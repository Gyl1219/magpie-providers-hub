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

test('页面引用的 DOM id 都在 index.html 里存在', () => {
  const html = read('page/index.html')
  const app = read('page/app.js')
  const ids = new Set()
  for (const m of app.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(m[1])
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `app.js 取了 #${id}，但 index.html 里没有`)
  }
})

test('快照模块：写入内容绝不含凭据（token/secret/ak/sk）', async () => {
  // 用假凭据驱动一次 usage/models，再读写出的 snapshot.js 检查
  const sandbox = mkdtempSync(join(tmpdir(), 'hub-page-'))
  const home = process.env.USERPROFILE
  process.env.USERPROFILE = sandbox
  process.env.HOME = sandbox
  try {
    const { saveCredential } = await import('../src/shared.mjs')
    // 造一份含敏感字段的凭据（模拟各渠道真实形状）
    saveCredential('officeace', {
      access: 'SECRET_ACCESS_TOKEN_SHOULD_NOT_LEAK',
      refresh_token: 'SECRET_REFRESH_TOKEN_SHOULD_NOT_LEAK',
      accessKeyId: 'SECRET_AK_SHOULD_NOT_LEAK',
      secretAccessKey: 'SECRET_SK_SHOULD_NOT_LEAK',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const { DshProvidersHubPlugin } = await import('../index.mjs')
    const plugin = await DshProvidersHubPlugin({}, {})
    await plugin.config({})
    // 触发 provider.models（会写快照）—— 用临时 provider.props 空对象
    await plugin.provider.models({ models: {} })
    const snap = read('page/snapshot.js')
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
    assert.ok(obj.channels.length >= 5, '应含全部渠道')
  } finally {
    process.env.USERPROFILE = home
    if (home === undefined) delete process.env.USERPROFILE
    rmSync(sandbox, { recursive: true, force: true })
  }
})
