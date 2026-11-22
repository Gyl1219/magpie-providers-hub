// 千问办公国际版（qwenwork.ai）渠道测试 —— fetch 全部 mock，不发真实网络请求。
//
// 覆盖：包装器设备流（入口 302 / poll 的 pending=404 与 granted=200）、续期
// （只认包装器对）、账号上下文（额度来源）、COSY 签名下的目录与 chat、登录载体
// 的「立刻返回」契约。**没有任何真机成功对话**，chat 的用例只钉协议形状。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-qwenwork-intl-'))
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')

// stubFetch 会替换全局 fetch；本地回环页（127.0.0.1）必须用真 fetch 访问，
// 否则页面与 /status 请求都会被 stub 吃掉。
const realFetch = globalThis.fetch

/** 上游解包产物（本机存在时才做逐字节对照；不存在则 skip，不伪造通过）。 */
const UPSTREAM_PKG = 'D:/qwenwork-intl/_inspect/package/index.mjs'

const {
  qwenworkIntlChannel,
  fallbackModels,
  FALLBACK_MODEL_IDS,
  createPkce,
  buildAuthorizeUrl,
  buildStartQuery,
  startDeviceFlow,
  pollDeviceToken,
  tokenOf,
  expired,
  expiresAtMs,
  fetchAccountContext,
  fetchIdentity,
  refresh,
  catalog,
  chat,
} = await import('../src/qwenwork-intl.mjs')

const { decodeBody, encodeBody, COSY_CHAT_PATH, COSY_MODELS_PATH } = await import('../src/qwenwork-intl-cosy.mjs')

// 真机实测的机读常量（这几个是**协议**，不是模型 id，改它们等于换协议）
const GATEWAY = 'https://gateway.qwenwork.ai'
const DEVICE_START = `${GATEWAY}/device/selectAccounts`
const DEVICE_POLL = `${GATEWAY}/api/v1/deviceToken/poll`
const DEVICE_REFRESH = `${GATEWAY}/api/v1/deviceToken/refresh`
const ACCOUNT_CONTEXT = `${GATEWAY}/api/v1/adapter/user/account-context`
const WRAPPER_CLIENT_ID = 'cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a'
const WRAPPER_REDIRECT = 'qwenwork://'

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const redirect = (location, status = 302) => new Response(null, { status, headers: { location } })

/**
 * 一份「COSY 齐全」的凭据：`access_token` + `uid` + `machineId`。
 * 后两个只在登录时拿得到（签名要 `Cosy-User` 与设备身份），缺一个就打不了 /algo 路由。
 */
const CRED = { access_token: 'AT-1', uid: 'u-1', machineId: 'mid-1' }

/** 记录调用的 fetch stub（不碰网络）。 */
const stubFetch = (respond) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // 本地回环（状态页 / status）必须走真 fetch，否则页面内容断言会被 stub 吃掉
    if (/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init)
    calls.push({ url, init, body: init?.body })
    return respond({ url, init })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── PKCE / 授权 URL ──────────────────────────────────────────────────────

test('PKCE：verifier 86 字符（b64url(randomBytes(64))，同上游）、challenge = base64url(sha256(verifier))', () => {
  const { verifier, challenge } = createPkce()
  assert.equal(verifier.length, 86, '上游 intlSignIn 是 b64url(randomBytes(64))')
  assert.ok(verifier.length >= 43 && verifier.length <= 128, 'Ory 要求 43~128')
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.ok(!/[+/=]/.test(challenge), '必须 base64url（无 + / =）')
})

test('授权 URL（网关没回 Location 时的兜底）：issuer 的 client/回调/scope/PKCE 齐全', () => {
  const { challenge } = createPkce()
  const url = new URL(buildAuthorizeUrl({ state: 'a'.repeat(32), challenge }))
  assert.equal(url.origin, 'https://qwenwork.ai')
  assert.equal(url.pathname, '/oauth2/auth')
  const q = url.searchParams
  assert.equal(q.get('client_id'), 'qwenwork-desktop-app', 'issuer 侧是这个 client（不是包装器那个）')
  assert.equal(q.get('redirect_uri'), 'https://gateway.qwenwork.ai/oauth/callback', '环回回调会被 Ory 拒')
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('code_challenge'), challenge)
  assert.match(q.get('scope') ?? '', /qwen_work/, 'scope 必须含 qwen_work')
  assert.match(q.get('scope') ?? '', /offline_access/, '要 refresh_token 必须带 offline_access')
  assert.ok((q.get('state') ?? '').length >= 32, 'Ory 拒短 state')
  assert.match(q.get('nonce') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})

// ── 包装器设备流：入口 ───────────────────────────────────────────────────

test('设备流入口 query：包装器 client + 裸 scheme 这一对，参数一个都不能省', () => {
  const query = buildStartQuery({ nonce: 'N-1', challenge: 'C-1', machineId: 'M-1' })
  assert.equal(query.get('client_id'), WRAPPER_CLIENT_ID, '换成 CN 的 client 会 400 INVALID_DEVICE_FLOW')
  assert.equal(query.get('redirect_uri'), WRAPPER_REDIRECT, '必须裸 scheme；换 https 回调同样 400')
  assert.equal(query.get('challenge'), 'C-1')
  assert.equal(query.get('challenge_method'), 'S256')
  assert.equal(query.get('nonce'), 'N-1')
  assert.equal(query.get('machine_id'), 'M-1')
})

test('设备流入口：GET + redirect:manual，拿 302 的 Location 当授权页', async () => {
  const authorizeUrl = 'https://qwenwork.ai/oauth2/auth?client_id=qwenwork-desktop-app&state=abc'
  const stub = stubFetch(() => redirect(authorizeUrl))
  try {
    const flow = await startDeviceFlow()
    assert.equal(flow.ok, true, JSON.stringify(flow))
    assert.equal(flow.authorizeUrl, authorizeUrl, 'Location 就是用户要打开的那一页')
    const sent = stub.calls[0]
    assert.equal(sent.init.method, 'GET', '探针复跑都是 GET（参数全在 query，没有 body）')
    assert.equal(sent.init.redirect, 'manual', '不 manual 就会跟到登录页，拿不到 302')
    assert.match(sent.url, new RegExp(`^${DEVICE_START}\\?`))
    assert.equal(new URL(sent.url).searchParams.get('client_id'), WRAPPER_CLIENT_ID)
    assert.equal(flow.nonce, new URL(sent.url).searchParams.get('nonce'))
    assert.equal(flow.machineId, new URL(sent.url).searchParams.get('machine_id'), 'machineId 要留着给 COSY')
    assert.equal(flow.challenge, createHash('sha256').update(flow.verifier).digest('base64url'))
  } finally { stub.restore() }
})

