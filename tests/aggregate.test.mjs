// 聚合层的行为契约。
//
// 只测「错了会静默出错」的地方：模型前缀分派、未登录回落、单渠道失败隔离。
// 不测「能 import」这类没有诊断价值的断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshProvidersHubPlugin } from '../index.mjs'

const build = async (options = {}) => {
  const plugin = await DshProvidersHubPlugin({}, options)
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, provider: cfg.provider['dsh-providers-hub'] }
}

test('一个插件只注册一个供应商：dsh-providers-hub', async () => {
  const plugin = await DshProvidersHubPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider), ['dsh-providers-hub'])
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
})

test('未登录也不返回空目录（回落兜底，选择器不会空掉）', async () => {
  const { plugin, provider } = await build()
  const models = await plugin.provider.models(provider)
  assert.ok(Object.keys(models).length > 0, '未登录时目录不应为空')
})

test('登录入口每渠道一个（不是每渠道一个供应商）', async () => {
  const { plugin } = await build()
  const labels = plugin.auth.methods.map((m) => m.label)
  assert.equal(labels.length, 3)
  assert.ok(labels.some((l) => l.includes('OfficeAce')))
  assert.ok(labels.some((l) => l.includes('AStudio')))
  assert.ok(labels.some((l) => l.includes('MiniMax')))
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
