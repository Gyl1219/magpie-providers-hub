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

// ⚠️ 门禁用例：上游行是 `{ modelId, modelName, … }`，不是 `{ id, name }`。
// 回归现场：只读 `id` → 每行都 `continue` → 目录为空 → 回落兜底表 6 条
// （用户报障「图1 只有几个旧模型，图2/图3 的模型都拿不到」）。
test('目录：认上游真实字段 modelId/modelName，且多行全部保留', async () => {
  const stub = stubFetch([{
    match: '/api/models/available',
    respond: ({ calls }) => {
      const h = calls.at(-1).headers
      assert.ok(h.Authorization?.startsWith('Bearer '), '目录要 Bearer')
      assert.ok(h['X-LobsterAI-Client-Capabilities'], '能力头照发（对齐客户端形态）')
      assert.ok(h['X-LobsterAI-Client-Version'], '缺失版本头')
      return json({
        code: 0,
        data: [
          {
            modelId: 'deepseek-flash',
            modelName: 'DeepSeek-V4.1-Flash',
            provider: 'deepseek',
            contextWindow: 1000000,
            costMultiplier: 0.05,
            supportsImage: true,
            supportsThinking: true,
            supportsToolCalling: null,
            accessible: true,
          },
          {
            modelId: 'glm-5.3',
            modelName: 'GLM-5.3',
            contextWindow: 1000000,
            supportsImage: false,
            supportsThinking: true,
            accessible: true,
          },
          // 大写主键必须原样保真：上游就是这个 modelId，改小写会 404
          {
            modelId: 'MiniMax-M3',
            modelName: 'MiniMax-M3',
            contextWindow: 1000000,
            supportsImage: true,
            accessible: true,
          },
        ],
      })
    },
  }])
  try {
    const models = await lobsteraiChannel.catalog(CRED)
    assert.deepEqual(
      Object.keys(models).sort(),
      ['MiniMax-M3', 'deepseek-flash', 'glm-5.3'],
      '三行都要进目录（旧实现读 id 会一条不剩，回落兜底表）',
    )
    assert.equal(models['deepseek-flash'].name, 'DeepSeek-V4.1-Flash', '名取 modelName，不是模型 id')
    assert.equal(models['MiniMax-M3'].name, 'MiniMax-M3')
    assert.equal(models['MiniMax-M3'].limit.context, 1_000_000)
    assert.equal(models['deepseek-flash'].capabilities.attachment, true, 'supportsImage → 图片能力')
    assert.equal(models['glm-5.3'].capabilities.attachment, false)
    assert.equal(models['deepseek-flash'].capabilities.reasoning, true, 'supportsThinking → 推理能力')
    assert.equal(models['deepseek-flash'].tool_call, true, 'supportsToolCalling:null 是未知，不是不支持')
  } finally {
    stub.restore()
  }
})

test('目录：accessible:false 跳过；旧 id/name 形态仍兼容', async () => {
  const stub = stubFetch([{
    match: '/api/models/available',
    respond: () => json({
      code: 0,
      data: [
        { modelId: 'locked', modelName: 'Locked', accessible: false, contextWindow: 1000000 },
        { id: 'legacy-id', name: 'Legacy Name', contextWindow: 262144, maxTokens: 4096 },
        { model: 'legacy-model', contextWindow: 131072 },
      ],
    }),
  }])
  try {
    const models = await lobsteraiChannel.catalog(CRED)
    assert.deepEqual(Object.keys(models).sort(), ['legacy-id', 'legacy-model'], '拿不到的条目别塞进目录')
    assert.equal(models['legacy-id'].name, 'Legacy Name')
    assert.equal(models['legacy-id'].limit.output, 4096)
    assert.equal(models['legacy-model'].name, 'legacy-model', '无名条目用 id 兜底')
  } finally {
    stub.restore()
  }
})

