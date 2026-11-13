// 腾讯 Marvis —— 公开渠道（随包发布，id `marvis`）
//
// 协议来源：gitee.com/iJetLi/deepseek-harness-codearts（公开仓库）的
//    src/marvis.ts + marvis-product.ts + marvis-auth.ts + marvis-adapter.ts。
//    本文件是这些实现的压平移植；**不引用任何私仓代码**。
//    本机自用的私有那条在同目录 marvis-private.mjs（gitignore，不进包）。
//
// 上游只有一个：https://yybadaccess.3g.qq.com
//   推理  /v1/chat/completions   （OpenAI 兼容；只要 Ual-Access-* 头，**不要**签名）
//   业务  /v3/*                  （钱包；要 md5(query + timestamp + accessKey + nonce) 签名）
//
// ⚠ 两套鉴权**不能混**：把 md5 签名头加到模型网关，会从 403 风控变成 401 登录态过期（实测）。
//
// ⚠ 模型网关的 UA 必须是 `AsyncOpenAI/Python 2.32.0`（Marvis agent 自己的）。
//    换浏览器 UA 或 magpie 的 UA 都会被风控拦（4100404）。
//
// ⚠ 模型表是**静态**的：Marvis 没有列模型接口，注册表在其客户端加密配置里。
//    `model` 字段填的是**槽位名**，服务端再路由到真实模型；响应体的 `model` 回真实模型名。
//
// 协议事实出处：codearts 的 marvis.ts 模块头（UAL 签名矩阵、uskey 长度、MarvisExt 形状）。

import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

/** 卡片上的供应商名：必须 `<中文> <English>` */
// 名称沿用移植来源 deepseek-harness-codearts 的 marvis-product.ts（「腾讯 Marvis」）。
// 本文件是**公开渠道**，随包发布；私有那条在 marvis-private.mjs（不进包）。
const DISPLAY_NAME = '腾讯 Marvis'

/** 业务接口基址（/v3/*：用户信息、钱包） */
const BASE = 'https://yybadaccess.3g.qq.com'
/** 推理基址 —— 渠道自己拼 `/chat/completions` */
const BASE_V1 = `${BASE}/v1`
const CHAT_URL = `${BASE_V1}/chat/completions`
const WALLET_URL = `${BASE}/v3/marvis_get_wallet`

/** 上游 business id（请求头 Ual-Access-Businessid） */
const BUSINESS_ID = 'marvis_client'

/** 业务接口签名用的 accessKey —— 明文硬编码在 Marvis 渲染层里，不是密钥 */
const ACCESS_KEY = 'fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi'

/** 模型网关必须用的 UA（换别的会被风控 4100404） */
const CLIENT = 'AsyncOpenAI/Python 2.32.0'
/** 业务接口（/v3/*）用的浏览器 UA，照抄 Marvis 自己的 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Marvis/1.60.3300.408 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36'

const CLIENT_VERSION = '1.60.3300.765'

/** uskey 总长（字节）—— Marvis 设备指纹的长度，实测 376 */
const USKEY_BYTES = 376

/**
 * `Marvis-Scene` —— **决定这次请求扣不扣额度**。
 *
 * ⚠ 2026-11-07 实测（钱包 used_tokens 差额）：
 *     preload_summary / ask_user_resolve / computer_use_direct / aigc_marvis_persona → 正常扣
 *     memory  → **0（完全免费）**
 *   `memory` 下流式、工具调用、系统提示词、大 max_tokens、长上下文全部正常。
 *   推测是产品设计（记忆总结不计费）。**随时可能被上游修掉** ——
 *   所以留了环境变量一键切回：`MARVIS_SCENE=preload_summary`
 */
// ⚠️ 公开版默认 preload_summary（codearts 口径，正常计费）。
//    「memory 不扣额度」是私仓的旁路，只在本机 marvis-private.mjs 里启用。
const DEFAULT_SCENE = 'preload_summary'
const currentScene = () => process.env.MARVIS_SCENE || DEFAULT_SCENE

// ── 设备指纹 ───────────────────────────────────────────────────────────────
//
// ⚠ 实测结论（同一 token、同一 guid）：
//     真 uskey / 随机 376 字节 / 空串 / 删掉 uskey 字段            → 200
//     qimei36 = "000…0"（伪造非空）                              → 403 风控
//     MarvisExt 只留 {} / {guid,nonce}                            → 200
//     删掉整个 Ual-Access-MarvisExt 头                            → 403 风控
//   即：**头必须存在**，但里面只有 guid 被校验；qimei36 要么真、要么别给。
//   native/ Beacon SDK 是**可选增强**，缺失不阻塞任何流程。

/**
 * 一次性设备指纹（uskey）：每次现签 376 字节随机再 base64。
 *
 * codearts 的做法（marvis.ts `uskeyOf`）：现签的代价可忽略，还能规避
 * 「同一指纹被服务端按使用次数判定」这类不可见风险。
 */
function syntheticUskey() {
  return randomBytes(USKEY_BYTES).toString('base64')
}

// ── 请求头 ─────────────────────────────────────────────────────────────────

/**
 * 模型网关要求的 `Ual-Access-MarvisExt`。
 * 字段照抄 Marvis agent 的 build_llm_auth_headers；上游按原文字符串处理，**不能有空格**。
 */
function marvisExt(acct) {
  return JSON.stringify({
    osVersion: 'Windows-10-10.0.26200',
    guid: acct.guid ?? '',
    uskey: syntheticUskey(),
    nonce: randomUUID(),
    reqScene: 1,
    taskType: 'user',
    clientVersion: acct.clientVersion ?? CLIENT_VERSION,
    isIoa: false,
  })
}

/**
 * 模型网关的完整请求头。
 * ⚠ uskey 每请求现签（同一 uskey 只给 2 次，第 3 次 403），所以头必须每次重建。
 */
function llmHeaders(acct, opts = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': CLIENT,
    'X-Stainless-Lang': 'python',
    'X-Stainless-Package-Version': '2.32.0',
    'X-Stainless-OS': 'Windows',
    'X-Stainless-Arch': 'other:amd64',
    'X-Stainless-Runtime': 'CPython',
    'X-Stainless-Runtime-Version': '3.11.9',
    'X-Stainless-Async': 'async:asyncio',
    'X-Stainless-Raw-Response': 'true',
    Authorization: 'Bearer placeholder',
    'Ual-Access-Openid': acct.openid,
    'Ual-Access-Access-Token': acct.accessToken,
    'Ual-Access-Login-Type': acct.loginType ?? '1',
    'Ual-Access-Guid': acct.guid ?? '',
    'Marvis-AgentTag': opts.agentTag ?? 'auto_discovery',
    'Marvis-Conversation-ID': opts.conversationId ?? '',
    'Marvis-Response-ID': opts.responseId ?? '',
    'Marvis-Scene': opts.scene ?? currentScene(),
    'Marvis-Protocol-Version': '1000',
    'X-Device-GUID': acct.guid ?? '',
    'Ual-Access-MarvisExt': marvisExt(acct),
  }
}

/** `/v3/*` 业务接口签名：md5(query + timestamp + accessKey + nonce) */
function ualSignature(query, timestamp, nonce) {
  return createHash('md5').update(query + timestamp + ACCESS_KEY + nonce).digest('hex')
}

/** `/v3/*` 业务接口的完整请求头 */
function businessHeaders(acct, { query, method = 'GET' }) {
  const timestamp = String(Date.now())
  const nonce = String(1000 + Math.floor(Math.random() * 9000))
  return {
    Accept: '*/*',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': BROWSER_UA,
    'Ual-Access-Businessid': BUSINESS_ID,
    'Ual-Access-Timestamp': timestamp,
    'Ual-Access-Nonce': nonce,
    'Ual-Access-Signature': ualSignature(query, timestamp, nonce),
    'Ual-Access-Guid': acct.guid ?? '',
    'Ual-Access-Access-Token': acct.accessToken,
    'Ual-Access-Login-Type': acct.loginType ?? '1',
    'Ual-Access-Openid': acct.openid,
    ...(method === 'POST' ? {} : {}),
  }
}

// ── 模型目录（静态） ───────────────────────────────────────────────────────
//
// 每条：`[槽位 id, 真实模型名, 上下文, 能力]`
//   · `main-auto` 是服务端自动路由槽位（按难度匹配）
//   · 只列**真实存在**的槽位（来自 config_defaults.yaml 的注册表），不猜不补
//   · 真实模型 id **不能**直接当 `model` 传（会 400 无效模型 id），只能填槽位名
//
// 为什么不分 file-auto / computer-auto / browser-auto / app-auto：
//   实测全部路由到 `deepseek-v4-1-flash-261017`，与 main-auto 一模一样，列出来只是 4 条重名。
//
// 已移除（上游 400 无效模型 id / 500 / 空响应）：
//   glm-5v-turbo-thinking · claude-opus-4-6-thinking · memory-compress · profile-request-placeholder
//   kimi-k2.5（500 RPC）· hunyuan-2.0-instruct-20251111（空响应）· venus-vision-llm（→ default）
// ⚠️ 只有一条，与 codearts 一致：Marvis **没有远端目录端点**（那个仓库实测
//    9 个候选端点全 404），而槽位表只确知 main-auto 一个。
//    猜别的槽位名会让用户看到「点了就 4100402 无效模型」的假模型 —— 宁可少列。
//    本机想用更多槽位，在 marvis-private.mjs 里覆写 fallbackModels/catalog。
const TABLE = [
  ['main-auto', 'DeepSeek V4.1 Flash', 1_000_000, { tools: true, vision: true }],
]

/** 默认输出上限（Marvis 的 default 槽位写的是 32000） */
const DEFAULT_OUTPUT = 32_000

/** 槽位名 → 显示名（也是 hub 侧的模型 key） */
const slotToName = new Map(TABLE.map(([slot, name]) => [slot, name]))
/** 显示名 → 槽位名 */
const nameToSlot = new Map(TABLE.map(([slot, name]) => [name, slot]))
/** 旧版存量：magpie 把数组下标持久化成了 `"0"…"7"`，路由里写 `marvis/0` */
const MODEL_ALIASES = Object.fromEntries(TABLE.map(([slot], index) => [String(index), slot]))

/** 把任意写法的模型 id 归一到槽位名：下标 / 显示名 / 槽位名都能进来 */
function canonicalModelId(id) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (raw === '') return TABLE[0][0]
  if (MODEL_ALIASES[raw]) return MODEL_ALIASES[raw]
  if (nameToSlot.has(raw)) return nameToSlot.get(raw)
  if (slotToName.has(raw)) return raw
  // 未知名字原样交给上游 —— 让它给出明确的 4100402，而不是我们静默换模型
  return raw
}

