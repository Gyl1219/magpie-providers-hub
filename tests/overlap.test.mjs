/**
 * 重叠渠道默认不注册（社区 registry 审核 PR #502 的结论）。
 *
 * yetone：同一个订阅在 registry 里出现两个入口、两套登录、两套额度，用户会搞不清
 * 装哪个。所以与现有插件重叠的五个渠道默认不注册（入口导出**对象占位**，magpie
 * 不把它当插件），要用就设 `MAGPIE_HUB_EXTRA_CHANNELS` 打开 —— 代码留在包里不删，
 * 已登录的用户升级不掉线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import {
  channelRegistered,
  extraChannelsFrom,
  extraChannelsFromFileRaw,
  extraSwitchFrom,
  disabledChannelMarker,
  OVERLAPPING_CHANNEL_IDS,
  EXTRA_CHANNELS_ENV,
  DEFAULT_PROVIDER_IDS,
  providerIdOf,
} from '../src/aggregate.mjs'

const OVERLAPPING = ['officeace', 'autoclaw', 'autoclawintl', 'loomy', 'minimaxintl']
const DEFAULT_ONLY = ['astudio', 'accio', 'lobsterai', 'magicrew', 'magicrew-intl']

test('重叠清单就是审核点名的那五个', () => {
  assert.deepEqual([...OVERLAPPING_CHANNEL_IDS].sort(), [...OVERLAPPING].sort())
  assert.equal(EXTRA_CHANNELS_ENV, 'MAGPIE_HUB_EXTRA_CHANNELS')
})

test('不重叠的渠道：无论开关如何都注册', () => {
  for (const id of DEFAULT_ONLY) {
    assert.equal(channelRegistered(id, {}), true, `${id} 必须默认注册`)
    assert.equal(channelRegistered(id, { [EXTRA_CHANNELS_ENV]: '' }), true)
  }
})

test('重叠渠道：默认不注册', () => {
  for (const id of OVERLAPPING) {
    assert.equal(channelRegistered(id, {}), false, `${id} 默认不该注册`)
    assert.equal(channelRegistered(id, { [EXTRA_CHANNELS_ENV]: '' }), false)
  }
})

test('重叠渠道：开关按 id 精确打开（只开要开的）', () => {
  const env = { [EXTRA_CHANNELS_ENV]: 'officeace,autoclawintl' }
  assert.equal(channelRegistered('officeace', env), true)
  assert.equal(channelRegistered('autoclawintl', env), true)
  assert.equal(channelRegistered('autoclaw', env), false, '没列出来的仍然不注册')
  assert.equal(channelRegistered('loomy', env), false)
  assert.equal(channelRegistered('astudio', env), true, '不重叠的照常')
})

test('开关 all：十个全开；大小写与空格都认', () => {
  const env = { [EXTRA_CHANNELS_ENV]: ' ALL , OfficeAce ' }
  for (const id of [...OVERLAPPING, ...DEFAULT_ONLY]) {
    assert.equal(channelRegistered(id, env), true, `${id} 在 all 下应注册`)
  }
})

test('开关文件：{"extraChannels": …} 两种形态都认，坏 JSON 当没开', () => {
  assert.equal(extraChannelsFromFileRaw('{"extraChannels":"all"}'), 'all')
  assert.equal(extraChannelsFromFileRaw('{"extraChannels":["officeace","loomy"]}'), 'officeace,loomy')
  assert.equal(extraChannelsFromFileRaw('{"extraChannels":"officeace"}'), 'officeace')
  assert.equal(extraChannelsFromFileRaw('{"别的字段":1}'), '')
  assert.equal(extraChannelsFromFileRaw('不是 JSON'), '')
  assert.equal(extraChannelsFromFileRaw(''), '')
})

test('开关文件：channelRegistered 直接吃文件内容', () => {
  const env = { [EXTRA_CHANNELS_ENV]: '' }
  assert.equal(channelRegistered('officeace', env, '{"extraChannels":["officeace"]}'), true)
  assert.equal(channelRegistered('loomy', env, '{"extraChannels":["officeace"]}'), false)
  assert.equal(channelRegistered('officeace', env, '{"extraChannels":"all"}'), true)
  assert.equal(channelRegistered('loomy', env, '坏 JSON'), false, '坏 JSON = 没开')
})

test('环境变量与开关文件取并集（任一处 all 即全开）', () => {
  const env = { [EXTRA_CHANNELS_ENV]: 'officeace' }
  const s1 = extraSwitchFrom(env[EXTRA_CHANNELS_ENV], '{"extraChannels":["loomy"]}')
  assert.equal(s1.all, false)
  assert.deepEqual([...s1.ids].sort(), ['loomy', 'officeace'])
  const s2 = extraSwitchFrom('officeace', '{"extraChannels":"all"}')
  assert.equal(s2.all, true)
})

test('开关文件走 DSH_HUB_SWITCH_PATH（真读磁盘的路径）', async () => {
  const { writeFileSync } = await import('node:fs')
  const { hubSwitchPath } = await import('../src/shared.mjs')
  const p = process.env.DSH_HUB_SWITCH_PATH
  assert.ok(p, 'setup 必须把开关文件重定向进沙箱')
  writeFileSync(p, '{"extraChannels":["autoclawintl"]}', 'utf8')
  assert.equal(channelRegistered('autoclawintl'), true, '磁盘上的开关文件应生效')
  assert.equal(channelRegistered('officeace'), false, '文件里没列的仍不注册')
  rmSync(p, { force: true })
  assert.equal(channelRegistered('autoclawintl'), false, '文件删掉即回默认态')
})

test('默认注册的 provider id = 条目里列的那五个', () => {
  assert.deepEqual([...DEFAULT_PROVIDER_IDS].sort(), DEFAULT_ONLY.map((id) => providerIdOf({ id })).sort())
  for (const id of OVERLAPPING) {
    assert.equal(DEFAULT_PROVIDER_IDS.includes(providerIdOf({ id })), false, `${id} 不该出现在条目里`)
  }
})

test('占位值是对象（magpie 只把函数导出当插件），且写明怎么开', () => {
  const marker = disabledChannelMarker('officeace')
  assert.equal(typeof marker, 'object')
  assert.equal(typeof marker, 'object')
  assert.notEqual(typeof marker, 'function', '占位绝不能是函数（会被当成一个供应商）')
  assert.equal(marker.disabled, true)
  assert.equal(marker.providerId, 'hub-officeace')
  assert.match(marker.reason, /MAGPIE_HUB_EXTRA_CHANNELS/)
})

test('入口：默认只导出五个插件函数，其余是占位对象', async () => {
  const mod = await import(new URL('../index.mjs', import.meta.url).href)
  const exported = Object.entries(mod).filter(([name]) => name.endsWith('Plugin'))
  const fns = exported.filter(([, v]) => typeof v === 'function').map(([n]) => n)
  const markers = exported.filter(([, v]) => typeof v !== 'function').map(([n]) => n)
  assert.equal(fns.length, 5, '默认注册五条供应商')
  assert.equal(markers.length, 5, '重叠的五条是占位对象')
  const EXPORT_NAME_OF = {
    officeace: 'HubOfficeAcePlugin',
    autoclaw: 'HubAutoClawPlugin',
    autoclawintl: 'HubAutoClawIntlPlugin',
    loomy: 'HubLoomyPlugin',
    minimaxintl: 'HubMiniMaxIntlPlugin',
    astudio: 'HubAStudioPlugin',
    accio: 'HubAccioPlugin',
    lobsterai: 'HubLobsterAIPlugin',
    magicrew: 'HubMagicrewPlugin',
    'magicrew-intl': 'HubMagicrewIntlPlugin',
  }
  for (const id of OVERLAPPING) {
    assert.ok(markers.includes(EXPORT_NAME_OF[id]), `${id} 的导出应是占位（${EXPORT_NAME_OF[id]}）`)
  }
  for (const id of DEFAULT_ONLY) {
    assert.ok(fns.includes(EXPORT_NAME_OF[id]), `${id} 的导出应是函数（${EXPORT_NAME_OF[id]}）`)
  }
  // HUB_PLUGINS 始终十条真函数（测试遍历用），对象导出不会被 magpie 当插件
  assert.equal(typeof mod.HUB_PLUGINS, 'object')
  assert.equal(Object.values(mod.HUB_PLUGINS).filter((v) => typeof v === 'function').length, 10)
})
