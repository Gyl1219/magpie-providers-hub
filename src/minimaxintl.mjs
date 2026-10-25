// MiniMax Code 国际版（minimaxintl）渠道实现 —— 移植自 DSH
// `minimax-oauth.ts` / `minimax-auth.ts` / `minimax-product.ts` / `minimax-adapter.ts`。
//
// ## 已被 DSH 真机验证的协议事实（2026-10-15，真实国际站账号 4/4 端点通过）
//
// - OAuth：`account.minimax.io` 设备码 + PKCE（client `mcode-public`），
//   官方 `mcode login --region global` 打开的就是这个主机；
// - 推理：`agent.minimax.io/mavis/api/v1/llm/v1/messages`（Anthropic Messages），
//   **只需 `Authorization: Bearer`**；
// - ⚠️ **access_token 不是 JWT**（`mmoat_` 前缀、60 字符、0 个点）——
//   过期时间**只能**来自响应 `expires_in` 自算的 `expires_at`，
//   登录/续期必须写入，否则账号永远显示「未知」；
// - ⚠️ **两种「还在等」都要认**：MiniMax 用 HTTP 200 + `status=pending`，
//   OAuth 标准用 400 + `error=authorization_pending`（只认标准会立刻抛错）；
// - ⚠️ 令牌响应的 **scope 必须含 `agent.default`**（官方客户端的硬校验）；
// - ⚠️ `agent.minimax.io` 恒 307 → 中国站（地理分流）—— 传输层见
//   `minimax-transport.mjs`，这里所有请求都必须走它。

import { createHash, randomBytes } from 'node:crypto'
import { loadCredential, saveCredential } from './shared.mjs'
import { minimaxFetch, apiHeaders, inferHeaders, describeGeoRoute } from './minimax-transport.mjs'
import {
  buildAnthropicPayload,
  anthropicSseToOpenAi,
  anthropicJsonToOpenAi,
  rememberModelMeta,
} from './minimax-bridge.mjs'

export const CHANNEL_ID = 'minimaxintl'
export const DISPLAY_NAME = 'MiniMax Code (国际版)'

const ACCOUNT_HOST = 'https://account.minimax.io'
const API_HOST = 'https://agent.minimax.io'
const REGION = 'en'
const BUILD_ENV = 'prod'
const CLIENT_ID = 'mcode-public'
const AUDIENCE = 'agent-backend'
const SCOPE = 'agent.default'

const DEVICE_CODE_PATH = '/oauth2/device/code'
const TOKEN_PATH = '/oauth2/token'
const MODELS_PATH = '/mavis/api/v1/models'
const INFER_PATH = '/mavis/api/v1/llm/v1/messages'

const OAUTH_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 30_000
/** 临期提前量（对齐本插件 officeace 与 magpie refreshLead 的 10 分钟口径）。 */
const EXPIRY_LEAD_MS = 10 * 60 * 1000
/** 设备码没给 expires_in 时的登录等待上限。 */
const SIGN_IN_MS = 10 * 60 * 1000

// ── OAuth：设备码 + PKCE（移植 minimax-oauth.ts）──────────────────────────

const nonEmpty = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/** PKCE：⚠️ challenge 按 **ascii** 编码 verifier（DSH 与官方客户端一致）。 */
function createPkce() {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
  return { codeVerifier, codeChallenge }
}

function parseDeviceAuthorization(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const deviceCode = nonEmpty(payload.device_code)
  const userCode = nonEmpty(payload.user_code)
  const verificationUri = nonEmpty(payload.verification_uri) ?? nonEmpty(payload.verification_url)
  const expiresInSec = positive(payload.expires_in)
  if (userCode === undefined || verificationUri === undefined) return undefined
  return {
    // ⚠️ MiniMax 变体：可能没有 device_code，轮询改用 user_code（community 实测形态）。
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: nonEmpty(payload.verification_uri_complete) ?? verificationUri,
    expiresInSec: expiresInSec ?? SIGN_IN_MS / 1000,
    intervalSec: positive(payload.interval) ?? 5,
  }
}

/**
 * 解析令牌响应（轮询与续期共用）。
 *
 * 硬校验照官方客户端：access/refresh 非空、token_type 是 Bearer、expires_in 正数、
 * **scope 含产品 scope**。⚠️ `expires_at` 以 `expires_in` 自算 —— token 不是 JWT。
 */
