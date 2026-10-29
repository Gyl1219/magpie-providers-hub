// magicrew 浏览器登录：自己拉起一个 Chromium（独立一次性 profile + 远程调试端口），
// 用户在窗口里正常登录（微信/手机/Google/邮箱/飞书都行），登录完在页面上下文里
// 用 CDP 读 localStorage 拿 JWT + 组织码，然后关窗删 profile。
//
// ═══ 为什么必须自己拉浏览器 ═══════════════════════════════════════════
// magicrew 没有 OAuth 回调通道 —— 「官方页面登录完插件自动拿到 token」只有一条路：
// 浏览器得是插件能看进去的那个。系统默认实例没有调试端口，读不到它的 localStorage。
//
// ⚠ 每次登录一个**一次性** profile，用完删：复用目录里的 localStorage 还躺着
//   上一个账号的 jwt，浏览器一开就会被读到 → 判定「登录完成」→ 关窗 →
//   拿到的是旧账号。一次性目录把这条路堵死。
//
// ⚠ 本机必须有 Chrome / Edge / Brave / Chromium 之一（headful，非 headless）。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 一次性 Chromium profile 的落点。
 *
 * ⚠️ 2026-10-30 从 `~/.cache/magpie` 挪到系统临时目录：社区 registry 的审核 grep
 *    含「HOME/cache paths」（officeace-auth #399 因宿主缓存写入被 block 的同一条标准），
 *    登录用的临时 profile 放进 magpie 自己的缓存目录属于「动宿主地盘」。
 *    系统临时目录语义上就是给一次性文件用的，且 sweep 仍只删本插件造的
 *    `magicrew-login-*` 目录名。
 */
const BASE = () => join(tmpdir(), 'magpie-providers-hub-login')

/** 找本机 Chromium 内核浏览器。 */
export function findBrowser() {
  const plat = process.platform
  const candidates =
    plat === 'win32'
      ? [
          join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        ]
      : plat === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
            '/snap/bin/chromium',
          ]
  for (const p of candidates) {
    try { if (p && existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

/** 一次性 profile 目录（插件自己的名字，便于 sweep 识别）。 */
export function newProfileDir() {
  const d = join(BASE(), `magicrew-login-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** 清残留：过期的 magicrew-login-* 一次性 profile（只删本插件造的目录名）。 */
export function sweepProfiles({ maxAgeMs = 2 * 3600_000 } = {}) {
  let names = []
  try { names = readdirSync(BASE()) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!/^magicrew-login-/.test(name)) continue
    const p = join(BASE(), name)
    try {
      const st = statSync(p)
      if (!st.isDirectory()) continue
      if (Date.now() - st.mtimeMs < maxAgeMs) continue
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      removed++
    } catch { /* ignore */ }
  }
  return removed
}

/** 等 Chromium 写出 DevToolsActivePort（第一行端口）。 */
async function waitPort(dir, timeoutMs = 8_000) {
  const f = join(dir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const line = readFileSync(f, 'utf8').split('\n')[0].trim()
      const port = Number(line)
      if (port > 0) return port
    } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return 0
}

/** 列出调试端口上的页面 target。 */
async function listPages(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(4000) })
  return (await r.json()) ?? []
}

/** 挑一个处于登录域名下的页面 target（别退回 about:blank —— 它会抛 SecurityError）。 */
async function pickLoginPage(port, hostFragment) {
  const pages = (await listPages(port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pages.length) return null
  return pages.find((p) => String(p.url || '').includes(hostFragment)) ?? null
}

/** 在页面上下文里求值一次（返回字符串）。 */
async function evaluate(port, hostFragment, expression, timeoutMs = 8000) {
  const page = await pickLoginPage(port, hostFragment)
  if (!page) throw new Error('没有可用的登录页 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() })
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`CDP 连接失败：${e?.message ?? e}`)) })
  })
  try {
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 求值超时')), timeoutMs)
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id !== 1) return
        clearTimeout(t)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      })
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (reply?.exceptionDetails) return ''
    return reply?.result?.value ?? ''
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
}

/** 从页面 localStorage 取 jwt + 组织码 + 显示名（一次求值）。 */
const READ_CREDS = `(() => {
  const raw = (k) => { try { return localStorage.getItem(k) || "" } catch { return "" } }
  const pick = (k) => {
    const s = raw(k)
    if (!s) return ""
    try { const o = JSON.parse(s); return typeof o === "object" && o ? String(o.value ?? "") : String(s) } catch { return s }
  }
  const obj = (k) => {
    try { const o = JSON.parse(raw(k)); return (o && typeof o === "object" ? (o.value ?? o) : null) || null } catch { return null }
  }
  const jwt = pick("MAGIC:user:authorization")
  const org = pick("MAGIC:user:organizationCode")
  if (!jwt || !jwt.startsWith("eyJ") || !org) return ""
  const ui = obj("MAGIC:user:userInfo") || {}
  const name = String(ui.phone || ui.email || ui.nickname || ui.real_name || "")
  return JSON.stringify({ jwt, org, name })
})()`

/**
 * 拉起浏览器打开登录页。
 * @returns {Promise<{port:number, dir:string, child:import('node:child_process').ChildProcess}>}
 */
export async function launchLoginBrowser(url) {
  const exe = findBrowser()
  if (!exe) throw new Error('本机没找到 Chrome / Edge / Brave / Chromium（浏览器登录需要其中之一）')
  sweepProfiles()
  const dir = newProfileDir()
  // 清掉可能让新进程「看起来起来、其实没动」的残留文件
  for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
  }
  let child
  try {
    child = spawn(
      exe,
      [
        `--user-data-dir=${dir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        '--disable-background-networking',
        url,
      ],
      { stdio: 'ignore', detached: false, windowsHide: false },
    )
  } catch (e) {
    throw new Error(`浏览器启动失败：${e?.message ?? e}`)
  }
  const port = await waitPort(dir)
  if (!port) {
    try { child.kill() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }) } catch { /* ignore */ }
    throw new Error('浏览器起来了但 8 秒内没写出调试端口（可能被安全软件拦了远程调试）')
  }
  return { port, dir, child }
}

