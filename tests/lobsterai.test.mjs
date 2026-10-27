// LobsterAI（有道龙虾）渠道移植语义回归（全部 stub fetch）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-lobster-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { lobsteraiChannel, parseEnvelope } = await import('../src/lobsterai.mjs')

test.after(() => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
})

const CRED = {
  access_token: 'at_lobster',
  refresh_token: 'rt_lobster',
  expires_at: String(Date.now() + 3600_000),
  uid: 'uid-1',
  user_id: 'yid-1',
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('127.0.0.1')) return original(input, init)
    calls.push({ url, headers: init?.headers ?? {}, method: init?.method ?? 'GET', body: init?.body })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, calls })
    }
    return json({ code: 0, msg: 'OK', data: {} })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 信封 ────────────────────────────────────────────────────────────────

test('信封：code !== 0 即失败（含 code 为字符串的形态）', () => {
  assert.equal(parseEnvelope({ code: 0, data: { a: 1 } }).ok, true)
  assert.equal(parseEnvelope({ code: '0', data: {} }).ok, true, '字符串 "0" 也认')
  const bad = parseEnvelope({ code: 401, msg: '未登录' })
  assert.equal(bad.ok, false)
  assert.equal(bad.message, '未登录')
  assert.equal(parseEnvelope({ code: 500 }).ok, false)
  assert.equal(parseEnvelope('nope').ok, false)
})

// ── 目录 ────────────────────────────────────────────────────────────────

test('目录：必须带客户端能力头与版本头（否则少 kimi-k3）', async () => {
  const stub = stubFetch([{
    match: '/api/models/available',
    respond: ({ calls }) => {
      const h = calls.at(-1).headers
      assert.ok(h.Authorization?.startsWith('Bearer '), '目录要 Bearer')
      assert.ok(h['X-LobsterAI-Client-Capabilities'], '缺能力头会少模型（DSH 实测 25 vs 26）')
      assert.ok(h['X-LobsterAI-Client-Version'], '缺版本头')
      return json({
        code: 0,
        data: [
          { id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 131072, maxTokens: 8192 },
          { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262144, inputModalities: ['text', 'image'] },
        ],
      })
    },
  }])
  try {
    const models = await lobsteraiChannel.catalog(CRED)
    assert.deepEqual(Object.keys(models).sort(), ['deepseek-v4', 'kimi-k3'])
    assert.equal(models['kimi-k3'].capabilities.attachment, true, 'inputModalities 含 image → 支持图片')
    assert.equal(models['deepseek-v4'].limit.context, 131_072)
  } finally {
    stub.restore()
  }
})

test('目录：离谱数值被拒（308 位数字串不得进 context）', async () => {
  const stub = stubFetch([{
    match: '/api/models/available',
    respond: () => json({
      code: 0,
      data: [{ id: 'weird', name: 'Weird', contextWindow: Number('9'.repeat(300)) || 1e308 }],
    }),
  }])
  try {
    const models = await lobsteraiChannel.catalog(CRED)
    assert.equal(models.weird.limit.context, 131_072, '异常值回落保守默认')
  } finally {
    stub.restore()
  }
})

// ── 余额 ────────────────────────────────────────────────────────────────

