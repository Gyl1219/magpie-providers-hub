// LobsterAI（有道龙虾）渠道 —— 移植自 DSH `lobsterai.ts` / `lobsterai-oauth.ts` /
// `lobsterai-product.ts` / `lobsterai-credits.ts`。
//
// ## 协议速览（DSH 实证，见 lobsterai2api + docs/lobsterai-integration-plan.md §4）
//
// ```
// 业务基址  https://lobsterai-server.youdao.com
//   POST /api/auth/exchange              换 token（无 Authorization）
//   POST /api/auth/refresh               续期（无 Authorization）
//   POST /api/proxy/v1/chat/completions  对话（Bearer，仅 SSE，**裸流不套信封**）
//   GET  /api/models/available           模型列表（Bearer）
//   GET  /api/user/profile-summary       积分余额（Bearer）
// 登录门户  https://lobsterai.youdao.com/portal#/login?...（回调到本机 127.0.0.1）
// ```
//
// ## 三条必须记住的坑
//
// 1. **信封统一 `{code, msg, data}`，`code !== 0` 即失败** —— 唯一例外是 chat
//    端点：它返回**裸 SSE，不套信封**，故不能用 parseEnvelope 解它。
// 2. **refresh 不带 Authorization**（带着会被拒）：匿名头 = Accept +
//    Content-Type + User-Agent，仅此三。
// 3. **模型列表要带客户端能力头**：不带 `X-LobsterAI-Client-Capabilities` 与
//    `X-LobsterAI-Client-Version` 时 `/api/models/available` 只回 25 个模型且
//    缺 `kimi-k3`（实测）；带上才是完整 26 个。
//
// ## 与 DSH 的有意差异
//
// DSH 把登录编排收在单进程 Promise 里（不学 Go 版的 /tmp 状态文件 + shell 编排）；
// 本移植沿用同一取舍，并复用 officeace 验证过的「立刻返回 URL、result 稍后 settle」契约。

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { untilText } from './shared.mjs'

export const CHANNEL_ID = 'lobsterai'
export const DISPLAY_NAME = 'LobsterAI（有道龙虾）'

const API_BASE = 'https://lobsterai-server.youdao.com'
const PORTAL_BASE = 'https://lobsterai.youdao.com'

const CALLBACK_PATH = '/auth/callback'
const EXCHANGE_PATH = '/api/auth/exchange'
const REFRESH_PATH = '/api/auth/refresh'
const MODELS_PATH = '/api/models/available'
const CHAT_PATH = '/api/proxy/v1/chat/completions'
const PROFILE_PATH = '/api/user/profile-summary'
const UPDATE_PATH = '/api/version/update'
// 每日签到活动（三步：slot → context → actions/check_in）
const ACTIVITY_SLOT_PATH = '/api/client-activities/slot'
const ACTIVITY_CONTEXT_PATH = '/api/client-activities'
/** 活动槽位查询参数（对齐 DSH 的 sigin.py / client.go 实测值）。 */
const SLOT_PLACEMENT = 'desktop_sidebar'
const SLOT_CONTAINER_API_VERSION = '2'
const SLOT_PLATFORM = 'win32'

const REQUEST_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
/** 客户端版本号缓存（12h）：日期式版本号，签到与模型列表都要带。 */
const VERSION_TTL_MS = 12 * 60 * 60 * 1000
/**
 * 版本号兜底值。DSH 实测 2026-09-04 为 `2026.9.4`；拉不到更新接口时用它 ——
 * 它只是请求头/query 里的客户端声明，不是鉴权凭据。
 */
const FALLBACK_CLIENT_VERSION = '2026.9.4'
/** `X-LobsterAI-Client-Capabilities` 取值（带上才回完整 26 个模型）。 */
const CLIENT_CAPABILITIES = 'chat,vision,tools'
/** User-Agent：对齐客户端（有道系）。 */
const USER_AGENT = `LobsterAI/${FALLBACK_CLIENT_VERSION}`

// ── 信封 ────────────────────────────────────────────────────────────────

