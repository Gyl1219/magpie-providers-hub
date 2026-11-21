// 千问办公国际版（qwenwork.ai）渠道 —— 独立 Ory/OIDC 发行方。
//
// ## 为什么登录必须是「粘贴式」
//
// 国际版客户端走 `native-oauth` + `external-browser`，而**唯一**被注册的
// redirect_uri 是 `https://gateway.qwenwork.ai/oauth/callback` —— 回调落在网关，
// 插件收不到。环回端口与各种 `qwenwork://` 变体一律被 Ory 拒（实测
// "does not match any of the pre-registered redirect urls"）。
//
// 所以只有一条路走得通：插件打开授权页 → 用户在浏览器里登录 → 授权完成后
// 浏览器停在那条深链（`qwenwork://…#code=…` 或 `…/oauth/callback?code=…`）→
// 用户把整条地址粘回插件的本地页 → 插件拿 code 去 issuer 换 token。
//
// ⚠️ 设备码流在这条渠道上不存在：网关 `/device/selectAccounts` 对任何 query 都
//    400 `INVALID_DEVICE_FLOW`（两站对照实测），别再往那个方向试。
//
// ## 常量出处
//
// 全部来自 https://qwenwork.ai/.well-known/openid-configuration 与
// 国际版桌面端 app.asar 的 `auth.browserLoginDeployments` / `GLOBAL_AUTHORITIES`。
// 可复跑：`default-workspace/verify-intl-facts.mjs`（5/5 通过）。
//
// ## COSY 路线复核（2026-11-21，匿名实测：只用假 token，不发真凭据）
//
// 结论一句话：**chat/catalog 走 `/algo/*` + COSY 签名，`/api/v1/*` 不是这条路。**
//
// · `/api/v1/*` 只认 `Bearer <token>`：把完整 COSY 信封打过去仍是
//   401 `User not authenticated`（models / chat / userinfo 三条都试过）。
// · 真实路由（来自国际版 asar 与上游 0.3.0 intl 实现）：
//   - 目录 `GET /algo/api/v2/model/list?Encode=1`
//   - 对话 `POST /algo/api/v2/service/pro/sse/agent_chat_generation
//     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`（SSE）
// · 签名可以完全离线复现（公钥是 asar 里的公开常量，1024-bit）：
//   `Authorization: Bearer COSY.<base64 payload>.<sig>`，
//   `sig = md5(payload + "\n" + Cosy-Key + "\n" + ts + "\n" + wireBody + "\n" + path)`，
//   path 去掉 `/algo` 前缀；payload 里是 AES-128-CBC 加密的用户信息，
//   `Cosy-Key` 是用 RSA 公钥包的 AES 密钥。
// · 实测证据（假 token，`Cosy-User` 也是假的）：
//   - 签名正确 → `model/list` **200 + 完整模型目录**（分组形状，见下）；
//   - 签名里把 path 写错 → 403 `{"code":"101","message":"Signature invalid"}`；
//   - chat 用「故意签名不一致」作对照 → 200 SSE 里回 `101 Signature invalid`；
//     签名一致时进到 token 校验（假 token → 500），说明签名这关已过。
// · 目录真实形状是**分组**的：`{chat, assistant, inline, quest, nap, qwork,
//   experts, qwake, app, qcode, byok_teams, byok_enterprise}`，每项
//   `key`/`display_name`/`max_input_tokens`/`is_default`/`is_reasoning`/
//   `price_factor`/`context_config`。`rowsOfGrouped()` 已按此形状实现
//   （`byok_*` 组跳过：要用用户自己的第三方 key，列出来点了只会 400）。
// · chat 的请求体还要按客户端字母表编码（`swapThirds(segmentEncode(json))`），
//   并带 `X-Model-Key`/`X-Model-Source`、`Accept: text/event-stream`。
//
// 本文件的 `catalog`/`chat` 已按上面的实测迁到 `/algo/*` + COSY 签名
// （签名实现见 `./qwenwork-intl-cosy.mjs`）。
//
// ## 未验证（不许当成已完成）
//
// · 端到端真登录：只验到「授权页接受 client/redirect/scope/PKCE」（302 → /signin），
//   没有走过一次真实换 token。
// · `refresh_token` 能否给这个 client 换新 token：未实测（走标准 OAuth 端点）。
// · COSY 签名之外还要求 `Cosy-User` 与 token 所属 uid 一致 —— 没有真账号，
//   只能验到「签名通过」这一关。
// · **真机一条对话都没发过**：路由、签名、body 编码都只到「匿名探针验到签名这关
//   过了」为止，没有任何一次带真 token 的成功响应。真机跑通前不许声称可用。
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