test('设备流入口：404/405 退 POST 再问一次（不靠猜该用哪个方法）', async () => {
  const seen = []
  const stub = stubFetch(({ init }) => {
    seen.push(init.method)
    if (init.method === 'GET') return new Response('', { status: 405 })
    return redirect('https://qwenwork.ai/oauth2/auth?state=ok')
  })
  try {
    const flow = await startDeviceFlow()
    assert.deepEqual(seen, ['GET', 'POST'])
    assert.equal(flow.ok, true)
  } finally { stub.restore() }
})

test('设备流入口被拒（参数对不匹配）：不抛、给中文原因 + 上游原文', async () => {
  const stub = stubFetch(() => json({ error: 'INVALID_DEVICE_FLOW' }, 400))
  try {
    const flow = await startDeviceFlow()
    assert.equal(flow.ok, false)
    assert.match(flow.error, /HTTP 400/)
    assert.match(flow.error, /INVALID_DEVICE_FLOW/)
  } finally { stub.restore() }
})

// ── 包装器设备流：轮询 ───────────────────────────────────────────────────

test('轮询：pending = 404 空体（不是失败）；granted = 200 + token', async () => {
  const pending = stubFetch(() => new Response('', { status: 404 }))
  try {
    const out = await pollDeviceToken({ nonce: 'N-1', verifier: 'V-1' })
    assert.deepEqual(out, { state: 'pending' }, '404 是「等用户授权」，把它当错误会让登录提前死掉')
    const sent = pending.calls[0]
    assert.match(sent.url, new RegExp(`^${DEVICE_POLL}\\?`))
    const query = new URL(sent.url).searchParams
    assert.equal(query.get('nonce'), 'N-1')
    assert.equal(query.get('verifier'), 'V-1')
    assert.equal(query.get('challenge_method'), 'S256')
    assert.equal(query.get('client_id'), null, '多带 client_id 会被 400 not_allowed')
  } finally { pending.restore() }

  const granted = stubFetch(() => json({ access_token: 'AT-G', refresh_token: 'RT-G', expires_in: 3600 }))
  try {
    const out = await pollDeviceToken({ nonce: 'N-1', verifier: 'V-1' })
    assert.equal(out.state, 'granted')
    assert.equal(out.token.access_token, 'AT-G')
    assert.equal(out.token.refresh_token, 'RT-G')
    assert.ok(out.token.expires_at > Date.now() + 3_500_000, 'expires_in 换成绝对毫秒')
  } finally { granted.restore() }
})

test('轮询：400 是硬错误（参数形态错，继续轮询无意义）；200 但没 token 也报错', async () => {
  const bad = stubFetch(() => json({ error: 'not_allowed' }, 400))
  try {
    const out = await pollDeviceToken({ nonce: 'N-1', verifier: 'V-1' })
    assert.equal(out.state, 'error')
    assert.equal(out.fatal, true)
    assert.match(out.message, /HTTP 400/)
  } finally { bad.restore() }

  const empty = stubFetch(() => json({ status: 'ok' }))
  try {
    const out = await pollDeviceToken({ nonce: 'N-1', verifier: 'V-1' })
    assert.equal(out.state, 'error')
    assert.equal(out.fatal, undefined, '缺 token 不是硬错误（可能是网关抖动）')
    assert.match(out.message, /没有 access_token/)
  } finally { empty.restore() }

  // 网络抖动：不算失败，调用方继续轮询
  const boom = stubFetch(() => { throw new TypeError('fetch failed') })
  try {
    const out = await pollDeviceToken({ nonce: 'N-1', verifier: 'V-1' })
    assert.equal(out.state, 'error')
    assert.equal(out.fatal, undefined)
  } finally { boom.restore() }
})

test('tokenOf：{data:{…}} 外壳与 camelCase 都认', () => {
  assert.equal(tokenOf({ access_token: 'A' }).access_token, 'A')
  assert.equal(tokenOf({ data: { access_token: 'B' } }).access_token, 'B')
  assert.equal(tokenOf({ accessToken: 'C', refreshToken: 'R', expiresIn: 60 }).access_token, 'C')
  assert.equal(tokenOf({ accessToken: 'C', refreshToken: 'R' }).refresh_token, 'R')
  assert.equal(tokenOf({ nope: 1 }), undefined)
  assert.equal(tokenOf(undefined), undefined)
})

// ── 到期判定 ─────────────────────────────────────────────────────────────

test('到期：日期字符串走 Date.parse（不能 Number）；未知当可用', () => {
  assert.equal(expired({}), false, '无到期字段 = 未知 ≠ 已过期')
  assert.equal(expired({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }), false)
  assert.equal(expired({ expires_at: new Date(Date.now() - 3_600_000).toISOString() }), true)
  assert.equal(expired({ expires_at: Date.now() + 60_000 }), true, '10 分钟内到期视为临期')
  assert.equal(expiresAtMs({ expires_at: 1_800_000_000 }), 1_800_000_000_000, '秒 → 毫秒')
  assert.equal(expiresAtMs({ expires_at: '1800000000000' }), 1_800_000_000_000, '毫秒数字串')
  assert.equal(expiresAtMs({ expires_at: '不是日期' }), undefined)
})

// ── 账号上下文 / 身份 ────────────────────────────────────────────────────

test('账号上下文：走 gateway 的 /api/v1/adapter/user、include 三件、身份与额度都取回来', async () => {
  const stub = stubFetch(() => json({
    data: {
      user: { id: 'af25a663-0000', name: '1610105401', email: 'n@example.com' },
      plan: { name: 'Free' },
      quota: { credits: 552.33 },
    },
  }))
  try {
    const out = await fetchAccountContext('AT-1')
    assert.equal(out.ok, true)
    const sent = stub.calls[0]
    assert.match(sent.url, new RegExp(`^${ACCOUNT_CONTEXT}\\?`), '账号上下文在网关上，不是 openapi')
    assert.equal(new URL(sent.url).searchParams.get('include'), 'user,plan,quota')
    assert.equal(sent.init.headers.authorization, 'Bearer AT-1')
    assert.equal(out.identity.nickname, '1610105401')
    assert.equal(out.identity.email, 'n@example.com')
    assert.equal(out.identity.uid, 'af25a663-0000', 'COSY 的 Cosy-User 就要这个 uid')
    assert.equal(out.identity.subject, 'af25a663-0000')
    assert.equal(out.quota.credits, 552.33, '界面上那 700 credits 就是这条的 quota')
  } finally { stub.restore() }
})

