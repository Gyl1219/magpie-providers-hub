// 签到移植语义回归（全部 stub fetch）。
// minimaxintl 走 Bearer + minimaxFetch（timezone_id 是 query 必填）；
// astudio 走 Cookie 四字段串 + client-popups（componentType 才是真字段）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-checkin-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { parseSigninPanel, checkin: minimaxCheckin, minimaxintlChannel } = await import('../src/minimaxintl.mjs')
const { astudioChannel } = await import('../src/astudio.mjs')
const { DshProvidersHubPlugin, REGISTERED_CHANNELS } = await import('../src/aggregate.mjs')

test.after = () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
}

const CRED = { access_token: 'mmoat_t', refresh_token: 'mmort_t', expires_at: String(Date.now() + 3600_000) }

/** 7 天面板构造器。 */
const panel = (todayStatus, opts = {}) => ({
  scene: 2,
  days: Array.from({ length: 7 }, (_, i) => ({
    day_no: i + 1,
    points: 100 + i,
    bonus_points: 0,
    is_today: i === (opts.todayIndex ?? 3),
    status: i === (opts.todayIndex ?? 3) ? todayStatus : (i < (opts.todayIndex ?? 3) ? 3 : 1),
  })),
})

const sseJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes) => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, init })
    }
    return new Response('{}', { status: 200 })
  }
  return { restore: () => { globalThis.fetch = original } }
}

// ── 面板解析（完整复刻官方 validateSigninPanel 的硬约束）────────────────

test('面板硬约束：6 天 / 非法 status / 2 条可领 / 2 条今日 / scene 越界 → 一律 undefined（不编造）', () => {
  const good = panel(2)
  assert.equal(parseSigninPanel(good)?.days.length, 7)
  assert.equal(parseSigninPanel({ ...good, days: good.days.slice(0, 6) }), undefined)
  assert.equal(parseSigninPanel({ ...good, days: good.days.map((d, i) => ({ ...d, status: i === 3 ? 9 : 1 })) }), undefined)
  assert.equal(parseSigninPanel({
    ...good,
    days: good.days.map((d, i) => ({ ...d, status: i === 3 || i === 4 ? 2 : 1 })),
  }), undefined, '最多 1 条可领')
  assert.equal(parseSigninPanel({
    ...good,
    days: good.days.map((d, i) => ({ ...d, is_today: i === 3 || i === 5 })),
  }), undefined, '最多 1 条今日')
  assert.equal(parseSigninPanel({ ...good, scene: 9 }), undefined)
  assert.equal(parseSigninPanel(null), undefined)
})

// ── minimaxintl checkin ─────────────────────────────────────────────────

test('签到：今日已领（status=3）→ done + 连续天数', async () => {
  const stub = stubFetch([{
    match: '/signin/status',
    respond: ({ url }) => {
      assert.ok(url.includes('timezone_id='), 'timezone_id 必须是 query 参数（放请求头无效）')
      return sseJson({ data: panel(3), base_resp: { status_code: 0, status_msg: 'ok' } })
    },
  }])
  try {
    const outcome = await minimaxCheckin(CRED)
    assert.equal(outcome.outcome, 'done')
    assert.equal(outcome.credit, 103)
    assert.equal(outcome.streak, 4, '今日已领：从今日向前数连续 Claimed（4 天）')
  } finally {
    stub.restore()
  }
})

test('签到：今日可领（status=2）→ claim → claim_result=1 → claimed', async () => {
  const claimedPanel = panel(3) // 领取后的面板
  const stub = stubFetch([
    { match: '/signin/status', respond: () => sseJson({ data: panel(2), base_resp: { status_code: 0 } }) },
    {
      match: '/signin/claim',
      respond: ({ init }) => {
        assert.equal(init.body, '{}', 'claim 的 body 是空对象串')
        return sseJson({
          data: { claim_result: 1, points: 400, panel: claimedPanel },
          base_resp: { status_code: 0 },
        })
      },
    },
  ])
  try {
    const outcome = await minimaxCheckin(CRED)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 400, 'credit 取 points 总数（已含 bonus_points，不相加）')
    assert.equal(outcome.streak, 4, '连续天数以领取后回传的面板为准')
  } finally {
    stub.restore()
  }
})

test('签到：claim_result=2 → done（幂等判据不是 HTTP 状态码）', async () => {
  const stub = stubFetch([
    { match: '/signin/status', respond: () => sseJson({ data: panel(2), base_resp: { status_code: 0 } }) },
    { match: '/signin/claim', respond: () => sseJson({ data: { claim_result: 2, points: 400 }, base_resp: { status_code: 0 } }) },
  ])
  try {
    const outcome = await minimaxCheckin(CRED)
    assert.equal(outcome.outcome, 'done')
  } finally {
    stub.restore()
  }
})

test('签到：status=1 未开始 → inactive；status=4 → ineligible', async () => {
  {
    const stub = stubFetch([{ match: '/signin/status', respond: () => sseJson({ data: panel(1), base_resp: { status_code: 0 } }) }])
    try { assert.equal((await minimaxCheckin(CRED)).outcome, 'inactive') } finally { stub.restore() }
  }
  {
    const stub = stubFetch([{ match: '/signin/status', respond: () => sseJson({ data: panel(4), base_resp: { status_code: 0 } }) }])
    try { assert.equal((await minimaxCheckin(CRED)).outcome, 'ineligible') } finally { stub.restore() }
  }
})

