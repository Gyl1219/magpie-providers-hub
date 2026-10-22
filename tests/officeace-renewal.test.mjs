// 从 DSH 移植的续期语义（五处缺口）。
//
// 这些全是「只在真机才现形」的行为，且错了以后症状极具误导性，故逐条钉死。
// 全程 stub fetch，不发真实请求。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import {
  officeaceChannel,
  expired,
  basicAuthFingerprint,
  isBasicCredentialRejection,
  EXPIRY_LEAD_MS,
} from '../src/officeace.mjs'

const MAAS = 'officeace.example-gw.com'

// DPoP 私钥必须是**合法**的 P-256 JWK：续期路径会 importKey + 签名，
// 随手编的 {x:'AA',y:'BB'} 会在 importKey 就炸（症状像「签名逻辑坏了」，
// 实际是夹具不合法）。用 webcrypto 现生成一份。
const dpopJwk = await webcrypto.subtle
  .generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  .then((k) => webcrypto.subtle.exportKey('jwk', k.privateKey))

/** 一份最小可用凭据（字段名与真实落盘一致）。 */
const credential = (over = {}) => ({
  access: 'AK',
  secret: 'SK',
  securityToken: 'ST',
  projectId: '',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'RT-one-shot',
  dpopPrivateJwk: dpopJwk,
  modelAppKey: 'key-1',
  modelAppSecret: 'sec-1',
  modelApiUrlBase: MAAS,
  ...over,
})