test('目录：离谱数值被拒（308 位数字串不得进 context）', async () => {
  const stub = stubFetch([{
    match: '/api/models/available',
    respond: () => json({
      code: 0,
      data: [{ modelId: 'weird', modelName: 'Weird', contextWindow: Number('9'.repeat(300)) || 1e308 }],
    }),
  }])
  try {
    const models = await lobsteraiChannel.catalog(CRED)
    assert.equal(models.weird.limit.context, 131_072, '异常值回落保守默认')
  } finally {
    stub.restore()
  }
})

// 兜底表是 catalog 抛错时 discoverModels 的唯一退路（aggregate.mjs:258），
// 它必须与远端同形：键 = modelId、名字 = modelName，条数不能比远端少一截。
test('兜底表与远端同形：19 条，键就是 modelId（含大写 MiniMax-M3）', () => {
  const models = lobsteraiChannel.fallbackModels
  assert.equal(Object.keys(models).length, 19, '远端整体失败时兜底表要够用，且与远端条数一致')
  assert.equal(models['deepseek-flash'].name, 'DeepSeek-V4.1-Flash')
  assert.ok(models['MiniMax-M3'], '大写主键原样保真')
  assert.ok(models['kimi-k3.1-pro'], 'Kimi K3.1 Pro 在表内')
  assert.equal(models['kimi-k2.8-preview'].limit.context, 262_144)
  assert.ok(!models['deepseek-v4'], '旧 id 已下线，别留在兜底表里')
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
    // 逐笔带 _qty（批大小，聚合层求和用）+ runsOutAt —— 聚合层据此折叠成 临期/长期/永久
    assert.equal(windows[0]._qty, 100, '批大小走 _qty')
    // ⚠️ amount 是 magpie 语义的「已用量」，不是批大小（两者语义相反，别混用）
    assert.equal(windows[0].limit, 100, '分母 = 同 label 的最大剩余量')
    assert.equal(windows[0].amount, 0, '这批一分未动 → 已用 0')
    // 无时区本地串按本地解析回同一瞬间（round-trip 语义）
    assert.equal(windows[0].runsOutAt, new Date(iso(future1)).toISOString())
    assert.match(windows[0].display, /后作废/, '倒计时进 display（指针桶收起后仍可见）')
    assert.equal(windows[1].runsOutAt, new Date(iso(future2)).toISOString())
    assert.equal(windows[2].runsOutAt, undefined, '无到期 = 永久')
  } finally {
    stub.restore()
  }
})

test('余额：同 label 的满额批当分母 → 已花的批次给出真实百分比', async () => {
  const future1 = Date.now() + 2 * 86400_000
  const future2 = Date.now() + 3 * 86400_000
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
        totalCreditsRemaining: 170.94,
        creditItems: [
          // 最早那批已经花了 29.06（原本 100，同 label 的另一批没动 → 分母可证）
          { label: '每日登录奖励', creditsRemaining: 70.94, expiresAt: iso(future1) },
          { label: '每日登录奖励', creditsRemaining: 100, expiresAt: iso(future2) },
        ],
      },
    }),
  }])
  try {
    const windows = await lobsteraiChannel.usage(CRED)
    assert.equal(windows[0].limit, 100, '分母 = 同 label 最大剩余量（100）')
    assert.equal(windows[0].amount, 29.06, '已用 = 100 - 70.94')
    assert.equal(windows[0].used, 29, 'used 是百分比（29.06/100 取整）')
    assert.equal(windows[0].unit, '积分')
    assert.equal(windows[1].amount, 0, '没动过的那批已用 0')
  } finally {
    stub.restore()
  }
})

test('余额：只有一批同 label 时不给分母（不拿剩余量冒充总量）', async () => {
  const future1 = Date.now() + 2 * 86400_000
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
        totalCreditsRemaining: 70.94,
        creditItems: [{ label: '每日登录奖励', creditsRemaining: 70.94, expiresAt: iso(future1) }],
      },
    }),
  }])
  try {
    const windows = await lobsteraiChannel.usage(CRED)
    assert.equal(windows[0].limit, undefined, '没有证据说明满额是多少 → 不给分母')
    assert.equal(windows[0].amount, undefined, '也就没有「已用」')
    assert.equal(windows[0]._qty, 70.94, '批大小照旧给聚合层')
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
