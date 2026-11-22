// 千问办公国际版（qwenwork.ai）渠道 —— 包装器设备流 + 网关主机。
//
// ## 登录：包装器设备流（**不是**粘贴式 Ory 回调）
//
// 早前这版按「Ory 网页登录 + 用户粘贴回调」写，已作废：国际站唯一被注册的
// redirect_uri 落在网关上，插件收不到回调。真机实测走通的路线是**包装器设备流**：
//
//   1. `GET https://gateway.qwenwork.ai/device/selectAccounts`（参数全在 query）
//      `challenge=` S256 / `challenge_method=S256` / `nonce=` / `machine_id=` /
//      `client_id=cc65e5fc-…` / `redirect_uri=qwenwork://`
//      → 302 到 `https://qwenwork.ai/oauth2/auth`，那一跳里换成 issuer 的
//        `client_id=qwenwork-desktop-app`、回调到网关、scope 含 `qwen_work`。
//      **外层 client 与 scheme 是专属的一对**：换成 CN 的 client 或换成
//      `https://gateway…/oauth/callback` 都是 400 `INVALID_DEVICE_FLOW`。
//   2. 用户在浏览器里完成登录（插件只等，不接收任何粘贴）。
//   3. 轮询 `GET https://gateway.qwenwork.ai/api/v1/deviceToken/poll`
//      `?nonce=&verifier=&challenge_method=S256`：
//        · 未授权 = **404 空体**（是「等待」，不是失败 —— 别把它当错误终止登录）
//        · 成功   = **200 + token / refresh_token**
//        · 多带 `client_id` = 400 `not_allowed`（所以 poll 只发这三个参数）
//
// ## 续期：网关的 deviceToken/refresh，**只认包装器对**
//
//   `POST https://gateway.qwenwork.ai/api/v1/deviceToken/refresh`
//   body `{ refresh_token, target: "c", client_id: <包装器 client>, redirect_uri: "qwenwork://" }`
//
// 用 issuer 的对（`qwenwork-desktop-app` + 网关回调）会被 400
// `INVALID_REFRESH_REQUEST`；所以**不要**改走 `/auth/oauth/token` 的
// `grant_type=refresh_token`（那条老路已删）。
//
// ## 目录 / 对话 / 账号上下文：全在 gateway 上
//
//   · 目录 `GET  https://gateway.qwenwork.ai/algo/api/v2/model/list?Encode=1`（要 COSY 签名）
//   · 对话 `POST https://gateway.qwenwork.ai/algo/api/v2/service/pro/sse/agent_chat_generation
//     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`（要 COSY 签名，SSE）
//   · 账号 `GET  https://gateway.qwenwork.ai/api/v1/adapter/user/account-context
//     ?include=user,plan,quota`（普通 `Bearer <token>`，真机 200，界面上
//     `700 credits / Free` 就是它的 `quota`）
//
// `openapi.qoder.sh` 上只有钱包（`/api/v1/adapter/user/wallets`，401）与一份
// 同名的 `/algo/*` 挂载；本渠道的目录/对话/账号一律走 gateway —— 真机 200 都在这边。
//
// ## COSY 签名（chat/catalog）
//
// `/algo/*` 只认信封，不认普通 Bearer（实测带完整信封打 `/api/v1/*` 仍是
// 401 `User not authenticated`）。签名实现在 `./qwenwork-intl-cosy.mjs`（龙娘维护，
// 这里只 import 不改）：`Authorization: Bearer COSY.<payload>.<sig>`，
// `sig = md5(payload\nkey\nts\nwireBody\npath)`，path 剥掉 `/algo` 前缀，
// body 必须是 `encodeBody(json)` 之后的上线形态。
//
// ## 对话要两个业务字段（真机实测，缺了就是 400）
//
// 网关在签名之外还要 `request_id` 与 `session_id`（都走 snake_case，驼峰
// `requestId` 会被当无效字段）：先回 `400 request_id is required`，补上再回
// `400 session_id is required`，两个都补才 200 SSE。宿主那边是 OpenAI 形状、
// 不带这两个 ⇒ `chat()` 自己补 uuid，**已有的不覆盖**（见 `withRequestIdentity`）。
//
// ## 未验证（不许当成已完成）
//
// · **经由本渠道 `chat()` 的端到端还没跑过**：协议层已由群内在真机上验通 ——
//   同一份凭据 + COSY 模块直打网关，补上两个字段后拿到 200 SSE（17 个 chunk、
//   `X-Model-Name: qwen3.8-flash`）。但那是绕开本模块的探针，不是这里的代码跑出来的
//   结果；真机跑通前不许声称可用（AGENTS §5）。
// · SSE chunk 是否还要二次解码：未知 ⇒ chat **不碰响应正文**，原样透传给宿主。
// · `deviceToken/poll` 的 200 响应体字段名（`access_token` / `accessToken`）与
//   `deviceToken/refresh` 的响应形状：只核到状态码与「能换票」的结论，
//   字段两种写法都认（见 `tokenOf`）。
// · 国际站有没有签到/积分活动：未知，所以 `checkin` 是 inactive。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { debugLog } from './shared.mjs'
import {
  COSY_CHAT_PATH,
  COSY_MODELS_PATH,
  chatHeaders,
  cosyHeaders,
  decodeBody,
  encodeBody,
} from './qwenwork-intl-cosy.mjs'

export const CHANNEL_ID = 'qwenwork-intl'
export const DISPLAY_NAME = '千问办公 (国际版)'

// ── 端点 ──────────────────────────────────────────────────────────────────

const ISSUER = 'https://qwenwork.ai'
/** Ory 的 authorize（302 的目标；也用作「拿不到 Location」时的兜底拼装）。 */
const AUTHORIZE_URL = `${ISSUER}/oauth2/auth`
const USERINFO_URL = `${ISSUER}/user/info`

