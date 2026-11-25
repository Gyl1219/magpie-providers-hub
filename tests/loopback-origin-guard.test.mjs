// 登录窗口 CSRF 门禁：非本页源的请求在路由之前被挡掉（issue #688 / #699 的剩余部分）
//
// 为什么需要这一层：登录页跑在 127.0.0.1 的随机端口上，**任何**网页都能往这个
// 端口 POST（loopback 不受同源策略保护），而浏览器对 POST 必带 Origin。所以
// 「Origin 不是本页源」就是跨站的判据。没有这一层时，攻击者能拿自己的账号密码
// 打 /password/login，把用户 magpie 静默绑到攻击者账号上 —— 请求全走攻击者的
// 额度与日志，用户还以为自己没登录。
//
// 覆盖范围：astudio(/password/login、/sms/login)、loomy(/sms/login、
// /wechat/complete)、magicrew(/api/login、/api/login-jwt、/api/browser-login、
// /api/google-handoff)。baizhi 与 monkeycode 的 /paste 由 PR #21 的 capability
// token + isSameOriginPost 单独守住，见 tests/baizhi.test.mjs、tests/monkeycode.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { isTrustedLoopbackRequest, isSameOriginPost, loginOrigin } = await import('../src/login-security.mjs')
const { astudioChannel } = await import('../src/astudio.mjs')
const { loomyChannel } = await import('../src/loomy.mjs')

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 拦掉所有非 loopback 请求；loopback 直通真服务器（和 monkeycode 测试同一个写法）。 */
const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('127.0.0.1')) return original(input, init)
    calls.push({ url, method: init?.method ?? 'GET' })
    for (const route of routes) if (url.includes(route.match)) return route.respond()
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const EVIL = 'https://evil.example'

/** 跨站 POST：浏览器必带 Origin，这条就是攻击面的原型。 */
const crossPost = (origin, path, body = {}) => fetch(`${origin}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: EVIL },
  body: JSON.stringify(body),
})

/** 同源 POST：登录页自己发的那种。 */
const samePost = (origin, path, body = {}) => fetch(`${origin}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: origin },
  body: JSON.stringify(body),
})

const readSource = (name) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8')

// ── 判据本身 ─────────────────────────────────────────────────────────────

test('isTrustedLoopbackRequest：POST 必须带本页 Origin', () => {
  const port = 41234
  const same = { method: 'POST', headers: { origin: loginOrigin(port) } }
  assert.equal(isTrustedLoopbackRequest(same, port), true)
  assert.equal(isTrustedLoopbackRequest({ method: 'POST', headers: { origin: EVIL } }, port), false)
  assert.equal(isTrustedLoopbackRequest({ method: 'POST', headers: {} }, port), false, '无 Origin 的 POST 不是浏览器表单，一律拒')
  assert.equal(isTrustedLoopbackRequest({ method: 'POST', headers: { origin: 'null' } }, port), false, '沙箱 iframe 的 Origin: null 也是跨站')
})

test('isTrustedLoopbackRequest：不带 Origin 的 GET 放行，带 Origin 的 GET 要同源', () => {
  const port = 41234
  assert.equal(isTrustedLoopbackRequest({ method: 'GET', headers: {} }, port), true, '登录页自己的导航/同源 fetch 不带 Origin')
  assert.equal(isTrustedLoopbackRequest({ method: 'GET', headers: { origin: loginOrigin(port) } }, port), true)
  assert.equal(isTrustedLoopbackRequest({ method: 'GET', headers: { origin: EVIL } }, port), false, '跨站 fetch 会带 Origin')
  assert.equal(isTrustedLoopbackRequest(undefined, port), false, '拿不到 req 时失败关闭')
})

test('isTrustedLoopbackRequest 与 /paste 用的 isSameOriginPost 判据一致', () => {
  const port = 41234
  const same = { method: 'POST', headers: { origin: loginOrigin(port) } }
  const evil = { method: 'POST', headers: { origin: EVIL } }
  assert.equal(isSameOriginPost(same, port), true)
  assert.equal(isSameOriginPost(evil, port), false)
  assert.equal(isTrustedLoopbackRequest(same, port), isSameOriginPost(same, port))
  assert.equal(isTrustedLoopbackRequest(evil, port), isSameOriginPost(evil, port))
})

// ── astudio：/password/login 是这轮最重的那个洞 ────────────────────────

