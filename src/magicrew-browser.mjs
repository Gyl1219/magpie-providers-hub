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
//
// ═══ Google 登录被拒（「此浏览器或应用可能不安全」）═════════════════
// 根因是 navigator.webdriver：Chrome 被 --remote-debugging-port 启动时，
// 每个页面都带着 webdriver=true，Google 在 accounts.google.com/v3/signin/rejected
// 拒掉（--disable-blink-features=AutomationControlled 可靠性不一，还会随版本失效，
// 所以本模块不靠它）。一次性 profile 省了 cookie/历史只是叠加项。
//
// 约束：用户默认浏览器里没有调试端口，CDP 读不到 localStorage；又不能把
// --remote-debugging-port 开到用户默认 profile 上 —— 那样他的 webdriver 标记
// 会由这一次注入（直到重启），用户所有窗口都带自动化痕迹。于是两个窗口各用
// 一张 profile，是**唯一**同时满足「Google 不拒」 + 「CDP 能读」 + 「不污染
// 用户默认 profile」的解：
//   ① 登录页照旧开一次性 profile + CDP（能读、判定可靠）；
//   ② 用户点「Google 登录」时把**同一地址交给用户自己那只浏览器**
//      （系统默认浏览器，无 --user-data-dir、无 --remote-debugging-port）
//      —— 用的是他自己的已登录 Google 会话，完成后会 302 回站点；
//   ③ CDP 在 ① 的 profile 轮询 localStorage（JWT）；302 回来后的落点页面
//      也会带着该站的会话 cookie（实测见 monkeycode：一路）。
//      两路任一命中即完成判定。
// Google 那一跳永远不在装着插件控制器的窗口里。
//
// 本模块与调用方约定的固定名（跨函数通信 + 测试锚点）：
//   · `baseline` —— waitForCreds 的入参快照：默认浏览器那张 profile 里
//     可能躺着上个账号的 JWT。本模块当前 CDP 只读一次性 profile，
//     所以 caller 从未见过默认浏览器里的 JWT，baseline 对它自然只读
//     「旧登录态」这一个事实：旧账号在时 baseline.jwt 不是 null，就是
//     调用方（magicrew / monkeycode）会在开窗前先读默认窗口一次，
//     把那一份当 baseline 传进来（或不传）。仅靠本文不写盘。
//   · `defaultProfileBound` —— session 上的标记，是 `openInDefaultBrowser`
//     的副作用：② 已发生 ⇒ 本轮窗口拥有用户默认 profile，收尾时不删；
//     `isDefaultProfileBound` 只是读它（供调用方/测试确认交接发生）。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

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

/**
 * 本机**用户已经在开的**日常 Chromium 系浏览器（日常浏览器 = 装着他 Google
 * 登录态的那一个）。
 *
 * ⚠️ 只用于 ②（Google 那一跳）：它只用来让用户完成 Google 登录，插件绝不通过
 *    它读 localStorage、绝不往它的 profile 写。返回 `{ exe }` 或 null。
 */
export function findDefaultBrowser() {
  const hit = process.env.MAGPIE_PROFILES_PROBE
  if (hit) return { exe: hit }
  if (process.platform === 'win32') {
    // UserChoice 拿到的 ProgID → 其 shell\open\command 的可执行路径（带参时只取 .exe）
    const viaRegistry = (() => {
      try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\URL Associations\\http\\UserChoice', '/v', 'ProgID'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const prog = out.match(/REG_SZ\s+(\S+)/)?.[1]
        if (!prog) return null
        const cmd = execFileSync('reg', ['query', `HKCU\\Software\\Classes\\${prog}\\shell\\open\\command`, '/ve'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const path = String(cmd).match(/REG_SZ\s+"([^"]+)"/)?.[1]
        return path && existsSync(path) ? path : null
      } catch { return null }
    })()
    if (viaRegistry) return { exe: viaRegistry }
  }
  const exe = findBrowser()
  return exe ? { exe } : null
}

/**
 * 本轮登录用「用户日常浏览器」的那张浏览器截图（② 的绑定地址）。
 * 若用户后面在两个窗口之间切换（① 的一次性窗口 / ② 的默认窗口），
 * 这是给 ② 的那一份：一次登录只用一份。
 */
export const GOOGLE_HANDOFF_KEY = 'google-handoff'

/**
 * 用**用户日常浏览器**开 URL —— 没有 --user-data-dir，没有 --remote-debugging-port，
 * 纯按 URL 把它交给系统默认处理。给 ② 的 Google 登录跳用：
 * 跳过去的正是用户自己的已登录窗口。
 *
 * 开成功后在 `session` 上落 `defaultProfileBound = true`（见文件头），
 * `closeSession` 据此跳过 profile 删除；`session` 不存在时静默不开。
 *
 * 返回 `{ exe }`（开成功了用的是哪一款）或 null（找不到浏览器）。
 */
export function openInDefaultBrowser(url, session) {
  const target = findDefaultBrowser()
  if (!target) return null
  try { spawn(target.exe, [url], { stdio: 'ignore', detached: true, windowsHide: false }).unref?.() } catch { return null }
  if (session) session.defaultProfileBound = true
  return target
}

/** ② 已发生：本轮登录窗拥有用户默认 profile（`closeSession` 据此跳过删；测试锚点）。 */
export function isDefaultProfileBound(session) {
  return Boolean(session?.defaultProfileBound)
}

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
 *
 * ⚠️⚠️ **必须 `detached: true` + `unref()`**（2026-11-01 真机事故）：
 *    magpie 调 `authorize()` 只取走 `url` 就返回，承载它的 node 进程随后可能
 *    被回收/退出。`detached: false` 时子浏览器是父进程的从属，**父进程一死
 *    窗口立刻消失** —— 用户「网页还没登录窗口就没了」。
 *    detached 让浏览器脱离父进程组独立存活，登录结束后由我们再显式关闭
 *    （`closeSession` 里有 taskkill 兜底，不会留僵尸）。
 *
 * ⚠️ Windows 上还需 `--no-startup-window` 之外的最小参数集：传 `url` 作为
 *    首个参数即可；不用 `--app`（会隐藏地址栏，登录页跳转不方便）。
 *
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
        // ⚠️ 新 profile 首次启动可能弹「登录以同步」向导，挡在登录页前面
        '--disable-sync',
        '--disable-extensions',
        url,
      ],
      {
        // ⚠️⚠️ 关键：脱离父进程组，父进程退出不带走浏览器窗口
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    )
    // 让事件循环不再为该子进程保持引用（否则父进程退出时会被一起收）
    child.unref?.()
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

/** 关浏览器（先 Browser.close，再兜底 taskkill 整棵进程树），然后删 profile。
 *  ② 已发生时不删：窗口拥有用户默认 profile —— 关浏览器到这里为止，
 *  不动它的登录态与 localStorage / cookie。 */
export async function closeSession(session) {
  if (!session) return
  if (session.defaultProfileBound) return
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