/** 国际站网关：设备流、目录、对话、账号上下文都在这台。 */
const GATEWAY = 'https://gateway.qwenwork.ai'
const DEVICE_START_URL = `${GATEWAY}/device/selectAccounts`
const DEVICE_POLL_URL = `${GATEWAY}/api/v1/deviceToken/poll`
const DEVICE_REFRESH_URL = `${GATEWAY}/api/v1/deviceToken/refresh`
const ACCOUNT_CONTEXT_URL = `${GATEWAY}/api/v1/adapter/user/account-context`

const CLIENT_ID = 'qwenwork-desktop-app' // issuer 侧（302 之后 Ory 用的那个）
const REDIRECT_URI = `${GATEWAY}/oauth/callback` // issuer 侧的注册回调
const SCOPE = 'openid profile email offline_access qwen_work'
/** 包装器（外层）client：设备流入口与 poll/refresh 只认它。 */
const WRAPPER_CLIENT_ID = 'cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a'
/** 包装器侧的 scheme（**裸 scheme**，`qwenwork-cn://` 是 CN 的）。 */
const WRAPPER_REDIRECT_URI = 'qwenwork://'

const API_BASE = GATEWAY
// 真实路径都在 /algo/* 且必须带 COSY 签名（见文件头）：
const MODELS_PATH = COSY_MODELS_PATH
const CHAT_PATH = COSY_CHAT_PATH

/** 上游按客户端标识认人，缺了会被网关挡（探针时用同一组头才拿到 401 而不是 404）。 */
const UA = 'qoderwork/2.0.2'
const CLIENT_HEADERS = {
  'user-agent': UA,
  'x-qwenwork-version': '2.0.2',
  'x-qwenwork-release-version': '2.0.2-26111211',
  'x-qwenwork-build': '26111211',
  'x-qwenwork-channel': 'stable',
}

const LOGIN_TIMEOUT_MS = 15 * 60_000
/** 轮询间隔：网关 pending 是 404，2s 一次既够快又不至于把登录窗口刷满。 */
const POLL_INTERVAL_MS = 2_000
const EXCHANGE_TIMEOUT_MS = 30_000
/** 临期提前量：与其它渠道同口径（10 分钟）。 */
const EXPIRY_LEAD_MS = 10 * 60 * 1000

const nonEmpty = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)

// ── COSY 账号视图 ─────────────────────────────────────────────────────────

/**
 * 把凭据翻成 COSY 信封要的形状。`uid` 与 `machineId` 缺一不可：
 * 前者要跟 access token 同属一人（上游服务端会验 `Cosy-User`），后者是设备身份。
 * 两者都只在登录时拿到 ⇒ 缺了就**只能重新登录**（不是续期能补的）。
 *
 * @returns {{ uid, name, email, access, machineId } | undefined}
 */
function cosyAccountOf(credential) {
  const access = nonEmpty(credential?.access_token)
  const uid = nonEmpty(credential?.uid) ?? nonEmpty(credential?.subject)
  const machineId = nonEmpty(credential?.machineId)
  if (access === undefined || uid === undefined || machineId === undefined) return undefined
  return {
    uid,
    name: nonEmpty(credential?.nickname) ?? '',
    email: nonEmpty(credential?.email) ?? '',
    access,
    machineId,
  }
}

/** 缺 COSY 身份时的统一响应：登录态按「过期」交回，让聚合层提示重新登录。 */
const needsRelogin = (why) => Response.json(
  { error: { type: 'provider_error', message: `登录态缺少 COSY 身份（${why}）：请重新登录千问办公（国际版）` } },
  { status: 401, headers: { 'X-Magpie-Sign-In': 'expired' } },
)

// ── 兜底目录 ──────────────────────────────────────────────────────────────
//
// id 取自上游 `QWENWORK_MODELS`（标准 / 高级 / Qwen3.8-Max 三条），显示名同源。
//
// ⚠️ **这些 id 只能写在这一处，且真值只有上游说了算。** 本项目里已经实测到：
// 同一个长 id，「人眼读到的」和「node 读到的字节」会对不上（组里一次排查中，终端
// 打印出来是个 `a` 字头的 id，实际传进去的字节首字符是 `q`）。所以：
//
//   · 手抄一份就多一次漂移机会，用户点了漂掉的 id 直接 400；
//   · 别处一律引用 `FALLBACK_MODEL_IDS`，不在测试、脚本、**注释**里重写字面量 ——
//     注释不参与求值，但它是下一次手抄的起点；`tests/qwenwork-intl.test.mjs` 有一条
//     「长 id 字面量全仓代码只出现一次」的门禁，注释里再抄一份也会让它红；
//   · 排查时一律用 Buffer/hex 比对，不靠文本搜索：实测 `Select-String` 对长 id 报
//     0 命中而文件里确实存在，人眼读、终端打印同样不可靠；
//   · 判定权交给 `tests/qwenwork-intl.test.mjs` 的「与上游 QWENWORK_MODELS 逐字节
//     一致」用例 —— 它按括号配对切出上游完整字面量，用 hex 逐条比。本机没有
//     上游解包产物时这条会 skip（**skip 不等于通过**，那台机器上就没校验）。
//
// 三条 id 的字节如需复核：跑那条用例，失败信息里同时打印本仓与上游两行 hex。
//
// `QWENWORK_MODELS` 本身不带上下文长度；`FALLBACK_CONTEXT` 取自同产物
// `QWORK_FALLBACK_LISTING` 的 `max_input_tokens`（其注释说明是从公有云
// 列表抄的、未逐条核过）—— 只当显示用的提示，别据此断言真实上限。
const FALLBACK_CONTEXT = 131_072

/** 与 `FALLBACK_MODEL_NAMES` 按下标一一对应，顺序即上游顺序。 */
export const FALLBACK_MODEL_IDS = ['flash', 'pro', 'qwen3.8-max-preview']
const FALLBACK_MODEL_NAMES = ['标准', '高级', 'Qwen3.8-Max']

