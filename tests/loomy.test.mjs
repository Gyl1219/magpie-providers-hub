// Loomy 渠道移植语义回归（全部 stub fetch / 固定时钟）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-loomy-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { loomyChannel, renderLoginPage, loomyAuthHeaders, ACCESS_KEY_ID, ACCESS_KEY_SECRET } = await import('../src/loomy.mjs')

test.after = () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
}

const CRED = { access_token: 'a'.repeat(32), userid: '1'.repeat(18), phone: '13800000000', expires_at: String(Date.now() + 14 * 86400_000) }

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // ⚠️ 本地载体服务的请求必须透传（否则 /sms/* 到不了载体服务器，
    // result promise 挂到超时 —— 测试假死）；只拦截外部域名。
    if (url.includes('127.0.0.1')) return original(input, init)
    calls.push({ url, headers: init?.headers, method: init?.method, body: init?.body })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, calls })
    }
    return new Response('{"code":"000000","data":{}}', { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 签名（9 段拼串 + HMAC-SHA1，固定 date/nonce 锁死）────────────────────

test('账号签名：account 前缀、9 段拼串、尾随 \\n\\n、Content-MD5', () => {
  const body = '{"x":1}'
  const headers = loomyAuthHeaders({
    method: 'POST', path: '/login/phone/checkCode', body,
    date: 'Sat, 25 Oct 2026 00:00:00 GMT', nonce: 'nonce-1',
  })
  assert.match(headers.Authorization, /^account /, '认证头前缀是 account，不是 Bearer')
  assert.equal(headers.Date, 'Sat, 25 Oct 2026 00:00:00 GMT')
  assert.equal(headers.Nonce, 'nonce-1')
  assert.equal(headers['Content-MD5'], createHash('md5').update(body, 'utf8').digest('base64'))
  // 独立重算：9 段（含尾随两个空段），密钥是模块内置的真 AccessKey。
  // ⚠️ 路径转义是**按段**的（先切段再逐段 RFC3986，斜杠保留）——
  //    对整条路径 encodeURIComponent 会把 / 也转义掉，重算必然失配。
  const expected = [
    'POST',
    '/login/phone/checkCode'.split('/').map((s) => encodeURIComponent(s)).join('/'),
    '',
    createHash('md5').update(body, 'utf8').digest('base64'),
    'application/json',
    'Sat, 25 Oct 2026 00:00:00 GMT',
    'nonce-1',
    '',
    '',
  ].join('\n')
  const sig = createHmac('sha1', ACCESS_KEY_SECRET).update(expected, 'utf8').digest('base64')
  assert.equal(headers.Authorization, `account ${ACCESS_KEY_ID}:${sig}`)
})

// ── 短信登录三步 ────────────────────────────────────────────────────────

test('短信登录：sendMsgCode 返回 msgid；checkCode 用同一 msgid 换 session（经真实载体服务）', async () => {
  const stub = stubFetch([
    {
      match: '/login/phone/sendMsgCode',
      respond: ({ calls }) => {
        const body = JSON.parse(calls.at(-1).body)
        assert.ok(calls.at(-1).headers.Authorization.startsWith('account '), '账号端点必须 HMAC 签名')
        assert.ok(calls.at(-1).headers['Content-MD5'], '有 body 必须带 Content-MD5')
        assert.equal(body.param.expire, 300, '验证码有效期 5 分钟')
        return new Response(JSON.stringify({ code: '000000', data: { msgid: 'MSG-1' } }), { status: 200 })
      },
    },
    {
      match: '/login/phone/checkCode',
      respond: ({ calls }) => {
        const body = JSON.parse(calls.at(-1).body)
        assert.equal(body.param.msgid, 'MSG-1', 'msgid 必须原样带回')
        assert.equal(body.param.expire, 1209600, '会话 14 天向服务端声明')
        assert.equal(body.base.ua, 'Loomy|Desktop|Electron|macOS', 'Windows 上也是这个值，照抄')
        return new Response(JSON.stringify({ code: '000000', data: { session: 's'.repeat(32), userid: 'u'.repeat(18) } }), { status: 200 })
      },
    },
  ])
  try {
    // ⚠️ 保持 stub 挂着驱动载体服务：后端的账号端点调用也要走 stub
    //（恢复真网络 = 打真机，且可能挂起）
    const flow = await loomyChannel.beginLogin(undefined)
    const port = new URL(flow.url).port
    const send = await fetch(`http://127.0.0.1:${port}/sms/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: '13800000000' }),
    })
    const sendJson = await send.json()
    assert.equal(sendJson.ok, true)
    const login = await fetch(`http://127.0.0.1:${port}/sms/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '13800000000', code: '123456', msgid: sendJson.msgid }),
    })
    const loginJson = await login.json()
    assert.equal(loginJson.ok, true)
    // 载体服务在登录成功后写旁路并落定 result
    const credential = await flow.result
    assert.equal(credential.access_token.length, 32)
    assert.ok(Math.abs(Number(credential.expires_at) - (Date.now() + 1209600 * 1000)) < 5000, 'expires_at = 登录 + 14 天')
  } finally {
    stub.restore()
  }
})

// ── 目录 ────────────────────────────────────────────────────────────────

test('目录：type=chat 过滤、倍率规范化、spark-x 窗口降档、qwen-3.8-max 读图', async () => {
  const stub = stubFetch([
    {
      match: '/models',
      respond: () => new Response(JSON.stringify({
        code: '000000',
        data: [
          { id: 'spark-x', name: 'Spark X2.5 （x0.1）', type: 'chat', context_length: 1048576, reasoning_efforts: ['none', 'low', 'high'] },
          { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max (x12.0)', type: 'chat', input_modalities: ['text'], context_length: 1000000 },
          { id: 'draw-x', name: '生图', type: 'image' }, // 非 chat 剔除
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash(x0.8)', type: 'chat', input_modalities: ['text', 'image'] },
        ],
      }), { status: 200 }),
    },
  ])
  try {
    const models = await loomyChannel.catalog(CRED)
    assert.ok(!models['draw-x'], '非 chat 模型剔除')
    assert.equal(models['spark-x'].limit.context, 262_144, 'spark-x 远端虚报必须降档（越墙 0 输出）')
    assert.equal(models['spark-x'].name, 'Spark X2.5 · x0.1', '倍率规范化为 ` · x{n}`')
    assert.equal(models['qwen-3.8-max'].capabilities.attachment, true, 'input_modalities 漏报，实测能读图')
    assert.equal(models['glm-5.3-flash'].capabilities.attachment, true)
    assert.deepEqual(models['spark-x'].variants?.none?.reasoning_effort, 'none', '档位原样下发')
  } finally {
    stub.restore()
  }
})

// ── 两池余额 ────────────────────────────────────────────────────────────

test('usage：两池分开（永久 balance 缺失不臆造 0）；每日桶带午夜 resetsAt', async () => {
  const stub = stubFetch([
    {
      match: '/points/records',
      respond: () => new Response(JSON.stringify({
        code: '000000',
        data: { balance: 15000, dailyBalance: 3611, availableBalance: 18611 },
      }), { status: 200 }),
    },
  ])
  try {
    const windows = await loomyChannel.usage(CRED)
    const permanent = windows.find((w) => w.name.includes('永久积分'))
    assert.equal(permanent.display, '剩余 15000')
    assert.ok(!permanent.name.includes('Loomy ·'), '内部名不带渠道前缀（聚合层统一加，叠了会双前缀）')
    const daily = windows.find((w) => w.name.includes('每日赠送'))
    assert.equal(daily.display, '剩余 3611')
    assert.equal(daily.used, 28, 'used = (5000-3611)/5000 —— 路由排序输入，不能硬编码 0')
    assert.equal(daily.span, 86_400)
    const resetHour = new Date(daily.resetsAt).getUTCHours()
    assert.ok(resetHour === 16 || resetHour === 15, '每日池重置点应是北京午夜（UTC 15/16 时，视 DST）')
  } finally {
    stub.restore()
  }
})

// ── 签到（first-login，幂等判据 alreadyProcessed）───────────────────────

test('签到：首次 → claimed（credit = dailyQuota - dailyConsumed）', async () => {
  const stub = stubFetch([{
    match: '/points/first-login',
    respond: ({ calls }) => {
      assert.equal(calls.at(-1).headers.token, CRED.access_token, 'points 端点只认 token 头')
      assert.equal(calls.at(-1).headers.authorization, undefined, '⚠️ points 端点带 Authorization 会被判缺少 token')
      return new Response(JSON.stringify({
        code: '000000',
        data: { alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 8, dailyBalance: 4992 },
      }), { status: 200 })
    },
  }])
  try {
    const outcome = await loomyChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 4992, '本次新发放 = dailyQuota - dailyConsumed（服务端不给差值）')
  } finally {
    stub.restore()
  }
})

test('签到：alreadyProcessed → claimed + 今日发放量（今日确实领到了，done 会被 magpie 渲染成黄色「稍后再问」）', async () => {
  const stub = stubFetch([{
    match: '/points/first-login',
    respond: () => new Response(JSON.stringify({
      code: '000000',
      data: { alreadyProcessed: true, dailyQuota: 5000, dailyConsumed: 100, dailyBalance: 4900 },
    }), { status: 200 }),
  }])
  try {
    const outcome = await loomyChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 5000, '今日发放量 = dailyQuota')
    assert.match(outcome.message, /4900\/5000/)
  } finally {
    stub.restore()
  }
})

