// Providers Hub 侧边栏页面门禁。
//
// 两件事最怕回归：
// ① 页面 JS 语法错 / 引用了不存在的函数（普通 <script> 里任何一处抛错 → 整页「已停止工作」，
//    与 astudio 载体页「按钮点不动」同型）；
// ② 快照里漏出凭据（快照是被宿主写到磁盘、页面可读的明文文件）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('分档不由页面按名字猜（真机 bug：OfficeAce 桶名不含档位字样会全变灰）', () => {
  const app = read('page/app.js')
  // 页面必须读宿主算好的 b.band
  assert.match(app, /b\.band/, '页面应读宿主算出的 band')
  // 页面不得自己拿名字去 indexOf 档位字样
  assert.doesNotMatch(app, /name\.indexOf\("临期"\)/, '页面不该按名字猜档位')
})

test('页面不自带主题：不写背景/字体族/字号，颜色只取 --magpie-* 变量', () => {
  const html = read('page/index.html')
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  // bridge 注入 :where() 零权重样式表（字体/颜色/标题/按钮/表格），页面不该覆盖它
  for (const forbidden of [/font-family\s*:/i, /^\s*body\s*\{/m, /background\s*:/i, /prefers-color-scheme/i]) {
    assert.doesNotMatch(style, forbidden, `页面不该自带主题样式：${forbidden}`)
  }
  // 要写颜色就必须用 magpie 的主题变量（深浅色自动跟随），不许硬编码 hex
  const hexes = style.match(/#[0-9a-f]{3,8}\b/gi) ?? []
  const varColors = style.match(/var\(--magpie-[a-z0-9-]+/gi) ?? []
  assert.ok(hexes.length === 0 || varColors.length > 0,
    `颜色应取 var(--magpie-*)，发现硬编码：${hexes.join(', ')}`)
  // 硬编码 hex 只允许出现在 var() 的兜底位（var(--x, #fff)）
  for (const m of style.matchAll(/(?<!var\([^)]*)#[0-9a-f]{3,8}\b/gi)) {
    const before = style.slice(Math.max(0, m.index - 60), m.index)
    assert.ok(/var\(--magpie-[a-z0-9-]+,\s*$/.test(before), `硬编码颜色 ${m[0]} 不在 var() 兜底位`)
  }
})

test('package.json 声明了侧边栏页面，文件存在', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.magpie, '缺 magpie 段')
  assert.ok(pkg.magpie.page, '缺 magpie.page（侧边栏入口）')
  assert.equal(pkg.magpie.page.file, 'page/index.html')
  assert.ok(pkg.magpie.page.title)
  // 声明指向的文件真实存在
  assert.ok(read('page/index.html').length > 0)
  assert.ok(pkg.files.includes('page'), 'files 必须包含 page，否则发布不带页面')
})

test('index.html 引用 bridge/snapshot/app 三个脚本', () => {
  const html = read('page/index.html')
  assert.match(html, /<script src="_magpie\/bridge\.js"><\/script>/, '缺 bridge.js（否则 magpie 未定义）')
  assert.match(html, /<script src="snapshot\.js"><\/script>/)
  assert.match(html, /<script src="app\.js"[^>]*><\/script>/)
})

test('页面 JS 语法可解析；普通脚本不能有顶层 await', () => {
  const app = read('page/app.js')
  assert.doesNotThrow(() => new Function(app), 'app.js 语法错误会让整页失效')
  // 顶层 await = 行首（无缩进）的 await（jethub 踩过：普通 <script> 里是语法错误）
  assert.doesNotMatch(app, /^await\s/m, '普通 <script> 里不能用顶层 await')
})

test('app.js 不联网（沙盒没有 fetch）', () => {
  const app = read('page/app.js')
  assert.doesNotMatch(app, /\bfetch\s*\(/, '页面沙盒 connect-src none：不能 fetch')
  assert.doesNotMatch(app, /XMLHttpRequest/, '页面沙盒不能用 XHR')
})

test('侧栏页列全十条：未登录排前面 + 给出登录命令（供应商页会折叠未登录项）', () => {
  // 真机报障：magpie 供应商页只显示已登录的，用户以为插件只注册了 5 个渠道。
  // 侧栏页是唯一一定列全的地方 —— 未登录的必须排前面，并给出可直接执行的命令。
  const app = read('page/app.js')
  assert.match(app, /sort\(/, '渠道必须排序（未登录的顶上去）')
  assert.match(app, /Number\(Boolean\(a\.signedIn\)\)/, '排序键是 signedIn')
  assert.match(app, /magpie plugin login /, '操作列要给出登录命令')
  assert.match(app, /ch\.provider/, '命令里用 provider id（快照字段），不硬编码')
})

test('页面引用的 DOM id 都在 index.html 里存在', () => {
  const html = read('page/index.html')
  const app = read('page/app.js')
  const ids = new Set()
  for (const m of app.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(m[1])
  // 动态创建的 id（脚本里 .id = "..." 赋值）不在静态 HTML 里，跳过
  const dynamic = new Set()
  for (const m of app.matchAll(/\.id\s*=\s*"([^"]+)"/g)) dynamic.add(m[1])
  for (const id of ids) {
    if (dynamic.has(id)) continue
    assert.ok(html.includes(`id="${id}"`), `app.js 取了 #${id}，但 index.html 里没有`)
  }
})

test('快照模块：写入内容绝不含凭据（token/secret/ak/sk）', async () => {
  // 用假凭据驱动一次 usage/models，再读写出的 snapshot.js 检查。
  // ⚠️ 快照路径用 env 重定向到临时文件 —— 测试绝不能碰真实的 page/snapshot.js
  //（真机事故：测试跑在沙箱 HOME 里把真实快照覆盖成「全部未登录」）。
  const sandbox = mkdtempSync(join(tmpdir(), 'hub-page-'))
  const snapPath = join(sandbox, 'snapshot-test.js')
  process.env.DSH_HUB_SNAPSHOT_PATH = snapPath
  const home = process.env.USERPROFILE
  process.env.USERPROFILE = sandbox
  process.env.HOME = sandbox
  try {
    // ⚠️ v0.5.0 起**没有旁路凭据文件**：凭据只在本进程内存缓存（`memoryCredentials`）。
    // 这里用 `_internal.rememberCredential` 模拟登录态。
    const { HUB_PLUGINS } = await import('../index.mjs')
    const { _internal } = await import('../src/aggregate.mjs')
    _internal.rememberCredential({ id: 'astudio' }, {
      access: 'SECRET_ACCESS_TOKEN_SHOULD_NOT_LEAK',
      refresh_token: 'SECRET_REFRESH_TOKEN_SHOULD_NOT_LEAK',
      accessKeyId: 'SECRET_AK_SHOULD_NOT_LEAK',
      secretAccessKey: 'SECRET_SK_SHOULD_NOT_LEAK',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const plugin = await HUB_PLUGINS.HubAStudioPlugin({}, {})
    await plugin.config({})
    // 触发 provider.models（会写快照）—— 用临时 provider.props 空对象
    await plugin.provider.models({ models: {} })
    const snap = readFileSync(snapPath, 'utf8')
    for (const secret of [
      'SECRET_ACCESS_TOKEN_SHOULD_NOT_LEAK',
      'SECRET_REFRESH_TOKEN_SHOULD_NOT_LEAK',
      'SECRET_AK_SHOULD_NOT_LEAK',
      'SECRET_SK_SHOULD_NOT_LEAK',
    ]) {
      assert.ok(!snap.includes(secret), `快照泄漏了凭据：${secret}`)
    }
    assert.match(snap, /window\.__PROVIDERS_HUB_SNAPSHOT__\s*=/, '快照应写入全局变量')
    // 结构健全：含 channels 数组
    const body = snap.replace(/^window\.__PROVIDERS_HUB_SNAPSHOT__\s*=\s*/, '').replace(/;\s*$/, '')
    const obj = JSON.parse(body)
    assert.ok(Array.isArray(obj.channels))
    assert.equal(obj.channels.length, 5, 'v0.5.0 起只有五条渠道')
    // 每条渠道都标着自己的供应商 id（页面上「关掉哪个会关掉它」）
    assert.ok(obj.channels.every((c) => typeof c.provider === 'string' && c.provider.startsWith('hub-')),
      `渠道行缺 provider 字段：${JSON.stringify(obj.channels.map((c) => c.provider))}`)
  } finally {
    delete process.env.DSH_HUB_SNAPSHOT_PATH
    process.env.USERPROFILE = home
    if (home === undefined) delete process.env.USERPROFILE
    rmSync(sandbox, { recursive: true, force: true })
  }
})
