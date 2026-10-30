/**
 * 社区 registry 审核的硬门槛（PR #502 的两轮审核意见）。这个文件是那几条红线的回归网：
 *
 *   ① 发布代码里不出现 magpie 的宿主文件路径（市场缓存 / 凭据文件）；
 *   ② 发布清单不含 tools/ 与 tests/；
 *   ③ **真加载一次插件，市场缓存文件的 mtime 与内容零变化**（yetone 的同款探针）；
 *   ④ 插件**不往 magpie 的配置目录写凭据**（v0.5.0 起账号只存 magpie 账号槽）；
 *   ⑤ 读账号槽时**只读本插件自己的槽**，别人的 token 不经过我们的代码。
 *
 * 前身是 MYCF711 的 officeace-auth #399 被 block 的那条：审核原话
 * 「no fs writes, child_process, eval or HOME/cache paths」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

// ⚠️ 必须走 fileURLToPath：URL.pathname 是百分号编码的，中文路径下会 scandir 不到
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const published = ['index.mjs', ...readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => join('src', f))]

test('红线①：发布代码里不出现 magpie 的宿主文件（市场缓存 / 凭据文件）', () => {
  for (const rel of published) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert.doesNotMatch(text, /plugin-market\.json/,
      `${rel} 不得引用 magpie 的市场缓存 —— 审核会直接 block（officeace-auth #399 先例）`)
    // ⚠️ PR #502 第 2 条：不许再写 <渠道>-credential.json 这类旁路凭据文件
    assert.doesNotMatch(text, /-credential\.json/,
      `${rel} 不得出现旁路凭据文件名（v0.5.0 起账号只存 magpie 账号槽）`)
  }
  assert.equal(existsSync(join(ROOT, 'src', 'self-register.mjs')), false,
    '自注册模块必须留在 tools/（仓库内手工工具），不能进 src/')
})

test('红线①之二：登录用的临时 profile 不落 magpie 的缓存目录', () => {
  const browser = readFileSync(join(ROOT, 'src', 'magicrew-browser.mjs'), 'utf8')
  assert.doesNotMatch(browser, /from 'node:os'[\s\S]{0,40}homedir/, '登录浏览器不该再碰 homedir')
  assert.doesNotMatch(browser, /join\(homedir\(\)/, '临时 profile 不许落在 home 下')
  assert.match(browser, /tmpdir\(\)/, '临时 profile 走系统临时目录')
  // 只读地盘可以留：magicrew 读 magpie 的 models.json 作兜底（只读，不写）
  const magicrew = readFileSync(join(ROOT, 'src', 'magicrew.mjs'), 'utf8')
  assert.doesNotMatch(magicrew, /writeFileSync\([^)]*\.cache/, 'magpie 的缓存目录只读不写')
})

test('红线①之三：诊断日志不进 magpie 的目录（开关打开也只落系统临时目录）', async () => {
  const { debugLog } = await import(new URL('../src/shared.mjs', import.meta.url).href)
  const home = process.env.HOME ?? process.env.USERPROFILE
  const magpieConfigLog = join(home, '.config', 'magpie', 'notify-debug.log')
  const magpieCacheLog = join(home, '.cache', 'magpie', 'debug.log')
  const tmpLog = join(tmpdir(), 'providers-hub', 'debug.log')
  const saved = process.env.DSH_HUB_DEBUG
  try {
    delete process.env.DSH_HUB_DEBUG
    const tmpHad = existsSync(tmpLog)
    debugLog('probe: 默认不该落盘')
    assert.equal(existsSync(tmpLog), tmpHad, '默认连临时目录都不写')
    assert.equal(existsSync(magpieConfigLog), false, '默认绝不能往 magpie 的 config 目录写')
    process.env.DSH_HUB_DEBUG = '1'
    debugLog('probe: 开了开关才写')
    assert.equal(existsSync(tmpLog), true, 'DSH_HUB_DEBUG=1 时写到系统临时目录（排查用）')
    assert.equal(existsSync(magpieConfigLog), false, '开了开关也不许写进 magpie 的目录')
    assert.equal(existsSync(magpieCacheLog), false, 'cache 目录同样不碰')
  } finally {
    if (saved === undefined) delete process.env.DSH_HUB_DEBUG
    else process.env.DSH_HUB_DEBUG = saved
    for (const p of [magpieConfigLog, magpieCacheLog]) {
      try { rmSync(p, { force: true }) } catch { /* 沙箱里删不掉无所谓 */ }
    }
  }
})

test('红线②：npm 发布清单不含 tools/ 与 tests/', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files), 'files 必须是白名单')
  for (const forbidden of ['tools', 'tests', 'tools/', 'tests/']) {
    assert.equal(pkg.files.includes(forbidden), false, `发布清单不该含 ${forbidden}`)
  }
  assert.ok(pkg.files.includes('src'), 'src 必须发布')
})

