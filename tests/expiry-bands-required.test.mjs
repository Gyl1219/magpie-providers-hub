// 门禁：滚动指针分档的契约（AGENTS.md 第 1、2 条）。
//
// 新渠道只要走 shared.mjs 的 expiryBandedWindows()，就自动合规；
// 这个测试锁死该工具的行为 —— 一旦有人改动分档语义，这里先红。
//
// ⚠️ 另有一条静态检查：确认渠道源码里出现的「带到期窗口」都用了 banding 工具，
//    而不是手拼 name（手拼会漏档位名，AGENTS.md 明令禁止）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const { expiryBandedWindows, assignExpiryBands } = await import('../src/shared.mjs')

const DAY = 86_400_000

test('expiryBandedWindows：临期=最早到期未耗尽；长期=其余到期；永久=无到期', () => {
  const now = Date.now()
  const buckets = [
    { label: '晚到期', remaining: 1000, expireMs: now + 10 * DAY, expireRaw: '2026-11-07 00:00:00' },
    { label: '早到期', remaining: 200, expireMs: now + 1 * DAY, expireRaw: '2026-10-29 00:00:00' },
    { label: '永久余', remaining: 500, expireMs: undefined, expireRaw: '' },
  ]
  const windows = expiryBandedWindows(buckets, now)
  const byName = (kw) => windows.find((w) => w.name.includes(kw))
  assert.match(byName('早到期').name, /临期·\d+天/, '最早到期的 = 临期指针')
  assert.match(byName('晚到期').name, /长期/, '其余到期 = 长期')
  assert.match(byName('永久余').name, /永久/, '无到期 = 永久')
  // display 带 MM-DD 到期 + 剩余量
  assert.match(byName('早到期').display, /剩余 200 · 10-29 到期/)
  assert.match(byName('永久余').display, /^剩余 500$/)
})

test('expiryBandedWindows：剩 0 = 已耗尽（先于永久判定）+ aside 折叠', () => {
  const now = Date.now()
  const buckets = [
    { label: '用完了', remaining: 0, expireMs: undefined, expireRaw: '' },       // 剩0且无到期
    { label: '还有', remaining: 100, expireMs: now + 2 * DAY, expireRaw: '2026-10-30 00:00:00' },
  ]
  const windows = expiryBandedWindows(buckets, now)
  const spent = windows.find((w) => w.name.includes('用完了'))
  assert.match(spent.name, /已耗尽/, '剩 0 应标已耗尽（不是永久）')
  assert.equal(spent.aside, true, '已耗尽桶 aside 折叠')
})

test('expiryBandedWindows：指针跳过已耗尽桶（用完了的不能当临期）', () => {
  const now = Date.now()
  const buckets = [
    { label: '先用完', remaining: 0, expireMs: now + 1 * DAY, expireRaw: '2026-10-29 00:00:00' },  // 最早但已耗尽
    { label: '还有', remaining: 100, expireMs: now + 3 * DAY, expireRaw: '2026-10-31 00:00:00' },
  ]
  const windows = expiryBandedWindows(buckets, now)
  assert.match(windows.find((w) => w.name.includes('先用完')).name, /已耗尽/)
  assert.match(windows.find((w) => w.name.includes('还有')).name, /临期/, '已耗尽的跳过，指针落到下一个未耗尽的')
})

test('expiryBandedWindows：used% 按 poolTotal 算（无 poolTotal 时满额=0）', () => {
  const now = Date.now()
  const windows = expiryBandedWindows([
    { label: '有总量', remaining: 50, poolTotal: 200, expireMs: now + DAY, expireRaw: '2026-10-29 00:00:00' },
    { label: '满额', remaining: 200, expireMs: now + DAY, expireRaw: '2026-10-29 00:00:00' },
  ], now)
  assert.equal(windows.find((w) => w.name.includes('有总量')).used, 75, '(200-50)/200=75%')
  assert.equal(windows.find((w) => w.name.includes('满额')).used, 0, '满额 used=0')
})

test('expiryBandedWindows：不挂 runsOutAt（避免重复一行）', () => {
  const now = Date.now()
  const windows = expiryBandedWindows([
    { label: 'x', remaining: 100, expireMs: now + DAY, expireRaw: '2026-10-29 00:00:00' },
  ], now)
  for (const w of windows) assert.equal(w.runsOutAt, undefined, '不应挂 runsOutAt')
})

test('门禁：渠道源码里带到期窗口的必须走 banding 工具（不手拼档位）', () => {
  const srcDir = join(import.meta.dirname, '..', 'src')
  // 存量豁免：这些渠道在本约定生效前就手拼了到期窗口，改造需单独回归验证，
  // 暂列入白名单。**新增渠道不得加入此名单** —— 必须直接走 expiryBandedWindows。
  // TODO(migration)：autoclaw / lobsterai / loomy 逐個改成 expiryBandedWindows 后从白名单移除。
  const GRANDFATHERED = new Set(['autoclaw.mjs', 'lobsterai.mjs', 'loomy.mjs'])
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.mjs')
    && !/^(shared|aggregate|self-register|minimax-bridge|minimax-transport|magicrew-browser)\.mjs$/.test(f)
    && !GRANDFATHERED.has(f))
  const offenders = []
  for (const f of files) {
    const code = readFileSync(join(srcDir, f), 'utf8')
    // 该渠道 usage 里出现「到期」字样，却没引入 banding 工具 → 视为手拼
    if (/到期/.test(code) && !/expiryBandedWindows|assignExpiryBands/.test(code) && /async function usage/.test(code)) {
      offenders.push(f)
    }
  }
  assert.deepEqual(offenders, [],
    `这些渠道的 usage 有到期逻辑但没走滚动指针工具（AGENTS.md 第 1 条）：${offenders.join(', ')}`)
})
