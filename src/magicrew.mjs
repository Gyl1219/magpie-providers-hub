// Magicrew · 超级麦吉（letsmagic.cn） / MagiCrew（magicrew.ai）
//
// 一个产品两套云，协议相同、宿主不同、模型不同 —— 本文件导出两个渠道。
//
// ═══ 协议（来自 MYCF711/magpie-magicrew-auth 实机核对）══════════════
// 业务 API   <host>/api/v1/...    要网页 JWT（Bearer）+ organization-code 头
// 模型网关   <host>/v1/...        OpenAI 兼容，要 mgw_ api_key（Bearer）
//
// 三层凭证（有效期完全不同）：
//   ① 网页登录 JWT    30 天
//   ② mgw_ api_key    2 小时   ← 每次请求前若将过期就续
//   ③ refresh_token   7 天，PUT 一次轮换一次（一次性，必须串行）
// ⇒ 登录一次拿 ①，之后 30 天全靠 ③ 自动滚。
//
// 关键端点：
//   POST /api/v1/sessions             手机号+密码登录 → { token, organization_code }
//   POST /api/v1/model-gateway/tokens 签发 api_key（body {}）
//   PUT  /api/v1/model-gateway/tokens { refresh_token } → 新 api_key + 新 refresh_token
//   GET  /api/v1/quota/points/total   积分余额（total_points / expiring_quota_details）
//   GET  /api/v1/flows/models         账号当前能选的模型（value/label/vision）
//   POST <host>/v1/chat/completions   OpenAI 兼容对话（Bearer mgw_ api_key）
//
// 精简版取舍：不含任务系统 / 邀请码 / 剪贴板 / CDP 浏览器登录。
// 登录支持两条路：手机号+密码（API 直连）、或直接粘贴 JWT + 组织码。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

import { assignExpiryBands } from './shared.mjs'

const REQUEST_TIMEOUT_MS = 30_000
/** api_key 只活 2 小时，提前 10 分钟续。 */
const REFRESH_LEAD_MS = 10 * 60_000
/** 登录窗 10 分钟。 */
const LOGIN_WINDOW_MS = 10 * 60_000

export const SITES = {
  cn: {
    id: 'magicrew',
    displayName: '超级麦吉 (MagiCrew 国内)',
    web: 'https://www.letsmagic.cn',
    host: 'https://i-magic-service.letsmagic.cn',
    /** 每日登录赠送（POST /api/v1/login-gift，当天 23:59:59 到期不累积） */
    dailyGrant: 200,
  },
  intl: {
    id: 'magicrew-intl',
    displayName: 'MagiCrew (国际版)',
    web: 'https://www.magicrew.ai',
    // ⚠ 国际站 host 是 magic-service.magicrew.ai（**无** i- 前缀）——
    //   来源：www.magicrew.ai/workspace 内嵌 MAGIC_SERVICE_BASE_URL。
    //   api.magicrew.ai 是 teamshare 网关，对 /api/v1/* 回 "not match rule path"，别用。
    host: 'https://magic-service.magicrew.ai',
    dailyGrant: 50,
  },
}

// ── HTTP 基础 ────────────────────────────────────────────────────────

class MagicrewError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'MagicrewError'
    Object.assign(this, extra)
  }
}

/** 业务请求头：JWT + organization-code（网关会看 Origin，缺了偶发 403）。 */
function headersFor(site, token, org) {
  const h = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': UA,
    accept: 'application/json',
    origin: site.web,
  }
  if (org) h['organization-code'] = org
  return h
}

/** 统一读包：HTTP 非 2xx 或业务 code != 1000 都抛错。 */
async function readBody(res) {
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { message: text.slice(0, 200) }
  }
  if (!res.ok) {
    throw new MagicrewError(body?.message || `HTTP ${res.status}`, { status: res.status, code: body?.code })
  }
  // magic 业务码：1000 = ok，其它当错（有的端点干脆无 code，放过）
  if (body && typeof body.code === 'number' && body.code !== 1000 && body.code !== 0) {
    throw new MagicrewError(body?.message || `业务错误码 ${body.code}`, { code: body.code })
  }
  return body
}

