// AutoClaw（智谱澳龙 / OpenClaw 云账号）渠道 —— 两个站点：国际 `hub-autoclaw` / 国内 `hub-autoclaw-cn`。
//
// 与 registry 里 `@magpie-community/opencode-autoclaw-auth` 的关系（#614 标准）：
//   **同一渠道的第二入口**，差别是——本渠道除了「粘贴 access/refresh token」，
//   还能**直接读取已登录 AutoClaw 桌面端的凭据**（免重新 OAuth / 收短信）。
//   绿标包只有网页 OAuth（国际）与手机验证码（国内），两条都做不到。
//   ⚠️ 同一 AutoClaw 账号下，两个插件读的是**同一份积分余额**：绿标包用掉的，
//      本渠道看到的剩余会同步减少。
//
// 协议来源（不自行发明）：
//   · 对话 / 续期 / 模型配置：上游 iJetLi/deepseek-harness-codearts 真机实测；
//   · 钱包端点与头组合：绿标包 `opencode-autoclaw-auth` 实测（本机余额 6397/2797 实证）；
//   · 批次净额分档：上游 `parseAutoclawLedgerBatches`（2026-10-20 真机取证）。
//
// ⚠️ 「读桌面端」的安全前提（PR 里必须交代）：
//   ① 解 DPAPI 用 `execFileSync('powershell.exe', [数组])`，不经 shell；插进脚本的
//      变量是 `Buffer.toString('hex')`（只可能是 [0-9a-f]），与 #502 被拒的
//      「外部文案拼进单引号」不是一个形态；
//   ② `DataProtectionScope.CurrentUser` ⇒ 只能解当前 Windows 用户自己的凭据；
//   ③ 默认完全不读：只有用户主动点「读取桌面端登录态」才执行。

import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignExpiryBands } from './shared.mjs'

// ── 协议常量（照抄上游实测值）─────────────────────────────────────────

const APP_ID = '100003'
const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
const SOURCE_ID = 'autoclaw'
const CLIENT_VERSION = '2.1.1'

const CHAT_PATH = '/autoclaw-proxy/proxy/autoclaw/chat/completions'
const MODEL_CONFIG_PATH = '/autoclaw-proxy/proxy/autoclaw-model-config'
const REFRESH_PATH = '/userapi/v1/refresh'
const REFRESH_FALLBACK_PATH = '/userapi/v1/agent-refresh'

/**
 * 406 绕过的硬约束：首条 message 必须是 system，且内容**精确包含**这句。
 * 缺了 → 406 Not Acceptable。
 */
const REQUIRED_SYSTEM_PREFIX = 'You are AutoClaw. Answer the user directly and concisely'

/** 两个站点。userDataDirName 是桌面端 userData 目录（读凭据用），实测不同。 */
const SITES = {
  intl: {
    id: 'autoclaw',
    displayName: 'AutoClaw（国际版）',
    apiBase: 'https://autoglm-api.autoglm.ai',
    userDataDirName: 'AutoClaw-oversea-official',
  },
  cn: {
    id: 'autoclaw-cn',
    displayName: 'AutoClaw（国内版）',
    apiBase: 'https://autoglm-acceleration-api.zhipuai.cn',
    userDataDirName: 'AutoClaw-official',
  },
}

/** 兜底模型表（上游实测：`zai_glm-5.3-flash` 是唯一免费且远端目录里没有的）。 */
const FALLBACK_MODEL_IDS = [
  { id: 'zai_glm-5.3-flash', name: 'GLM-5.3-Flash (AutoClaw)', free: true },
  { id: 'zaicoding_glm-5.3', name: 'GLM-5.3 (AutoClaw)', free: false },
  { id: 'zai_auto', name: 'Auto (AutoClaw)', free: false },
  { id: 'zai_auto-fast', name: 'Auto-Fast (AutoClaw)', free: false },
]

/** 思考档只声明三档：`off` 在本仓库语义里由「不传」表达（与 zcode/buddy 一致）。 */
const REASONING_EFFORTS = ['low', 'high', 'max']
const CONTEXT_WINDOW = 1_048_576

/** 钱包类型 → 展示名（**逐字照抄**上游 `AUTOCLAW_WALLET_TYPE_LABELS`，不自行增删）。 */
const WALLET_TYPE_LABELS = {
  reward: '奖励积分',
  daily: '每日积分',
  subscription: '签约积分',
  fuel_pack: '加油包积分',
  other: '其他积分',
}

/** 流水翻页上限（上游同款 5 页；超出部分靠守恒容差兜住）。 */
const LEDGER_MAX_PAGES = 5

// ── 基础工具 ────────────────────────────────────────────────────────────

/** 剥 Bearer 前缀与空白。 */
const bareToken = (v) => String(v ?? '').trim().replace(/^Bearer\s+/i, '').trim()

/** 渠道层统一错误响应（供 chat / usage 的失败分支用）。 */
const fail = (message, status = 502) =>
  Response.json({ error: { type: 'provider_error', message } }, { status })

/** `MD5(appId&timestamp&appKey)` —— 上游静态签名。 */
const sign = (timestamp) =>
  createHash('md5').update(`${APP_ID}&${timestamp}&${APP_KEY}`).digest('hex')

/**
 * 解析用户粘贴的凭据。三种格式都收：
 *   ① `{"accessToken":"…","refreshToken":"…"}`（camelCase / snake_case / 简写）
 *   ② `accessToken=…` 每行一条（`=` / `:` 均可）
 *   ③ 整串就是一个 token（只有 access，没有 refresh）
 */
