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
// ```
//
// ## 四个必须记住的坑（loomy.ts 文件头实测）
//
// 1. **两套认证头**：chat 只认 `Authorization: Bearer`；models/points 只认
//    小写 `token`。带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。
//    chat 两个都发（官方客户端同款）。
// 2. **业务失败恒 HTTP 200**：成败只能读 body 的 `code`（'000000' = OK，
//    '100002' = 登录失效 → 不重试、提示重登）。
// 3. **没有 refresh 端点**：session 登录时声明 14 天，过期只能重新短信登录。
// 4. **短信登录是三步表单流**（无 URL 可开）：sendMsgCode → msgid →
//    checkCode(session)。msgid 必须原样带回。
//
// ## magpie 侧形状
//
// OpenAI 兼容直传（与 officeace 同型，无翻译层）；登录用本地载体页
// （与 astudio 同型）；签到/余额走 token 头。

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { loadCredential, saveCredential } from './shared.mjs'

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
/** 临期窗口外的会话剩余天数提示阈值（14 天会话，一半就该留意）。 */
const SESSION_WARN_MS = 7 * 86_400_000

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

// ── 登录：短信三步（账号端点，HMAC 签名）────────────────────────────────

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

/** 账号端点请求（body 序列化一次、签名与发送共用 —— 签名能通过的前提）。 */
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

// ── 载体页（短信三步表单流，与 astudio 同型）────────────────────────────

/** 页面 HTML：短信三步表单流（无极验 —— Loomy 的验证码只要手机号）。 */
export function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 Loomy</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#eee;
     max-width:420px;margin:40px auto;padding:24px;border-radius:12px;background:#1a1a1a}