async function jsonRequest(url, { method = 'GET', headers, body, signal } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return readBody(res)
}

// ── 登录（手机号 + 密码）────────────────────────────────────────────

async function login({ site, phone, password, stateCode = '+86', organizationCode = '' }) {
  const body = await jsonRequest(`${site.host}/api/v1/sessions`, {
    method: 'POST',
    headers: headersFor(site, '', organizationCode),
    body: JSON.stringify({
      type: 'phone_password',
      phone: String(phone || '').replace(/[^\d]/g, ''),
      password: password || '',
      state_code: stateCode || '+86',
      organization_code: organizationCode || '',
      email: '',
      redirect: '',
      invite_code: '',
    }),
  })
  const d = body?.data ?? body
  // 字段名官方文档没有 —— 三种写法都兜住
  const token = d?.token || d?.access_token || d?.accessToken || d?.jwt || ''
  if (!token) throw new MagicrewError('登录成功但没拿到 token')
  return {
    token,
    organizationCode: d?.organization_code || d?.organizationCode || organizationCode || '',
    nickname: d?.name || d?.nickname || d?.phone || phone || undefined,
  }
}

// ── 模型网关 key：签发 / 续期 ────────────────────────────────────────
// ⚠ 这些是模块级函数，site 由调用方（渠道闭包）传入 —— 凭据里**不放** site，
//   否则 site 对象会被一起序列化进 magpie 账号槽 / sidecar（冗余）。

async function issueGatewayKey(site, credential) {
  const { token, organizationCode } = credential
  const body = await jsonRequest(`${site.host}/api/v1/model-gateway/tokens`, {
    method: 'POST',
    headers: headersFor(site, token, organizationCode),
    body: '{}',
  })
  const d = body?.data ?? {}
  if (!d.api_key) throw new MagicrewError('签发密钥失败：没有 api_key')
  return {
    apiKey: d.api_key,
    refreshToken: d.refresh_token,
    apiKeyExpiresAt: d.api_key_expires_at,
    refreshTokenExpiresAt: d.refresh_token_expires_at,
  }
}

/** refresh_token 换新 api_key；refresh_token 轮换（一次性，串行调用）。 */
async function refreshGatewayKey(site, credential) {
  const { refreshToken } = credential
  if (!refreshToken) throw new MagicrewError('无 refresh_token，需重新登录')
  const body = await jsonRequest(`${site.host}/api/v1/model-gateway/tokens`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: site.web },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const d = body?.data ?? {}
  if (!d.api_key) throw new MagicrewError('续期失败：没有 api_key')
  return {
    apiKey: d.api_key,
    refreshToken: d.refresh_token || refreshToken,
    apiKeyExpiresAt: d.api_key_expires_at,
    refreshTokenExpiresAt: d.refresh_token_expires_at,
  }
}

// ── 积分额度 ─────────────────────────────────────────────────────────

async function fetchPoints(site, credential) {
  const { token, organizationCode } = credential
  const body = await jsonRequest(`${site.host}/api/v1/quota/points/total`, {
    headers: headersFor(site, token, organizationCode),
  })
  const d = body?.data ?? {}
  return {
    total: Number(d.total_points ?? 0),
    expiring: (d.expiring_quota_details ?? []).map((q) => ({
      points: Number(q.remaining_points ?? 0),
      expiresAt: q.expires_at,
    })),
    nextGrant: d.next_cycle_grant ?? null,
  }
}

// ── 模型 ─────────────────────────────────────────────────────────────

async function fetchModels(site, credential) {
  const { token, organizationCode } = credential
  const body = await jsonRequest(`${site.host}/api/v1/flows/models`, {
    headers: headersFor(site, token, organizationCode),
  })
  const list = body?.data?.models ?? []
  return list.map((m) => ({
    id: String(m.value ?? ''),
    name: String(m.label || m.value || '').trim(),
    vision: !!m.vision,
  })).filter((m) => m.id)
}

