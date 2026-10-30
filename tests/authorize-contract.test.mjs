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

const { astudioChannel } = await import('../src/astudio.mjs')
const { accioChannel } = await import('../src/accio.mjs')
const { lobsteraiChannel } = await import('../src/lobsterai.mjs')
const { magicrewChannel, magicrewIntlChannel } = await import('../src/magicrew.mjs')
const { REGISTERED_CHANNELS, makeHubPlugin } = await import('../src/aggregate.mjs')

const FAKE = { fake: true }
const stubBeginLogin = async () => ({ url: 'https://example.com/authorize', result: Promise.resolve(FAKE) })
// ⚠️ 必须覆盖**每一个**注册渠道：漏掉的那个会在 authorize 里真发网络请求
//（设备码申请），把测试卡到登录超时。按 REGISTERED_CHANNELS 遍历，新渠道自动覆盖。
for (const channel of REGISTERED_CHANNELS) {
  channel.beginLogin = stubBeginLogin
}

/** 每个渠道一个供应商 ⇒ 拿它的插件实例。 */
const build = async (channel) => {
  // ⚠️ notify:false —— 这个测试会把全部渠道各「登录」一遍，每遍都触发
  //    Windows 系统通知；测试里必须关掉，否则跑一轮 npm test 连环弹屏。
  const plugin = await makeHubPlugin(channel)({}, { notify: false })
  const cfg = {}
  await plugin.config(cfg)
  return plugin
}

test('每个注册渠道都实现了 beginLogin', async () => {
  assert.equal(REGISTERED_CHANNELS.length, 5, `v0.5.0 起只有五条渠道，实际：${REGISTERED_CHANNELS.length}`)
  for (const channel of REGISTERED_CHANNELS) {
    assert.equal(typeof channel.beginLogin, 'function', `${channel.id} 缺少 beginLogin`)
  }
  // 引用一致性：测试 stub 的对象必须是聚合层实际持有的那几个
  for (const channel of [astudioChannel, accioChannel, lobsteraiChannel, magicrewChannel, magicrewIntlChannel]) {
    assert.ok(REGISTERED_CHANNELS.includes(channel), `${channel.id} 未注册进聚合层`)
  }
  // 已删渠道不许再出现在聚合层（PR #502 审核：重叠 + 敏感能力，整个删掉）
  for (const gone of ['officeace', 'autoclaw', 'autoclawintl', 'loomy', 'minimaxintl']) {
    assert.equal(REGISTERED_CHANNELS.some((c) => c.id === gone), false, `${gone} 已从包里删除`)
  }
})

test('authorize 立刻返回（不 await 用户登录）', async () => {
  for (const channel of REGISTERED_CHANNELS) {
    const plugin = await build(channel)
    assert.equal(plugin.auth.methods.length, channel.loginMethods?.length ?? 1,
      `${channel.id}: 登录入口数应与 loginMethods 声明一致`)
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
  }
})

test('callback 兑现凭据：success + channel 归属 + 进内存缓存', async () => {
  const { _internal } = await import('../src/aggregate.mjs')
  for (const channel of REGISTERED_CHANNELS) {
    const plugin = await build(channel)
    for (const method of plugin.auth.methods) {
      const handle = await method.authorize()
      const outcome = await handle.callback()
      assert.equal(outcome.type, 'success')
      // ⚠️ channel 字段是账号槽归属的唯一判据（loader/refresh/checkin 都按它分发）
      assert.equal(outcome.channel, channel.id, `${method.label}: 登录回调的 channel 应是本渠道`)
      assert.ok(REGISTERED_CHANNELS.some((c) => c.id === outcome.channel), `${method.label}: channel 未注册`)
      // ⚠️ v0.5.0 起**没有旁路凭据文件**（PR #502 审核第 2 条）：凭据进内存缓存，
      //    落盘只走 magpie 账号槽（client.auth.set）。
      assert.notEqual(_internal.cachedCredentialOf(channel), undefined, `${outcome.channel}: 登录后应进内存缓存`)
      // FAKE 凭据字段被完整带进账号槽（magpie 存的就是这个对象）
      assert.equal(outcome.fake, true, `${method.label}: 凭据字段未随账号槽存储`)
    }
  }
})

test('cleanup', () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
})
