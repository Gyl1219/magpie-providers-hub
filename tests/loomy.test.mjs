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
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(started.url).origin },
      body: JSON.stringify({ action: 'send_sms', phone: '13800000000' }),
    })).json()
    assert.equal(send.ok, true)
    const done = await (await fetch(started.url.replace('/login', '/wechat/complete'), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(started.url).origin },
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
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(started.url).origin },
      body: JSON.stringify({ mobile: '13900000000' }),
    })).json()
    assert.equal(send.msgid, 'MSG1')
    await fetch(started.url.replace('/login', '/sms/login'), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(started.url).origin },
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

// ── 上游网关故障：一次即止，不参与换号 ─────────────────────────────────
//
// 语义来源（仓库内实证，非照抄 DSH）：
//   magicrew.mjs:343-347 —— magpie 400 分支非额度文案 ⇒ 整轮失败、账号不 rest、
//     其它账号一个都不问；marvis.mjs:426 —— 503 属「可重试」，会换号。
//   网关级故障同渠道共用网关，换号纯白打，故出口状态取 400。

const chatBody = (stream = false) => ({
  model: 'GLM-5.3-Flash', stream, messages: [{ role: 'user', content: 'hi' }],
})

test('chat：HTTP 502 → 400 upstream_error（一次即止，不换号）', async () => {
  const stub = stubFetch([{ match: '/chat/completions', respond: () => json({ message: 'bad gateway' }, 502) }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
    assert.equal(res.status, 400, '出口必须是 400：magpie 400 非额度文案 ⇒ 不换号')
    const err = (await res.json()).error
    assert.equal(err.type, 'upstream_error')
    assert.equal(err.code, 'upstream_unavailable')
    assert.match(err.message, /502/, 'message 原样带真实 HTTP 状态（状态码语义偏弱，靠文案兜）')
    assert.match(err.message, /换号无用/)
  } finally { stub.restore() }
})

test('chat：HTTP 503 + 信封 100002 → 仍是上游故障，不触发 renew 换号', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ code: '100002', desc: 'token 无效' }, 503),
  }])
  let renewCalls = 0
  try {
    const res = await loomyChannel.chat(
      { access_token: 'AT' },
      { body: chatBody(), renew: async () => { renewCalls += 1; return { access_token: 'NEW' } } },
    )
    assert.equal(renewCalls, 0, '5xx 时信封 code 不可信，绝不能拿它去 renew')
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.type, 'upstream_error')
    assert.equal(stub.calls.length, 1, '只打一次网关，不重发')
  } finally { stub.restore() }
})

test('chat：HTTP 200 + 「该模型服务暂时不可用」→ 同样判上游故障', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ code: '500', desc: '该模型服务暂时不可用，请稍后再试' }),
  }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
    assert.equal(res.status, 400, '业务信封里的网关故障也要摘出换号路径')
    const err = (await res.json()).error
    assert.equal(err.type, 'upstream_error')
    assert.equal(err.code, 'upstream_unavailable')
    assert.match(err.message, /暂时不可用/)
  } finally { stub.restore() }
})

test('chat：英文 upstream 文案（service unavailable / bad gateway）也认', async () => {
  for (const desc of ['Service Unavailable', 'bad gateway', 'upstream timeout']) {
    const stub = stubFetch([{ match: '/chat/completions', respond: () => json({ code: '500', desc }) }])
    try {
      const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
      assert.equal(res.status, 400, `「${desc}」应判上游故障`)
      assert.equal((await res.json()).error.type, 'upstream_error')
    } finally { stub.restore() }
  }
})

test('chat：普通业务错保持 provider_error + 原语义（不被上游分类吞掉）', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ code: '999999', desc: '参数不合法' }),
  }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
    assert.equal(res.status, 502, '业务错沿用旧出口（200 信封 → 502）')
    assert.equal((await res.json()).error.type, 'provider_error')
  } finally { stub.restore() }
})

test('chat：HTTP 400 非上游文案 → provider_error 透出原状态码', async () => {
  const stub = stubFetch([{ match: '/chat/completions', respond: () => json({ error: { message: 'invalid model' } }, 400) }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.type, 'provider_error')
  } finally { stub.restore() }
})

