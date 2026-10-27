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
import { randomBytes } from 'node:crypto'
import { loadCredential, saveCredential, assignExpiryBands, debugLog } from './shared.mjs'

const PROVIDER = 'astudio'
const DISPLAY = 'AStudio（讯飞）'

/** 推理网关基址（OpenAI 兼容）。 */
const MAAS_BASE = 'https://astronstudio-api-volces-prod.xf-yun.com'
/** 账号后端基址（活体凭据权威源）。 */
const AUTH_BASE = 'https://agent.xfyun.cn/xingchen-studio'
/** SSO 基址（微信扫码三步流：qrcode → uids 轮询 → bind）。 */
const SSO_BASE = 'https://sso.xfyun.cn'

const CHAT_PATH = '/model-gateway/v1/chat/completions'
const CATALOG_PATH = '/api/v1/model-manager/models'
const BOT_CONFIGS_PATH = '/bot/models/configs'
const INIT_APP_PATH = '/tenant-app/v2/init-app'
const GEE_CAPTCHA_PATH = '/chat/gee-captcha'
const SEND_SMS_PATH = '/login/mobile/send-verify-code'
const PHONE_LOGIN_PATH = '/login/phone-quick-login'
const PASSWORD_LOGIN_PATH = '/login/check-account'

/** 微信扫码 fd 的字母表（DSH ASTUDIO_WECHAT_FD_ALPHABET 同款：去易混字符）。 */
const WECHAT_FD_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz23456789'

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

/**
 * 页面 HTML：三合一登录（短信 / 账号密码 / 微信扫码），交互照抄 DSH 载体页
 * （bind 模式、单次消费、可重试；微信 Tab 按需拉二维码 + 2s 轮询 /poll）。
 */
export function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 AStudio</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#eee;
     display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111}