// ── 端点（OIDC discovery 实测）─────────────────────────────────────────────

const ISSUER = 'https://qwenwork.ai'
const AUTHORIZE_URL = `${ISSUER}/oauth2/auth`
const TOKEN_URL = `${ISSUER}/auth/oauth/token` // `/oauth2/token` 是 404
const USERINFO_URL = `${ISSUER}/user/info`
const CLIENT_ID = 'qwenwork-desktop-app' // 在 .ai 上有效；`wukong` 是 invalid_client
const REDIRECT_URI = 'https://gateway.qwenwork.ai/oauth/callback' // 唯一被接受的
const SCOPE = 'openid profile email offline_access qwen_work'

/** 模型/API 主机（app.asar `GLOBAL_AUTHORITIES.qwenwork-global-prod`）。 */
const API_BASE = 'https://openapi.qoder.sh'
// 真实路径都在 /algo/* 且必须带 COSY 签名（见文件头「COSY 路线复核」）：
// `/api/v1/*` 只认 Bearer，把完整签名信封打过去仍是 401 `User not authenticated`。
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

// ── PKCE ──────────────────────────────────────────────────────────────────

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
 * Ory 拒短 state（实测 "state is missing or does not have enough characters"）。
 * `state`/`nonce` 用 dashed UUID，与上游一致。
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

// ── 粘贴串解析 ────────────────────────────────────────────────────────────

/**
 * 从用户粘回来的那一整条里取出 `code` / `state`。
 *
 * 实测可能出现的三种形态（都要认）：
 *   1. `qwenwork://oauth/callback?code=…&state=…`
 *   2. `https://gateway.qwenwork.ai/oauth/callback?code=…&state=…`
 *   3. 只贴了一串裸 code（没有 `?`）—— 当成 code 本身
 *
 * @returns {{ code?: string, state?: string, error?: string }}
 */
export function parsePasted(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return { error: '粘贴内容为空' }
  // 深链 / http(s) / 裸 code：URL 解析对 scheme 不敏感，统一按「?后面」取参
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) {
    // 裸 code：只接受看起来像 code 的串（避免用户把整段说明文字贴进来）
    if (/^[\w.:-]{8,}$/.test(raw)) return { code: raw }
    return { error: '这段里没有找到 ?code=（请粘贴浏览器地址栏的完整地址）' }
  }
  const params = new URLSearchParams(raw.slice(queryStart + 1))
  const errorCode = params.get('error')
  if (errorCode !== null && errorCode !== '') {
    const description = params.get('error_description') ?? ''
    return { error: `授权被拒绝：${errorCode}${description === '' ? '' : `（${description}）`}` }
  }
  const code = nonEmpty(params.get('code'))
  if (code === undefined) return { error: '这条回调里没有 code（授权可能没完成，或复制的是旧地址）' }
  return { code, state: nonEmpty(params.get('state')) }
}

// ── 换 token / 读身份 ─────────────────────────────────────────────────────

/**
 * 用一次性 code 换 token。失败一律返回 `{ ok:false, error }`，不抛 ——
 * 登录页要能把原因原样显示给用户。
 */
