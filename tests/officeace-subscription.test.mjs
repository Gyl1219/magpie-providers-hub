// officeace 订阅面（V11 签名 / 积分分桶 / 每日签到 / 倍率进目录）的移植语义回归。
// 全部 stub fetch；V11 的三条铁律各有一条用例钉死。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

const dpopJwk = await webcrypto.subtle
  .generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  .then((k) => webcrypto.subtle.exportKey('jwk', k.privateKey))

const CRED = {
  access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'P1',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'RT', dpopPrivateJwk: dpopJwk,
  modelAppKey: 'k', modelAppSecret: 's', modelApiUrlBase: 'gw.example.com',
}

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, init, calls })
    }
    return new Response('{}', { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

// ── V11 签名三条铁律（请求形状检查）─────────────────────────────────────

test('V11 GET：不带 Content-Type（多这个头签名串多一行必 401）+ Authorization 形状', async () => {
  const { fetchUsage } = await import('../src/officeace.mjs')
  const stub = stubFetch([{
    match: '/v1/subscription',
    respond: () => json({ skus: [], bonus_skus: [] }),
  }])
  try {
    await fetchUsage(CRED)
    const call = stub.calls[0]
    assert.equal(call.init.headers['Content-Type'], undefined, 'GET 不得带 Content-Type（铁律 1）')
    assert.match(call.init.headers.Authorization, /^V11-HMAC-SHA256 Credential=AK\/\d{8}\/cn-southwest-2\/apic, /)
    assert.ok(call.init.headers.Authorization.includes('SignedHeaders='))
    assert.equal(call.init.headers['x-subscription-type'], 'v2')
    assert.equal(call.init.headers['X-Security-Token'], 'ST')
    assert.equal(call.init.headers['X-Project-ID'], 'P1')
  } finally {
    stub.restore()
  }
})

test('V11 POST（签到）：必须带 Content-Type（不带是 500 11020001）', async () => {
  const { checkin } = await import('../src/officeace.mjs')
  const stub = stubFetch([{
    match: '/bonus/claim',
    respond: () => json({ bonus_skus: [{ activity_id: 'd', activity_name: '每日签到', points: 1000 }] }),
  }])
  try {
    const outcome = await checkin(CRED)
    assert.equal(call().init.headers['Content-Type'], 'application/json;charset=utf8', 'POST 必须带 Content-Type（铁律 1 的另一面）')
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 1000)
    function call() { return stub.calls[0] }
  } finally {
    stub.restore()
  }
})

test('V11 POST 的 body 参与 payload 哈希（空 body 按空串计）—— URL 尾斜杠由服务端校验', async () => {
  const { checkin } = await import('../src/officeace.mjs')
  const stub = stubFetch([{
    match: '/bonus/claim',
    respond: () => new Response('', { status: 200 }),
  }])
  try {
    const outcome = await checkin(CRED)
    // 空响应体 + 2xx = 已领取（官方对重复领取也回 200，幂等由服务端保证）
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(stub.calls[0].url.endsWith('/v1/subscription/bonus/claim'), true)
  } finally {
    stub.restore()
  }
})

// ── 签到失败语义（DSH 真实报障：静默失败每天白丢 1000 分）────────────────

test('签到：401 必须按状态码报 failed + 带服务端报文（不能读成「没有可领的」）', async () => {
  const { checkin } = await import('../src/officeace.mjs')
  const stub = stubFetch([{
    match: '/bonus/claim',
    respond: () => new Response('{"error_code":"IAM_TOKEN_EXPIRED"}', { status: 401 }),
  }])
  try {
    const outcome = await checkin(CRED)
    assert.equal(outcome.outcome, 'failed')
    assert.match(outcome.message, /401/)
    assert.match(outcome.message, /IAM_TOKEN_EXPIRED/, '服务端报文是唯一指路信息，必须带出')
  } finally {
    stub.restore()
  }
})

test('签到：凭据缺失（无 securityToken）→ failed，不发请求', async () => {
  const { checkin } = await import('../src/officeace.mjs')
  let called = 0
  const stub = stubFetch([{ match: 'x', respond: () => { called += 1; return json({}) } }])
  try {
    const outcome = await checkin({ access: 'AK' })
    assert.equal(outcome.outcome, 'failed')
    assert.match(outcome.message, /凭据缺失/)
    assert.equal(called, 0)
  } finally {
    stub.restore()
  }
})

// ── 订阅分桶 ────────────────────────────────────────────────────────────

test('订阅分桶：套餐桶（.trial 不带到期）+ 活动桶 + 过期桶折叠 + resetsAt', async () => {
  const { fetchUsage } = await import('../src/officeace.mjs')
  const stub = stubFetch([{
    match: '/v1/subscription',
    respond: () => json({
      skus: [
        { sku_name: '专业版', sku_code: 'pro.monthly', quotas: [
          { sku_attr_code: 'officeace_points', sku_value: 10000, current_value: 2500, expired_time: '2026-11-24T23:59:59+08:00' },
          { sku_attr_code: 'other_quota', sku_value: 1, current_value: 0 }, // 非 points 的 quota 跳过
        ] },
        { sku_name: '试用', sku_code: 'starter.trial', quotas: [
          { sku_attr_code: 'officeace_points', sku_value: 500, current_value: 0 }, // trial：无到期字段
        ] },
        { sku_name: '已过期套餐', sku_code: 'old.monthly', quotas: [
          { sku_attr_code: 'officeace_points', sku_value: 800, current_value: 0, expired_time: '2026-10-01T23:59:59+08:00' },
        ] },
      ],
      bonus_skus: [
        { activity_id: 'daily', activity_name: '每日签到', points: 1000, current_value: 400, expired_time: '2026-10-25T23:59:59+08:00' },
      ],
    }),
  }])
  try {
    const windows = await fetchUsage(CRED)
    assert.equal(windows.length, 4)
    const pro = windows.find((w) => w.name.includes('专业版'))
    assert.equal(pro.used, 25, 'used = current/sku_value 百分比')
    assert.equal(pro.display, '7500 / 10000')
    assert.ok(pro.resetsAt !== undefined, '套餐桶带 resetsAt（重置前提醒吃它）')
    const trial = windows.find((w) => w.name.includes('试用'))
    assert.equal(trial.resetsAt, undefined, '.trial 后缀不带到期（试用不过期语义，照抄 DSH 判据）')
    const expired = windows.find((w) => w.name.includes('已过期'))
    assert.equal(expired.aside, true, '已过期桶收进折叠区')
    const bonus = windows.find((w) => w.name.includes('每日签到'))
    assert.equal(bonus.display, '600 / 1000')
    assert.ok(bonus.resetsAt !== undefined, '活动桶的当日 23:59:59 作废时间进 resetsAt')
  } finally {
    stub.restore()
  }
})

test('订阅查询失败：带 HTTP 状态与报文（不吞）', async () => {
  const { fetchUsage } = await import('../src/officeace.mjs')
  const stub = stubFetch([{
    match: '/v1/subscription',
    respond: () => new Response('{"error":"token expired"}', { status: 401 }),
  }])
  try {
    await assert.rejects(
      () => fetchUsage(CRED),
      /订阅查询失败：HTTP 401.*token expired/s,
    )
  } finally {
    stub.restore()
  }
})

// ── 倍率进目录名 ────────────────────────────────────────────────────────

test('目录：倍率拼进展示名（x1 不标）；倍率表拉不到纯降级', async () => {
  // 两段各用全新模块实例（倍率缓存是模块级 20 分钟，跨段复用会让降级段读到成功缓存）
  const q1 = '?v=' + Date.now() + '-a'
  const { officeaceChannel } = await import('../src/officeace.mjs' + q1)
  const stub = stubFetch([
    {
      match: '/v2/models',
      respond: () => json({ data: [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      ] }),
    },
    {
      match: '/v1/model-token-rates',
      respond: () => json({ models: [
        { model_name: 'glm-5.2', cost_coefficient: 0.7 },
        { model_name: 'deepseek-v4.1-flash', cost_coefficient: 1 },
      ] }),
    },
  ])
  try {
    const models = await officeaceChannel.catalog(CRED)
    assert.match(models['glm-5.2'].name, /GLM-5\.2 · x0\.7/, '非 1 倍率必须进名字（选型最重要的信号）')
    assert.equal(models['deepseek-v4.1-flash'].name, 'DeepSeek V4.1 Flash', 'x1 不标（默认倍率没有信息量）')
  } finally {
    stub.restore()
  }
  // 降级：全新实例 + 倍率端点挂了 → 目录照常，只是无 x 系数
  const q2 = '?v=' + Date.now() + '-b'
  const { officeaceChannel: fresh } = await import('../src/officeace.mjs' + q2)
  const stub2 = stubFetch([
    { match: '/v2/models', respond: () => json({ data: [{ id: 'glm-5.2', name: 'GLM-5.2' }] }) },
    { match: '/v1/model-token-rates', respond: () => new Response('err', { status: 500 }) },
  ])
  try {
    const models = await fresh.catalog(CRED)
    assert.equal(models['glm-5.2'].name, 'GLM-5.2', '倍率失败 → 优雅降级（模型照常可选）')
  } finally {
    stub2.restore()
  }
})