export function parseTokenGrant(payload, previousRefreshToken) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('MiniMax 令牌响应不是对象')
  }
  const accessToken = nonEmpty(payload.access_token)
  const refreshToken = nonEmpty(payload.refresh_token) ?? previousRefreshToken
  const tokenType = nonEmpty(payload.token_type)
  const expiresInSec = positive(payload.expires_in)
  if (accessToken === undefined) throw new Error('MiniMax 令牌响应缺少 access_token')
  if (refreshToken === undefined) throw new Error('MiniMax 令牌响应缺少 refresh_token')
  if (tokenType === undefined || tokenType.toLowerCase() !== 'bearer') {
    throw new Error('MiniMax 令牌响应的 token_type 不是 Bearer')
  }
  if (expiresInSec === undefined) throw new Error('MiniMax 令牌响应缺少 expires_in')
  const scope = typeof payload.scope === 'string' ? payload.scope : ''
  if (!scope.split(/\s+/u).filter(Boolean).includes(SCOPE)) {
    throw new Error(`MiniMax 令牌响应的 scope 不含 ${SCOPE}`)
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_at: String(Date.now() + expiresInSec * 1000),
    scope,
  }
}

const oauthForm = (fields) => new URLSearchParams(fields).toString()

/**
 * 申请设备码 → 轮询令牌。
 *
 * @returns `{ url, userCode, result }` —— url 立刻可用（beginLogin 契约），
 *   `result` 兑现凭据。
 */
async function startDeviceFlow() {
  const pkce = createPkce()
  const authResponse = await fetch(`${ACCOUNT_HOST}${DEVICE_CODE_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: oauthForm({
      client_id: CLIENT_ID, scope: SCOPE, audience: AUDIENCE,
      code_challenge: pkce.codeChallenge, code_challenge_method: 'S256',
    }),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })
  if (!authResponse.ok) throw new Error(`MiniMax 设备码申请失败（HTTP ${authResponse.status}）`)
  const auth = parseDeviceAuthorization(await authResponse.json().catch(() => undefined))
  if (auth === undefined) throw new Error('MiniMax 设备码响应无法解析')

  const pollBody = auth.deviceCode !== undefined
    ? { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: auth.deviceCode }
    : { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', user_code: auth.userCode }
  const result = (async () => {
    const deadline = Date.now() + auth.expiresInSec * 1000
    let intervalMs = auth.intervalSec * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs))
      const response = await fetch(`${ACCOUNT_HOST}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: oauthForm({ ...pollBody, client_id: CLIENT_ID, code_verifier: pkce.codeVerifier }),
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => undefined)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {}
      const status = nonEmpty(record.status)
      const error = nonEmpty(record.error)
      // ⚠️ 两种「还在等」都要认：MiniMax 用 HTTP 200 + status=pending，
      // OAuth 标准用 400 + error=authorization_pending。只认标准会立刻抛错。
      if (response.ok && status === 'pending') continue
      if (response.ok && status === 'slow_down') { intervalMs += 5000; continue }
      if (response.ok && (status === 'denied' || status === 'access_denied')) {
        throw new Error('用户取消了 MiniMax 授权')
      }
      if (response.ok && (status === 'expired' || status === 'expired_token')) {
        throw new Error('MiniMax 设备码已过期，请重新登录')
      }
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') { intervalMs += 5000; continue }
      if (response.ok) return parseTokenGrant(payload)
      throw new Error(`MiniMax 授权失败：${error ?? `HTTP ${response.status}`}`)
    }
    throw new Error('MiniMax 设备码已过期，请重新登录')
  })()
  result.catch(() => {}) // 防 unhandledRejection（错误仍会传给真正 await 它的人）
  return { url: auth.verificationUriComplete, userCode: auth.userCode, result }
}

