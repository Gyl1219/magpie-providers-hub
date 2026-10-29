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
import { loadCredential, saveCredential, notSignedIn, expiryBandedWindows } from './shared.mjs'

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
 *
 * 倍率（V11 `/v1/model-token-rates`）拼进展示名（`GLM-5.2 · x0.7`）——
 * 与 resolveModel 同源（选择器显示与实际计费一致）。
 *
 * ⚠️ **拉不到倍率表时不做过滤**（回落全量，行为与加过滤前一致）：
 *    过滤的前提是「倍率表 = 已部署证据」，表都拉不到就没有证据可用 ——
 *    这时若只留白名单，会把一个本来正常的账号缩成 5 个模型（比列出几个
 *    可能 404 的更糟）。倍率表可用时才按它过滤。
 */
async function fetchCatalog(credential) {
  const response = await fetch(`${maasBase(credential)}${MODELS_PATH}`, {
    headers: { Accept: 'application/json', Authorization: basicAuthorization(credential) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`OfficeAce 目录读取失败：HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
  // 倍率表失败不阻断目录（降级为无 x 系数）
  const rates = await fetchTokenRates(credential).catch(() => new Map())
  // ⚠️ 只有拿到倍率表才启用部署过滤（空表 = 没证据，不过滤）
  const deployFiltered = rates.size > 0
  const models = {}
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (typeof row?.id === 'string' ? row.id : '')
    if (id.length === 0) continue
    // ⚠️ **账号部署过滤**：`/v2/models` 是全平台目录，本账号未部署的模型
    //    推理端回 HTTP 404 + `ModelArts.81009 Invalid model`（选到就整轮失败）。
    //    ① RATE_BUT_UNDEPLOYED：**无条件**剔除「确证跑不了」的反向例外
    //       （与倍率表能否拉到无关 —— 这是硬事实）；
    //    ② 倍率表命中 = 已开通计费项（实测 9 条里 8 条可用）；
    //    ③ DEPLOYED_NO_RATE：补「能跑但无倍率」（免费/预览）。
    //    ⚠️ ②③ 只在倍率表可用时生效：拿不到表就没有证据，跳过过滤回落全量，
    //       否则一次 V11 抖动会把正常账号从十来个模型缩成 5 个。
    if (RATE_BUT_UNDEPLOYED.has(id)) continue
    if (deployFiltered && !verifiableDeployed(id) && !rates.has(id)) continue
    const baseName = typeof row?.name === 'string' && row.name.length > 0 ? row.name : id
    const rate = rates.get(id)
    models[id] = {
      // ⚠️ x1 不标（全默认倍率没有信息量）；只标非 1 的
      name: rate !== undefined && rate !== 1 ? `${baseName} · x${rate}` : baseName,
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

/**
 * 已真机验证「本账号能跑、但不在 V11 倍率表里」的模型（免费/预览计费项不入表）。
 * ⚠️ 2026-10-26 实测 26 个目录项逐个打推理端得出。
 */
const DEPLOYED_NO_RATE = new Set([
  'deepseek-v4-flash',
  'deepseek-v4.1-flash-0930',
  'qwen3-30b-a3b',
  'qwen3-32b',
  'kimi-k2.6',
])
const verifiableDeployed = (id) => DEPLOYED_NO_RATE.has(id)

/**
 * 已真机验证「**在**倍率表里、但本账号推理端仍不可用」的模型 —— **反向例外**。
 *
 * ⚠️⚠️ 这是本文件最容易写错的一条：「进了倍率表」**不等于**「已部署」。
 *    实测 `glm-5.3-flash` 在 V11 倍率表里（有 cost_coefficient），
 *    但推理端回 `HTTP 404 ModelArts.81009 Invalid model` ——
 *    用户选中它就会整轮失败（2026-10-26 真机报障）。
 *    故这两张表要**同时**用：白名单补「能跑但无倍率」，本表剔除「有倍率但跑不了」。
 */
const RATE_BUT_UNDEPLOYED = new Set([
  'glm-5.3-flash',
])

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

/**
 * 续期的**纯协议**部分：STS 交换 + modelInfo。
 *
 * ⚠️ 落盘职责留给调用方（对齐 DSH `doRefreshCredential` 的抽法）：避免同一份凭据
 *    被写两处、重复消费一次性 refresh_token。
 *
 * ⚠️ 缺口 5：**STS 一成功就落盘，不等 modelInfo**（顺序不能反）。原先等
 *    modelInfo 一起成功才落盘，中途崩掉就把新 refresh_token 丢了。
 */
async function doRefresh(current, persist) {
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
    // ⚠️「已被消费」要单独成句：它的含义是**新 token 没落盘**，不是网络抖动，
    //    重试一万次也是同一个错（真机 2026-10-29：STS5.1806 → 只能重新登录）。
    const consumed = /STS5\.1806|has been used/i.test(detail)
    console.warn(
      `[officeace] STS 续期失败 HTTP ${r.status}${consumed ? '（refresh_token 已被消费 —— 新 token 未落盘，必须重新登录）' : ''}：${detail.slice(0, 200)}`,
    )
    throw new Error(consumed
      ? 'OfficeAce 续期失败：refresh_token 已被消费（一次性），新凭据未落盘 —— 请重新登录'
      : 'OfficeAce 续期失败，请重新登录')
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
  // 缺口 5：STS 一成功**立即落盘**，不等 modelInfo（此刻旧 refresh_token 已作废）
  persist?.(next)
  try {
    Object.assign(next, await fetchModelInfo(next))
  } catch {
    // modelInfo 失败不回滚 STS：推理凭据可能仍有效
  }
  return next
}

/**
 * **并发去重闸**（缺口 1 —— 最危险的一个）。
 *
 * ⚠️ refresh_token 是**一次性**的：两个并发请求同时看到临期 → 各自发一次 STS 续期 →
 *    第二次去消费已被消费的 refresh_token → 凭据**永久失效**，只能重新登录。
 *    故同一凭据同一时刻只允许一个在途续期，其余调用方共享它的结果。
 *
 * ⚠️⚠️ 键必须是**凭据身份**（refreshToken）而不是渠道 id：账号池下同渠道
 *    会有多个账号并发续期 —— 按渠道键控会让账号 B 共享账号 A 的续期结果
 *    （拿到别人的凭据，且 B 的 token 根本没被消费）。聚合层 gatedRenew 同款键控。
 */
const refreshInFlight = new Map()

function refreshOnce(current, persist) {
  const key = `${PROVIDER}\n${current?.refreshToken ?? ''}`
  const pending = refreshInFlight.get(key)
  if (pending !== undefined) return pending
  const task = doRefresh(current, persist).finally(() => refreshInFlight.delete(key))
  refreshInFlight.set(key, task)
  return task
}

/**
 * 临期判据：提前 **10 分钟**（缺口 2，原先只留 60 秒）。
 *
 * ⚠️ 60 秒在真实链路上必然踩边界：一次长对话（上游思考链超时给到 600 秒）会在中途过期。
 * ⚠️ `expiresAt` 解析不出来时**保守判为临期**（对齐 DSH `isExpiring`）：
 *    拿不到时间就不能假设它还有效。
 */
const EXPIRY_LEAD_MS = 10 * 60 * 1000

const expired = (c) => {
  if (!c?.expiresAt) return false
  const t = Date.parse(c.expiresAt)
  if (!Number.isFinite(t)) return true
  return t - Date.now() < EXPIRY_LEAD_MS
}

/**
 * 「这次重发**有没有意义**」的指纹（缺口 4）：决定 Basic 鉴权 + 目标 host 的三个字段。
 *
 * ⚠️ 必须含 **host**：真实缺陷是「华为按账号下发专属网关，Basic 二元组逐字节不变、
 *    只有网关变了」。只比 key/secret 会把「换 host 后重发有意义」误判为无意义。
 * ⚠️ 也**不能用对象身份**判（每次解析都是新对象，`renewed !== credential` 恒为真
 *    ⇒ 401 恒被白重发一次）。
 */
const basicAuthFingerprint = (c) =>
  `${c.modelAppKey}\u0000${c.modelAppSecret}\u0000${maasBase(c)}`

/**
 * 什么算「这对 Basic 凭据被拒」（缺口 4 的判据，逐字对齐 DSH）。
 *
 * | 状态 | 认定 | 理由 |
 * |---|---|---|
 * | **4xx** | ✅ | 客户端错误类；报文点名了这对凭据 ⇒ 就是它被拒 |
 * | **2xx** | ❌ | 成功响应的 body 是**模型输出** —— 用户正在排查的就是这句报文，模型完全可能原样复述 ⇒ 若认可，一次**成功的回答**会把整个渠道误判成凭据失效 |
 * | **5xx** | ❌ | 基础设施抖动、形状未知 ⇒ 宁可多撞一次，不可误伤渠道 |
 *
 * ⚠️ 边界画在**状态类**（4xx）而非枚举具体码：华为文档把 APIG.1009 定义为 400、
 *    真机回 401，再冒出 403 包装层也不该漏。**两条腿都要**（码腿 + 措辞腿）：
 *    码是权威，但网关包装层可能改码；措辞来自真机报文原文。
 */
const isBasicCredentialRejection = (status, body) => {
  if (!(status >= 400 && status < 500)) return false
  return /APIG\.1009/i.test(body) || /AppKey or AppSecret/i.test(body)
}

/**
 * 4xx/401 时「续期这一次到底发生了什么」的**四态**（刻意不是布尔）。
 *   'not-attempted' | 'unchanged' | 'changed' | 'unreadable'
 *
 * ⚠️ `unreadable`（续期后拿不到凭据）与 `unchanged`（拿到了但逐字节没变）指向
 *    **完全不同的下一步动作**，混成布尔必然给错指引。
 */

/** 按形状给出可读归因。⚠️ 顺序必须是**先判形状、再判状态码**。 */
function diagnose(status, body, renewal) {
  if (isBasicCredentialRejection(status, body)) {
    if (renewal === 'unchanged') {
      return '已续期，但 AppKey/AppSecret 与网关**一个字节都没变** ⇒ 重新登录改变不了这个拒绝，'
        + '请到华为云控制台核对该账号的订阅/权限（反复重登无效）'
    }
    if (renewal === 'changed') {
      return '凭据刚续期且已变化仍被拒 ⇒ 权限/订阅面问题（新凭据同样不被 MaaS 认可）'
    }
    if (renewal === 'unreadable') {
      return '续期后取不到凭据 ⇒ 请重新登录'
    }
    return '华为 APIG.1009：MaaS 侧不认这对 AppKey/AppSecret（本次未尝试续期）'
  }
  if (status === 401) {
    return 'HTTP 401，但报文不是已知的「AppKey/AppSecret 无效」形状 —— '
      + '可能是网关/代理层抖动，请核对出口 IP 与 endpoint，不必急着重登'
  }
  return `HTTP ${status}`
}

// ── V11 签名的订阅面（移植 officeace-auth.ts 的 signAndRequest / claimDailyBonus）──

/**
 * V11 签名请求（华为 APIG 私有算法，逐字复刻 OfficeAce 客户端的 B()/F()）。
 *
 * ## 三条铁律（每条都曾导致 401，别凭直觉改）
 *
 * 1. **GET 不发 Content-Type**（客户端的 cloudFetch 只在非 GET 时设置它）——
 *    多这一个头，签名串就多一行，服务端重算必不匹配。POST 必须带
 *    （实测不带是 HTTP 500 OfficeAce.11020001），且 body 参与哈希（无 body 按空串）。
 * 2. **密钥派生**：u = HMAC(sha256, accessKey).update(secretKey)；
 *    derive = HMAC(sha256, u).update(scope 字节 + 0x01) 取**前 32 字节**；
 *    以 derive 的 **hex 字符串**（不是 raw bytes）为 key 签 stringToSign。
 * 3. **LF 分隔**（canonical 头行与 stringToSign 都是）；canonical 路径**强制尾斜杠**；
 *    头值 trim + 折叠空白。
 *
 * @returns `{ ok, status, text }` —— 失败把报文带出来（报文是唯一指路信息：
 *   token expired / IAM.0011 / 签名过期，各指向完全不同的处置动作）。
 */
async function signAndRequest(url, credential, method, body) {
  const region = 'cn-southwest-2'
  const service = 'apic'
  const pad = (n) => (n >= 10 ? String(n) : `0${n}`)
  const now = new Date()
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const urlEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

  const u = new URL(url)
  const canonicalUri0 = u.pathname.split('/').map((s) => urlEncode(decodeURIComponent(s))).join('/')
  const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`
  const queryPairs = []
  u.searchParams.forEach((v, n) => queryPairs.push([n, v]))
  queryPairs.sort(([a], [c]) => a.localeCompare(c))
  const canonicalQuery = queryPairs.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join('&')

  const original = {
    'x-subscription-type': 'v2',
    'X-Sdk-Date': xdate,
    'X-Security-Token': String(credential.securityToken ?? '').trim(),
    Host: u.host,
  }
  if (method === 'POST') original['Content-Type'] = 'application/json;charset=utf8'
  if (credential.projectId) original['X-Project-ID'] = credential.projectId
  const lower = {}
  for (const [k, v] of Object.entries(original)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  const signedHeaders = Object.keys(lower).sort()
  let canonicalHeaders = ''
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`
  const payloadHash = createHash('sha256').update(body ?? '', 'utf8').digest('hex')
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n')
  const scope = `${xdate.slice(0, 8)}/${region}/${service}`
  const stringToSign = ['V11-HMAC-SHA256', xdate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  // ⚠️ 残缺凭据（只落了 access、没有 secret —— 例：登录走到一半的旁路文件）会让
  //    下面 HMAC 抛 Node 的 ERR_INVALID_ARG_TYPE，卡片显示成看不懂的英文报错。
  //    这里先拦一道，给一句能照做的提示。
  if (!credential?.access || !credential?.secret) {
    throw new Error('凭据不完整（缺 access/secret），请重新登录华为云 OfficeAce')
  }
  const u1 = createHmac('sha256', credential.access).update(credential.secret).digest()
  const derivedKey = createHmac('sha256', u1)
    .update(Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])]))
    .digest()
    .subarray(0, 32)
    .toString('hex')
  const signature = createHmac('sha256', Buffer.from(derivedKey, 'utf8')).update(stringToSign).digest('hex')

  try {
    const r = await fetch(url, {
      method,
      headers: {
        ...original,
        Authorization: `V11-HMAC-SHA256 Credential=${credential.access}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await r.text().catch(() => '')
    return { ok: r.ok, status: r.status, text }
  } catch (error) {
    // ⚠️ 失败/无响应也要带原因（不能只给空串 —— 那会把 401 读成「没有可领的」）
    return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error) }
  }
}

const SUBSCRIPTION_PATH = '/v1/subscription'
const TOKEN_RATES_PATH = '/v1/model-token-rates'
const BONUS_CLAIM_PATH = '/v1/subscription/bonus/claim'
/**
 * ⚠️⚠️ 订阅面（V11）挂在** MaaS 域**（`officeace.cn-southwest-2.huaweicloud-agentarts.com`，
 * DSH `OFFICEACE.defaultBaseUrl`），不是 CLAW 域（`agentarts.…myhuaweicloud.com` 是
 * 登录/auth 用的）。真机教训：打 CLAW 域回 `404 APIGW.0101 API 不存在`
 * —— 签名是对的（签名错是 401），纯粹主机不对。
 */
const SUBSCRIPTION_BASE = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com'

/**
 * 拉订阅（V11）→ magpie usage windows（积分分桶）。
 *
 * 响应含套餐桶（`skus[].quotas`，`sku_attr_code === 'officeace_points'`）与
 * 活动桶（`bonus_skus[]`）。⚠️ `.trial` 后缀的 sku 不带到期时间（试用不过期语义）
 * —— 照抄 DSH 判据，不猜。
 * 查询失败**不吞**：带原因显示。
 */
export async function fetchUsage(credential) {
  const result = await signAndRequest(`${SUBSCRIPTION_BASE}${SUBSCRIPTION_PATH}`, credential, 'GET')
  if (!result.ok) {
    // ⚠️ 「推理域活、订阅域死」的错法要说人话（真机 2026-10-29）：
    //    STS 三元组过期 → IAM 签名被 APIG 拒（APIG.0301 Unauthorized），
    //    而 chat 走的 CLAW 域用的是另一套会话（Bearer），照样 200。
    //    此时 refresh_token 已被上轮续期消费（STS5.1806，一次性的，救不回）
    //    —— 卡片上「对话不受影响，请重新登录」比 HTTP 401 原文有用得多。
    const iamDead = result.status === 401 && result.text.includes('APIG.0301')
    const tokenExpired = typeof credential?.expiresAt === 'string' && Date.parse(credential.expiresAt) < Date.now()
    if (iamDead && tokenExpired) {
      throw new Error(
        'IAM 会话已过期（订阅面 401），refresh_token 已被上轮续期消费（STS5.1806）——'
        + '对话不受影响，重新登录后恢复额度显示',
      )
    }
    const detail = result.text.trim().slice(0, 200)
    throw new Error(`订阅查询失败：HTTP ${result.status}${detail === '' ? '' : `：${detail}`}`)
  }
  let j
  try {
    j = JSON.parse(result.text)
  } catch {
    throw new Error('订阅查询失败：响应不是 JSON')
  }
  const windows = []
  const nowMs = Date.now()
  // ── 滚动指针分档（AGENTS.md 第 1 条）──
  // 每个 quota / bonus = 一个桶；「临期」永远指向**最早到期的未耗尽桶**（FEFO 头），
  // 它用完/过期后指针自动轮到下一桶。桶名带档位（`· 临期·N天` / `· 长期` /
  // `· 永久` / `· 已耗尽`），聚合层 bandOfWindow 的第 1 优先级就是「名字里已有档位」。
  const buckets = []
  for (const sku of Array.isArray(j?.skus) ? j.skus : []) {
    for (const q of Array.isArray(sku?.quotas) ? sku.quotas : []) {
      if (q?.sku_attr_code !== 'officeace_points') continue
      const total = Number(q.sku_value)
      const used = Number(q.current_value)
      if (!Number.isFinite(total) || total <= 0) continue
      const isTrial = String(sku.sku_code ?? '').endsWith('.trial')
      const expiresAt = typeof q.expired_time === 'string' && q.expired_time.length > 0 ? q.expired_time : null
      const remaining = Math.max(0, total - used)
      const expireMs = expiresAt !== null ? new Date(expiresAt).getTime() : NaN
      buckets.push({
        label: sku.sku_name ?? '套餐',
        remaining,
        poolTotal: total,                       // used% 按真实总量算
        expireMs: Number.isFinite(expireMs) ? expireMs : undefined,
        expireRaw: expiresAt ?? '',
        // ⚠️ 已过期的**试用桶不折叠**（用户要看得见它过期），非试用过期桶折叠
        asideWhen: Number.isFinite(expireMs) && !isTrial && expireMs <= nowMs,
      })
    }
  }
  for (const bonus of Array.isArray(j?.bonus_skus) ? j.bonus_skus : []) {
    const points = Number(bonus?.points)
    if (!Number.isFinite(points) || points <= 0) continue
    const used = Number(bonus.current_value)
    const remaining = Math.max(0, points - (Number.isFinite(used) ? used : 0))
    const expiresAt = typeof bonus.expired_time === 'string' ? bonus.expired_time : null
    const expireMs = expiresAt !== null ? new Date(expiresAt).getTime() : NaN
    buckets.push({
      label: bonus.activity_name ?? '活动奖励',
      remaining,
      poolTotal: points,
      expireMs: Number.isFinite(expireMs) ? expireMs : undefined,
      expireRaw: expiresAt ?? '',
      asideWhen: Number.isFinite(expireMs) && expireMs <= nowMs,
    })
  }
  // 分档 + 拼窗口（共享工具，AGENTS.md 第 1 条）
  for (const w of expiryBandedWindows(buckets, nowMs)) {
    const b = buckets.find((x) => w.name.startsWith(x.label))
    windows.push({
      ...w,
      ...(b?.asideWhen === true ? { aside: true } : {}),
      // ⚠️ 内部字段：仅供页面快照分档/倒计时，**不进 magpie 卡片**
      ...(b?.expireMs !== undefined ? { expiresAtMs: b.expireMs } : {}),
    })
  }
  return windows
}

/**
 * 每日签到：`POST /v1/subscription/bonus/claim`（每日送 1000 积分的活动桶）。
 *
 * ⚠️ 官方客户端**没有签到按钮** —— 订阅页一挂载就自动领（按小时去重）。
 * ⚠️ 积分**当日作废**（expired_time = 当天 23:59:59）：当天不领就永久失去。
 * ⚠️ POST 必须带 Content-Type（铁律 1 的另一面：不带是 500 11020001）；
 *    非 2xx 必须按状态码判（signAndRequest 对失败可能给空串 —— 401 会被
 *    读成「今天没有可领的」，每天白丢 1000 分且无痕，DSH 真实报障）。
 */
export async function checkin(credential) {
  if (!credential?.access || !credential?.securityToken) {
    return { outcome: 'failed', message: '凭据缺失（access 或 securityToken），未发起签到' }
  }
  const result = await signAndRequest(`${SUBSCRIPTION_BASE}${BONUS_CLAIM_PATH}`, credential, 'POST')
  if (!result.ok || result.status < 200 || result.status >= 300) {
    const detail = result.text.trim().slice(0, 200)
    return {
      outcome: 'failed',
      message: `HTTP ${result.status === 0 ? '（未发出/无响应）' : result.status}${detail === '' ? '' : `：${detail}`}`,
    }
  }
  if (result.text.length === 0) return { outcome: 'claimed', message: '已领取（响应为空）' }
  try {
    const j = JSON.parse(result.text)
    const skus = (Array.isArray(j?.bonus_skus) ? j.bonus_skus : []).map((s) => ({
      name: typeof s?.activity_name === 'string' ? s.activity_name : '活动奖励',
      points: Number(s?.points) || 0,
    }))
    const credit = skus.reduce((sum, s) => sum + s.points, 0)
    if (skus.length === 0) return { outcome: 'done', message: '今日已无新增可领' }
    return { outcome: 'claimed', ...(credit > 0 ? { credit } : {}), message: skus.map((s) => `${s.name} +${s.points}`).join('；') }
  } catch {
    // 2xx 但解析失败：领取本身可能已成功，不当失败报（重复领取幂等，明天再来）
    return { outcome: 'done', message: '已领取（响应无法解析）' }
  }
}

/** 倍率缓存（catalog 时拉一次，chat 的模型名展示同源）。模块级 + 20 分钟。 */
let tokenRatesCache = { at: 0, map: new Map() }
const TOKEN_RATES_TTL_MS = 20 * 60 * 1000

/**
 * 拉消耗倍率（V11）：`GET /v1/model-token-rates` → Map<模型id, 倍率>。
 * 响应 snake_case（`model_name` / `cost_coefficient`），兼容 camelCase 形态。
 * 失败 → 空表（倍率显示优雅降级：模型照常可选，只是名字后不带 x 系数）。
 */
export async function fetchTokenRates(credential) {
  if (Date.now() - tokenRatesCache.at < TOKEN_RATES_TTL_MS && tokenRatesCache.map.size > 0) {
    return tokenRatesCache.map
  }
  const out = new Map()
  try {
    const result = await signAndRequest(`${SUBSCRIPTION_BASE}${TOKEN_RATES_PATH}`, credential, 'GET')
    if (result.ok && result.text.length > 0) {
      const j = JSON.parse(result.text)
      for (const m of Array.isArray(j?.models) ? j.models : []) {
        const name = typeof m?.model_name === 'string' ? m.model_name : (typeof m?.modelName === 'string' ? m.modelName : undefined)
        const coeff = typeof m?.cost_coefficient === 'number' ? m.cost_coefficient : (typeof m?.costCoefficient === 'number' ? m.costCoefficient : undefined)
        if (name !== undefined && coeff !== undefined) out.set(name, coeff)
      }
      tokenRatesCache = { at: Date.now(), map: out }
    }
  } catch { /* 空表降级 */ }
  return out
}

/**
 * 渠道实现 —— 供聚合层消费，**本身不是插件**（不导出 config/auth/provider）。
 *
 * 聚合层按这个形状调用：
 *   - `id` / `displayName`：渠道标识
 *   - `fallbackModels`：未登录时的兜底目录
 *   - `beginLogin(openBrowser)` → `{ url, result }`（url 立刻可用，不 await 登录）
 *   - `refresh(credential, persist?)` → 新凭据；`persist` 负责立即落盘
 *   - `expired(credential)` → 是否临期（提前 10 分钟）
 *   - `catalog(credential)` → `{ [modelId]: modelDef }`（倍率拼进 name）
 *   - `chat(credential, { body, signal, renew? })` → Response
 *   - `usage(credential)` → magpie windows（订阅积分分桶）
 *   - `checkin(credential)` → 每日签到（bonus/claim）
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

  /** 返回 `{ url, result }` —— url 立刻可用，登录结果在 result promise 里。 */
  beginLogin,
  // ⚠️ 必须绑 **refreshOnce**（带去重闸 + 接 persist），不能绑 doRefresh：
  //    绑错的话缺口 1 的并发闸就是死代码 —— 并发续期会各自消费一次性
  //    refresh_token，直接把凭据打死。
  refresh: refreshOnce,
  expired,
  catalog: fetchCatalog,
  /** 订阅积分分桶（V11 直读，失败由聚合层带原因显示）。 */
  usage: fetchUsage,
  /** 每日签到（POST bonus/claim，每日 1000 积分、当日作废）。 */
  checkin,

  /**
   * 发一次对话请求；`model` 已去掉渠道前缀。
   *
   * ## 缺口 4：非 2xx 时「续期一次再重发」有没有意义
   *
   * 闸门必须是**超集**：`401` 照旧一律尝试续期（形状未知的网关 401 也可能是凭据
   * 陈旧，旧行为能救回来的不能丢），**另外**把「4xx + 报文点名这对 Basic 凭据」
   * 也算进来（APIG.1009 文档 400／真机 401，只认 401 会漏掉文档那一侧）。
   *
   * 重发与否**只认指纹**（key+secret+host），不认对象身份 —— 指纹没变 ⇒ 重发注定
   * 得到同一个拒绝，不如把这句话原样告诉用户（省去一次无效重登）。
   */
  async chat(credential, { body, signal, renew }) {
    const url = `${maasBase(credential)}${CHAT_PATH}`
    const headers = {
      'content-type': 'application/json',
      // ⚠️ MaaS 用 **Basic**（appKey:appSecret base64），不是 Bearer。
      authorization: basicAuthorization(credential),
    }
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    })
    if (response.ok) return response

    const text = await response.text().catch(() => '')
    let finalStatus = response.status
    let finalText = text
    // 产生**最终**那次拒绝的凭据。
    // ⚠️ 续期真的换掉 Basic 三元组时，下一轮用的是**新**那份 ⇒ 归因必须落在它身上，
    //    否则永远追不上实际在用的凭据，每轮仍白撞一次。
    let rejected = credential
    let renewal = 'not-attempted' // 四态，不是布尔

    if ((finalStatus === 401 || isBasicCredentialRejection(finalStatus, finalText)) && renew) {
      const before = basicAuthFingerprint(credential)
      let renewed
      try {
        // 聚合层注入的是**硬**续期：失败会抛，才能与「续期成功但没变化」区分开
        renewed = await renew(credential)
      } catch {
        renewed = undefined
      }
      if (!renewed) {
        renewal = 'unreadable'
      } else if (basicAuthFingerprint(renewed) !== before) {
        renewal = 'changed'
        rejected = renewed
        const retry = await fetch(`${maasBase(renewed)}${CHAT_PATH}`, {
          method: 'POST',
          headers: { ...headers, authorization: basicAuthorization(renewed) },
          body: JSON.stringify(body),
          signal,
        })
        if (retry.ok) return retry
        finalStatus = retry.status
        finalText = await retry.text().catch(() => '')
      } else {
        // 续期跑了，但决定鉴权与网关的三个字段逐字节没变 ⇒ 重发没有意义
        renewal = 'unchanged'
      }
    }

    return Response.json({
      error: {
        type: 'provider_error',
        message: `OfficeAce（华为 MaaS）返回 HTTP ${finalStatus}：`
          + `${finalText.slice(0, 200)}（${diagnose(finalStatus, finalText, renewal)}）`,
        // 透传给上层做熔断/重试判定的原始状态码（不用被拒绝的凭据参与）
        provider_status: finalStatus,
        credential_rejected: isBasicCredentialRejection(finalStatus, finalText),
        renewal_outcome: renewal,
        rejected_fingerprint: basicAuthFingerprint(rejected),
      },
    }, { status: finalStatus >= 400 ? finalStatus : 502 })
  },
}

// 供测试与聚合层复用的判据（**唯一一份实现**，避免两处漂移）
export {
  expired,
  basicAuthFingerprint,
  isBasicCredentialRejection,
  diagnose,
  refreshOnce,
  EXPIRY_LEAD_MS,
}