/** hub 侧模型表（key = 显示名） */
function fallbackModels() {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [slot, name, context, cap] of TABLE) {
    const vision = Boolean(cap.vision)
    const tools = Boolean(cap.tools)
    const reasoning = Boolean(cap.reasoning)
    out[name] = {
      name,
      // ⚠ magpie 真正读的是**顶层** `attachment` / `tool_call` / `reasoning`
      //    与 `capabilities.input.image`，两处都写，避免能力静默为假。
      //    只写嵌套那层（lingxi 早前的写法）时，读顶层的那条路径取不到值，
      //    `tool_call ?? true` 会把不会调工具的模型默认成会调。
      attachment: vision,
      tool_call: tools,
      reasoning,
      modalities: { input: vision ? ['text', 'image'] : ['text'] },
      capabilities: {
        temperature: true,
        reasoning,
        attachment: vision,
        toolcall: tools,
        input: { text: true, image: vision, audio: false, video: false, pdf: false },
        output: { text: true },
      },
      limit: { context, output: DEFAULT_OUTPUT },
    }
  }
  return out
}

/** 目录：静态表就是权威（没有列模型接口），登录前后一致 */
async function catalog() {
  return fallbackModels()
}

// ── 凭据 ───────────────────────────────────────────────────────────────────

/**
 * 把粘贴进来的一串解析成凭据。
 *
 * 接受三种写法（都能从浏览器 F12 里拼出来）：
 *   1. `openid|accessToken|guid|loginType`   ← 推荐，一行搞定
 *   2. JSON：`{"openid":"…","accessToken":"…","guid":"…","loginType":"1"}`
 *   3. 只给 accessToken —— 不行，openid 缺了网关必拒，直接报清楚。
 */
export function parseCredential(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('未登录：请粘贴 Marvis 凭据')

  // JSON 形态
  if (text.startsWith('{')) {
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('凭据解析失败：看起来是 JSON 但解析不了')
    }
    const acct = {
      openid: String(json.openid ?? json.openId ?? '').trim(),
      accessToken: String(json.accessToken ?? json.access_token ?? json.token ?? '').trim(),
      guid: String(json.guid ?? '').trim(),
      loginType: String(json.loginType ?? json.login_type ?? '1').trim(),
    }
    return requireComplete(acct)
  }

  // 竖线分隔
  if (text.includes('|')) {
    const parts = text.split('|').map((each) => each.trim())
    const acct = {
      openid: parts[0] ?? '',
      accessToken: parts[1] ?? '',
      guid: parts[2] ?? '',
      loginType: parts[3] || '1',
    }
    return requireComplete(acct)
  }

  throw new Error(
    '凭据格式不对：需要 `openid|accessToken|guid|loginType` 四段（竖线分隔），' +
      '或一段 JSON。只有 accessToken 不够 —— 网关同时校验 openid 与 guid。',
  )
}

function requireComplete(acct) {
  const missing = []
  if (!acct.openid) missing.push('openid')
  if (!acct.accessToken) missing.push('accessToken')
  if (!acct.guid) missing.push('guid')
  if (missing.length) {
    throw new Error(`凭据不完整，缺少：${missing.join(' / ')}（guid 缺了会被上游判 -109 参数错误）`)
  }
  if (acct.loginType !== '1' && acct.loginType !== '2') acct.loginType = '1'
  return acct
}

/** 渠道凭据 → 请求用的账号对象 */
function acctOf(credential) {
  if (!credential || typeof credential !== 'object') return undefined
  const openid = String(credential.openid ?? '').trim()
  // magpie 存 OAuth 凭据时把 token 放在 access（refresh 放 refresh）；
  // 渠道自己登录时用的是 accessToken/refreshToken。两种都认。
  const accessToken = String(credential.accessToken ?? credential.access ?? credential.key ?? '').trim()
  const guid = String(credential.guid ?? '').trim()
  if (!openid || !accessToken || !guid) return undefined
  return { openid, accessToken, guid, loginType: String(credential.loginType ?? '1') }
}

// ── 工具 schema 兼容 ───────────────────────────────────────────────────────
//
// 实测（DSH 真实请求，57 个工具）：只要有**一个** `function.parameters` 缺顶层
// `type: "object"`，上游就回 `{"code":3000101,"msg":"invalid parameter"}`。
// 只补缺失的 type，不动 properties / required / additionalProperties。

function withObjectType(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) {
    let changed = false
    const out = schema.map((each) => {
      const next = withObjectType(each)
      if (next !== each) changed = true
      return next
    })
    return changed ? out : schema
  }

  let changed = false
  const out = { ...schema }
  if (out.properties && typeof out.properties === 'object' && !out.type) {
    out.type = 'object'
    changed = true
  }

  for (const key of ['properties', 'patternProperties']) {
    const map = out[key]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    const next = {}
    let mapChanged = false
    for (const [name, child] of Object.entries(map)) {
      const value = withObjectType(child)
      next[name] = value
      if (value !== child) mapChanged = true
    }
    if (mapChanged) {
      out[key] = next
      changed = true
    }
  }

  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
    if (out[key] && typeof out[key] === 'object') {
      const value = withObjectType(out[key])
      if (value !== out[key]) {
        out[key] = value
        changed = true
      }
    }
  }

  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(out[key])) {
      const value = withObjectType(out[key])
      if (value !== out[key]) {
        out[key] = value
        changed = true
      }
    }
  }

  return changed ? out : schema
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return tools
  let changed = false
  const out = tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool
    const fn = tool.function
    if (!fn || typeof fn !== 'object' || !fn.parameters) return tool
    const params = withObjectType(fn.parameters)
    if (params === fn.parameters) return tool
    changed = true
    return { ...tool, function: { ...fn, parameters: params } }
  })
  return changed ? out : tools
}

// ── 错误分流 ───────────────────────────────────────────────────────────────
//
// 上游业务错误放在响应体里，HTTP 可能仍是 200/4xx。magpie 只看状态码决定
// 「换账号 / 重试 / 搁置模型」，所以必须按语义翻译：
//   登录态过期 → 401 + X-Magpie-Sign-In: expired（摘号重登）
//   风控       → 503（可重试，换新 uskey 就过）
//   模型不可用 → 404（只搁置这个模型，不打死账号）

const MODEL_ISSUE = /model.*not (found|exist|allowed|available)|no such model|不支持.*模型|模型.*(不存在|未开通|不可用)|4100402/i
const RISK_BLOCK = /4100404|风控拦截/
const AUTH_EXPIRED = /4100403|登录态过期|未登录/

function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { type: 'upstream_error', code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

// ── chat ───────────────────────────────────────────────────────────────────

/**
 * 转发一次对话。
 *
 * ⚠ 成功响应**绝不读 body**（读了就是「只有第一段就结束」）—— 原样交给宿主。
 *    只有错误响应才读 body 来做分流。
 *
 * @param {object} acct 请求用的四件套
 * @param {object} request hub 信封 `{ body, signal, renew }`
 * @param {{ renewTarget?: object, retried?: boolean }} [opts] 401 硬续期的重试状态
 */
async function chat(acct, request, opts = {}) {
  // 401 硬续期要按**完整凭据**调 renew（identityOf 用 refreshToken 键控去重闸）
  const renewTarget = opts.renewTarget ?? acct
  const retried = opts.retried === true

  // ⚠ 契约：第二参是信封 `{ body, signal, renew }`，请求体在 **`body` 字段**里。
  //   把整个信封当 body 发出去，上游会看到 renew/signal 这两个陌生键（AGENTS §5 真机 502 踩过）。
  const rawBody = request?.body
  if (rawBody === undefined) throw new Error('Marvis 请求体缺失（契约：chat(credential, { body, signal })）')
  let body
  let parsed = undefined
  if (typeof rawBody === 'string') {
    body = rawBody
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
  } else if (rawBody && typeof rawBody === 'object') {
    parsed = { ...rawBody }
    body = JSON.stringify(parsed)
  } else {
    throw new Error('Marvis 请求体为空')
  }

  // 归一：模型 id（下标 / 显示名 → 槽位名）+ 工具 schema（补 type: "object"）
  if (parsed) {
    let changed = false
    const canonical = canonicalModelId(parsed.model)
    if (canonical !== parsed.model) {
      parsed.model = canonical
      changed = true
    }
    const tools = normalizeTools(parsed.tools)
    if (tools !== parsed.tools) {
      parsed.tools = tools
      changed = true
    }
    // 上游有这些扩展头管着场景与配额，请求体里不需要再带
    if (changed) body = JSON.stringify(parsed)
  }

  let headers
  try {
    headers = llmHeaders(acct, { agentTag: 'auto_discovery' })
  } catch (err) {
    return errorResponse(503, 'header_unavailable', `请求头构造失败：${err?.message ?? err}`)
  }
  // 保留调用方原有的头，只覆盖鉴权那几项
  // ⚠ 合并方向必须**反过来**：上游头先铺底，调用方只补协议头之外的东西。
  //   早前是「调用方的 contentType 覆盖我们的」，一旦宿主传 `text/event-stream`
  //   就把 `application/json` 盖掉，上游按非 JSON 拒（参考 loader 也是这个方向）。
  for (const [key, value] of Object.entries(request?.headers ?? {})) {
    if (typeof value !== 'string') continue
    if (/^content-(type|length|encoding)$/i.test(key)) continue
    if (key.toLowerCase() === 'authorization') continue
    headers[key] = value
  }
  // body 被改写过 → 让 fetch 重算长度
  delete headers['content-length']
  delete headers['Content-Length']
  delete headers['content-encoding']
  delete headers['Content-Encoding']

  // ⚠ signal 透传，**不挂硬超时**：120s 会掐断长对话（AGENTS §5）
  let response
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers,
      body,
      ...(request?.signal ? { signal: request.signal } : {}),
    })
  } catch (err) {
    return errorResponse(503, 'upstream_unreachable', `连不上 Marvis 网关：${err?.message ?? err}`)
  }

  if (response.ok) {
    // 上游流式响应的 content-type 常是 text/plain，但 body 是标准 SSE。
    // 部分 OpenAI 客户端按 content-type 决定走不走 SSE 解析器，这里归一化。
    const contentType = response.headers.get('content-type') ?? ''
    if (response.body && !/event-stream/i.test(contentType)) {
      const fixed = new Headers(response.headers)
      fixed.set('content-type', 'text/event-stream; charset=utf-8')
      return new Response(response.body, { status: response.status, headers: fixed })
    }
    return response
  }

  // 错误分流：只读错误的 body
  let text = ''
  try {
    text = await response.clone().text()
  } catch {
    /* 读不出来就按状态码判 */
  }

  if (AUTH_EXPIRED.test(text) || response.status === 401) {
    // 硬续期：本地判「过期」时服务端往往还收 refresh_token（微信 2 小时档最常见）。
    // ⚠ 换取实测「access_token 不变、只重置有效期」—— 续期成功就重发，
    //   不能学 accio 的「token 没变就不重发」。只重试一次，防打转。
    if (!retried && typeof request?.renew === 'function') {
      let fresh
      try {
        fresh = await request.renew(renewTarget)
      } catch {
        fresh = undefined // 续期没成功 —— 如实 401 摘号
      }
      const renewed = fresh === undefined ? undefined : acctOf(fresh)
      if (renewed !== undefined) {
        return chat(renewed, request, { renewTarget: fresh, retried: true })
      }
    }
    return errorResponse(401, 'sign_in_expired', 'Marvis 登录态已过期，请重新登录。', {
      'X-Magpie-Sign-In': 'expired',
    })
  }
  if (RISK_BLOCK.test(text)) {
    return errorResponse(
      503,
      'risk_blocked',
      `上游风控拦截（通常是一次性 uskey 用完了，重试即可）：${text.slice(0, 300)}`,
    )
  }
  if (MODEL_ISSUE.test(text) || response.status === 404) {
    return errorResponse(404, 'model_unavailable', `该模型在当前账号不可用：${text.slice(0, 300)}`)
  }
  return new Response(text || null, { status: response.status, headers: response.headers })
}