export const fallbackModels = Object.fromEntries(
  FALLBACK_MODEL_IDS.map((id, index) => [
    id,
    {
      name: FALLBACK_MODEL_NAMES[index],
      limit: { context: FALLBACK_CONTEXT, output: 0 },
      tool_call: true,
      options: {},
      headers: {},
      status: 'active',
      release_date: '',
    },
  ]),
)

// ── 到期判定 ──────────────────────────────────────────────────────────────

/**
 * 凭据到期时刻（毫秒）。
 * ⚠️ 日期字符串必须走 `Date.parse`，不能用 `Number()`（AGENTS §5：NaN 恒真 →
 *    永远判「没过期」→ 拿死 token 打上游）。
 */
export function expiresAtMs(credential) {
  const raw = credential?.expires_at ?? credential?.expiresAt
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? Math.round(raw) : Math.round(raw * 1000)
  }
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      return n > 1e12 ? n : n * 1000
    }
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * 是否过期。**无到期字段 = 未知**，当可用处理（401 兜底识别）——
 * 「未知」不是「已过期」，否则没记住 expires_in 的账号会被判死。
 */
export function expired(credential) {
  const at = expiresAtMs(credential)
  if (at === undefined) return false
  return at - EXPIRY_LEAD_MS <= Date.now()
}

// ── PKCE / 授权 URL ───────────────────────────────────────────────────────

/**
 * verifier = base64url(randomBytes(64)) → 86 字符（Ory 要求 43~128）。
 * 与上游 0.3.0 的 `intlSignIn` 一致：`b64url(randomBytes(64))`。
 */
