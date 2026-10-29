/**
 * 社区 registry 审核的硬门槛（MYCF711 的 officeace-auth #399 在 2026-10-27 被 block
 * 的原话）：插件**不得在加载/运行时改写 magpie 的宿主文件** —— 审核的 grep 标准是
 * 「no fs writes, child_process, eval or HOME/cache paths」，特指
 * `~/.cache/magpie/plugin-market.json`（magpie 的市场缓存）。
 *
 * 2026-10-30 我们把自注册整个移出发布包（`src/self-register.mjs` → `tools/`），
 * 这个文件的用例就是那条红线的回归网：
 *   ① 源码里不再出现 plugin-market.json；
 *   ② 发布清单不含 tools/ 与 tests/；
 *   ③ **真加载一次插件，市场缓存文件的 mtime 与内容零变化**（审核同款探针）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 必须走 fileURLToPath：URL.pathname 是百分号编码的，中文路径下会 scandir 不到
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const published = ['index.mjs', ...readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => join('src', f))]

test('红线①：发布代码里不出现 magpie 的市场缓存文件', () => {
  for (const rel of published) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert.doesNotMatch(text, /plugin-market\.json/,
      `${rel} 不得引用 magpie 的市场缓存 —— 审核会直接 block（officeace-auth #399 先例）`)
  }
  assert.equal(existsSync(join(ROOT, 'src', 'self-register.mjs')), false,
    '自注册模块必须留在 tools/（仓库内手工工具），不能进 src/')
})

test('红线①之二：登录用的临时 profile 也不落 magpie 的缓存目录', () => {
  // 曾经写在 ~/.cache/magpie（magpie 自己的缓存目录）下 —— 属于「动宿主地盘」。
  const browser = readFileSync(join(ROOT, 'src', 'magicrew-browser.mjs'), 'utf8')
  assert.doesNotMatch(browser, /from 'node:os'[\s\S]{0,40}homedir/, '登录浏览器不该再碰 homedir')
  assert.doesNotMatch(browser, /join\(homedir\(\)/, '临时 profile 不许落在 home 下')
  assert.match(browser, /tmpdir\(\)/, '临时 profile 走系统临时目录')
  // 只读地盘可以留：magicrew 读 magpie 的 models.json 作兜底（只读，不写）
  const magicrew = readFileSync(join(ROOT, 'src', 'magicrew.mjs'), 'utf8')
  assert.doesNotMatch(magicrew, /writeFileSync\([^)]*\.cache/, 'magpie 的缓存目录只读不写')
})

test('红线①之三：诊断日志默认不写 magpie 的目录（DSH_HUB_DEBUG=1 才写）', async () => {
  const { debugLog } = await import(new URL('../src/shared.mjs', import.meta.url).href)
  const home = process.env.HOME ?? process.env.USERPROFILE
  const logPath = join(home, '.config', 'magpie', 'notify-debug.log')
  const had = existsSync(logPath)
  const saved = process.env.DSH_HUB_DEBUG
  try {
    delete process.env.DSH_HUB_DEBUG
    debugLog('probe: 默认不该落盘')
    assert.equal(existsSync(logPath), had, '默认绝不能往 magpie 的目录里写日志')
    process.env.DSH_HUB_DEBUG = '1'
    debugLog('probe: 开了开关才写')
    assert.equal(existsSync(logPath), true, 'DSH_HUB_DEBUG=1 时应当写（排查用）')
  } finally {
    if (saved === undefined) delete process.env.DSH_HUB_DEBUG
    else process.env.DSH_HUB_DEBUG = saved
    try { rmSync(logPath, { force: true }) } catch { /* 沙箱里删不掉无所谓 */ }
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
  // 像 magpie 那样把每个函数导出当成插件加载一遍（这里取前两个，覆盖工厂全部副作用）
  const fns = Object.values(mod).filter((v) => typeof v === 'function').slice(0, 2)
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
  await new Promise((r) => setTimeout(r, 400)) // 自注册即便有延迟也会在这一段里落盘

  assert.equal(statSync(marketPath).mtimeMs, before, '加载插件绝不能写 magpie 的市场缓存')
  assert.equal(readFileSync(marketPath, 'utf8'), seed, '内容也必须一字不改')
})

test('自注册能力仍在仓库里（tools/），只是不随包发布', () => {
  assert.equal(existsSync(join(ROOT, 'tools', 'self-register.mjs')), true)
  const runner = readFileSync(join(ROOT, 'tools', 'register-local.mjs'), 'utf8')
  assert.match(runner, /magpie-providers-hub/)
  assert.match(runner, /hub-officeace/, 'runner 要带上十个 provider id')
})
