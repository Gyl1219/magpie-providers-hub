// OfficeAce（华为云 AgentArts）— 独立实现，不依赖 DSH。
//
// 流程（对齐 `officeace-auth.ts` 的实测结论，本文件零 import）：
//   1. POST {CLAW}/v1/claw/auth/state                  → 云侧登记 state
//   2. 浏览器打开 auth.huaweicloud.com 授权页（PKCE + DPoP）
//   3. 轮询 GET {CLAW}/v1/claw/auth/code?state=…        → code
//   4. POST sts.cn-north-4/v1/oauth2/tokens             → STS 凭据（AK/SK/security_token）
//   5. GET  {CLAW}/v1/claw/client-permission-validate   → modelInfo（推理端点 + app key/secret）
//   6. 推理：POST {modelApiUrlBase}/v1/chat/completions
//
// ⚠️ **refresh_token 是一次性的**（STS5.1806）：续期失败即永久失效，必须重新登录。
//    故失败必须留痕（console.warn），绝不静默吞掉。

import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { loadCredential, saveCredential, notSignedIn } from './shared.mjs'

const PROVIDER = 'officeace'
const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const CLIENT_ID = 'pdp5_for_agentarts'
const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`

const STATE_PATH = '/v1/claw/auth/state'
const CODE_PATH = '/v1/claw/auth/code'
const PERMISSION_PATH = '/v1/claw/client-permission-validate'
/** MaaS 推理域上的目录与对话路径（/v2/models 返回 11 个；/v2/chat/completions）。 */
const MODELS_PATH = '/v2/models'
const CHAT_PATH = '/v2/chat/completions'
/** 官方 MaaS 直连域；凭据里带 modelApiUrlBase 时以它为准。 */
const OFFICIAL_MAAS_BASE = 'https://api.modelarts-maas.com'

const REQUEST_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 3_000
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

const b64 = (buf) => Buffer.from(buf).toString('base64url')

async function generateDpopKeyPair() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateJwk: await webcrypto.subtle.exportKey('jwk', kp.privateKey),
    publicJwk: await webcrypto.subtle.exportKey('jwk', kp.publicKey),
  }
}

async function importDpopPrivateKey(jwk) {
  return webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function generateDpopJwt(privateKey, publicJwk, htm, htu, nowMs = Date.now()) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv } }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(Buffer.from(JSON.stringify(payload)))}`
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(input))
  return `${input}.${b64(new Uint8Array(sig))}`
}

/**
 * 华为云 APIG 签名（AK/SK，SDK-HMAC-SHA256）。
 *
 * ⚠️ 三处坑（逐字复刻上游反编译实现）：
 *   1. canonical URI **末尾强制补 /**
 *   2. 签名密钥是**裸 Secret**，不做 AWS 式 scope 密钥派生
 *   3. 头名**全小写排序**，头值 trim
 */
function signHuaweiRequest(method, url, headers, bodyText, accessKey, secretKey) {
  const u = new URL(url)
  const now = new Date()
  const pad = (n) => (n >= 10 ? String(n) : `0${n}`)
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const urlEncode = (s) => encodeURIComponent(s)

  const canonicalUri0 = u.pathname.split('/').map(urlEncode).join('/')
  const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`

  const queryPairs = []
  for (const key of [...u.searchParams.keys()].sort()) {
    queryPairs.push(`${urlEncode(key)}=${urlEncode(u.searchParams.get(key) ?? '')}`)
  }
  const canonicalQuery = queryPairs.join('&')

  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim()
  lower.host = u.host
  lower['x-sdk-date'] = xdate
  const signedHeaders = Object.keys(lower).sort()
  let canonicalHeaders = ''
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`

  const bodyHash = (method === 'PUT' || method === 'PATCH' || method === 'POST')
    ? createHash('sha256').update(bodyText).digest('hex')
    : createHash('sha256').update('').digest('hex')
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), bodyHash].join('\n')
  const stringToSign = ['SDK-HMAC-SHA256', xdate, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const sig = createHmac('sha256', secretKey).update(stringToSign).digest('hex')
  return {
    ...headers,
    'X-Sdk-Date': xdate,
    Authorization: `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaders.join(';')}, Signature=${sig}`,
  }
}

/**
 * MaaS 推理域：凭据里的 `modelApiUrlBase` 优先，否则官方直连域。
 *
 * ⚠️ 实测上游返回的 `modelApiUrlBase` 是**不带协议的裸域名**
 *    （`officeace.cn-southwest-2.huaweicloud-agentarts.com`），
 *    直接拼 `/v2/models` 会 `Failed to parse URL`。必须补 `https://`。
 */