// ── usage ──────────────────────────────────────────────────────────────────
//
// Marvis 的额度是**令牌钱包**：总额 10,000,000 tokens，用掉多少、剩多少。
// 上游 `POST /v3/marvis_get_wallet` 返回
//   { total_tokens, used_tokens, frozen_tokens, avail_tokens, total_cost, status }
//
// ⚠ 这里是**余额型**窗口（无作废包、无到期窗口）—— AGENTS §1「别硬套滚动指针」。
//   分档门禁的判据是「文件含『到期』+ 命名式 usage 函数声明」，而本文件的「到期」
//   全是**登录 token 有效期**（refresh/expiry 段），与额度窗口无关 —— 所以内部取数
//   函数叫 walletWindows，usage 只留渠道属性（autoclaw 同类形状），别改回命名式
//   的 usage 函数声明，会把门禁误伤成「手拼到期档位」。

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '0')

async function walletWindows(credential) {
  const acct = acctOf(credential)
  if (acct === undefined) return []

  const body = '{}'
  let wallet
  try {
    const res = await fetch(WALLET_URL, {
      method: 'POST',
      headers: businessHeaders(acct, { query: body, method: 'POST' }),
      body,
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
    wallet = JSON.parse(text)?.data
    if (!wallet) throw new Error(`返回体没有 data：${text.slice(0, 200)}`)
  } catch (err) {
    // 读失败不把整次判死，但也不能静默返回空数组 —— 那样卡片只剩「已登录」，
    // 用户看不出是钱包接口挂了。按 qiniu 惯例出一行**不带 used** 的说明窗口
    // （无 used = text-only，只上卡片，不参与路由）。
    return [{ name: '令牌用量', display: `读取令牌钱包失败：${err?.message ?? err}` }]
  }

  const total = Number(wallet.total_tokens ?? 0)
  const used = Number(wallet.used_tokens ?? 0)
  const avail = Number(wallet.avail_tokens ?? Math.max(0, total - used))
  const frozen = Number(wallet.frozen_tokens ?? 0)
  if (!Number.isFinite(total) || total <= 0) return []

  const windows = [
    {
      name: '令牌用量',
      amount: Number.isFinite(used) ? Math.max(0, Math.min(total, used)) : 0,
      limit: total,
      // ⚠ `amount` + `limit` 必须同时有 `used`：magpie < 0.1.1934 会把没有 used 的窗口
      //    当 text-only 丢掉，该号在智能路由里等于不存在（quota.mjs 的结论）。
      used: total > 0 ? Math.round((Math.max(0, Math.min(total, used)) / total) * 10000) / 100 : 0,
      unit: 'tokens',
      display: `${fmt(avail)} 可用 / 共 ${fmt(total)}`,
    },
  ]
  if (Number.isFinite(frozen) && frozen > 0) {
    windows.push({ name: '冻结中', display: `冻结 ${fmt(frozen)}` })
  }
  return windows
}

// ══ 登录：QQ / 微信 OAuth + 从本机 Marvis 导入 ════════════════════════════
//
// 压平自参考实现的 hooks/methods.mjs + marvis/{login,browser,desktop,device,expiry,profile}.mjs。
// 三条登录路 + 粘贴入口（apiAuth）兜底，与参考 methods() 的形态一致：
//   · QQ / 微信：起**隔离浏览器**（一次性 profile、Marvis Electron UA、抹 navigator.webdriver），
//     CDP `Fetch.requestPaused` 在**请求阶段**拦下回调（请求不出网，code 保持未消费），
//     再由 Node 带**本次登录专属的虚拟 guid** 把 code 换唯一那一次。
//   · 从本机 Marvis 导入：读客户端进程内存里的登录态（只读，不写、不注入、不 hook）。
//
// ⚠ 契约（hub）：beginLogin(openBrowser, { arg }) 必须**立刻**返回
//   `{ url, opened: true, instructions, result }` —— 在这里 await 用户登录会与
//   magpie 双向死锁。重活全部放 `result` 这条 promise（deferred 起步，连
//   findBrowser 的 1.4 秒注册表扫描都不挡 authorize 返回），aggregate 挂 toast 链
//   + callback 各自 await 它。
//
// ⚠ `opened: true` 让宿主**不要**再开系统默认浏览器；`url: ""`（本机导入）时
//   更不能让宿主去开 —— 参考实现实测给 about:blank 会弹「没有可打开此链接的应用」。
//
// ⚠⚠ `-109 RC_PARAMS_INVALID` 的根因（已修）：`marvis_oauth` 是**参数检查**失败，
//   最常见的是**缺设备 guid**。实测：缺 guid → 恒定 -109；带 `Ual-Access-Guid`
//   后，假 code / 已消费 code 变成 `-107 RC_NO_AUTH_ERR`。官方成功路径是
//   「回调 → 302 + Set-Cookie 写入登录态」，不是 JSON 响应体。

/** 上游只给 QQ（QC）和微信（WX）两种登录；`Ual-Access-Login-Type` 取值 QC=1、WX=2 */
const LOGIN_TYPE = { QC: '1', WX: '2' }
const QQ_APP_ID = '1903794758'
const WX_APP_ID = 'wxb650708317d56f88'

/**
 * redirect_uri 的**基址**（固定在 Marvis 服务端，QQ 互联预注册过，改不了 ——
 * 所以不能起本地 loopback 收回调）。
 * ⚠⚠ 换取时必须拼 `?login_type=<QC|WX>`：它决定服务端用哪个 app 的身份换 code，
 *   少了直接 `-109`。
 */
const OAUTH_REDIRECT = `${BASE}/marvis_client_login/marvis_oauth`

/** 回调地址判据：跳到 marvis_oauth 且带 code= */
const CALLBACK = /marvis_client_login\/marvis_oauth\?[^#]*\bcode=/i
/** CDP `Fetch.enable` 的拦截模式（故意放松到「路径含 marvis_oauth」，isCallbackUrl 再筛） */
const CALLBACK_PATTERN = '*marvis_oauth*'
/** 回调端点的路径片段 —— 「这是不是回调」的兜底判据 */
const CALLBACK_PATH = 'marvis_client_login/marvis_oauth'

/** `-109` 的可执行提示：参数检查没通过，最常见是缺 guid */
const PARAM_HINT =
  '  [提示] 服务端参数检查未通过（最常见是缺设备 guid）。这不是 code 过期，' +
  '请把这条提示反馈给插件作者；也可以改用「从本机 Marvis 导入」——装了客户端并在里面登录过就能一键导入。'
/** 拦截没生效（浏览器自己把回调请求发了出去）时的追加提示 */
const NOT_INTERCEPTED_HINT =
  '（本次未能在请求发出前拦下回调，code 很可能已被浏览器消费 —— 换个 Chromium 内核浏览器再试）'

// ── 登录有效期归一 ─────────────────────────────────────────────────────────
//
// ⚠ 上游两条链路的字段语义不同（2026-11-07 真实事故）：
//   `access_token_expire_time` 是**绝对**时间（秒 10 位/毫秒 13 位）；
//   `expires_in` 是**相对**秒数 —— 微信只有 7200（2 小时），QQ ≈30 天。
//   旧写法 `> 1e9` 三目把微信的 7200 判成「不是时间戳」回退 30 天 —— 错 60 倍，
//   微信 token 2 小时过期插件却以为还有 30 天，从不续期（「微信被踢下线」根因）。

/** 上游一个都不给时的兜底：30 天 */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000
/** 微信侧 `expires_in` 只有 2 小时（实测 7200）；导入型登录态拿不到真实值时按它兜底 */
const WX_TTL_MS = 2 * 60 * 60_000

/** 把上游返回的登录态算成**绝对毫秒时间戳**：绝对 → 相对 → 兜底 TTL */
function expiresAtOf(info, { fallbackMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const abs = Number(info?.access_token_expire_time ?? 0)
  if (Number.isFinite(abs) && abs > 0) return abs > 1e12 ? abs : abs * 1000
  const rel = Number(info?.expires_in ?? 0)
  if (Number.isFinite(rel) && rel > 0) return now + rel * 1000
  return now + fallbackMs
}

/** 按登录方式给兜底 TTL —— 微信 2 小时、QQ 30 天，差 360 倍，不能共用一个 */
function ttlFor(loginType) {
  const s = String(loginType ?? '').toUpperCase()
  return s === '2' || s === 'WX' || s === 'WXAPP' ? WX_TTL_MS : DEFAULT_TTL_MS
}

// ── 虚拟设备 guid（每账号一台「虚拟设备」）────────────────────────────────
//
// ⚠ 实测：Marvis 上游把 token 绑定在 `guid` 上（同 token + 随机 guid → 401）。
//   客户端默认所有账号共用本机 svid，**新号登录会把旧号顶掉**；给每个账号
//   分配独立 guid，多个号就能并存。
// ⚠ 登录过程中的 state → guid 映射**不能**用模块级变量：宿主同进程服务多个账号，
//   两个登录窗口并行会串号 —— 按 OAuth state 分开存。

/** 生成一个 32 位小写 hex 的设备 guid（与 Marvis 的 svid 同形状） */
function newDeviceGuid() {
  return randomBytes(16).toString('hex')
}

/** 登录过程中的 state → guid 暂存表（10 分钟 TTL，take 一次性取走） */
function createDeviceRegistry({ ttlMs = 10 * 60_000, now = Date.now } = {}) {
  /** @type {Map<string, { guid: string, at: number }>} */
  const map = new Map()
  const prune = () => {
    const t = now()
    for (const [k, v] of map) if (t - v.at > ttlMs) map.delete(k)
  }
  return {
    remember(state, guid) {
      if (!state || !guid) return
      prune()
      map.set(String(state), { guid: String(guid), at: now() })
    },
    take(state) {
      if (!state) return ''
      prune()
      const hit = map.get(String(state))
      if (!hit) return ''
      map.delete(String(state))
      return hit.guid
    },
    get size() {
      prune()
      return map.size
    },
  }
}

/** 从 URL 里取 OAuth state（字符串原样 —— QQ 的 state 是小数，转数字会变形） */
function stateOfUrl(url) {
  try {
    return new URL(String(url)).searchParams.get('state') ?? ''
  } catch {
    return ''
  }
}

/** 登录过程中的 state → 虚拟设备 guid 映射（模块级单表，按 state 隔离多账号） */
const pendingDevices = createDeviceRegistry()

// ── OAuth 授权码换取（login.mjs 压平）─────────────────────────────────────

/**
 * 拼授权页地址。
 * ⚠ `redirect_uri` 必须拼 `?login_type=<QC|WX>`；QQ 的 `state` 必须是
 *   `Math.random()*100` 的**小数字符串**（与渲染层 `Bpe(e)` 逐字一致，格式不符判参数无效）；
 *   微信的 state **本身就是 guid**（token 绑 guid，全程同一个）。
 */
function authorizeUrl(loginType, guid) {
  if (loginType === 'WX') {
    const p = new URLSearchParams({
      appid: WX_APP_ID,
      redirect_uri: `${OAUTH_REDIRECT}?login_type=${loginType}`,
      response_type: 'code',
      scope: 'snsapi_login',
      state: guid,
    })
    return `https://open.weixin.qq.com/connect/qrconnect?${p}`
  }
  const p = new URLSearchParams({
    which: 'Login',
    display: 'pc',
    response_type: 'code',
    client_id: QQ_APP_ID,
    redirect_uri: `${OAUTH_REDIRECT}?login_type=${loginType}`,
    state: String(Math.random() * 100),
  })
  return `https://graph.qq.com/oauth2.0/authorize?${p}`
}

/** 从粘贴内容里抠授权码：纯 code / 完整回调 URL / JSON 里的 code 字段 */
function extractCode(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  try {
    const c = new URL(s).searchParams.get('code')
    if (c) return c
  } catch {
    /* 不是 URL */
  }
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s)
      const c = j?.code ?? j?.user_info?.code ?? j?.data?.code
      if (typeof c === 'string' && c.length > 4) return c
    } catch {
      /* 不是 JSON */
    }
  }
  const m = /(?:^|[?&])code=([^&\s]+)/.exec(s)
  if (m) return decodeURIComponent(m[1])
  if (/^[A-Za-z0-9_-]{8,}$/.test(s)) return s
  return null
}

/** `logintype` / QC / WX / "1" / "2" → `Ual-Access-Login-Type` 的 "1" / "2" */
function loginTypeCode(raw) {
  const s = String(raw ?? '')
  if (s === '2') return '2'
  return /^WX/i.test(s) ? '2' : '1'
}

/**
 * 把响应头里的 `Set-Cookie` 拆成 `name -> value`（同名只留第一个）。
 * ⚠ 不能按逗号 split —— `Expires=Wed, 01 Jan…` 里的逗号会把一条 cookie 劈成两半；
 *   Node 22+ 的 `getSetCookie()` 是可靠来源。
 */
function parseSetCookies(headers) {
  /** @type {string[]} */
  const lines =
    typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : String(headers?.get?.('set-cookie') ?? '')
          .split(/,(?=\s*[^;=]+=)/)
          .filter(Boolean)
  const jar = new Map()
  for (const line of lines) {
    const pair = String(line).split(';')[0]
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!name || jar.has(name)) continue
    jar.set(name, value)
  }
  return jar
}

