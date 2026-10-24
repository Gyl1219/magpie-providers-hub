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

/** 页面 HTML：极验 + 短信。交互照抄 DSH 载体页（bind 模式、单次消费、可重试）。 */
export function renderLoginPage() {
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
button.secondary{background:#374151}
#msg{margin-top:14px;font-size:13px;min-height:20px;color:#9ca3af}
#captchaBox{margin-top:8px;font-size:13px;color:#9ca3af;min-height:18px}
.ok{color:#34d399}
</style></head><body>
<h2>登录 AStudio</h2>
<p style="font-size:13px;color:#9ca3af">手机短信验证码登录：先完成安全验证，再获取短信验证码。</p>
<label>手机号</label><input id="mobile" placeholder="13800138000" autocomplete="tel">
<button id="captcha" class="secondary">点击进行安全验证</button>
<div id="captchaBox">未验证</div>
<div style="display:flex;gap:8px">
  <div style="flex:1"><label>验证码</label><input id="code" placeholder="6 位数字"></div>
  <div style="flex:1"><label>&nbsp;</label><button id="send">获取验证码</button></div>
</div>
<button id="go">登录</button>
<div id="msg"></div>
<script>
// 极验交互照抄 DSH 载体页（astudio-oauth.ts 的 setupCaptcha/triggerGeetestCaptcha）：
//  - product:'bind' + onReady 里程序化 verify()（不是 popup 常驻）；
//  - **每次点「安全验证」新起一个实例**（新 challenge），完成/失败/超时后 destroy()；
//  - validate 是**一次性**的：send 消费后必须重新验证（旧值置空），
//    重发用已消费的 validate 必失败 —— 这是上一版「无法获取验证码」的根因。
let captchaResult = null;
const msg = (t) => { document.getElementById('msg').textContent = t };

var gtScriptPromise = null;
function ensureGeetestSdk() {
  if (typeof window.initGeetest === 'function') return Promise.resolve();
  if (gtScriptPromise) return gtScriptPromise;
  gtScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://static.geetest.com/static/tools/gt.js';
    s.async = true;
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => { s.remove(); gtScriptPromise = null;
      reject(new Error('安全验证组件加载失败，请检查网络后重试。')) }, { once: true });
    document.head.appendChild(s);
  });
  return gtScriptPromise;
}

async function triggerCaptcha() {
  await ensureGeetestSdk();
  const r = await fetch('/gee-captcha');
  const j = await r.json();
  if (!j.ok || !j.data) throw new Error(j.message || '获取验证码配置失败');
  const config = j.data;
  return new Promise((resolve, reject) => {
    let finished = false;
    let instance = null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (instance && typeof instance.destroy === 'function') instance.destroy(); } catch (_) {}
      'payload' in result ? resolve(result.payload) : reject(result.error);
    };
    const timer = setTimeout(() => finish({ error: new Error('安全验证超时，请重试。') }), 30000);
    try {
      window.initGeetest(Object.assign({}, config, {
        https: true, offline: !config.success, product: 'bind', width: '100%',
      }), (o) => {
        instance = o;
        o.onReady(() => { try { o.verify(); } catch (e) { finish({ error: new Error('安全验证启动失败，请重试。') }) } });
        o.onError(() => finish({ error: new Error('安全验证网络异常，请稍后重试。') }));
        if (typeof o.onClose === 'function') o.onClose(() => finish({ error: new Error('安全验证已取消。') }));
        o.onSuccess(() => {
          const val = o.getValidate();
          if (!val || !val.geetest_challenge || !val.geetest_validate || !val.geetest_seccode) {
            finish({ error: new Error('安全验证结果无效，请重试。') });
            return;
          }
          finish({ payload: {
            geetestChallenge: val.geetest_challenge,
            geetestValidate: val.geetest_validate,
            geetestSeccode: val.geetest_seccode,
          } });
        });
      });
    } catch (e) {
      finish({ error: e instanceof Error ? e : new Error(String(e)) });
    }
  });
}

