// 千问办公（国际版）注册态门禁 —— **无开关**：只断言「5 个注册点全在或全不在」。
//
// 背景：2026-11-22 按 B 案撤回了 hub-qwenwork-intl 的注册（真机 chat 未验证，
// AGENTS §5 不许对外暴露）。撤回靠手改 5 处，没人拦就容易在下次合并里被加回来。
//
// 为什么不用一个 `EXPECT_REGISTERED` 布尔：
//   · 布尔是这套门禁里**唯一需要人记得翻转**的东西，而「记得翻转」正是这类
//     门禁最容易失效的方式；
//   · 真正的不变量本来就是对称的 —— 5 个注册点**要么全在、要么全不在**，
//     半加（例如只在 lazyChannels 塞一行，PROVIDER_IDS / HUB_PLUGINS 都不变）
//     才是必须拦下的状态，而它与当前处于哪种模式无关。
//   所以这里从源码自算模式，再由它推运行时的期望：翻转零成本，抄错即报。
//
// 真机跑通、按 A 案接回注册时：把 5 处加回去即可，本文件**不用改**。
//
// 文件名原为 `qwenwork-intl-unregistered.test.mjs`（第一版只钉撤回态），内容早已与
// 模式无关，2026-11-22 提交前改成了现在的名字。本文件**不依赖自己的文件名**，
// scripts/qwenwork-registration-gate.mjs 两个名字都认，改不改名它都能跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const CHANNEL_ID = 'qwenwork-intl'
const PROVIDER_ID = `hub-${CHANNEL_ID}`
const CHANNEL_FILE = fileURLToPath(new URL('../src/qwenwork-intl.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX_FILE = join(ROOT, 'index.mjs')
const AGG_FILE = join(ROOT, 'src', 'aggregate.mjs')

/**
 * 源码注册点：读文件而不是 import —— 「写了字符串却没加载成功」也要看得见。
 * 这 5 处对应 README「加一个新渠道」三步（index 懒加载 / 插件导出 / HUB_PLUGINS，
 * aggregate 的 lazyChannels / CHANNELS），少任何一处渠道都不会完整生效。
 */
function textSites() {
  const index = readFileSync(INDEX_FILE, 'utf8')
  const agg = readFileSync(AGG_FILE, 'utf8')
  return [
    { name: `index.mjs 懒加载名单含 '${CHANNEL_ID}'`, present: index.includes(`'${CHANNEL_ID}'`) },
    { name: 'index.mjs 导出 HubQwenworkIntlPlugin', present: /export\s+const\s+HubQwenworkIntlPlugin\b/.test(index) },
    {
      name: 'index.mjs HUB_PLUGINS 展开 HubQwenworkIntlPlugin',
      present: index.includes('HubQwenworkIntlPlugin }') || index.includes('{ HubQwenworkIntlPlugin'),
    },
    { name: `src/aggregate.mjs lazyChannels 含 '${CHANNEL_ID}':`, present: agg.includes(`'${CHANNEL_ID}':`) },
    { name: `src/aggregate.mjs CHANNELS 含 lazyLoaded['${CHANNEL_ID}']`, present: agg.includes(`lazyLoaded['${CHANNEL_ID}']`) },
  ]
}

/** 运行时可见结果：magpie 实际拿到的供应商列表。 */
async function runtimeSites() {
  const entry = await import('../index.mjs')
  return [
    { name: 'PROVIDER_IDS 含 provider id', present: entry.PROVIDER_IDS.includes(PROVIDER_ID) },
    { name: 'REGISTERED_CHANNELS 含该渠道对象', present: entry.REGISTERED_CHANNELS.some((c) => c?.id === CHANNEL_ID) },
    { name: 'HUB_PLUGINS 含 HubQwenworkIntlPlugin', present: 'HubQwenworkIntlPlugin' in entry.HUB_PLUGINS },
    { name: 'index.mjs 导出 HubQwenworkIntlPlugin（函数）', present: typeof entry.HubQwenworkIntlPlugin === 'function' },
  ]
}

/** 由源码自算当前模式：true = 已注册（5 处全在），false = 撤回态（全不在）。 */
function registeredBySource() {
  const sites = textSites()
  const inSite = sites.filter((s) => s.present)
  if (inSite.length === sites.length) return true
  if (inSite.length === 0) {
    // 撤回态多严一层：整份文件连这个 id 的字样都不许有（注释是下一次手抄的起点）
    for (const file of [INDEX_FILE, AGG_FILE]) {
      const text = readFileSync(file, 'utf8')
      assert.equal(text.includes(CHANNEL_ID), false, `${file} 里仍出现 ${CHANNEL_ID}（不只是注册点，任何字样都算）`)
    }
    return false
  }
  const missing = sites.filter((s) => !s.present).map((s) => `· 缺 ${s.name}`)
  const extra = inSite.map((s) => `· 有 ${s.name}`)
  assert.fail(
    `注册不完整（${sites.length} 处里只有 ${inSite.length} 处）：渠道会出现在下拉里但聚合层拿不到，`
    + `或者反过来。要么全加回，要么全撤掉。\n${extra.join('\n')}\n${missing.join('\n')}`,
  )
}

test('源码注册点全在或全不在（半加状态点名报，不需要人翻开关）', () => {
  const registered = registeredBySource()
  assert.equal(typeof registered, 'boolean')
})

test('运行时与源码一致（防止「写了字符串却加载失败」这类假注册）', async () => {
  const expected = registeredBySource()
  const wrong = (await runtimeSites())
    .filter((s) => s.present !== expected)
    .map((s) => `· ${s.name}（实际 ${s.present ? '在' : '不在'}，源码表示应 ${expected ? '在' : '不在'}）`)
  assert.equal(wrong.length, 0, `运行时与源码不一致：\n${wrong.join('\n')}`)
})

test('反向锚点：其它按需渠道导出仍在（否则上面几条会因整批 lazy 坏掉而误绿）', async () => {
  const entry = await import('../index.mjs')
  assert.ok(Array.isArray(entry.PROVIDER_IDS) && entry.PROVIDER_IDS.length >= 7, `供应商数异常：${entry.PROVIDER_IDS.length}`)
  assert.equal(typeof entry.HubBaizhiPlugin, 'function', '按需导出整体缺失，本文件的断言已失去意义')
})

test('渠道对象仍可独立加载（撤回只影响注册，不删功能；接回时也要求它完好）', async () => {
  assert.equal(existsSync(CHANNEL_FILE), true, 'src/qwenwork-intl.mjs 不见了：撤回不等于删文件')
  const { qwenworkIntlChannel } = await import('../src/qwenwork-intl.mjs')
  assert.equal(qwenworkIntlChannel?.id, CHANNEL_ID, 'ASCII id 不可改（发布后锁死）')
  assert.deepEqual(qwenworkIntlChannel.checkin(), { outcome: 'inactive' }, '无签到端点 → inactive')
  assert.equal(typeof qwenworkIntlChannel.beginLogin, 'function')
  assert.equal(typeof qwenworkIntlChannel.chat, 'function')
  assert.equal(typeof qwenworkIntlChannel.catalog, 'function')
})