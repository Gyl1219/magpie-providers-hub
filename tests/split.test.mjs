// 多供应商拆分（v0.4.0）的行为契约。
//
// 覆盖三件「错了会静默出错」的事：
//   1. 十个渠道 ↔ 十个供应商 id ↔ 十条 magpie 卡片，一一对应且 id 稳定唯一；
//   2. 旧版（聚合形态）账号槽 `providers-hub*` 能一次性迁到 `hub-*`，且幂等；
//   3. 没有账号槽的旁路渠道（一键导入的 AutoClaw 这类）由模块级 sweep 补签，
//      结果只进页面快照、绝不进任何账号的返回信息。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-split-'))
const originalHome = process.env.USERPROFILE
const originalAuthPath = process.env.DSH_HUB_AUTH_PATH
const originalSnapPath = process.env.DSH_HUB_SNAPSHOT_PATH
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.DSH_HUB_AUTH_PATH = join(sandbox, '.config', 'magpie', 'plugin-auth.json')
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')
mkdirSync(join(sandbox, '.config', 'magpie'), { recursive: true })

const { HUB_PLUGINS, REGISTERED_CHANNELS, PROVIDER_IDS } = await import('../index.mjs')
const { makeHubPlugin, providerIdOf, providerNameOf, _internal } = await import('../src/aggregate.mjs')

test.after = () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  if (originalAuthPath === undefined) delete process.env.DSH_HUB_AUTH_PATH
  else process.env.DSH_HUB_AUTH_PATH = originalAuthPath
  if (originalSnapPath === undefined) delete process.env.DSH_HUB_SNAPSHOT_PATH
  else process.env.DSH_HUB_SNAPSHOT_PATH = originalSnapPath
  rmSync(sandbox, { recursive: true, force: true })
}

const writeAuthSlots = (obj) => writeFileSync(process.env.DSH_HUB_AUTH_PATH, JSON.stringify(obj), 'utf8')
const readSnapshot = () => {
  try {
    const text = readFileSync(process.env.DSH_HUB_SNAPSHOT_PATH, 'utf8')
    return JSON.parse(text.replace(/^window\.__PROVIDERS_HUB_SNAPSHOT__\s*=\s*/, '').replace(/;\s*$/, ''))
  } catch {
    return undefined
  }
}

test('十个渠道 ↔ 十个供应商 id ↔ 十个插件导出，一一对应', async () => {
  assert.equal(REGISTERED_CHANNELS.length, 10, '渠道数应是 10（漏注册会静默少一个供应商）')
  assert.deepEqual(PROVIDER_IDS, REGISTERED_CHANNELS.map(providerIdOf), 'PROVIDER_IDS 必须与渠道一一对应')
  assert.equal(Object.keys(HUB_PLUGINS).length, 10, 'index.mjs 必须导出 10 个插件函数')
  const seen = new Set()
  for (const channel of REGISTERED_CHANNELS) {
    const plugin = await makeHubPlugin(channel)({}, { notify: false })
    assert.equal(plugin.provider.id, providerIdOf(channel))
    assert.equal(plugin.auth.provider, providerIdOf(channel))
    assert.ok(!seen.has(plugin.provider.id), `供应商 id 重复：${plugin.provider.id}`)
    seen.add(plugin.provider.id)
    const cfg = {}
    await plugin.config(cfg)
    assert.equal(cfg.provider[plugin.provider.id].name, providerNameOf(channel), '供应商显示名要跟渠道对上')
  }
  assert.equal(seen.size, 10)
})