/** ⚠️ 统一信封 `{code, msg, data}`：`code !== 0` 即失败（chat 端点除外）。 */
export function parseEnvelope(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: undefined, message: '响应不是 JSON 对象', data: undefined }
  }
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  const message = typeof payload.msg === 'string' ? payload.msg
    : (typeof payload.message === 'string' ? payload.message : '')
  if (!Number.isFinite(code) || code !== 0) {
    return {
      ok: false,
      code: Number.isFinite(code) ? code : undefined,
      message: message.length > 0 ? message : `业务错误 ${String(payload.code)}`,
      data: undefined,
    }
  }
  return { ok: true, code, message, data: payload.data }
}

// ── 请求头 ──────────────────────────────────────────────────────────────

/** 匿名头（exchange / refresh 用，**不带 Authorization**）。 */
const anonymousHeaders = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': USER_AGENT,
})

/** 带凭据头（Bearer + 客户端能力/版本头）。 */
const authorizedHeaders = (credential, clientVersion) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': USER_AGENT,
  Authorization: `Bearer ${credential.access_token}`,
  'X-LobsterAI-Client-Capabilities': CLIENT_CAPABILITIES,
  'X-LobsterAI-Client-Version': clientVersion ?? FALLBACK_CLIENT_VERSION,
})

// ── 客户端版本号（12h 缓存，失败回落常量）────────────────────────────────

let versionCache = { at: 0, value: undefined }

/** 校验并归一化日期式版本号：主干点分数字 + 可选预发布后缀。 */
function parseClientVersion(raw) {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  if (!/^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) return undefined
  return value
}

async function clientVersion() {
  if (Date.now() - versionCache.at < VERSION_TTL_MS && versionCache.value !== undefined) {
    return versionCache.value
  }
  try {
    const response = await fetch(`${API_BASE}${UPDATE_PATH}`, {
      headers: anonymousHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      const body = await response.json()
      // 该端点形状与业务接口不同：{data:{value:{version}}}
      const parsed = parseClientVersion(body?.data?.value?.version)
      if (parsed !== undefined) {
        versionCache = { at: Date.now(), value: parsed }
        return parsed
      }
    }
  } catch { /* 回落常量 */ }
  versionCache = { at: Date.now(), value: FALLBACK_CLIENT_VERSION }
  return FALLBACK_CLIENT_VERSION
}

// ── 登录：本地回调 + authCode 换 token ──────────────────────────────────

/** 起本地回调服务，立刻返回 loginUrl + result（result 稍后 settle）。 */
async function beginLogin(openBrowser) {
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {})
  const state = randomUUID()
  const uuid = randomUUID()
  // firstKeyfrom：客户端首次启动时刻（毫秒串），exchange 必填
  const firstKeyfrom = String(Date.now())

  let server
  let closed = false
  let timer
  const closeServer = () => new Promise((resolve) => {
    if (closed || !server) return resolve()
    closed = true
    server.close(() => resolve())
  })
  const settle = (ok, value) => {
    if (timer !== undefined) clearTimeout(timer)
    void closeServer()
    ok ? settleOk(value) : settleFail(value)
  }
  timer = setTimeout(() => settle(false, new Error('LobsterAI 登录超时（超过 10 分钟无回调）')), LOGIN_TIMEOUT_MS)

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404); res.end('not found')
        return
      }
      // ⚠️ state 必须回验（回调可被任意页面触发）
      if (url.searchParams.get('state') !== state) {
        settle(false, new Error('LobsterAI 回调 state 不匹配（疑似被劫持，请重试）'))
        sendJson(400, { ok: false, message: 'state 不匹配' })
        return
      }
      const code = url.searchParams.get('code') ?? url.searchParams.get('authCode') ?? ''
      if (code.length === 0) {
        settle(false, new Error('LobsterAI 回调缺少 code'))
        sendJson(400, { ok: false, message: '缺少 code' })
        return
      }
      const credential = await exchangeAuthCode(code, { uuid, firstKeyfrom })
      sendJson(200, { ok: true, message: '登录成功，可以关闭此页面' })
      settle(true, credential)
    } catch (error) {
      settle(false, error instanceof Error ? error : new Error(String(error)))
      sendJson(200, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })

  const port = await new Promise((resolve, reject) => {
    let settled = false
    server.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      settled = true
      server.on('error', () => {})
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    settle(false, new Error(`LobsterAI 回调端口无法监听（${error.message}）`))
    throw error
  })

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const query = new URLSearchParams({ source: 'electron', redirect_uri: redirectUri, state })
  const url = `${PORTAL_BASE}/portal#/login?${query.toString()}`
  if (openBrowser) openBrowser(url)
  return { url, result, instructions: `在打开的页面完成有道龙虾登录，完成后本窗口自动继续。也可以手动打开：${url}` }
}