function parsePasted(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined

  // ① JSON
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text)
      const accessToken = bareToken(o.accessToken ?? o.access_token ?? o.access)
      const refreshToken = bareToken(o.refreshToken ?? o.refresh_token ?? o.refresh)
      if (accessToken !== '') return { accessToken, refreshToken }
    } catch { /* 落到 ② */ }
  }

  // ② 两行 key=value / key: value
  const map = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(accessToken|access_token|access|refreshToken|refresh_token|refresh)\s*[=:]\s*(.+?)\s*$/i.exec(line)
    if (m) map[m[1].toLowerCase()] = m[2]
  }
  const accessToken = bareToken(map.accesstoken ?? map.access_token ?? map.access)
  const refreshToken = bareToken(map.refreshtoken ?? map.refresh_token ?? map.refresh)
  if (accessToken !== '') return { accessToken, refreshToken }

  // ③ 整串就是一个 token（只有 access，没有 refresh）
  if (!/\s/.test(text)) return { accessToken: bareToken(text), refreshToken: '' }
  return undefined
}

/** magpie 的 credential → 本渠道的 { accessToken, refreshToken }。 */
function tokensOf(credential) {
  const fromKey = parsePasted(credential?.key)
  if (fromKey !== undefined) return fromKey
  const accessToken = bareToken(credential?.accessToken ?? credential?.access_token ?? credential?.access)
  if (accessToken === '') return undefined
  return {
    accessToken,
    refreshToken: bareToken(credential?.refreshToken ?? credential?.refresh_token ?? credential?.refresh),
  }
}

/**
 * 从 access token（JWT 形态时）里取 device_id —— 独立包同款：续期请求带的
 * device_id 应与凭据自身一致，而不是所有粘贴凭据共用一个常量（#652 评审意见）。
 * 非 JWT 或没有该声明 → undefined，调用方再落回各自的默认值。
 */
function jwtDeviceId(accessToken) {
  const parts = bareToken(accessToken).split('.')
  if (parts.length < 2) return undefined
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const id = payload?.device_id ?? payload?.deviceId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/** 请求头。`X-Version` 是国际站推理的**硬校验头**（缺它 → 空响应 500）。 */
function headersFor(site, { accessToken, modelId, stream }) {
  const ts = String(Math.floor(Date.now() / 1000))
  const h = {
    'Content-Type': 'application/json',
    'X-Version': CLIENT_VERSION,
    'X-Auth-Appid': APP_ID,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign(ts),
    'X-Authorization': `Bearer ${bareToken(accessToken)}`,
    'X-Product': SOURCE_ID,
  }
  if (modelId !== undefined) h['X-Request-Model'] = modelId
  if (stream === true) h.Accept = 'text/event-stream'
  return h
}

/**
 * 钱包 / 资源接口的请求头 —— **照抄绿标包 `bizHeaders` 的实测组合**。
 *
 * ⚠️⚠️ 头的历史（每一版都是真机探出来的，别再"简化"）：
 *    · 对话那套头（X-Authorization + X-Product）打钱包 → `410000 用户未登录`；
 *    · 上游 iJetLi 的 credits 头（X-Lang/X-Channel: official/UA 2.1.0，双鉴权）→ 仍 410000；
 *    · **绿标包同款才通**：只带 `Authorization`（不带 X-Authorization），
 *      `X-Version: 1.18.1` + `X-Tm` + `X-Trace-Id` + `X-Channel: AutoClaw4` +
 *      `Origin/Referer: http://localhost:18432`（桌面端本地服务的来源标）+
 *      `User-Agent: AutoClaw/1.18.1 (…)`（WAF 要求客户端 UA）。
 *
 * ⚠️ 还有一个**token 类型**坑（同一天实测）：桌面端导入的旧 token 能对话、
 *    但资产服务不认（410000）—— 用 RT 续期换发的新 token 才能查钱包。
 *    ⇒ usage 里 410000 时必须先续期再重查（见 usage 注释）。
 */
function walletHeaders(site, accessToken) {
  const ts = String(Math.floor(Date.now() / 1000))
  const h = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': 'AutoClaw/1.18.1 (Windows-x64)',
    'X-Version': '1.18.1',
    'X-Tm': String(Date.now()),
    'X-Product': SOURCE_ID,
    'X-Auth-Appid': APP_ID,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign(ts),
    'X-Trace-Id': randomBytes(16).toString('hex'),
    'X-Lang': 'zh-CN',
    'X-Channel': 'AutoClaw4',
    Origin: 'http://localhost:18432',
    Referer: 'http://localhost:18432/',
  }
  if (accessToken !== undefined && bareToken(accessToken) !== '') h.Authorization = `Bearer ${bareToken(accessToken)}`
  return h
}

/**
 * 406 绕过：首条 message 必须是 system 且**精确包含**那句前缀。
 *
 * ⚠️ 取社区包的做法（把前缀**并进**已有 system）而不是上游的独占一条：
 *   独占一条会让模型在 messages[1] 读到原生人设、与 "Answer concisely"
 *   措辞冲突（上游自己的注释承认这点未解决）。
 */
function withSystemPrefix(messages) {
  const list = Array.isArray(messages) ? [...messages] : []
  if (list.length === 0) return [{ role: 'system', content: REQUIRED_SYSTEM_PREFIX }]

  const first = list[0]
  if (first?.role !== 'system') {
    return [{ role: 'system', content: REQUIRED_SYSTEM_PREFIX }, ...list]
  }

  const text = typeof first.content === 'string'
    ? first.content
    : Array.isArray(first.content)
      ? first.content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('\n')
      : String(first.content ?? '')

  if (text.includes(REQUIRED_SYSTEM_PREFIX)) return list

  return [{ ...first, content: `${REQUIRED_SYSTEM_PREFIX}\n\n${text}` }, ...list.slice(1)]
}