export async function exchangeCode({ code, verifier, redirectUri = REDIRECT_URI, clientId = CLIENT_ID, signal } = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  })
  let response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: signal ?? AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, error: `换 token 请求失败：${error?.message ?? error}` }
  }
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const code = nonEmpty(payload?.error)
    const why = nonEmpty(payload?.error_description)
    const detail = code !== undefined && why !== undefined
      ? `${code}: ${why}`
      : (code ?? why ?? text.slice(0, 200))
    return { ok: false, error: `换 token 被拒（HTTP ${response.status}）：${detail}` }
  }
  const accessToken = nonEmpty(payload?.access_token)
  if (accessToken === undefined) return { ok: false, error: '换 token 的响应里没有 access_token' }
  return {
    ok: true,
    token: {
      access_token: accessToken,
      ...(nonEmpty(payload?.refresh_token) !== undefined ? { refresh_token: payload.refresh_token } : {}),
      ...(nonEmpty(payload?.id_token) !== undefined ? { id_token: payload.id_token } : {}),
      ...(nonEmpty(payload?.token_type) !== undefined ? { token_type: payload.token_type } : {}),
      ...(Number.isFinite(payload?.expires_in) ? { expires_at: Date.now() + payload.expires_in * 1000 } : {}),
      ...(nonEmpty(payload?.scope) !== undefined ? { scope: payload.scope } : {}),
    },
  }
}

/**
 * 读身份（`/user/info`）。只取**稳定且人可读**的字段当账号显示名；
 * 拿不到就返回空对象 —— 聚合层会退化成渠道显示名（AGENTS §6 已有兜底）。
 */