/**
 * authCode 换凭据。请求体必须含 5 个字段（对齐 Go 侧 main.go:264-270）：
 * `authCode` / `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`。
 */
async function exchangeAuthCode(code, session) {
  const version = await clientVersion()
  const body = {
    authCode: code,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: String(Date.now()),
    uuid: session.uuid,
    version,
  }
  const response = await fetch(`${API_BASE}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: anonymousHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`LobsterAI exchange 响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 150)}`)
  }
  const envelope = parseEnvelope(payload)
  if (!envelope.ok) throw new Error(`LobsterAI exchange 失败：${envelope.message}`)
  return toCredential(envelope.data)
}

/** 响应载荷 → 本插件凭据（`expires_at` 统一毫秒字符串）。 */
function toCredential(data) {
  const access = typeof data?.accessToken === 'string' ? data.accessToken
    : (typeof data?.access_token === 'string' ? data.access_token : '')
  const refresh = typeof data?.refreshToken === 'string' ? data.refreshToken
    : (typeof data?.refresh_token === 'string' ? data.refresh_token : '')
  if (access.length === 0) throw new Error('LobsterAI 响应缺少 accessToken')
  const expiresInSec = Number(data?.expiresIn ?? data?.expires_in)
  const credential = {
    access_token: access,
    refresh_token: refresh,
  }
  if (Number.isFinite(expiresInSec) && expiresInSec > 0) {
    credential.expires_at = String(Date.now() + expiresInSec * 1000)
  }
  const uid = typeof data?.uid === 'string' ? data.uid : undefined
  const userId = typeof data?.userId === 'string' ? data.userId : undefined
  const nickname = typeof data?.nickname === 'string' ? data.nickname : undefined
  if (uid !== undefined) credential.uid = uid
  if (userId !== undefined) credential.user_id = userId
  if (nickname !== undefined) credential.nickname = nickname
  return credential
}

// ── 续期（**不带 Authorization**）────────────────────────────────────────

async function refresh(credential, persist) {
  if (typeof credential?.refresh_token !== 'string' || credential.refresh_token.length === 0) {
    throw new Error('LobsterAI 没有 refresh_token，请重新登录')
  }
  const body = {
    refreshToken: credential.refresh_token,
    userId: credential.user_id ?? credential.uid ?? '',
  }
  const response = await fetch(`${API_BASE}${REFRESH_PATH}`, {
    method: 'POST',
    headers: anonymousHeaders(), // ⚠️ 不能带 Authorization
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => undefined)
  const envelope = parseEnvelope(payload)
  if (!envelope.ok) {
    const error = new Error(`LobsterAI 续期失败：${envelope.message}`)
    // 终态：refresh_token 失效只能重登
    if (/invalid|expired|无效|过期/i.test(envelope.message)) error.signedOut = true
    throw error
  }
  const next = toCredential(envelope.data)
  // 保留身份字段（上游续期响应可能不带）
  if (next.uid === undefined && credential.uid !== undefined) next.uid = credential.uid
  if (next.user_id === undefined && credential.user_id !== undefined) next.user_id = credential.user_id
  if (next.nickname === undefined && credential.nickname !== undefined) next.nickname = credential.nickname
  if (typeof persist === 'function') persist(next)
  return next
}

/** 到期判定（提前 10 分钟，与其余渠道一致）。无 expires_at 视为不过期。 */
function expired(credential) {
  const raw = credential?.expires_at
  const ms = typeof raw === 'string' ? Number(raw) : (typeof raw === 'number' ? raw : NaN)
  if (!Number.isFinite(ms) || ms <= 0) return false
  return ms <= Date.now() + 10 * 60 * 1000
}

// ── 目录（必须带能力头，否则少一个模型）─────────────────────────────────

const CONTEXT_CAP = 1e15 // 防御 308 位数字串（DSH 审计实测的真实缺陷）

function readNum(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0 || n > CONTEXT_CAP) return undefined
  return n
}

async function fetchCatalog(credential) {
  const version = await clientVersion()
  const response = await fetch(`${API_BASE}${MODELS_PATH}`, {
    headers: authorizedHeaders(credential, version),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`LobsterAI 目录读取失败：HTTP ${response.status}`)
  const payload = await response.json().catch(() => undefined)
  const envelope = parseEnvelope(payload)
  if (!envelope.ok) throw new Error(`LobsterAI 目录读取失败：${envelope.message}`)
  const rows = Array.isArray(envelope.data) ? envelope.data
    : (Array.isArray(envelope.data?.models) ? envelope.data.models : [])
  const models = {}
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id = typeof row.id === 'string' ? row.id.trim()
      : (typeof row.model === 'string' ? row.model.trim() : '')
    if (id.length === 0) continue
    const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : id
    const context = readNum(row.contextWindow ?? row.context_length) ?? 131_072
    const output = readNum(row.maxTokens ?? row.max_tokens) ?? 8192
    const inputs = Array.isArray(row.inputModalities) ? row.inputModalities : []
    const attachment = inputs.includes('image') || row.supportsVision === true || row.vision === true
    models[id] = {
      name,
      limit: { context, output },
      tool_call: true,
      capabilities: { temperature: true, reasoning: true, attachment },
      options: {},
      headers: {},
      variants: {},
      status: 'active',
      release_date: '',
    }
  }
  return models
}

/**
 * 兜底目录（DSH 实测 `GET /api/models/available` 拉到的常用条目）。
 * ⚠️ 上游若有变化以远端为准；这里只在远端整体失败时顶替。
 */
const FALLBACK_MODELS = {
  'deepseek-v4': { name: 'DeepSeek V4', limit: { context: 131_072, output: 8192 } },
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', limit: { context: 1_000_000, output: 8192 } },
  'glm-5.3': { name: 'GLM-5.3', limit: { context: 1_000_000, output: 8192 } },
  'kimi-k2.6': { name: 'Kimi K2.6', limit: { context: 262_144, output: 8192 } },
  'qwen3.8-max': { name: 'Qwen 3.8 Max', limit: { context: 1_000_000, output: 8192 } },
  'minimax-m3': { name: 'MiniMax M3', limit: { context: 1_000_000, output: 8192 } },
}

// ── chat（OpenAI 兼容，**仅 SSE、裸流不套信封**）────────────────────────

async function chat(credential, { body, signal, renew }) {
  const version = await clientVersion()
  const send = (cred) => fetch(`${API_BASE}${CHAT_PATH}`, {
    method: 'POST',
    headers: {
      ...authorizedHeaders(cred, version),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  })

  let response = await send(credential)
  // 401/403 → 硬续期一次再重发（refresh_token 轮换渠道的常规兜底）
  if ((response.status === 401 || response.status === 403) && typeof renew === 'function') {
    let renewed
    try {
      renewed = await renew(credential)
    } catch {
      renewed = undefined
    }
    if (renewed !== undefined && renewed.access_token !== credential.access_token) {
      response = await send(renewed)
    }
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    // 非流式：这里才可能是信封（chat 正常路径是裸 SSE，不套信封）
    const text = await response.text().catch(() => '')
    let message = text.slice(0, 200)
    try {
      const envelope = parseEnvelope(JSON.parse(text))
      if (!envelope.ok) message = envelope.message
    } catch { /* 原样 */ }
    return Response.json(
      { error: { type: 'provider_error', message: `LobsterAI 返回（HTTP ${response.status}）：${message}` } },
      { status: response.status >= 400 ? response.status : 502 },
    )
  }
  // 标准 OpenAI SSE，原样透传
  return response
}

// ── 余额 / 签到 ─────────────────────────────────────────────────────────

const readNumber = (v) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 && n <= CONTEXT_CAP ? n : undefined
}
const readBool = (v) => v === true

/** 带凭据的 JSON 请求（目录/余额/活动三处共用）。 */
async function requestJson(path, credential, init) {
  const version = await clientVersion()
  const response = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: authorizedHeaders(credential, version),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) return { ok: false, response, body, message: `HTTP ${response.status}` }
  return { ok: true, response, body }
}

/**
 * 积分余额 → magpie windows。
 *
 * ⚠️ 用 `profile-summary` 而不是 `/api/user/quota`：后者只显示
 * `freeCreditsTotal=300`、**不含活动积分**（DSH 实测：同一账号 profile-summary
 * 有 5297.72，quota 只有 300）。
 *
 * ⚠️ **逐笔输出，不按 label 聚合**：`creditItems[]` 每行带 `expiresAt`
 * （ISO 8601，实测"2026-10-23T01:21:23"，可能空格分隔）—— 每笔到账时间不同、
 * 作废时间各异，按 label 求和会把「明天作废的 100」和「下月作废的 100」
 * 混成一桶（到期信息丢失）。逐笔带 `amount` + `runsOutAt` 交给聚合层的
 * 指针汇总（与 AutoClaw 的 8 批流水同款：>3 桶自动折叠成 临期/长期/永久）。
 * 已过期的包不可用，跳过（与 minimaxintl 同口径）。
 */
async function usage(credential) {
  const result = await requestJson(PROFILE_PATH, credential)
  if (!result.ok) {
    return [{ name: DISPLAY_NAME, used: 0, display: `额度服务不可用（${result.message}）` }]
  }
  const envelope = parseEnvelope(result.body)
  if (!envelope.ok) {
    return [{ name: DISPLAY_NAME, used: 0, display: `积分查询失败：${envelope.message}` }]
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  const items = Array.isArray(data.creditItems) ? data.creditItems : []
  const total = readNumber(data.totalCreditsRemaining)
  const now = Date.now()
  const windows = []
  let sawAny = false
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const remaining = readNumber(item.creditsRemaining)
    if (remaining === undefined || remaining <= 0) continue
    sawAny = true
    // 包名用 label（人看的名字，实测"每日登录奖励"）而不是 type（"campaign"）
    const label = typeof item.label === 'string' && item.label.length > 0 ? item.label
      : (typeof item.type === 'string' ? item.type : '积分')
    const expiresAt = typeof item.expiresAt === 'string' ? item.expiresAt.replace(' ', 'T') : ''
    const expMs = expiresAt.length > 0 ? Date.parse(expiresAt) : NaN
    if (Number.isFinite(expMs) && expMs <= now) continue // 已过期的包不可用
    const until = Number.isFinite(expMs) ? untilText(new Date(expMs).toISOString(), now) : undefined
    windows.push({
      name: `${label} · 剩 ${remaining}`,
      used: 0,
      // amount 供聚合层指针汇总求和（>3 桶自动折叠成 临期/长期/永久）
      amount: remaining,
      display: until !== undefined ? `剩 ${remaining} · ${until}` : `剩 ${remaining}`,
      ...(Number.isFinite(expMs) ? { runsOutAt: new Date(expMs).toISOString() } : {}),
    })
  }
  if (windows.length === 0) {
    if (sawAny) return [{ name: DISPLAY_NAME, used: 0, display: '无可用积分（全部已过期）' }]
    if (total !== undefined) return [{ name: `${DISPLAY_NAME} · 积分`, used: 0, display: `剩余 ${total}` }]
    return [{ name: DISPLAY_NAME, used: 0, display: '响应未包含余额字段' }]
  }
  return windows
}

/**
 * 每日签到（三步，移植 lobsterai-credits.ts 的 claimLobsteraiDailyCheckin）：
 * ① `GET /api/client-activities/slot`（placement/clientVersion/containerApiVersion/platform）
 * ② `GET /api/client-activities/{code}/context?configRevision=…`
 *    —— 要**同时**看 `state.claimedToday` 与 `actions` 是否含 `check_in`
 * ③ `POST /api/client-activities/{code}/actions/check_in`（带 configRevision + idempotencyKey）
 *
 * ⚠️ 两步预检查都要做：只看 claimedToday 会漏掉「活动在但今天不该领」。
 * ⚠️ 积分三级回退：creditsGranted → rewardCredits → credits。
 */
async function checkin(credential) {
  const slotResult = await requestJson(
    `${ACTIVITY_SLOT_PATH}?${new URLSearchParams({
      placement: SLOT_PLACEMENT,
      clientVersion: await clientVersion(),
      containerApiVersion: SLOT_CONTAINER_API_VERSION,
      platform: SLOT_PLATFORM,
    }).toString()}`,
    credential,
  )
  if (!slotResult.ok) return { outcome: 'failed', message: `活动槽位查询失败：${slotResult.message}` }
  const slotEnvelope = parseEnvelope(slotResult.body)
  if (!slotEnvelope.ok) return { outcome: 'failed', message: `活动槽位查询失败：${slotEnvelope.message}` }
  const slotData = typeof slotEnvelope.data === 'object' && slotEnvelope.data !== null ? slotEnvelope.data : {}
  const activity = typeof slotData.activity === 'object' && slotData.activity !== null ? slotData.activity : {}
  const activityCode = typeof activity.activityCode === 'string' ? activity.activityCode : ''
  const slotState = typeof slotData.slotState === 'string' ? slotData.slotState : ''
  const configRevision = readNumber(activity.configRevision)
  if (slotState !== 'available' || activityCode.length === 0) {
    return { outcome: 'inactive', message: `无可用活动（slotState=${slotState || '空'}）` }
  }

  const ctxResult = await requestJson(
    `${ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(activityCode)}/context?${new URLSearchParams({
      configRevision: String(configRevision ?? 0),
    }).toString()}`,
    credential,
  )
  if (!ctxResult.ok) return { outcome: 'failed', message: `活动上下文查询失败：${ctxResult.message}` }
  const ctxEnvelope = parseEnvelope(ctxResult.body)
  if (!ctxEnvelope.ok) return { outcome: 'failed', message: `活动上下文查询失败：${ctxEnvelope.message}` }
  const ctxData = typeof ctxEnvelope.data === 'object' && ctxEnvelope.data !== null ? ctxEnvelope.data : {}
  const state = typeof ctxData.state === 'object' && ctxData.state !== null ? ctxData.state : {}
  const actions = Array.isArray(ctxData.actions) ? ctxData.actions.filter((a) => typeof a === 'string') : []
  if (readBool(state.claimedToday)) return { outcome: 'done', message: '今天已签到' }
  if (!actions.includes('check_in')) return { outcome: 'ineligible', message: '当前不可签到' }

  const claimResult = await requestJson(
    `${ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(activityCode)}/actions/check_in`,
    credential,
    {
      method: 'POST',
      body: JSON.stringify({
        configRevision: configRevision ?? 0,
        // 客户端幂等键（服务端据此去重）
        idempotencyKey: randomUUID(),
        payload: {},
      }),
    },
  )
  if (!claimResult.ok) return { outcome: 'failed', message: `签到失败：${claimResult.message}` }
  const claimEnvelope = parseEnvelope(claimResult.body)
  if (!claimEnvelope.ok) return { outcome: 'failed', message: `签到失败：${claimEnvelope.message}` }
  const claimData = typeof claimEnvelope.data === 'object' && claimEnvelope.data !== null ? claimEnvelope.data : {}
  const result = typeof claimData.result === 'object' && claimData.result !== null ? claimData.result : {}
  const credit = readNumber(result.creditsGranted) ?? readNumber(result.rewardCredits) ?? readNumber(result.credits) ?? 0
  const message = typeof result.message === 'string' && result.message.length > 0 ? result.message : undefined
  return { outcome: 'claimed', ...(credit > 0 ? { credit } : {}), ...(message ? { message } : {}) }
}

// ── 渠道对象 ────────────────────────────────────────────────────────────

export const lobsteraiChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  fallbackModels: FALLBACK_MODELS,
  beginLogin,
  refresh,
  expired,
  catalog: fetchCatalog,
  chat,
  usage,
  checkin,
}