.card{background:#1a1a1a;border-radius:12px;padding:24px;width:360px;max-width:90vw}
h2{margin:0 0 16px;font-size:18px;text-align:center}
.tabs{display:flex;gap:4px;background:#0d0d0d;border-radius:8px;padding:4px;margin-bottom:20px}
.tab-btn{flex:1;padding:8px 4px;font-size:13px;border:0;border-radius:6px;background:transparent;
         color:#9ca3af;cursor:pointer;transition:all .2s}
.tab-btn.active{background:#26334d;color:#60a5fa;font-weight:600}
.pane{display:none}.pane.active{display:block}
label{display:block;margin:14px 0 6px;font-size:12px;color:#9ca3af}
input{width:100%;padding:0 12px;height:38px;box-sizing:border-box;border:1px solid #333;
      border-radius:6px;background:#0d0d0d;color:#eee;font-size:14px;outline:none}
input:focus{border-color:#3b82f6}
button.primary{width:100%;height:38px;margin-top:8px;border:0;border-radius:6px;background:#3b82f6;
        color:#fff;font-size:14px;cursor:pointer}
button.primary:hover{background:#2563eb}
button.secondary{white-space:nowrap;padding:0 12px;height:38px;font-size:13px;border:1px solid #444;
        border-radius:6px;background:#26232a;color:#cbd5e1;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:8px}.row>div{flex:1}
.captcha-box{min-height:40px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;
     background:#0d0d0d;border:1px dashed #444;border-radius:6px;font-size:12px;color:#9ca3af;padding:6px 10px}
.captcha-ready{border-color:#34d399;color:#34d399;font-weight:500}
.qr-box{width:200px;height:200px;margin:10px auto;border:1px solid #333;border-radius:8px;
        display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fafafa}
.qr-box img{width:100%;height:100%;object-fit:contain}
.wechat-tip{font-size:12px;color:#9ca3af;text-align:center;margin:8px 0 0}
.tip{font-size:12px;color:#6b7280;text-align:center;margin-top:10px;line-height:1.4}
#msg{margin-top:14px;min-height:20px;font-size:13px;text-align:center;border-radius:4px;padding:4px;color:#9ca3af}
#msg.ok{color:#34d399;font-weight:500}#msg.err{color:#f87171}
</style></head><body>
<div class="card">
<h2>登录 AStudio</h2>
<div class="tabs">
  <button class="tab-btn active" data-tab="sms" type="button">手机验证码</button>
  <button class="tab-btn" data-tab="password" type="button">账号密码</button>
  <button class="tab-btn" data-tab="wechat" type="button">微信扫码</button>
</div>

<div class="pane active" id="pane-sms">
  <label>手机号</label><input id="mobile" placeholder="13800138000" autocomplete="tel" maxlength="11">
  <label>人机验证</label>
  <div class="captcha-box" id="smsCaptchaBox"><button class="secondary" id="smsCaptchaBtn" type="button">完成安全验证</button></div>
  <label>验证码</label>
  <div class="row"><div><input id="code" placeholder="6 位验证码" maxlength="6"></div>
    <div><button class="secondary" id="send" style="width:100%">获取验证码</button></div></div>
  <button class="primary" id="go">登 录</button>
  <div class="tip">未注册手机号验证通过后将自动完成注册开户</div>
</div>

<div class="pane" id="pane-password">
  <label>账号 / 手机号</label><input id="pwdAccount" placeholder="请输入账号或手机号" autocomplete="username">
  <label>密码</label><input id="pwdPassword" type="password" placeholder="请输入登录密码" autocomplete="current-password">
  <label>人机验证</label>
  <div class="captcha-box" id="pwdCaptchaBox"><button class="secondary" id="pwdCaptchaBtn" type="button">完成安全验证</button></div>
  <button class="primary" id="goPwd">登 录</button>
  <div class="tip">未注册账号请使用手机验证码快捷登录开户</div>
</div>

<div class="pane" id="pane-wechat">
  <div class="qr-box" id="qrBox"><span style="color:#666;font-size:12px">点击下方按钮加载二维码</span></div>
  <p class="wechat-tip">请打开微信扫描上方二维码进行登录</p>
  <div style="text-align:center;margin-top:8px">
    <button class="secondary" id="refreshQr" type="button" style="font-size:12px;height:30px">刷新二维码</button>
  </div>
</div>

<div id="msg"></div>
</div>
<script>
// ── Tab 切换（进微信 Tab 拉码并轮询，离开即停）──────────────────────────
let pollTimer = null, wechatFd = '';
const msg = (t, cls) => { const el = document.getElementById('msg'); el.textContent = t || ''; el.className = cls || '' };
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('pane-' + btn.dataset.tab).classList.add('active');
    msg('', '');
    if (btn.dataset.tab === 'wechat') loadQr(); else stopPoll();
  });
});

// ── 极验（bind 模式：每次新实例、单次消费、可重试）──────────────────────
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

/** 把「完成安全验证」按钮接到独立的一份 captcha 状态上（短信/密码各一份）。 */
function setupCaptcha(btnId, boxId) {
  const btn = document.getElementById(btnId);
  const box = document.getElementById(boxId);
  const state = { result: null };
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '正在拉起验证…';
    try {
      state.result = await triggerCaptcha();
      box.innerHTML = '<span class="captcha-ready">✓ 已完成安全验证</span>';
      btn.textContent = '重新验证';
    } catch (e) {
      state.result = null;
      box.innerHTML = '<button class="secondary" id="' + btnId + '" type="button">验证失败，重试</button>';
      box.querySelector('button').onclick = btn.onclick;
      msg(e.message || '安全验证失败', 'err');
      btn.textContent = '完成安全验证';
    }
    btn.disabled = false;
  };
  return state;
}
const smsCaptcha = setupCaptcha('smsCaptchaBtn', 'smsCaptchaBox');
const pwdCaptcha = setupCaptcha('pwdCaptchaBtn', 'pwdCaptchaBox');

// ── Tab 1：短信 ─────────────────────────────────────────────────────────
let sendCooldown = 0;
document.getElementById('send').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  if (!mobile) return msg('请填手机号', 'err');
  if (!smsCaptcha.result) return msg('请先完成人机安全验证', 'err');
  if (sendCooldown > 0) return;
  msg('正在发送验证码…');
  try {
    const r = await fetch('/sms/send', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile, geetestChallenge: smsCaptcha.result.geetestChallenge,
        geetestValidate: smsCaptcha.result.geetestValidate, geetestSeccode: smsCaptcha.result.geetestSeccode }) });
    const j = await r.json();
    if (j.ok) {
      msg(j.message || '验证码已发送', 'ok');
      sendCooldown = 60;
      const t = setInterval(() => {
        sendCooldown -= 1;
        document.getElementById('send').textContent = sendCooldown > 0 ? sendCooldown + 's' : '获取验证码';
        if (sendCooldown <= 0) clearInterval(t);
      }, 1000);
    } else {
      msg(j.message || '发送失败', 'err');
    }
  } catch (e) { msg('发送失败：' + e.message, 'err') }
  finally {
    // ⚠️ validate 一次性：消费后作废，要求重新滑一次（重发用旧值必失败）
    smsCaptcha.result = null;
    document.getElementById('smsCaptchaBox').innerHTML = '<button class="secondary" id="smsCaptchaBtn2" type="button">点击进行安全验证</button>';
    document.getElementById('smsCaptchaBtn2').onclick = document.getElementById('smsCaptchaBtn').onclick || null;
  }
};
document.getElementById('go').onclick = async () => {
  const mobile = document.getElementById('mobile').value.trim();
  const verifyCode = document.getElementById('code').value.trim();
  if (!mobile || !verifyCode) return msg('请填手机号和验证码', 'err');
  msg('登录中…');
  try {
    const r = await fetch('/sms/login', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ mobile, verifyCode }) });
    const j = await r.json();
    if (j.ok) msg('登录成功！可以关闭此页面返回', 'ok'); else msg(j.message || '登录失败', 'err');
  } catch (e) { msg('登录失败：' + e.message, 'err') }
};

// ── Tab 2：账号密码 ─────────────────────────────────────────────────────
document.getElementById('goPwd').onclick = async () => {
  const accountName = document.getElementById('pwdAccount').value.trim();
  const accountPwd = document.getElementById('pwdPassword').value;
  if (!accountName) return msg('请输入账号或手机号', 'err');
  if (!accountPwd) return msg('请输入密码', 'err');
  if (!pwdCaptcha.result) return msg('请先完成人机安全验证', 'err');
  msg('登录中…');
  try {
    const r = await fetch('/password/login', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ accountName, accountPwd,
        geetestChallenge: pwdCaptcha.result.geetestChallenge,
        geetestValidate: pwdCaptcha.result.geetestValidate,
        geetestSeccode: pwdCaptcha.result.geetestSeccode }) });
    const j = await r.json();
    if (j.ok) msg('登录成功！可以关闭此页面返回', 'ok'); else msg(j.message || '登录失败', 'err');
  } catch (e) { msg('登录失败：' + e.message, 'err') }
  finally {
    pwdCaptcha.result = null;
    document.getElementById('pwdCaptchaBox').innerHTML = '<span style="font-size:12px;color:#9ca3af">需重新验证</span>';
  }
};