export async function fetchIdentity(accessToken, { signal } = {}) {
  let response
  try {
    response = await fetch(USERINFO_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: signal ?? AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, error: `读用户信息失败：${error?.message ?? error}` }
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
  // 常见 claim / 业务字段名，逐个试；都没有就不写（宁可少，不编）
  const nickname = nonEmpty(user.name) ?? nonEmpty(user.preferred_username) ?? nonEmpty(user.nickname)
  const email = nonEmpty(user.email)
  // 上游拿不到 uid 就报「the sign-in named no user」——因为它的 COSY 请求头要
  // `Cosy-User: uid`。这里不因此判登录失败（用户还能看到账号名），但把 uid
  // 单独留在凭据上，供以后接签名对话时用。
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

// ── 登录页（本地回环；两步都在同一个页面里）──────────────────────────────

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function renderLoginPage({ authUrl, phase, message, state }) {
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
label{display:block;margin:16px 0 6px;font-size:13px;color:#aaa}
textarea{width:100%;height:88px;padding:10px;box-sizing:border-box;border:1px solid #333;border-radius:6px;
         background:#0d0d0d;color:#eee;font-family:ui-monospace,Consolas,monospace;font-size:12px}
button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:6px;background:#22c55e;
       color:#06210f;font-size:15px;font-weight:600;cursor:pointer}
#status{margin:14px 0;font-size:13px;min-height:20px;color:#9ca3af}
.hint{font-size:12px;color:#777;line-height:1.7}
</style></head><body>
<h2>登录千问办公（国际版）</h2>
<ol>
  <li>点下面的按钮打开授权页，在页面里完成登录。</li>
  <li>登录完成后浏览器会停在一个 <code>qwenwork://…</code> 深链或
      <code>gateway.qwenwork.ai/oauth/callback?code=…</code> 地址上。</li>
  <li>把 <strong>地址栏那一整条</strong> 复制下来，粘贴到下面的框里，点提交。</li>
</ol>
<a class="btn" href="${escapeHtml(authUrl)}" target="_blank" rel="noreferrer">① 打开授权页</a>
<label for="paste">② 粘贴回调地址（含 code）</label>
<textarea id="paste" data-state="${escapeHtml(state ?? '')}" placeholder="qwenwork://oauth/callback?code=…&state=…"></textarea>
<button id="submit">提交</button>
<div id="status">${escapeHtml(message ?? '')}</div>
<p class="hint">这条 code 是一次性的，用一次就失效，不是密码；插件只把它换成 token，
不会保存你粘贴的原文。</p>
<script>
const status = document.getElementById('status')
document.getElementById('submit').onclick = async () => {
  const raw = document.getElementById('paste').value.trim()
  if (!raw) { status.textContent = '请先粘贴回调地址'; return }
  status.textContent = '正在换取 token…'
  try {
    const res = await fetch('/paste', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    })
    const data = await res.json()
    status.textContent = data.ok ? '登录成功，可以关闭此页面了' : ('失败：' + (data.message ?? '未知原因'))
  } catch (e) { status.textContent = '失败：' + e.message }
}
// 阶段轮询：后台换 token 的进度也显示出来
setInterval(async () => {
  try {
    const r = await fetch('/status'); const d = await r.json()
    if (d.message && d.phase !== '${escapeHtml(phase ?? '')}') { status.textContent = d.message }
  } catch {}
}, 1500)
</script></body></html>`
}

// ── beginLogin ────────────────────────────────────────────────────────────

/**
 * 登录载体（AGENTS §6）：本函数**立刻**返回 `{ url, result }`，
 * 真正等用户完成的是 `result`（magpie 的 `callback()` 里 await）。
 *
 * `openBrowser` 打开的是**本地页**：授权页与粘贴框在同一屏，用户不用在两个
 * 窗口之间找。本地只绑 127.0.0.1，不接受任何外部投递（粘贴必须发生在本地页）。
 */
export async function beginLogin(openBrowser) {
  const pkce = createPkce()
  const state = randomUUID() // 上游 intlSignIn 的 state 也是 randomUUID()；Ory 拒短 state
  const authUrl = buildAuthorizeUrl({ state, challenge: pkce.challenge })

  let settleOk
  let settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {}) // 防 unhandledRejection（magpie 未必回调 callback）

  let settled = false
  let server
  let timer
  let phase = 'waiting'
  let message = '请按页面上的两步操作：先打开授权页登录，再把回调地址粘回来。'

  const closeServer = () => new Promise((resolve) => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
  const settle = (ok, value) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    void closeServer()
    ok ? settleOk(value) : settleFail(value)
  }
  const fail = (error) => settle(false, error instanceof Error ? error : new Error(String(error)))
  const setPhase = (p, m) => { phase = p; if (m !== undefined) message = m }

  /** 粘贴 → 校验 state → 换 token → 读身份。 */
  const completeFromPasted = async (raw) => {
    const parsed = parsePasted(raw)
    if (parsed.error !== undefined) return { ok: false, message: parsed.error }
    // state 有就必须对上（防别的本地进程投一个别人的 code）；没有则放行并记一笔
    if (parsed.state !== undefined && parsed.state !== state) {
      debugLog(`qwenwork-intl: 粘贴的 state 不匹配（收到 ${parsed.state.slice(0, 8)}…）`)
      return { ok: false, message: 'state 不匹配（这条回调不是本次登录发起的），请重新登录一次' }
    }
    if (parsed.state === undefined) debugLog('qwenwork-intl: 粘贴串里没有 state，按无校验放行')

    setPhase('exchanging', '正在用 code 换 token…')
    const exchanged = await exchangeCode({ code: parsed.code, verifier: pkce.verifier })
    if (!exchanged.ok) {
      setPhase('waiting', `换取失败：${exchanged.error}`)
      return { ok: false, message: exchanged.error }
    }
    setPhase('identity', '已拿到 token，正在读取账号信息…')
    const identity = await fetchIdentity(exchanged.token.access_token)
    if (!identity.ok) debugLog(`qwenwork-intl: ${identity.error}（不影响登录，用渠道显示名兜底）`)

    setPhase('done', '登录成功，可以关闭此页面')
    // machineId 与上游 intlSignIn 同口径（randomUUID）：接 COSY 签名对话时要用它
    settle(true, { ...exchanged.token, ...identity.identity, machineId: randomUUID(), channel: CHANNEL_ID })
    return { ok: true }
  }

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      if (pathname === '/' || pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage({ authUrl, phase, message, state }))
        return
      }
      if (pathname === '/status') return sendJson(200, { phase, message })
      if (pathname === '/paste' && req.method === 'POST') {
        const body = await new Response(req).json().catch(() => ({}))
        const outcome = await completeFromPasted(String(body.raw ?? ''))
        return sendJson(200, outcome)
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
      sendJson(200, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })

  timer = setTimeout(() => fail(new Error('千问办公（国际版）登录超时（15 分钟内未完成粘贴）')), LOGIN_TIMEOUT_MS)
  timer.unref?.()

  // ⚠️ 先挂 'error' 再 listen（EADDRINUSE 是异步事件，不挂会崩进程）。
  //    这一段只等端口绑定（毫秒级），不等用户 —— 契约禁的是后者。
  const port = await new Promise((resolve, reject) => {
    let done = false
    server.once('error', (error) => { if (!done) { done = true; reject(error) } })
    server.listen(0, '127.0.0.1', () => {
      done = true
      server.unref()
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    fail(new Error(`回调端口无法监听（${error.message}）`))
    throw error
  })

  const url = `http://127.0.0.1:${port}/login`
  // ⚠️ 插件自己开了浏览器窗口（本地页）⇒ 必须回 `opened: true`，
  //    否则宿主会拿 url 再开一个系统默认浏览器窗口（AGENTS §6、marvis.mjs:2238 同款）。
  let opened = false
  if (openBrowser) {
    try {
      openBrowser(url)
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
    instructions: `在打开的页面里点「打开授权页」登录 qwenwork.ai，登录后把浏览器地址栏那条`
      + `（qwenwork://… 或含 ?code=…）复制回来粘到页面上。手动打开：${url}`,
  }
}

// ── 续期 ──────────────────────────────────────────────────────────────────

/**
 * 用 refresh_token 换新 token。
 *
 * ⚠️ **未实测**能否给这个 client 换（见文件头）。所以失败信息要如实，
 *    并且不把它当成「账号已死」—— 由聚合层的软续期吞掉、401 那条路兜底。
 * `persist` 只在拿到新 refresh_token（轮换）时被调，写回内存缓存。
 */
export async function refresh(credential, persist) {
  const refreshToken = nonEmpty(credential?.refresh_token)
  if (refreshToken === undefined) throw new Error('没有 refresh_token：请重新登录')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const detail = payload?.error_description ?? payload?.error ?? text.slice(0, 200)
    throw new Error(`续期被拒（HTTP ${response.status}）：${detail}`)
  }
  const accessToken = nonEmpty(payload?.access_token)
  if (accessToken === undefined) throw new Error('续期响应里没有 access_token')
  const next = {
    ...credential,
    access_token: accessToken,
    ...(nonEmpty(payload?.refresh_token) !== undefined ? { refresh_token: payload.refresh_token } : {}),
    ...(Number.isFinite(payload?.expires_in) ? { expires_at: Date.now() + payload.expires_in * 1000 } : {}),
  }
  // 一次性 RT：换了就立刻写回内存，别让并发入口拿旧 RT 去打
  if (nonEmpty(payload?.refresh_token) !== undefined && typeof persist === 'function') {
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
 * ⚠️ 这条渠道的 chat **没有真机验证过**：签名这关用假 token 过了（进到 token 校验），
 *    但没有任何一次带真 token 的成功对话。在有人真机发一条之前，任何「可用」的说法
 *    都是假设。SSE 里的 chunk 是否还要二次解码同样未验证 —— 所以**不碰响应正文**，
 *    原样交给宿主（猜错的解码会把整条流毁掉，而透传至少不会更坏）。
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
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  const wire = encodeBody(json)
  const modelKey = nonEmpty(body?.model)
  let signed
  try {
    signed = chatHeaders(
      url,
      account,
      wire,
      {},
      {
        ...(modelKey !== undefined ? { key: modelKey } : {}),
        ...(nonEmpty(body?.model_source) !== undefined ? { source: body.model_source } : {}),
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
        ...(body?.stream === true ? {} : { Accept: 'application/json' }),
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