test('身份：账号上下文拿不到时退 issuer 的 /user/info，并剥 {data:{user}}', async () => {
  const stub = stubFetch(({ url }) => {
    if (url.startsWith(ACCOUNT_CONTEXT)) return new Response('nope', { status: 500 })
    if (url === 'https://qwenwork.ai/user/info') {
      return json({ data: { user: { id: 'uid-9', name: '李四', email: 'l@example.com' } } })
    }
    return new Response(`unexpected ${url}`, { status: 500 })
  })
  try {
    const out = await fetchIdentity('AT-1')
    assert.equal(out.ok, true)
    assert.equal(out.identity.nickname, '李四')
    assert.equal(out.identity.email, 'l@example.com')
    assert.equal(out.identity.subject, 'uid-9')
    assert.equal(stub.calls.at(-1).url, 'https://qwenwork.ai/user/info')
    assert.equal(stub.calls.at(-1).init.headers.authorization, 'Bearer AT-1')
  } finally { stub.restore() }
})

test('身份：两处都没有 claim → 空对象（聚合层退渠道显示名，不编）', async () => {
  const stub = stubFetch(() => json({}))
  try {
    const out = await fetchIdentity('AT-1')
    assert.equal(out.ok, true)
    assert.deepEqual(out.identity, {})
  } finally { stub.restore() }
})

test('身份读取失败：不抛，ok:false 带 HTTP 码（登录不因它失败）', async () => {
  const stub = stubFetch(() => new Response('nope', { status: 500 }))
  try {
    const out = await fetchIdentity('AT-1')
    assert.equal(out.ok, false)
    assert.match(out.error, /HTTP 500/)
  } finally { stub.restore() }
})

// ── 续期 ─────────────────────────────────────────────────────────────────

test('续期：只打网关的 deviceToken/refresh，body 是包装器对；RT 轮换立刻写回', async () => {
  const persisted = []
  const stub = stubFetch(() => json({
    access_token: 'AT-2', refresh_token: 'RT-2', token_type: 'Bearer', expires_in: 3600,
  }))
  try {
    const credential = {
      access_token: 'AT-1', refresh_token: 'RT-1',
      channel: 'qwenwork-intl', uid: 'u-1', machineId: 'mid-1',
    }
    const next = await refresh(credential, (c) => persisted.push(c))

    const sent = stub.calls[0]
    assert.equal(sent.url, DEVICE_REFRESH, '续期在网关上，不是 issuer 的 /auth/oauth/token')
    assert.equal(sent.init.method, 'POST')
    assert.match(String(sent.init.headers['content-type']), /application\/json/)
    const body = JSON.parse(String(sent.body))
    assert.equal(body.refresh_token, 'RT-1')
    assert.equal(body.target, 'c')
    assert.equal(body.client_id, WRAPPER_CLIENT_ID, 'issuer 那对会被 400 INVALID_REFRESH_REQUEST')
    assert.equal(body.redirect_uri, WRAPPER_REDIRECT)
    assert.equal('grant_type' in body, false, '标准 OAuth refresh 在这条渠道不成立')

    assert.equal(next.access_token, 'AT-2')
    assert.equal(next.refresh_token, 'RT-2', 'RT 轮换后必须换成新的')
    assert.equal(next.uid, 'u-1', '续期响应不带用户 id，原凭据的必须留住')
    assert.equal(next.machineId, 'mid-1')
    assert.equal(next.channel, 'qwenwork-intl')
    assert.ok(next.expires_at > Date.now() + 3_500_000, 'expires_in 换成绝对毫秒')
    assert.equal(persisted.length, 1, 'RT 轮换要立刻写回（并发入口不能拿旧 RT）')
    assert.equal(persisted[0].refresh_token, 'RT-2')
  } finally { stub.restore() }

  await assert.rejects(() => refresh({ access_token: 'AT-1' }), /没有 refresh_token/)
})

test('续期被拒：抛带 HTTP 码与上游原因的错误，且不写回（坏凭据不持久化）', async () => {
  const stub = stubFetch(() => json({ errorCode: 'INVALID_REFRESH_TOKEN', message: 'invalid_grant' }, 401))
  const writes = []
  try {
    await assert.rejects(
      () => refresh({ access_token: 'AT-1', refresh_token: 'RT-OLD' }, (c) => writes.push(c)),
      (error) => {
        assert.match(error.message, /续期被拒/)
        assert.match(error.message, /HTTP 401/)
        assert.match(error.message, /INVALID_REFRESH_TOKEN/)
        assert.match(error.message, /invalid_grant/)
        return true
      },
    )
    assert.equal(writes.length, 0)
  } finally { stub.restore() }

  // 包装器对用错时的形状：400 INVALID_REFRESH_REQUEST
  const wrongPair = stubFetch(() => json({ error: 'INVALID_REFRESH_REQUEST' }, 400))
  try {
    await assert.rejects(
      () => refresh({ access_token: 'AT-1', refresh_token: 'RT-1' }),
      /INVALID_REFRESH_REQUEST/,
    )
  } finally { wrongPair.restore() }
})

// ── 目录 ─────────────────────────────────────────────────────────────────