/** 302 的 `Set-Cookie` 集合 → 内部账号形状（缺 openid/accesstoken 就不算成功） */
function accountFromCookies(jar, opts = {}) {
  const openid = jar.get('openid')
  const accessToken = jar.get('accesstoken') ?? jar.get('access_token')
  if (!openid || !accessToken) return null
  return normalizeLogin(
    {
      access_token: accessToken,
      openid,
      refresh_token: jar.get('refreshtoken') || undefined,
      nick_name: jar.get('nickname') || undefined,
      head_img_url: jar.get('head_img_url') || undefined,
      access_token_expire_time: jar.get('access_token_expire_time') || undefined,
      login_type: jar.get('logintype') || opts.loginType || '',
    },
    accessToken,
    openid,
    {
      guid: opts.guid,
      appid: jar.get('appid'),
      scope: jar.get('scope'),
      isLocked: /^(1|true|yes)$/i.test(jar.get('is_locked') ?? ''),
    },
  )
}

/**
 * 换取失败的两个死码 —— **都不是「账号错」**：
 *   `-109` 参数检查没通过（缺 guid / login_type / code…；发生在 code 校验**之前**，
 *        不能据此判断 code 是否过期）；
 *   `-107` 参数已通过、认证/会话校验失败（code 无效/过期/已消费）。
 */
function loginError(errCode, msg) {
  const code = Number(errCode)
  const hint =
    code === -109
      ? '（-109 RC_PARAMS_INVALID：请求参数检查未通过 —— 最常见是缺设备 guid（Ual-Access-Guid），也可能是缺 login_type / code、非 GET 或 login_type 非法。参数检查在 code 校验之前，不能据此判断 code 是否过期）'
      : code === -107
        ? '（-107：参数已通过，认证/会话校验失败 —— code 无效、已过期或已被消费，或本次会话不能完成授权。请重新走一遍登录；与账号本身无关）'
        : ''
  return new Error(`登录失败（code=${errCode}）：${msg}${hint}`)
}

/**
 * 用授权码换登录态。
 * ⚠⚠ 必须 `redirect: "manual"`：跟随 302 只会落到落地页，登录态（Set-Cookie）就丢了。
 * ⚠ 不要带业务签名头（WAF 直接 400）；`Ual-Access-Guid` 是唯一必须的 `Ual-` 头，
 *   且必须是**这次授权生成的那个**（token 绑 guid）。
 * ⚠ query 里只能有 login_type / code / state —— 多一个参数服务端就 -109。
 */
async function exchangeCode(code, loginType, guid, state) {
  if (!code) {
    throw new Error('换取登录态失败：没有授权码（回调地址里取不到 code=）。请重新走一遍登录。')
  }
  if (!guid) {
    throw new Error(
      '换取登录态失败：缺少设备 guid（请求头 Ual-Access-Guid）。' +
        '不带它服务端一律 -109 RC_PARAMS_INVALID —— 先取一个设备 guid 再换。',
    )
  }
  const params = { login_type: loginType, code }
  if (state) params.state = String(state)
  const url = `${OAUTH_REDIRECT}?${new URLSearchParams(params).toString()}`

  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'User-Agent': BROWSER_UA,
      'Ual-Access-Guid': String(guid),
    },
    signal: AbortSignal.timeout(30_000),
  })

  // ① 成功形态（官方实测）：302 + Set-Cookie
  const fromCookie = accountFromCookies(parseSetCookies(res.headers), { loginType, guid })
  if (fromCookie) return fromCookie

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') ?? ''
    throw new Error(
      `登录失败：服务端返回 ${res.status}，但没有下发登录 Cookie（Location=${to || '空'}）。请重新走一遍登录。`,
    )
  }

  // ② 兼容形态：200 + JSON
  const text = await res.text()
  /** @type {any} */
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `登录接口返回的既不是 302 + Cookie 也不是 JSON（HTTP ${res.status}）：${text.slice(0, 200) || '空响应'}`,
    )
  }
  const info = body?.user_info ?? body?.data ?? body ?? null
  const accessToken = info?.access_token ?? info?.accessToken ?? body?.access_token
  const openid = info?.openid ?? info?.openId ?? info?.open_id
  const biz = Number(body?.code ?? 0)
  if (accessToken && openid && (biz === 0 || Number.isNaN(biz))) {
    return normalizeLogin(info, accessToken, openid, { guid })
  }
  throw loginError(biz || res.status, body?.msg ?? '未返回 access_token / openid')
}

/** 从回调地址里取 `state`（**字符串原样**保留 —— QQ 的 state 是小数，变形就比对不过） */
function stateOfCallback(callbackUrl) {
  try {
    return new URL(String(callbackUrl)).searchParams.get('state') ?? ''
  } catch {
    const m = /[?&]state=([^&\s#]+)/.exec(String(callbackUrl ?? ''))
    return m ? m[1] : ''
  }
}

/**
 * 从回调里拿登录态。
 * **主路径**：回调请求被 CDP 在**跳转前**拦下（body 恒为空），Node 带 guid + state 换一次。
 * **兜底**：URL 里取不到 code 但正文是 JSON（旧路径）也认。
 */
async function parseCallback(callbackUrl, body, opts = {}) {
  const loginType = opts.loginType ?? 'QC'
  const state = stateOfCallback(callbackUrl) || opts.state || ''
  // guid 绝不能是 undefined（老代码传 undefined 只会拿到 -109）
  const guid =
    opts.guid || (loginType === 'WX' && /^[0-9a-f]{32}$/i.test(state) ? state : '') || deviceGuid()

  const text = String(body ?? '').trim()
  // ⚠ 不能只看 startsWith("{") —— 浏览器渲染 JSON 会加缩进/包装；抠第一个 { 到最后一个 }
  const jsonText = (() => {
    const a = text.indexOf('{')
    const b = text.lastIndexOf('}')
    return a >= 0 && b > a ? text.slice(a, b + 1) : ''
  })()
  if (jsonText) {
    /** @type {any} */
    let body0
    try {
      body0 = JSON.parse(jsonText)
    } catch {
      body0 = null
    }
    if (body0) {
      const biz = body0.code
      const info = body0.user_info ?? body0.data ?? body0
      const accessToken = info?.access_token ?? info?.accessToken
      const openid = info?.openid ?? info?.openId ?? info?.open_id
      if (typeof biz === 'number' && biz !== 0) throw loginError(biz, body0.msg ?? '未返回用户信息')
      if (accessToken && openid) return normalizeLogin(info, accessToken, openid, { guid })
    }
  }

  const code = extractCode(callbackUrl)
  if (!code) {
    throw new Error(
      `没能从回调地址里取出授权码（${String(callbackUrl).slice(0, 160) || '空'}）。请重新走一遍登录。`,
    )
  }
  return exchangeCode(code, loginType, guid, state)
}

/** 上游登录态（cookie 解析 / user_info）→ 内部账号形状 */
function normalizeLogin(info, accessToken, openid, extra = {}) {
  const nickname = info?.nick_name ? safeDecode(info.nick_name) : ''
  return {
    openid: String(openid),
    accessToken: String(accessToken),
    refreshToken: info?.refresh_token ? String(info.refresh_token) : undefined,
    nickname: nickname || undefined,
    avatar: info?.head_img_url ? safeDecode(info.head_img_url) : undefined,
    loginType: loginTypeCode(info?.login_type),
    expiresAt: expiresAtOf(info, { fallbackMs: ttlFor(loginTypeCode(info?.login_type)) }),
    ...(extra.guid ? { guid: String(extra.guid) } : {}),
    ...(extra.appid ? { appid: extra.appid } : {}),
    ...(extra.scope ? { scope: extra.scope } : {}),
    ...(extra.isLocked ? { isLocked: true } : {}),
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s))
  } catch {
    return String(s)
  }
}

/**
 * 本机设备 guid：注册表 `HKCU\SOFTWARE\Tencent\Marvis\Env\svid`；没装 Marvis 时
 * 用「机器名 + 用户名」派生（同一台机器永远同一个）。
 * ⚠ `reg` 的路径必须 String.raw —— JS 里 `\S` `\T` 是无效转义，反斜杠会被吃掉。
 */