// ── Tab 3：微信扫码（拉码 + 2s 轮询 /poll）───────────────────────────────
async function loadQr() {
  stopPoll();
  const box = document.getElementById('qrBox');
  box.innerHTML = '<span style="color:#666;font-size:12px">正在加载二维码…</span>';
  try {
    const r = await fetch('/wechat/qrcode');
    const j = await r.json();
    if (!j.ok || !j.qrUrl) throw new Error(j.message || '获取二维码失败');
    wechatFd = j.fd;
    box.innerHTML = '<img src="' + j.qrUrl + '" alt="微信二维码" />';
    startPoll();
  } catch (e) {
    box.innerHTML = '<span style="color:#f87171;font-size:12px">加载失败，请点击刷新</span>';
    msg(e.message, 'err');
  }
}
function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/poll');
      const j = await r.json();
      if (j.status === 'success') {
        stopPoll();
        msg('微信扫码登录成功！可以关闭此页面返回', 'ok');
      } else if (j.status === 'error' || j.status === 'unbound') {
        stopPoll();
        msg(j.message || '微信扫码登录失效，请刷新重试', 'err');
      }
    } catch (_) {}
  }, 2000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
document.getElementById('refreshQr').addEventListener('click', loadQr);
</script></body></html>`
}

/** 起本地 Carrier 服务，返回 loginUrl + result promise（对齐 DSH 的 startAstudioLoginFlow）。 */
async function startLoginFlow() {
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  /** 载体页流程状态（微信 Tab 当前二维码的 fd）。 */
  const state = { wechatFd: undefined }
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
      if (pathname === '/password/login') {
        const body = await readBody(req)
        const accountName = String(body.accountName ?? '').trim()
        const accountPwd = String(body.accountPwd ?? '')
        if (!accountName || !accountPwd) return sendJson(res, 400, { ok: false, message: '账号与密码不能为空' })
        if (!body.geetestChallenge || !body.geetestValidate || !body.geetestSeccode) {
          return sendJson(res, 400, { ok: false, message: '缺少极验验证参数（请先完成人机验证）' })
        }
        // POST /login/check-account（FormData：账号 + 密码 + 极验三件套，seccode base64）
        const form = new FormData()
        form.append('accountName', accountName)
        form.append('accountPwd', accountPwd)
        form.append('geetest_challenge', String(body.geetestChallenge))
        form.append('geetest_validate', String(body.geetestValidate))
        form.append('geetest_seccode', Buffer.from(String(body.geetestSeccode), 'utf8').toString('base64'))
        const r = await fetch(`${AUTH_BASE}${PASSWORD_LOGIN_PATH}`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!r.ok) return sendJson(res, 400, { ok: false, message: `密码登录请求失败（HTTP ${r.status}）` })
        const j = await r.json().catch(() => ({}))
        const code = j?.code
        if (code !== 0 && code !== undefined && code !== '0') {
          return sendJson(res, 400, { ok: false, message: `密码登录失败：${j?.desc ?? j?.message ?? j?.msg ?? `code=${code}`}` })
        }
        const d = j?.data && typeof j.data === 'object' ? j.data : j
        const uid = String(d?.uid ?? d?.account_id ?? '')
        const ssoSessionId = String(d?.ssoSessionId ?? d?.token ?? '')
        // ⚠️ 三入口同款容错：uid 与 ssoSessionId 互为备选，至少一个即可
        if (!uid && !ssoSessionId) {
          return sendJson(res, 400, { ok: false, message: '密码登录响应中缺少必要的会话标识' })
        }
        const credential = await completeLogin({
          uid: uid || ssoSessionId,
          ssoSessionId: ssoSessionId || uid,
          token: d?.token ? String(d.token) : (ssoSessionId || uid),
          accountId: String(d?.accountId ?? d?.account_id ?? (uid || ssoSessionId)),
          nickname: d?.nickname ? String(d.nickname) : undefined,
          username: accountName,
          loginMethod: 'password',
        })
        sendJson(res, 200, { ok: true, message: '登录成功' })
        clearTimeout(timer)
        settleOk(credential)
        setTimeout(() => void closeServer(), 500)
        return
      }
      if (pathname === '/wechat/qrcode') {
        // GET sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd=…（fd = 8 字符随机串）
        const fd = Array.from(randomBytes(8), (b) => WECHAT_FD_ALPHABET[b % WECHAT_FD_ALPHABET.length]).join('')
        const r = await fetch(`${SSO_BASE}/SSOService/wx/scanlogin/qrcode?fd=${encodeURIComponent(fd)}`, {
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          signal: AbortSignal.timeout(15_000),
        })
        if (!r.ok) return sendJson(res, 500, { ok: false, message: `获取微信二维码失败（HTTP ${r.status}）` })
        const text = await r.text()
        let j
        try { j = JSON.parse(text) } catch {
          return sendJson(res, 500, { ok: false, message: '获取微信二维码失败（响应不是 JSON）' })
        }
        if (j?.code !== 0 && j?.code !== '0') {
          return sendJson(res, 500, { ok: false, message: `获取微信二维码失败：${j?.desc ?? j?.message ?? j?.code}` })
        }
        const qrUrl = typeof j?.data === 'string' ? j.data : ''
        if (!qrUrl) return sendJson(res, 500, { ok: false, message: '获取微信二维码失败：未返回二维码 URL' })
        state.wechatFd = fd
        return sendJson(res, 200, { ok: true, qrUrl, fd })
      }
      if (pathname === '/poll') {
        if (!state.wechatFd) return sendJson(res, 200, { status: 'pending', message: '未获取二维码' })
        const fd = state.wechatFd
        const r = await fetch(`${SSO_BASE}/SSOService/wx/scanlogin/uids?fd=${encodeURIComponent(fd)}`, {
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          signal: AbortSignal.timeout(15_000),
        })
        if (!r.ok) return sendJson(res, 500, { status: 'error', message: `轮询扫码状态失败（HTTP ${r.status}）` })
        const j = await r.json().catch(() => null)
        if (j === null) return sendJson(res, 500, { status: 'error', message: '轮询扫码状态失败（响应不是 JSON）' })
        const code = j?.code
        if (code === -1 || code === '-1') {
          return sendJson(res, 200, { status: 'pending', message: typeof j?.desc === 'string' ? j.desc : '未扫码' })
        }
        if (code === 0 || code === '0') {
          // 账号提取：data 可能是数组，或 {infoList:[]}
          const rows = Array.isArray(j?.data) ? j.data
            : Array.isArray(j?.data?.infoList) ? j.data.infoList : []
          const accounts = []
          for (const item of rows) {
            if (typeof item !== 'object' || item === null) continue
            const uid = String(item.uid ?? item.accountId ?? '').trim()
            // ⚠️ 三入口同款容错（DSH 2026-10-20 报障修正）：ssoSessionId 兜底链
            //    ssoSessionId → sso_session_id → token → uid，至少一个标识即可；
            //    但不得产出全空账号（半截凭据会让后续每个请求都 80000）
            const ssoSessionId = String(item.ssoSessionId ?? item.sso_session_id ?? item.token ?? uid).trim() || uid
            if (uid || ssoSessionId) {
              accounts.push({ uid: uid || ssoSessionId, ssoSessionId: ssoSessionId || uid })
            }
          }
          if (accounts.length === 0) {
            // ⚠️ code=0 的 desc 是「成功」（信封状态）≠ 有账号。infoList 空 =
            //    该微信号未开通 AStudio —— 真出路是去 AStudio 客户端绑定手机号
            //    完成开通，「重新扫码」是假出路（同一个号再扫还是空）。
            return sendJson(res, 200, {
              status: 'unbound',
              message: '该微信号尚未开通 AStudio 账号 ⇒ 请先在 AStudio 客户端里用该微信登录并绑定手机号完成开通，再回来扫码',
            })
          }
          const account = accounts[0]
          // bind（尽力而为，失败不阻断 —— 会话已在扫码侧建立）
          const bindForm = new URLSearchParams({
            fd, accountId: account.uid,
            ...(account.ssoSessionId ? { ssoSessionId: account.ssoSessionId } : {}),
            isNew: 'false',
          })
          await fetch(`${SSO_BASE}/SSOService/wx/scanlogin/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: bindForm.toString(),
            signal: AbortSignal.timeout(15_000),
          }).catch(() => {})
          const credential = await completeLogin({ ...account, loginMethod: 'wechat' })
          debugLog(`astudio wechat: 登录完成，settle（${credential.accountId}）`)
          sendJson(res, 200, { status: 'success', message: '登录成功' })
          clearTimeout(timer)
          settleOk(credential)
          setTimeout(() => void closeServer(), 500)
          return
        }
        return sendJson(res, 200, { status: 'error', code: String(code), message: j?.desc ?? String(code) })
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
     * 到期本地时间串 → 毫秒（按 +08:00 解析）。
     *
     * ⚠️ 上游给的是**不带时区的本地时间串**（DSH 侧按纪律原样透出）。但讯飞是
     * 国内服务，其「本地」就是 Asia/Shanghai —— 按东八区解析成确定时刻后，
     * ①写进 resetsAt（托盘面板显示「重置于 …」，对齐 ZCODE）；②参与滚动指针
     * 分档。形状不认就返回 undefined（该桶按永久处理，原文信息不丢）。
     */
    const expiryMs = (text) => {
      const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(String(text ?? ''))
      if (m === null) return undefined
      return Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}+08:00`)
    }
    const buckets = []
    const pushPool = (label, totalKey, balanceKey, expireKey) => {
      const remaining = int(balanceKey)
      if (remaining === undefined) return // 该池不下发 ⇒ 不臆造条目
      const poolTotal = int(totalKey) ?? remaining
      const expireRaw = str(expireKey)
      buckets.push({
        label,
        remaining,
        poolTotal,
        expireRaw,
        expireMs: expiryMs(expireRaw),
      })
    }
    pushPool('会员积分', 'memberTotal', 'memberBalance', 'memberNextExpireTime')
    pushPool('购买积分', 'buyTotal', 'buyBalance', 'buyNextExpireTime')
    pushPool('赠送积分', 'activityTotal', 'activityBalance', 'activityNextExpireTime')
    pushPool('星火积分（独立池）', 'sparkTotalAmount', 'sparkTotalBalance', 'sparkNextExpireTime')
    // 滚动指针分档（shared.mjs 的 assignExpiryBands）：临期 = 最早到期的未耗尽桶
    assignExpiryBands(buckets)
    for (const bucket of buckets) {
      const usedPercent = bucket.poolTotal > 0
        ? Math.max(0, Math.min(100, Math.round(((bucket.poolTotal - bucket.remaining) / bucket.poolTotal) * 100)))
        : (bucket.remaining > 0 ? 0 : 100)
      const expiryShort = bucket.expireRaw !== ''
        ? bucket.expireRaw.replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$2-$3')
        : undefined
      windows.push({
        // 渠道前缀由聚合层统一加（usageWindowsOf）—— 这里只写桶本身的语义
        name: `${bucket.label} · ${bucket.band}`,
        used: usedPercent,
        // ⚠️ 刻意不挂 runsOutAt：亮色层已带时间（band 名「临期·N天」+ display
        // 绝对日期），再挂会多一行浅灰重复（与 autoclaw 同款去重 —— 用户报障）
        // 剩 0 的桶收进折叠区（aside）：主环位留给有值的桶
        ...(bucket.remaining <= 0 ? { aside: true } : {}),
        display: `剩余 ${bucket.remaining}${expiryShort !== undefined ? ` · ${expiryShort} 到期` : ''}`,
      })
    }
    if (windows.length === 0) {
      // 上游只给合计、一个池都没下发：补一条让总额可见（与 DSH 同取舍）
      windows.push({ name: '可用积分', used: 0, display: `剩余 ${total}` })
    }
    return windows
  },
}
