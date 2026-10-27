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
const { accioChannel } = await import('../src/accio.mjs')
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
  // ⚠️ notify:false —— 这个测试会把全部渠道各「登录」一遍，每遍都触发
  //    Windows 系统通知；测试里必须关掉，否则跑一轮 npm test 连环弹屏。
  const plugin = await DshProvidersHubPlugin({}, { notify: false })
  const cfg = {}
  await plugin.config(cfg)
  return plugin
}

test('每个注册渠道都实现了 beginLogin', async () => {
  assert.ok(REGISTERED_CHANNELS.length >= 4, `渠道数异常：${REGISTERED_CHANNELS.length}`)
  for (const channel of REGISTERED_CHANNELS) {
    assert.equal(typeof channel.beginLogin, 'function', `${channel.id} 缺少 beginLogin`)
  }
  // 引用一致性：测试 stub 的对象必须是聚合层实际持有的那几个
  for (const channel of [officeaceChannel, astudioChannel, minimaxintlChannel, accioChannel]) {
    assert.ok(REGISTERED_CHANNELS.includes(channel), `${channel.id} 未注册进聚合层`)
  }
  // autoclaw 两个渠道（国内/国际）：聚合层持有的必须就是模块导出的那份
  const { autoclawChannel, autoclawIntlChannel } = await import('../src/autoclaw.mjs')
  assert.ok(REGISTERED_CHANNELS.includes(autoclawChannel), 'autoclaw 未注册进聚合层')
  assert.ok(REGISTERED_CHANNELS.includes(autoclawIntlChannel), 'autoclawintl 未注册进聚合层')
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

test('callback 兑现凭据：success + channel 归属 + 双写落盘', async () => {
  const plugin = await build()
  const { loadCredential } = await import('../src/shared.mjs')
  for (const method of plugin.auth.methods) {
    const handle = await method.authorize()
    const outcome = await handle.callback()
    assert.equal(outcome.type, 'success')
    // ⚠️ channel 字段是账号槽归属的唯一判据（loader/refresh/checkin 都按它分发）
    assert.ok(typeof outcome.channel === 'string' && outcome.channel.length > 0,
      `${method.label}: 登录回调缺 channel 字段`)
    assert.ok(REGISTERED_CHANNELS.some((c) => c.id === outcome.channel), `${method.label}: channel 未注册`)
    // 旁路双写（兜底路径的凭据源）
    assert.notEqual(loadCredential(outcome.channel), null, `${outcome.channel}: 旁路凭据未落盘`)
    // FAKE 凭据字段被完整带进账号槽（magpie 存的就是这个对象）
    assert.equal(outcome.fake, true, `${method.label}: 凭据字段未随账号槽存储`)
  }
})

test('cleanup', () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
})