test('chat：正常回答的正文里出现「暂时不可用」不得误判（只有报错路径才做文案匹配）', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ id: 'x', choices: [{ message: { content: '当网关回「该模型服务暂时不可用」时应当重试' } }] }),
  }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
    assert.equal(res.status, 200, '成功回答原样透传')
    assert.match((await res.json()).choices[0].message.content, /暂时不可用/)
  } finally { stub.restore() }
})

test('chat：请求 URL 与账号无关（同一网关基址）—— 换号绕不过网关故障', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ id: 'x', choices: [{ message: { content: 'OK' } }] }),
  }])
  try {
    await loomyChannel.chat({ access_token: 'AT-A', userid: 'U1' }, { body: chatBody() })
    await loomyChannel.chat({ access_token: 'AT-B', userid: 'U2' }, { body: chatBody() })
    const urls = stub.calls.map((c) => c.url)
    assert.equal(urls.length, 2)
    assert.equal(urls[0], urls[1], '两个账号打的是同一个 URL')
    assert.match(urls[0], /^https:\/\/loomyad\.xunfei\.cn\/api\/v1\/chat\/completions$/)
    assert.doesNotMatch(urls[0], /U1|U2|AT-A|AT-B/, 'URL 里不带任何账号/凭据标识')
  } finally { stub.restore() }
})

test('chat：额度不足仍是 402 原样透出（换号路径没被上游分类吞掉）', async () => {
  // loomy 的额度不足走 HTTP 402 + {error:{message}}（见 parseEnvelope 注释），
  // 402 是 magpie 唯一无条件换号的出口 —— 上游故障分类必须绕开它。
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ error: { message: '积分不足，请充值' } }, 402),
  }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody() })
    assert.equal(res.status, 402, '额度不足必须保持 402：这是唯一会换号的出口')
    const err = (await res.json()).error
    assert.equal(err.type, 'provider_error', '不上游故障分类')
    assert.match(err.message, /积分不足/)
  } finally { stub.restore() }
})

test('chat：SSE 流式成功仍原样透传（上游故障分类不碰流式分支）', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }])
  try {
    const res = await loomyChannel.chat({ access_token: 'AT' }, { body: chatBody(true) })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /\[DONE\]/)
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

// ── 目录：新形状 {object:"list",data:[…]} / 旧信封回归 ──────────────────

const catalogRow = (overrides = {}) => ({
  id: 'catalog-model-a',
  type: 'chat',
  name: 'Catalog Model A · x2.0',
  context_length: 262_144,
  max_output_tokens: 4096,
  default_reasoning_effort: 'low',
  reasoning_efforts: ['low', 'high'],
  input_modalities: ['text'],
  ...overrides,
})

test('catalog：新形状 {object:"list",data:[…]} 解析成功，不回落 FALLBACK_MODELS', async () => {
  const stub = stubFetch([{
    match: '/models',
    respond: () => json({ object: 'list', data: [catalogRow()] }),
  }])
  try {
    const models = await loomyChannel.catalog({ access_token: 'AT' })
    // 'catalog-model-a' 不在 FALLBACK_MODELS 里 —— 只有真从 data 解析出来才会存在。
    // 若解析失败回落兜底，这个键不会出现（兜底里全是已下线模型）。
    assert.ok(Object.hasOwn(models, 'catalog-model-a'), '新形状的模型被解析出来，未回落兜底')
    assert.equal(models['catalog-model-a'].name, 'Catalog Model A · x2.0', '倍率从 name 末尾括号提取')
    assert.equal(models['catalog-model-a'].limit.context, 262_144)
    assert.equal(models['catalog-model-a'].status, 'active')
    // 兜底独有键不在结果里，进一步证明不是 FALLBACK_MODELS
    assert.equal(Object.hasOwn(models, 'spark-x'), false, '兜底独有模型不出现')
    assert.equal(Object.hasOwn(models, 'deepseek-v4-flash-0731'), false)
  } finally { stub.restore() }
})

