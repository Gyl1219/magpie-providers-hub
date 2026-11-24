// 签到接线门禁（issue #19 的真正缺口：缺的不是签到步骤，是把签到接给聚合层）。
//
// 真机实证：aggregate 的 `sweepCheckins()`（src/aggregate.mjs:843）与渠道对象的
// `auth.checkin()`（src/aggregate.mjs:1381）都只看 `channel.checkin` 是不是函数。
// 把签到实现成顶层函数却不挂到渠道对象上，这条渠道就永远被判成「无每日签到」，
// 什么都不发生、也不报错 —— 这正是 #19「额度恒为 0 且没有任何提示」的形状。
//
// ⚠️ 别用正则扫源码判断「挂没挂」：`loomy.mjs:1049` 是简写 `checkin,`，
//    `astudio.mjs` 是 `async checkin(credential) {}` 方法语法，
//    `qwenwork-intl.mjs:1090` 是 `checkin: () => ({ outcome: 'inactive' })`。
//    文本匹配要么漏（astudio 就漏过），要么假阳性。这里直接 import 看运行时 typeof。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const index = await import(new URL('../index.mjs', import.meta.url))

/** 有真实签到端点的渠道（额度靠签到发放）。README「需要开自动签到」清单依赖这张表。 */
const CHANNELS_WITH_CHECKIN = [
  'astudio', 'lobsterai', 'loomy', 'monkeycode', 'monkeycode-intl',
  'baizhi', 'magicrew', 'magicrew-intl',
]

/** 没有签到端点、用 inactive 桩显式表态的**已注册**渠道。 */
const CHANNELS_INACTIVE = ['qiniu', 'marvis', 'autoclaw', 'autoclaw-cn']

/**
 * 尚未接回注册点、但有 inactive 桩的渠道（源码里验证，不走 REGISTERED_CHANNELS）。
 * 接回注册那天这两条会挪进上面的清单 —— 本清单因此只增不减是失败信号。
 */
const INACTIVE_NOT_YET_REGISTERED = ['qwenwork-intl']

/**
 * 没有 checkin 键、且这是**设计**（不是漏挂）的渠道，附理由。
 * 缺键与 inactive 桩在聚合层都写「无每日签到」，区别只在意图：
 * 这一份清单让「漏挂」与「本来没有」可区分 —— 而不报备的缺键一律判红。
 */
const NO_CHECKIN_BY_DESIGN = {
  accio: '每日 200 积分由登录触发，没有签到端点（tests/checkin.test.mjs:59 锁着这条）',
}

// REGISTERED_CHANNELS 是渠道对象数组（不是 id 字符串数组）。
const registry = new Map()
for (const channel of index.REGISTERED_CHANNELS ?? []) {
  if (channel !== null && typeof channel === 'object' && typeof channel.id === 'string') {
    registry.set(channel.id, channel)
  }
}
/** 渠道 id → 渠道对象。找不到直接抛，不要静默跳过（静默跳过正是 #19 的成因）。 */
function channelOf(id) {
  const hit = registry.get(id)
  if (hit === undefined) throw new Error(`拿不到渠道对象：${id}`)
  return hit
}

test('有签到端点的渠道，运行时 checkin 必须是函数', () => {
  const missing = []
  for (const id of CHANNELS_WITH_CHECKIN) {
    if (!registry.has(id)) { missing.push(`${id}（未注册）`); continue }
    if (typeof channelOf(id).checkin !== 'function') missing.push(id)
  }
  assert.deepEqual(
    missing,
    [],
    `这些渠道有签到端点却没把 checkin 挂到渠道对象上：${missing.join(', ')}`
      + ' —— aggregate 只会看到 undefined，永远不调签到，且不报错',
  )
})

test('无签到端点的渠道用 inactive 桩显式表态', () => {
  for (const id of CHANNELS_INACTIVE) {
    assert.ok(registry.has(id), `${id} 应在 REGISTERED_CHANNELS 里`)
    const channel = channelOf(id)
    assert.equal(typeof channel.checkin, 'function', `${id} 应有 checkin 桩`)
    assert.equal(channel.checkin()?.outcome, 'inactive', `${id} 的桩必须返回 inactive`)
  }
})

test('未接回注册点的渠道也保留 inactive 桩（接回时不必再补）', async () => {
  for (const id of INACTIVE_NOT_YET_REGISTERED) {
    assert.equal(registry.has(id), false, `${id} 已注册 —— 请挪进 CHANNELS_INACTIVE 清单`)
    const file = await readFile(new URL(`../src/${id}.mjs`, import.meta.url), 'utf8')
    assert.match(
      file,
      /checkin:\s*\(\)\s*=>\s*\(\{\s*outcome:\s*'inactive'\s*\}\)/,
      `${id} 的渠道对象应保留 inactive 桩`,
    )
  }
})

test('缺 checkin 键的渠道必须逐个报备，报备清单与实际缺键集合完全相等', () => {
  // ⚠️ 不真调真实 checkin()：它会读凭据、发网络请求，在无凭据的测试环境里
  //    抛 unhandledRejection 把整个文件判红。这里只锁接线，不锁行为。
  const lacking = [...registry.keys()]
    .filter((id) => typeof channelOf(id).checkin !== 'function')
    .sort()
  assert.deepEqual(
    lacking,
    Object.keys(NO_CHECKIN_BY_DESIGN).sort(),
    '缺 checkin 键的渠道变了：新缺的说明漏挂了；已报备的补上了就从清单里删掉',
  )
})

test('checkin 只报本渠道，不聚合其余渠道的明细', async () => {
  const source = await readFile(new URL('../src/aggregate.mjs', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('async checkin(getAuth)'))
  assert.ok(fn.length > 0, 'aggregate 渠道对象必须有 checkin')
  assert.ok(/const own = tally\.get\(channel\.id\)/.test(fn), 'checkin 结果必须取自本渠道的 tally')
})

test('签到结局写进页面快照，供面板显示真实原因（#19「没有任何提示」）', async () => {
  const source = await readFile(new URL('../src/aggregate.mjs', import.meta.url), 'utf8')
  assert.ok(/snapshotCache\.checkin\.set\(channel\.id, row\)/.test(source), 'sweep 结果必须进快照')
  assert.ok(/snapshotCache\.checkin\.set\(channel\.id, own\)/.test(source), '按账号签到结果也必须进快照')
  const snap = source.slice(source.indexOf('const ck = snapshotCache.checkin.get(channel.id)'))
  assert.ok(/outcome: ck\.outcome/.test(snap), '快照需带 outcome')
  assert.ok(/credit: ck\.credit/.test(snap), '快照需带 credit')
  assert.ok(/message: ck\.message/.test(snap), '快照需带 message —— 这是 #19「没有任何提示」的直接来源')
})

test('旁路-only 渠道由 sweepCheckins 补签，有账号槽的不重复签', async () => {
  const source = await readFile(new URL('../src/aggregate.mjs', import.meta.url), 'utf8')
  const idx = source.indexOf('async function sweepCheckins()')
  assert.ok(idx > 0, '必须存在 sweepCheckins')
  const body = source.slice(idx, idx + 1400)
  assert.ok(/hasAccountSlot\(channel\)\) continue/.test(body), '有账号槽的渠道应跳过')
  assert.ok(/typeof channel\.checkin !== 'function'\) continue/.test(body), '无签到端点的渠道应跳过')
  assert.ok(/signedIn\(channel\)\) continue/.test(body), '未登录的渠道应跳过')
  assert.ok(/cached\.outcome !== 'failed'\) continue/.test(body), '已成功过的当天不重复签到；failed 才重试')
})