export function createPkce() {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * issuer 侧的 authorize URL。正常登录由包装器 302 给出（`startDeviceFlow` 读
 * `Location`）；这里只在网关没回 `Location` 时兜底拼一条等价的。
 *
 * Ory 拒短 state（实测 "state is missing or does not have enough characters"）。
 */
export function buildAuthorizeUrl({ state, challenge, nonce, redirectUri = REDIRECT_URI, clientId = CLIENT_ID } = {}) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
    nonce: nonce ?? randomUUID(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${AUTHORIZE_URL}?${query.toString()}`
}

// ── 包装器设备流：起流程 / 轮询 ───────────────────────────────────────────

/** 设备流入口的 query（真机那次 302 的五个参数，一个都不能省）。 */
export function buildStartQuery({ nonce, challenge, machineId }) {
  return new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: WRAPPER_CLIENT_ID,
    redirect_uri: WRAPPER_REDIRECT_URI,
  })
}

/**
 * 起设备流：拿 302 的 `Location`（= issuer 的 authorize URL）。
 *
 * 方法：**GET**（探针三次复跑都是 302）。交办单里写的是 `POST` + query ——
 * 两种都不带 body、参数全在 query，所以这里先 GET，遇 404/405 再退 POST，
 * 不靠猜。
 *
 * `redirect: 'manual'` 必须给：否则 fetch 会跟到 `qwenwork.ai/oauth2/auth`，
 * 那是给人看的登录页，在 node 里既拿不到 302 也没有意义。
 *
 * @returns {Promise<{ok:true, authorizeUrl, nonce, verifier, challenge, machineId} | {ok:false, error}>}
 */
export async function startDeviceFlow({ fetchImpl = fetch, signal } = {}) {
  const pkce = createPkce()
  const nonce = randomUUID()
  const machineId = randomUUID()
  const url = `${DEVICE_START_URL}?${buildStartQuery({ nonce, challenge: pkce.challenge, machineId })}`

  const attempt = (method) => fetchImpl(url, {
    method,
    headers: { ...CLIENT_HEADERS, accept: '*/*' },
    redirect: 'manual',
    ...(signal !== undefined ? { signal } : {}),
  })

  let response
  try {
    response = await attempt('GET')
    // 405 = 路由只认 POST；404 = 网关这一跳没挂 GET。两条都退 POST 再问一次。
    if (response.status === 404 || response.status === 405) response = await attempt('POST')
  } catch (error) {
    return { ok: false, error: `设备流入口请求失败：${error?.message ?? error}` }
  }

  if (!(response.status >= 300 && response.status < 400)) {
    // 400 INVALID_DEVICE_FLOW = 参数对不匹配（wrapper client / scheme 这一对是专属的）
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      error: `设备流入口被拒（HTTP ${response.status}）：${text.slice(0, 200) || '（空响应体）'}`,
    }
  }

  const location = nonEmpty(response.headers.get('location'))
  return {
    ok: true,
    authorizeUrl: location ?? buildAuthorizeUrl({ state: nonce, challenge: pkce.challenge, nonce }),
    nonce,
    verifier: pkce.verifier,
    challenge: pkce.challenge,
    machineId,
  }
}

/** 从 poll / refresh 的响应体里取 token（`data` 外壳与 camelCase 都认）。 */
export function tokenOf(payload) {
  const bare = typeof payload?.data === 'object' && payload.data !== null
    ? { ...payload, ...payload.data }
    : payload
  const access = nonEmpty(bare?.access_token) ?? nonEmpty(bare?.accessToken)
  if (access === undefined) return undefined
  const refreshToken = nonEmpty(bare?.refresh_token) ?? nonEmpty(bare?.refreshToken)
  const tokenType = nonEmpty(bare?.token_type) ?? nonEmpty(bare?.tokenType)
  const expiresIn = Number(bare?.expires_in ?? bare?.expiresIn)
  return {
    access_token: access,
    ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
    ...(tokenType !== undefined ? { token_type: tokenType } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
    ...(nonEmpty(bare?.scope) !== undefined ? { scope: bare.scope } : {}),
  }
}

/**
 * 轮询设备流。
 *
 * 契约（真机实测）：
 *   · **404 + 空体 = 仍在等待**（不是失败 —— 把它当错误会让登录在用户扫码前就死掉）；
 *   · 200 + token/refresh_token = 授权完成；
 *   · 400 = 参数形态不对（多带了 `client_id` 之类），这是**硬错误**，轮询下去也没用。
 *
 * @returns {Promise<{state:'pending'} | {state:'granted', token} | {state:'error', message, fatal?:boolean, status?:number}>}
 */
export async function pollDeviceToken({ nonce, verifier, fetchImpl = fetch, signal } = {}) {
  const query = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' }) // 不许带 client_id
  let response
  try {
    response = await fetchImpl(`${DEVICE_POLL_URL}?${query}`, {
      method: 'GET',
      headers: { ...CLIENT_HEADERS, accept: 'application/json' },
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    // 网络抖动不算失败：调用方继续轮询
    return { state: 'error', message: `轮询请求失败：${error?.message ?? error}` }
  }
  if (response.status === 404) return { state: 'pending' }

  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    payload = undefined
  }

  if (response.ok) {
    const token = tokenOf(payload)
    if (token === undefined) {
      return {
        state: 'error',
        status: response.status,
        message: `授权响应里没有 access_token：${text.slice(0, 200)}`,
      }
    }
    return { state: 'granted', token }
  }
  return {
    state: 'error',
    status: response.status,
    // 400 是「我们发错了」：client_id 多带一个就 400 not_allowed，继续轮询无意义
    fatal: response.status === 400,
    message: `轮询被拒（HTTP ${response.status}）：${text.slice(0, 200) || '（空响应体）'}`,
  }
}

// ── 账号上下文 / 身份 ─────────────────────────────────────────────────────

/**
 * 账号上下文（真机 200）：`data.user` 是身份，`data.plan` / `data.quota` 是额度。
 * 这是我们**唯一**能拿到 uid 的地方 —— COSY 的 `Cosy-User` 就要它。
 */
export async function fetchAccountContext(accessToken, { signal } = {}) {
  let response
  try {
    response = await fetch(`${ACCOUNT_CONTEXT_URL}?include=user,plan,quota`, {
      headers: { ...CLIENT_HEADERS, accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: signal ?? AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, error: `读账号上下文失败：${error?.message ?? error}` }
  }
  if (!response.ok) return { ok: false, error: `读账号上下文失败（HTTP ${response.status}）` }
  const payload = await response.json().catch(() => undefined)
  if (typeof payload !== 'object' || payload === null) return { ok: true, identity: {} }
  const user = typeof payload.data?.user === 'object' && payload.data.user !== null
    ? payload.data.user
    : (typeof payload.user === 'object' && payload.user !== null ? payload.user : {})
  const nickname = nonEmpty(user.name) ?? nonEmpty(user.nickname) ?? nonEmpty(user.preferred_username)
  const email = nonEmpty(user.email)
  const uid = nonEmpty(user.id) ?? nonEmpty(user.sub) ?? nonEmpty(user.user_id) ?? nonEmpty(user.uid)
  const quota = typeof payload.data?.quota === 'object' && payload.data.quota !== null ? payload.data.quota : undefined
  return {
    ok: true,
    identity: {
      ...(nickname !== undefined ? { nickname } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(uid !== undefined ? { subject: uid, uid } : {}),
    },
    ...(quota !== undefined ? { quota } : {}),
  }
}

/**
 * 读身份：先账号上下文（真机 200 的那条路，能给 uid），拿不到再退 Ory 的
 * `/user/info`（只认 OIDC token，claim 形状）。
 *
 * 拿不到就返回空对象 —— 聚合层会退化成渠道显示名（AGENTS §6 已有兜底）。
 */
export async function fetchIdentity(accessToken, { signal } = {}) {
  const context = await fetchAccountContext(accessToken, { signal })
  if (context.ok && Object.keys(context.identity).length > 0) {
    return { ok: true, identity: context.identity, ...(context.quota !== undefined ? { quota: context.quota } : {}) }
  }

  let response
  try {
    response = await fetch(USERINFO_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: signal ?? AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, error: context.ok ? `读用户信息失败：${error?.message ?? error}` : context.error }
  }
  if (!response.ok) {
    return { ok: false, error: `读用户信息失败（HTTP ${response.status}）` }
  }
  const info = await response.json().catch(() => undefined)
  if (typeof info !== 'object' || info === null) return { ok: true, identity: {} }
  // `/user/info` 的形状没实测：既可能是 OIDC claim，也可能是 `{data:{user:{…}}}`。
  // 上游 0.3.0 的 `normalizeUser` 是 `(v?.data ?? v)?.user ?? (v?.data ?? v)`，照它剥壳。
  const bare = typeof info.data === 'object' && info.data !== null ? info.data : info
  const user = typeof bare.user === 'object' && bare.user !== null ? { ...bare, ...bare.user } : bare
  const nickname = nonEmpty(user.name) ?? nonEmpty(user.preferred_username) ?? nonEmpty(user.nickname)
  const email = nonEmpty(user.email)
  const uid = nonEmpty(user.sub) ?? nonEmpty(user.id) ?? nonEmpty(user.user_id) ?? nonEmpty(user.uid)
  return {
    ok: true,
    identity: {
      ...(nickname !== undefined ? { nickname } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(uid !== undefined ? { subject: uid, uid } : {}),
    },
  }
}

// ── 登录页（本地状态页；设备流不需要粘贴）─────────────────────────────────

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function renderLoginPage({ authUrl, phase, message }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录千问办公（国际版）</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#1a1a1a;color:#eee;
     max-width:560px;margin:36px auto;padding:24px;border-radius:12px}
h2{margin-top:0;font-size:19px}
ol{padding-left:20px;line-height:1.9;font-size:14px;color:#ddd}
a.btn{display:inline-block;margin:8px 0 4px;padding:10px 16px;border-radius:6px;background:#3b82f6;
      color:#fff;text-decoration:none;font-size:14px}
#status{margin:14px 0;font-size:13px;min-height:20px;color:#9ca3af}
.hint{font-size:12px;color:#777;line-height:1.7}
</style></head><body>
<h2>登录千问办公（国际版）</h2>
<ol>
  <li>点下面的按钮打开授权页（已自动打开的话就用那个窗口）。</li>
  <li>在页面里用你的国际站账号登录并同意授权。</li>
  <li>完成后<strong>回到这一页</strong>即可 —— 插件在后台轮询，成功后会自动结束。</li>
</ol>
<a class="btn" href="${escapeHtml(authUrl)}" target="_blank" rel="noreferrer">打开授权页</a>
<div id="status">${escapeHtml(message ?? '')}</div>
<p class="hint">这条流程走的是国际版客户端的设备流：授权页由网关跳转到
qwenwork.ai，回调落在网关，插件只轮询 token，不会读取你的密码，也不需要你复制任何地址。</p>
<script>
const status = document.getElementById('status')
let last = ${JSON.stringify(phase ?? '')}
setInterval(async () => {
  try {
    const d = await (await fetch('/status')).json()
    if (d.message && d.phase !== last) { status.textContent = d.message; last = d.phase }
  } catch {}
}, 1500)
</script></body></html>`
}

// ── beginLogin ────────────────────────────────────────────────────────────

/**
 * 登录载体（AGENTS §6）：本函数**立刻**返回 `{ url, result }`，
 * 真正等用户完成的是 `result`（magpie 的 `callback()` 里 await）。
 *
 * `openBrowser` 打开的是 **issuer 的授权页**（网关 302 的目标），本地只留一张
 * 状态页：用户在网页里登录，插件在后台轮询 `deviceToken/poll`。
 * 设备流没有投递入口，所以这里**没有**粘贴框，也不接受任何外部 POST。
 */
export async function beginLogin(openBrowser) {
  const flow = await startDeviceFlow()

  let settleOk
  let settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {}) // 防 unhandledRejection（magpie 未必回调 callback）

  if (!flow.ok) {
    // 起不动流程就没有可轮询的 nonce：把失败直接交给 result（宿主会报出来）
    const failure = new Error(`千问办公（国际版）设备流无法启动：${flow.error}`)
    settleFail(failure)
    return {
      url: AUTHORIZE_URL,
      result,
      cancel: () => {},
      instructions: `设备流入口被拒：${flow.error}`,
    }
  }

  let settled = false
  let server
  let timer
  let pollTimer
  let phase = 'polling'
  let message = '已打开授权页，请在浏览器里完成登录；插件会在后台自动完成。'

  const closeServer = () => new Promise((resolve) => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
  const settle = (ok, value) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    void closeServer()
    ok ? settleOk(value) : settleFail(value)
  }
  const fail = (error) => settle(false, error instanceof Error ? error : new Error(String(error)))
  const setPhase = (p, m) => { phase = p; if (m !== undefined) message = m }

  const complete = async (token) => {
    setPhase('identity', '已拿到 token，正在读取账号信息…')
    const identity = await fetchIdentity(token.access_token)
    if (!identity.ok) debugLog(`qwenwork-intl: ${identity.error}（不影响登录，用渠道显示名兜底）`)
    setPhase('done', '登录成功，可以关闭此页面')
    // machineId 必须与起流程时那一个一致：COSY 的 `Cosy-MachineId` 要用它
    settle(true, { ...token, ...identity.identity, machineId: flow.machineId, channel: CHANNEL_ID })
    return { ok: true }
  }

  const tick = async () => {
    if (settled) return
    const out = await pollDeviceToken({ nonce: flow.nonce, verifier: flow.verifier })
    if (settled) return
    if (out.state === 'granted') { await complete(out.token); return }
    if (out.state === 'error' && out.fatal === true) { fail(new Error(out.message)); return }
    if (out.state === 'error') debugLog(`qwenwork-intl: ${out.message}（继续轮询）`)
    pollTimer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
    pollTimer.unref?.()
  }

  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/' || pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderLoginPage({ authUrl: flow.authorizeUrl, phase, message }))
      return
    }
    if (pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ phase, message }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  timer = setTimeout(() => fail(new Error('千问办公（国际版）登录超时（15 分钟内未完成授权）')), LOGIN_TIMEOUT_MS)
  timer.unref?.()

  // ⚠️ 先挂 'error' 再 listen（EADDRINUSE 是异步事件，不挂会崩进程）。
  //    这一段只等端口绑定（毫秒级），不等用户 —— 契约禁的是后者。
  //    绑不上端口也**不抛**：beginLogin 必须返回，失败只能走 result。
  const port = await new Promise((resolve) => {
    let done = false
    server.once('error', (error) => {
      if (done) return
      done = true
      fail(new Error(`状态页端口无法监听（${error.message}）`))
      resolve(undefined)
    })
    server.listen(0, '127.0.0.1', () => {
      if (done) return
      done = true
      server.unref()
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  if (port === undefined) {
    // 端口没绑上：授权页仍然给用户（登录本身是浏览器那侧的事），只是没有本地状态页
    let opened = false
    if (openBrowser) {
      try {
        openBrowser(flow.authorizeUrl)
        opened = true
      } catch (error) {
        debugLog(`qwenwork-intl: 打开浏览器失败（${error?.message ?? error}），改由宿主打开`)
      }
    }
    return {
      url: flow.authorizeUrl,
      ...(opened ? { opened: true } : {}),
      result,
      cancel: (reason = '千问办公（国际版）登录已取消') => fail(new Error(reason)),
      instructions: `本地状态页无法监听端口，直接在浏览器里完成授权：${flow.authorizeUrl}`,
    }
  }

  // 第一次轮询立刻发（用户可能已经登录过），之后每 POLL_INTERVAL_MS 一次
  pollTimer = setTimeout(() => { void tick() }, 0)
  pollTimer.unref?.()

  const url = `http://127.0.0.1:${port}/login`
  // ⚠️ 插件自己开了浏览器窗口 ⇒ 必须回 `opened: true`，
  //    否则宿主会拿 url 再开一个系统默认浏览器窗口（AGENTS §6、marvis.mjs:2238 同款）。
  //    这里打开的是**授权页**，不是本地状态页 —— 用户要登录的是 qwenwork.ai。
  let opened = false
  if (openBrowser) {
    try {
      openBrowser(flow.authorizeUrl)
      opened = true
    } catch (error) {
      debugLog(`qwenwork-intl: 打开浏览器失败（${error?.message ?? error}），改由宿主打开`)
    }
  }
  return {
    url,
    ...(opened ? { opened: true } : {}),
    result,
    cancel: (reason = '千问办公（国际版）登录已取消') => fail(new Error(reason)),
    instructions: `已打开 qwenwork.ai 授权页，登录完成后插件自动结束；`
      + `若浏览器没打开，手动访问：${flow.authorizeUrl}（状态页：${url}）`,
  }
}

// ── 续期 ──────────────────────────────────────────────────────────────────

/**
 * 用 refresh_token 续期 —— **网关的 deviceToken/refresh，只认包装器对**。
 *
 * 实测（假 token 的形状探针）：包装器对 → `401 INVALID_REFRESH_TOKEN`（形状接受，
 * 只嫌 token 假）；issuer 对 / 混搭 → `400 INVALID_REFRESH_REQUEST`（形状被拒）。
 * 所以这里绝不用 `/auth/oauth/token` 的 `grant_type=refresh_token`。
 *
 * `persist` 只在拿到新 refresh_token（轮换）时被调，写回内存缓存。
 */
export async function refresh(credential, persist) {
  const refreshToken = nonEmpty(credential?.refresh_token) ?? nonEmpty(credential?.refreshToken)
  if (refreshToken === undefined) throw new Error('没有 refresh_token：请重新登录')

  let response
  try {
    response = await fetch(DEVICE_REFRESH_URL, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        refresh_token: refreshToken,
        target: 'c',
        client_id: WRAPPER_CLIENT_ID,
        redirect_uri: WRAPPER_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`续期请求失败：${error?.message ?? error}`)
  }

  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const code = nonEmpty(payload?.errorCode) ?? nonEmpty(payload?.error) ?? nonEmpty(payload?.code)
    const detail = nonEmpty(payload?.message) ?? nonEmpty(payload?.error_description)
    const why = [code, detail].filter((v) => v !== undefined).join(': ') || text.slice(0, 200)
    throw new Error(`续期被拒（HTTP ${response.status}）：${why}`)
  }

  const token = tokenOf(payload)
  if (token === undefined) throw new Error('续期响应里没有 access_token')

  const next = { ...credential, ...token }
  // 设备身份与用户 id 不在续期响应里：`{...credential, ...token}` 已保留，
  // 但显式确认一次 —— 丢了 uid 就打不了 /algo（COSY 的 Cosy-User 就是它）。
  if (nonEmpty(credential?.uid) !== undefined && nonEmpty(next.uid) === undefined) next.uid = credential.uid
  if (nonEmpty(credential?.machineId) !== undefined && nonEmpty(next.machineId) === undefined) {
    next.machineId = credential.machineId
  }

  // 一次性 RT：换了就立刻写回内存，别让并发入口拿旧 RT 去打
  if (token.refresh_token !== undefined && typeof persist === 'function') {
    try {
      persist(next)
    } catch (error) {
      debugLog(`qwenwork-intl: persist 失败（忽略）：${error?.message ?? error}`)
    }
  }
  return next
}

// ── 目录 ──────────────────────────────────────────────────────────────────

/**
 * 从响应里捞出扁平的条目数组：OpenAI 标准 `{object:'list', data:[…]}`、
 * `{models:[…]}`、`{data:{models:[…]}}`、裸数组。都不认就返回空 —— 空不代表
 * 「没有模型」，`catalog` 会再试分组形状，最终退回兜底表。
 */
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.models)) return payload.models
  if (Array.isArray(payload?.data?.models)) return payload.data.models
  return []
}

