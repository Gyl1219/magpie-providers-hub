// 渠道模型名**自带斜杠**时的路由契约（真机踩过）。
//
// MonkeyCode 的上游模型名是 `monkeycode-basic/deepseek-flash` 这种形态：
// 档位前缀 `monkeycode-basic/` 是**模型名的一部分**，不是供应商前缀。
//
// 旧 resolve() 一律 `split('/')` 后取最后一段当 model、取倒数第二段当 prefix 校验，
// 于是 `hub-monkeycode-intl/monkeycode-basic/deepseek-flash` 的 prefix 被判成
// `monkeycode-basic`（≠ provider / channel id）→ 404「无法识别的模型」。
// 即使放过，只把 `deepseek-flash` 发上游也会 403 Forbidden（网关只认全名）。
//
// 本文件锁死：声明 `modelHasSlash` 的渠道必须把**整串模型名**交给上游，
// 且其它渠道的既有三种写法（裸名 / hub-<id>/名 / 旧 <id>/名）行为不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-slash-'))
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { HUB_PLUGINS } = await import('../index.mjs')
const { makeHubPlugin } = await import('../src/aggregate.mjs')

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** 造一个最小渠道：记录上游实际收到的 model，其余一律回固定响应。 */
const makeProbeChannel = ({ id, modelHasSlash }) => {
  const seen = []
  const channel = {
    id,
    displayName: `probe-${id}`,
    ...(modelHasSlash === true ? { modelHasSlash: true } : {}),
    fallbackModels: {},
    catalog: async () => ({}),
    loginMethods: [{ label: 'probe' }],
    beginLogin: async () => ({ url: 'http://127.0.0.1:1/', result: new Promise(() => {}) }),
    expired: () => false,
    refresh: async () => { throw new Error('probe: no refresh') },
    checkin: async () => ({ outcome: 'inactive' }),
    usage: async () => [],
    chat: async (credential, init) => {
      seen.push(init?.body?.model)
      return Response.json({ ok: true, model: init?.body?.model })
    },
  }
  return { channel, seen }
}

/** 用给定渠道建插件，并拿到它的 fetch 入口。 */
const mount = async (channel) => {
  const plugin = await makeHubPlugin(channel)({}, { notify: false })
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, cfg }
}

/** 走一次 chat 请求，返回上游看到的 model。 */
const chatOnce = async (plugin, model) => {
  // authOfChannel 要求 auth.channel === channel.id（不是 provider id）
  const channelId = plugin.provider.id.replace(/^hub-/, '')
  const { fetch: pluginFetch } = await plugin.auth.loader(async () => ({
    type: 'success', channel: channelId, access: 'probe-token',
  }))
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  const res = await pluginFetch('http://127.0.0.1/x', { method: 'POST', body })
  const payload = await res.json().catch(() => ({}))
  return { status: res.status, payload }
}

test('modelHasSlash 渠道：档位前缀不被当成渠道前缀剥掉', async () => {
  const { channel, seen } = makeProbeChannel({ id: 'probe-slash', modelHasSlash: true })
  const { plugin, cfg } = await mount(channel)

  // magpie 实际发来的形态：hub-<渠道 id>/<上游全名>
  const out = await chatOnce(plugin, 'hub-probe-slash/monkeycode-basic/deepseek-flash')
  assert.equal(out.status, 200, '必须路由成功，不能 404')
  assert.equal(seen.at(-1), 'monkeycode-basic/deepseek-flash',
    '上游必须收到带档位前缀的完整模型名（只发 deepseek-flash 会被网关 403）')

  // 裸名（无供应商前缀）也要原样保留
  await chatOnce(plugin, 'monkeycode-pro/deepseek-v4-pro')
  assert.equal(seen.at(-1), 'monkeycode-pro/deepseek-v4-pro')
})

test('modelHasSlash 渠道：仍认旧写法，且剥离后不残留前缀', async () => {
  const { channel, seen } = makeProbeChannel({ id: 'probe-slash2', modelHasSlash: true })
  const { plugin, cfg } = await mount(channel)

  await chatOnce(plugin, 'probe-slash2/monkeycode-ultra/deepseek-v4-pro')
  assert.equal(seen.at(-1), 'monkeycode-ultra/deepseek-v4-pro', '旧渠道 id 前缀也要剥掉')

  await chatOnce(plugin, 'providers-hub/monkeycode-basic/deepseek-flash')
  assert.equal(seen.at(-1), 'monkeycode-basic/deepseek-flash', '旧聚合前缀也要剥掉')
})

test('未声明 modelHasSlash 的渠道：行为不变（三种写法 + 别人的前缀仍 404）', async () => {
  const { channel, seen } = makeProbeChannel({ id: 'probe-plain' })
  const { plugin, cfg } = await mount(channel)

  await chatOnce(plugin, 'glm-5')
  assert.equal(seen.at(-1), 'glm-5', '裸名')

  await chatOnce(plugin, 'hub-probe-plain/glm-5')
  assert.equal(seen.at(-1), 'glm-5', 'hub-<id>/ 前缀被剥')

  await chatOnce(plugin, 'probe-plain/glm-5')
  assert.equal(seen.at(-1), 'glm-5', '旧 <id>/ 前缀被剥')

  const others = await chatOnce(plugin, 'hub-other/glm-5')
  assert.equal(others.status, 404, '别的供应商前缀必须 404，不静默转发')
})