test('余额：creditItems 逐笔输出（带 expiresAt 作废时刻），过期笔跳过', async () => {
  const future1 = Date.now() + 2 * 86400_000
  const future2 = Date.now() + 40 * 86400_000
  const past = Date.now() - 86400_000
  // ⚠️ 上游下发的是**无时区**的本地时间串（"YYYY-MM-DDTHH:mm:ss"），
  //    渠道按本地解析（DSH 同款）—— 测试也要按本地构造，不能拿 UTC 串切片
  const iso = (ms) => {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  const stub = stubFetch([{
    match: '/api/user/profile-summary',
    respond: () => json({
      code: 0,
      data: {
        totalCreditsRemaining: 2172.02,
        creditItems: [
          { label: '每日登录奖励', creditsRemaining: 100, expiresAt: iso(future1) },
          { label: '每日登录奖励', creditsRemaining: 100, expiresAt: iso(future2) },
          { label: 'DeepSeek 异常积分返还', creditsRemaining: 58.49 }, // 无到期 = 永久
          { label: '已过期包', creditsRemaining: 100, expiresAt: iso(past) },
        ],
      },
    }),
  }])
  try {
    const windows = await lobsteraiChannel.usage(CRED)
    assert.equal(windows.length, 3, '过期笔不显示（不可用）')
    // 逐笔带 amount + runsOutAt —— 聚合层据此折叠成 临期/长期/永久
    assert.equal(windows[0].amount, 100)
    // 无时区本地串按本地解析回同一瞬间（round-trip 语义）
    assert.equal(windows[0].runsOutAt, new Date(iso(future1)).toISOString())
    assert.match(windows[0].display, /后作废/, '倒计时进 display（指针桶收起后仍可见）')
    assert.equal(windows[1].runsOutAt, new Date(iso(future2)).toISOString())
    assert.equal(windows[2].runsOutAt, undefined, '无到期 = 永久')
  } finally {
    stub.restore()
  }
})

test('余额：全部过期 → 如实显示「无可用积分」；空 creditItems 回总额', async () => {
  const past = Date.now() - 86400_000
  const stubAllExpired = stubFetch([{
    match: '/api/user/profile-summary',
    respond: () => json({ code: 0, data: { creditItems: [{ label: 'x', creditsRemaining: 100, expiresAt: new Date(past).toISOString() }] } }),
  }])
  try {
    const windows = await lobsteraiChannel.usage(CRED)
    assert.match(windows[0].display, /无可用积分/)
  } finally {
    stubAllExpired.restore()
  }
  const stubTotal = stubFetch([{
    match: '/api/user/profile-summary',
    respond: () => json({ code: 0, data: { totalCreditsRemaining: 300 } }),
  }])
  try {
    const windows = await lobsteraiChannel.usage(CRED)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].display, '剩余 300')
  } finally {
    stubTotal.restore()
  }
})

// ── 签到（三步）──────────────────────────────────────────────────────────

test('签到：slot → context → check_in 全流程，积分走三级回退', async () => {
  const step = { slot: 0, ctx: 0, claim: 0 }
  const stub = stubFetch([
    {
      match: '/api/client-activities/slot',
      respond: ({ url }) => {
        step.slot += 1
        assert.match(url, /placement=desktop_sidebar/)
        assert.match(url, /platform=win32/)
        assert.match(url, /containerApiVersion=2/)
        return json({ code: 0, data: { slotState: 'available', activity: { activityCode: 'daily', configRevision: 7 } } })
      },
    },
    {
      match: '/context',
      respond: ({ url }) => {
        step.ctx += 1
        assert.match(url, /configRevision=7/)
        return json({ code: 0, data: { state: { claimedToday: false }, actions: ['check_in'] } })
      },
    },
    {
      match: '/actions/check_in',
      respond: ({ calls }) => {
        step.claim += 1
        const body = JSON.parse(calls.at(-1).body)
        assert.equal(body.configRevision, 7, 'configRevision 必须回传')
        assert.equal(typeof body.idempotencyKey, 'string', '幂等键必需')
        assert.ok(body.idempotencyKey.length >= 32)
        // 三级回退链的第二级：rewardCredits
        return json({ code: 0, data: { result: { rewardCredits: 200, message: '签到成功' } } })
      },
    },
  ])
  try {
    const outcome = await lobsteraiChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 200)
    assert.equal(outcome.message, '签到成功')
    assert.deepEqual(step, { slot: 1, ctx: 1, claim: 1 })
  } finally {
    stub.restore()
  }
})

