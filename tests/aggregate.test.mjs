// 多供应商层的行为契约。
//
// 只测「错了会静默出错」的地方：供应商 id 映射、模型分派、未登录回落、登录入口。
// 不测「能 import」这类没有诊断价值的断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUB_PLUGINS, REGISTERED_CHANNELS, PROVIDER_IDS } from '../index.mjs'
import { tierSummarize, providerIdOf, providerNameOf } from '../src/aggregate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 建一个供应商实例（默认 officeace）。 */
const build = async (options = {}, exportName = 'HubOfficeAcePlugin') => {
  const plugin = await HUB_PLUGINS[exportName]({}, options)
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, cfg, provider: cfg.provider[plugin.provider.id] }
}

test('一个插件，十个供应商：每个实例只注册自己那一条', async () => {
  assert.equal(PROVIDER_IDS.length, REGISTERED_CHANNELS.length, '每个渠道一个供应商')
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length, '供应商 id 必须唯一')
  for (const id of PROVIDER_IDS) assert.match(id, /^hub-[a-z0-9-]+$/, `供应商 id 必须是 ASCII：${id}`)
  for (const [exportName, makePlugin] of Object.entries(HUB_PLUGINS)) {
    const plugin = await makePlugin({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const keys = Object.keys(cfg.provider)
    assert.equal(keys.length, 1, `${exportName} 只能注册一个供应商，实际：${keys.join(',')}`)
    assert.ok(PROVIDER_IDS.includes(keys[0]), `${exportName} 注册的 id 不在名单里：${keys[0]}`)
    assert.equal(plugin.provider.id, keys[0], `${exportName} 的 provider.id 与 config 键不一致`)
    assert.equal(plugin.auth.provider, keys[0], `${exportName} 的 auth.provider 与 provider.id 不一致`)
  }
})

test('每个供应商一个登录入口（不是每渠道一个供应商时代的十个）', async () => {
  for (const [exportName, makePlugin] of Object.entries(HUB_PLUGINS)) {
    const plugin = await makePlugin({}, {})
    assert.equal(plugin.auth.methods.length, 1, `${exportName} 应只有一个登录入口`)
    assert.match(plugin.auth.methods[0].label, /^登录 .+$/)
  }
})

test('目录里的模型 id 不再带渠道前缀（一个供应商只有一个渠道）', async () => {
  for (const [exportName, makePlugin] of Object.entries(HUB_PLUGINS)) {
    const plugin = await makePlugin({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const models = await plugin.provider.models(cfg.provider[plugin.provider.id])
    const ids = Object.keys(models)
    // 未登录且渠道没有兜底目录时可以是空的（登录后由 catalog 填充）——
    // 但只要非空，key 就是裸模型名。
    for (const id of ids) {
      assert.doesNotMatch(id, /\//, `${exportName} 的模型 id 不该带前缀：${id}`)
    }
  }
})

test('未登录也不返回空目录（回落兜底，选择器不会空掉）', async () => {
  const { plugin, provider } = await build()
  const models = await plugin.provider.models(provider)
  assert.ok(Object.keys(models).length > 0, '未登录时目录不应为空')
})

test('别的供应商的模型打到本供应商 → 404（不静默转发到本渠道）', async () => {
  const { plugin } = await build()
  const { fetch: pluginFetch } = await plugin.auth.loader()
  for (const model of ['hub-autoclaw/glm-5.3', '不存在的渠道/模型']) {
    const response = await pluginFetch('http://127.0.0.1/x', {
      method: 'POST',
      body: JSON.stringify({ model }),
    })
    assert.equal(response.status, 404, `${model} 应 404`)
  }
})

test('三种模型写法都认得：裸名 / hub-<渠道>/名 / 旧 officeace/名', async () => {
  const { plugin } = await build()
  const { officeaceChannel } = await import('../src/officeace.mjs')
  const seen = []
  const original = officeaceChannel.chat
  officeaceChannel.chat = async (credential, { body }) => {
    seen.push(body.model)
    return Response.json({ ok: true })
  }
  const originalEnsure = officeaceChannel.expired
  officeaceChannel.expired = () => false
  try {
    const { fetch: pluginFetch } = await plugin.auth.loader(async () => ({
      type: 'success', channel: officeaceChannel.id, access: 'a',
    }))
    for (const model of ['glm-5.3', 'hub-officeace/glm-5.3', 'officeace/glm-5.3']) {
      const res = await pluginFetch('http://127.0.0.1/x', {
        method: 'POST',
        body: JSON.stringify({ model }),
      })
      assert.equal(res.status, 200, `${model} 应被接受`)
    }
  } finally {
    officeaceChannel.chat = original
    officeaceChannel.expired = originalEnsure
  }
  // 发给上游的 model 必须是裸名
  assert.deepEqual(seen, ['glm-5.3', 'glm-5.3', 'glm-5.3'])
})

test('astudio 明确声明不支持自动续期（不假装能刷新）', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  await assert.rejects(
    () => astudioChannel.refresh({ accessToken: 'x' }),
    /不支持自动续期|重新登录/,
  )
})

test('页面只读快照，不调 magpie.read（magpie 的 read 只服务两个内建项，自造名被拒）', () => {
  const app = readFileSync(join(ROOT, 'page/app.js'), 'utf8')
  assert.doesNotMatch(app, /magpie\.read\s*\(/, '页面不得调用 magpie.read（服务端只认 usage:summary / providers:list）')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.magpie.reads, undefined, '不应声明自造 read 名（会被服务端拒绝）')
  // 页面不提供假登录按钮：登录入口是供应商编辑器的 auth.methods（magpie 原生）
  assert.doesNotMatch(app, /magpie\.read\("login"/)
})

test('账号槽的 type=' + "'success'" + ' 也要认，且只出本渠道的桶', async () => {
  // 真机 bug：登录回调写 type:'success'，而 authOfChannel 只判 'oauth'
  // → 永不匹配 → 每个账号槽掉进旁路兜底 → 每张卡额度都一样。
  const { plugin } = await build({ notify: false })
  const { officeaceChannel } = await import('../src/officeace.mjs')
  const originalLogin = officeaceChannel.beginLogin
  const originalUsage = officeaceChannel.usage
  const originalExpired = officeaceChannel.expired
  officeaceChannel.beginLogin = async () => ({
    url: 'https://auth.example',
    result: Promise.resolve({ access: 'a', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
  })
  officeaceChannel.usage = async () => [{ name: 'officeace-only', used: 0, amount: 42 }]
  officeaceChannel.expired = () => false
  try {
    const handle = await plugin.auth.methods[0].authorize()
    const auth = await handle.callback()
    assert.equal(auth.type, 'success')
    assert.equal(auth.channel, officeaceChannel.id)
    const usage = await plugin.auth.usage(async () => auth)
    assert.equal(usage.windows.length, 1)
    assert.equal(usage.windows[0].name, 'officeace-only', '桶名不该再带渠道前缀')
    assert.equal(usage.windows[0].amount, 42)
  } finally {
    officeaceChannel.beginLogin = originalLogin
    officeaceChannel.usage = originalUsage
    officeaceChannel.expired = originalExpired
  }
})

test('供应商 id / 显示名映射：hub- 前缀 + 中文名', () => {
  const byId = Object.fromEntries(REGISTERED_CHANNELS.map((c) => [providerIdOf(c), providerNameOf(c)]))
  assert.equal(byId['hub-officeace'], '华为云 OfficeAce')
  assert.equal(byId['hub-astudio'], 'AStudio（讯飞）')
  assert.ok(Object.values(byId).every((name) => typeof name === 'string' && name.length > 0))
})

// ── 三档汇总（指针方案 A）───────────────────────────────────────────────

test('tierSummarize：≤3 桶原样返回；>3 桶汇总成 临期(指针)/长期/永久', () => {
  // 小组数渠道（officeace 3 桶）保留原始命名 —— 信息更足
  const small = [
    { name: '个人体验版', used: 0, amount: 500 },
    { name: '新用户福利', used: 0, amount: 3994, resetsAt: '2026-11-12T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 100, resetsAt: '2026-10-26T15:59:59Z' },
  ]
  // ≤3 桶保留原命名，但到期字段剥掉（浅灰行去重 —— 渠道行带 runsOutAt 只是分类输入）
  const smallOut = tierSummarize(small)
  assert.equal(smallOut.length, 3)
  assert.ok(smallOut.every((w) => w.runsOutAt === undefined && w.resetsAt === undefined), '≤3 桶到期字段剥掉')
  assert.equal(smallOut[1].amount, 3994, '其余字段原样保留')

  // AutoClaw 形态：8 桶（7 笔不同到期批次 + 1 永久）→ 3 桶
  const many = [
    { name: '登录奖励', used: 0, amount: 500, resetsAt: '2026-10-26T14:47:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-26T14:58:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-29T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-30T00:00:00Z' },
    { name: '登录奖励', used: 0, amount: 500, resetsAt: '2026-10-30T12:53:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-31T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-11-01T00:00:00Z' },
    { name: '永久奖励', used: 0, amount: 10550 },
  ]
  const out = tierSummarize(many)
  assert.equal(out.length, 3, '8 桶 → 3 桶')
  const pointer = out.find((w) => w.name.startsWith('临期'))
  // 指针桶 = 最早到期的那一批，amount 只算它自己（数字必须如实）
  assert.equal(pointer.amount, 500)
  assert.equal(pointer.runsOutAt, undefined, '三档桶不挂 runsOutAt（display 已带倒计时，再挂会出第三行浅灰重复）')
  const longTerm = out.find((w) => w.name.includes('长期'))
  assert.equal(longTerm.amount, 200 + 200 + 200 + 500 + 200 + 200, '其余 6 批合计')
  assert.equal(longTerm.runsOutAt, undefined, '长期桶同样不挂 runsOutAt（浅灰行去重）')
  const permanent = out.find((w) => w.name.includes('永久'))
  assert.equal(permanent.amount, 10550)
  assert.equal(permanent.resetsAt, undefined)
  // 桶序：临期在前（红桶即现在烧的）
  assert.ok(out[0].name.startsWith('临期'))
})

test('tierSummarize：状态条/失败条透传、不可求和的桶不动', () => {
  const rows = [
    { name: 'a', used: 0, amount: 1, resetsAt: '2026-10-27T00:00:00Z' },
    { name: 'b', used: 0, amount: 2, resetsAt: '2026-10-28T00:00:00Z' },
    { name: 'c', used: 0, amount: 3, resetsAt: '2026-10-29T00:00:00Z' },
    { name: 'd', used: 0, amount: 4, resetsAt: '2026-10-30T00:00:00Z' },
    { name: '状态条', used: 0, display: '已登录' },               // 无 amount → 透传
    { name: '失败条', used: 0, display: '额度查询失败：xx' },      // 无 amount → 透传
  ]
  const out = tierSummarize(rows)
  assert.ok(out.some((w) => w.name === '状态条'), '状态条透传')
  assert.ok(out.some((w) => w.display === '额度查询失败：xx'), '失败条透传')
  assert.equal(out.filter((w) => w.name.startsWith('临期')).length, 1)
  // 只有一条永久时保留原名（信息更足）
  const single = tierSummarize([
    { name: '星火积分', used: 0, amount: 60000 },
    { name: 'a', used: 0, amount: 1, resetsAt: '2026-10-27T00:00:00Z' },
    { name: 'b', used: 0, amount: 2, resetsAt: '2026-10-28T00:00:00Z' },
    { name: 'c', used: 0, amount: 3, resetsAt: '2026-10-29T00:00:00Z' },
  ])
  assert.ok(single.some((w) => w.name === '星火积分'), '单条永久保留原命名')
})