// ── 模型目录 ────────────────────────────────────────────────────────────

const modelRow = (id, name, free) => ({
  name,
  limit: { context: CONTEXT_WINDOW, output: 65_536 },
  tool_call: true,
  reasoning: true,
  // ⚠️ 两处都写：magpie 读顶层 modalities/attachment（见 lingxi.mjs 注释）
  attachment: false,
  modalities: { input: ['text'], output: ['text'] },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false },
    output: { text: true },
  },
  options: { reasoning_efforts: REASONING_EFFORTS, default_reasoning_effort: 'high' },
  ...(free ? { free: true } : {}),
})

const fallbackModels = () =>
  Object.fromEntries(FALLBACK_MODEL_IDS.map((m) => [m.id, modelRow(m.id, m.name, m.free)]))

/** 远端模型配置（登录后以它为准；失败退回兜底表）。两站目录结构相同。 */
async function catalog(site, credential) {
  const tokens = tokensOf(credential)
  if (tokens === undefined) return fallbackModels()
  try {
    const res = await fetch(`${site.apiBase}${MODEL_CONFIG_PATH}`, {
      headers: headersFor(site, { accessToken: tokens.accessToken }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return fallbackModels()
    const json = await res.json()
    const rows = Array.isArray(json?.data?.models) ? json.data.models
      : Array.isArray(json?.models) ? json.models
        : Array.isArray(json?.data) ? json.data
          : []
    const out = {}
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id : ''
      if (id === '') continue
      const ctx = Number(row?.contextWindow) > 0 ? Number(row.contextWindow) : CONTEXT_WINDOW
      const rowFree = row?.isFree === true || FALLBACK_MODEL_IDS.some((f) => f.id === id && f.free)
      const base = modelRow(id, typeof row?.name === 'string' && row.name !== '' ? row.name : id, rowFree)
      base.limit = { context: ctx, output: Math.min(65_536, ctx - 1) }
      out[id] = base
    }
    return Object.keys(out).length > 0 ? out : fallbackModels()
  } catch {
    return fallbackModels()
  }
}

// ── 续期 ────────────────────────────────────────────────────────────────

/** 续期去重：同一 refresh_token 并发只发一次（RT 一次性轮换）。 */
const refreshFlight = new Map()

async function refreshOnce(site, refreshToken, deviceId) {
  const key = `${site.id}|${refreshToken.slice(-12)}`
  const running = refreshFlight.get(key)
  if (running !== undefined) return running

  const task = (async () => {
    const errors = []
    for (const path of [REFRESH_PATH, REFRESH_FALLBACK_PATH]) {
      const ts = String(Math.floor(Date.now() / 1000))
      try {
        const res = await fetch(`${site.apiBase}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Appid': APP_ID,
            'X-Auth-TimeStamp': ts,
            'X-Auth-Sign': sign(ts),
          },
          body: JSON.stringify({ refresh_token: refreshToken, source_id: SOURCE_ID, device_id: deviceId }),
          signal: AbortSignal.timeout(20_000),
        })
        const text = await res.text().catch(() => '')
        if (!res.ok) { errors.push(`${path} HTTP ${res.status} ${text.slice(0, 90)}`); continue }
        let json
        try { json = JSON.parse(text) } catch { errors.push(`${path} 非 JSON`); continue }
        const d = json?.data ?? json
        const accessToken = bareToken(d?.access_token ?? d?.accessToken)
        if (accessToken === '') { errors.push(`${path} 无 access_token`); continue }
        // 到期时间（响应里有就带上）：号槽有了 expires，magpie 才会**主动**调度
        // auth.refresh —— 一次性 RT 的轮换必须在到期前由 magpie 走落槽路径完成。
        // 只认数字（旧槽实测为毫秒）；秒级（<1e12）归一成毫秒，其余不猜。
        let expiresAt
        const rawExp = d?.expires_at ?? d?.expiresAt
        if (Number.isFinite(rawExp) && rawExp > 0) expiresAt = rawExp >= 1e12 ? rawExp : rawExp * 1000
        return {
          accessToken,
          refreshToken: bareToken(d?.refresh_token ?? d?.refreshToken) || refreshToken,
          userId: d?.user_id ?? d?.userId,
          expiresAt,
        }
      } catch (error) {
        errors.push(`${path} ${error?.message ?? error}`)
      }
    }
    throw new Error(`AutoClaw 续期失败：${errors.join('；')}`)
  })()

  refreshFlight.set(key, task)
  try { return await task } finally { refreshFlight.delete(key) }
}

// ── 对话 ────────────────────────────────────────────────────────────────

const modelOf = (body, credential) => {
  const raw = typeof body?.model === 'string' ? body.model.trim() : ''
  return raw === '' ? (credential?.model ?? 'zai_auto') : raw
}

async function chat(site, credential, { body, signal, renew } = {}) {
  const tokens = tokensOf(credential)
  if (tokens === undefined) return fail('未登录：缺少 AutoClaw accessToken', 401)

  const model = modelOf(body, credential)
  const stream = body?.stream !== false

  const payload = { ...body, model, messages: withSystemPrefix(body?.messages) }
  delete payload.max_tokens // 上游用 maxTokens，且必须 < contextWindow
  payload.stream = stream

  const send = async (accessToken) => fetch(`${site.apiBase}${CHAT_PATH}`, {
    method: 'POST',
    headers: headersFor(site, { accessToken, modelId: model, stream }),
    body: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal }),
  })

  let response
  try {
    response = await send(tokens.accessToken)
  } catch (error) {
    return fail(`连接 AutoClaw 失败：${error?.message ?? error}`)
  }

  // 401 / 403 → 续期一次再重发（RT 一次性轮换）。
  // ⚠️⚠️ 续期**必须走 init.renew（gatedRenew → channel.refresh）**，不能只在本地
  //    refreshOnce：RT 是一次性的，本地续出的新 AT/RT 若不落回账号槽，
  //    magpie 重启后槽里就是「死 AT + 已消费的 RT」⇒ 账号必死
  //    （真机事故：国际版槽就是这么被打死的——探针续期后新 token 只活在进程内存里）。
  //    gatedRenew 会把新凭据记进内存缓存，magpie 的 auth.refresh 路径负责落槽。
  if ((response.status === 401 || response.status === 403) && tokens.refreshToken !== '') {
    try {
      let renewed
      if (typeof renew === 'function') {
        renewed = await renew(credential) // gatedRenew：去重 + 记内存 + （magpie 路径）落槽
      } else {
        // 没有 renew 钩子的调用方（测试/旁路）：本地续 + 记内存
        const next = await refreshOnce(site, tokens.refreshToken, credential?.device_id ?? jwtDeviceId(tokens.accessToken) ?? 'dsh-autoclaw-device-001')
        renewed = { ...credential, ...next }
        rememberTokens(site, tokens, next)
      }
      const nextTokens = tokensOf(renewed) ?? tokens
      response = await send(nextTokens.accessToken)
    } catch (error) {
      return fail(`AutoClaw 登录态已失效：${error?.message ?? error}`, 401)
    }
  }

  if (response.status === 401 || response.status === 403) return fail('AutoClaw 登录态已失效，请重新登录', 401)
  return response
}

// ── 用量（上游 autoclaw-credits.ts 完整移植）────────────────────────────

/** 拉一次钱包。返回 { code, msg, data } 或 { error }（HTTP/解析失败）。 */
async function fetchWalletData(site, accessToken) {
  let res
  try {
    res = await fetch(`${site.apiBase}/agent-assetmgr/api/v2/wallets?biz_app_id=${SOURCE_ID}`, {
      headers: walletHeaders(site, accessToken),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return { error: `查不到余额：${error?.message ?? error}` }
  }
  if (!res.ok) return { error: `查不到余额（HTTP ${res.status}）` }
  let json
  try { json = await res.json() } catch { return { error: '查不到余额（响应非 JSON）' } }
  return { code: json?.code, msg: json?.msg, data: json?.data }
}

/** 到期日短格式（MM-DD），窗口 display 用。 */
const fmtMD = (ms) => {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 余额 —— **上游 `fetchAutoclawBalanceDetailed` 的完整移植**，不是简化版：
 *
 *   ① 钱包  `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
 *      → `total_balance` + 可见池（`display === true` **严格**过滤，缺字段=不可见，
 *        官方桌面端同口径；fail-open 会把红色「每日 0」放回来）。
 *   ② 流水  `GET /agent-assetmgr/api/v1/ledgers_std`（翻页 ≤5、page_size=100、
 *      `flow_direction: all` —— 必须含 debit/expire，否则批次和=历史发放额，
 *      用户一有消耗就不守恒 ⇒ 分档永不出现）。
 *   ③ 批次净额：`credit − debit − expire` 按同一 `wallet_expires_at`（unix 秒）归批；
 *      负 credit（冲正）丢弃、已过期批次丢弃、净额 ≤0 丢弃、永久发放按描述分列。
 *   ④ 容差守恒：批次和与钱包总额差 ≤ max(100, 1%) 才采用批次（翻页误差实测 0.07%）；
 *      否则回退钱包包 —— **宁可没有临期档，也不给错数**。
 *   ⑤ 分档必须走 hub 的 `expiryBandedWindows`（AGENTS.md 第 1 条，不手拼档位）。
 *   ⑥ 410000 → 先用 RT 续期换发新 token 再重查一次（桌面端导入的旧 token
 *      资产服务不认；真机实测：续期后同一账号 total_balance=2797 查询成功）。
 */
async function usage(site, credential) {
  const tokens = tokensOf(credential)
  if (tokens === undefined) {
    return [{ name: '额度', display: '未登录：缺少 AutoClaw accessToken' }]
  }

  // ① 钱包（410000 时先用 RT 续期换发新 token 再重查一次）
  let wallet = await fetchWalletData(site, tokens.accessToken)
  if (wallet.code === 410000 && tokens.refreshToken !== '') {
    try {
      const next = await refreshOnce(site, tokens.refreshToken, credential?.device_id ?? jwtDeviceId(tokens.accessToken) ?? 'dsh-autoclaw-device-001')
      rememberTokens(site, tokens, next)
      wallet = await fetchWalletData(site, next.accessToken)
    } catch { /* 续期失败：保持 410000 的结果，如实报需要重新登录 */ }
  }
  if (wallet.error !== undefined) return [{ name: '额度', display: wallet.error }]
  if (wallet.code === 410000) return [{ name: '额度', display: '登录态已失效，请重新登录' }]
  if (wallet.code !== undefined && wallet.code !== 0) {
    return [{ name: '额度', display: `查不到余额（code ${wallet.code}：${wallet.msg ?? '未知'}）` }]
  }

  const data = wallet.data ?? {}
  const total = Number.isFinite(data.total_balance) ? data.total_balance : 0
  // 可见池：`display === true` 严格判断（fail-closed），priority 升序，名字取 display_name 或类型标签
  const walletPackages = (Array.isArray(data.wallets) ? data.wallets : [])
    .filter((w) => w !== null && typeof w === 'object' && w.display === true)
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : 100) - (Number.isFinite(b.priority) ? b.priority : 100))
    .map((w) => ({
      name: (typeof w.display_name === 'string' && w.display_name.trim() !== '')
        ? w.display_name.trim()
        : (WALLET_TYPE_LABELS[w.public_wallet_type] ?? (typeof w.public_wallet_type === 'string' && w.public_wallet_type !== '' ? `${w.public_wallet_type}积分` : '其他积分')),
      remaining: Number.isFinite(w.balance) ? w.balance : 0,
      expireMs: undefined,
    }))

  // ② 流水批次（失败/不守恒 → 回退钱包包，总额仍正确，只是没有临期档）
  let packages = walletPackages
  if (total > 0) {
    try {
      const entries = await fetchLedgerEntries(site, tokens.accessToken)
      const batches = parseLedgerBatches(entries)
      const batchSum = batches.reduce((sum, pkg) => sum + pkg.remaining, 0)
      const tolerance = Math.max(100, Math.floor(total * 0.01))
      if (batches.length > 0 && Math.abs(batchSum - total) <= tolerance) packages = batches
    } catch { /* 回退钱包包 */ }
  }

  // ③ 空包兜底：只有真有余额才造（total=0 时造出的是 remaining:0 的死包，纯噪声）
  if (packages.length === 0 && total > 0) {
    packages = [{ name: '奖励积分', remaining: total, expireMs: undefined }]
  }

  // ④ 分档 + 三段组装（临期指针 / 长期合并 / 永久单独 / 已耗尽折叠）
  // ⚠️⚠️ 长期包**必须合并**（用户 2026-10-28 定案：「一条条列出来一屏全是黄胶囊」）。
  //    AutoClaw 每日签到一天一发、各带到期时刻 ⇒ 流水里一天一个批次，逐批出窗口
  //    就是 8 个「每日签到 · 长期」黄胶囊（真机 2026-11-04 报障「分这么多干嘛」）。
  //    正确形态（magicrew 同款）：临期指针单列（服务端正在扣的），其余长期合并成
  //    一个窗口（剩余求和 + 共 K 批 + 最早到期）。
  const buckets = packages.map((pkg) => ({
    label: pkg.name,
    remaining: Math.max(0, Math.round(pkg.remaining)),
    ...(Number.isFinite(pkg.expireMs) && pkg.expireMs > 0 ? { expireMs: pkg.expireMs } : {}),
  }))
  assignExpiryBands(buckets)
  const windows = []
  // ① 临期指针：最早到期的未耗尽桶（服务端正在扣的就是它），resetsAt 画走势投影
  const pointer = buckets.find((b) => typeof b.band === 'string' && b.band.startsWith('临期'))
  if (pointer !== undefined) {
    windows.push({
      name: `${pointer.label} · ${pointer.band}`,
      used: 0,
      ...(Number.isFinite(pointer.expireMs) ? { resetsAt: new Date(pointer.expireMs).toISOString() } : {}),
      display: `剩余 ${pointer.remaining} · ${fmtMD(pointer.expireMs)} 到期`,
    })
  }
  // ② 长期包合并成一个窗口（剩余求和 + 共 K 批 + 最早到期；单批只带自己的到期日）
  const longs = buckets.filter((b) => b.band === '长期')
  if (longs.length > 0) {
    const sum = longs.reduce((s, b) => s + b.remaining, 0)
    const earliestMs = longs.map((b) => b.expireMs).filter(Number.isFinite).sort((a, b) => a - b)[0]
    const tail = longs.length > 1
      ? ` · 共 ${longs.length} 批 · 最早 ${fmtMD(earliestMs)} 到期`
      : ` · ${fmtMD(earliestMs)} 到期`
    windows.push({
      name: '积分包 · 长期',
      used: 0,
      ...(Number.isFinite(earliestMs) ? { resetsAt: new Date(earliestMs).toISOString() } : {}),
      display: `剩余 ${sum}${tail}`,
    })
  }
  // ③ 永久余额单独（amount/limit 形态才有进度条与百分比；绝不发 balance）
  for (const b of buckets.filter((x) => x.band === '永久')) {
    windows.push({
      name: `${b.label} · 永久`,
      used: 0,
      amount: 0,
      limit: b.remaining,
      unit: '积分',
      display: `剩余 ${b.remaining}`,
    })
  }
  // ④ 已耗尽 → aside 折叠（不占主位）
  for (const b of buckets.filter((x) => x.band === '已耗尽')) {
    windows.push({ name: `${b.label} · 已耗尽`, used: 100, aside: true, display: `剩余 ${b.remaining}` })
  }
  if (windows.length === 0) windows.push({ name: '积分余额', used: 0, display: `剩余 ${total}` })
  return windows
}

/**
 * 拉流水（有界翻页）。⚠️ 与上游同款的三个细节：
 *   · `flow_direction: all`（必须含 debit/expire，见上）；
 *   · 共用一份 15s 时间预算（5 页各自 arm 会把最坏耗时抬到 75s）；
 *   · 中途任何一页失败**返回已拿到的部分**（守恒校验兜住不完整序列）。
 */
async function fetchLedgerEntries(site, accessToken) {
  const all = []
  let cursor
  for (let page = 0; page < LEDGER_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ asset_type: 'point', wallet_type: 'all', page_size: '100', flow_direction: 'all' })
    if (cursor !== undefined) query.set('cursor', cursor)
    let res
    try {
      res = await fetch(`${site.apiBase}/agent-assetmgr/api/v1/ledgers_std?${query.toString()}`, {
        headers: walletHeaders(site, accessToken),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return all
    }
    if (!res.ok) return all
    let json
    try { json = await res.json() } catch { return all }
    if (json?.code !== 0 || !Array.isArray(json?.data?.entries)) return all
    all.push(...json.data.entries)
    const next = json.data.next_cursor ?? json.data.nextCursor
    cursor = typeof next === 'string' && next.length > 0 ? next : undefined
    if (cursor === undefined) break
  }
  return all
}

/**
 * 流水 → 按到期批次的积分包（**净额口径**，上游 `parseAutoclawLedgerBatches` 移植）。
 *
 * ⚠️⚠️ `amount` 是历史账变额，不是批次剩余 —— 但 `debit` / `expire` 条目
 *    **同样携带 `wallet_expires_at`**（与 credit 同一批次语义）⇒
 *    按到期时刻做净额（加发放、减消耗、减过期）即得每批剩余。
 *    只算 credit 的旧口径：批次和 21900 vs 钱包 20842 ⇒ 守恒恒败 ⇒ 永远「全是永久」。
 *
 * 边界（逐条照抄上游实测结论，不自行发明）：
 *   · 只认 credit/debit/expire 三种 mutation_type（不猜别的语义）；
 *   · 负 `credit`（冲正/退款）丢弃 —— 并进批次会把 remaining 压低；
 *     负 `debit`/`expire` 必须保留 —— 它们本来就是负的，扣消耗全靠它们；
 *   · `wallet_expires_at` **只认 number**（秒）：字符串/ISO 一律判「无到期」
 *     ⇒ 落永久桶。不做猜测式归一（本仓库红线）；
 *   · 已过期批次（exp ≤ now）直接丢弃：那批积分已不在钱包余额里；
 *   · 永久发放**按描述分列**（活动赠送/注册奖励各成一包，不混成一桶）。
 */
function parseLedgerBatches(entriesRaw, now = Date.now()) {
  if (!Array.isArray(entriesRaw)) return []
  const nowSec = now / 1000
  const byExpiry = new Map()
  const permanentByLabel = new Map()
  for (const raw of entriesRaw) {
    if (raw === null || typeof raw !== 'object') continue
    const type = raw.mutation_type
    if (type !== 'credit' && type !== 'debit' && type !== 'expire') continue
    const amount = Number.isFinite(raw.amount) ? raw.amount : 0
    if (amount === 0) continue
    if (type === 'credit' && amount < 0) continue
    const metaDesc = raw.metadata !== null && typeof raw.metadata === 'object' ? raw.metadata.description : undefined
    const label = [metaDesc, raw.description, raw.source].find((v) => typeof v === 'string' && v.trim() !== '')
    const name = typeof label === 'string' ? label.trim() : '积分发放'
    const exp = Number.isFinite(raw.wallet_expires_at) ? raw.wallet_expires_at : undefined
    if (exp === undefined || exp <= 0) {
      permanentByLabel.set(name, (permanentByLabel.get(name) ?? 0) + amount)
      continue
    }
    if (exp <= nowSec) continue
    const bucket = byExpiry.get(exp) ?? { amount: 0, label: name }
    bucket.amount += amount
    byExpiry.set(exp, bucket)
  }
  const out = [...byExpiry.entries()]
    .filter(([, batch]) => batch.amount > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([expSec, batch]) => ({ name: batch.label, remaining: batch.amount, expireMs: expSec * 1000 }))
  for (const [label, amount] of permanentByLabel) {
    if (amount > 0) out.push({ name: label, remaining: amount, expireMs: undefined })
  }
  return out
}

// ── 凭据记忆（纯内存，不落盘）───────────────────────────────────────────

/**
 * 续期后的新 token。⚠️⚠️ 必须**按凭据身份**键控，不能按站点全局：
 *    按站点存会让「A 账号续出的新 token」覆盖到**同站点的其它账号**上
 *    （单测暴露过：空凭据被塞上了上一个用例续出来的 token）。
 *    键 = 站点 + 原 accessToken 尾段。
 */
const refreshed = new Map()
const tokenKeyOf = (site, credential) => {
  const access = bareToken(credential?.accessToken ?? credential?.access_token ?? credential?.access)
    || String(credential?.key ?? '')
  return `${site.id}|${access.slice(-24)}`
}
const rememberTokens = (site, from, next) => {
  refreshed.set(tokenKeyOf(site, from), next)
}

/** 把内存里续期过的 token 叠到**同一份凭据**上。 */
const withRefreshed = (site, credential) => {
  const next = refreshed.get(tokenKeyOf(site, credential))
  if (next === undefined) return credential
  return { ...credential, accessToken: next.accessToken, refreshToken: next.refreshToken }
}

// ── 读取桌面端凭据（可选，默认不执行）──────────────────────────────────

/**
 * 读 AutoClaw 桌面端已登录凭据。
 *
 * 路径（上游实测）：
 *   %APPDATA%\<userDataDirName>\Local State        → os_crypt.encrypted_key（"DPAPI"+密文）
 *   %APPDATA%\<userDataDirName>\accounts\<id>\account-credentials.enc
 *                                                  → 3 字节前缀 + 12 nonce + 密文 + 16 tag
 *
 * ⚠️ 隔离口 `DSH_AUTOCLAW_APPDATA` **优先于** `APPDATA`：测试用它指向临时目录，
 *    否则装了客户端的开发者跑单测会读到**本人真实 token**（上游的 P0 教训）。
 */
function probeLocal(site, { appData } = {}) {
  const base = appData ?? process.env.DSH_AUTOCLAW_APPDATA ?? process.env.APPDATA
    ?? (process.env.USERPROFILE === undefined ? undefined : join(process.env.USERPROFILE, 'AppData', 'Roaming'))
  if (base === undefined) return undefined

  const dir = join(base, site.userDataDirName)
  const localStatePath = join(dir, 'Local State')
  if (!existsSync(localStatePath)) return undefined

  let localState
  try { localState = JSON.parse(readFileSync(localStatePath, 'utf8')) } catch { return undefined }
  const encKeyB64 = localState?.os_crypt?.encrypted_key
  if (typeof encKeyB64 !== 'string' || encKeyB64 === '') return undefined

  const encKeyBuf = Buffer.from(encKeyB64, 'base64')
  if (!encKeyBuf.subarray(0, 5).equals(Buffer.from('DPAPI'))) return undefined

  // DPAPI 解主密钥：数组传参、不经 shell；hex 只可能是 [0-9a-f]
  const hex = encKeyBuf.subarray(5).toString('hex')
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$hex = "${hex}"`,
    '$bytes = for ($i=0; $i -lt $hex.Length; $i+=2) { [Convert]::ToByte($hex.Substring($i, 2), 16) }',
    '$u = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($u)',
  ].join('\n')

  let masterKeyB64 = ''
  try {
    masterKeyB64 = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return undefined
  }
  if (masterKeyB64 === '') return undefined
  const masterKey = Buffer.from(masterKeyB64, 'base64')
  if (masterKey.length !== 32) return undefined

  const accountsDir = join(dir, 'accounts')
  if (!existsSync(accountsDir)) return undefined

  for (const entry of readdirSync(accountsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const credFile = join(accountsDir, entry.name, 'account-credentials.enc')
    if (!existsSync(credFile)) continue
    const enc = readFileSync(credFile)
    if (enc.length < 31) continue
    try {
      const nonce = enc.subarray(3, 15)
      const body = enc.subarray(15)
      const ciphertext = body.subarray(0, body.length - 16)
      const tag = body.subarray(body.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      const parsed = JSON.parse(plain)
      const accessToken = bareToken(parsed?.accessToken ?? parsed?.access_token)
      const refreshToken = bareToken(parsed?.refreshToken ?? parsed?.refresh_token)
      if (accessToken !== '') {
        return {
          accessToken,
          refreshToken,
          deviceId: typeof parsed?.deviceId === 'string' ? parsed.deviceId : undefined,
          userId: parsed?.userId ?? parsed?.user_id,
          // 到期时间（桌面端凭据里带就带回）：号槽有 expires，magpie 才会主动调度续期
          ...(Number.isFinite(parsed?.expiresAt) && parsed.expiresAt > 0 ? { expires_at: parsed.expiresAt } : {}),
          ...(Number.isFinite(parsed?.expires_at) && parsed.expires_at > 0 ? { expires_at: parsed.expires_at } : {}),
        }
      }
    } catch { /* 这条账号解不开就试下一个 */ }
  }
  return undefined
}

// ── 渠道导出 ────────────────────────────────────────────────────────────

/**
 * 造一个站点渠道。
 *
 * 登录入口两个（#614 允许并存）：
 *   ① `beginLogin` —— 「读取桌面端登录态」，**只有用户点它才读文件/起进程**
 *   ② `apiAuth`   —— 粘贴 access/refresh token，永远可用
 */
function makeAutoclawChannel(site) {
  return {
    id: site.id,
    displayName: site.displayName,

    /**
     * ① 读取桌面端登录态。返回 `{ url, result }`：magpie 等这个 promise 拿凭据。
     * ⚠️ 不打开浏览器、不产生 URL —— 纯本地读取。
     */
    beginLogin: () => {
      let result
      try {
        const credential = probeLocal(site)
        if (credential === undefined) {
          result = Promise.reject(new Error(
            `没有找到 ${site.displayName} 的桌面端登录态。请先安装并登录 AutoClaw 客户端，或改用「粘贴凭据」。`,
          ))
        } else {
          // ⚠️⚠️ 导入时**立即轮换**一次（RT → 新 AT/RT）：
          //   桌面端文件里的旧 pair 查余额会被资产服务拒（410000，真机实测），
          //   且轮换会作废旧 pair —— 所以必须在导入这一刻换成新鲜 pair 落槽，
          //   而不是等第一次 410000 才自救（那时的续期结果不落槽，magpie 重启即死）。
          //   代价：桌面端自己的会话被作废，客户端会要求重新登录 —— 导入前说明里写明。
          result = refreshOnce(site, credential.refreshToken, credential.deviceId ?? jwtDeviceId(credential.accessToken) ?? 'dsh-autoclaw-device-001')
            .then((next) => ({
              type: 'oauth',
              channel: site.id,
              accessToken: next.accessToken,
              refreshToken: next.refreshToken,
              ...(Number.isFinite(next.expiresAt) ? { expires_at: next.expiresAt } : {}),
              ...(next.userId !== undefined ? { userId: next.userId } : {}),
              ...(credential.deviceId !== undefined ? { device_id: credential.deviceId } : {}),
              site: site.id === SITES.cn.id ? 'cn' : 'intl',
            }))
            .catch((error) => {
              throw new Error(
                `桌面端里的登录态已失效（${error?.message ?? error}）。请先打开 AutoClaw 客户端重新登录，再回到这里点「读取桌面端登录态」；或改用「粘贴凭据」。`,
              )
            })
        }
      } catch (error) {
        result = Promise.reject(error)
      }
      // 未捕获的 rejection 会拖垮 magpie 宿主（AGENTS.md 记载），先挂一个兜底
      result.catch(() => {})
      return {
        url: '',
        // ⚠️ 必须带 instructions：不带的话 magpie 落到默认文案「在打开的页面里完成
        //   登录」—— 本方法根本不开浏览器，那句是误导（用户问「为啥显示浏览器登录」）。
        instructions: '正在读取本机 AutoClaw 桌面端登录态，无需浏览器，几秒内自动继续。注意：导入会轮换登录态，AutoClaw 客户端之后可能要求重新登录。',
        result,
      }
    },
    loginMethods: [{ label: `读取 AutoClaw 桌面端登录态（${site.displayName}）——注意：导入会作废桌面客户端的会话，客户端之后需要重新登录` }],

    /** ② 粘贴凭据：单输入框，JSON 或两行 key=value 都收。 */
    apiAuth: {
      label: `粘贴 AutoClaw 凭据（${site.displayName}：accessToken + refreshToken）`,
      placeholder: '{"accessToken":"…","refreshToken":"…"} 或两行 key=value',
      keyField: 'key',
    },

    /**
     * 凭据是否过期 —— 决定 aggregate 是否走 `renewSoft`（→ gatedRenew → 本渠道
     *   `refresh` → magpie 落槽）。
     *
     * ⚠️⚠️ 必须实现：v0.5.0 删掉旧 autoclaw 时，账号槽**留在了 plugin-auth.json 里**。
     *    没有判据的话，一份过期残留槽会显示成「已登录」。
     *
     * 判据：AT 已过期（或无 expires）但有 token → **视为过期**，让 renewSoft 用
     *   `refresh` 自愈 —— `refresh` 会把轮换出的新 RT 落回槽里。之前一版在这里
     *   「有 RT 就乐观放行」是错的：续期结果只在内存里，槽永远是死 RT
     *   （真机事故：国际版槽被探针续期打死）。
     */
    expired: (credential) => {
      const tokens = tokensOf(credential)
      if (tokens === undefined) return true

      const raw = credential?.expires_at ?? credential?.expires
      const ms = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Date.parse(raw) : NaN)

      // ① 没过期 → 可用
      if (Number.isFinite(ms) && ms > Date.now()) return false
      // ② 凭据里没有 expires 字段但有 token → 未知（桌面端导入/粘贴常无到期），
      //    当作可用，让 401/410000 路径按需自愈（chat 走 init.renew 落槽）
      if (!Number.isFinite(ms)) return false

      // ③ 已过期 → 走 renewSoft 自愈（refresh 现已实现并落槽）
      return true
    },

    fallbackModels: fallbackModels(),
    catalog: (credential) => catalog(site, credential),
    chat: (credential, init) => chat(site, withRefreshed(site, credential), init),
    usage: (credential) => usage(site, withRefreshed(site, credential)),

    /**
     * 续期（gatedRenew 契约）：`refresh(credential, persist)` → 返回合并后的凭据。
     *
     * ⚠️⚠️ 这条是 **RT 一次性渠道的生死线**：magpie 的 `auth.refresh` 调到这里，
     *    返回值经 `saveAuth` 落回账号槽 —— 轮换出的新 RT 只有落槽才算活。
     *    只在本地 refreshOnce 而不落槽 =「续期成功、账号照样死」（真机事故）。
     * `persist` 只更新内存缓存；落槽由 magpie 的 refresh 返回值完成。
     */
    refresh: async (credential, persist) => {
      const tokens = tokensOf(credential)
      if (tokens === undefined) throw new Error('未登录：缺少 AutoClaw accessToken')
      if (tokens.refreshToken === '') {
        throw new Error('AutoClaw refresh_token 为空，无法续期（该凭据只能重新登录）')
      }
      const next = await refreshOnce(site, tokens.refreshToken, credential?.device_id ?? jwtDeviceId(tokens.accessToken) ?? 'dsh-autoclaw-device-001')
      const merged = {
        ...credential,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        ...(Number.isFinite(next.expiresAt) ? { expires_at: next.expiresAt } : {}),
        ...(next.userId !== undefined ? { userId: next.userId } : {}),
      }
      // 内存缓存（本进程后续请求直接用新 token）
      persist?.({ accessToken: next.accessToken, refreshToken: next.refreshToken })
      rememberTokens(site, tokens, next)
      return merged
    },

    /** 上游没有独立的每日签到端点（登录即发），不做。 */
    checkin: () => ({ outcome: 'inactive' }),
  }
}

/** 国际站渠道。 */
export const autoclawChannel = makeAutoclawChannel(SITES.intl)
/** 国内站渠道。 */
export const autoclawCnChannel = makeAutoclawChannel(SITES.cn)

// 测试钩子（不进 magpie 的供应商导出，见 index.mjs 的铁律注释）
export {
  parsePasted as autoclawParsePasted,
  withSystemPrefix as autoclawWithSystemPrefix,
  probeLocal as autoclawProbeLocal,
  SITES as AUTOCLAW_SITES,
  FALLBACK_MODEL_IDS as AUTOCLAW_FALLBACK_IDS,
}