test('红线③：加载插件后 magpie 市场缓存零变化（审核同款探针）', async () => {
  // 造一份「magpie 的市场缓存」到沙箱 HOME 下（tests/setup.mjs 已把 HOME 指向临时目录）
  const home = process.env.HOME ?? process.env.USERPROFILE
  const cacheDir = join(home, '.cache', 'magpie')
  mkdirSync(cacheDir, { recursive: true })
  const marketPath = join(cacheDir, 'plugin-market.json')
  const seed = JSON.stringify({ version: 1, plugins: [{ package: 'officeace-auth', name: 'OfficeAce', community: true }] }, null, 2)
  writeFileSync(marketPath, seed, 'utf8')
  const before = statSync(marketPath).mtimeMs

  const mod = await import(new URL('../index.mjs', import.meta.url).href)
  // 像 magpie 那样把每个函数导出当成插件加载一遍
  const fns = Object.values(mod).filter((v) => typeof v === 'function')
  assert.ok(fns.length > 0, 'index.mjs 必须导出插件函数')
  const client = {
    app: { log: async () => {} },
    auth: { set: async () => {}, get: async () => undefined, list: async () => [] },
    tui: { showToast: async () => {} },
    config: { get: async () => ({ data: {} }) },
  }
  for (const fn of fns) {
    await fn({ client, directory: join(home, '.config', 'magpie'), worktree: ROOT, $: undefined, project: {} }, { notify: false })
  }
  await new Promise((r) => setTimeout(r, 400))

  assert.equal(statSync(marketPath).mtimeMs, before, '加载插件绝不能写 magpie 的市场缓存')
  assert.equal(readFileSync(marketPath, 'utf8'), seed, '内容也必须一字不改')
})

test('红线④：加载插件不往 magpie 的配置目录写任何凭据文件', async () => {
  const home = process.env.HOME ?? process.env.USERPROFILE
  const configDir = join(home, '.config', 'magpie')
  mkdirSync(configDir, { recursive: true })
  const before = new Set(readdirSync(configDir))

  const { makeHubPlugin, REGISTERED_CHANNELS } = await import(new URL('../src/aggregate.mjs', import.meta.url).href)
  const client = {
    app: { log: async () => {} },
    auth: { set: async () => {}, get: async () => undefined },
    tui: { showToast: async () => {} },
    config: { get: async () => ({ data: {} }) },
  }
  for (const channel of REGISTERED_CHANNELS) {
    const plugin = await makeHubPlugin(channel)({ client, directory: configDir }, { notify: false, migrateLegacySlots: false })
    const cfg = {}
    await plugin.config(cfg)
    await plugin.provider.models({ models: {} })
  }
  await new Promise((r) => setTimeout(r, 200))

  const after = readdirSync(configDir)
  const created = after.filter((f) => !before.has(f))
  assert.deepEqual(created, [], `插件不得在 magpie 的配置目录里新建文件，实际新建了：${created.join(', ')}`)
})

test('红线⑤：读账号槽只读本插件自己的槽（别人的 token 不进内存）', async () => {
  const home = process.env.HOME ?? process.env.USERPROFILE
  const authPath = process.env.DSH_HUB_AUTH_PATH ?? join(home, '.config', 'magpie', 'plugin-auth.json')
  mkdirSync(join(home, '.config', 'magpie'), { recursive: true })
  writeFileSync(authPath, JSON.stringify({
    // 别的插件的槽 —— 里面有别人的 token
    'someone-elses-provider': { type: 'oauth', access_token: 'OTHER_PLUGIN_SECRET_TOKEN' },
    // 我们自己的槽
    'hub-astudio': { type: 'success', channel: 'astudio', accountId: 'tester', access_token: 'OURS' },
  }), 'utf8')

  const { readOwnAuthEntries } = await import(new URL('../src/shared.mjs', import.meta.url).href)
  const entries = readOwnAuthEntries()
  assert.deepEqual(entries.map((e) => e.key), ['hub-astudio'], '只该返回本插件的槽')
  const serialized = JSON.stringify(entries)
  assert.equal(serialized.includes('OTHER_PLUGIN_SECRET_TOKEN'), false, '别人的 token 不许进返回对象')
  assert.equal('value' in entries[0], false, '不需要值时不保留 auth 内容（withValue 才给）')

  // 快照也不能泄漏别人的 token
  const { _internal } = await import(new URL('../src/aggregate.mjs', import.meta.url).href)
  _internal.enableSnapshotWrites()
  await _internal.sweepAllChannels()
  const snap = readFileSync(process.env.DSH_HUB_SNAPSHOT_PATH, 'utf8')
  assert.equal(snap.includes('OTHER_PLUGIN_SECRET_TOKEN'), false, '快照不得带上别人的凭据')
})

test('自注册能力仍在仓库里（tools/），只是不随包发布', () => {
  assert.equal(existsSync(join(ROOT, 'tools', 'self-register.mjs')), true)
  const runner = readFileSync(join(ROOT, 'tools', 'register-local.mjs'), 'utf8')
  assert.match(runner, /magpie-providers-hub/)
  // 条目只列保留的五条（与社区 registry 不重叠的）
  for (const id of ['hub-astudio', 'hub-accio', 'hub-lobsterai', 'hub-magicrew', 'hub-magicrew-intl']) {
    assert.ok(runner.includes(`'${id}'`), `条目该带 ${id}`)
  }
  // 已删除的五条渠道不许再出现在条目里
  for (const id of ['hub-officeace', 'hub-autoclaw', 'hub-loomy', 'hub-minimaxintl']) {
    assert.equal(runner.includes(`'${id}'`), false, `已删渠道 ${id} 不该进条目`)
  }
})