// 真机实测（含假 token 的匿名签名探针）：真实的 `model/list` 是**分组**形状 ——
// `{chat, assistant, inline, quest, nap, qwork, experts, qwake, app, qcode,
// byok_teams, byok_enterprise}`，每组里才是模型条目（`key`/`display_name`/
// `max_input_tokens`/`context_config`/`is_default`/…）。`rowsOf()` 只认扁平形状，
// 单靠它国际站的目录必然退回兜底表。
//
// 分组条目自带三种可能的外壳（数组、`{models}`、`{items}`/`{list}`/`{data}`），
// 逐层试。`byok_*` 组**跳过**：那几组要用用户自己的第三方 key，列出来用户点了
// 只会 400，属于「列不出来好过列错」的同一类判断。
const GROUP_ENTRY_KEYS = ['models', 'items', 'list', 'data', 'children']

function entriesOfGroup(group) {
  if (Array.isArray(group)) return group
  for (const key of GROUP_ENTRY_KEYS) {
    if (Array.isArray(group?.[key])) return group[key]
  }
  return []
}

function rowsOfGrouped(payload) {
  const root = payload?.data ?? payload?.models ?? payload
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return []
  // 扁平的 `{object:'list', data:[…]}` 已经被 rowsOf 接走，这里只处理「值是组」的形状
  const rows = []
  for (const [groupKey, group] of Object.entries(root)) {
    if (groupKey.startsWith('byok')) continue
    for (const row of entriesOfGroup(group)) {
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
    }
  }
  return rows
}