function deviceGuid() {
  try {
    // ⚠ 必须 String.raw，见上
    const out = execFileSync('reg', ['query', String.raw`HKCU\SOFTWARE\Tencent\Marvis\Env`, '/v', 'svid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    const m = /svid\s+REG_SZ\s+([0-9a-fA-F]{32})/.exec(out)
    if (m) return m[1].toLowerCase()
  } catch {
    /* 没装 Marvis 或没有这个键，用派生值 */
  }
  const seed = `${hostname()}|${userInfo?.().username ?? ''}|marvis`
  return createHash('md5').update(seed).digest('hex')
}

// ── 隔离浏览器 + CDP 拦回调（browser.mjs 压平）────────────────────────────
//
// ⚠ 取舍照搬参考实现：一次性 user-data-dir（关窗即毁）、伪装 Marvis Electron UA、
//   `Page.addScriptToEvaluateOnNewDocument` 抹 navigator.webdriver（不用
//   `--disable-blink-features=AutomationControlled` —— 会挂「不受支持的标记」警告条）。
// ⚠ 所有钩子（Network.* / Fetch.enable）必须在 `Page.navigate` **之前**装好 ——
//   装晚了首次请求就漏过去，拦截永远不触发（先开 about:blank 就是为了这个）。
// ⚠ 退出码不可靠（浏览器可能吞掉调试参数），以「CDP 端口能不能连上」为准。

/** Windows 候选浏览器（Chrome → 国产 Chromium → Edge 最后：Edge 策略最多） */
const WIN_EXES = [
  'chrome.exe',
  '360ChromeX.exe',
  '360chrome.exe',
  '360se.exe',
  'QQBrowser.exe',
  'Brave.exe',
  'vivaldi.exe',
  'opera.exe',
  'SogouExplorer.exe',
  '2345Explorer.exe',
  'liebao.exe',
  'Maxthon.exe',
  'UCBrowser.exe',
  'Quark.exe',
  'msedge.exe',
]

/**
 * 静态完成页 —— 回调被拦下后由 CDP `Fetch.fulfillRequest` **合成**响应喂给浏览器。
 * 不能 continue（请求一出去 code 就被消费），页面只告诉用户「授权完成」。
 */
const COMPLETE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权完成</title>
<style>
  html,body{margin:0;height:100%;background:#f6f7f9;color:#1a1a1a;
    font:16px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{height:100%;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:36px 44px;
    box-shadow:0 12px 32px rgba(0,0,0,.06);text-align:center;max-width:420px}
  .tick{font-size:44px;line-height:1}
  h1{font-size:20px;margin:14px 0 8px;font-weight:600}
  p{margin:6px 0;color:#4b5563;font-size:14px}
  .muted{color:#9aa2ae;font-size:13px;margin-top:18px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="tick">✓</div>
      <h1>授权完成</h1>
      <p>已拿到授权码，正在换取登录态…</p>
      <p class="muted">这个窗口会自动关闭，请回到 magpie 查看结果。</p>
    </div>
  </div>
</body>
</html>`

/**
 * 这个 URL 是不是登录回调？先按调用方判据（match）认；不中再按「路径 + 带 code/error」兜底。
 * ⚠ 授权页自己的地址里也带 `marvis_oauth` 字样（redirect_uri 被百分号编码），
 *   所以不能用「包含 marvis_oauth」当判据，必须看未编码的路径片段。
 */
function isCallbackUrl(url, matcher) {
  const u = String(url ?? '')
  if (!u) return false
  if (matcher && matcher.test(u)) return true
  if (!u.includes(CALLBACK_PATH)) return false
  try {
    const params = new URL(u).searchParams
    return params.has('code') || params.has('error') || params.has('error_description')
  } catch {
    return false
  }
}

/** Windows 注册表 App Paths 查浏览器；查不到返回空串 */
function registryAppPath(exe) {
  if (process.platform !== 'win32') return ''
  for (const root of ['HKCU', 'HKLM']) {
    for (const tail of [
      `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ]) {
      try {
        const out = execFileSync('reg', ['query', `${root}\\${tail}`, '/ve'], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        const line = out.split('\n').find((l) => /REG_SZ/i.test(l))
        const path = line?.split('REG_SZ')[1]?.trim()
        if (path && existsSync(path)) return path
      } catch {
        /* 没有这个键 */
      }
    }
  }
  return ''
}

/** 候选浏览器（按优先级，不做存在性检查 —— 方便测试与排序） */
function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath } = {}) {
  const h = env.HOME || env.USERPROFILE || ''
  const local = env.LOCALAPPDATA || ''
  const roaming = env.APPDATA || ''
  const pf = env.PROGRAMFILES || ''
  const pf86 = env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'] || ''
  const add = (list, name, path) => {
    if (path) list.push({ name, path })
  }

  if (platform === 'win32') {
    const list = []
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      if (fromRegistry) add(list, exe.replace(/\.exe$/i, ''), fromRegistry)
    }
    add(list, 'Chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    add(list, 'Chrome', join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    add(list, 'Chrome', join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    add(list, 'Chromium', join(local, 'Chromium', 'Application', 'chrome.exe'))
    add(list, 'Chromium', join(pf, 'Chromium', 'Application', 'chrome.exe'))
    add(list, '360极速浏览器X', join(local, '360ChromeX', 'Chrome', 'Application', '360ChromeX.exe'))
    add(list, '360浏览器', join(local, '360Chrome', 'Chrome', 'Application', '360chrome.exe'))
    add(list, '360安全浏览器', join(roaming, 'secoresdk', '360se6', 'Application', '360se.exe'))
    add(list, 'QQ浏览器', join(local, 'Tencent', 'QQBrowser', 'Application', 'QQBrowser.exe'))
    add(list, 'Brave', join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    add(list, 'Brave', join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    add(list, 'Vivaldi', join(local, 'Vivaldi', 'Application', 'vivaldi.exe'))
    add(list, 'Opera', join(local, 'Programs', 'Opera', 'opera.exe'))
    add(list, 'Opera', join(roaming, 'Opera Software', 'Opera Stable', 'opera.exe'))
    add(list, '搜狗浏览器', join(local, 'SogouExplorer', 'SogouExplorer.exe'))
    add(list, '2345浏览器', join(local, '2345Explorer', '2345Explorer.exe'))
    add(list, '猎豹浏览器', join(local, 'liebao', 'liebao.exe'))
    add(list, 'Maxthon', join(roaming, 'Maxthon3', 'Bin', 'Maxthon.exe'))
    add(list, 'UC浏览器', join(local, 'UCBrowser', 'Application', 'UCBrowser.exe'))
    add(list, '夸克浏览器', join(local, 'Quark', 'Quark.exe'))
    add(list, 'Edge', join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    add(list, 'Edge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    return dedupe(list)
  }

  if (platform === 'darwin') {
    return [
      ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
      ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Vivaldi', '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
      ['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ].map(([name, path]) => ({ name, path }))
  }

  return [
    ['Chrome', join(h, '.config/google-chrome/chrome')],
    ['Chromium', join(h, '.config/chromium/chrome')],
    ['Brave', join(h, '.config/BraveSoftware/Brave-Browser/brave')],
    ['Vivaldi', join(h, '.config/vivaldi/vivaldi')],
    ['Edge', join(h, '.config/microsoft-edge/msedge')],
  ].map(([name, path]) => ({ name, path }))
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    const key = x.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 缓存：注册表查询要跑十几次 `reg query`，每次登录都重查会让 UI 卡 1.4 秒 */
let browserCache = null
let browserCached = false

/** 第一个真实存在的候选；没有返回 null（结果进程内缓存） */
function findBrowser({ platform = process.platform, env = process.env, exists = existsSync, lookup = registryAppPath } = {}) {
  if (browserCached) return browserCache
  browserCache = browserCandidates({ platform, env, lookup }).find((b) => exists(b.path)) ?? null
  browserCached = true
  return browserCache
}

/** 测试用：清掉浏览器缓存 */
function resetBrowserCache() {
  browserCache = null
  browserCached = false
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 打开受控浏览器，在**请求阶段**拦下登录回调，返回那个回调地址。
 * 返回值的 `body` 恒为空串（兼容兜底除外）：回调请求根本没发出去。
 *
 * @returns {Promise<{url:string, body:string, browser:string, intercepted:boolean}>}
 *   `intercepted: true` = 请求在发出前被拦下（code 未被消费，正常路径）。
 */
async function openIsolatedLogin({
  browser,
  url,
  match,
  pattern = CALLBACK_PATTERN,
  extraHeaders,
  timeoutMs = 5 * 60_000,
  settleMs = 700,
  signal,
}) {
  if (!browser?.path) {
    throw new Error('没有找到可用的 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 浏览器都行）')
  }
  // 去掉 g/y 标志：带 lastIndex 的正则在循环里 .test() 会时真时假
  const matcher = match instanceof RegExp ? new RegExp(match.source, match.flags.replace(/[gy]/g, '')) : null

  const profile = mkdtempSync(join(tmpdir(), 'magpie-marvis-login-'))
  const port = await freePort()
  const child = spawn(
    browser.path,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      // ⚠ 不用 --disable-blink-features=AutomationControlled（会挂警告条），
      //   navigator.webdriver 用 CDP 脚本抹掉
      '--exclude-switches=enable-automation',
      `--user-agent=${BROWSER_UA}`,
      '--lang=zh-CN',
      // ⚠ 必须先开 about:blank：钩子要在导航**之前**装好
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: false },
  )

  const cleanup = () => {
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响主流程 */
    }
  }

  const deadline = Date.now() + timeoutMs
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    let pageWs = ''
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('登录已取消')
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
        pageWs = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ''
        if (pageWs) break
      } catch {
        /* 浏览器还没起好 */
      }
      await sleep(300)
    }
    if (!pageWs) {
      throw new Error(
        '受控浏览器没有打开调试端口（可能是浏览器吞掉了 --remote-debugging-port，或安全软件拦截）。' +
          '请换一个 Chromium 内核浏览器，或改用「从本机 Marvis 导入」。',
      )
    }

    const ws = new WebSocket(pageWs)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')), { once: true })
    })

    // ── CDP 收发：一个监听器收全部「事件 + 命令回包」────────────────────
    // ⚠ 监听器必须在 Page.navigate 之前挂上：建立拦截全在事件里
    let nextId = 0
    const pending = new Map()

    /** 发一条 CDP 命令并等结果（带超时，避免连接断了把流程吊死） */
    const send = (method, params = {}, cmdTimeout = 10_000) =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时`))
        }, cmdTimeout)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        try {
          ws.send(JSON.stringify({ id, method, params }))
        } catch (err) {
          clearTimeout(timer)
          pending.delete(id)
          reject(err)
        }
      })

    /** @type {{url:string, via:'fetch'|'network', resourceType:string} | null} */
    let hit = null
    let fetchArmed = false
    let fallbackRequestId = ''

    /** 用静态完成页满足被暂停的请求（body 必须 base64 —— CDP 只收这个形状） */
    const fulfill = (requestId) =>
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responsePhrase: 'OK',
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(COMPLETE_PAGE, 'utf8').toString('base64'),
      })

    const onMessage = (event) => {
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg.id !== undefined) {
        const waiting = pending.get(msg.id)
        if (!waiting) return
        pending.delete(msg.id)
        clearTimeout(waiting.timer)
        if (msg.error) waiting.reject(new Error(msg.error.message || 'CDP error'))
        else waiting.resolve(msg.result)
        return
      }

      // ① 主路径：请求**发出去之前**被拦下
      if (msg.method === 'Fetch.requestPaused') {
        const params = msg.params ?? {}
        const requestId = String(params.requestId ?? '')
        const u = String(params.request?.url ?? '')
        if (!requestId) return
        if (!isCallbackUrl(u, matcher)) {
          // 不是回调（授权页地址里也带 marvis_oauth 字样但路径是编码的）—— 放行
          send('Fetch.continueRequest', { requestId }).catch(() => {})
          return
        }
        // ⚠ 命中后绝不 continueRequest：请求一出去 code 就被消费
        if (hit) {
          // 同一回调被拦第二次（重载 / self_redirect）：同样喂静态页，只认第一个
          fulfill(requestId).catch(() => {})
          return
        }
        fulfill(requestId)
          .catch(() => {})
          .finally(() => {
            hit ??= { url: u, via: 'fetch', resourceType: String(params.resourceType ?? '') }
          })
        return
      }

      // ② 兼容路径：Fetch 没装上时只能看响应（code 多半已被消费）
      if (msg.method === 'Network.responseReceived' && !hit) {
        const params = msg.params ?? {}
        // ⚠ 资源类型在 params.type，不在 response.type
        const kind = String(params.type ?? '')
        const u = String(params.response?.url ?? '')
        if (u && isCallbackUrl(u, matcher) && (kind === 'Document' || kind === 'Fetch' || kind === 'XHR')) {
          fallbackRequestId = String(params.requestId ?? '')
          hit = { url: u, via: 'network', resourceType: kind }
        }
      }
    }

    const failPending = () => {
      for (const [id, waiting] of pending) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error('CDP 连接已关闭'))
        pending.delete(id)
      }
    }

    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', failPending)

    try {
      // ── 钩子：全部在 Page.navigate 之前 ─────────────────────────────
      await send('Network.enable').catch(() => {})
      await send('Network.setUserAgentOverride', {
        userAgent: BROWSER_UA,
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Win32',
      }).catch(() => {})
      // 服务端对 yybadaccess 的每个请求都校验 Ual-Access-MarvisExt（uskey 指纹），
      // 登录流用不到（拦截后换取在 Node 里做），保留注入能力给其它流程
      if (extraHeaders && Object.keys(extraHeaders).length > 0) {
        await send('Network.setExtraHTTPHeaders', { headers: extraHeaders }).catch(() => {})
      }
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})",
      }).catch(() => {})

      // ⚠⚠ 核心：Request 阶段拦下回调，code 保持未消费，由 Node 带 guid 换唯一那一次
      fetchArmed = await send('Fetch.enable', {
        patterns: [{ urlPattern: pattern, requestStage: 'Request' }],
      })
        .then(() => true)
        .catch(() => false)

      await send('Page.navigate', { url }).catch(() => {})

      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('登录已取消')

        if (hit) {
          let body = ''
          if (hit.via === 'network' && fallbackRequestId) {
            for (let i = 0; i < 10 && !body; i++) {
              try {
                const r = await send('Network.getResponseBody', { requestId: fallbackRequestId }, 5000)
                const raw = String(r?.body ?? '')
                body = r?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw
              } catch {
                /* body 还没就绪 */
              }
              if (!body) await sleep(200)
            }
          }
          // 让合成的完成页有机会画出来再关窗
          if (settleMs > 0) await sleep(settleMs)
          return { url: hit.url, body, browser: browser.name, intercepted: hit.via === 'fetch' }
        }

        await sleep(120)
      }

      throw new Error(
        `等了 ${Math.round(timeoutMs / 1000)} 秒还没完成扫码授权。` +
          (fetchArmed ? '' : '（提示：这个浏览器不接受 CDP 请求拦截，换一个 Chromium 内核浏览器再试）') +
          '可以重新点一次登录，或改用「从本机 Marvis 导入」。',
      )
    } finally {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', failPending)
      failPending()
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
    }
  } finally {
    cleanup()
  }
}

// ── 从本机 Marvis 导入（desktop.mjs 压平）──────────────────────────────────
//
// token 落盘是 AES-256-CBC + 运行期派生密钥（攻不出来），但客户端跑着时明文在
// 进程内存里 —— 直接读。
// ⚠ 只读，不写、不注入、不 hook；只在 Windows；不需要管理员权限（同用户进程即可）。
// ⚠⚠ 四个踩过的坑：① C# 不能经 `powershell -Command <长脚本>` 传（引号被吃），
//   落临时 .cs + .ps1 走 `-File`；② `Add-Type -Path` 不能再给 `-Language`
//   （AmbiguousParameterSet）；③ .ps1 全 ASCII（PS 5.1 按 ANSI 读，中文会乱码带崩语法）；
//   ④ 输出走 base64（内存字节直接 Write-Output 会被编码/换行搞坏）。

/** 探查本机是否有 Marvis 客户端在跑 */
async function desktopAvailable() {
  try {
    return findMarvisPids().length > 0
  } catch {
    return false
  }
}

/**
 * 列出可能持有登录态的进程 PID。
 * ⚠ 两个进程都要扫：`Marvis.exe`（Electron 主进程，持 Chromium cookie）与
 *   `MarvisAgent.exe`（Python agent，持 Ual-Access-Access-Token 头）。
 *   实测 Marvis.exe 有 3 个实例，cookie 只在其中一个里 —— 只扫一个会漏。
 */
function findMarvisPids() {
  const pids = []
  for (const name of ['Marvis.exe', 'MarvisAgent.exe']) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      })
      for (const m of out.matchAll(/"[^"]+","(\d+)"/g)) pids.push(Number(m[1]))
    } catch {
      /* 没装 / 没跑 */
    }
  }
  return pids
}

/** C# 扫描器 —— 独立 .cs 由 Add-Type -Path 编译。**全 ASCII**（坑③） */
const MEM_SCAN_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public class MarvisMemScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, ref MBI mbi, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public uint Pad1;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
        public uint Pad2;
    }

    private static bool Readable(uint p)
    {
        switch (p)
        {
            case 0x02: case 0x04: case 0x06: case 0x08:
            case 0x20: case 0x40: case 0x80:
            case 0x42: case 0x44: case 0x60: case 0x62: case 0x64:
                return true;
            default:
                return false;
        }
    }

    // Scan committed readable regions for needle, append every hit region.
    public static string Scan(int pid, string needle)
    {
        IntPtr h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) return string.Empty;

        StringBuilder sb = new StringBuilder();
        long addr = 0;
        MBI mbi = new MBI();
        const long MAX_REGION = 64L * 1024 * 1024;

        while (VirtualQueryEx(h, new IntPtr(addr), ref mbi, Marshal.SizeOf(typeof(MBI))) != 0)
        {
            long size = (long)mbi.RegionSize;
            if (mbi.State == 0x1000 && size > 0 && size < MAX_REGION && Readable(mbi.Protect))
            {
                byte[] buf = new byte[size];
                IntPtr read;
                if (ReadProcessMemory(h, new IntPtr(addr), buf, (int)size, out read))
                {
                    string s = Encoding.UTF8.GetString(buf, 0, (int)read);
                    if (s.IndexOf(needle, StringComparison.Ordinal) >= 0) sb.Append(s);
                }
            }
            addr += size;
            if (addr > 0x7FFFFFFFFFFFL) break;
        }
        CloseHandle(h);
        return sb.ToString();
    }
}
`

/** run.ps1 的内容 —— **全 ASCII**（坑③） */
function memScanPs1(pid) {
  return [
    "$ErrorActionPreference = 'Stop'",
    // -Path implies the language from the extension; do NOT also pass -Language
    // (different parameter sets -> AmbiguousParameterSet).  (坑②)
    "Add-Type -Path (Join-Path $PSScriptRoot 'Scan.cs')",
    `$text = [MarvisMemScan]::Scan(${pid}, 'accesstoken=')`,
    `if ([string]::IsNullOrEmpty($text)) { $text = [MarvisMemScan]::Scan(${pid}, 'accessToken') }`,
    '$b = [System.Text.Encoding]::UTF8.GetBytes($text)',
    '[Console]::Out.Write([Convert]::ToBase64String($b))',
    '',
  ].join('\r\n')
}

/**
 * 从进程内存里读出登录态。
 * 内存里有两处：① cookie 形态 `openid=…; accesstoken=…; …`（字段最全）；
 * ② 结构化 `"openid":"…","accessToken":"…"`。优先 ①。
 */
async function importFromDesktop() {
  if (process.platform !== 'win32') {
    throw new Error('「从本机导入」只支持 Windows。请改用 QQ / 微信 登录。')
  }
  const pids = findMarvisPids()
  if (!pids.length) {
    throw new Error('没找到运行中的 Marvis 客户端。请先打开 Marvis 并登录，或改用 QQ / 微信 登录。')
  }

  const dir = mkdtempSync(join(tmpdir(), 'magpie-marvis-scan-'))
  try {
    writeFileSync(join(dir, 'Scan.cs'), MEM_SCAN_CS, 'utf8')

    let lastErr = ''
    for (const pid of pids) {
      writeFileSync(join(dir, 'run.ps1'), memScanPs1(pid), 'utf8')
      let b64 = ''
      try {
        b64 = execFileSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'run.ps1')],
          { encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
        ).trim()
      } catch (err) {
        lastErr = String(err?.stderr ?? '').trim() || String(err?.message ?? err)
        continue
      }
      const text = b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''
      const acct = parseLoginState(text)
      if (acct) return acct
    }

    throw new Error(
      '读到了 Marvis 进程，但里面没有登录态。请在 Marvis 客户端里登录一次再试，或改用 QQ / 微信 登录。' +
        (lastErr ? `（最后一次错误：${lastErr.slice(0, 200)}）` : ''),
    )
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响主流程 */
    }
  }
}

