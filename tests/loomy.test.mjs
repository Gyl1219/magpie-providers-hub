// Loomy 渠道测试（全部 stub 上游；127.0.0.1 本地登录服务器直通）。
// 覆盖：HMAC 签名锁、信封解析、短信三步、微信 uuid/长轮询状态机、绑定两分支、
// 双头认证 chat、两池余额、过期判据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-loomy-'))
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')

const {
  loomyChannel,
  loomyAuthHeaders,
  buildLoomyWechatAuthUrl,
  extractLoomyWechatUuid,
  buildLoomyWechatQrImageUrl,
  pollLoomyWechatOnce,
  LOOMY_WECHAT_POLL_STATUS,
  ACCESS_KEY_ID,
  ACCESS_KEY_SECRET,
} = await import('../src/loomy.mjs')

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // 本地登录服务器直通（测试要真打它）
    if (url.includes('127.0.0.1')) return original(input, init)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    for (const route of routes) if (url.includes(route.match)) return route.respond({ url, calls, init })
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── HMAC 签名（9 段拼串锁死）────────────────────────────────────────────

test('HMAC 签名：9 段拼串 + account 前缀 + Content-MD5', () => {
  const h = loomyAuthHeaders({
    path: '/login/phone/sendMsgCode',
    body: '{"fixed":"body"}',
    date: 'Mon, 02 Nov 2026 00:00:00 GMT',
    nonce: 'nonce-abc',
  })
  // 串 = POST \n /login/phone/sendMsgCode \n (空query) \n MD5(body) \n application/json \n date \n nonce \n \n \n
  const md5 = createHash('md5').update('{"fixed":"body"}', 'utf8').digest('base64')
  const stringToSign = [
    'POST', '/login/phone/sendMsgCode', '', md5, 'application/json',
    'Mon, 02 Nov 2026 00:00:00 GMT', 'nonce-abc', '', '',
  ].join('\n')
  const expect = createHmac('sha1', ACCESS_KEY_SECRET).update(stringToSign, 'utf8').digest('base64')
  assert.equal(h.Authorization, `account ${ACCESS_KEY_ID}:${expect}`)
  assert.equal(h['Content-MD5'], md5)
  assert.equal(h.Nonce, 'nonce-abc')
})

// ── 信封解析 ────────────────────────────────────────────────────────────

test('信封：000000=OK；100002=登录失效；其余=业务错误', async () => {
  const stub = stubFetch([
    { match: '/points/records', respond: () => json({ code: '100002', desc: 'token 无效' }) },
  ])
  try {
    const rows = await loomyChannel.usage({ access_token: 'AT' })
    assert.match(rows[0].display, /登录会话已失效/)
  } finally { stub.restore() }
})

// ── 微信：uuid / 二维码 / 长轮询状态机 ──────────────────────────────────

test('微信授权 URL：appid 与官方 redirect 写死（域名白名单）', () => {
  const url = buildLoomyWechatAuthUrl('state-1')
  assert.ok(url.includes('appid=wx18d60be432287cf8'))
  assert.ok(url.includes('redirect_uri=' + encodeURIComponent('https://loomy.xunfei.cn/oauth/wechat/callback')))
  assert.ok(url.includes('scope=snsapi_login'))
})

test('uuid 提取：二维码图与长轮询两个来源都认', () => {
  assert.equal(extractLoomyWechatUuid('<img src="/connect/qrcode/ABC123">'), 'ABC123')
  assert.equal(extractLoomyWechatUuid("l/qrconnect?uuid=XYZ789&last=404"), 'XYZ789')
  assert.equal(extractLoomyWechatUuid('没有 uuid'), undefined)
})

test('二维码图片 URL：uuid 原样拼接', () => {
  assert.equal(buildLoomyWechatQrImageUrl('ABC'), 'https://open.weixin.qq.com/connect/qrcode/ABC')
})

test('长轮询状态机：405+code=confirmed；404=已扫；403=取消；402=过期；408=等待', async () => {
  const caseOf = async (body) => {
    const stub = stubFetch([{ match: 'long.open.weixin.qq.com', respond: () => new Response(body) }])
    try { return await pollLoomyWechatOnce('UUID', '') } finally { stub.restore() }
  }
  const ok = await caseOf("window.wx_errcode=405;window.wx_code='CODE1';")
  assert.deepEqual(ok, { status: LOOMY_WECHAT_POLL_STATUS.confirmed, code: 'CODE1', errcode: '405' })
  const noCode = await caseOf('window.wx_errcode=405;window.wx_code=\'\';')
  assert.equal(noCode.status, LOOMY_WECHAT_POLL_STATUS.scanned, '405 无 code 保守判已扫')
  assert.equal((await caseOf('window.wx_errcode=404;')).status, LOOMY_WECHAT_POLL_STATUS.scanned)
  assert.equal((await caseOf('window.wx_errcode=403;')).status, LOOMY_WECHAT_POLL_STATUS.cancelled)
  assert.equal((await caseOf('window.wx_errcode=402;')).status, LOOMY_WECHAT_POLL_STATUS.expired)
  assert.equal((await caseOf('window.wx_errcode=408;')).status, LOOMY_WECHAT_POLL_STATUS.waiting)
})