const contextOf = (row) => {
  for (const key of ['context_window', 'context_length', 'max_context_tokens', 'max_input_tokens']) {
    const n = Number(row?.[key])
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  // 分组形状把上限藏在 `context_config` 里（`{max_input_tokens, …}`）
  for (const key of ['max_input_tokens', 'context_window', 'context_length']) {
    const n = Number(row?.context_config?.[key])
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return undefined
}

const outputOf = (row) => {
  for (const key of ['max_output_tokens', 'max_tokens', 'output_tokens']) {
    const n = Number(row?.[key])
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  for (const key of ['max_output_tokens', 'max_tokens']) {
    const n = Number(row?.context_config?.[key])
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return undefined
}

/**
 * 把响应正文解析成对象。`Encode=1` 的路由上服务端**可能**回编码串（COSY 字母表），
 * 也可能回明文 JSON（匿名探针拿到的是可读 JSON）—— 两条都要认：
 * 先试 JSON.parse，不成就按 COSY 解码再试一次。
 */
function parseMaybeEncoded(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    // 落到下面：按上线形态解一次
  }
  try {
    return JSON.parse(decodeBody(text))
  } catch {
    return undefined
  }
}

/** 远端目录：认不出形状就返回空对象（聚合层随后退回 `fallbackModels`）。 */
export async function catalog(credential) {
  const account = cosyAccountOf(credential)
  // 没有 COSY 身份（老凭据/未登录）→ 直接兜底表，不打必被 401 的请求
  if (account === undefined) return { ...fallbackModels }
  const url = `${API_BASE}${MODELS_PATH}`
  let signed
  try {
    // GET 没有请求体，签名里的 body 就是空串（与匿名探针一致）
    signed = cosyHeaders(url, account, '')
  } catch (error) {
    debugLog(`qwenwork-intl: 造 COSY 头失败（${error?.message ?? error}），退兜底目录`)
    return { ...fallbackModels }
  }
  let response
  try {
    response = await fetch(url, {
      headers: { ...CLIENT_HEADERS, ...signed, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return { ...fallbackModels }
  }
  if (!response.ok) return { ...fallbackModels }
  const payload = parseMaybeEncoded(await response.text().catch(() => ''))
  const models = {}
  // 先认扁平形状；一条都没认出再按分组形状拆（真机目录是分组的，见 rowsOfGrouped）
  const flat = rowsOf(payload)
  const rows = flat.length > 0 ? flat : rowsOfGrouped(payload)
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const id = nonEmpty(row.id) ?? nonEmpty(row.model) ?? nonEmpty(row.key) ?? nonEmpty(row.name)
    if (id === undefined) continue
    const context = contextOf(row)
    const output = outputOf(row)
    models[id] = {
      name: nonEmpty(row.display_name) ?? nonEmpty(row.displayName) ?? id,
      limit: {
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
      },
      tool_call: true,
      capabilities: { temperature: true },
      options: {},
      headers: {},
      status: 'active',
      release_date: '',
    }
  }
  // 远端一条都没认出（形状变了 / 401 / 空目录）→ 用兜底表，宁可少列不编 id
  return Object.keys(models).length > 0 ? models : { ...fallbackModels }
}

// ── chat ──────────────────────────────────────────────────────────────────

/**
 * 补上网关要求的两个业务字段：`request_id` / `session_id`（真机实测：缺 `request_id`
 * → `400 request_id is required`，补上再缺 `session_id` → `400 session_id is required`，
 * 两个都补才有 200 SSE）。
 *
 * 规则：**已有的不覆盖**（宿主/上层可能自己带，或是多轮对话里要复用的 session），
 * 只补缺的。驼峰 `requestId` / `sessionId` 的**值会被搬到 snake_case 上**，而不是
 * 丢掉：值是调用方给的、它靠这个对号，搬过去两边都满足；若只把驼峰当「已有」就
 * 不生成 snake_case，网关只认 snake_case，会照样回 `400 request_id is required`
 * —— 那是纯亏的静默失败。
 *
 * 生成的 uuid 用小写标准形态（`randomUUID()`），snake_case 键名。
 *
 * `session_id` **不是会话记忆**（真机实测：同一 `session_id` 连问两轮、第二轮 messages
 * 里不带历史，它记不住第一轮说的数字；换新 session 结果一样）。上下文只由 `messages`
 * 承载，服务端不按 session 聚合历史 —— 所以每轮生成新 uuid 无害。这两个字段纯粹是
 * 网关的请求标识，缺了就是 400。
 *
 * @param {object} body 宿主给的请求体（OpenAI 形状，通常没有这两个字段）
 * @returns {object} 同一个对象的浅拷贝（不改调用方的对象）
 */
export function withRequestIdentity(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body
  const next = { ...body }
  // 先搬驼峰值（有值才搬，值本身不动），再从缺的里补 uuid。
  if (nonEmpty(next.request_id) === undefined && nonEmpty(next.requestId) !== undefined) {
    next.request_id = next.requestId
  }
  if (nonEmpty(next.request_id) === undefined) next.request_id = randomUUID()
  if (nonEmpty(next.session_id) === undefined && nonEmpty(next.sessionId) !== undefined) {
    next.session_id = next.sessionId
  }
  if (nonEmpty(next.session_id) === undefined) next.session_id = randomUUID()
  return next
}

/**
 * 转发一次对话。
 *
 * 契约（AGENTS §5）：第二参是信封 `{ body, signal }`，请求体在 **`body`** 字段里；
 * **返回原始 Response**（不包装）；错误转成带 `provider_error` 的 Response，不抛；
 * `signal` 原样透传，**不挂硬超时**。
 *
 * 这条路由（`/algo/.../agent_chat_generation`）**只认 COSY 签名**，请求体要按客户端
 * 字母表编码成上线形态（`encodeBody`）。签名与 body 强绑定：发出去的串和签的串不同
 * ⇒ 403 `Signature invalid`（匿名探针复现过）。
 *
 * ⚠️ **经由本函数的端到端仍未跑过**。协议层在真机上已验通（同一份凭据 + COSY 模块
 *    直打网关：目录 200、补上 `request_id`/`session_id` 后 200 SSE、17 个 chunk、
 *    `X-Model-Name: qwen3.8-flash`），但那是绕开本模块的探针，不是这段代码跑出来的
 *    结果。在有人用 `hub-qwenwork-intl` 自己发一条之前，任何「可用」的说法都是假设。
 *    SSE 里的 chunk 是否还要二次解码同样未验证 —— 所以**不碰响应正文**，原样交给
 *    宿主（猜错的解码会把整条流毁掉，而透传至少不会更坏）。
 */
export async function chat(credential, request = {}) {
  if (nonEmpty(credential?.access_token) === undefined) {
    return Response.json(
      { error: { type: 'provider_error', message: '未登录：请先登录千问办公（国际版）' } },
      { status: 401, headers: { 'X-Magpie-Sign-In': 'expired' } },
    )
  }
  const body = request?.body
  if (body === undefined) {
    return Response.json(
      { error: { type: 'provider_error', message: '请求体缺失（契约：chat(credential, { body, signal })）' } },
      { status: 400 },
    )
  }
  const account = cosyAccountOf(credential)
  if (account === undefined) return needsRelogin('缺 uid 或 machineId')

  const url = `${API_BASE}${CHAT_PATH}`
  // 网关要 request_id / session_id（见 withRequestIdentity）；宿主给的可能是对象，
  // 也可能已是 JSON 串（透传场景），两种都要补。
  let prepared = body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      const filled = withRequestIdentity(parsed)
      if (filled !== parsed) prepared = JSON.stringify(filled)
    } catch {
      // 不是 JSON 就原样发：网关自己会回 400，比我们在这里猜格式更准确
    }
  } else {
    prepared = withRequestIdentity(body)
  }
  const json = typeof prepared === 'string' ? prepared : JSON.stringify(prepared)
  const wire = encodeBody(json)
  // 模型键与 stream 从**补完字段的那份**取：body 是 JSON 串时 `body?.model` 恒为
  // undefined（那会让 X-Model-Key 丢失、非流式被按 SSE 回包）。
  const asObject = typeof prepared === 'string'
    ? (() => { try { return JSON.parse(prepared) } catch { return undefined } })()
    : prepared
  const modelKey = nonEmpty(asObject?.model)
  let signed
  try {
    signed = chatHeaders(
      url,
      account,
      wire,
      {},
      {
        ...(modelKey !== undefined ? { key: modelKey } : {}),
        ...(nonEmpty(asObject?.model_source) !== undefined ? { source: asObject.model_source } : {}),
      },
    )
  } catch (error) {
    return Response.json(
      { error: { type: 'provider_error', message: `造 COSY 签名失败：${error?.message ?? error}` } },
      { status: 503 },
    )
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      // chatHeaders 默认给 SSE；非流式请求必须改回 JSON，否则网关按流式回包、宿主解析不到 chat.completion
      headers: {
        ...CLIENT_HEADERS,
        ...signed,
        ...(asObject?.stream === true ? {} : { Accept: 'application/json' }),
      },
      body: wire,
      ...(request?.signal !== undefined ? { signal: request.signal } : {}),
    })
  } catch (error) {
    return Response.json(
      { error: { type: 'provider_error', message: `连不上网关：${error?.message ?? error}` } },
      { status: 503 },
    )
  }

  // 成功：**绝不读 body**（读了流就没了），原样交给宿主
  if (response.ok) return response

  const text = await response.text().catch(() => '')
  // 403 `{"code":"101","message":"Signature invalid"}` 是**我们**的签名错了（body 与
  // 签的串不一致 / 时钟偏了），不是登录态问题 —— 摘号会让用户白重登一次也没用。
  if (/signature\s+invalid/i.test(text) || /"code"\s*:\s*"?101"?/.test(text)) {
    return Response.json(
      {
        error: {
          type: 'upstream_error',
          code: 'signature_invalid',
          message: `COSY 签名被上游拒绝（HTTP ${response.status}）：${text.slice(0, 300)}`
            + '——这是签名/请求体不一致，换账号与重登都无效。',
        },
      },
      { status: 502 },
    )
  }
  if (response.status === 401 || response.status === 403) {
    return Response.json(
      { error: { type: 'provider_error', message: `登录态被拒绝（HTTP ${response.status}）：${text.slice(0, 300)}` } },
      { status: 401, headers: { 'X-Magpie-Sign-In': 'expired' } },
    )
  }
  // 402/429 原样透出：magpie 靠这两个码换号 / 重试
  if (response.status === 402 || response.status === 429) {
    return Response.json(
      { error: { type: 'provider_error', message: `上游返回 HTTP ${response.status}：${text.slice(0, 300)}` } },
      { status: response.status },
    )
  }
  return Response.json(
    { error: { type: 'provider_error', message: `上游返回 HTTP ${response.status}：${text.slice(0, 300)}` } },
    { status: response.status >= 400 ? response.status : 502 },
  )
}

// ── 渠道对象 ──────────────────────────────────────────────────────────────

export const qwenworkIntlChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  fallbackModels,
  beginLogin,
  // 交办单里写的键名是 `login`；聚合层实际认的是 `beginLogin`。两个都给，
  // 语义完全一致（同一函数），免得下游按 `login` 取时拿到 undefined。
  login: beginLogin,
  refresh,
  expired,
  catalog,
  chat,
  /** 国际站没有签到端点 → inactive（绝不用 failed，会把卡片涂红）。 */
  checkin: () => ({ outcome: 'inactive' }),
}