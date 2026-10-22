// AStudio（讯飞 AstronStudio）渠道实现 —— 供聚合层消费，本身不是插件。
//
// ## 登录：本地 Carrier 载体页（三合一：短信 / 账号密码 / 微信扫码）
//
// DSH 的 jethub 也是这么做的（`startAstudioLoginFlow`）：**授权页不在讯飞那边**，
// 而是**我们本地起一个 HTTP 服务**承载登录页，页面里完成极验 + 短信/密码/微信，
// 拿到会话后再去账号后端换推理凭据。
//
// ⚠️ 为什么必须走本地页（而不是 magpie 的普通 OAuth「开一个 URL 就完事」）：
//    magpie 的 `oauth` 方法语义是「开 URL → 等回调 → 完」，而这里要**两步交互**
//    （极验滑块 → 收短信 → 填验证码）。所以复用 DSH 同款：返回本地页 URL，
//    用户在页面里走完，`result` promise 兑现。
//
// ## 协议要点（实测，不是推测）
//
// | 用途 | 方法 | 地址 | 认证 |
// |---|---|---|---|
// | 对话 | POST | `{maas}/model-gateway/v1/chat/completions` | `Bearer <modelBearerToken>` |
// | 目录 | GET | `{maas}/api/v1/model-manager/models` | 同上 |
// | 活体凭据 | GET | `{auth}/bot/models/configs` | Cookie 四字段串 |
//
// 1. **两个基址不共用前缀**：推理 `/model-gateway/v1`，目录 `/api/v1/model-manager`。
//    ⚠️ `/model-gateway/v1/models` 恒 404 —— 不能按「OpenAI 兼容必有 /v1/models」拼。
// 2. **推理端只认裸 slug**：`builtin/<base64>` 是 acode 内核内部别名，发上去 502。
// 3. **失败两种信封**：控制面 `{code,message,data}`（HTTP 仍 200，code≠0 即失败）；
//    推理面 OpenAI 裸体。
//
// ⚠️ **无程序化续期**：SSO 会话 `Max-Age=31536000`（一年，不滑动），
//    失效时上游恒返回 HTTP 200 + `code=80000`。本渠道**不假装能刷新**。

import { createServer } from 'node:http'
import { loadCredential, saveCredential } from './shared.mjs'

const PROVIDER = 'astudio'
const DISPLAY = 'AStudio（讯飞）'

/** 推理网关基址（OpenAI 兼容）。 */
const MAAS_BASE = 'https://astronstudio-api-volces-prod.xf-yun.com'
/** 账号后端基址（活体凭据权威源）。 */
const AUTH_BASE = 'https://agent.xfyun.cn/xingchen-studio'

const CHAT_PATH = '/model-gateway/v1/chat/completions'
const CATALOG_PATH = '/api/v1/model-manager/models'
const BOT_CONFIGS_PATH = '/bot/models/configs'
const INIT_APP_PATH = '/tenant-app/v2/init-app'
const GEE_CAPTCHA_PATH = '/chat/gee-captcha'
const SEND_SMS_PATH = '/login/mobile/send-verify-code'
const PHONE_LOGIN_PATH = '/login/phone-quick-login'
const PASSWORD_LOGIN_PATH = '/login/check-account'