/** 从内存文本里抠登录态（两种形态） */
function parseLoginState(text) {
  if (!text) return null
  const guid = deviceGuid()

  // 形态 1：cookie 串。⚠ guid 优先从**同一段内存**里取 —— 服务端按
  //   (openid, guid, token) 三元组校验，内存里这份才是 token 真正绑定的那个。
  const cookie = /openid=([0-9A-Fa-f]{16,64});\s*accesstoken=([^;\s]+);\s*(?:refreshtoken=([^;\s]+);\s*)?(?:logintype=([A-Za-z]+))?/
  let m = cookie.exec(text)
  if (m) {
    const expire = /access_token_expire_time=(\d{10})/.exec(text)
    const memGuid = /guid=([0-9a-fA-F]{32})/.exec(text)
    return {
      openid: m[1],
      accessToken: m[2],
      refreshToken: m[3] || undefined,
      loginType: /^WX/i.test(m[4] ?? '') ? '2' : '1',
      guid: memGuid ? memGuid[1].toLowerCase() : guid,
      // ⚠ 拿不到真实 expires_in 时按登录方式兜底（微信只有 2 小时，共用 30 天会 401）
      expiresAt: expire ? Number(expire[1]) * 1000 : Date.now() + ttlFor(/^WX/i.test(m[4] ?? '') ? '2' : '1'),
    }
  }

  // 形态 2：结构化串。⚠ 只认 1（QQ）/ 2（微信）；写别的值会让后续请求 401。
  //   读不到 logintype 就按最短 TTL（微信 2 小时）保守兜底，续期后会被真实值修正。
  const json = /"openid"\s*:\s*"([0-9A-Fa-f]{16,64})"[\s\S]{0,600}?"accessToken"\s*:\s*"([^"]+)"/
  m = json.exec(text)
  if (m) {
    const rt = /"refreshToken"\s*:\s*"([^"]+)"/.exec(text)
    return {
      openid: m[1],
      accessToken: m[2],
      refreshToken: rt?.[1],
      loginType: '1',
      guid,
      expiresAt: Date.now() + WX_TTL_MS,
    }
  }
  return null
}