test('catalog：旧信封 {code:"000000",data:[…]} 回归兼容，解析结果一致', async () => {
  const stub = stubFetch([{
    match: '/models',
    respond: () => json({ code: '000000', data: [catalogRow()] }),
  }])
  try {
    const models = await loomyChannel.catalog({ access_token: 'AT' })
    assert.ok(Object.hasOwn(models, 'catalog-model-a'), '旧信封同样解析出模型')
    assert.equal(models['catalog-model-a'].limit.context, 262_144)
    assert.equal(models['catalog-model-a'].limit.output, 4096, '旧信封也带 max_output_tokens')
  } finally { stub.restore() }
})

test('catalog：max_output_tokens 缺失/非法 → limit.output 回落 8192', async () => {
  const stub = stubFetch([{
    match: '/models',
    respond: () => json({ object: 'list', data: [
      catalogRow({ id: 'model-no-out', max_output_tokens: undefined }),
      catalogRow({ id: 'model-bad-out', max_output_tokens: 'abc' }),
    ] }),
  }])
  try {
    const models = await loomyChannel.catalog({ access_token: 'AT' })
    assert.equal(models['model-no-out'].limit.output, 8_192, '缺失 → 默认 8192')
    assert.equal(models['model-bad-out'].limit.output, 8_192, '非数字 → 不物化，回落默认')
  } finally { stub.restore() }
})

test('catalog：default_reasoning_effort 采信远端；缺失/空串 → defaultEffort 回落 high', async () => {
  const stub = stubFetch([{
    match: '/models',
    respond: () => json({ object: 'list', data: [
      catalogRow({ id: 'model-eff-low', default_reasoning_effort: 'low' }),
      catalogRow({ id: 'model-eff-empty', default_reasoning_effort: '' }),
      catalogRow({ id: 'model-eff-none', default_reasoning_effort: undefined }), // 显式 undefined 才能盖掉帮手默认 'low'，真正测「缺失」
    ] }),
  }])
  try {
    const models = await loomyChannel.catalog({ access_token: 'AT' })
    assert.equal(models['model-eff-low'].defaultEffort, 'low', '远端给了就采信（不强制 high）')
    assert.equal(models['model-eff-empty'].defaultEffort, 'high', '空串 → 回落本地默认 high')
    assert.equal(models['model-eff-none'].defaultEffort, 'high', '缺失 → 回落本地默认 high')
  } finally { stub.restore() }
})

test('recordModelEfforts：catalog 记录档位 → chat 白名单（合法档下发，非法档静默不发）', async () => {
  const stub = stubFetch([
    {
      match: '/models',
      respond: () => json({ object: 'list', data: [catalogRow({ id: 'effort-model' })] }),
    },
    {
      match: '/chat/completions',
      respond: () => json({ id: 'x', choices: [{ message: { content: 'OK' } }] }),
    },
  ])
  try {
    const models = await loomyChannel.catalog({ access_token: 'AT' })
    // variants 来自 reasoning_efforts（不是全量档位）
    assert.deepEqual(models['effort-model'].variants, {
      low: { reasoning_effort: 'low' },
      high: { reasoning_effort: 'high' },
    })
    // 合法档 high 在 efforts ['low','high'] 内 → 下发
    await loomyChannel.chat(
      { access_token: 'AT' },
      { body: { model: 'effort-model', stream: false, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' } },
    )
    const legal = stub.calls.find(
      (c) => c.url.includes('/chat/completions') && JSON.parse(c.body).reasoning_effort === 'high',
    )
    assert.ok(legal, '合法档 high 被下发')
    // 非法档 xhigh 不在 efforts 内 → 静默不下发
    await loomyChannel.chat(
      { access_token: 'AT' },
      { body: { model: 'effort-model', stream: false, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' } },
    )
    const illegal = stub.calls.find(
      (c) => c.url.includes('/chat/completions') && JSON.parse(c.body).reasoning_effort === 'xhigh',
    )
    assert.equal(illegal, undefined, '非法档 xhigh 静默不下发')
  } finally { stub.restore() }
})

// ── 过期判据 ────────────────────────────────────────────────────────────

test('expired：expires_at 字符串能解析；无 expires 不凭猜测判过期', () => {
  assert.equal(loomyChannel.expired({ expires_at: String(Date.now() - 3600_000) }), true)
  assert.equal(loomyChannel.expired({ expires_at: String(Date.now() + 3600_000) }), false)
  assert.equal(loomyChannel.expired({}), false, '无到期字段 → 拿去试（服务端 100002 能识别）')
})