function maasBase(credential) {
  const raw = credential?.modelApiUrlBase
  if (typeof raw !== 'string' || raw.length === 0) return OFFICIAL_MAAS_BASE
  const trimmed = raw.replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** MaaS 用 Basic 认证：`base64(appKey:appSecret)`。 */
function basicAuthorization(credential) {
  return 'Basic ' + Buffer.from(`${credential.modelAppKey}:${credential.modelAppSecret}`).toString('base64')
}

/**
 * 拉模型目录：`GET {maas}/v2/models`。
 *
 * ⚠️ 返回的是**平台目录**，不保证该账号已订阅；且**没有能力元数据**（只有 id），
 *    故上下文窗口统一按保守值，工具调用按实测（`toolCallingSupported: true`）声明。
 */
async function fetchCatalog(credential) {
  const response = await fetch(`${maasBase(credential)}${MODELS_PATH}`, {
    headers: { Accept: 'application/json', Authorization: basicAuthorization(credential) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`OfficeAce 目录读取失败：HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
  const models = {}
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (typeof row?.id === 'string' ? row.id : '')
    if (id.length === 0) continue
    models[id] = {
      name: typeof row?.name === 'string' && row.name.length > 0 ? row.name : id,
      limit: { context: 128_000, output: 8192 },
      tool_call: true,
      capabilities: { temperature: true, reasoning: true, attachment: false },
      options: {},
      headers: {},
      variants: {},
      status: 'active',
      release_date: '',
    }
  }
  return models
}

async function registerState() {
  const r = await fetch(`${CLAW_BASE}${STATE_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`华为云 state 注册失败：HTTP ${r.status}`)
  const { state } = await r.json()
  if (typeof state !== 'string' || state.length === 0) throw new Error('华为云未返回 state')
  return state
}

async function pollLoginCode(state) {
  const r = await fetch(`${CLAW_BASE}${CODE_PATH}?state=${encodeURIComponent(state)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return undefined
  try {
    const j = await r.json()
    const code = j.code ?? j.data?.code
    return typeof code === 'string' && code.length > 0 ? code : undefined
  } catch {
    return undefined
  }
}

async function exchangeCode(code, codeVerifier, dpopPrivateJwk) {
  const privateKey = await importDpopPrivateKey(dpopPrivateJwk)
  const publicJwk = { kty: 'EC', crv: 'P-256', x: dpopPrivateJwk.x, y: dpopPrivateJwk.y }
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL)
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`华为云 token 交换失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  const token = JSON.parse(text)
  const c = token.credentials
  if (!c?.access_key_id || !c?.secret_access_key || !c?.security_token) {
    throw new Error('华为云 token 响应缺少凭据')
  }
  return {
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? '',
    expiresAt: c.expiration ?? '',
    refreshToken: token.refresh_token ?? '',
    dpopPrivateJwk,
  }
}

async function fetchModelInfo(credential) {
  const url = `${CLAW_BASE}${PERMISSION_PATH}`
  const headers = { 'content-type': 'application/json', 'x-security-token': credential.securityToken }
  if (credential.projectId) headers['x-project-id'] = credential.projectId
  const signed = signHuaweiRequest('GET', url, headers, '', credential.access, credential.secret)
  const r = await fetch(url, { method: 'GET', headers: signed, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await r.text()
  if (!r.ok) throw new Error(`华为云权限校验失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  const j = JSON.parse(text)
  const auth = j.subscription?.model_info?.model_auth_info
  const base = j.subscription?.model_info?.model_api_url_base
  if (typeof auth?.model_app_key !== 'string' || typeof auth?.model_app_secret !== 'string') {
    // ⚠️ 必须给出路：只说「未订阅」用户无从下手。
    throw new Error('账号未开通 ModelArts MaaS：请在华为云控制台或 OfficeAce 客户端完成开通后重试。')
  }
  return {
    modelAppKey: auth.model_app_key,
    modelAppSecret: auth.model_app_secret,
    modelApiUrlBase: typeof base === 'string' && base.length > 0 ? base : CLAW_BASE,
  }
}

/**
 * 启动登录：**立刻**返回 `{ url, credential }`。
 *
 * ⚠️ 不要在 `authorize()` 里 await 用户完成登录 —— magpie 的约定是先拿 url 打开浏览器，
 *    再调 `callback()` 等结果；在 authorize 里死等会让双方互等。
 *    故这里把「等」放进挂起的 `credential` promise，由 callback() await。
 */
async function beginLogin(openBrowser) {
  const state = await registerState()
  const codeVerifier = b64(randomBytes(32))
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const { privateJwk } = await generateDpopKeyPair()

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'SHA-256',
    state,
    scope: 'openid',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
  })
  const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
    `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
  )}`
  if (openBrowser) openBrowser(authorizeUrl)

  // ⚠️ 后台推进：**先返回 url**，让调用方立刻拿到（否则与 magpie 死锁），
  //    轮询结果放在 `result` 里，由 callback() await。
  //
  // 契约与 astudio 一致：`{ url, result }`（result 兑现凭据）。
  const result = (async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const code = await pollLoginCode(state)
      if (code) {
        const exchanged = await exchangeCode(code, codeVerifier, privateJwk)
        const info = await fetchModelInfo(exchanged)
        return { ...exchanged, ...info }
      }
    }
    throw new Error('OfficeAce 登录超时（10 分钟）')
  })()

  return { url: authorizeUrl, result }
}

async function refreshCredential(current) {
  if (!current.refreshToken) throw new Error('凭据不支持续期，请重新登录')
  const privateKey = await importDpopPrivateKey(current.dpopPrivateJwk)
  const publicJwk = { kty: 'EC', crv: 'P-256', x: current.dpopPrivateJwk.x, y: current.dpopPrivateJwk.y }
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL)
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    // ⚠️ 必须留痕：refresh_token 一次性，丢了只能重新登录。
    console.warn(
      `[officeace] STS 续期失败 HTTP ${r.status}：${detail.slice(0, 200)}`
      + '（refresh_token 是一次性的：若报 STS5.1806 已被消费，必须重新登录）',
    )
    throw new Error('OfficeAce 续期失败，请重新登录')
  }
  const token = await r.json()
  const c = token.credentials
  const next = {
    ...current,
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? current.projectId,
    expiresAt: c.expiration,
    refreshToken: token.refresh_token ?? current.refreshToken,
  }
  try {
    Object.assign(next, await fetchModelInfo(next))
  } catch {
    // modelInfo 失败不回滚 STS：推理凭据可能仍有效
  }
  return next
}

const expired = (c) => {
  if (!c?.expiresAt) return false
  const t = Date.parse(c.expiresAt)
  return Number.isFinite(t) && t < Date.now() + 60_000
}

/**
 * 渠道实现 —— 供聚合层消费，**本身不是插件**（不导出 config/auth/provider）。
 *
 * 聚合层按这个形状调用：
 *   - `id` / `displayName`：渠道标识
 *   - `fallbackModels`：未登录时的兜底目录
 *   - `login(openBrowser)` → `{ credential, authorizeUrl }`
 *   - `refresh(credential)` → 新凭据（失败抛错并留痕）
 *   - `expired(credential)` → 是否临期
 *   - `catalog(credential)` → `{ [modelId]: modelDef }`
 *   - `chat(credential, { model, body, signal })` → Response
 */
export const officeaceChannel = {
  id: PROVIDER,
  displayName: 'OfficeAce',

  // 未登录时的兜底目录（实测 `/v2/models` 有 11 个，这里列常用的 10 个）。
  fallbackModels: {
    'glm-5.3': { name: 'GLM-5.3', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'glm-5.2': { name: 'GLM-5.2', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'glm-5.1': { name: 'GLM-5.1', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'deepseek-v4': { name: 'DeepSeek-V4', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'deepseek-v4.1': { name: 'DeepSeek-V4.1', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'qwen3-30b': { name: 'Qwen3 30B', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'qwen3-32b': { name: 'Qwen3 32B', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'kimi-k2.6': { name: 'Kimi-K2.6', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'pangu-2.0-pro': { name: '盘古 2.0 Pro', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'pangu-2.0-flash': { name: '盘古 2.0 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  },

  /** 返回 `{ url, credential }` —— url 立刻可用，登录结果在 credential promise 里。 */
  beginLogin,
  refresh: refreshCredential,
  expired,
  catalog: fetchCatalog,

  /** 发一次对话请求；`model` 已去掉渠道前缀。 */
  async chat(credential, { body, signal }) {
    const url = `${maasBase(credential)}${CHAT_PATH}`
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // ⚠️ MaaS 用 **Basic**（appKey:appSecret base64），不是 Bearer。
        authorization: basicAuthorization(credential),
      },
      body: JSON.stringify(body),
      signal,
    })
  },
}