const captchaBtn = document.getElementById('captcha');
const captchaBox = document.getElementById('captchaBox');
captchaBtn.onclick = async () => {
  captchaBtn.disabled = true;
  captchaBtn.textContent = '正在拉起验证…';
  try {
    captchaResult = await triggerCaptcha();
    captchaBox.textContent = '✓ 已完成安全验证';
    captchaBox.className = 'ok';
    captchaBtn.textContent = '重新验证';
  } catch (e) {
    captchaResult = null;
    captchaBox.textContent = '未验证';
    captchaBox.className = '';
    captchaBtn.textContent = '验证失败，重试';
    msg(e.message || '安全验证失败');
  }
  captchaBtn.disabled = false;
};

let sendCooldown = 0;
document.getElementById('send').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  if (!mobile) return msg('请填手机号');
  if (!captchaResult) return msg('请先点击上方按钮完成安全验证');
  if (sendCooldown > 0) return;
  msg('正在发送验证码…');
  try {
    const r = await fetch('/sms/send', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile, geetestChallenge: captchaResult.geetestChallenge,
        geetestValidate: captchaResult.geetestValidate, geetestSeccode: captchaResult.geetestSeccode }) });
    const j = await r.json();
    if (j.ok) {
      msg(j.message || '验证码已发送');
      sendCooldown = 60;
      const t = setInterval(() => {
        sendCooldown -= 1;
        document.getElementById('send').textContent = sendCooldown > 0 ? sendCooldown + 's' : '获取验证码';
        if (sendCooldown <= 0) clearInterval(t);
      }, 1000);
    } else {
      msg(j.message || '发送失败');
    }
  } catch (e) { msg('发送失败：' + e.message) }
  finally {
    // ⚠️ validate 一次性：无论成败都作废，要求重新滑一次（重发用旧值必失败）
    captchaResult = null;
    captchaBox.textContent = '需重新验证';
    captchaBox.className = '';
    captchaBtn.textContent = '点击进行安全验证';
  }
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
        const j = await r.json().catch(() => ({}))
        // ⚠️ 成功判据对齐 DSH sendAstudioSmsCode：code 为 0 / '0'（字符串）/
        //    undefined（信封没有 code 键）都算成功 —— 只认 === 0 会把上游
        //    字符串形态误判成「发送失败」，且 desc 为空时页面无任何提示。
        const code = j?.code
        const ok = code === 0 || code === '0' || code === undefined
        const message = j?.desc ?? j?.message ?? j?.msg ?? (ok ? '短信验证码已发送' : `code=${String(code)}`)
        return sendJson(res, 200, { ok, message })
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

  /**
   * 每日签到 + 福利礼包领取（移植 astudio-credits.ts 的 claimDaily）。
   *
   * 流程：GET /client-popups/pending 查可领弹窗 → 逐个 POST /client-popups/complete。
   * ⚠️ 真实字段是 **`componentType`** 而不是 `type`（2026-10-20 真机取证）——
   * 读错字段会一个可领弹窗都识别不出来，界面显示「今天已领取」而积分一动不动
   * （用户报障的原话）。仍兼容 `type`，但优先 `componentType`。
   * ⚠️ code 80000 = SSO 会话失效（终态，需人工重登）。
   */
  async checkin(credential) {
    const cookie = cookieHeader(credential)
    if (cookie.length === 0) {
      return { outcome: 'failed', message: '未登录 AStudio（缺少登录会话 Cookie），请重新登录' }
    }
    const headers = {
      Accept: 'application/json',
      Cookie: cookie,
      clientType: '21',
      studioVersion: '3.5.2',
    }
    const CLAIMABLE = ['DAILY_REWARD_DIALOG', 'NEW_USER_DIALOG']
    const popupTypeOf = (record) => String(record.componentType ?? record.type ?? '')
    /** 积分解析：数字 / 字符串 / JSON 串 / {points|credit|rewardPoints|reward_points}。 */
    const pointsOf = (payload) => {
      if (typeof payload === 'number') return Number.isFinite(payload) && payload >= 0 ? Math.floor(payload) : 0
      if (typeof payload === 'string') {
        const trimmed = payload.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { return pointsOf(JSON.parse(trimmed)) } catch { /* 回退 */ }
        }
        const parsed = parseInt(trimmed, 10)
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
      }
      if (typeof payload === 'object' && payload !== null) {
        for (const key of ['points', 'credit', 'rewardPoints', 'reward_points']) {
          if (key in payload) return pointsOf(payload[key])
        }
      }
      return 0
    }
    const payloadOf = (record) => {
      if (typeof record?.payload === 'object' && record.payload !== null) return record.payload
      if (typeof record?.content === 'object' && record.content !== null) return record.content
      if (typeof record?.content === 'string') {
        try {
          const parsed = JSON.parse(record.content)
          if (typeof parsed === 'object' && parsed !== null) return parsed
        } catch { /* 忽略非 JSON */ }
      }
      return undefined
    }
    const deadSession = (code, message) => code === 80000
      || (typeof message === 'string' && message.includes('登录异常，请重新登录'))

    let pending
    try {
      const response = await fetch(`${AUTH_BASE}/client-popups/pending`, {
        method: 'GET', headers, signal: AbortSignal.timeout(15_000),
      })
      const text = await response.text()
      if (!response.ok) return { outcome: 'failed', message: `签到查询失败（HTTP ${response.status}）` }
      pending = JSON.parse(text)
    } catch (error) {
      return { outcome: 'failed', message: `签到查询失败（网络异常）：${error.message}` }
    }
    const code = typeof pending?.code === 'number' ? pending.code : parseInt(String(pending?.code ?? ''), 10)
    const message = typeof pending?.message === 'string' ? pending.message : String(pending?.desc ?? '')
    if (deadSession(code, message)) {
      return { outcome: 'failed', message: 'AStudio 登录会话已失效，需人工重新登录' }
    }
    if (Number.isFinite(code) && code !== 0) {
      return { outcome: 'failed', message: `签到查询失败：${message || `code=${code}`}` }
    }
    const rows = Array.isArray(pending?.data) ? pending.data : []
    const popups = []
    const seen = new Set()
    for (const record of rows) {
      if (typeof record !== 'object' || record === null) continue
      const type = popupTypeOf(record)
      if (!CLAIMABLE.includes(type)) continue
      const popupId = typeof record.popupId === 'number' ? record.popupId : parseInt(String(record.popupId), 10)
      if (!Number.isFinite(popupId) || seen.has(popupId)) continue
      seen.add(popupId)
      popups.push({ popupId, instanceKey: typeof record.instanceKey === 'string' ? record.instanceKey : '', payload: payloadOf(record) })
    }
    // ⚠️ pending 为空 / 无可领弹窗 = 今日已领（实测已领取时返回 code=0 data=[]）
    if (popups.length === 0) {
      return { outcome: 'done', message: '今天已领取每日签到奖励及福利礼包' }
    }
    let totalCredit = 0
    for (const popup of popups) {
      let complete
      try {
        const response = await fetch(`${AUTH_BASE}/client-popups/complete`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ popupId: popup.popupId, instanceKey: popup.instanceKey }),
          signal: AbortSignal.timeout(15_000),
        })
        const text = await response.text()
        if (!response.ok) return { outcome: 'failed', message: `领取失败（HTTP ${response.status}）` }
        complete = JSON.parse(text)
      } catch (error) {
        return { outcome: 'failed', message: `领取失败（网络异常）：${error.message}` }
      }
      const completeCode = typeof complete?.code === 'number' ? complete.code : parseInt(String(complete?.code ?? ''), 10)
      const completeMsg = typeof complete?.message === 'string' ? complete.message : String(complete?.desc ?? '')
      if (deadSession(completeCode, completeMsg)) {
        return { outcome: 'failed', message: 'AStudio 登录会话已失效，需人工重新登录' }
      }
      if (Number.isFinite(completeCode) && completeCode !== 0) {
        return { outcome: 'failed', message: `领取失败：${completeMsg || `code=${completeCode}`}` }
      }
      // 积分优先取 complete 响应，取不到再回退弹窗 payload
      const credit = pointsOf(complete?.data) > 0 ? pointsOf(complete?.data) : pointsOf(popup.payload)
      totalCredit += credit
    }
    return {
      outcome: 'claimed',
      credit: totalCredit > 0 ? totalCredit : undefined,
      message: popups.length > 1 ? `已领取 ${popups.length} 项福利` : undefined,
    }
  },

  /**
   * 额度分桶（移植 astudio-credits.ts 的 buildAstudioBalance）。
   *
   * `GET /points/balance`（只认 Cookie 的 ssoSessionId）。按**来源四分法**分桶：
   * 会员/购买/赠送积分（主池，total 取上游权威 `totalBalance` 而非逐包求和）
   * + 星火积分（**独立池**，缺席则不产出）。每池带 `*NextExpireTime` 到期时间 ——
   * ⚠️ 是**不带时区的本地时间串**（DSH 纪律：原样透出、不 Date.parse、不做比较），
   * 所以只拼进 name，不写 resetsAt（resetsAt 是 ISO 时刻，拼错时区会误导）。
   */
  async usage(credential) {
    const cookie = cookieHeader(credential)
    if (cookie.length === 0) {
      return [{ name: DISPLAY, used: 0, display: '未登录（缺少会话 Cookie）' }]
    }
    let body
    try {
      const response = await fetch(`${AUTH_BASE}/points/balance`, {
        method: 'GET',
        headers: { Accept: 'application/json', Cookie: cookie },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        return [{ name: DISPLAY, used: 0, display: `额度服务不可用（HTTP ${response.status}）` }]
      }
      body = JSON.parse(await response.text())
    } catch (error) {
      return [{ name: DISPLAY, used: 0, display: `额度服务不可用（网络异常）：${error.message}` }]
    }
    const code = typeof body?.code === 'number' ? body.code : parseInt(String(body?.code ?? ''), 10)
    const message = typeof body?.message === 'string' ? body.message : String(body?.desc ?? '')
    if (code === 80000 || (typeof message === 'string' && message.includes('登录异常，请重新登录'))) {
      return [{ name: DISPLAY, used: 0, display: '登录会话已失效，需重新登录' }]
    }
    if (Number.isFinite(code) && code !== 0) {
      return [{ name: DISPLAY, used: 0, display: `积分查询失败：${message || `code=${code}`}` }]
    }
    const data = typeof body?.data === 'object' && body.data !== null ? body.data : {}
    const int = (key) => {
      const v = data[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    }
    const str = (key) => (typeof data[key] === 'string' ? data[key] : '')
    const total = int('totalBalance')
    if (total === undefined) {
      return [{ name: DISPLAY, used: 0, display: '响应未包含余额字段' }]
    }
    const windows = []
    /**
     * 到期本地时间串 → ISO（按 +08:00 解析）。
     *
     * ⚠️ 上游给的是**不带时区的本地时间串**（DSH 侧按纪律原样透出）。但讯飞是
     * 国内服务，其「本地」就是 Asia/Shanghai —— 按东八区解析进 resetsAt 后，
     * magpie 的托盘面板才能像 ZCODE 那样显示「重置于 …」。形状不认就留空
     * （桶名里仍保留原文，信息不丢）。
     */
    const expiryIso = (text) => {
      const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(String(text ?? ''))
      if (m === null) return undefined
      return new Date(`${m[1]}T${m[2]}:${m[3] ?? '00'}+08:00`).toISOString()
    }
    const pushPool = (label, totalKey, balanceKey, expireKey) => {
      const remaining = int(balanceKey)
      if (remaining === undefined) return // 该池不下发 ⇒ 不臆造条目
      const poolTotal = int(totalKey) ?? remaining
      const expire = str(expireKey)
      const resetsAt = expiryIso(expire)
      const usedPercent = poolTotal > 0 ? Math.max(0, Math.min(100, Math.round(((poolTotal - remaining) / poolTotal) * 100))) : (remaining > 0 ? 0 : 100)
      windows.push({
        name: `AStudio · ${label}${expire !== '' ? ` · ${expire} 到期` : ''}`,
        used: usedPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        // 剩 0 的桶收进折叠区（aside）：主环位留给有值的桶 ——
        // 否则面板上两三个 0% 死环把「剩余 7000/60000」的好桶全挤掉
        ...(remaining <= 0 ? { aside: true } : {}),
        display: `剩余 ${remaining}`,
      })
    }
    pushPool('会员积分', 'memberTotal', 'memberBalance', 'memberNextExpireTime')
    pushPool('购买积分', 'buyTotal', 'buyBalance', 'buyNextExpireTime')
    pushPool('赠送积分', 'activityTotal', 'activityBalance', 'activityNextExpireTime')
    pushPool('星火积分（独立池）', 'sparkTotalAmount', 'sparkTotalBalance', 'sparkNextExpireTime')
    if (windows.length === 0) {
      // 上游只给合计、一个池都没下发：补一条让总额可见（与 DSH 同取舍）
      windows.push({ name: 'AStudio · 可用积分', used: 0, display: `剩余 ${total}` })
    }
    return windows
  },
}