const REQUEST_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** Cookie 四字段串：驼峰+蛇形**同值各发一次**，少一个命中不同校验分支。 */
function cookieHeader(credential) {
  const sso = credential.ssoSessionId ?? credential.sso_session_id ?? ''
  const acc = credential.accountId ?? credential.account_id ?? ''
  const tok = credential.token ?? sso
  return [['ssoSessionId', sso], ['sso_sessionid', sso], ['account_id', acc], ['token', tok || sso]]
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** 从 `bot/models/configs` 的 `data` 数组里挑出推理 api_key。 */
function pickApiKey(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  for (const row of rows) {
    const key = typeof row?.api_key === 'string' ? row.api_key
      : typeof row?.apiKey === 'string' ? row.apiKey : ''
    if (key.length > 0) return key
  }
  return undefined
}

/** 登录拿到 identity 后：init-app（可失败）→ bot/models/configs 换推理凭据。 */
async function completeLogin(identity) {
  const sso = String(identity.ssoSessionId ?? identity.uid ?? '').trim()
  const acc = String(identity.accountId ?? identity.uid ?? '').trim()
  const token = String(identity.token ?? sso).trim()
  const seed = { ssoSessionId: sso, accountId: acc, token }
  const cookie = cookieHeader(seed)

  try {
    await fetch(`${AUTH_BASE}${INIT_APP_PATH}`, {
      method: 'POST', headers: { Accept: 'application/json', Cookie: cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    // init-app 非阻塞：失败不影响后续
  }

  const r = await fetch(`${AUTH_BASE}${BOT_CONFIGS_PATH}`, {
    method: 'GET', headers: { Accept: 'application/json', Cookie: cookie },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`换取 AStudio 推理凭据失败：HTTP ${r.status}`)
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch {
    // 非 JSON = 登录页 HTML / 网关错误页 → 会话失效的典型形态
    throw new Error('换取 AStudio 推理凭据失败：响应不是 JSON（会话可能已失效）')
  }
  const apiKey = pickApiKey(body)
  if (!apiKey) throw new Error('账号后端未返回推理 api_key（未开通或会话已失效）')

  return {
    accessToken: apiKey,
    ssoSessionId: sso,
    accountId: acc,
    token,
    loginMethod: identity.loginMethod ?? 'sms',
    nickname: identity.nickname ?? identity.mobile ?? acc,
    loggedInAt: new Date().toISOString(),
  }
}

/** 页面 HTML：极验 + 短信。（微信扫码/密码登录留给后续：需要 SSO 轮询与二维码渲染） */
function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 AStudio</title>
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
#gee{margin:14px 0}
</style></head><body>
<h2>登录 AStudio</h2>
<p style="font-size:13px;color:#9ca3af">手机短信验证码登录。先点「获取验证码」（需完成滑块验证），再填入短信里的验证码。</p>
<div id="gee"></div>
<label>手机号</label><input id="mobile" placeholder="13800138000" autocomplete="tel">
<div style="display:flex;gap:8px">
  <div style="flex:1"><label>验证码</label><input id="code" placeholder="6 位数字"></div>
  <div style="flex:1"><label>&nbsp;</label><button id="send">获取验证码</button></div>
</div>
<button id="go">登录</button>
<div id="msg"></div>
<script>
// 极验：载入官方 gt.js 并渲染。滑块结果由 geetest 回调给出，
// 我们不破解它 —— 只把 {challenge, validate, seccode} 原样交给后端。
let gee = null;
const msg = (t) => { document.getElementById('msg').textContent = t };
async function loadGee() {
  const r = await fetch('/gee-captcha'); const j = await r.json();
  if (!j.ok) throw new Error(j.message || '极验配置获取失败');
  const cfg = j.data;
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://static.geetest.com/static/js/gt.0.4.9.js';
    s.onload = () => window.initGeetest({
      gt: cfg.gt, challenge: cfg.challenge, new_captcha: cfg.new_captcha,
      product: 'popup', width: '100%'
    }, (o) => {
      o.appendTo('#gee');
      o.onSuccess = () => { gee = o.getValidate(); msg('滑块验证通过'); resolve() };
      o.onReady = () => resolve();
    });
    s.onerror = () => { msg('极验脚本加载失败，请检查网络'); resolve() };
    document.head.appendChild(s);
  });
}
document.getElementById('send').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  if (!mobile) return msg('请填手机号');
  if (!gee) { await loadGee(); if (!gee) return msg('请先完成滑块验证') }
  try {
    const r = await fetch('/sms/send', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile, geetestChallenge: gee.geetest_challenge,
        geetestValidate: gee.geetest_validate, geetestSeccode: gee.geetest_seccode }) });
    const j = await r.json();
    msg(j.ok ? (j.message || '验证码已发送') : (j.message || '发送失败'));
  } catch (e) { msg('发送失败：' + e.message) }
};
document.getElementById('go').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  const verifyCode = document.getElementById('code').value.trim();
  if (!mobile || !verifyCode) return msg('请填手机号和验证码');
  msg('登录中…');
  try {
    const r = await fetch('/sms/login', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile, verifyCode }) });
    const j = await r.json();
    msg(j.ok ? (j.message || '登录成功') : (j.message || '登录失败'));
  } catch (e) { msg('登录失败：' + e.message) }
};
loadGee();
</script></body></html>`
}

/** 起本地 Carrier 服务，返回 loginUrl + result promise（对齐 DSH 的 startAstudioLoginFlow）。 */
async function startLoginFlow() {
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  let server
  let closed = false
  const closeServer = () => new Promise((resolve) => {
    if (closed || !server) return resolve()
    closed = true
    server.close(() => resolve())
  })
  const timer = setTimeout(() => {
    settleFail(new Error('AStudio 登录超时（超过 5 分钟无操作）'))
    void closeServer()
  }, LOGIN_TIMEOUT_MS)

  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  const readBody = async (req) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > 64 * 1024) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf-8')
    return text.length === 0 ? {} : JSON.parse(text)
  }

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    try {
      if (pathname === '/' || pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage())
        return
      }
      if (pathname === '/gee-captcha') {
        const r = await fetch(`${AUTH_BASE}${GEE_CAPTCHA_PATH}?t=${Date.now()}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
        })
        if (!r.ok) return sendJson(res, 500, { ok: false, message: `HTTP ${r.status}` })
        const body = await r.json()
        const data = body?.data && typeof body.data === 'object' ? body.data : body
        if (typeof data?.gt !== 'string' || typeof data?.challenge !== 'string') {
          return sendJson(res, 500, { ok: false, message: '极验配置缺失 gt/challenge' })
        }
        return sendJson(res, 200, { ok: true, data })
      }
      if (pathname === '/sms/send') {
        const body = await readBody(req)
        const form = new FormData()
        form.append('mobile', String(body.mobile ?? ''))
        form.append('countryCode', String(body.countryCode ?? '86'))
        form.append('geetest_challenge', String(body.geetestChallenge ?? ''))
        form.append('geetest_validate', String(body.geetestValidate ?? ''))
        form.append('geetest_seccode', Buffer.from(String(body.geetestSeccode ?? ''), 'utf8').toString('base64'))
        const r = await fetch(`${AUTH_BASE}${SEND_SMS_PATH}`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const j = await r.json()
        return sendJson(res, 200, { ok: j.code === 0, message: j.desc ?? j.message ?? j.msg ?? '' })
      }
      if (pathname === '/sms/login') {
        const body = await readBody(req)
        const form = new FormData()
        form.append('mobile', String(body.mobile ?? ''))
        form.append('verifyCode', String(body.verifyCode ?? ''))
        form.append('countryCode', '86')
        const r = await fetch(`${AUTH_BASE}${PHONE_LOGIN_PATH}`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!r.ok) return sendJson(res, 400, { ok: false, message: `HTTP ${r.status}` })
        const j = await r.json()
        if (j.code !== 0) return sendJson(res, 400, { ok: false, message: j.desc ?? j.message ?? `code=${j.code}` })
        const d = j.data && typeof j.data === 'object' ? j.data : {}
        const identity = {
          uid: String(d.uid ?? d.account_id ?? ''),
          ssoSessionId: String(d.ssoSessionId ?? d.token ?? ''),
          token: d.token ? String(d.token) : undefined,
          accountId: String(d.accountId ?? d.account_id ?? ''),
          mobile: String(body.mobile ?? ''),
          loginMethod: 'sms',
        }
        const credential = await completeLogin(identity)
        sendJson(res, 200, { ok: true, message: '登录成功' })
        clearTimeout(timer)
        settleOk(credential)
        setTimeout(() => void closeServer(), 500)
        return
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })

  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      typeof addr === 'object' && addr !== null ? resolve(addr.port) : reject(new Error('无法获取端口'))
    })
    server.on('error', reject)
  })

  return { loginUrl: `http://127.0.0.1:${port}/login`, result: result.finally(() => { clearTimeout(timer) }), close: closeServer }
}