test('签到：100002 → failed + signIn 标记（业务失败恒 HTTP 200，只看状态码会漏判）', async () => {
  const stub = stubFetch([{
    match: '/points/first-login',
    respond: () => new Response(JSON.stringify({ code: '100002', desc: '缺少 token' }), { status: 200 }),
  }])
  try {
    const outcome = await loomyChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'failed')
    assert.equal(outcome.signIn, 'expired')
  } finally {
    stub.restore()
  }
})

// ── 无续期 + 过期语义 ───────────────────────────────────────────────────

test('无 refresh 端点（诚实标记）；过期判据=到期即过（无过期信息不过期）', async () => {
  await assert.rejects(() => loomyChannel.refresh(CRED), /无自动续期|重新短信登录/)
  assert.equal(loomyChannel.expired({}), false)
  assert.equal(loomyChannel.expired({ expires_at: String(Date.now() - 1000) }), true)
})

test('chat 非流式：上游是 chat.completion JSON → 原样回传（不是 502）', async () => {
  // 真机 bug：Loomy 的非流式响应**没有** {code,…} 信封，就是 OpenAI 的
  // chat.completion JSON。旧代码读不到 code 就判「业务错误（缺少 code）」→ 502，
  // 把上游已经答对的 "OK" 丢掉（只影响显式 stream:false 的调用方）。
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => new Response(JSON.stringify({
      id: 'cht-1', object: 'chat.completion', created: 1, model: 'spark-x2.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }],
    }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
  }])
  try {
    const res = await loomyChannel.chat(CRED, {
      body: { model: 'spark-x2.6', messages: [{ role: 'user', content: 'say OK' }], stream: false },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, 'OK', '成功的上游回答不能被当成错误吞掉')
  } finally {
    stub.restore()
  }
})

test('chat 非流式：真正的业务错误（缺 token 信封）仍要报错', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => new Response(JSON.stringify({ code: '100002', message: '缺少 token' }), { status: 200 }),
  }])
  try {
    const res = await loomyChannel.chat(CRED, {
      body: { model: 'spark-x2.6', messages: [{ role: 'user', content: 'x' }], stream: false },
    })
    assert.equal(res.status, 401)
    assert.match((await res.json()).error.message, /已失效/)
  } finally {
    stub.restore()
  }
})

// ── 载体页门禁（页面 JS 藏在模板串里，node --check 查不到）──────────────

test('载体页：script 可解析、元素齐全、无未定义顶层调用', () => {
  const page = renderLoginPage()
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1]
  assert.doesNotThrow(() => new Function(script.replace(/\/\/[^\n]*/g, '')))
  for (const id of ['mobile', 'send', 'code', 'go', 'msg']) assert.ok(page.includes(`id="${id}"`))
})