// ── 签到（每日登录赠送 + 新手福利任务）───────────────────────────────
// 协议（MYCF711/magpie-magicrew-auth 实测）：
//   POST /api/v1/login-gift                              无请求体 → {granted, point_amount, message}
//     · 幂等：当天已领过 → granted:false（HTTP 仍 200），可每天无脑调
//     · 国内 +200/天、国际 +50/天，奖励进当天 23:59:59 到期的额度包
//   GET  /api/v1/onboarding/tasks                        → data.tasks[]（code/title/points/status/reward_status）
//   PUT  /api/v1/onboarding/tasks/{code}/completion      body {} → data.points；9303 = 不支持手动完成
//   ⚠ 两套机制独立：每日登录赠送 ≠ 新手福利（国际站 tasks 恒空，靠它领不到每日赠送）

async function claimLoginGift(site, credential) {
  const body = await jsonRequest(`${site.host}/api/v1/login-gift`, {
    method: 'POST',
    headers: headersFor(site, credential.token, credential.organizationCode),
    body: '',
  })
  const d = body?.data ?? {}
  return { granted: Boolean(d.granted), points: Number(d.point_amount ?? 0), message: String(d.message ?? '') }
}

async function fetchOnboardingTasks(site, credential) {
  const body = await jsonRequest(`${site.host}/api/v1/onboarding/tasks`, {
    headers: headersFor(site, credential.token, credential.organizationCode),
  })
  return (body?.data?.tasks ?? []).map((t) => ({
    code: String(t.code ?? ''),
    title: String(t.title ?? t.code ?? ''),
    points: Number(t.points ?? 0),
    status: t.status,
    rewardStatus: t.reward_status,
  })).filter((t) => t.code)
}

async function completeOnboardingTask(site, credential, code) {
  return jsonRequest(`${site.host}/api/v1/onboarding/tasks/${encodeURIComponent(code)}/completion`, {
    method: 'PUT',
    headers: headersFor(site, credential.token, credential.organizationCode),
    body: '{}',
  })
}