h2{margin-top:0}label{display:block;margin:14px 0 6px;font-size:13px;color:#aaa}
input{width:100%;padding:10px;box-sizing:border-box;border:1px solid #333;border-radius:6px;
      background:#0d0d0d;color:#eee}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:6px;background:#3b82f6;
       color:#fff;font-size:15px;cursor:pointer}
button:disabled{background:#444;cursor:not-allowed}
#msg{margin-top:14px;font-size:13px;min-height:20px;color:#9ca3af}
</style></head><body>
<h2>登录 Loomy</h2>
<p style="font-size:13px;color:#9ca3af">手机短信验证码登录（讯飞账号）。会话有效期 14 天。</p>
<label>手机号</label><input id="mobile" autocomplete="tel">
<button id="send">获取验证码</button>
<label>验证码</label><input id="code" placeholder="6 位数字">
<button id="go">登录</button>
<div id="msg"></div>
<script>
let msgid = null;
let cooldown = 0;
const msg = (t) => { document.getElementById('msg').textContent = t };
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
</script></body></html>`
}

/** 起本地载体服务（短信三步表单流），立刻返回 loginUrl + result。 */
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

  timer = setTimeout(() => settle(false, new Error('Loomy 登录超时（超过 10 分钟无操作）')), LOGIN_WINDOW_MS)

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      if (pathname === '/' || pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage())
        return
      }
      if (pathname === '/sms/send') {
        const body = await new Response(req).json().catch(() => ({}))
        const msgid = await sendSmsCode(String(body.mobile ?? ''))
        return sendJson(200, { ok: true, msgid, message: '短信验证码已发送（5 分钟内有效）' })
      }
      if (pathname === '/sms/login') {
        const body = await new Response(req).json().catch(() => ({}))
        const login = await loginBySmsCode(String(body.mobile ?? ''), String(body.code ?? ''), String(body.msgid ?? ''))
        const credential = {
          access_token: login.session,
          userid: login.userid,
          phone: String(body.mobile ?? ''),
          expires_at: String(Date.now() + SESSION_TTL_SECONDS * 1000),
        }
        saveCredential(CHANNEL_ID, credential)
        sendJson(200, { ok: true, message: '登录成功，可以关闭此页面' })
        settle(true, credential)
        return
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
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    settle(false, new Error(`Loomy 回调端口无法监听（${error.message}）`))
    throw error
  })

  const url = `http://127.0.0.1:${port}/login`
  if (openBrowser) openBrowser(url)
  return { url, result, instructions: `在打开的页面里完成短信登录，完成后本窗口自动继续。也可以手动打开：${url}` }
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
    // 倍率在 name 字符串里（三种括号风格混用 → 规范化为 ` · x{n}`）
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

/**
 * 额度分桶 → magpie windows。两池分开（用户明确要求：永久与每日分开计算）：
 * 每日桶 resetsAt = 下一北京午夜（每日 5000 未用完随日重置）、span 86400s；
 * 永久桶无到期。`balance` 缺失 ≠ 0（IKMCOO：不臆造 0），缺失时不出永久桶。
 */
/**
 * 额度分桶 → magpie windows。两池分开（用户明确要求：永久与每日分开计算）：
 * 每日桶 resetsAt = 下一北京午夜（每日 5000 未用完随日重置）、span 86400s；
 * 永久桶无到期。`balance` 缺失 ≠ 0（IKMCOO：不臆造 0），缺失时不出永久桶。
 *
 * ⚠️⚠️ **used 必须按真实消耗算**（MYCF711 模板实测纪律）：`used` 不只画进度条，
 * 还是 magpie **路由排序的输入** —— 硬编码 0 = 满额，账号会排到队首，额度烧穿
 * 的账号反而继续接活（用户真机报障：每日 5000 剩 3611 还显示「剩余 100%」）。
 * 每日基数 5000 来自签到端点实测的 `dailyQuota`；上游若加赠导致 daily > 基数，
 * 按钳制到 0 处理（不报负数）。渠道内部名不带 "Loomy ·" 前缀（聚合层统一加
 * 渠道前缀 —— 内部再带就叠成 "Loomy (讯飞) · Loomy · …"）。
 */
const DAILY_QUOTA = 5000

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
    // balance/unit：magpie ≥0.1.1790 的一等「还剩多少」读数（路由按它认识账号）；
    // 旧宿主忽略该字段，无副作用。
    windows.push({ name: '永久积分', used: 0, display: `剩余 ${permanent}`, balance: permanent, unit: '积分' })
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
    // ⚠️ alreadyProcessed = **今天的每日额度已经领到**（当日首次签到时初始化）。
    //   如实报 claimed + 今日发放量 —— magpie 对 `done` 渲染成**黄色**「回复已签到
    //   …稍后会再问」（它的语义是「厂商说已签到，可能签到日没翻页」），用户报障
    //   「明明每日的领到了为啥不显示成功」。今日确实领过 5000，claimed 是诚实的。
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
const LOOMY_DAILY_QUOTA_DESCRIPTION = '每日赠送额度（消耗后不回补）'

// ── chat（OpenAI 兼容直传，双头认证）────────────────────────────────────

const modelIndex = []
const effortsOf = (modelId) => modelIndex.find((m) => catalogKey(m.id) === catalogKey(modelId))?.efforts

async function chat(credential, { body: openaiBody, signal, renew }) {
  const inner = String(openaiBody?.model ?? '')
  const efforts = effortsOf(inner)
  // ⚠️ 档位白名单：不在该模型 efforts 内的值静默不下发（上游对未知字段静默忽略，
  // 三种字段名都回 200 —— 不能靠状态码判断生效与否，字段名依据是远端自己的命名）
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
    // ① **非流式成功**就是 OpenAI 的 chat.completion JSON（没有 {code,…} 信封）
    //    —— 真机：stream:false 上游回了 200 + content:"OK"，这里却把它读成
    //    「业务错误（缺少 code）」→ 502。看得懂的成功必须原样回传。
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

// ── 渠道对象 ────────────────────────────────────────────────────────────

export const loomyChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  fallbackModels: FALLBACK_MODELS,
  beginLogin,
  // ⚠️ 无 refresh 端点（诚实标记）：session 14 天，过期只能重新短信登录
  async refresh() {
    throw new Error('Loomy 无自动续期：会话有效期 14 天，过期后请重新短信登录')
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