/** 拉目录：`GET {maas}/api/v1/model-manager/models`。 */
async function fetchCatalog(credential) {
  const r = await fetch(`${MAAS_BASE}${CATALOG_PATH}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`AStudio 目录读取失败：HTTP ${r.status}`)
  const body = await r.json()
  // 控制面信封 `{code,message,data}`（HTTP 仍 200）
  if (body?.code !== undefined && body.code !== 0) {
    throw new Error(`AStudio 目录读取失败：${body.message ?? body.desc ?? `code=${body.code}`}`)
  }
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  const models = {}
  for (const row of rows) {
    // ⚠️ 只认**裸 slug**：`builtin/<base64>` 是 acode 内部别名，发推理端会 502。
    const id = typeof row?.model === 'string' ? row.model : (typeof row?.id === 'string' ? row.id : '')
    if (id.length === 0 || id.startsWith('builtin/')) continue
    models[id] = {
      name: typeof row?.display_name === 'string' && row.display_name.length > 0 ? row.display_name : id,
      limit: {
        context: Number(row?.context_window) || 128_000,
        output: Number(row?.max_output_tokens) || 8192,
      },
      tool_call: true,
      capabilities: {
        temperature: true,
        reasoning: true,
        // 实测远端 input_modalities 全是 ['text'] ⇒ 明确不支持图片
        attachment: Array.isArray(row?.input_modalities) ? row.input_modalities.includes('image') : false,
      },
      options: {}, headers: {}, variants: {},
      status: 'active', release_date: '',
    }
  }
  return models
}

export const astudioChannel = {
  id: PROVIDER,
  displayName: DISPLAY,

  // 兜底目录（7 个常见模型；登录后以远端目录为准）
  fallbackModels: {
    'xopdsv4flash0731in': { name: 'DeepSeek V4 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
    'spark-x': { name: '讯飞星火 X', limit: { context: 128_000, output: 8192 }, tool_call: true },
  },

  /**
   * 起本地载体页并**立刻**返回 `{ url, result }`（契约与 officeace 一致）。
   *
   * ⚠️ 不在 authorize 里等登录：magpie 先拿 url 打开浏览器、再调 callback 等结果。
   *    url 已就绪（本地服务已在监听），登录在 `result` 上推进。
   */
  async beginLogin(openBrowser) {
    const flow = await startLoginFlow()
    if (openBrowser) openBrowser(flow.loginUrl)
    return { url: flow.loginUrl, result: flow.result }
  },

  /** ⚠️ 无程序化续期：SSO 会话一年不滑动，失效即需人工重登。不假装能刷新。 */
  async refresh() {
    throw new Error('AStudio 不支持自动续期：会话失效后请重新登录（SSO 会话一年，不滑动）')
  },
  expired: () => false,

  catalog: fetchCatalog,

  async chat(credential, { body, signal }) {
    // ⚠️ /model-gateway/v1/chat/completions 是唯一能用；/model-gateway/v1/models 恒 404
    return fetch(`${MAAS_BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential.accessToken}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  },
}