test('目录：走 gateway 的 /algo + COSY 签名（GET 的签名 body 是空串），认扁平形状', async () => {
  const openai = stubFetch(() => json({
    object: 'list',
    data: [
      { id: 'qwen3-coder-plus', display_name: 'Qwen3 Coder Plus', context_length: 262144, max_output_tokens: 65536 },
      { id: 'glm-5', context_window: 200000 },
      { id: '' },
      null,
    ],
  }))
  try {
    const models = await catalog(CRED)
    const sent = openai.calls[0]
    assert.equal(sent.url, `${GATEWAY}${COSY_MODELS_PATH}`,
      '目录真机 200 在 gateway 上（openapi 那条会 401/403）')
    assert.equal(sent.init.method ?? 'GET', 'GET')
    assert.equal(sent.body, undefined, 'GET 不带请求体')
    assert.equal(sent.init.headers['Cosy-User'], 'u-1', 'Cosy-User 必须与 token 同属一人')
    assert.equal(sent.init.headers['Cosy-MachineId'], 'mid-1')
    assert.match(sent.init.headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
    assert.equal(sent.init.headers.authorization, undefined, '/algo 路由不认普通 Bearer')
    // 签名覆盖空串 body 与剥掉 /algo 的 path —— 用这个头自己的 Cosy-Key 复现
    const [, payload, sig] = sent.init.headers.Authorization.split('.')
    assert.equal(sig, createHash('md5').update(
      `${payload}\n${sent.init.headers['Cosy-Key']}\n${sent.init.headers['Cosy-Date']}\n\n/api/v2/model/list`,
    ).digest('hex'), 'GET 的签名 body 是空串')

    assert.equal(models['qwen3-coder-plus'].name, 'Qwen3 Coder Plus')
    assert.equal(models['qwen3-coder-plus'].limit.context, 262144)
    assert.equal(models['qwen3-coder-plus'].limit.output, 65536)
    assert.equal(models['glm-5'].limit.context, 200000, 'context_window 别名也要认')
    assert.equal(models['glm-5'].name, 'glm-5', '没有 display_name 就用 id')
    assert.equal(models['glm-5'].limit.output, undefined, '没给就不写（不编 8192）')
    assert.equal('' in models, false, '空 id 不入目录')
  } finally { openai.restore() }
})

test('目录：401 / 形状认不出 → 退回兜底表（不编新 id）', async () => {
  const expected = [...FALLBACK_MODEL_IDS].sort()
  const [first, second, third] = FALLBACK_MODEL_IDS
  for (const respond of [() => new Response('no', { status: 401 }), () => json({ unknown: true })]) {
    const stub = stubFetch(respond)
    try {
      const models = await catalog(CRED)
      assert.deepEqual(Object.keys(models).sort(), expected)
      assert.equal(models[second].name, '高级', '档位键要给中文显示名')
      assert.equal(models[third].name, 'Qwen3.8-Max')
      assert.equal(models[first].limit.context, 131072)
    } finally { stub.restore() }
  }
})

test('目录：缺 uid/machineId 的凭据不打请求，直接兜底（打了也是 401，白挨一次）', async () => {
  for (const credential of [
    { access_token: 'AT-1', uid: 'u-1' },
    { access_token: 'AT-1', machineId: 'mid-1' },
    {},
  ]) {
    const stub = stubFetch(() => json({ object: 'list', data: [{ id: 'x' }] }))
    try {
      const models = await catalog(credential)
      // 期望值从常量算：这里再抄一遍 id 字面量，等于给自己留一次漂移机会
      assert.deepEqual(Object.keys(models).sort(), [...FALLBACK_MODEL_IDS].sort(), JSON.stringify(credential))
      assert.equal(stub.calls.length, 0, '没有 COSY 身份就不要发请求')
    } finally { stub.restore() }
  }
})

test('目录：服务端回编码串（Encode=1）也能解出条目', async () => {
  const plain = JSON.stringify({ chat: { models: [{ key: 'enc-1', display_name: '编码回来的' }] } })
  const wire = encodeBody(plain)
  assert.notEqual(wire, plain)
  const stub = stubFetch(() => new Response(wire, { status: 200, headers: { 'content-type': 'text/plain' } }))
  try {
    const models = await catalog(CRED)
    assert.deepEqual(Object.keys(models), ['enc-1'])
    assert.equal(models['enc-1'].name, '编码回来的')
  } finally { stub.restore() }
})

test('目录：真机的分组形状（chat/assistant/qwork/…）也能拆出条目，byok 组跳过', async () => {
  // 形状取自真机 `model/list`（分组，每组里才是条目；真机只有 qwork 非空）
  const stub = stubFetch(() => json({
    chat: {
      models: [
        { key: 'auto', display_name: '自动', is_default: true, context_config: { max_input_tokens: 262144 } },
        { key: 'qwen3.8-max', display_name: 'Qwen3.8-Max', is_reasoning: true, max_input_tokens: 131072 },
      ],
    },
    qwork: { items: [{ key: 'qwork-pro', display_name: '办公高级', context_config: { max_input_tokens: 65536, max_output_tokens: 16384 } }] },
    qcode: [{ key: 'qcode-coder', display_name: '代码' }],
    assistant: { list: [] },
    byok_teams: { models: [{ key: 'byok-x', display_name: '自带 Key' }] },
  }))
  try {
    const models = await catalog(CRED)
    assert.deepEqual(Object.keys(models).sort(), ['auto', 'qcode-coder', 'qwen3.8-max', 'qwork-pro'],
      '三组条目的 key 都进目录；空组与 byok_* 组不进')
    assert.equal(models.auto.name, '自动', 'display_name 优先')
    assert.equal(models.auto.limit.context, 262144, 'context_config.max_input_tokens 要认')
    assert.equal(models['qwen3.8-max'].limit.context, 131072, '顶层 max_input_tokens 也要认')
    assert.equal(models['qwork-pro'].limit.output, 16384, 'context_config.max_output_tokens 要认')
    assert.equal('byok-x' in models, false, 'byok 组要用用户自己的 key，列出来只会 400')
  } finally { stub.restore() }
})

test('目录：空的分组（每组都没条目）→ 退回兜底表，不返回空目录', async () => {
  const stub = stubFetch(() => json({ chat: { models: [] }, assistant: [] }))
  try {
    const models = await catalog(CRED)
    assert.deepEqual(Object.keys(models).sort(), [...FALLBACK_MODEL_IDS].sort())
  } finally { stub.restore() }
})

// ── chat 契约（AGENTS §5）─────────────────────────────────────────────────

test('chat：走 gateway 的 /algo/**/agent_chat_generation + COSY 签名、body 是上线编码形态、返回原始 Response', async () => {
  const stub = stubFetch(() => new Response('data: {"choices":[]}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))
  const body = { model: 'qwen3-coder-plus', stream: true, messages: [{ role: 'user', content: 'hi' }] }
  try {
    const res = await chat(CRED, { body, signal: undefined, renew: () => {} })
    assert.ok(res instanceof Response)
    assert.equal(res.status, 200)

    const sent = stub.calls[0]
    assert.equal(sent.url, `${GATEWAY}${COSY_CHAT_PATH}`,
      '对话真机 200 也在 gateway 上')
    assert.equal(sent.init.method, 'POST')
    // 请求体不是明文 JSON：是 encodeBody(JSON) 的上线形态，且能解回原样
    assert.notEqual(sent.body, JSON.stringify(body))
    const payload = JSON.parse(decodeBody(String(sent.body)))
    // 网关要求的两个业务字段由 chat() 补（见下一条用例）；比对时先摘掉
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    assert.match(payload.request_id, UUID, '缺 request_id 会 400 request_id is required')
    assert.match(payload.session_id, UUID, '缺 session_id 会 400 session_id is required')
    const { request_id, session_id, ...rest } = payload
    assert.deepEqual(rest, body, '除补的两个 uuid 之外，body 必须原样（不许改键、不许丢字段）')
    assert.ok(!('renew' in payload) && !('signal' in payload), '信封键不外泄')

    assert.equal(sent.init.headers.authorization, undefined, '/algo 路由不认普通 Bearer')
    assert.match(sent.init.headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
    assert.equal(sent.init.headers['Cosy-User'], 'u-1')
    assert.equal(sent.init.headers.Accept, 'text/event-stream')
    assert.equal(sent.init.headers['X-Model-Key'], 'qwen3-coder-plus', '对话要带模型来源键')
    assert.equal('Cosy-ClientIp' in sent.init.headers, false, '对话不发 ClientIp')
    // 签名覆盖**上线形态**的 body（不是明文 JSON）与剥掉 /algo 的 path
    const [, sealed, sig] = sent.init.headers.Authorization.split('.')
    assert.equal(sig, createHash('md5').update(
      `${sealed}\n${sent.init.headers['Cosy-Key']}\n${sent.init.headers['Cosy-Date']}\n${sent.body}\n/api/v2/service/pro/sse/agent_chat_generation`,
    ).digest('hex'), '签名必须签 encodeBody 之后的串')
    assert.equal(sent.init.signal, undefined, '没给 signal 不得自造超时')
  } finally { stub.restore() }
})

test('chat：非流式也要编码 body，Accept 跟着 stream 走（SSE 头会让网关按流回包）', async () => {
  const stub = stubFetch(() => json({ choices: [] }))
  try {
    await chat(CRED, { body: { model: 'pro', messages: [] } })
    const sent = stub.calls[0]
    assert.equal(sent.init.headers.Accept, 'application/json')
    assert.equal(JSON.parse(decodeBody(String(sent.body))).model, 'pro')
  } finally { stub.restore() }
})

test('chat：缺 request_id/session_id 自动补 uuid（真机 400 request_id is required 的修法）', async () => {
  const stub = stubFetch(() => new Response('ok', { status: 200 }))
  try {
    const body = { model: 'qwork-auto', stream: true, messages: [{ role: 'user', content: '收到' }] }
    await chat(CRED, { body })
    const payload = JSON.parse(decodeBody(String(stub.calls[0].body)))
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    assert.match(payload.request_id, UUID, 'request_id 必须是小写标准 uuid')
    assert.match(payload.session_id, UUID, 'session_id 必须是小写标准 uuid')
    assert.notEqual(payload.request_id, payload.session_id, '两个 id 是不同维度，别用同一个')
    // 网关只认 snake_case；驼峰顶上去会被当无效字段
    assert.equal(payload.requestId, undefined)
    assert.equal(payload.sessionId, undefined)
    // 不许改调用方的对象（chat 是只读它的入参）
    assert.deepEqual(body, { model: 'qwork-auto', stream: true, messages: [{ role: 'user', content: '收到' }] })
  } finally { stub.restore() }
})

test('chat：已有的 request_id/session_id 不被覆盖（调用方给的号要能对上）', async () => {
  const stub = stubFetch(() => new Response('ok', { status: 200 }))
  try {
    const body = {
      model: 'qwork-auto',
      messages: [],
      request_id: 'req-keep-me',
      session_id: 'sess-keep-me',
    }
    await chat(CRED, { body })
    const payload = JSON.parse(decodeBody(String(stub.calls[0].body)))
    assert.equal(payload.request_id, 'req-keep-me', '已有就必须原样保留，换掉会让调用方对不上号')
    assert.equal(payload.session_id, 'sess-keep-me', 'session 一换就等于开新会话，历史就断了')

    // 只缺一个时只补那一个，另一个不动
    const partial = { model: 'qwork-auto', messages: [], request_id: 'req-only' }
    await chat(CRED, { body: partial })
    const second = JSON.parse(decodeBody(String(stub.calls[1].body)))
    assert.equal(second.request_id, 'req-only')
    assert.match(second.session_id, /^[0-9a-f-]{36}$/, '缺的才补')
  } finally { stub.restore() }
})

test('chat：只给了驼峰 requestId/sessionId 时把值搬到 snake_case（否则网关照样 400）', async () => {
  // 关键点：把驼峰当「已有」而不生成 snake_case，是纯亏的静默失败 —— 网关只认
  // snake_case，会再回 `400 request_id is required`，而调用方以为自己给了。
  const stub = stubFetch(() => new Response('ok', { status: 200 }))
  try {
    const body = { model: 'qwork-auto', messages: [], requestId: 'req-camel', sessionId: 'sess-camel' }
    await chat(CRED, { body })
    const payload = JSON.parse(decodeBody(String(stub.calls[0].body)))
    assert.equal(payload.request_id, 'req-camel', '值必须搬过去，且值与调用方给的完全一致（不许换成新 uuid）')
    assert.equal(payload.session_id, 'sess-camel')
    // 驼峰键原样留着：删掉同样会让调用方对不上号
    assert.equal(payload.requestId, 'req-camel')
    assert.equal(payload.sessionId, 'sess-camel')
    assert.deepEqual(body, { model: 'qwork-auto', messages: [], requestId: 'req-camel', sessionId: 'sess-camel' })

    // snake 与驼峰都给时，以 snake 为准（不搬、不覆盖）
    const both = { model: 'qwork-auto', messages: [], request_id: 'req-snake', requestId: 'req-camel', session_id: 'sess-snake' }
    await chat(CRED, { body: both })
    const second = JSON.parse(decodeBody(String(stub.calls[1].body)))
    assert.equal(second.request_id, 'req-snake', 'snake_case 是网关认的那个，优先它')
    assert.equal(second.session_id, 'sess-snake')

    // 驼峰是空串 = 没给：照常生成 uuid
    const empty = { model: 'qwork-auto', messages: [], requestId: '   ', sessionId: '' }
    await chat(CRED, { body: empty })
    const third = JSON.parse(decodeBody(String(stub.calls[2].body)))
    assert.match(third.request_id, /^[0-9a-f-]{36}$/, '空串/空白不算已有')
    assert.match(third.session_id, /^[0-9a-f-]{36}$/)
    assert.notEqual(third.request_id, '   ')
  } finally { stub.restore() }
})

test('chat：body 已是 JSON 串时也补字段，且模型键/stream 仍从解出来的对象取', async () => {
  // 透传场景：宿主可能把 body 直接给成串。此前 `body?.model` 对串恒为 undefined
  // ⇒ X-Model-Key 丢失、非流式被按 SSE 回包。
  const stub = stubFetch(() => new Response('ok', { status: 200 }))
  try {
    const raw = JSON.stringify({ model: 'qwork-advanced', messages: [{ role: 'user', content: 'hi' }] })
    await chat(CRED, { body: raw })
    const call = stub.calls[0]
    const payload = JSON.parse(decodeBody(String(call.body)))
    assert.equal(payload.model, 'qwork-advanced')
    assert.match(payload.request_id, /^[0-9a-f-]{36}$/)
    assert.match(payload.session_id, /^[0-9a-f-]{36}$/)
    assert.equal(call.init.headers['X-Model-Key'], 'qwork-advanced', '串形状也要带模型键')
    assert.equal(call.init.headers.Accept, 'application/json', '没声明 stream 就按非流式要 JSON')
  } finally { stub.restore() }

  // 不是 JSON 的串：原样发出，让网关自己回 400（不在这里猜格式）
  const passthrough = stubFetch(() => new Response('ok', { status: 200 }))
  try {
    await chat(CRED, { body: 'not-json-at-all' })
    assert.equal(decodeBody(String(passthrough.calls[0].body)), 'not-json-at-all', '非 JSON 串不许被改写')
  } finally { passthrough.restore() }
})

test('chat：缺 uid/machineId → 401 + 摘号（签名造不出来，让用户重登）', async () => {
  for (const credential of [
    { access_token: 'AT-1', uid: 'u-1' },
    { access_token: 'AT-1', machineId: 'mid-1' },
  ]) {
    const stub = stubFetch(() => new Response('should not be called', { status: 200 }))
    try {
      const res = await chat(credential, { body: { model: 'm', messages: [] } })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
      assert.match((await res.json()).error.message, /重新登录/)
      assert.equal(stub.calls.length, 0, '造不出签名就不要发请求（发了必 403 Signature invalid）')
    } finally { stub.restore() }
  }
})

test('chat：signal 原样透传（不挂硬超时）', async () => {
  const stub = stubFetch(() => new Response('ok', { status: 200 }))
  const controller = new AbortController()
  try {
    await chat(CRED, { body: { model: 'm', messages: [] }, signal: controller.signal })
    assert.equal(stub.calls[0].init.signal, controller.signal)
  } finally { stub.restore() }
})

test('chat 错误分流：401 摘号 / 402·429 原样换号 / 500 兜成 502', async () => {
  const cases = [
    [401, 401, 'expired'],
    [403, 401, 'expired'],
    [402, 402, undefined],
    [429, 429, undefined],
    [500, 500, undefined],
  ]
  for (const [upstream, expected, signIn] of cases) {
    const stub = stubFetch(() => new Response('upstream says no', { status: upstream }))
    try {
      const res = await chat(CRED, { body: { model: 'm', messages: [] } })
      assert.equal(res.status, expected, `上游 ${upstream} 应映射成 ${expected}`)
      assert.equal(res.headers.get('x-magpie-sign-in') ?? undefined, signIn, `上游 ${upstream} 的摘号头`)
      const body = await res.json()
      assert.equal(body.error.type, 'provider_error')
    } finally { stub.restore() }
  }
})

test('chat：403 Signature invalid 不摘号（是签名错，不是登录态），转 502 upstream_error', async () => {
  const stub = stubFetch(() => json({ code: '101', message: 'Signature invalid' }, 403))
  try {
    const res = await chat(CRED, { body: { model: 'm', messages: [] } })
    assert.equal(res.status, 502, '签名错是我们这边的问题，不是账号问题')
    assert.equal(res.headers.get('x-magpie-sign-in'), null, '摘号会让用户白重登一次也没用')
    const body = await res.json()
    assert.equal(body.error.type, 'upstream_error')
    assert.equal(body.error.code, 'signature_invalid')
    assert.match(body.error.message, /换账号与重登都无效/)
  } finally { stub.restore() }

  // 普通 403（不是签名错）仍按登录态处理
  const plain = stubFetch(() => new Response('forbidden by policy', { status: 403 }))
  try {
    const res = await chat(CRED, { body: { model: 'm', messages: [] } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
  } finally { plain.restore() }
})

test('chat：未登录 → 401 + 摘号头；请求体缺失 → 400（都不抛）', async () => {
  const anon = await chat({}, { body: { model: 'm' } })
  assert.equal(anon.status, 401)
  assert.equal(anon.headers.get('x-magpie-sign-in'), 'expired')

  const noBody = await chat(CRED, {})
  assert.equal(noBody.status, 400)
  assert.match((await noBody.json()).error.message, /请求体缺失/)
})

test('chat 非 2xx 分流：其余 4xx/5xx 一律 provider_error，状态码保留、绝不带摘号头', async () => {
  const cases = [400, 404, 409, 422, 500, 502, 503]
  for (const upstream of cases) {
    const stub = stubFetch(() => new Response(`upstream ${upstream}`, { status: upstream }))
    try {
      const res = await chat(CRED, { body: { model: 'm', messages: [] } })
      assert.equal(res.status, upstream, `上游 ${upstream} 应原样保留（只有 401/403 才改写成 401）`)
      assert.equal(res.headers.get('x-magpie-sign-in'), null, `上游 ${upstream} 不是登录态问题，不得摘号`)
      const body = await res.json()
      assert.equal(body.error.type, 'provider_error')
      assert.match(body.error.message, new RegExp(`HTTP ${upstream}`))
      assert.ok(body.error.message.includes(`upstream ${upstream}`), '上游正文要截进来，便于定位')
    } finally { stub.restore() }
  }

  // 网络层失败 → 503 provider_error（不是抛异常）
  const boom = stubFetch(() => { throw new TypeError('fetch failed') })
  try {
    const res = await chat(CRED, { body: { model: 'm', messages: [] } })
    assert.equal(res.status, 503)
    assert.match((await res.json()).error.message, /连不上网关/)
  } finally { boom.restore() }

  // 成功分支不得读 body（读了流就没了）——用一次性流验证：交回宿主时仍可读
  const ok = stubFetch(() => new Response('data: {"choices":[]}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))
  try {
    const res = await chat(CRED, { body: { model: 'm', stream: true, messages: [] } })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'data: {"choices":[]}\n\n', '成功响应必须原样、未被消费')
  } finally { ok.restore() }
})

// ── 迁移锚点 ─────────────────────────────────────────────────────────────

test('迁移锚点：目录与对话都打 gateway 的 /algo，不再出现 /api/v1 与 openapi.qoder.sh', async () => {
  const stub = stubFetch(({ url }) => (/agent_chat_generation/.test(url) ? new Response('ok', { status: 200 }) : json({ data: [] })))
  try {
    await chat(CRED, { body: { model: 'm', messages: [] } })
    await catalog(CRED)
    // 两次调用都记在同一个 stub 里：分开建两个 stub 会互相覆盖
    const chatCall = stub.calls.find((c) => /agent_chat_generation/.test(c.url))
    const catalogCall = stub.calls.find((c) => /model\/list/.test(c.url))
    assert.ok(chatCall && catalogCall, `两次请求都要被记录：${stub.calls.map((c) => c.url).join(', ')}`)
    for (const call of [chatCall, catalogCall]) {
      assert.equal(call.url.includes('/api/v1/'), false, `目录/对话不许打 /api/v1：${call.url}`)
      assert.equal(call.url.startsWith(`${GATEWAY}/algo/api/v2/`), true, `必须走 gateway 的 /algo：${call.url}`)
      assert.ok(call.init.headers['Cosy-Key'], 'COSY 信封必须有 Cosy-Key（RSA 包的 AES key）')
      assert.ok(call.init.headers['Cosy-Date'], '签名带时间戳')
      assert.match(call.init.headers.Authorization, /^Bearer COSY\.[^.]+\.[0-9a-f]{32}$/,
        'Authorization 是 COSY 签名头，不是普通 Bearer')
    }
    assert.equal(chatCall.url, `${GATEWAY}${COSY_CHAT_PATH}`)
    assert.equal(catalogCall.url, `${GATEWAY}${COSY_MODELS_PATH}`)
  } finally {
    stub.restore()
  }
})

// ── 兜底目录的常量纪律 ───────────────────────────────────────────────────

test('兜底目录：对象键序 = FALLBACK_MODEL_IDS 顺序，三条齐全', () => {
  // 这里**不抄 id 字面量**：抄一份就是一次漂移机会（本机显示层会改写长 id）。
  assert.equal(FALLBACK_MODEL_IDS.length, 3, '上游 QWENWORK_MODELS 三条')
  assert.deepEqual(Object.keys(fallbackModels), FALLBACK_MODEL_IDS, '对象键序 = 上游顺序')
  // 这里**不断言 sort() 的具体结果**：那取决于每个 id 的真实字节（首字符谁大谁小），
  // 而真实字节只有下面那条对上游逐字节比对的用例说了算。
})

test(
  '兜底目录：三个 id 与上游 QWENWORK_MODELS 逐字节一致（防手抄/显示层改写漂移）',
  { skip: !existsSync(UPSTREAM_PKG) },
  () => {
    // 本机显示层会把长 id 渲染成另一个名字：人眼读、终端打印都可能与真实字节不同。
    // 所以这里既不抄常量也不比「看起来一样」，直接用 hex 比字节。
    const text = readFileSync(UPSTREAM_PKG, 'utf8')
    // 上游是数组 `QWENWORK_MODELS = [ { id: "…", … }, … ]`；对象形状也认。
    // 切法必须按括号配对扫描：正则 `[\s\S]*?\n}` 会停在第一个条目的收尾行上，
    // 只拿到一条 —— 那不是「三条都对上了」，是三条里只看了一条。
    const literal = /QWENWORK_MODELS\s*=\s*([[{])/.exec(text)
    assert.ok(literal, '上游应有 QWENWORK_MODELS 字面量（= [ 或 = {）')
    const openAt = literal.index + literal[0].length - 1
    const open = text[openAt]
    const close = open === '[' ? ']' : '}'
    let depth = 0
    let endAt = -1
    for (let i = openAt; i < text.length; i += 1) {
      const ch = text[i]
      // 跳过字符串字面量，否则里面的括号会把深度算歪
      if (ch === '"' || ch === "'" || ch === '`') {
        for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === '\\') i += 1
        continue
      }
      if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') {
        depth -= 1
        if (depth === 0 && ch === close) { endAt = i; break }
      }
    }
    assert.ok(endAt > openAt, '没找到与开括号配对的收口（上游结构变了就重写这段）')
    const closed = text.slice(openAt + 1, endAt)
    const byIdField = [...closed.matchAll(/\bid\s*:\s*(["'])(.*?)\1/g)].map((m) => m[2])
    // 对象形状 `{ 键: { name: … } }`：每行键的最浅缩进才是模型 id，
    // 深层缩进是条目内部字段（name/limit/…），按「最浅缩进」过滤掉。
    const keyed = [...closed.matchAll(/^( +)(["']?)([A-Za-z0-9][\w.:-]*)\2\s*:/gm)]
      .map((m) => ({ indent: m[1].length, key: m[3] }))
    const minIndent = keyed.length > 0 ? Math.min(...keyed.map((k) => k.indent)) : 0
    const byKey = keyed.filter((k) => k.indent === minIndent).map((k) => k.key)
    const upstreamIds = byIdField.length > 0 ? byIdField : byKey
    const hex = (list) => list.map((id) => `${JSON.stringify(id)}=${Buffer.from(id, 'utf8').toString('hex')}`).join(' ')
    assert.equal(upstreamIds.length, 3, `上游应正好三条，实际认出 ${upstreamIds.length}：${hex(upstreamIds)}`)
    assert.deepEqual(
      FALLBACK_MODEL_IDS.map((id) => Buffer.from(id, 'utf8').toString('hex')),
      upstreamIds.map((id) => Buffer.from(id, 'utf8').toString('hex')),
      '顺序与字节都必须与上游一致。失败时下面两行就是真值，照上游那行改常量（别照显示层抄）：\n'
        + `  本仓 FALLBACK_MODEL_IDS: ${hex(FALLBACK_MODEL_IDS)}\n`
        + `  上游 QWENWORK_MODELS   : ${hex(upstreamIds)}`,
    )
  },
)

test('兜底目录：长 id 的字面量在全仓代码里只出现一次（注释也算漂移源）', () => {
  // 上一轮实测：同一份源码里我声称「只剩一处」，实际是两处 —— 定义行 + 注释里又抄了一份。
  // 注释不参与求值，但它是下一次手抄的起点，所以这条门禁把**注释也当命中**。
  //
  // 只查长 id：`flash` / `pro` 这种短名在别处是通用模型键（COSY 测试里大量出现），
  // 拿它们当指纹会误报；短名靠肉眼就能核，长 id 才是显示层会改写的那个。
  //
  // 比较走 hex：本环境文本搜索对长 id 不可靠（Select-String 报 0 命中，实际存在）。
  const ROOT = fileURLToPath(new URL('..', import.meta.url))
  const walk = (dir) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      // 只看代码文件：文档里的引用不影响求值，不在这条门禁的管辖范围
      else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full)
    }
    return out
  }
  const files = [
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'tests')),
    ...walk(join(ROOT, 'scripts')),
    ...readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(mjs|js)$/.test(e.name))
      .map((e) => join(ROOT, e.name)),
  ]

  const longIds = FALLBACK_MODEL_IDS.filter((id) => id.length >= 8)
  assert.ok(longIds.length > 0, 'FALLBACK_MODEL_IDS 里应至少有一个长 id（否则这条门禁空转）')

  const hits = []
  for (const id of longIds) {
    const needle = Buffer.from(id, 'utf8').toString('hex')
    for (const file of files) {
      const hex = Buffer.from(readFileSync(file, 'utf8'), 'utf8').toString('hex')
      let count = 0
      for (let at = hex.indexOf(needle); at !== -1; at = hex.indexOf(needle, at + needle.length)) count += 1
      if (count > 0) hits.push(`${relative(ROOT, file).replaceAll('\\', '/')} ×${count}=${JSON.stringify(id)}`)
    }
  }

  assert.deepEqual(
    hits.sort(), longIds.map((id) => `src/qwenwork-intl.mjs ×1=${JSON.stringify(id)}`).sort(),
    '每个长 id 只许在 src/qwenwork-intl.mjs 出现一次（注释里再抄一份也算）；'
      + `\n  实际命中：${JSON.stringify(hits)}`,
  )
})

// ── 渠道对象 / 登录载体契约 ───────────────────────────────────────────────

test('渠道对象：id/displayName/login 别名/inactive/兜底目录来自上游常量', () => {
  assert.equal(qwenworkIntlChannel.id, 'qwenwork-intl', 'ASCII、发布后不可改')
  assert.equal(qwenworkIntlChannel.displayName, '千问办公 (国际版)')
  assert.equal(typeof qwenworkIntlChannel.beginLogin, 'function')
  assert.equal(qwenworkIntlChannel.login, qwenworkIntlChannel.beginLogin, '交办单里的 login 键')
  assert.deepEqual(qwenworkIntlChannel.checkin(), { outcome: 'inactive' }, '无签到端点 → inactive')
  assert.equal(typeof qwenworkIntlChannel.fallbackModels, 'object', 'fallbackModels 必须是对象（函数会被当空目录）')
  assert.equal(Object.keys(qwenworkIntlChannel.fallbackModels).length, 3, '上游 QWENWORK_MODELS 三条')
  assert.equal(typeof qwenworkIntlChannel.catalog, 'function')
  assert.equal(typeof qwenworkIntlChannel.chat, 'function')
  assert.equal(typeof qwenworkIntlChannel.refresh, 'function')
  assert.equal(typeof qwenworkIntlChannel.expired, 'function')
  assert.equal(qwenworkIntlChannel.usage, undefined, '国际站额度只走账号上下文，不写 usage（写了就得走 banding）')
})

test('beginLogin：立刻返回、自己在浏览器里打开**授权页**（opened 语义），本地只留状态页', async () => {
  const authorizeUrl = 'https://qwenwork.ai/oauth2/auth?client_id=qwenwork-desktop-app&state=feed'
  const stub = stubFetch(({ url }) => {
    if (url.startsWith(DEVICE_START)) return redirect(authorizeUrl)
    if (url.startsWith(DEVICE_POLL)) return new Response('', { status: 404 }) // 一直 pending
    return new Response('unexpected', { status: 500 })
  })
  const opened = []
  const startedAt = Date.now()
  let started
  try {
    started = await qwenworkIntlChannel.beginLogin((url) => opened.push(url))
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 2000, `必须立刻返回，实际 ${elapsed}ms`)
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/login$/, '本地只留状态页')
    assert.deepEqual(opened, [authorizeUrl], '插件打开的是授权页，不是本地页')
    assert.equal(started.opened, true, '自己开了窗口就必须回 opened:true，否则宿主会再开一个')
    assert.ok(started.result instanceof Promise)
    assert.equal(typeof started.instructions, 'string')
    assert.match(started.instructions, /qwenwork\.ai\/oauth2\/auth/, '拿不到浏览器时要能手动照抄')

    // 本地页：只有「打开授权页」与进度，**没有粘贴框**（设备流没有投递入口）
    const page = await (await realFetch(started.url)).text()
    assert.match(page, /打开授权页/)
    assert.match(page, /qwenwork\.ai\/oauth2\/auth/, '授权 URL 要出现在页面里')
    assert.equal(page.includes('<textarea'), false, '设备流不接受粘贴，页面不该有输入框')

    const status = await (await realFetch(started.url.replace('/login', '/status'))).json()
    assert.equal(typeof status.phase, 'string')
    assert.equal(status.phase, 'polling', '还没拿到 token')
  } finally {
    stub.restore()
    started?.cancel?.('测试结束')
    await started?.result.catch(() => {})
  }
})

test('beginLogin 端到端：poll 拿到 token → 读账号上下文 → result 交出带 machineId 的凭据', async () => {
  const authorizeUrl = 'https://qwenwork.ai/oauth2/auth?client_id=qwenwork-desktop-app&state=e2e'
  const stub = stubFetch(({ url }) => {
    if (url.startsWith(DEVICE_START)) return redirect(authorizeUrl)
    if (url.startsWith(DEVICE_POLL)) {
      return json({ access_token: 'AT-E2E', refresh_token: 'RT-E2E', expires_in: 1800 })
    }
    if (url.startsWith(ACCOUNT_CONTEXT)) {
      return json({ data: { user: { id: 'af25a663-e2e', name: '1610105401', email: 'z@example.com' } } })
    }
    return new Response(`unexpected ${url}`, { status: 500 })
  })
  let started
  try {
    started = await qwenworkIntlChannel.beginLogin(() => {})
    const credential = await started.result
    assert.equal(credential.access_token, 'AT-E2E')
    assert.equal(credential.refresh_token, 'RT-E2E')
    assert.equal(credential.nickname, '1610105401')
    assert.equal(credential.email, 'z@example.com')
    assert.equal(credential.uid, 'af25a663-e2e', '账号上下文给的 uid 就是 COSY 的 Cosy-User')
    assert.equal(credential.channel, 'qwenwork-intl')
    assert.match(credential.machineId, /^[0-9a-f-]{36}$/i, '设备身份要随凭据一起存，续期后才打得了 /algo')
    assert.ok(credential.expires_at > Date.now())

    // 轮询参数与入口参数必须同源：verifier 配对 challenge，nonce 与入口一致
    const pollCall = stub.calls.find((c) => c.url.startsWith(DEVICE_POLL))
    const startCall = stub.calls.find((c) => c.url.startsWith(DEVICE_START))
    assert.ok(pollCall && startCall)
    assert.equal(new URL(pollCall.url).searchParams.get('nonce'), new URL(startCall.url).searchParams.get('nonce'))
    const verifier = new URL(pollCall.url).searchParams.get('verifier')
    assert.equal(createHash('sha256').update(verifier).digest('base64url'),
      new URL(startCall.url).searchParams.get('challenge'), 'poll 的 verifier 必须对得上入口的 challenge')
    // 成功之后不该再去 poll 一次
    const pollsBefore = stub.calls.filter((c) => c.url.startsWith(DEVICE_POLL)).length
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(stub.calls.filter((c) => c.url.startsWith(DEVICE_POLL)).length, pollsBefore, '拿到 token 后必须停轮询')
  } finally {
    stub.restore()
    started?.cancel?.('测试结束')
    await started?.result.catch(() => {})
  }
})

test('beginLogin：设备流入口被拒 → result 直接给失败，不返回可用的 url/result 假象', async () => {
  const stub = stubFetch(() => json({ error: 'INVALID_DEVICE_FLOW' }, 400))
  try {
    const started = await qwenworkIntlChannel.beginLogin(() => {})
    assert.equal(started.opened, undefined, '没起成流程就没有授权页可开')
    assert.match(started.instructions, /INVALID_DEVICE_FLOW/)
    await assert.rejects(() => started.result, /设备流无法启动/)
  } finally { stub.restore() }
})