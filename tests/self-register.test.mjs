/**
 * 市场缓存自注册（卡片「承载 …」/ 认证标的来源）。
 *
 * ⚠️ 真机 2026-10-30：magpie 启动后**异步**拉一次官方 registry 并整体重写
 * `~/.cache/magpie/plugin-market.json`，把插件 100ms 写进去的那条**冲掉**
 * —— 卡片于是退回 GitHub 话题发现的「未审阅」黄标。所以落盘时点是有上限的
 * 一组补写（FLUSH_SCHEDULE_MS），不是一次了事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSelf, _flushNow, _reset, _internal } from '../tools/self-register.mjs'

/** 造一个「假的 magpie 家目录」：configDir → <tmp>/config/magpie，缓存落到 <tmp>/.cache/magpie */
function fakeHome(plugins) {
  const root = mkdtempSync(join(tmpdir(), 'selfreg-'))
  const configDir = join(root, 'config', 'magpie')
  const cacheDir = join(root, '.cache', 'magpie')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  if (plugins) writeFileSync(join(cacheDir, 'plugin-market.json'), JSON.stringify({ version: 1, plugins }, null, 2), 'utf8')
  return { root, configDir, cacheDir, marketPath: join(cacheDir, 'plugin-market.json') }
}

const ENTRY = {
  package: 'magpie-providers-hub',
  name: 'Providers Hub',
  providers: ['hub-officeace', 'hub-autoclawintl'],
  community: true,
  summary: { en: 'en', zh: 'zh' },
}

test('自注册：条目进缓存，官方条目不动', async () => {
  _reset()
  const home = fakeHome([{ package: 'officeace-auth', name: 'OfficeAce', community: true }])
  const r = await registerSelf(ENTRY, { configDir: home.configDir })
  assert.equal(r.ok, true)
  assert.deepEqual(r.added, ['magpie-providers-hub'])
  const j = JSON.parse(readFileSync(home.marketPath, 'utf8'))
  assert.equal(j.plugins.length, 2, '官方条目保留 + 新增我们一条')
  assert.equal(j.plugins[0].package, 'officeace-auth')
  assert.equal(j.plugins[1].package, 'magpie-providers-hub')
  assert.deepEqual(j.plugins[1].providers, ['hub-officeace', 'hub-autoclawintl'])
})

test('自注册：magpie 官方拉取整体重写后，后续时点把条目补回来（黄标的根因）', async () => {
  _reset()
  const home = fakeHome([{ package: 'officeace-auth', name: 'OfficeAce', community: true }])
  await registerSelf(ENTRY, { configDir: home.configDir })
  // 模拟 magpie 异步拉到官方 registry：整文件覆盖成官方条目
  writeFileSync(home.marketPath, JSON.stringify({ version: 1, plugins: [{ package: 'officeace-auth', name: 'OfficeAce', community: true }] }, null, 2), 'utf8')
  let j = JSON.parse(readFileSync(home.marketPath, 'utf8'))
  assert.equal(j.plugins.length, 1, '此刻我们的条目确实被冲掉了')
  // 后续时点（30s/90s/240s 那几次）补写 —— 测试里用 _flushNow 直接驱动
  const again = _flushNow()
  assert.equal(again.ok, true)
  j = JSON.parse(readFileSync(home.marketPath, 'utf8'))
  assert.equal(j.plugins.length, 2, '补写必须把我们的条目加回来')
  assert.ok(j.plugins.some((x) => x.package === 'magpie-providers-hub'))
})

test('自注册：重复合并且条目已存在 → 不写盘（幂等，不做无意义 IO）', async () => {
  _reset()
  const home = fakeHome([{ package: 'officeace-auth', name: 'OfficeAce', community: true }])
  await registerSelf(ENTRY, { configDir: home.configDir })
  const q = globalThis[_internal.QUEUE_KEY]
  const writesBefore = q.writes
  const r = _flushNow()
  assert.equal(r.changed, false, '内容一样就不该写盘')
  assert.equal(q.writes, writesBefore, '写盘次数不能增加')
})

test('自注册：缓存不可用时跳过（不阻塞插件加载），缓存恢复后仍能写', async () => {
  _reset()
  const home = fakeHome(null) // 没有 plugin-market.json
  const r = await registerSelf(ENTRY, { configDir: home.configDir })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '市场缓存不可用')
  assert.equal(existsSync(home.marketPath), false, '不凭空造缓存文件')
  // magpie 的官方拉取落盘后，后续补写就能成功
  writeFileSync(home.marketPath, JSON.stringify({ version: 1, plugins: [] }, null, 2), 'utf8')
  const again = _flushNow()
  assert.equal(again.ok, true)
  assert.equal(JSON.parse(readFileSync(home.marketPath, 'utf8')).plugins.length, 1)
})

test('落盘时点是有上限的一组补写（不是轮询/watch）', () => {
  assert.ok(Array.isArray(_internal.FLUSH_SCHEDULE_MS), '时点表必须存在')
  assert.ok(_internal.FLUSH_SCHEDULE_MS.length >= 2, '不能只写一次（会被 magpie 官方拉取冲掉）')
  assert.ok(_internal.FLUSH_SCHEDULE_MS.length <= 6, '必须有上限（禁止无休止轮询）')
  assert.ok(_internal.FLUSH_SCHEDULE_MS.every((ms) => ms > 0))
})
