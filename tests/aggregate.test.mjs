// 聚合层的行为契约。
//
// 只测「错了会静默出错」的地方：模型前缀分派、未登录回落、单渠道失败隔离。
// 不测「能 import」这类没有诊断价值的断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshProvidersHubPlugin } from '../index.mjs'
import { tierSummarize } from '../src/aggregate.mjs'

const build = async (options = {}) => {
  const plugin = await DshProvidersHubPlugin({}, options)
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, provider: cfg.provider['providers-hub'] }
}

test('一个插件只注册一个供应商：providers-hub', async () => {
  const plugin = await DshProvidersHubPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider), ['providers-hub'])
})

test('目录里的模型 id 带渠道前缀（渠道/模型）', async () => {
  const { plugin, provider } = await build()
  const models = await plugin.provider.models(provider)
  const ids = Object.keys(models)
  assert.ok(ids.length > 0)
  for (const id of ids) assert.match(id, /^[a-z0-9-]+\/.+/, `模型 id 缺少渠道前缀：${id}`)
  // 至少含已注册的每个渠道
  const channels = new Set(ids.map((id) => id.split('/')[0]))
  assert.ok(channels.has('officeace'))
  assert.ok(channels.has('astudio'))
  assert.ok(channels.has('minimaxintl'))
  assert.ok(channels.has('accio'))
})

test('未登录也不返回空目录（回落兜底，选择器不会空掉）', async () => {
  const { plugin, provider } = await build()
  const models = await plugin.provider.models(provider)
  assert.ok(Object.keys(models).length > 0, '未登录时目录不应为空')
})

test('登录入口每渠道一个（不是每渠道一个供应商）', async () => {
  const { plugin } = await build()
  const labels = plugin.auth.methods.map((m) => m.label)
  assert.equal(labels.length, 6)
  assert.ok(labels.some((l) => l.includes('OfficeAce')))
  assert.ok(labels.some((l) => l.includes('AStudio')))
  assert.ok(labels.some((l) => l.includes('MiniMax')))
  assert.ok(labels.some((l) => l.includes('Accio')))
  assert.ok(labels.some((l) => l.includes('AutoClaw (智谱)')), '国内 AutoClaw 登录入口')
  assert.ok(labels.some((l) => l.includes('AutoClaw (国际版)')), '国际 AutoClaw 登录入口')
})

test('无法识别的 model 返回 404 而不是抛异常炸掉会话', async () => {
  const { plugin } = await build()
  const { fetch: pluginFetch } = await plugin.auth.loader()
  const response = await pluginFetch('http://127.0.0.1/x', {
    method: 'POST',
    body: JSON.stringify({ model: '不存在的渠道/模型' }),
  })
  assert.equal(response.status, 404)
})

test('astudio 明确声明不支持自动续期（不假装能刷新）', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  await assert.rejects(
    () => astudioChannel.refresh({ accessToken: 'x' }),
    /不支持自动续期|重新登录/,
  )
})

// ── 三档汇总（指针方案 A）───────────────────────────────────────────────

test('tierSummarize：≤3 桶原样返回；>3 桶汇总成 临期(指针)/长期/永久', () => {
  // 小组数渠道（officeace 3 桶）保留原始命名 —— 信息更足
  const small = [
    { name: '个人体验版', used: 0, amount: 500 },
    { name: '新用户福利', used: 0, amount: 3994, resetsAt: '2026-11-12T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 100, resetsAt: '2026-10-26T15:59:59Z' },
  ]
  assert.deepEqual(tierSummarize(small), small, '≤3 桶不动')

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
  assert.equal(pointer.resetsAt, '2026-10-26T14:47:00Z')
  const longTerm = out.find((w) => w.name.includes('长期'))
  assert.equal(longTerm.amount, 200 + 200 + 200 + 500 + 200 + 200, '其余 6 批合计')
  assert.equal(longTerm.resetsAt, '2026-10-26T14:58:00Z', '长期桶的 resetsAt = 其中最早（烧桶一死自动转正）')
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
