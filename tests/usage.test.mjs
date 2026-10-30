// 额度分桶 → magpie usage windows 的移植语义回归（全部 stub fetch）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-usage-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { accioChannel } = await import('../src/accio.mjs')
const { astudioChannel } = await import('../src/astudio.mjs')

test.after = () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
}

const AC_CRED = { access_token: 'at_accio', refresh_token: 'rt2', expires_at: Date.now() + 3600_000, region: 'cn' }

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push(url)
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, init })
    }
    return json({})
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── accio 分桶 ──────────────────────────────────────────────────────────

test('accio：三类桶固定顺序（不按响应键序，面板不跳行）、0 桶保留、缺席桶不产出', async () => {
  const stub = stubFetch([
    {
      match: '/api/entitlement/currentSubscription',
      respond: ({ url }) => {
        assert.ok(url.includes('accessToken='), 'token 必须在 query（缺它 400）')
        return json({
          success: true,
          data: {
            remaining: 350,
            // 键序故意打乱：服务端键序不可靠
            entitlement: {
              referral: { remaining: 100, used: 0, total: 100 },
              monthly: { remaining: 0, used: 200, total: 200 },
              daily: { remaining: 250, used: 50, total: 300 },
            },
          },
        })
      },
    },
    { match: '/api/entitlement/quota', respond: () => json({ success: true, data: { refreshCountdownSeconds: 86400 } }) },
  ])
  try {
    const windows = await accioChannel.usage(AC_CRED)
    assert.deepEqual(windows.map((w) => w.name), ['Accio · 每日积分', 'Accio · 每月积分', 'Accio · 推荐积分'])
    assert.equal(windows[0].used, 17, 'daily：used 50/300 → 17%')
    assert.equal(windows[1].used, 100, 'monthly：剩 0 → 100%（桶保留，用户要看到「还有 0」）')
    assert.equal(windows[1].display, '剩余 0')
    assert.ok(windows[0].resetsAt, '只有 daily 有刷新时刻（quota 倒计时现算）')
    assert.equal(windows[2].resetsAt, undefined, '其余桶不知道就不写 —— 写了是编造')
  } finally {
    stub.restore()
  }
})

test('accio：缺席的桶不产出（不把「没有桶」说成「桶是空的」）', async () => {
  const stub = stubFetch([
    { match: '/currentSubscription', respond: () => json({ success: true, data: { remaining: 5, entitlement: { daily: { remaining: 5, used: 0, total: 5 } } } }) },
    { match: '/quota', respond: () => json({ success: true, data: {} }) },
  ])
  try {
    const windows = await accioChannel.usage(AC_CRED)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].name, 'Accio · 每日积分')
  } finally {
    stub.restore()
  }
})

test('accio：未登录是 HTTP 200 + code 401/NOT_LOGIN（只看 HTTP 码会漏判）', async () => {
  const stub = stubFetch([
    { match: '/currentSubscription', respond: () => json({ success: false, code: '401', message: 'NOT_LOGIN' }) },
  ])
  try {
    await assert.rejects(
      () => accioChannel.usage(AC_CRED),
      (error) => /NOT_LOGIN/.test(error.message) && error.signedOut === true,
    )
  } finally {
    stub.restore()
  }
})

test('accio：quota 端点失败可容忍（只丢刷新时刻，不丢桶）', async () => {
  const stub = stubFetch([
    { match: '/currentSubscription', respond: () => json({ success: true, data: { entitlement: { daily: { remaining: 9, used: 1, total: 10 } } } }) },
    { match: '/quota', respond: () => new Response('boom', { status: 500 }) },
  ])
  try {
    const windows = await accioChannel.usage(AC_CRED)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].resetsAt, undefined)
  } finally {
    stub.restore()
  }
})

// ── astudio 分桶（托盘面板适配：resetsAt + aside）────────────────────────

const AS_CRED = { accessToken: 'b', ssoSessionId: 's', accountId: 'a', token: 't' }

test('astudio：滚动指针分档 —— 临期指向最早到期的未耗尽桶，剩0桶已耗尽+aside', async () => {
  const stub = stubFetch([
    {
      match: '/points/balance',
      respond: () => json({
        code: 0,
        data: {
          totalBalance: 7000, totalAmount: 7000,
          memberBalance: 0, memberTotal: 100,
          buyBalance: 0, buyTotal: 50,
          activityBalance: 7000, activityTotal: 7000, activityNextExpireTime: '2026-11-01T04:45:48',
          sparkTotalBalance: 60000, sparkTotalAmount: 60000, sparkNextExpireTime: '',
        },
      }),
    },
  ])
  try {
    const windows = await astudioChannel.usage(AS_CRED)
    const member = windows.find((w) => w.name.includes('会员积分'))
    assert.match(member.name, /已耗尽/, '剩 0 的桶标已耗尽（不占临期指针位）')
    assert.equal(member.aside, true)
    const activity = windows.find((w) => w.name.includes('赠送积分'))
    assert.match(activity.name, /临期·\d+天/, '唯一有到期且有值的桶 = 指针位')
    assert.equal(activity.used, 0)
    assert.equal(activity.runsOutAt, undefined, '浅灰行撤掉（亮色层 band 名 + display 日期已带时间）')
    assert.equal(activity.display, '剩余 7000 · 11-01 到期')
    const spark = windows.find((w) => w.name.includes('星火积分'))
    assert.match(spark.name, /永久/, '无到期 = 永久')
  } finally {
    stub.restore()
  }
})

test('assignExpiryBands：指针随最早桶耗尽/过期而滚动（12天桶接管显示）', async () => {
  const { assignExpiryBands } = await import('../src/shared.mjs')
  const now = Date.now()
  // 3 天桶还在时：它是指针，12 天桶是长期
  const round1 = [
    { remaining: 100, expireMs: now + 3 * 86400_000 },
    { remaining: 200, expireMs: now + 12 * 86400_000 },
  ]
  assignExpiryBands(round1, now)
  assert.equal(round1[0].band, '临期·3天')
  assert.equal(round1[1].band, '长期')
  // 3 天桶耗尽：指针滚到 12 天桶（它变临期·12天，不再被瞒住）
  const round2 = [
    { remaining: 0, expireMs: now + 3 * 86400_000 },
    { remaining: 200, expireMs: now + 12 * 86400_000 },
  ]
  assignExpiryBands(round2, now)
  assert.equal(round2[0].band, '已耗尽')
  assert.equal(round2[1].band, '临期·12天')
  // 无到期桶 = 永久
  const round3 = [{ remaining: 60000 }]
  assignExpiryBands(round3, now)
  assert.equal(round3[0].band, '永久')
})

// ── 供应商层分发 ────────────────────────────────────────────────────────

test('未登录的供应商：usage 出「未登录」状态条（不报成查询失败）', async () => {
  const { HUB_PLUGINS } = await import('../index.mjs')
  const plugin = await HUB_PLUGINS.HubAStudioPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  const result = await plugin.auth.usage()
  assert.equal(result.plan, 'AStudio（讯飞）')
  assert.equal(result.windows.length, 1)
  assert.match(result.windows[0].display, /未登录/)
})
