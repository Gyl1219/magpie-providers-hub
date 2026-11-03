// Loomy（讯飞）渠道实现 —— 移植自 DSH `loomy.ts` / `loomy-sign.ts` /
// `loomy-oauth.ts` / `loomy-product.ts` / `loomy-credits.ts` / `loomy-adapter.ts`。
//
// ## 协议总览（全部 DSH 真机实测）
//
// ```
// 业务基址  https://loomyad.xunfei.cn/api/v1
//   POST /chat/completions        认证：Authorization Bearer + token 双头
//   GET  /models                  认证：只认小写 token 头
//   GET  /points/records          只读余额（两池：永久 balance + 每日 dailyBalance）
//   POST /points/first-login      每日额度签到（幂等判据 alreadyProcessed）
// 账号基址  https://account.xfinfr.com（HMAC-SHA1 签名，Authorization: account {ak}:{sig}）
//   POST /login/phone/sendMsgCode → { base, param:{ ccode, phone, expire:300 } }
//   POST /login/phone/checkCode   → { base, param:{ ccode, phone, mcode, msgid, expire:1209600 } }
//   POST /login/thirdAccount/bind/auth     微信 code 换 rcode（{tcode:{code},type:'wx'}）
//   POST /login/thirdAccount/bind/sendMsg  绑定手机号发码（{rcode,phone,ccode,expire}）
//   POST /login/thirdAccount/bind/checkCode 验码完成绑定+登录（{rcode,mcode,msgid,expire}）
//   POST /login/thirdAccount/bind/skip     已绑手机号时跳过绑定直接换 session
// ```
//
// ## 四个必须记住的坑（loomy.ts 文件头实测）
//
// 1. **两套认证头**：chat 只认 `Authorization: Bearer`；models/points 只认
//    小写 `token`。带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。
//    chat 两个都发（官方客户端同款）。
// 2. **业务失败恒 HTTP 200**：成败只能读 body 的 `code`（'000000' = OK，
//    '100002' = 登录失效 → 不重试、提示重登）。
// 3. **没有 refresh 端点**：session 登录时声明 14 天，过期只能重新登录。
// 4. **短信登录是三步表单流**（无 URL 可开）：sendMsgCode → msgid →
//    checkCode(session)。msgid 必须原样带回。
//
// ## 登录方式（#614 差异：微信扫码为独有，绿标 opencode-loomy-auth 没有）
//
// 本地页双路并存：**微信扫码**（二维码 + 长轮询 + 可选绑手机号）与 **短信验证码**。
// 微信流程：开放平台 OAuth 页取 uuid（redirect_uri 写死官方地址，只用于取 uuid，
// 回调页实测 404 不参与）→ 二维码 data URL → 长轮询（405=确认带 wx_code）→
// bind/auth 换 rcode → 已绑手机号走 skip 直接换 session，未绑走短信绑定。

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

export const CHANNEL_ID = 'loomy'
export const DISPLAY_NAME = 'Loomy (讯飞)'

const API_BASE = 'https://loomyad.xunfei.cn/api/v1'
const ACCOUNT_BASE = 'https://account.xfinfr.com'

const OK_CODE = '000000'
const AUTH_ERROR_CODE = '100002'
const REQUEST_TIMEOUT_MS = 60_000
const SMS_CODE_TTL_SECONDS = 300
/** 登录会话 14 天（登录请求里向服务端声明的 expire）。 */
const SESSION_TTL_SECONDS = 1_209_600

// 讯飞账号 AccessKey（客户端 .env.prod 随包分发 + AES 混淆，本质公开；
// 只用于账号端点的 HMAC 签名，与用户数据无关）。导出供测试重算签名。
export const ACCESS_KEY_ID = '2thryby66wxi53sk'
export const ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r'
const APP_ID = 'GM3LOOMY'

// ── 讯飞账号 HMAC-SHA1 签名（逐字移植 loomy-sign.ts）─────────────────────
//
// 签名串 9 段 \n 连接：METHOD / ESCAPED_PATH / ESCAPED_QUERY / Content-MD5 /
// Content-Type / Date / Nonce / SignedHeaders(空) / CanonicalizedHeaders(空)
// —— 后两段空串使串以 \n\n 结尾，不要「顺手」去掉尾随换行。
// RFC3986 转义 = encodeURIComponent + 补转 ! ' ( ) *。

const escapeRfc3986 = (value) => encodeURIComponent(value)
  .replace(/!/g, '%21').replace(/'/g, '%27')
  .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A')

const contentMd5 = (body) => (body.length === 0 ? '' : createHash('md5').update(body, 'utf8').digest('base64'))

function buildEscapedPath(rawPath) {
  let clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1)
  return clean.split('/').map((seg) => (seg.length > 0 ? escapeRfc3986(seg) : '')).join('/')
}

