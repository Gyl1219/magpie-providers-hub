// authorize() 契约：必须**立刻**返回 { url, method, callback }，不能 await 用户登录。
//
// 这是真实踩到的 bug：在 authorize 里 await 用户完成登录 ⇒ magpie 在等 authorize
// 返回、用户却在等浏览器打开，双向死锁（现象是 `magpie plugin login` 一直卡住）。
// ofm 的 `authorizeConsole` 也是这个形状（它返回 { url, method, callback }）。
//
// ⚠️ 用 stub 替换渠道的 beginLogin：不真发网络请求、不留 10 分钟轮询定时器、
//    不往真实配置目录写凭据。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 在 import 之前把 HOME 指向临时目录：shared.mjs 的凭据路径按 homedir() 解析
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-auth-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { officeaceChannel } = await import('../src/officeace.mjs')
const { astudioChannel } = await import('../src/astudio.mjs')
const { minimaxintlChannel } = await import('../src/minimaxintl.mjs')
const { REGISTERED_CHANNELS } = await import('../src/aggregate.mjs')
const { DshProvidersHubPlugin } = await import('../index.mjs')

const FAKE = { fake: true }
const stubBeginLogin = async () => ({ url: 'https://example.com/authorize', result: Promise.resolve(FAKE) })
// ⚠️ 必须覆盖**每一个**注册渠道：漏掉的那个会在 authorize 里真发网络请求
//（设备码申请），把测试卡到登录超时。按 REGISTERED_CHANNELS 遍历，新渠道自动覆盖。
for (const channel of REGISTERED_CHANNELS) {
  channel.beginLogin = stubBeginLogin
}

const build = async () => {
  const plugin = await DshProvidersHubPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  return plugin
}

test('每个注册渠道都实现了 beginLogin', async () => {
  assert.ok(REGISTERED_CHANNELS.length >= 3, `渠道数异常：${REGISTERED_CHANNELS.length}`)
  for (const channel of REGISTERED_CHANNELS) {
    assert.equal(typeof channel.beginLogin, 'function', `${channel.id} 缺少 beginLogin`)
  }
  // 引用一致性：测试 stub 的对象必须是聚合层实际持有的那几个
  for (const channel of [officeaceChannel, astudioChannel, minimaxintlChannel]) {
    assert.ok(REGISTERED_CHANNELS.includes(channel), `${channel.id} 未注册进聚合层`)
  }
})

test('authorize 立刻返回（不 await 用户登录）', async () => {
  const plugin = await build()
  for (const method of plugin.auth.methods) {
    const started = Date.now()
    const handle = await method.authorize()
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `${method.label}: authorize 耗时 ${elapsed}ms，说明仍在等用户登录（死锁）`)
    assert.equal(typeof handle.url, 'string')
    assert.ok(handle.url.length > 0, `${method.label}: 缺少 url`)
    assert.equal(handle.method, 'auto')
    assert.equal(typeof handle.callback, 'function', `${method.label}: 缺少 callback`)
  }
})

test('callback 兑现凭据、返回 success 并落盘', async () => {
  const plugin = await build()
  const { loadCredential } = await import('../src/shared.mjs')
  for (const method of plugin.auth.methods) {
    const handle = await method.authorize()
    const outcome = await handle.callback()
    assert.equal(outcome.type, 'success')
    assert.equal(typeof outcome.key, 'string')
    assert.ok(outcome.key.length > 0)
    assert.notEqual(loadCredential(outcome.key), null, `${outcome.key}: 凭据未落盘`)
  }
})

test('cleanup', () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
})