/** 按 URL 子串路由的 stub fetch，并记录每次调用。 */
const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body })
    for (const [pattern, make] of routes) {
      if (url.includes(pattern)) return make({ url, init })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const STS_OK = (refreshToken) => JSON.stringify({
  credentials: {
    access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
    project_id: 'P2', expiration: new Date(Date.now() + 7200_000).toISOString(),
  },
  refresh_token: refreshToken,
})

const MODEL_INFO_OK = (key = 'key-2', secret = 'sec-2', base = MAAS) => JSON.stringify({
  subscription: {
    model_info: {
      model_auth_info: { model_app_key: key, model_app_secret: secret },
      model_api_url_base: base,
    },
  },
})

// ── 缺口 1：并发去重闸（refresh_token 一次性）──────────────────────────────
test('并发续期只发一次 STS 请求（否则第二次消费一次性 token，凭据永久失效）', async () => {
  const stub = stubFetch([
    ['oauth2/tokens', () => new Response(STS_OK('RT-new'), { status: 200 })],
    ['client-permission-validate', () => new Response(MODEL_INFO_OK(), { status: 200 })],
  ])
  try {
    const base = credential()
    const persisted = []
    const [a, b, c] = await Promise.all([
      officeaceChannel.refresh(base, (p) => persisted.push(p)),
      officeaceChannel.refresh(base, (p) => persisted.push(p)),
      officeaceChannel.refresh(base, (p) => persisted.push(p)),
    ])
    const stsCalls = stub.calls.filter((x) => x.url.includes('oauth2/tokens'))
    assert.equal(stsCalls.length, 1, `并发续期发了 ${stsCalls.length} 次 STS 请求，应为 1 次`)
    assert.equal(a, b, '并发调用应共享同一结果（同一 promise）')
  } finally {
    stub.restore()
  }
})

// ── 缺口 5：STS 成功即落盘，不等 modelInfo ─────────────────────────────────
test('STS 一成功就落盘（modelInfo 失败也不能丢新 refresh_token）', async () => {
  const stub = stubFetch([
    ['oauth2/tokens', () => new Response(STS_OK('RT-new'), { status: 200 })],
    // modelInfo 炸掉：这正是原先会丢 token 的路径
    ['client-permission-validate', () => { throw new Error('modelInfo 网络抖动') }],
  ])
  const persisted = []
  try {
    const next = await officeaceChannel.refresh(credential(), (p) => persisted.push({ ...p }))
    assert.ok(persisted.length >= 1, 'STS 成功后必须至少落盘一次，且发生在 modelInfo 之前')
    assert.equal(persisted[0].refreshToken, 'RT-new', '落盘的必须是新 refresh_token')
    // modelInfo 失败不回滚：仍返回凭据（旧的 appKey 也还在）
    assert.equal(next.refreshToken, 'RT-new')
  } finally {
    stub.restore()
  }
})

// ── 缺口 2：临期提前量 ────────────────────────────────────────────────────
test('临期判据提前 10 分钟（一次长对话会在中途过期）', () => {
  assert.equal(EXPIRY_LEAD_MS, 10 * 60 * 1000)
  const mk = (msFromNow) => credential({ expiresAt: new Date(Date.now() + msFromNow).toISOString() })
  assert.equal(expired(mk(9 * 60 * 1000)), true, '剩 9 分钟应判临期')
  assert.equal(expired(mk(11 * 60 * 1000)), false, '剩 11 分钟应判有效')
  assert.equal(expired(mk(-1000)), true, '已过期必须判临期')
})

test('expiresAt 解析不出来时保守判临期（不能假设有效）', () => {
  assert.equal(expired(credential({ expiresAt: '不是时间' })), true)
  // 完全没这个字段 → 无从判断，不触发续期（由 401 那条路兜底）
  assert.equal(expired(credential({ expiresAt: undefined })), false)
})

// ── 缺口 4：指纹必须含 host ───────────────────────────────────────────────
test('指纹含网关 host：只有网关变了也算“重发有意义”', () => {
  const a = basicAuthFingerprint(credential())
  // Basic 二元组逐字节不变、只有网关变了（真实缺陷场景）
  const b = basicAuthFingerprint(credential({ modelApiUrlBase: 'modelgw-0004.officeace.example-gw.com' }))
  assert.notEqual(a, b, '网关不同必须指纹不同，否则换网关后的重发会被判为无意义')
  // 只有 STS 三元组变、Basic 与 host 都没变 → 指纹应相同（重发没意义）
  const c = basicAuthFingerprint(credential({ access: 'X', secret: 'Y', securityToken: 'Z' }))
  assert.equal(a, c, 'STS 变化不应改变 Basic 指纹')
})

// ── 缺口 4：什么算「这对 Basic 凭据被拒」 ─────────────────────────────────
test('凭据拒绝判据：4xx+报文认，2xx 与 5xx 一律不认', () => {
  const body = '{"error":{"code":"APIG.1009","message":"AppKey or AppSecret is invalid"}}'
  assert.equal(isBasicCredentialRejection(401, body), true, '真机的 401')
  assert.equal(isBasicCredentialRejection(400, body), true, '华为文档定义的 400')
  assert.equal(isBasicCredentialRejection(403, 'AppKey or AppSecret'), true, '包装层改码也不该漏')
  // 2xx 的 body 是模型输出，可能原样复述这句 ⇒ 认了就等于「一次成功回答熔断整渠道」
  assert.equal(isBasicCredentialRejection(200, body), false)
  // 5xx 是基础设施抖动，形状未知
  assert.equal(isBasicCredentialRejection(502, body), false)
  assert.equal(isBasicCredentialRejection(500, 'gateway html error'), false)
  // 401 但报文不是已知形状（网关/代理层 401）⇒ 不算凭据拒绝
  assert.equal(isBasicCredentialRejection(401, '<html>502 bad gateway</html>'), false)
})

// ── 缺口 4：401 的四态与是否重发 ──────────────────────────────────────────
const chatBody = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }

test('401 + 续期换掉了三元组 ⇒ 用新凭据重发一次', async () => {
  const stub = stubFetch([
    ['/v2/chat/completions', ({ calls }) => {
      const seen = stub.calls.filter((x) => x.url.includes('/v2/chat/completions')).length
      // 第一次 401，第二次（重发）200
      if (seen === 1) return new Response('{"error":"APIG.1009 AppKey or AppSecret is invalid"}', { status: 401 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }],
  ])
  try {
    const response = await officeaceChannel.chat(credential(), {
      body: chatBody,
      renew: async () => credential({ modelAppKey: 'key-2', modelAppSecret: 'sec-2' }),
    })
    const chats = stub.calls.filter((x) => x.url.includes('/v2/chat/completions'))
    assert.equal(chats.length, 2, '换了凭据应重发一次')
    assert.equal(response.status, 200)
  } finally {
    stub.restore()
  }
})

test('401 + 续期后三元组逐字节没变 ⇒ 不白重发，归因写明“重登无效”', async () => {
  const stub = stubFetch([
    ['/v2/chat/completions', () => new Response('{"error":"APIG.1009 AppKey or AppSecret is invalid"}', { status: 401 })],
  ])
  try {
    const response = await officeaceChannel.chat(credential(), {
      body: chatBody,
      // 续期成功但 appKey/appSecret/host 完全没变（真实缺陷形态）
      renew: async () => credential({ access: 'NEW_AK' }),
    })
    const chats = stub.calls.filter((x) => x.url.includes('/v2/chat/completions'))
    assert.equal(chats.length, 1, '指纹未变时不得白重发')
    const payload = await response.json()
    assert.equal(payload.error.renewal_outcome, 'unchanged')
    assert.match(payload.error.message, /一个字节都没变/)
    assert.match(payload.error.message, /反复重登|重新登录改变不了/)
  } finally {
    stub.restore()
  }
})

test('401 + 续期抛错 ⇒ 四态记 unreadable（不与 unchanged 混淆）', async () => {
  const stub = stubFetch([
    ['/v2/chat/completions', () => new Response('{"error":"APIG.1009 AppKey or AppSecret is invalid"}', { status: 401 })],
  ])
  try {
    const response = await officeaceChannel.chat(credential(), {
      body: chatBody,
      renew: async () => { throw new Error('STS5.1806 refresh_token 已被消费') },
    })
    const payload = await response.json()
    assert.equal(payload.error.renewal_outcome, 'unreadable',
      '续期失败必须与「续期成功但没变化」区分，否则会给错指引')
    assert.match(payload.error.message, /重新登录/)
  } finally {
    stub.restore()
  }
})

test('5xx 不触发续期（基础设施抖动不该消费一次性 token）', async () => {
  const stub = stubFetch([
    ['/v2/chat/completions', () => new Response('upstream 502', { status: 502 })],
  ])
  let renewed = 0
  try {
    await officeaceChannel.chat(credential(), {
      body: chatBody,
      renew: async () => { renewed += 1; return credential() },
    })
    assert.equal(renewed, 0, '5xx 不该尝试续期')
  } finally {
    stub.restore()
  }
})

test('成功响应不触发续期，也不被“模型复述报文”误判成凭据拒绝', async () => {
  const stub = stubFetch([
    ['/v2/chat/completions', () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'APIG.1009 AppKey or AppSecret is invalid' } }] }),
      { status: 200 },
    )],
  ])
  let renewed = 0
  try {
    const response = await officeaceChannel.chat(credential(), {
      body: chatBody,
      renew: async () => { renewed += 1; return credential() },
    })
    assert.equal(response.status, 200)
    assert.equal(renewed, 0)
  } finally {
    stub.restore()
  }
})

// ── 缺口 3：软续期不打死可用凭据 ─────────────────────────────────────────
test('渠道 refresh 失败会抛出（由聚合层决定吞或不吞，判据只有一份）', async () => {
  const stub = stubFetch([
    ['oauth2/tokens', () => new Response('STS5.1806 already consumed', { status: 400 })],
  ])
  try {
    await assert.rejects(() => officeaceChannel.refresh(credential()), /续期失败/)
  } finally {
    stub.restore()
  }
})