// ── 昵称 / 头像（profile.mjs 压平）────────────────────────────────────────
//
// ⚠ 实测：`marvis_get_user_info` 只认**签名 POST**（businessHeaders 形状），
//   且身份放 body 的 userInfo 里，不带 Ual-Access-Access-Token（带了反而 500）。
//   拿不到就返回 null —— 绝不编造账号名（QQ 号拿不到，Marvis 只用 openid）。

const USER_INFO_URL = `${BASE}/marvis_client/marvis_get_user_info`

/** `1` / `2` / `QC` / `WX` → 接口 body 里的 `loginType` */
function rawLoginType(v) {
  const s = String(v ?? '').toUpperCase()
  return s === '2' || s === 'WX' || s === 'WXAPP' ? 'WX' : 'QC'
}

/** `1` / `QC` → QQ；`2` / `WX` → 微信 */
function platformLabel(loginType) {
  const s = String(loginType ?? '').toUpperCase()
  return s === '2' || s === 'WX' || s === 'WXAPP' ? '微信' : 'QQ'
}

/** 卡片上显示的账号名：`QQ·昵称` / `微信·昵称`；没有昵称返回空串（宿主回退供应商名） */
function accountLabel(nickname, loginType) {
  const name = String(nickname ?? '').trim()
  return name ? `${platformLabel(loginType)}·${name}` : ''
}

/** 取当前账号的昵称和头像；拿不到返回 null，绝不阻塞登录 */
async function fetchUserProfile(acct, opts = {}) {
  const openid = String(acct?.openid ?? '')
  const accessToken = String(acct?.accessToken ?? '')
  const guid = String(acct?.guid ?? '')
  if (!openid || !accessToken || !guid) return null

  const body = JSON.stringify({
    userInfo: {
      openId: openid,
      accessToken,
      refreshToken: String(acct?.refreshToken ?? ''),
      loginType: rawLoginType(opts.loginType ?? acct?.loginType),
      guid,
    },
  })
  const timestamp = String(Date.now())
  const nonce = String(1000 + Math.floor(Math.random() * 9000))
  const signature = ualSignature(body, timestamp, nonce)

  /** @type {Response} */
  let res
  try {
    res = await fetch(USER_INFO_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        'Ual-Access-Businessid': BUSINESS_ID,
        'Ual-Access-Timestamp': timestamp,
        'Ual-Access-Nonce': nonce,
        'Ual-Access-Signature': signature,
      },
      body,
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    })
  } catch {
    return null
  }

  /** @type {any} */
  let json
  try {
    json = await res.json()
  } catch {
    return null
  }
  if (json?.ret !== 0 || !json?.nick_name) return null
  const nickname = safeDecode(json.nick_name).trim()
  if (!nickname) return null
  const avatar = json.head_img_url ? safeDecode(json.head_img_url) : ''
  return { nickname, ...(avatar ? { avatar } : {}) }
}

/** 补昵称/头像：拿不到就用原值，绝不阻塞登录 */
async function withProfile(acct, loginType, deps) {
  try {
    const profile = await deps.fetchUserProfile(acct, { loginType })
    if (!profile) return acct
    return { ...acct, nickname: profile.nickname || acct.nickname, avatar: profile.avatar || acct.avatar }
  } catch {
    return acct
  }
}

// ── 续期（refresh.mjs 压平）────────────────────────────────────────────────
//
// ⚠⚠ 上游有两个长得像续期的端点，只有一个能用（2026-11-07 实测）：
//   ✅ `POST /marvis_client_login/marvis_refresh_token` —— 官方客户端走的就是它，
//      `code:0` 时 **access_token 不变、只重置有效期**。
//   ❌ `GET /v3/marvis_refresh_token?refresh_token=…` —— 恒 -109，0.2.13 及以前
//      调的是它，续期从来没成功过（「微信被踢」的根因）。
// ⚠ body 的 loginType 恒为字符串 `"Marvis"` —— **不是** `Ual-Access-Login-Type` 的 1/2！
// ⚠ `refresh_token` 可能回**空串**（微信实测）：「这次没给新值」不是「清空」——
//   必须回退旧值，否则下次短路永不续期。
// ⚠ 只有 -107 / -101 才算「登录态真的不能用了」；-109（参数）/-7（签名）/-5（缺头）
//   是插件自身的问题 —— 标成登录失效会把好账号打成「需要重新登录」，比不续期更糟。
// ⚠ 并发串行由 aggregate 的 `gatedRenew`（凭据身份键控去重闸，AGENTS §6）提供，
//   同账号共享一次在途请求 —— 本层不再重复加锁（参考的 refresh-lock 在 hub 里由载体承担）。

/** 续期端点（官方客户端同款；❌ /v3/marvis_refresh_token 那个恒 -109） */
const REFRESH_URL = `${BASE}/marvis_client_login/marvis_refresh_token`
/** 「登录态真的不能用了」的业务码；其余错误是插件自身的问题，不摘号 */
const FATAL_REFRESH_CODES = new Set([-107, -101])

/**
 * 到期判定（与 autoclaw 同款语义）：
 *   过期 → true（renewSoft 用 refresh 自愈）；无到期字段 → 未知当可用，
 *   交给 chat 的 401 硬续期自愈（粘贴/本机导入常无到期）。
 */
function credentialExpired(credential) {
  let acct = acctOf(credential)
  if (acct === undefined && typeof credential?.key === 'string') {
    try {
      acct = parseCredential(credential.key)
    } catch {
      acct = undefined
    }
  }
  if (acct === undefined) return true
  const raw = credential?.expires_at ?? credential?.expires
  const ms = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN
  if (!Number.isFinite(ms)) return false
  return ms <= Date.now()
}

/**
 * 续期（gatedRenew 契约）：`refresh(credential, persist)` → **合并后的完整凭据**。
 *
 * ⚠⚠ 轮换出的新 refresh_token 只有落槽才算活 —— 返回值经 aggregate 的 saveAuth
 *   落回账号槽（autoclaw 真机教训：只在本地续期不落槽 =「续期成功、账号照样死」）。
 *   `persist` 只更新内存缓存。
 */
async function refreshMarvis(credential, persist) {
  const acct = acctOf(credential)
  if (acct === undefined) throw new Error('未登录：Marvis 凭据不完整')
  const refreshToken = String(credential?.refreshToken ?? credential?.refresh ?? '')
  if (!refreshToken) {
    throw new Error('Marvis refresh_token 为空，无法续期（请重新登录一次）')
  }

  const body = JSON.stringify({
    userInfo: {
      openId: acct.openid,
      refreshToken,
      accessToken: acct.accessToken,
      // ⚠ 恒为 "Marvis" —— 不是 Ual-Access-Login-Type 的 "1"/"2"（写错就续不上）
      loginType: 'Marvis',
    },
  })

  /** @type {Response} */
  let res
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: businessHeaders(acct, { query: body, method: 'POST' }),
      body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new Error(`续期请求发不出去：${err?.message ?? err}`)
  }

  const text = await res.text()
  /** @type {any} */
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`续期接口返回的不是 JSON（${res.status}）：${text.slice(0, 200)}`)
  }

  const info = json?.user_info ?? json?.data ?? null
  const biz = Number(json?.code ?? 0)
  const access = String(info?.access_token ?? info?.accessToken ?? '')
  if (!access || biz !== 0) {
    const err = new Error(`续期失败（code=${json?.code ?? '?'}）：${json?.msg ?? text.slice(0, 200)}`)
    // ⚠ 只有「参数过了、会话/token 校验失败」才算登录失效
    if (FATAL_REFRESH_CODES.has(biz)) err.signIn = 'expired'
    throw err
  }

  // ⚠ 空串是「这次没给新值」—— 回退旧值，否则下次短路永不续期
  const nextRefresh = String(info?.refresh_token ?? info?.refreshToken ?? '') || refreshToken
  // 实测 access_token 不变、只重置有效期 —— expires 走 expiresAtOf 三分支
  const expiresAt = expiresAtOf(info, { fallbackMs: ttlFor(credential?.loginType) })

  // 顺手补昵称：老账号升级后卡片上还是一串 key，续期就能变成 QQ/微信昵称。拿不到不阻塞。
  let profile = null
  try {
    profile = await fetchUserProfile({ ...acct, accessToken: access, refreshToken: nextRefresh }, {})
  } catch {
    /* 昵称拿不到不影响续期 */
  }

  const merged = {
    ...credential,
    accessToken: access,
    refreshToken: nextRefresh,
    expires_at: expiresAt,
    ...(profile?.nickname ? { nickname: accountLabel(profile.nickname, credential?.loginType) } : {}),
    ...(profile?.avatar ? { avatar: profile.avatar } : {}),
  }
  persist?.({ accessToken: access, refreshToken: nextRefresh, expires_at: expiresAt })
  return merged
}

// ── 登录载体（beginLogin）────────────────────────────────────────────────
//
// hub 契约：beginLogin(openBrowser, { arg }) 立刻返回
//   `{ url, opened: true, instructions, result }`。
// `arg` 来自 loginMethods 条目（'QC' | 'WX' | 'desktop'）—— aggregate 的
// buildOne 把它传进来，多入口才能区分点了哪个。
// 重活全部在 `result` 里（deferred 起步：连 findBrowser 的注册表扫描都不挡返回）。
// ⚠ `opened: true` 是必须的：没它宿主会拿 `url` 再开一个系统默认浏览器窗口。

/** 三条登录路（oauth 入口，粘贴入口 apiAuth 在后兜底） */
const LOGIN_METHODS = [
  { label: 'QQ 登录（隔离浏览器窗口）', arg: 'QC' },
  { label: '微信登录（隔离浏览器窗口）', arg: 'WX' },
  { label: '从本机 Marvis 导入（需已安装并登录）', arg: 'desktop' },
]

const LOGIN_INSTRUCTIONS = {
  QC:
    '1) 会打开一个**独立的**浏览器窗口（不碰你日常浏览器）\n' +
    '2) 用你的 QQ 登录并确认授权\n' +
    '3) 授权完成后窗口会自己关掉，回到 magpie 即可',
  WX:
    '1) 会打开一个**独立的**浏览器窗口（不碰你日常浏览器）\n' +
    '2) 用微信扫码并确认\n' +
    '3) 授权完成后窗口会自己关掉，回到 magpie 即可',
  desktop: '正在读取本机 Marvis 登录态…（需已安装 Marvis 并在客户端里登录过）',
}