/**
 * 轮询读凭据，直到拿到（且与 baseline 不同）或超时。
 * @param {{port:number}} session
 * @param {string} hostFragment  登录页 URL 里应包含的片段（用于挑 target）
 */
export async function waitForCreds(session, hostFragment, { timeout = 300_000, interval = 1500, baseline = null } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const raw = await evaluate(session.port, hostFragment, READ_CREDS)
      if (raw) {
        const o = JSON.parse(raw)
        if (o?.jwt?.startsWith('eyJ') && o?.org) {
          const same = baseline && o.jwt === baseline.jwt && o.org === baseline.org
          if (!same) return o
        }
      }
    } catch { /* 页面还在加载 / target 换了 —— 下一轮再试 */ }
    await new Promise((r) => setTimeout(r, interval))
  }
  return null
}

/** 关浏览器（先 Browser.close，再兜底 taskkill 整棵进程树），然后删 profile。 */
export async function closeSession(session) {
  if (!session) return
  try {
    const r = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(3000) })
    const v = await r.json()
    if (v?.webSocketDebuggerUrl) {
      await new Promise((resolve) => {
        const ws = new WebSocket(v.webSocketDebuggerUrl)
        const done = () => { try { ws.close() } catch { /* ignore */ } ; resolve() }
        const t = setTimeout(done, 2000)
        ws.addEventListener('open', () => {
          try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })) } catch { /* ignore */ }
          setTimeout(() => { clearTimeout(t); done() }, 600)
        }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(t); done() }, { once: true })
      })
    }
  } catch { /* ignore */ }
  const pid = session.child?.pid
  if (pid) {
    try {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          k.on('exit', resolve); k.on('error', resolve); setTimeout(resolve, 3000)
        })
      } else {
        try { session.child.kill('SIGKILL') } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  const dir = session.dir
  if (!dir) return
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch { await new Promise((r) => setTimeout(r, 300)) }
  }
}