/** 续期。⚠️ `invalid_grant` + HTTP 400 = 已被顶掉，只能重新登录。 */
export async function refreshCredential(current) {
  if (typeof current?.refresh_token !== 'string' || current.refresh_token === '') {
    throw new Error('凭据缺少 refresh_token，请重新登录')
  }
  const response = await fetch(`${ACCOUNT_HOST}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: oauthForm({
      grant_type: 'refresh_token', refresh_token: current.refresh_token,
      client_id: CLIENT_ID, scope: SCOPE, audience: AUDIENCE,
    }),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const record = typeof payload === 'object' && payload !== null ? payload : {}
    const error = nonEmpty(record.error) ?? `HTTP ${response.status}`
    const err = new Error(`MiniMax 续期失败：${error}`
      + (error === 'invalid_grant' ? '（refresh_token 已失效，请重新登录）' : ''))
    err.signedOut = error === 'invalid_grant' && response.status === 400
    throw err
  }
  return parseTokenGrant(payload, current.refresh_token)
}

// ── 凭据时效 ─────────────────────────────────────────────────────────────

/**
 * 过期时间（毫秒）。`expires_at` 是本实现写入的毫秒串；
 * 兼容秒级（>1e12 视为毫秒）。token 不是 JWT，无 JWT 分支可走。
 */
function expiresAtMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number(raw)
    const parsed = value > 1_000_000_000_000 ? value : value * 1000
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

export function expired(credential) {
  const at = expiresAtMs(credential)
  // 无过期信息时保守视为未过期（DSH 同款；真正失效由 401 路径兜底）
  if (at === undefined) return false
  return at - Date.now() < EXPIRY_LEAD_MS
}

// ── 账号身份（移植 minimax-identity.ts，上游 Gitee IKP8UA 修法）───────────

const USERINFO_PATH = '/v1/api/user/info'
/**
 * ⚠️ 两个 query 参数**一个都不能少**（上游 12 组消融实测）：
 * - 缺 `device_platform=web` → 400 code=2；
 * - 缺 `biz_id=3` → 国际站仍 200 code=0 但 **name 为空**（数据是错的）。
 *   只需 Bearer —— 不需要官方客户端的 yy/x-signature 签名头。
 */
const USERINFO_QUERY = '?device_platform=web&biz_id=3'

/**
 * 解析身份响应（两站实测矩阵的判据，缺一不可）：
 * ① `statusInfo`/`base_resp` 非零 code → 失败（国内站缺 biz_id 的形态）；
 * ② 身份块先 `data.userInfo` 再顶层 `userInfo`（两站/两种信封都见过）；
 * ③ **name 非空**是核心判据 —— 国际站缺 biz_id 时 code=0 但 name 空，
 *    只有这一条能拦住（显示空白比显示内部 id 更糟）。
 */
export function parseUserIdentity(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const root = payload
  const status = [root.statusInfo, root.base_resp, root.baseResp].find(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  )
  if (status !== undefined) {
    const code = status.code ?? status.status_code
    if (typeof code === 'number' && code !== 0) return undefined
    if (typeof code === 'string' && code.trim() !== '' && code.trim() !== '0') return undefined
  }
  const data = typeof root.data === 'object' && root.data !== null && !Array.isArray(root.data) ? root.data : undefined
  const userInfo = [data?.userInfo, root.userInfo].find(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  )
  if (userInfo === undefined) return undefined
  const name = nonEmpty(userInfo.name)
  if (name === undefined) return undefined
  const userId = nonEmpty(userInfo.userID)
  return userId === undefined ? { name } : { name, userId }
}

/**
 * 读一次账号身份。**任何失败都返回 undefined（不抛）** —— 昵称是展示信息，
 * 拿不到就退回渠道显示名（阻塞登录才是更糟的行为）。
 *
 * ⚠️ 必须走 minimaxFetch（保凭据跟随 307 + 传输重试）+ apiHeaders（附 XFF）：
 * 大陆直连出口恒 307 到中国站 → 401（与凭据失效同形）；XFF/代理出海才能读到。
 */
export async function fetchUserIdentity(credential, { xff } = {}) {
  const url = `${API_HOST}${USERINFO_PATH}${USERINFO_QUERY}`
  try {
    const response = await minimaxFetch(url, () => ({
      method: 'GET',
      headers: Object.fromEntries(apiHeaders(credential, xff).entries()),
      signal: AbortSignal.timeout(8_000),
    }))
    if (!response.ok) return undefined
    return parseUserIdentity(JSON.parse(await response.text()))
  } catch {
    return undefined
  }
}

// ── 目录（移植 normalizeMinimaxModel 的口径）─────────────────────────────

/**
 * 兜底目录（DSH 实测 4 条，顺序照抄远端 `model_order`）。
 * ⚠️ 必须含 M3.1-Flash-Preview —— 它不在官方客户端静态表里，漏了它
 * 远端一失败用户就看不到自己在用的模型。
 */
const FALLBACK_MODELS = [
  { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1-Flash-Preview', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: true, effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'default', thinkingMode: 'forced_on' },
  { id: 'MiniMax-M3', name: 'M3', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: true, thinkingMode: 'switchable' },
  { id: 'MiniMax-M2.7-highspeed', name: 'M2.7-highspeed', contextWindow: 200_000, maxTokens: 128_000, supportsImage: false, thinkingMode: 'forced_on' },
  { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 200_000, maxTokens: 128_000, supportsImage: false, thinkingMode: 'forced_on' },
]

const positiveInt = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined)

/** 远端条目归一：窗口取 `context_window_options` **最大档**（DSH 口径），非 `limit.context`。 */
export function normalizeModel(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const id = nonEmpty(raw.id) ?? nonEmpty(raw.name)
  if (id === undefined) return undefined
  const name = nonEmpty(raw.name) ?? id
  const limit = typeof raw.limit === 'object' && raw.limit !== null ? raw.limit : {}
  const options = Array.isArray(raw.context_window_options)
    ? raw.context_window_options.map(positiveInt).filter((v) => v !== undefined)
    : []
  const contextWindow = options.length > 0 ? Math.max(...options) : positiveInt(limit.context)
  const inputs = Array.isArray(raw.modalities?.input) ? raw.modalities.input : []
  const effortOptions = Array.isArray(raw.effort_options)
    ? [...new Set(raw.effort_options.filter((e) => typeof e === 'string' && e !== ''))]
    : undefined
  const rawDefault = nonEmpty(raw.default_effort)
  const defaultEffort = rawDefault !== undefined && effortOptions?.includes(rawDefault) ? rawDefault : undefined
  const thinkingMode = nonEmpty(raw.thinking_config?.mode)
  const maxTokens = positiveInt(limit.output)
  return {
    id, name,
    contextWindow: contextWindow ?? 0,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    supportsImage: inputs.includes('image'),
    ...(effortOptions !== undefined && effortOptions.length > 0 ? { effortOptions } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(thinkingMode !== undefined ? { thinkingMode } : {}),
  }
}

/** 远端目录信封：`{providers:[{providerId:"minimax",config:{models,model_order}}]}`。 */
export function parseModelsPayload(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const minimax = providers.find((p) => p?.providerId === 'minimax')
  const models = typeof minimax?.config?.models === 'object' && minimax.config.models !== null
    ? minimax.config.models
    : undefined
  if (models === undefined) return []
  const order = Array.isArray(minimax.config.model_order) ? minimax.config.model_order.filter((id) => models[id]) : []
  const ids = [...order, ...Object.keys(models).filter((id) => !order.includes(id))]
  const out = []
  for (const id of ids) {
    const entry = normalizeModel({ ...models[id], id })
    if (entry !== undefined) out.push(entry)
  }
  return out
}

async function fetchEntries(credential) {
  const url = `${API_HOST}${MODELS_PATH}?region=${REGION}&buildEnv=${BUILD_ENV}`
  const ask = async (cred) => fetch(url, {
    headers: cred === undefined
      ? { Accept: 'application/json' }
      : Object.fromEntries(apiHeaders(cred).entries()),
    signal: AbortSignal.timeout(15_000),
  })
  let response = await ask(credential)
  // 匿名目录是公开的：账号被拒时退回匿名（DSH 同款）
  if (response.status === 401 || response.status === 403) response = await ask(undefined)
  if (!response.ok) throw new Error(`MiniMax 目录读取失败：HTTP ${response.status}`)
  return parseModelsPayload(await response.json())
}

/** magpie 的变体表（与 DSH minimaxReasoningInfo 的产出一致）。 */
function variantsOf(entry) {
  const out = {}
  if (entry.thinkingMode === 'switchable') {
    out.none = { reasoning_effort: 'none' }
  }
  if (Array.isArray(entry.effortOptions) && entry.effortOptions.length > 0) {
    for (const effort of entry.effortOptions) {
      out[effort] = { reasoning_effort: effort }
    }
  } else if (entry.thinkingMode === 'switchable') {
    out.on = { reasoning_effort: 'on' }
  }
  return out
}

async function catalog(credential) {
  let entries
  try {
    entries = await fetchEntries(credential)
  } catch {
    entries = undefined
  }
  const list = entries !== undefined && entries.length > 0 ? entries : FALLBACK_MODELS
  // 桥接层要按模型查 thinkingMode/maxTokens，喂给它一份
  rememberModelMeta(list)
  const models = {}
  for (const entry of list) {
    models[entry.id] = {
      name: entry.name,
      limit: {
        context: entry.contextWindow > 0 ? entry.contextWindow : 128_000,
        output: entry.maxTokens ?? 8_192,
      },
      tool_call: true,
      capabilities: {
        temperature: true,
        reasoning: entry.thinkingMode === 'switchable' || entry.thinkingMode === 'forced_on',
        attachment: entry.supportsImage === true,
      },
      options: {},
      headers: {},
      variants: variantsOf(entry),
      status: 'active',
      release_date: '',
    }
  }
  return models
}

// ── 聊天（Anthropic Messages + OpenAI 翻译桥）────────────────────────────

/** 把 async generator 变成 SSE Response。 */
function sseResponse(generator) {
  const encoder = new TextEncoder()
  const iterator = generator[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {})
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 发一次对话（OpenAI 请求体进，OpenAI 响应出）。
 *
 * @param credential minimaxintl 凭据
 * @param context `{ body, signal, renew, xff }` —— body 是**去掉渠道前缀**的
 *   OpenAI 请求体；`renew` 是聚合层注入的硬续期；`xff` 是可选的海外 IP
 *   （绕地理分流，magpie plugin options 的 `minimaxXff`）。
 */
async function chat(credential, { body, signal, renew, xff }) {
  let geoRouted = false
  const payload = buildAnthropicPayload(body)
  const send = (cred) => minimaxFetch(
    `${API_HOST}${INFER_PATH}`,
    () => ({
      method: 'POST',
      headers: inferHeaders(cred, xff, payload.stream === true ? 'text/event-stream' : 'application/json'),
      body: JSON.stringify(payload),
      signal,
    }),
    {
      signal,
      // ⚠️ 必须在 307 那一跳记录：跟到中国站后的 401 与「凭据真失效」逐字同形。
      onGeoRoute: () => { geoRouted = true },
    },
  )

  let response = await send(credential)
  // 401/403：先硬续期一次再重发一次（凭据可能被服务端提前撤销而本地 expires_at 未到）
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

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // ⚠️ 经历过地理路由时，业务错误原文仍放前面（307→402 时「去充值」不能被顶掉）
    const message = `MiniMax 国际版返回 HTTP ${response.status}：`
      + (geoRouted ? describeGeoRoute(text) : text.slice(0, 300))
    return Response.json(
      { error: { type: 'provider_error', message, ...(geoRouted ? { geo_routed: true } : {}) } },
      { status: response.status >= 400 ? response.status : 502 },
    )
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('application/json') || contentType.includes('text/html')) {
    // 200 + 非 SSE：本家「200+业务码」的既有习惯，一个 SSE 帧都没有
    const text = await response.text().catch(() => '')
    return Response.json(
      { error: { type: 'provider_error', message: `MiniMax 国际版返回了非 SSE 响应（HTTP 200）${text === '' ? '' : ` — ${text.slice(0, 400)}`}` } },
      { status: 502 },
    )
  }

  if (payload.stream === true) {
    return sseResponse(anthropicSseToOpenAi(response.body, { model: body?.model, signal }))
  }
  const json = await response.json().catch(() => undefined)
  if (typeof json !== 'object' || json === null) {
    return Response.json(
      { error: { type: 'provider_error', message: 'MiniMax 国际版返回了无法解析的响应' } },
      { status: 502 },
    )
  }
  return Response.json(anthropicJsonToOpenAi(json, { model: body?.model }))
}

// ── 签到（移植 minimax-credits.ts 的实测口径）────────────────────────────

const SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status'
const SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'
/** 面板状态：1 未开始 / 2 可领 / 3 已领 / 4 不适用。 */
const DAY_STATUS = { Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4 }

/** 本机 IANA 时区名（客户端同款）。⚠️ timezone_id 是 **query** 参数：放请求头无效。 */
const timezoneId = () => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.trim() !== '' ? zone.trim() : 'UTC'
  } catch {
    return 'UTC'
  }
}

const finiteNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * 解析签到面板（**完整复刻**官方客户端 `validateSigninPanel` 的硬约束，
 * 不满足即 undefined 不编造）：恰好 7 天、day_no 1..7 无重复、
 * 最多 1 条可领、最多 1 条今日、status ∈ {1,2,3,4}、scene ∈ {0..4}。
 */
export function parseSigninPanel(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const scene = finiteNumber(data.scene)
  if (scene === undefined || scene < 0 || scene > 4) return undefined
  if (!Array.isArray(data.days) || data.days.length !== 7) return undefined
  const days = []
  const seen = new Set()
  let claimable = 0
  let today = 0
  for (const raw of data.days) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const dayNo = finiteNumber(raw.day_no)
    const points = finiteNumber(raw.points)
    const status = finiteNumber(raw.status)
    const bonusRaw = raw.bonus_points
    const bonusPoints = bonusRaw === undefined ? 0 : finiteNumber(bonusRaw)
    if (dayNo === undefined || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7) return undefined
    if (seen.has(dayNo)) return undefined
    if (points === undefined || points < 0) return undefined
    if (bonusPoints === undefined || bonusPoints < 0) return undefined
    if (typeof raw.is_today !== 'boolean') return undefined
    if (status === undefined || status < 1 || status > 4) return undefined
    seen.add(dayNo)
    if (status === DAY_STATUS.Claimable) claimable += 1
    if (raw.is_today) today += 1
    days.push({ dayNo, points, bonusPoints, status, isToday: raw.is_today })
  }
  if (claimable > 1 || today > 1) return undefined
  return { scene, days }
}

/** 面板 → 连续签到天数（从今日起向前数连续 Claimed；今日未领则从前一天起）。 */
function streakDaysOf(days) {
  const sorted = [...days].sort((a, b) => a.dayNo - b.dayNo)
  const todayIndex = sorted.findIndex((d) => d.isToday)
  if (todayIndex < 0) return 0
  const start = sorted[todayIndex].status === DAY_STATUS.Claimed
    ? todayIndex
    : sorted[todayIndex].status === DAY_STATUS.Claimable ? todayIndex - 1 : -1
  let streak = 0
  for (let i = start; i >= 0 && sorted[i].status === DAY_STATUS.Claimed; i -= 1) streak += 1
  return streak
}

/**
 * 签到信封请求。⚠️ 业务码在 `base_resp.status_code`（HTTP 恒 200，
 * `invalid timezone_id` 也是 200）；走 minimaxFetch（重定向保凭据 + XFF）。
 */
/**
 * 签到信封请求。⚠️ 业务码在 `base_resp.status_code`（HTTP 恒 200，
 * `invalid timezone_id` 也是 200）；走 minimaxFetch（重定向保凭据 + XFF）。
 *
 * ⚠️ 必须挂 onGeoRoute：中国大陆直连出口会被 307 到中国站，国际站 token
 * 打到中国站 = 401「invalid access token」，与「凭据真失效」逐字同形 ——
 * 不判就是「登录成功却签到 401」这种最具误导性的形态（真因是出口 IP）。
 */
async function signinEnvelope(path, credential, method, xff) {
  const url = new URL(`${API_HOST}${path}`)
  url.searchParams.set('timezone_id', timezoneId())
  let geoRouted = false
  const response = await minimaxFetch(url.toString(), () => ({
    method,
    headers: Object.fromEntries(apiHeaders(credential, xff).entries()),
    ...(method === 'POST' ? { body: '{}' } : {}),
  }), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    onGeoRoute: () => { geoRouted = true },
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    const detail = `HTTP ${response.status}：${text.slice(0, 200)}`
    throw new Error(`MiniMax 签到响应不是 JSON：${geoRouted ? describeGeoRoute(detail) : detail}`)
  }
  const baseResp = typeof payload?.base_resp === 'object' && payload.base_resp !== null ? payload.base_resp : {}
  const statusCode = finiteNumber(baseResp.status_code)
  if (statusCode !== undefined && statusCode !== 0) {
    const message = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : `status_code=${statusCode}`
    const error = new Error(
      `MiniMax 签到失败：${geoRouted ? describeGeoRoute(`${statusCode} ${message}`) : message}`,
    )
    // ⚠️ 如实区分：invalid access token 要重登；invalid signature 是网关/重定向
    error.signedOut = !geoRouted && (statusCode === 401 || /invalid access token/i.test(message))
    throw error
  }
  if (response.status === 401 || response.status === 403) {
    // ⚠️ 经历过地理路由时，业务错误原文放前面（DSH 纪律：「去重登」不能顶掉「换出口」）
    const error = new Error(
      `MiniMax 签到失败：${geoRouted ? describeGeoRoute(`HTTP ${response.status}`) : `凭据已失效（HTTP ${response.status}）`}`,
    )
    error.signedOut = !geoRouted
    throw error
  }
  return payload
}

/**
 * 每日签到：读面板 → 今日可领则 claim。
 *
 * 返回 magpie 的 checkin 词汇表：`{outcome, credit?, streak?, message?}`，
 * outcome ∈ claimed / done / inactive / ineligible / failed。
 * ⚠️ 幂等判据是 `claim_result`（1=本次真领取，2=已领过），**不是 HTTP 状态码**
 * （重复领取同样 200）。
 */
export async function checkin(credential, { xff } = {}) {
  let panel
  try {
    const statusPayload = await signinEnvelope(SIGNIN_STATUS_PATH, credential, 'GET', xff)
    panel = parseSigninPanel(statusPayload?.data)
  } catch (error) {
    return { outcome: 'failed', message: error.message, ...(error.signedOut ? { signIn: 'expired' } : {}) }
  }
  if (panel === undefined) {
    return { outcome: 'failed', message: '签到面板响应形状不符合预期（服务端可能改版）' }
  }
  const sorted = [...panel.days].sort((a, b) => a.dayNo - b.dayNo)
  const todays = sorted.filter((d) => d.isToday)
  const today = todays[0]
  const streakBefore = streakDaysOf(panel.days)
  if (today === undefined) return { outcome: 'inactive', message: '签到面板里没有今日条目' }
  if (today.status === DAY_STATUS.Claimed) {
    return { outcome: 'done', credit: today.points, streak: streakBefore, message: '今日已签到' }
  }
  if (today.status === DAY_STATUS.Disabled) return { outcome: 'ineligible', message: '今日签到不可用' }
  if (today.status !== DAY_STATUS.Claimable) return { outcome: 'inactive', message: '今日签到还没开始' }
  let claimPayload
  try {
    claimPayload = await signinEnvelope(SIGNIN_CLAIM_PATH, credential, 'POST', xff)
  } catch (error) {
    return { outcome: 'failed', message: error.message, ...(error.signedOut ? { signIn: 'expired' } : {}) }
  }
  const claimData = typeof claimPayload?.data === 'object' && claimPayload.data !== null ? claimPayload.data : {}
  const claimResult = finiteNumber(claimData.claim_result)
  // credit 取 points（总数，已含 bonus_points）；连续天数以**领取后**回传的面板为准
  const claimedPanel = parseSigninPanel(claimData.panel)
  const streak = claimedPanel !== undefined ? streakDaysOf(claimedPanel.days) : streakBefore + 1
  const credit = finiteNumber(claimData.points)
  if (claimResult === 1) return { outcome: 'claimed', ...(credit !== undefined ? { credit } : {}), streak }
  if (claimResult === 2) return { outcome: 'done', ...(credit !== undefined ? { credit } : {}), streak, message: '今日已签到' }
  return { outcome: 'failed', message: `签到响应缺少有效的 claim_result（${JSON.stringify(claimData.claim_result ?? null)}）` }
}

// ── 额度分桶（credit/details 逐行一桶；DSH 压平成 total，我们保留桶）────

const CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details'

/**
 * `remaining_amount` 是**字符串**（"800.00"，上游用字符串规避浮点）——
 * 只认 number 会把 800 静默算成 0（DSH 修过的真实缺陷）。空串返回 undefined
 * （`Number('')` 是 0，会把「空」误读成「0 积分」）。
 */
function looseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 额度分桶 → magpie usage windows。
 *
 * `details[]` 每行 = 一桶（`remaining_amount` + `expire_at_ms` 毫秒）。
 * 已过期的桶跳过（那些额度服务端仍会返回但不可用 —— 显示出来是误导）。
 * ⚠️ 响应是**平铺**的（`total_count` 与 `base_resp` 同级），没有 `data` 信封
 * —— 与签到端点不同形，不能复用同一个解包（DSH 实测注释明确记录）。
 */
async function usage(credential, { xff } = {}) {
  let geoRouted = false
  const response = await minimaxFetch(`${API_HOST}${CREDIT_DETAILS_PATH}`, () => ({
    method: 'GET',
    headers: Object.fromEntries(apiHeaders(credential, xff).entries()),
  }), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    onGeoRoute: () => { geoRouted = true },
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`MiniMax 余额查询响应不是 JSON：${geoRouted ? describeGeoRoute(`HTTP ${response.status}`) : `HTTP ${response.status}：${text.slice(0, 150)}`}`)
  }
  const baseResp = typeof payload?.base_resp === 'object' && payload.base_resp !== null ? payload.base_resp : {}
  const statusCode = finiteNumber(baseResp.status_code)
  if (statusCode !== undefined && statusCode !== 0) {
    const message = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : `status_code=${statusCode}`
    if (geoRouted) throw new Error(`MiniMax 余额查询失败：${describeGeoRoute(message)}`)
    const error = new Error(`MiniMax 余额查询失败：${message}`)
    error.signedOut = statusCode === 401 || /invalid access token/i.test(message)
    throw error
  }
  if (response.status === 401 || response.status === 403) {
    if (geoRouted) throw new Error(`MiniMax 余额查询失败：${describeGeoRoute(`HTTP ${response.status}`)}`)
    const error = new Error(`MiniMax 余额查询失败：凭据已失效（HTTP ${response.status}）`)
    error.signedOut = true
    throw error
  }
  const now = Date.now()
  const windows = []
  const rows = Array.isArray(payload?.details) ? payload.details : []
  for (const row of rows) {
    const remaining = looseAmount(row?.remaining_amount)
    const expireAt = finiteNumber(row?.expire_at_ms)
    if (remaining === undefined) continue
    if (expireAt !== undefined && expireAt <= now) continue // 已过期桶不可用，不显示
    const expiryText = expireAt !== undefined
      ? `${new Date(expireAt).getMonth() + 1}-${String(new Date(expireAt).getDate()).padStart(2, '0')} 到期`
      : '长期有效'
    /**
     * 「重置前提醒」适配（magpie 设置里那个 提前 12/24/48 小时 通知）：
     * - `span`（秒）让 magpie 把桶识别为周期窗口（MiniMax 积分 ≈ 月度）——
     *   「每周或每月窗口用量不到 85% 即将重置」的触发就靠它分类；
     * - `used` 用 consumed/granted 的真实百分比（非 0），85% 阈值才有意义。
     * 两个字段都来自同一行响应（DSH 取证：`granted_at_ms` / `consumed_amount`
     * / `granted_amount` 与 `remaining_amount` 同级），缺哪个就省哪个，不编造。
     */
    const grantedAt = finiteNumber(row?.granted_at_ms)
    const span = grantedAt !== undefined && expireAt !== undefined && expireAt > grantedAt
      ? Math.round((expireAt - grantedAt) / 1000)
      : undefined
    const consumed = looseAmount(row?.consumed_amount)
    const grantedAmount = looseAmount(row?.granted_amount)
    const usedPercent = consumed !== undefined && grantedAmount !== undefined && grantedAmount > 0
      ? Math.max(0, Math.min(100, Math.round((consumed / grantedAmount) * 100)))
      : 0
    windows.push({
      name: `${remaining} 积分 · ${expiryText}`,
      used: usedPercent,
      ...(span !== undefined ? { span } : {}),
      ...(expireAt !== undefined ? { resetsAt: new Date(expireAt).toISOString() } : {}),
      display: `剩余 ${remaining}`,
    })
  }
  return windows.length > 0 ? windows : [{ name: DISPLAY_NAME, used: 0, display: '无积分明细' }]
}

// ── 渠道对象（聚合层契约）────────────────────────────────────────────────

export const minimaxintlChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,

  // 未登录时的兜底目录（与 DSH 同一份实测表；登录后以远端目录为准）
  fallbackModels: Object.fromEntries(FALLBACK_MODELS.map((m) => [m.id, {
    name: m.name,
    limit: { context: m.contextWindow, output: m.maxTokens },
    tool_call: true,
  }])),

  /**
   * 设备码登录：**立刻**返回 url（verification_uri_complete，用户点开即带上
   * 预填的 user_code），登录在 `result` 上推进 —— 对齐 beginLogin 契约。
   *
   * 登录成功后顺带查一次**账号真名**（`/v1/api/user/info`，上游 IKP8UA 修法）：
   * 拿到就作为 `result` 凭据的 `nickname` —— 多账号时账号卡显示真名而不是
   * 内部 id。查不到不阻塞（token 不是 JWT、登录响应不含身份，真名只有这个
   * 端点给；大陆出口 307 时它静默失败，属预期）。
   */
  async beginLogin(openBrowser, { xff } = {}) {
    const started = await startDeviceFlow()
    if (openBrowser) openBrowser(started.url)
    return {
      url: started.url,
      result: started.result.then(async (credential) => {
        const identity = await fetchUserIdentity(credential, { xff })
        return identity !== undefined ? { ...credential, nickname: identity.name } : credential
      }),
      instructions: `在打开的页面里登录 MiniMax 并确认代码 ${started.userCode}，完成后本窗口自动继续。`,
    }
  },

  /** 硬续期（失败抛错；软续期由聚合层的 ensure 决定）。 */
  refresh: refreshCredential,
  expired,
  catalog,
  chat,
  /** 每日签到（magpie 的 auth.checkin 钩子分发到这里）。 */
  checkin,
  /** 额度分桶（聚合层 usage 分发到这里）。 */
  usage,
}