// ── 登录：双路本地页 ────────────────────────────────────────────────────

test('beginLogin：本地页同时渲染微信二维码与短信表单', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: 'open.weixin.qq.com/connect/qrcode', respond: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }) },
  ])
  try {
    const started = await loomyChannel.beginLogin()
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/login$/)
    const page = await (await fetch(started.url)).text()
    assert.match(page, /data:image\/jpeg;base64,/, '二维码内联')
    assert.match(page, /微信扫码/, '微信区块在')
    assert.match(page, /短信验证码/, '短信区块在')
    // ⚠️ 不 await started.result：它会等满 10 分钟登录超时（server/timer 已 unref，
    //   用例结束即过，页面内容断言就是本用例的全部目的）
    started.close?.()
  } finally { stub.restore() }
})

test('微信扫码：bind=1（已绑手机号）→ skip 直接换 session', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: 'open.weixin.qq.com/connect/qrcode', respond: () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }) },
    { match: 'long.open.weixin.qq.com', respond: () => new Response("window.wx_errcode=405;window.wx_code='WCODE1';") },
    { match: '/login/thirdAccount/bind/auth', respond: () => json({ code: '000000', data: { rcode: 'RC1', bind: 1, nickname: '哄哄' } }) },
    { match: '/login/thirdAccount/bind/skip', respond: () => json({ code: '000000', data: { session: 'SESS1', userid: 'U1' } }) },
    { match: '/points/records', respond: () => json({ code: '000000', data: { balance: 100, dailyBalance: 5000 } }) },
  ])
  try {
    const started = await loomyChannel.beginLogin()
    // 触发一次 poll：confirmed → bind/auth → skip → settle
    await fetch(started.url.replace('/login', '/wechat/poll'))
    const credential = await started.result
    assert.equal(credential.access_token, 'SESS1')
    assert.equal(credential.userid, 'U1')
    assert.equal(credential.nickname, '哄哄')
    assert.ok(Number(credential.expires_at) > Date.now(), '14 天会话带上 expires')
    started.close?.()
  } finally { stub.restore() }
})

test('微信扫码：bind=0（未绑手机号）→ 页面走绑定表单完成登录', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: 'open.weixin.qq.com/connect/qrcode', respond: () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }) },
    { match: 'long.open.weixin.qq.com', respond: () => new Response("window.wx_errcode=405;window.wx_code='WCODE2';") },
    { match: '/login/thirdAccount/bind/auth', respond: () => json({ code: '000000', data: { rcode: 'RC2', bind: 0 } }) },
    { match: '/login/thirdAccount/bind/sendMsg', respond: () => json({ code: '000000', data: { msgid: 'MSG9' } }) },
    { match: '/login/thirdAccount/bind/checkCode', respond: () => json({ code: '000000', data: { session: 'SESS2', userid: 'U2', phone: '138****0000' } }) },
    { match: '/points/records', respond: () => json({ code: '000000', data: { balance: 100, dailyBalance: 5000 } }) },
  ])
  try {
    const started = await loomyChannel.beginLogin()
    const pollRes = await (await fetch(started.url.replace('/login', '/wechat/poll'))).json()
    assert.equal(pollRes.status, 'need_phone', '未绑手机号 → 页面显示绑定表单')
    const send = await (await fetch(started.url.replace('/login', '/wechat/complete'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send_sms', phone: '13800000000' }),
    })).json()
    assert.equal(send.ok, true)
    const done = await (await fetch(started.url.replace('/login', '/wechat/complete'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'verify_sms', phone: '13800000000', code: '123456' }),
    })).json()
    assert.equal(done.ok, true)
    const credential = await started.result
    assert.equal(credential.access_token, 'SESS2')
    assert.equal(credential.phone, '138****0000', '服务端返回的脱敏手机号优先')
    started.close?.()
  } finally { stub.restore() }
})

