// 载体页门禁：内联 <script> 必须能被 JS 引擎解析。
//
// 页面 JS 藏在 .mjs 的模板串里，node --check 查不到 —— 上一版就因为
// 残留的 `};` 与对已删函数 loadGee() 的调用让整个 script 挂掉，
// 症状是「所有按钮点不动」（用户实测报障）。此测试从源头拦住这类回归：
// 语法错 / 引用不存在的顶层函数（在解析期不报，运行期报 —— 故补一轮
// 语法解析 + 静态函数名自检）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderLoginPage } from '../src/astudio.mjs'

const page = renderLoginPage()

test('页面是完整 HTML 且包含全部交互元素', () => {
  assert.match(page, /<!doctype html>/i)
  assert.match(page, /<\/html>$/)
  for (const id of ['captcha', 'captchaBox', 'mobile', 'send', 'code', 'go', 'msg']) {
    assert.ok(page.includes(`id="${id}"`), `缺少 #${id}`)
  }
})

test('内联 script 能被 JS 引擎解析（按钮全挂的根因门禁）', () => {
  const match = page.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, '页面没有 <script>')
  // 只做解析（new Function 编译不执行），语法错在这里抛
  assert.doesNotThrow(() => new Function(match[1]))
})

test('script 里调用的顶层函数都有定义（loadGee 残留调用的门禁）', () => {
  const raw = page.match(/<script>([\s\S]*?)<\/script>/)[1]
  // 剥注释（注释里的「verify()」之类字样不是调用）
  const script = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // 抽出「标识符(」的调用点（排除语言关键字/浏览器 API/已定义名）
  const browserApi = new Set(['fetch', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'Promise', 'Error', 'String', 'Object', 'document', 'window'])
  const defined = new Set()
  // 顶层与块内的 function 声明 + const/let 赋函数
  for (const m of script.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
  for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1])
  for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|;|,|\))/g)) defined.add(m[1])
  for (const m of script.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'async', 'typeof'].includes(name)) continue
    if (browserApi.has(name) || defined.has(name)) continue
    // 剩下的必须是链式调用（如 document.getElementById）—— 独立裸调用即未定义
    const before = script.slice(Math.max(0, m.index - 1), m.index)
    if (before === '.' || before === '_') continue // o.verify() 之类成员调用
    assert.ok(defined.has(name) || browserApi.has(name),
      `script 调用了未定义的顶层函数 ${name}()（loadGee 残留型回归）`)
  }
})