function buildEscapedQuery(queryParams) {
  if (queryParams === undefined) return ''
  const entries = Object.entries(queryParams)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${escapeRfc3986(key)}=${value === null || value === undefined ? '' : escapeRfc3986(String(value))}`)
    .join('&')
}

/**
 * 账号端点请求头。⚠️ body 必须与签名用的是**同一个字符串**（二次序列化即失效）。
 * `date`/`nonce` 可注入（测试用固定值锁死拼串）；缺省时现生成（与客户端一致）。
 */
export function loomyAuthHeaders({ path, queryParams, body, contentType = 'application/json', date, nonce }) {
  const finalDate = date ?? new Date().toUTCString()
  const finalNonce = nonce ?? randomUUID()
  const stringToSign = [
    'POST',
    buildEscapedPath(path),
    buildEscapedQuery(queryParams),
    contentMd5(body),
    contentType,
    finalDate,
    finalNonce,
    '',
    '',
  ].join('\n')
  const signature = createHmac('sha1', ACCESS_KEY_SECRET).update(stringToSign, 'utf8').digest('base64')
  const headers = {
    Authorization: `account ${ACCESS_KEY_ID}:${signature}`,
    Date: finalDate,
    Nonce: finalNonce,
    'Content-Type': contentType,
  }
  const md5 = contentMd5(body)
  if (md5.length > 0) headers['Content-MD5'] = md5
  return headers
}

// ── 业务信封 ────────────────────────────────────────────────────────────

/** ⚠️ Loomy 的业务失败恒 HTTP 200，成败只能读 body 的 code。 */
function parseEnvelope(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: '', message: '响应不是 JSON 对象', data: undefined }
  }
  const code = typeof payload.code === 'string' ? payload.code : ''
  const message = typeof payload.desc === 'string' && payload.desc.length > 0
    ? payload.desc
    : (typeof payload.message === 'string' ? payload.message : '')
  if (code !== OK_CODE) {
    return { ok: false, code, message: message.length > 0 ? message : `业务错误 ${code || '(缺少 code)'}`, data: undefined }
  }
  return { ok: true, code, message, data: payload.data }
}

// ── 账号端点请求（body 序列化一次、签名与发送共用 —— 签名能通过的前提）────

function buildAccountBody(param) {
  return {
    base: {
      appid: APP_ID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      // ⚠️ 硬编码 macOS：客户端在 Windows 上发的也是这个值，照抄不要改。
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: randomUUID().replace(/-/g, ''),
    },
    param,
  }
}

async function postAccount(path, param) {
  const serialized = JSON.stringify(buildAccountBody(param))
  const headers = loomyAuthHeaders({ path, body: serialized })
  const response = await fetch(`${ACCOUNT_BASE}${path}`, {
    method: 'POST', headers, body: serialized,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`讯飞账号响应不是 JSON（${path}，HTTP ${response.status}）`)
  }
  const envelope = parseEnvelope(parsed)
  if (!envelope.ok) throw new Error(envelope.message)
  return envelope.data
}

// ── 登录一：短信三步（账号端点，HMAC 签名）────────────────────────────────

async function sendSmsCode(phone) {
  const data = await postAccount('/login/phone/sendMsgCode', { ccode: '86', phone, expire: SMS_CODE_TTL_SECONDS })
  const msgid = typeof data?.msgid === 'string' ? data.msgid : ''
  // ⚠️ 不返回空串：上层会拿它去登录，服务端报「msgid 无效」，与真实原因无关
  if (msgid.length === 0) throw new Error('短信验证码响应缺少 msgid')
  return msgid
}

async function loginBySmsCode(phone, code, msgid) {
  const data = await postAccount('/login/phone/checkCode', {
    ccode: '86', phone, mcode: code, msgid, expire: SESSION_TTL_SECONDS,
  })
  const session = typeof data?.session === 'string' ? data.session : ''
  const userid = typeof data?.userid === 'string' ? data.userid : ''
  if (session.length === 0) throw new Error('登录响应缺少 session')
  if (userid.length === 0) throw new Error('登录响应缺少 userid')
  return { session, userid }
}

// ── 登录二：微信扫码（移植 loomy-wechat.ts）──────────────────────────────

const WECHAT_OPEN_BASE = 'https://open.weixin.qq.com'
const WECHAT_LONG_POLL_BASE = 'https://long.open.weixin.qq.com'
/** 微信开放平台的 appid（讯飞 Loomy 官方客户端同款，写死）。 */
export const LOOMY_WECHAT_APP_ID = 'wx18d60be432287cf8'
/** 微信 OAuth 回调地址 —— 微信校验域名白名单，必须写死官方地址；只用于取 uuid。 */
export const LOOMY_WECHAT_REDIRECT_URI = 'https://loomy.xunfei.cn/oauth/wechat/callback'
const WECHAT_POLL_TIMEOUT_MS = 40_000
/** 长轮询要求客户端 UA（默认 UA 实测也会过，但照抄官方同款最稳）。 */
const WECHAT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 长轮询状态（移植 LOOMY_WECHAT_POLL_STATUS）。 */
export const LOOMY_WECHAT_POLL_STATUS = Object.freeze({
  waiting: 'waiting',
  scanned: 'scanned',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  expired: 'expired',
  error: 'error',
})

/** 拼微信授权页 URL（state 任意；只用于**取 uuid**，回调页不参与）。 */
export function buildLoomyWechatAuthUrl(state) {
  const query = new URLSearchParams({
    appid: LOOMY_WECHAT_APP_ID,
    scope: 'snsapi_login',
    redirect_uri: LOOMY_WECHAT_REDIRECT_URI,
    state,
    login_type: 'jssdk',
    self_redirect: 'default',
  })
  return `${WECHAT_OPEN_BASE}/connect/qrconnect?${query.toString()}`
}

/** 从授权页 HTML 里提取二维码 uuid（两个来源任一命中即可）。 */
export function extractLoomyWechatUuid(html) {
  const fromImg = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/)
  if (fromImg !== null && String(fromImg[1] ?? '').length > 0) return String(fromImg[1])
  const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/)
  if (fromPoll !== null) {
    const candidate = String(fromPoll[1] ?? '')
    if (candidate.length > 0) return candidate
  }
  return undefined
}

/** 二维码图片地址。 */
export function buildLoomyWechatQrImageUrl(uuid) {
  return `${WECHAT_OPEN_BASE}/connect/qrcode/${encodeURIComponent(uuid)}`
}

/** 拉授权页并提取 uuid。 */
export async function fetchLoomyWechatUuid(state, fetcher = fetch) {
  const authUrl = buildLoomyWechatAuthUrl(state)
  const response = await fetcher(authUrl, {
    headers: { 'User-Agent': WECHAT_UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`微信授权页拉取失败：HTTP ${response.status}`)
  const html = await response.text()
  const uuid = extractLoomyWechatUuid(html)
  if (uuid === undefined || uuid === '') throw new Error('微信授权页未包含二维码 uuid（页面结构可能变化）')
  return uuid
}

/** 下载二维码图片并转成 data URL（实测 JPEG ~47KB）。 */
export async function fetchLoomyWechatQrImage(uuid, fetcher = fetch) {
  const url = buildLoomyWechatQrImageUrl(uuid)
  const response = await fetcher(url, {
    headers: { 'User-Agent': WECHAT_UA, Referer: buildLoomyWechatAuthUrl('') },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`二维码图片拉取失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

/**
 * 长轮询一次。状态机（官方 JS 同款判据）：
 *   405 = 已确认（带 wx_code）；404 = 已扫待确认；403 = 取消；
 *   402 = 二维码失效；408 与未知 = 继续等。网络异常归 error 不抛。
 */
export async function pollLoomyWechatOnce(uuid, lastErrcode, fetcher = fetch) {
  const query = `uuid=${encodeURIComponent(uuid)}`
    + (lastErrcode.length > 0 ? `&last=${encodeURIComponent(lastErrcode)}` : '')
    + `&_=${Date.now()}`
  const url = `${WECHAT_LONG_POLL_BASE}/connect/l/qrconnect?${query}`

  let body
  try {
    const response = await fetcher(url, {
      headers: { 'User-Agent': WECHAT_UA, Referer: buildLoomyWechatAuthUrl('') },
      signal: AbortSignal.timeout(WECHAT_POLL_TIMEOUT_MS),
    })
    body = await response.text()
  } catch (error) {
    // 网络异常归 error 状态（**不抛**）：长轮询偶发失败不该终止整个流程。
    return { status: LOOMY_WECHAT_POLL_STATUS.error, code: '', errcode: error instanceof Error ? error.message : 'network' }
  }

  const errcode = (body.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? ''
  const code = (body.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? ''

  // ⚠️ 405 = 已确认（官方 JS 在此分支用 wx_code 拼回调 URL）。
  if (errcode === '405') {
    return code.length > 0
      ? { status: LOOMY_WECHAT_POLL_STATUS.confirmed, code, errcode }
      // 405 却没带 code：异常形态。保守判 scanned（继续轮询），绝不拿空 code 换 session。
      : { status: LOOMY_WECHAT_POLL_STATUS.scanned, code: '', errcode }
  }
  if (errcode === '404') return { status: LOOMY_WECHAT_POLL_STATUS.scanned, code: '', errcode }
  if (errcode === '403') return { status: LOOMY_WECHAT_POLL_STATUS.cancelled, code: '', errcode }
  if (errcode === '402') return { status: LOOMY_WECHAT_POLL_STATUS.expired, code: '', errcode }
  return { status: LOOMY_WECHAT_POLL_STATUS.waiting, code: '', errcode }
}

// ── 登录三：微信 code 换会话（移植 loomy-oauth.ts 的绑定四步）────────────

/**
 * 第 1 步：微信 code 换 rcode，并得知是否已绑手机号。
 * `bind` 缺失时归 0（走绑定流程）：保守方向 —— 已绑最多多填一次手机号，
 * 未绑却跳过会拿到没有手机号的账号。
 */
async function bindThirdAccount(code) {
  const data = await postAccount('/login/thirdAccount/bind/auth', { tcode: { code }, type: 'wx' })
  const rcode = typeof data?.rcode === 'string' ? data.rcode : ''
  if (rcode.length === 0) throw new Error('微信授权响应缺少 rcode')
  const bind = data?.bind === 1 ? 1 : 0
  return {
    bind,
    rcode,
    ...(typeof data?.nickname === 'string' && data.nickname.length > 0 ? { nickname: data.nickname } : {}),
  }
}

/** 第 2 步：向待绑定的手机号下发验证码（返回 msgid，第 3 步原样带回）。 */
async function bindSendMsg(rcode, phone) {
  const data = await postAccount('/login/thirdAccount/bind/sendMsg', { rcode, phone, ccode: '86', expire: SMS_CODE_TTL_SECONDS })
  const msgid = typeof data?.msgid === 'string' ? data.msgid : ''
  if (msgid.length === 0) throw new Error('绑定手机号响应缺少 msgid')
  return msgid
}

/** 第 3 步：验证短信验证码，通过即完成绑定 + 登录（返回 session/userid/phone）。 */
async function bindCheckCode(rcode, mcode, msgid) {
  const data = await postAccount('/login/thirdAccount/bind/checkCode', { rcode, mcode, msgid, expire: SESSION_TTL_SECONDS })
  const session = typeof data?.session === 'string' ? data.session : ''
  const userid = typeof data?.userid === 'string' ? data.userid : ''
  const phone = typeof data?.phone === 'string' ? data.phone : ''
  if (session.length === 0) throw new Error('绑定登录响应缺少 session')
  if (userid.length === 0) throw new Error('绑定登录响应缺少 userid')
  return { session, userid, phone }
}

/** 第 4 步（bind===1 时走）：跳过绑定直接换 session。 */
async function bindSkip(rcode) {
  const data = await postAccount('/login/thirdAccount/bind/skip', { rcode, expire: SESSION_TTL_SECONDS })
  const session = typeof data?.session === 'string' ? data.session : ''
  const userid = typeof data?.userid === 'string' ? data.userid : ''
  if (session.length === 0) throw new Error('微信登录响应缺少 session')
  if (userid.length === 0) throw new Error('微信登录响应缺少 userid')
  return { session, userid }
}

// ── 目录（GET /models，token 头）────────────────────────────────────────

/** 查表键：小写去空白（两张能力覆盖表唯一的查表口径）。 */
const catalogKey = (modelId) => String(modelId ?? '').trim().toLowerCase()

/**
 * spark-x 远端虚报 1048576，官方客户端本地表与上游墙位都是 262144
 * （issue IKJW31：越墙 = 0 输出 + max-tokens 且不自动重试）。
 */
const CONTEXT_OVERRIDES = { 'spark-x': 262_144 }
/** 远端声明纯文本但实测能读图的模型（input_modalities 漏报，真机颜色测试）。 */
const IMAGE_OVERRIDES = new Set(['qwen-3.8-max'])
/** 全部 chat 模型同一份档位（真机采集），默认档 DSH 取 high（不采信远端的 low）。 */
const LOOMY_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']
const LOOMY_DEFAULT_EFFORT = 'high'

/** 倍率藏在 name 末尾括号里（三种括号风格混用）或已规范化的 ` · x{n}`。 */
function splitRate(rawName) {
  const original = String(rawName ?? '').trim()
  if (original.length === 0) return { name: '', rate: '' }
  const bracketed = original.match(/^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$/i)
  if (bracketed !== null) {
    const name = String(bracketed[1] ?? '').trim()
    const rate = String(bracketed[2] ?? '').replace(/\s+/g, '').toLowerCase()
    if (name.length > 0) return { name, rate }
    return { name: original, rate: '' }
  }
  const normalized = original.match(/^(.*?)\s*·\s*(x\s*[\d.]+)\s*$/i)
  if (normalized !== null) {
    const name = String(normalized[1] ?? '').trim()
    const rate = String(normalized[2] ?? '').replace(/\s+/g, '').toLowerCase()
    if (name.length > 0) return { name, rate }
  }
  return { name: original, rate: '' }
}

const contextWindowOf = (modelId, declared) =>
  CONTEXT_OVERRIDES[catalogKey(modelId)] ?? declared
const supportsImageOf = (modelId, declared) =>
  IMAGE_OVERRIDES.has(catalogKey(modelId)) || declared

async function fetchCatalog(credential) {
  const r = await fetch(`${API_BASE}/models`, {
    headers: { Accept: 'application/json', token: credential.access_token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`Loomy 目录读取失败：HTTP ${r.status}`)
  const body = await r.json()
  const envelope = parseEnvelope(body)
  if (!envelope.ok) throw new Error(`Loomy 目录读取失败：${envelope.message}`)
  const rows = Array.isArray(envelope.data) ? envelope.data : []
  const models = {}
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id.length === 0 || row.type !== 'chat') continue // 判据是 type==='chat'（不是 output_modalities）
    const display = splitRate(row.name ?? '').name
    const rate = splitRate(row.name ?? '').rate
    const declaredContext = Number(row.context_length)
    const efforts = Array.isArray(row.reasoning_efforts)
      ? row.reasoning_efforts.filter((e) => typeof e === 'string' && e !== '')
      : undefined
    models[id] = {
      name: rate !== '' ? `${display} · ${rate}` : display,
      limit: { context: contextWindowOf(id, Number.isFinite(declaredContext) ? declaredContext : 128_000), output: 8_192 },
      tool_call: true,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: supportsImageOf(id, Array.isArray(row.input_modalities) ? row.input_modalities.includes('image') : false),
      },
      options: {},
      headers: {},
      variants: Object.fromEntries((efforts ?? LOOMY_EFFORTS).map((effort) => [effort, { reasoning_effort: effort }])),
      status: 'active',
      release_date: '',
    }
    if (efforts !== undefined && efforts.length > 0) models[id].defaultEffort = LOOMY_DEFAULT_EFFORT
  }
  return models
}

// 兜底目录（DSH 实测 8 个 chat 模型；spark-x 窗口已按真实墙位降档）
const FALLBACK_MODELS = {
  'deepseek-v4-flash-0731': { name: 'DeepSeek V4 Flash 0731 · x3.0', limit: { context: 1_048_576, output: 8_192 } },
  'MiniMax-M3': { name: 'MiniMax M3 · x4.0', limit: { context: 1_048_576, output: 8_192 } },
  'Kimi-k2.6': { name: 'Kimi k2.6 · x6.5', limit: { context: 262_144, output: 8_192 } },
  'qwen-3.8-max': { name: 'Qwen 3.8 Max · x12.0', limit: { context: 1_000_000, output: 8_192 } },
  'GLM-5.3-Flash': { name: 'GLM 5.3 Flash · x0.8', limit: { context: 1_048_576, output: 8_192 } },
  'qwen3.8-flash': { name: 'qwen 3.8 flash · x0.8', limit: { context: 1_000_000, output: 8_192 } },
  'spark-x': { name: 'Spark X2.5 · x0.1', limit: { context: 262_144, output: 8_192 } },
  'mimo-v2.5': { name: 'MiMo V2.5 · x3.3', limit: { context: 1_048_576, output: 8_192 } },
}

// ── 积分（两池：永久 balance + 每日 dailyBalance）───────────────────────

async function pointsEnvelope(credential, path, init) {
  const headers = { Accept: 'application/json', token: credential.access_token }
  let payload
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const parsed = await response.json().catch(() => undefined)
  return parseEnvelope(parsed)
}

const readNumber = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const DAILY_QUOTA = 5000

/**
 * 额度两池分开（用户明确要求：永久与每日分开计算）：
 * 每日桶 resetsAt = 下一北京午夜（每日 5000 未用完随日重置）、span 86400s；
 * 永久桶无到期 —— 用 amount/limit 形态（balance 会让 magpie 关掉进度条）。
 * ⚠️ used 必须按真实消耗算（MYCF711 实测纪律）：used 是路由排序的输入，
 * 硬编码 0 = 满额，额度烧穿的账号反而排到队首继续接活。
 */
async function usage(credential) {
  const result = await pointsEnvelope(credential, '/points/records?pageNo=1&pageSize=1&recordType=all')
  if (!result.ok) {
    return [{ name: DISPLAY_NAME, used: 0, display: result.code === AUTH_ERROR_CODE ? '登录会话已失效，需重新登录' : `积分查询失败：${result.message}` }]
  }
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {}
  const permanent = readNumber(data.balance)
  const daily = readNumber(data.dailyBalance) ?? 0
  const dailyUsedPercent = Math.max(0, Math.min(100, Math.round(((DAILY_QUOTA - daily) / DAILY_QUOTA) * 100)))
  const windows = []
  if (permanent !== undefined) {
    windows.push({ name: '永久积分', used: 0, amount: 0, limit: permanent, unit: '积分', display: `剩余 ${permanent}` })
  }
  // 每日池重置点 = 下一北京午夜（Asia/Shanghai），span 86400s 让 magpie 识别为周期窗口
  const nowBeijing = new Date(Date.now() + 8 * 3600_000)
  const nextMidnight = Date.UTC(nowBeijing.getUTCFullYear(), nowBeijing.getUTCMonth(), nowBeijing.getUTCDate() + 1) - 8 * 3600_000
  windows.push({
    name: '每日赠送',
    used: dailyUsedPercent,
    span: 86_400,
    resetsAt: new Date(nextMidnight).toISOString(),
    display: `剩余 ${daily}`,
  })
  return windows
}

/** 一键签到 = 触发每日额度（语义是「重置每日额度」，不是 +5000 积分）。 */
const LOOMY_DAILY_QUOTA_DESCRIPTION = '每日赠送额度（消耗后不回补）'
async function checkin(credential) {
  const result = await pointsEnvelope(credential, '/points/first-login', { method: 'POST', body: {} })
  if (!result.ok) {
    return {
      outcome: 'failed',
      message: result.code === AUTH_ERROR_CODE ? '登录会话已失效，需重新登录' : result.message,
      ...(result.code === AUTH_ERROR_CODE ? { signIn: 'expired' } : {}),
    }
  }
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {}
  const dailyQuota = readNumber(data.dailyQuota)
  const dailyBalance = readNumber(data.dailyBalance)
  if (data.alreadyProcessed === true) {
    // alreadyProcessed = 今天的每日额度已经领到。如实报 claimed + 今日发放量
    //（magpie 对 done 渲染黄色「可能签到日没翻页」，用户报障过）。
    return {
      outcome: 'claimed',
      credit: dailyQuota ?? DAILY_QUOTA,
      message: dailyQuota === undefined ? '今日额度已初始化' : `今日额度已初始化（每日 ${dailyBalance ?? 0}/${dailyQuota}）`,
    }
  }
  const dailyConsumed = readNumber(data.dailyConsumed)
  const granted = dailyQuota !== undefined && dailyConsumed !== undefined
    ? Math.max(0, dailyQuota - dailyConsumed)
    : (dailyQuota ?? 0)
  return { outcome: 'claimed', credit: granted, message: LOOMY_DAILY_QUOTA_DESCRIPTION }
}

// ── chat（OpenAI 兼容直传，双头认证）────────────────────────────────────

const modelIndex = []
const effortsOf = (modelId) => modelIndex.find((m) => catalogKey(m.id) === catalogKey(modelId))?.efforts

async function chat(credential, { body: openaiBody, signal, renew }) {
  const inner = String(openaiBody?.model ?? '')
  const efforts = effortsOf(inner)
  // 档位白名单：不在该模型 efforts 内的值静默不下发（上游对未知字段静默忽略）
  const requested = typeof openaiBody?.reasoning_effort === 'string' ? openaiBody.reasoning_effort : undefined
  const effort = requested !== undefined && efforts !== undefined && efforts.includes(requested) ? requested : undefined
  const payload = {
    model: inner,
    messages: Array.isArray(openaiBody?.messages) ? openaiBody.messages : [],
    stream: openaiBody?.stream !== false,
    ...(Number.isSafeInteger(Number(openaiBody?.max_tokens)) && Number(openaiBody.max_tokens) > 0
      ? { max_tokens: Number(openaiBody.max_tokens) } : {}),
    ...(typeof openaiBody?.temperature === 'number' ? { temperature: openaiBody.temperature } : {}),
    ...(Array.isArray(openaiBody?.stop) && openaiBody.stop.length > 0 ? { stop: openaiBody.stop } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(Array.isArray(openaiBody?.tools) && openaiBody.tools.length > 0 ? { tools: openaiBody.tools } : {}),
  }

  const send = (cred) => fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.access_token}`,
      token: cred.access_token,
    },
    body: JSON.stringify(payload),
    ...(signal !== undefined ? { signal } : {}),
  })

  let response = await send(credential)
  // 业务失败恒 HTTP 200 + code 100002 —— 必须读 body 判，只看状态码会把
  // 「登录失效」误判成成功
  if (typeof renew === 'function' && await looksAuthDead(response)) {
    let renewed
    try {
      renewed = await renew(credential)
    } catch {
      renewed = undefined
    }
    if (renewed !== undefined) {
      response = await send(renewed)
    }
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text().catch(() => '')
    // ① 非流式成功就是 OpenAI 的 chat.completion JSON（没有 {code,…} 信封）
    //    —— 真机：stream:false 上游回了 200 + content:"OK"，读成信封会误判 502
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed?.choices)) {
        return new Response(text, {
          status: response.status,
          headers: { 'content-type': contentType || 'application/json; charset=utf-8' },
        })
      }
    } catch { /* 不是 JSON → 下面按信封/原文报错 */ }
    // ② 业务失败恒 HTTP 200 + {code,…}（100002 = 登录失效）
    let message = text.slice(0, 200)
    try {
      const envelope = parseEnvelope(JSON.parse(text))
      message = envelope.message
      if (envelope.code === AUTH_ERROR_CODE) {
        return Response.json(
          { error: { type: 'provider_error', message: 'Loomy 登录会话已失效，需重新登录' } },
          { status: 401 },
        )
      }
    } catch { /* 原样 */ }
    return Response.json(
      { error: { type: 'provider_error', message: `Loomy 返回（HTTP ${response.status}）：${message}` } },
      { status: response.status >= 400 ? response.status : 502 },
    )
  }
  // 标准 OpenAI SSE 原样透传（data: 帧 + 空 data: 终止，无加密无信封）
  return response
}

/** 非 SSE 响应是否是「登录失效」（100002）。 */
async function looksAuthDead(response) {
  const clone = response.clone()
  try {
    const envelope = parseEnvelope(await clone.json())
    return envelope.code === AUTH_ERROR_CODE
  } catch {
    return false
  }
}

// ── 本地载体页：微信扫码 + 短信 双路登录 ────────────────────────────────

/**
 * 页面 HTML：双路并存 —— 微信扫码（默认区块）与短信验证码。
 * 单文件、内联二维码（data URL），无外部资源。
 * 页面自己负责：轮询状态 → 需要时显示绑定手机号表单 → 成功后提示关闭。
 */
function renderLoginPage(qrDataUrl) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 Loomy</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#eee;
     max-width:420px;margin:40px auto;padding:24px;border-radius:12px;background:#1a1a1a}
h2{margin-top:0}h3{margin:18px 0 8px;font-size:14px;color:#ccc}
label{display:block;margin:14px 0 6px;font-size:13px;color:#aaa}
input{width:100%;padding:10px;box-sizing:border-box;border:1px solid #333;border-radius:6px;
      background:#0d0d0d;color:#eee}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:6px;background:#3b82f6;
       color:#fff;font-size:15px;cursor:pointer}
button:disabled{background:#444;cursor:not-allowed}
#msg{margin-top:14px;font-size:13px;min-height:20px;color:#9ca3af}
.qr{width:220px;height:220px;display:block;margin:0 auto;border:1px solid #333;border-radius:8px}
.status{margin-top:10px;font-size:13px;min-height:20px;color:#9ca3af;text-align:center}
.bindform{display:none}
.bindform[data-show="1"]{display:block}
</style></head><body>
<h2>登录 Loomy</h2>
<p style="font-size:13px;color:#9ca3af">微信扫码（推荐）或手机短信验证码。会话有效期 14 天。</p>

<h3>方式一：微信扫码</h3>
<img class="qr" id="wxqr" alt="微信二维码" src="${qrDataUrl}">
<div class="status" id="wxstatus">等待扫码…</div>
<div class="bindform" id="bindform">
  <p style="font-size:13px;color:#9ca3af">该微信账号未绑定手机号，绑定后完成登录：</p>
  <label>手机号</label><input id="bphone" autocomplete="tel">
  <button id="bsend">获取验证码</button>
  <label>验证码</label><input id="bcode" placeholder="6 位数字">
  <button id="bgo">绑定并登录</button>
</div>

<h3>方式二：短信验证码</h3>
<label>手机号</label><input id="mobile" autocomplete="tel">
<button id="send">获取验证码</button>
<label>验证码</label><input id="code" placeholder="6 位数字">
<button id="go">登录</button>
<div id="msg"></div>
<script>
let msgid = null;
let cooldown = 0;
let lastErr = '';
let stopped = false;
const msg = (t) => { document.getElementById('msg').textContent = t };
const wxs = (t) => { document.getElementById('wxstatus').textContent = t };
document.getElementById('send').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  if (!mobile) return msg('请填手机号');
  if (cooldown > 0) return;
  msg('正在发送验证码…');
  try {
    const r = await fetch('/sms/send', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile }) });
    const j = await r.json();
    if (!j.ok) { msg(j.message || '发送失败'); return }
    msgid = j.msgid;
    msg('验证码已发送（5 分钟内有效）');
    cooldown = 60;
    const btn = document.getElementById('send');
    const t = setInterval(() => {
      cooldown -= 1;
      btn.textContent = cooldown > 0 ? cooldown + 's' : '获取验证码';
      if (cooldown <= 0) clearInterval(t);
    }, 1000);
  } catch (e) { msg('发送失败：' + e.message) }
};
document.getElementById('go').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  const code = document.getElementById('code').value.trim();
  if (!mobile || !code) return msg('请填手机号和验证码');
  if (!msgid) return msg('请先获取验证码');
  msg('登录中…');
  try {
    const r = await fetch('/sms/login', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile, code, msgid }) });
    const j = await r.json();
    msg(j.ok ? '登录成功，可以关闭此页面' : (j.message || '登录失败'));
  } catch (e) { msg('登录失败：' + e.message) }
};
// 微信长轮询（页面每 2 秒打一次，服务器转发一次微信长轮询）
async function pollWechat() {
  if (stopped) return;
  try {
    const r = await fetch('/wechat/poll');
    const j = await r.json();
    if (j.status === 'done') { stopped = true; wxs('登录成功，可以关闭此页面'); return }
    if (j.status === 'need_phone') {
      stopped = true;
      wxs('微信未绑定手机号，请在下方绑定表单完成');
      document.getElementById('bindform').dataset.show = '1';
      return;
    }
    if (j.status === 'confirmed') { wxs('已确认，正在完成登录…'); }
    else if (j.status === 'scanned') { wxs('已扫码，请在手机上确认…'); }
    else if (j.status === 'cancelled') { wxs('已取消，请刷新二维码重试'); }
    else if (j.status === 'expired') { wxs('二维码已过期，请重新发起登录'); stopped = true; return }
    else if (j.status === 'error') { wxs('网络抖动，继续等待…'); }
  } catch (e) { /* 轮询失败继续 */ }
  setTimeout(pollWechat, 2000);
}
pollWechat();
document.getElementById('bsend').onclick = async () => {
  const phone = document.getElementById('bphone').value.trim();
  if (!phone) return wxs('请填手机号');
  wxs('正在发送验证码…');
  try {
    const r = await fetch('/wechat/complete', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action: 'send_sms', phone }) });
    const j = await r.json();
    wxs(j.ok ? '验证码已发送' : (j.message || '发送失败'));
  } catch (e) { wxs('发送失败：' + e.message) }
};
document.getElementById('bgo').onclick = async () => {
  const phone = document.getElementById('bphone').value.trim();
  const code = document.getElementById('bcode').value.trim();
  if (!phone || !code) return wxs('请填手机号和验证码');
  wxs('绑定并登录中…');
  try {
    const r = await fetch('/wechat/complete', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action: 'verify_sms', phone, code }) });
    const j = await r.json();
    if (j.ok && j.done) { stopped = true; wxs('登录成功，可以关闭此页面'); }
    else wxs(j.message || '绑定失败');
  } catch (e) { wxs('绑定失败：' + e.message) }
};
</script></body></html>`
}

/**
 * 起本地载体服务（微信扫码 + 短信双路），立刻返回 loginUrl + result。
 *
 * 微信流程（移植 loomy-wechat-login.ts）：
 *   页面加载时已带二维码（beginLogin 先取 uuid + 图片）；
 *   GET /wechat/poll  → 转发一次长轮询；confirmed 时 bind/auth 换 rcode：
 *     bind===1 → bind/skip 直接换 session（settle 完成）；
 *     bind===0 → 回 need_phone，页面显示绑定表单；
 *   POST /wechat/complete → send_sms / verify_sms 完成绑定登录。
 */
async function beginLogin(openBrowser) {
  const LOGIN_WINDOW_MS = 10 * 60 * 1000
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {})
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

  // 微信状态（移植 FlowState）
  const state = { uuid: '', lastErrcode: '', wechatCode: '', rcode: '', bind: 0, nickname: '', bindMsgid: '' }

  timer = setTimeout(() => settle(false, new Error('Loomy 登录超时（超过 10 分钟无操作）')), LOGIN_WINDOW_MS)
  timer.unref?.() // 不吊住宿主退出（与 server.unref 同理）

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      if (pathname === '/' || pathname === '/login') {
        // 页面加载时取二维码（uuid 在 beginLogin 开始时已取好）
        const qrDataUrl = await fetchLoomyWechatQrImage(state.uuid)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage(qrDataUrl))
        return
      }
      if (pathname === '/wechat/poll') {
        if (state.wechatCode.length > 0) return sendJson(200, { status: 'done' })
        const polled = await pollLoomyWechatOnce(state.uuid, state.lastErrcode)
        if (polled.errcode.length > 0) state.lastErrcode = polled.errcode
        if (polled.status === LOOMY_WECHAT_POLL_STATUS.confirmed && polled.code.length > 0) {
          state.wechatCode = polled.code
          try {
            const bound = await bindThirdAccount(polled.code)
            state.rcode = bound.rcode
            state.bind = bound.bind
            state.nickname = bound.nickname ?? ''
            if (bound.bind === 1) {
              const login = await bindSkip(bound.rcode)
              settle(true, buildWechatCredential(login, state.nickname))
              return sendJson(200, { status: 'done' })
            }
            return sendJson(200, { status: 'need_phone' })
          } catch (error) {
            settle(false, error)
            return sendJson(200, { status: 'error', message: error instanceof Error ? error.message : String(error) })
          }
        }
        return sendJson(200, { status: polled.status })
      }
      if (pathname === '/wechat/complete') {
        const body = await new Response(req).json().catch(() => ({}))
        const action = typeof body.action === 'string' ? body.action : ''
        if (action === 'send_sms') {
          state.bindMsgid = await bindSendMsg(state.rcode, String(body.phone ?? ''))
          return sendJson(200, { ok: true })
        }
        if (action === 'verify_sms') {
          const login = await bindCheckCode(state.rcode, String(body.code ?? ''), state.bindMsgid)
          settle(true, {
            access_token: login.session,
            userid: login.userid,
            phone: login.phone.length > 0 ? login.phone : String(body.phone ?? ''),
            ...(state.nickname.length > 0 ? { nickname: state.nickname } : {}),
            expires_at: String(Date.now() + SESSION_TTL_SECONDS * 1000),
          })
          return sendJson(200, { ok: true, done: true })
        }
        return sendJson(200, { ok: false, message: `未知 action: ${action}` })
      }
      if (pathname === '/sms/send') {
        const body = await new Response(req).json().catch(() => ({}))
        const msgid = await sendSmsCode(String(body.mobile ?? ''))
        return sendJson(200, { ok: true, msgid, message: '短信验证码已发送（5 分钟内有效）' })
      }
      if (pathname === '/sms/login') {
        const body = await new Response(req).json().catch(() => ({}))
        const login = await loginBySmsCode(String(body.mobile ?? ''), String(body.code ?? ''), String(body.msgid ?? ''))
        settle(true, {
          access_token: login.session,
          userid: login.userid,
          phone: String(body.mobile ?? ''),
          expires_at: String(Date.now() + SESSION_TTL_SECONDS * 1000),
        })
        return sendJson(200, { ok: true, message: '登录成功，可以关闭此页面' })
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
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
      // ⚠️ unref：登录窗口是独立的用户流程，不该吊住宿主进程的退出
      //   （测试里未结算 result 的用例否则会挂满 10 分钟超时）。
      server.unref()
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    settle(false, new Error(`Loomy 回调端口无法监听（${error.message}）`))
    throw error
  })

  // uuid 在起服务前取好（失败则整个流程起不来）
  state.uuid = await fetchLoomyWechatUuid(randomUUID())

  const url = `http://127.0.0.1:${port}/login`
  if (openBrowser) openBrowser(url)
  return { url, result, instructions: `在打开的页面里完成登录（微信扫码或短信），完成后本窗口自动继续。也可以手动打开：${url}` }
}