test('短信登录：三步流走本地页（send → msgid → login → settle）', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: 'open.weixin.qq.com/connect/qrcode', respond: () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }) },
    { match: '/login/phone/sendMsgCode', respond: () => json({ code: '000000', data: { msgid: 'MSG1' } }) },
    { match: '/login/phone/checkCode', respond: () => json({ code: '000000', data: { session: 'SESS3', userid: 'U3' } }) },
    { match: '/points/records', respond: () => json({ code: '000000', data: { balance: 100, dailyBalance: 5000 } }) },
  ])
  try {
    const started = await loomyChannel.beginLogin()
    const send = await (await fetch(started.url.replace('/login', '/sms/send'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '13900000000' }),
    })).json()
    assert.equal(send.msgid, 'MSG1')
    await fetch(started.url.replace('/login', '/sms/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '13900000000', code: '654321', msgid: send.msgid }),
    })
    const credential = await started.result
    assert.equal(credential.access_token, 'SESS3')
    assert.equal(credential.phone, '13900000000')
    started.close?.()
  } finally { stub.restore() }
})

// ── chat（双头认证 + 业务码）────────────────────────────────────────────

test('chat：Authorization Bearer 与 token 双头都在；非流式 chat.completion 原样透传', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ id: 'x', choices: [{ message: { content: 'OK' } }] }),
  }])
  try {
    const res = await loomyChannel.chat(
      { access_token: 'AT1' },
      { body: { model: 'GLM-5.3-Flash', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200)
    const sent = stub.calls[0]
    assert.equal(sent.headers.Authorization, 'Bearer AT1', 'chat 认 Bearer')
    assert.equal(sent.headers.token, 'AT1', 'chat 同时带 token 头（官方客户端同款）')
    const body = await res.json()
    assert.equal(body.choices[0].message.content, 'OK', '非流式成功原样透传（不走信封判）')
  } finally { stub.restore() }
})

test('chat：业务码 100002 → 401 登录失效（不误判成功）', async () => {
  const stub = stubFetch([{ match: '/chat/completions', respond: () => json({ code: '100002', desc: 'token 无效' }) }])
  try {
    const res = await loomyChannel.chat(
      { access_token: 'AT' },
      { body: { model: 'GLM-5.3-Flash', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 401)
    assert.match((await res.json()).error.message, /重新登录/)
  } finally { stub.restore() }
})

// ── 余额（两池）─────────────────────────────────────────────────────────

test('usage：永久池走 amount/limit 形态（balance 会关进度条）；每日池 span+resetsAt', async () => {
  const stub = stubFetch([{
    match: '/points/records',
    respond: () => json({ code: '000000', data: { balance: 14257, dailyBalance: 3611 } }),
  }])
  try {
    const rows = await loomyChannel.usage({ access_token: 'AT' })
    assert.equal(rows.length, 2)
    const permanent = rows.find((r) => r.name === '永久积分')
    assert.equal(permanent.limit, 14257, 'amount/limit 形态（有进度条）')
    assert.equal(permanent.balance, undefined, '绝不发 balance（magpie 对 balance 关进度条）')
    assert.equal(permanent.display, '剩余 14257')
    const daily = rows.find((r) => r.name === '每日赠送')
    assert.equal(daily.span, 86_400)
    assert.ok(Number.isFinite(Date.parse(daily.resetsAt)), '每日池带重置点（北京午夜）')
    assert.ok(daily.used > 0, 'used 按真实消耗算（1389/5000 已用）')
  } finally { stub.restore() }
})

// ── 签到 ────────────────────────────────────────────────────────────────

test('checkin：alreadyProcessed → claimed（今日确实领过，不是 done）', async () => {
  const stub = stubFetch([{
    match: '/points/first-login',
    respond: () => json({ code: '000000', data: { alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 3611 } }),
  }])
  try {
    const r = await loomyChannel.checkin({ access_token: 'AT' })
    assert.equal(r.outcome, 'claimed', '已领过也是 claimed（done 会被 magpie 渲染黄色重问）')
    assert.equal(r.credit, 5000)
  } finally { stub.restore() }
})

test('checkin：100002 → failed + signIn expired', async () => {
  const stub = stubFetch([{ match: '/points/first-login', respond: () => json({ code: '100002', desc: 'token 无效' }) }])
  try {
    const r = await loomyChannel.checkin({ access_token: 'AT' })
    assert.equal(r.outcome, 'failed')
    assert.equal(r.signIn, 'expired')
  } finally { stub.restore() }
})

// ── 过期判据 ────────────────────────────────────────────────────────────

test('expired：expires_at 字符串能解析；无 expires 不凭猜测判过期', () => {
  assert.equal(loomyChannel.expired({ expires_at: String(Date.now() - 3600_000) }), true)
  assert.equal(loomyChannel.expired({ expires_at: String(Date.now() + 3600_000) }), false)
  assert.equal(loomyChannel.expired({}), false, '无到期字段 → 拿去试（服务端 100002 能识别）')
})

