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
   */
  async beginLogin(openBrowser) {
    const started = await startDeviceFlow()
    if (openBrowser) openBrowser(started.url)
    return {
      url: started.url,
      result: started.result,
      instructions: `在打开的页面里登录 MiniMax 并确认代码 ${started.userCode}，完成后本窗口自动继续。`,
    }
  },

  /** 硬续期（失败抛错；软续期由聚合层的 ensure 决定）。 */
  refresh: refreshCredential,
  expired,
  catalog,
  chat,
}