test('签到：claimedToday → done（幂等，不再打领取接口）', async () => {
  let claimCalls = 0
  const stub = stubFetch([
    { match: '/slot', respond: () => json({ code: 0, data: { slotState: 'available', activity: { activityCode: 'daily', configRevision: 1 } } }) },
    { match: '/context', respond: () => json({ code: 0, data: { state: { claimedToday: true }, actions: ['check_in'] } }) },
    { match: '/actions/check_in', respond: () => { claimCalls += 1; return json({ code: 0, data: {} }) } },
  ])
  try {
    const outcome = await lobsteraiChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'done')
    assert.equal(claimCalls, 0, '已签到不得再打领取（服务端幂等也不能白打）')
  } finally {
    stub.restore()
  }
})

test('签到：活动在但 actions 无 check_in → ineligible（与已领取区分）', async () => {
  const stub = stubFetch([
    { match: '/slot', respond: () => json({ code: 0, data: { slotState: 'available', activity: { activityCode: 'x', configRevision: 1 } } }) },
    { match: '/context', respond: () => json({ code: 0, data: { state: { claimedToday: false }, actions: [] } }) },
  ])
  try {
    const outcome = await lobsteraiChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'ineligible')
    assert.match(outcome.message, /不可签到/)
  } finally {
    stub.restore()
  }
})

test('签到：无可用活动槽 → inactive', async () => {
  const stub = stubFetch([{
    match: '/slot',
    respond: () => json({ code: 0, data: { slotState: 'empty', activity: {} } }),
  }])
  try {
    const outcome = await lobsteraiChannel.checkin(CRED)
    assert.equal(outcome.outcome, 'inactive')
  } finally {
    stub.restore()
  }
})

// ── 续期 ────────────────────────────────────────────────────────────────

test('续期：不带 Authorization（带了会被拒）；身份字段保留', async () => {
  const stub = stubFetch([{
    match: '/api/auth/refresh',
    respond: ({ calls }) => {
      const h = calls.at(-1).headers
      assert.equal(h.Authorization, undefined, '⚠️ refresh 不能带 Authorization')
      assert.ok(h['User-Agent'], '要有 UA')
      const body = JSON.parse(calls.at(-1).body)
      assert.equal(body.refreshToken, 'rt_lobster')
      assert.equal(body.userId, 'yid-1', 'userId 取 user_id 优先')
      return json({ code: 0, data: { accessToken: 'at_new', refreshToken: 'rt_new', expiresIn: 3600 } })
    },
  }])
  try {
    const next = await lobsteraiChannel.refresh(CRED)
    assert.equal(next.access_token, 'at_new')
    assert.equal(next.refresh_token, 'rt_new')
    assert.equal(next.uid, 'uid-1', '上游没回 uid 时保留原值')
    assert.equal(next.user_id, 'yid-1')
    assert.ok(Number(next.expires_at) > Date.now(), 'expires_at 由 expiresIn 推算（毫秒串）')
  } finally {
    stub.restore()
  }
})

test('续期：无 refresh_token → 明确报错；失效 → signedOut', async () => {
  await assert.rejects(() => lobsteraiChannel.refresh({ access_token: 'x' }), /没有 refresh_token/)
  const stub = stubFetch([{
    match: '/api/auth/refresh',
    respond: () => json({ code: 401, msg: 'invalid refresh token' }),
  }])
  try {
    await assert.rejects(
      () => lobsteraiChannel.refresh(CRED),
      (error) => /invalid/i.test(error.message) && error.signedOut === true,
    )
  } finally {
    stub.restore()
  }
})

test('过期判定：提前 10 分钟算临期；无 expires_at 视为不过期', () => {
  assert.equal(lobsteraiChannel.expired({}), false)
  assert.equal(lobsteraiChannel.expired({ expires_at: String(Date.now() + 3600_000) }), false)
  assert.equal(lobsteraiChannel.expired({ expires_at: String(Date.now() + 60_000) }), true, '10 分钟内算临期')
  assert.equal(lobsteraiChannel.expired({ expires_at: String(Date.now() - 1000) }), true)
})