/** 微信登录结果 → 渠道凭据（session 14 天）。 */
function buildWechatCredential(login, nickname) {
  return {
    access_token: login.session,
    userid: login.userid,
    ...(login.phone !== undefined && login.phone !== '' ? { phone: login.phone } : {}),
    ...(nickname !== undefined && nickname !== '' ? { nickname } : {}),
    expires_at: String(Date.now() + SESSION_TTL_SECONDS * 1000),
  }
}

// ── 渠道对象 ────────────────────────────────────────────────────────────

export const loomyChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  fallbackModels: FALLBACK_MODELS,
  beginLogin,
  loginMethods: [{ label: '浏览器登录（微信扫码或手机短信）' }],
  // ⚠️ 无 refresh 端点（诚实标记）：session 14 天，过期只能重新登录
  async refresh() {
    throw new Error('Loomy 无自动续期：会话有效期 14 天，过期后请重新登录')
  },
  expired: (credential) => {
    const raw = Number(credential?.expires_at)
    // 无 expires_at 视为不过期：宁可拿可能过期的凭据去试（服务端回 100002 我们能识别），
    // 也不凭猜测阻止用户使用（DSH 同款取舍）
    return Number.isFinite(raw) && raw > 0 && raw <= Date.now()
  },
  catalog: fetchCatalog,
  chat,
  checkin,
  usage,
}