test('astudio：跨站 POST /password/login 被挡在路由之前（403、不打上游）', async () => {
  const stub = stubFetch([{ match: '', respond: () => json({}) }])
  const started = await astudioChannel.beginLogin(undefined)
  started.result.catch(() => {})
  try {
    const origin = new URL(started.url).origin
    const res = await crossPost(origin, '/password/login', { accountName: 'attacker', accountPwd: 'p', geetestChallenge: 'a', geetestValidate: 'b', geetestSeccode: 'c' })
    assert.equal(res.status, 403)
    assert.equal(await res.text(), 'forbidden')
    assert.equal(stub.calls.length, 0, '被挡的请求不该碰到上游')
  } finally {
    stub.restore()
    started.close?.()
  }
})

test('astudio：同源 POST /password/login 进到路由（不是 403）', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: '', respond: () => json({ code: 0, data: {} }) },
  ])
  const started = await astudioChannel.beginLogin(undefined)
  started.result.catch(() => {})
  try {
    const origin = new URL(started.url).origin
    const res = await samePost(origin, '/password/login', { accountName: '', accountPwd: '' })
    assert.notEqual(res.status, 403, '同源请求必须穿过去，否则登录页自己就废了')
  } finally {
    stub.restore()
    started.close?.()
  }
})

test('astudio：跨站 GET 带 Origin 也挡，不带 Origin 的 GET 放行（页面要能打开）', async () => {
  const stub = stubFetch([{ match: '', respond: () => json({}) }])
  const started = await astudioChannel.beginLogin(undefined)
  started.result.catch(() => {})
  try {
    const page = await fetch(started.url)
    assert.equal(page.status, 200, '登录页是同一来源的导航，不带 Origin')
    assert.match(await page.text(), /<html/i)

    const crossGet = await fetch(started.url, { headers: { origin: EVIL } })
    assert.equal(crossGet.status, 403)
  } finally {
    stub.restore()
    started.close?.()
  }
})

// ── loomy：/sms/login、/wechat/complete ─────────────────────────────────

test('loomy：跨站 POST /sms/login 被挡，同源 POST 进到路由', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: 'open.weixin.qq.com/connect/qrcode', respond: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }) },
    { match: '', respond: () => json({ code: 0, data: {} }) },
  ])
  const started = await loomyChannel.beginLogin()
  started.result.catch(() => {})
  try {
    const origin = new URL(started.url).origin
    const blocked = await crossPost(origin, '/sms/login', { mobile: '13000000000', verifyCode: '000000' })
    assert.equal(blocked.status, 403)
    assert.equal(await blocked.text(), 'forbidden')

    const crossed = await crossPost(origin, '/wechat/complete', { code: 'CODE' })
    assert.equal(crossed.status, 403)

    const allowed = await samePost(origin, '/sms/login', {})
    assert.notEqual(allowed.status, 403, '同源请求必须穿过去')
  } finally {
    stub.restore()
    started.close?.()
  }
})

// ── magicrew：四个 /api/* 状态改写端点 ──────────────────────────────────
// magicrew 的 beginLogin 不返回 close 句柄，也不 unref 服务器与 10 分钟定时器，
// 起一次真服务器就会把测试进程吊住 —— 所以这一支只验「门装上了」，用源码接线
// 断言；判据本身由上面三条覆盖。

test('magicrew：handler 在路由之前调用同源门，且四个 /api/* 都在门后', () => {
  const source = readSource('magicrew.mjs')
  const guardAt = source.indexOf('isTrustedLoopbackRequest(req, port)')
  assert.notEqual(guardAt, -1, 'handler 里必须调用同源门')
  for (const route of ['/api/login', '/api/login-jwt', '/api/browser-login', '/api/google-handoff']) {
    const routeAt = source.indexOf(`pathname === '${route}'`)
    assert.notEqual(routeAt, -1, `${route} 必须还在`)
    assert.ok(guardAt < routeAt, `${route} 必须在门之后`)
  }
  assert.match(source, /let port = 0/, 'port 必须先声明再在 listen 决议后赋值，否则早到的请求撞 TDZ')
})

test('astudio 与 loomy：门装在 handler 顶部，port 先声明', () => {
  for (const name of ['astudio.mjs', 'loomy.mjs']) {
    const source = readSource(name)
    const guardAt = source.indexOf('isTrustedLoopbackRequest(req, port)')
    assert.notEqual(guardAt, -1, `${name}: handler 里必须调用同源门`)
    assert.match(source, /let port = 0/, `${name}: port 必须先声明`)
    assert.ok(guardAt < source.indexOf("pathname === '/'"), `${name}: 门必须在第一个路由之前`)
  }
})