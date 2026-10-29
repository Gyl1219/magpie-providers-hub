// magicrew 浏览器登录模块：本机可测的部分（找浏览器、profile 目录、清理）。
// CDP 真机部分（拉起浏览器 / WebSocket 读 localStorage）不在单测覆盖。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../src/magicrew-browser.mjs')

const basename = (p) => p.split(/[\\/]/).pop()

// ⚠️ profile 落点 2026-10-30 从 ~/.cache/magpie 挪到系统临时目录（不碰 magpie 的缓存）
const PROFILE_BASE = join(tmpdir(), 'magpie-providers-hub-login')

test('导出契约完整', () => {
  for (const fn of ['findBrowser', 'newProfileDir', 'sweepProfiles', 'launchLoginBrowser', 'waitForCreds', 'closeSession']) {
    assert.equal(typeof mod[fn], 'function', `缺 ${fn}`)
  }
})

test('findBrowser 返回 null 或一个浏览器路径（不抛错）', () => {
  const exe = mod.findBrowser()
  assert.ok(exe === null || typeof exe === 'string', `findBrowser 返回异常：${exe}`)
  if (process.platform === 'win32' && exe) {
    assert.match(exe, /chrome|msedge|brave/i)
  }
})

test('newProfileDir 生成一次性目录且以 magicrew-login- 开头', () => {
  const a = mod.newProfileDir()
  const b = mod.newProfileDir()
  assert.ok(existsSync(a), '目录应被创建')
  assert.match(basename(a), /^magicrew-login-/)
  assert.notEqual(a, b, '两次应不同（一次性）')
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('sweepProfiles：删过期的一次性 profile 目录，不碰同前缀文件', () => {
  const base = PROFILE_BASE
  mkdirSync(base, { recursive: true })
  const oldDir = join(base, `magicrew-login-test-old-${process.pid}-${Date.now()}`)
  mkdirSync(oldDir, { recursive: true })
  const threeHoursAgo = new Date(Date.now() - 3 * 3600_000)
  utimesSync(oldDir, threeHoursAgo, threeHoursAgo)
  const keepFile = join(base, `magicrew-login-keepfile-${Date.now()}.log`)
  writeFileSync(keepFile, 'not a profile')
  try {
    assert.ok(existsSync(oldDir))
    mod.sweepProfiles({ maxAgeMs: 2 * 3600_000 })
    assert.equal(existsSync(oldDir), false, '过期 profile 应被删')
    assert.equal(existsSync(keepFile), true, '同前缀普通文件不该被删')
  } finally {
    rmSync(oldDir, { recursive: true, force: true })
    rmSync(keepFile, { force: true })
  }
})