/** 用 ctx = { site, ... } 造一个渠道对象，符合 providers-hub 的渠道契约。 */
export function makeChannel(site) {
  const CHANNEL_ID = site.id
  const DISPLAY_NAME = site.displayName

  /** 承载页 HTML：一键浏览器登录（推荐）/ 手机号+密码 / 粘贴 JWT。 */
  function renderLoginPage() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 ${DISPLAY_NAME}</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:460px;margin:40px auto;padding:0 20px}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#888;font-size:12px;margin-bottom:20px}
  label{display:block;font-size:12px;color:#666;margin:14px 0 4px}
  input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ccc;border-radius:8px;font-size:14px}
  button{width:100%;padding:11px;margin-top:16px;border:0;border-radius:8px;background:#0ea5e9;color:#fff;font-size:15px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .big{padding:14px;font-size:16px;background:#16a34a}
  .err{color:#e11d48;font-size:13px;margin-top:12px;min-height:18px}
  .ok{color:#16a34a;font-size:13px;margin-top:12px}
  .hint{color:#888;font-size:12px;margin-top:8px;line-height:1.6}
  details{margin-top:22px}
  summary{cursor:pointer;color:#666;font-size:13px}
  .sep{margin:22px 0 6px;border-top:1px solid #ddd;padding-top:14px;color:#999;font-size:12px}
</style></head><body>
<h1>登录 ${DISPLAY_NAME}</h1>
<div class="sub">${site.web}</div>

<button id="browser" class="big">① 一键浏览器登录（推荐）</button>
<div class="hint">点它 → 弹出浏览器窗口 → 在里面用微信 / 手机号 / Google / 邮箱 / 飞书 登录 → 登录完成自动接上，无需回来点任何按钮。</div>
<div class="err" id="err"></div>

<div class="sep">或</div>

<label>手机号</label>
<input id="phone" inputmode="numeric" placeholder="不带国家码">
<label>密码</label>
<input id="password" type="password" placeholder="登录密码">
<button id="go">② 手机号 + 密码登录</button>

<details>
  <summary>③ 或者直接粘贴 JWT + 组织码</summary>
  <div class="hint">打开 ${site.web} 并登录，F12 → Network 取 <code>authorization</code>（Bearer 后的 JWT）与 <code>organization-code</code>。</div>
  <label>JWT</label>
  <input id="jwt" placeholder="eyJ...">
  <label>组织码 organization-code</label>
  <input id="org" placeholder="organization-code">
  <button id="go-jwt" style="background:#475569">用 JWT 登录</button>
</details>

<script>
const $ = (id) => document.getElementById(id)
const errEl = $('err')
const err = (m) => { errEl.textContent = m }
const okScreen = () => { document.body.innerHTML = '<h1>登录成功</h1><div class="ok">可以关闭此页面返回 magpie</div>' }
async function post(path, body) {
  const r = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body || {}) })
  return r.json()
}
$('browser').addEventListener('click', async () => {
  $('browser').disabled = true
  err('已弹出浏览器，请在里面完成登录…（登录成功后这里会自动跳转）')
  try {
    const r = await post('/api/browser-login')
    if (!r.ok) throw new Error(r.message || '浏览器登录失败')
    okScreen()
  } catch (e) { err(e.message); $('browser').disabled = false }
})
$('go').addEventListener('click', async () => {
  const phone = $('phone').value.trim(), password = $('password').value
  if (!phone || !password) return err('填手机号和密码')
  $('go').disabled = true; err('登录中…')
  try {
    const r = await post('/api/login', { phone, password })
    if (!r.ok) throw new Error(r.message || '登录失败')
    okScreen()
  } catch (e) { err(e.message) } finally { $('go').disabled = false }
})
$('go-jwt').addEventListener('click', async () => {
  const token = $('jwt').value.trim(), organizationCode = $('org').value.trim()
  if (!token) return err('填 JWT')
  err('校验中…')
  try {
    const r = await post('/api/login-jwt', { token, organizationCode })
    if (!r.ok) throw new Error(r.message || 'JWT 无效')
    okScreen()
  } catch (e) { err(e.message) }
})
</script>
</body></html>`
  }

  /**
   * 载体页登录：起一个本机 HTTP 服务。三条路：
   *   ① 一键浏览器登录（CDP 拉起 Chrome，读 localStorage）
   *   ② 手机号 + 密码（调 API）
   *   ③ 粘贴 JWT + 组织码
   */
  async function beginLogin(openBrowser) {
    const { createServer } = await import('node:http')
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
    timer = setTimeout(() => settle(false, new Error(`${DISPLAY_NAME} 登录超时（10 分钟无操作）`)), LOGIN_WINDOW_MS)

    const sendJson = (res, status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }

    server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      try {
        if (pathname === '/' || pathname === '/login') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(renderLoginPage())
          return
        }
        if (pathname === '/api/login') {
          const body = await new Response(req).json().catch(() => ({}))
          const loginResult = await login({
            site,
            phone: String(body.phone ?? ''),
            password: String(body.password ?? ''),
          })
          // 登录成功后立刻签发 api_key，做成完整凭据（凭据里不放 site）
          const gw = await issueGatewayKey(site, { token: loginResult.token, organizationCode: loginResult.organizationCode })
          sendJson(res, 200, { ok: true })
          settle(true, {
            token: loginResult.token,
            organizationCode: loginResult.organizationCode,
            nickname: loginResult.nickname,
            apiKey: gw.apiKey,
            refreshToken: gw.refreshToken,
            apiKeyExpiresAt: gw.apiKeyExpiresAt,
            refreshTokenExpiresAt: gw.refreshTokenExpiresAt,
          })
          return
        }
        if (pathname === '/api/login-jwt') {
          const body = await new Response(req).json().catch(() => ({}))
          const token = String(body.token ?? '').trim()
          const organizationCode = String(body.organizationCode ?? '').trim()
          // 校验：拉一次积分（能读到说明 JWT 有效）
          await fetchPoints(site, { token, organizationCode })
          const gw = await issueGatewayKey(site, { token, organizationCode })
          sendJson(res, 200, { ok: true })
          settle(true, {
            token,
            organizationCode,
            nickname: undefined,
            apiKey: gw.apiKey,
            refreshToken: gw.refreshToken,
            apiKeyExpiresAt: gw.apiKeyExpiresAt,
            refreshTokenExpiresAt: gw.refreshTokenExpiresAt,
          })
          return
        }
        if (pathname === '/api/browser-login') {
          // 一键浏览器登录：拉起 Chrome → 等 localStorage 里的 jwt+org → 关窗 → 签发 key
          const { launchLoginBrowser, waitForCreds, closeSession } = await import('./magicrew-browser.mjs')
          let session
          try {
            // 直接开到登录页（/login 实测 200），省得用户再找入口
            session = await launchLoginBrowser(`${site.web}/login`)
            // 页面可能落在任意子域，用根域匹配 target（letsmagic.cn / magicrew.ai）
            const hostFragment = new URL(site.web).hostname.replace(/^www\./, '')
            const creds = await waitForCreds(session, hostFragment, { timeout: 300_000 })
            if (!creds) throw new Error('浏览器登录超时（5 分钟内未检测到登录完成）')
            const { jwt, org, name } = creds
            // 用读到的 JWT 签发 api_key
            const gw = await issueGatewayKey(site, { token: jwt, organizationCode: org })
            sendJson(res, 200, { ok: true })
            settle(true, {
              token: jwt,
              organizationCode: org,
              nickname: name || undefined,
              apiKey: gw.apiKey,
              refreshToken: gw.refreshToken,
              apiKeyExpiresAt: gw.apiKeyExpiresAt,
              refreshTokenExpiresAt: gw.refreshTokenExpiresAt,
            })
          } finally {
            void closeSession(session)
          }
          return
        }
        sendJson(res, 404, { ok: false, message: 'not found' })
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error?.message ?? String(error) })
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const url = `http://127.0.0.1:${port}/login`
    try { openBrowser?.(url) } catch { /* ignore */ }
    return { url, result }
  }

  /** 若 api_key 快过期（或没签过），续期/签发。refresh_token 一次性，串行。 */
  async function ensureApiKey(credential) {
    const now = Date.now()
    const exp = Number(credential?.apiKeyExpiresAt)
    const hasKey = typeof credential?.apiKey === 'string' && credential.apiKey !== ''
    const fresh = hasKey && (!Number.isFinite(exp) || exp - now > REFRESH_LEAD_MS)
    if (fresh) return credential
    if (credential?.refreshToken) {
      const gw = await refreshGatewayKey(site, credential)
      return { ...credential, ...gw }
    }
    // 没 refresh_token（如 JWT 登录但签发失败）：用 JWT 重新签
    if (credential?.token) {
      const gw = await issueGatewayKey(site, credential)
      return { ...credential, ...gw }
    }
    throw new MagicrewError('凭据已失效，请重新登录')
  }

  /**
   * 签到 = ① 每日登录赠送（+dailyGrant/天，幂等）+ ② 新手福利任务（一次性），
   * ③ 复读积分报净变化。语义照原插件 runCheckin。
   * ⚠️ first_ai_work 精简版**不做**：原插件会替账号真的建项目+发消息；
   *   PUT 它回 9303（不支持手动完成）→ 归入「需手动」。
   */
  async function checkin(credential) {
    let before
    try { before = (await fetchPoints(site, credential)).total }
    catch (e) { return { outcome: 'failed', message: `读不到积分：${e?.message ?? e}` } }

    const parts = []
    let claimedAnything = false
    let failed = false

    // ① 每日登录赠送（幂等 —— 已领过 granted:false，不是错误）。
    //   ⚠️ granted:false = 今日的赠送**已经入账**（登录时自动领）—— 如实报 claimed
    //   + 今日额度：magpie 对 done/inactive 渲染成黄/灰「稍后再问」，用户报障
    //   「明明领到了为啥不显示成功」。
    let todayCredit = 0
    try {
      const gift = await claimLoginGift(site, credential)
      if (gift.granted) { claimedAnything = true; todayCredit += gift.points; parts.push(`每日登录 +${gift.points}`) }
      else { claimedAnything = true; todayCredit += site.dailyGrant; parts.push(`每日登录已领过（今日 +${site.dailyGrant} 已入账）`) }
    } catch (e) { failed = true; parts.push(`每日登录失败：${e?.message ?? e}`) }

    // ② 新手福利任务（一次性）
    try {
      const tasks = await fetchOnboardingTasks(site, credential)
      if (tasks.length === 0) {
        parts.push('无新手任务')
      } else {
        const pending = tasks.filter((t) => t.status !== 'COMPLETED' && t.rewardStatus !== 'GRANTED')
        if (pending.length === 0) parts.push(`新手福利 ${tasks.length} 项均已领完`)
        else {
          let ok = 0
          const skipped = []
          const errs = []
          for (const t of pending) {
            if (t.code === 'first_ai_work') { skipped.push(t.title); continue }
            try {
              await completeOnboardingTask(site, credential, t.code)
              ok++
              claimedAnything = true
            } catch (e) {
              if (String(e?.code) === '9303') skipped.push(t.title)
              else errs.push(`${t.title}：${e?.message ?? e}`)
            }
            await new Promise((r) => setTimeout(r, 400)) // 服务端限流留余地
          }
          if (ok > 0) parts.push(`新手福利完成 ${ok} 项`)
          if (skipped.length) parts.push(`需手动：${skipped.join('、')}`)
          if (errs.length) { failed = true; parts.push(`新手福利失败：${errs.join('；')}`) }
        }
      }
    } catch (e) { failed = true; parts.push(`新手任务读取失败：${e?.message ?? e}`) }

    // ③ 复读积分，报净变化。credit：本次净增优先；无净增（都领过了）时报
    //   今日已入账的每日赠送 —— 让 magpie 显示绿色「今日已签到 +N」而不是黄/灰。
    let after = before
    try { after = (await fetchPoints(site, credential)).total } catch { /* 读不到按无变化 */ }
    const gained = Math.max(0, after - before)
    if (gained > 0) claimedAnything = true
    const credit = gained > 0 ? gained : todayCredit
    const head = gained > 0 ? `积分 +${gained}（${before} → ${after}）` : `积分 ${after}（本次无变动）`
    return {
      outcome: claimedAnything ? 'claimed' : failed ? 'failed' : 'done',
      ...(credit > 0 ? { credit } : {}),
      message: [head, ...parts].join('。'),
    }
  }

  async function usage(credential) {
    try {
      const points = await fetchPoints(site, credential)
      const nowMs = Date.now()
      // ── 滚动指针分档（shared.mjs 的 assignExpiryBands）+ **长期合并** ──
      // 每个到期积分包先成一个桶；「临期」= 最早到期的未耗尽桶（FEFO 头）单独显示
      // —— 服务端正在扣的就是它。⚠️ 其余**长期包合并成一个窗口**（用户定案：
      // 「长期分那么多包干嘛？合并」—— 新手任务/活动奖励每笔各成一包，一条条列
      // 出来一屏全是黄胶囊）。合并窗 display 照 AutoClaw：「共 K 批 · 最早 MM-DD 到期」。
      const endOfToday = new Date(nowMs)
      endOfToday.setHours(23, 59, 59, 0)
      const eodMs = endOfToday.getTime()
      const isDailyGrant = (q) => {
        const ms = isoMs(q.expiresAt)
        return ms !== undefined && Math.abs(ms - eodMs) <= 60_000 // 当天 23:59:59
      }
      const buckets = []
      for (const q of points.expiring) {
        buckets.push({
          label: isDailyGrant(q) ? '每日赠送' : '积分包',
          remaining: q.points,
          expireMs: isoMs(q.expiresAt),
          expireRaw: q.expiresAt,
        })
      }
      const expiringSum = points.expiring.reduce((s, q) => s + q.points, 0)
      const permanent = Math.max(0, points.total - expiringSum)
      if (permanent > 0) {
        buckets.push({ label: '积分余额', remaining: permanent, expireMs: undefined, expireRaw: '' })
      }
      assignExpiryBands(buckets, nowMs)

      const shortDate = (v) => {
        const ms = isoMs(v)
        return ms === undefined ? undefined : fmtDate(ms)
      }
      const windows = []
      // ① 临期指针单独显示（最早到期的未耗尽桶）
      const pointer = buckets.find((b) => typeof b.band === 'string' && b.band.startsWith('临期'))
      if (pointer !== undefined) {
        const expiryShort = shortDate(pointer.expireRaw)
        windows.push({
          name: `${pointer.label} · ${pointer.band}`,
          used: 0,
          display: `剩余 ${pointer.remaining}${expiryShort !== undefined ? ` · ${expiryShort} 到期` : ''}`,
        })
      }
      // ② 长期包合并成一个窗口（多批带批数 + 最早到期；单批带自己的到期日）
      const longs = buckets.filter((b) => b.band === '长期')
      if (longs.length > 0) {
        const sum = longs.reduce((s, b) => s + b.remaining, 0)
        const earliestMs = longs.map((b) => b.expireMs).filter(Number.isFinite).sort((a, b) => a - b)[0]
        const tail = longs.length > 1
          ? ` · 共 ${longs.length} 批 · 最早 ${fmtDate(earliestMs)} 到期`
          : ` · ${fmtDate(earliestMs)} 到期`
        windows.push({ name: '积分包 · 长期', used: 0, display: `剩余 ${sum}${tail}` })
      }
      // ③ 永久余额单独
      for (const b of buckets.filter((x) => x.band === '永久')) {
        windows.push({ name: `${b.label} · 永久`, used: 0, display: `剩余 ${b.remaining}` })
      }
      // ④ 已耗尽 → aside 折叠（不占主位）
      for (const b of buckets.filter((x) => x.band === '已耗尽')) {
        windows.push({ name: `${b.label} · 已耗尽`, used: 100, aside: true, display: `剩余 ${b.remaining}` })
      }
      if (windows.length === 0) windows.push({ name: '积分余额', used: 0, display: `剩余 ${points.total}` })
      return windows
    } catch (error) {
      const expired = /401|403|token|登录|会话|失效|unauthor/i.test(error?.message ?? '')
      return [{ name: DISPLAY_NAME, used: 0, display: expired ? '登录会话已失效，需重新登录' : `积分查询失败：${error?.message ?? error}` }]
    }
  }

  async function refresh(credential) {
    // 续期就是换 api_key（refresh_token 轮换）。返回更新后的完整凭据。
    const next = await ensureApiKey(credential)
    return next
  }

  async function catalog() {
    // 无凭据时的兜底：给一张最小语言模型表（登录后会被实时列表替换）
    return {}
  }

  /** 直传网关：<host>/v1/chat/completions（Bearer mgw_ api_key）。 */
  async function chat(credential, request) {
    const withKey = await ensureApiKey(credential)
    const url = `${site.host}/v1/chat/completions`
    const headers = {
      authorization: `Bearer ${withKey.apiKey}`,
      'content-type': 'application/json',
      'user-agent': UA,
      origin: site.web,
      accept: request?.stream ? 'text/event-stream' : 'application/json',
    }
    // ⚠ 国际站 /v1/* **强制**要求 organization-code（不带 → HTTP 500 裸文本）。
    //   国内站带不带都行；统一带上更稳。
    const org = withKey.organizationCode
    if (org) headers['organization-code'] = org
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new MagicrewError(`网关 HTTP ${res.status}：${text.slice(0, 160)}`, { status: res.status })
    }
    return { response: res }
  }

  return {
    id: CHANNEL_ID,
    displayName: DISPLAY_NAME,
    fallbackModels: {},
    beginLogin,
    refresh,
    expired: (credential) => {
      const raw = Number(credential?.refreshTokenExpiresAt)
      return Number.isFinite(raw) && raw > 0 && raw <= Date.now()
    },
    catalog,
    chat,
    usage,
    checkin,
    // 供测试用
    _login: login,
    _issueGatewayKey: issueGatewayKey,
    _refreshGatewayKey: refreshGatewayKey,
    _fetchPoints: fetchPoints,
    _fetchModels: fetchModels,
  }
}

function isoMs(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (Number.isFinite(n) && n > 1e12) return n
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : undefined
}

function fmtDate(v) {
  const ms = isoMs(v)
  if (ms === undefined) return String(v)
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const magicrewChannel = makeChannel(SITES.cn)
export const magicrewIntlChannel = makeChannel(SITES.intl)