test('旧账号槽 providers-hub* → hub-<渠道>：搬迁一次、幂等、可关', async () => {
  const channel = REGISTERED_CHANNELS[0]
  const legacyAuth = {
    type: 'success',
    channel: channel.id,
    accountId: 'OfficeAce',
    access: 'AK',
    expires: Date.now() + 3600_000,
  }
  // 旧版聚合形态的槽 key
  writeAuthSlots({ 'providers-hub': legacyAuth, 'providers-hub#abc': { ...legacyAuth, accountId: 'second' } })
  _internal.resetMigrations()

  const saved = []
  const plugin = await makeHubPlugin(channel)({
    client: { auth: { set: async (call) => { saved.push(call) } } },
  }, { notify: false })
  await plugin.config({})
  assert.equal(saved.length, 2, '旧槽里同渠道的两个账号都要搬过去')
  assert.ok(saved.every((c) => c.path.id === providerIdOf(channel)), '写到新供应商 id 下')
  assert.equal(saved[0].body.accountId, 'OfficeAce', '账号信息原样带过去')
  assert.equal(saved[0].body.channel, channel.id, 'channel 归属字段不能丢')

  // 幂等（进程内）：同一个供应商再加载一次不再写
  const again = []
  const plugin2 = await makeHubPlugin(channel)({
    client: { auth: { set: async (call) => { again.push(call) } } },
  }, { notify: false })
  await plugin2.config({})
  assert.equal(again.length, 0, '同进程内迁移只做一次')

  // 幂等（magpie 已落盘）：新槽存在后，即便重置进程内缓存也不再搬
  writeAuthSlots({
    'providers-hub': legacyAuth,
    [`${providerIdOf(channel)}`]: legacyAuth,
  })
  _internal.resetMigrations()
  const third = []
  const plugin3 = await makeHubPlugin(channel)({
    client: { auth: { set: async (call) => { third.push(call) } } },
  }, { notify: false })
  await plugin3.config({})
  assert.equal(third.length, 0, '新槽已存在就不能覆盖（会冲掉 magpie 的新登录）')

  // 别的渠道的槽不能被抢走
  const other = REGISTERED_CHANNELS[1]
  writeAuthSlots({ 'providers-hub': legacyAuth })
  _internal.resetMigrations()
  const otherSaved = []
  const pluginOther = await makeHubPlugin(other)({
    client: { auth: { set: async (call) => { otherSaved.push(call) } } },
  }, { notify: false })
  await pluginOther.config({})
  assert.equal(otherSaved.length, 0, `${other.id} 没有旧槽，不该写`)

  // 关掉迁移：一条都不写
  _internal.resetMigrations()
  const offSaved = []
  const plugin4 = await makeHubPlugin(REGISTERED_CHANNELS[0])({
    client: { auth: { set: async (call) => { offSaved.push(call) } } },
  }, { notify: false, migrateLegacySlots: false })
  await plugin4.config({})
  assert.equal(offSaved.length, 0, 'migrateLegacySlots:false 必须完全不动 magpie 的槽')
})

test('旁路口径的渠道由模块级 sweep 补签，结果只进快照', async () => {
  // 一个没有任何 magpie 账号槽、只有旁路凭据的渠道（生产里「一键导入」即此形态）
  const channel = REGISTERED_CHANNELS[2]
  writeAuthSlots({})
  const { saveCredential } = await import('../src/shared.mjs')
  saveCredential(channel.id, { access_token: 'sidecar-only' })
  let calls = 0
  const original = channel.checkin
  channel.checkin = async () => {
    calls += 1
    return { outcome: 'claimed', credit: 30, message: '旁路补签 OK' }
  }
  try {
    _internal.enableSnapshotWrites()
    await _internal.sweepAllChannels()
    assert.equal(calls, 1, '没有账号槽的渠道必须被 sweep 补签')
    const snap = readSnapshot()
    const row = snap?.channels?.find((c) => c.id === channel.id)
    assert.ok(row, '快照里应有该渠道')
    assert.equal(row.checkin?.outcome, 'claimed', '签到结果要进快照（页面据此上色）')
    assert.equal(row.checkin?.credit, 30)
    // 再扫一次：当日记账已 claimed，不重复请求
    await _internal.sweepAllChannels()
    assert.equal(calls, 1, '同日已签的不重复打上游')
  } finally {
    channel.checkin = original
  }
})