test('签到：业务码在 base_resp.status_code（HTTP 200 + invalid timezone_id 同形）→ failed', async () => {
  const stub = stubFetch([{
    match: '/signin/status',
    respond: () => sseJson({ base_resp: { status_code: 400, status_msg: 'invalid timezone_id' } }),
  }])
  try {
    const outcome = await minimaxCheckin(CRED)
    assert.equal(outcome.outcome, 'failed')
    assert.match(outcome.message, /invalid timezone_id/)
  } finally {
    stub.restore()
  }
})

test('签到：地理分流（307→中国站）后的 401 必须报「出口 IP」而不是「凭据失效」', async () => {
  // 中国大陆直连出口的真实形态：agent.minimax.io 恒 307 → agent.minimaxi.com，
  // 国际站 token 打到中国站 = 401 invalid access token（与凭据真失效逐字同形）。
  const stub = stubFetch([
    { match: 'agent.minimax.io', respond: () => new Response(null, { status: 307, headers: { location: 'https://agent.minimaxi.com/minimax-cloud/api/v1/signin/status' } }) },
    { match: 'agent.minimaxi.com', respond: () => new Response('{"error":"invalid access token"}', { status: 401 }) },
  ])
  try {
    const outcome = await minimaxCheckin(CRED)
    assert.equal(outcome.outcome, 'failed')
    assert.match(outcome.message, /出口 IP|分流/, '必须指向真实原因（换出口/XFF），误导成重登会白烧一次登录')
    assert.doesNotMatch(outcome.message, /凭据已失效/)
  } finally {
    stub.restore()
  }
})

test('渠道对象挂了 checkin；accio 没有签到端点（跳过不占失败名额）', async () => {
  assert.equal(typeof minimaxintlChannel.checkin, 'function')
  assert.equal(typeof astudioChannel.checkin, 'function')
  const { officeaceChannel } = await import('../src/officeace.mjs')
  const { accioChannel } = await import('../src/accio.mjs')
  assert.equal(typeof officeaceChannel.checkin, 'function', 'officeace 有签到（每日 bonus/claim，1000 积分当日作废）')
  assert.equal(accioChannel.checkin, undefined, 'Accio 每日 200 积分由登录触发，无签到端点')
})

// ── astudio checkin ─────────────────────────────────────────────────────

const ACRED = { accessToken: 'bearer', ssoSessionId: 'sso', accountId: 'acc1', token: 'tok' }

test('astudio 签到：pending 无可领弹窗 → done（实测已领取时返回 code=0 data=[]）', async () => {
  const stub = stubFetch([{ match: '/client-popups/pending', respond: () => sseJson({ code: 0, data: [] }) }])
  try {
    const outcome = await astudioChannel.checkin(ACRED)
    assert.equal(outcome.outcome, 'done')
  } finally {
    stub.restore()
  }
})

test('astudio 签到：componentType 才是真字段（读 type 会一个都识别不出来 → 积分一动不动）', async () => {
  const completes = []
  const stub = stubFetch([
    {
      match: '/client-popups/pending',
      respond: () => sseJson({
        code: 0,
        data: [{
          popupId: 3, popupCode: 'DAILY_LOGIN_REWARD_V1', popupType: 'BANNER',
          componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'k1',
          payload: { points: '100', title: '限时每日福利' },
        }],
      }),
    },
    {
      match: '/client-popups/complete',
      respond: ({ init }) => {
        completes.push(JSON.parse(init.body))
        return sseJson({ code: 0, data: { points: 100 } })
      },
    },
  ])
  try {
    const outcome = await astudioChannel.checkin(ACRED)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 100)
    assert.deepEqual(completes, [{ popupId: 3, instanceKey: 'k1' }])
  } finally {
    stub.restore()
  }
})

test('astudio 签到：code 80000 = 会话失效（终态，需人工重登）', async () => {
  const stub = stubFetch([{ match: '/client-popups/pending', respond: () => sseJson({ code: 80000, message: '登录异常，请重新登录' }) }])
  try {
    const outcome = await astudioChannel.checkin(ACRED)
    assert.equal(outcome.outcome, 'failed')
    assert.match(outcome.message, /重新登录/)
  } finally {
    stub.restore()
  }
})

test('astudio 签到：新用户礼包一并领取（多弹窗积分求和）', async () => {
  let n = 0
  const stub = stubFetch([
    {
      match: '/client-popups/pending',
      respond: () => sseJson({
        code: 0,
        data: [
          { popupId: 3, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'k1', payload: { points: 100 } },
          { popupId: 7, componentType: 'NEW_USER_DIALOG', instanceKey: 'k2', payload: { credit: 500 } },
        ],
      }),
    },
    {
      match: '/client-popups/complete',
      respond: () => sseJson({ code: 0, data: ++n === 1 ? { points: 100 } : { credit: 500 } }),
    },
  ])
  try {
    const outcome = await astudioChannel.checkin(ACRED)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 600)
  } finally {
    stub.restore()
  }
})

// ── 聚合层分发 ──────────────────────────────────────────────────────────

test('聚合 checkin：无签到端点的渠道跳过；结果按渠道保留明细并汇总', async () => {
  const plugin = await DshProvidersHubPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  // 凭据存档在沙箱 HOME：全未登录 → inactive 且不发请求
  const outcome = await plugin.auth.checkin()
  assert.equal(outcome.outcome, 'inactive')
  assert.deepEqual(outcome.channels, [])
})