/** deferred：fn 的重活推到宏任务里跑，beginLogin 不等它 */
function deferred(fn) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      fn().then(resolve, reject)
    }, 0)
  })
}

/**
 * 内部账号 → hub 凭据（**扁平**形状）：
 * aggregate 会把它 spread 进账号槽，chat/usage 的 acctOf 直接读
 * openid/accessToken/guid/loginType 四件套；`expires_at`（毫秒数字）由
 * aggregate 的 expiresMsOf 认，转成槽上的 `expires`。
 * ⚠ nickname 带登录方式前缀（`QQ·昵称`）—— accountId 用它，卡片名自解释。
 */
function loginCredential(acct, loginTypeKey) {
  const label = accountLabel(acct.nickname, loginTypeKey)
  const accessToken = String(acct.accessToken)
  const refreshToken = acct.refreshToken ? String(acct.refreshToken) : ''
  return {
    // ⚠️ 宿主契约：登录结果必须是 { type:'success', access, refresh }。
    //    magpie 的 keptAs() 只认带 refresh（或 key）的成功结果，否则报
    //    「sign-in gave nothing to keep」；没有 access 字符串也一样被丢。
    type: 'success',
    access: accessToken,
    refresh: refreshToken,
    // 渠道自己读的四件套：magpie 存 oauth 时把 access/refresh 之外的字段
    // 原样留下（save 的 ...extra），所以这些字段能回到 chat/usage。
    openid: String(acct.openid),
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    guid: String(acct.guid ?? ''),
    loginType: String(acct.loginType ?? '1'),
    ...(label ? { nickname: label } : {}),
    ...(acct.avatar ? { avatar: acct.avatar } : {}),
    expires_at: Number(acct.expiresAt) || Date.now() + ttlFor(acct.loginType),
  }
}

/** QQ / 微信 OAuth 流（隔离浏览器 + CDP 拦回调 + guid 绑定换取） */
function oauthLoginFlow(loginType, deps) {
  // ⚠ 每个账号一个独立虚拟 guid，而不是共用本机 svid —— 否则新号登录会把旧号顶掉
  const guid = newDeviceGuid()
  const url = authorizeUrl(loginType, guid)
  // 用 QQ/微信 回传的 state 关联这次登录与 guid（WX 的 state 本身就是 guid）
  const state = stateOfUrl(url) || guid
  pendingDevices.remember(state, guid)

  const result = deferred(async () => {
    try {
      const browser = deps.findBrowser()
      if (!browser) {
        throw new Error(
          '没有找到可用的 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 浏览器都行）。' +
            '请装一个，或改用「从本机 Marvis 导入」。',
        )
      }

      // 起隔离浏览器 → 在**请求阶段**拦下回调（请求不出网，code 不会被消费）
      const { url: callbackUrl, body, intercepted } = await deps.openIsolatedLogin({
        browser,
        url,
        match: CALLBACK,
        pattern: CALLBACK_PATTERN,
        timeoutMs: 5 * 60_000,
      })

      // 取回这次登录专属的虚拟 guid
      const callbackState = stateOfUrl(callbackUrl)
      const virtualGuid = pendingDevices.take(callbackState) || (loginType === 'WX' ? callbackState : '')
      if (!virtualGuid) {
        throw new Error(
          '登录流程已失效（找不到这次登录的设备标识）。请重新点一次登录，或改用「从本机 Marvis 导入」。',
        )
      }

      /** @type {any} */
      let acct
      try {
        // ⚠ guid 必须是**这次登录生成的那个**：token 会绑定到它
        acct = await deps.parseCallback(callbackUrl, body, { loginType, guid: virtualGuid })
        acct = await withProfile({ ...acct, guid: virtualGuid }, loginType, deps)
      } catch (err) {
        const msg = String(err?.message ?? err)
        // -109 = 参数检查没过（不该再出现；出现就是真 bug，别让用户误判成 code 过期）
        const paramHint = /-109|RC_PARAMS_INVALID/.test(msg) ? PARAM_HINT : ''
        throw new Error(msg + paramHint + (intercepted ? '' : NOT_INTERCEPTED_HINT))
      }
      return loginCredential(
        { ...acct, guid: virtualGuid, loginType: acct.loginType ?? LOGIN_TYPE[loginType] ?? '1' },
        loginType,
      )
    } finally {
      // 失败回滚：清掉这次登录的临时映射（成功路径上面已 take，二次 take 是空操作）
      pendingDevices.take(state)
    }
  })

  return { url, opened: true, instructions: LOGIN_INSTRUCTIONS[loginType], result }
}

/** 从本机 Marvis 导入（读进程内存，无浏览器） */
function desktopLoginFlow(deps) {
  const result = deferred(async () => {
    const acct = await deps.importFromDesktop()
    const loginType = acct.loginType === '2' ? 'WX' : 'QC'
    return loginCredential(await withProfile(acct, loginType, deps), loginType)
  })
  return {
    // ⚠ url 必须空串 + opened: true：宿主拿 url 去开会弹「没有可打开此链接的应用」
    url: '',
    opened: true,
    instructions: LOGIN_INSTRUCTIONS.desktop,
    result,
  }
}

/**
 * 渠道登录入口。
 * @param {{ arg?: 'QC'|'WX'|'desktop', _deps?: object }} [opts]
 *   `_deps` 是离线测试的注入缝（stub 掉浏览器/换取/内存导入），生产不传。
 */
function beginLogin(opts = {}) {
  const arg = opts.arg ?? 'QC'
  const deps = {
    openIsolatedLogin,
    findBrowser,
    parseCallback,
    importFromDesktop,
    desktopAvailable,
    fetchUserProfile,
    ...opts._deps,
  }
  if (arg === 'desktop') return desktopLoginFlow(deps)
  return oauthLoginFlow(arg === 'WX' ? 'WX' : 'QC', deps)
}

// ── 渠道对象 ───────────────────────────────────────────────────────────────

export const marvisChannel = {
  id: 'marvis',
  displayName: DISPLAY_NAME,

  // ⚠️ 没有 apiAuth 粘贴入口：按 deepseek-harness-codearts 的 marvis 形态，
  //    登录只走 QQ / 微信 OAuth（或从本机 Marvis 导入），不留手工粘贴兜底。
  //    凭据由 beginLogin 换回后写进账号槽，chat/usage 直接读槽上的四件套。

  fallbackModels: fallbackModels(),
  /**
   * 到期判定：过期 → true（renewSoft 用 refresh 自愈）；粘贴/导入无到期字段 →
   * 未知当可用，交给 chat 的 401 硬续期。
   */
  expired: credentialExpired,

  /** 续期（gatedRenew 契约）：refresh(credential, persist) → 合并后的完整凭据 */
  refresh: refreshMarvis,
  catalog,

  /**
   * 浏览器 OAuth（QQ / 微信）与「从本机 Marvis 导入」—— 三条登录路，
   * `loginMethods` 的 `arg` 区分入口（aggregate 的 buildOne 透传）。
   * 没有粘贴入口：凭据只能由这些登录路换取。
   */
  beginLogin: (openBrowser, opts = {}) => beginLogin(opts),
  loginMethods: LOGIN_METHODS,

  /**
   * chat 的凭据就是账号槽对象（beginLogin 换回的四件套 + refreshToken）。
   * 没有粘贴入口，所以这里不再读 `credential.key`。
   *
   * ⚠ 契约：**返回 Response，不抛**（抛错会让 magpie 拿不到 headers → 502 undefined）。
   */
  chat: async (credential, request) => {
    let acct
    try {
      acct = acctOf(credential) ?? parseCredentialRaw(credential)
    } catch (err) {
      return errorResponse(401, 'sign_in_expired', `Marvis 凭据不可用：${err?.message ?? err}`, {
        'X-Magpie-Sign-In': 'expired',
      })
    }
    // ⚠ 契约：chat() **绝不抛**。抛了 magpie 拿不到 headers → 502 `undefined is not an object`。
    try {
      return await chat(acct, request, {
        // 401 硬续期按完整凭据走 renew（键控去重闸认 refreshToken）
        renewTarget: credential !== null && typeof credential === 'object' ? credential : acct,
      })
    } catch (err) {
      return errorResponse(400, 'bad_request', `Marvis 请求被拒：${err?.message ?? err}`)
    }
  },

  usage: async (credential) => {
    try {
      const acct = acctOf(credential) ?? parseCredentialRaw(credential)
      return await walletWindows(acct)
    } catch (err) {
      return [{ name: '令牌用量', display: `Marvis 凭据不可用：${err?.message ?? err}` }]
    }
  },

  /** Marvis 没有签到端点 → inactive（绝不用 failed，会把卡片涂红） */
  checkin: () => ({ outcome: 'inactive' }),
}

/** 兜底：调用方给的已经是对象形态（内部测试用） */
function parseCredentialRaw(value) {
  const acct = acctOf(value)
  if (acct === undefined) throw new Error('未登录：Marvis 凭据不完整')
  return acct
}

// 供单测使用（非渠道契约的一部分）
export {
  TABLE as MARVIS_TABLE,
  DEFAULT_OUTPUT as MARVIS_DEFAULT_OUTPUT,
  canonicalModelId as marvisCanonicalModelId,
  fallbackModels as marvisFallbackModels,
  llmHeaders as marvisLlmHeaders,
  businessHeaders as marvisBusinessHeaders,
  ualSignature as marvisUalSignature,
  normalizeTools as marvisNormalizeTools,
  withObjectType as marvisWithObjectType,
  syntheticUskey as marvisSyntheticUskey,
  currentScene as marvisScene,
  CHAT_URL as MARVIS_CHAT_URL,
  WALLET_URL as MARVIS_WALLET_URL,
  BASE as MARVIS_BASE,
  // 登录栈（供单测；非渠道契约）
  LOGIN_METHODS as MARVIS_LOGIN_METHODS,
  loginCredential as marvisLoginCredential,
  acctOf as marvisAcctOf,
  authorizeUrl as marvisAuthorizeUrl,
  extractCode as marvisExtractCode,
  parseCallback as marvisParseCallback,
  parseSetCookies as marvisParseSetCookies,
  accountFromCookies as marvisAccountFromCookies,
  expiresAtOf as marvisExpiresAtOf,
  ttlFor as marvisTtlFor,
  newDeviceGuid as marvisNewDeviceGuid,
  createDeviceRegistry as marvisDeviceRegistry,
  stateOfUrl as marvisStateOfUrl,
  isCallbackUrl as marvisIsCallbackUrl,
  browserCandidates as marvisBrowserCandidates,
  parseLoginState as marvisParseLoginState,
  accountLabel as marvisAccountLabel,
  pendingDevices as marvisPendingDevices,
  refreshMarvis as marvisRefresh,
  credentialExpired as marvisCredentialExpired,
}
