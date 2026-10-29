// 自注册：把本插件写进 magpie 的市场缓存
//
// ⚠ 本文件移植自 MYCF711/magpie-plugin-template（MIT）：
//   https://github.com/MYCF711/magpie-plugin-template/blob/main/src/self-register.mjs
//   实测依据（缓存只启动时重写、写一次即稳、并发合并）均出自该作者的取证，
//   以下正文除本头注释外逐字保留。
// 自注册：把本插件写进 magpie 的市场缓存
//
// ═══════════════════════════════════════════════════════════════════
// 问题
// ═══════════════════════════════════════════════════════════════════
//
// magpie 的插件卡片上，「源码」按钮和卡片标题来自
// ~/.cache/magpie/plugin-market.json —— magpie 的社区插件列表缓存。
//
// 包不在那个列表里 ⇒ 卡片标题退回包名，没有源码按钮。
//
// ═══════════════════════════════════════════════════════════════════
// 做法：攒一批，合并去重，写一次
// ═══════════════════════════════════════════════════════════════════
//
// magpie 把**所有插件加载进同一个 Bun 进程**（它自己的文档写
// "one Bun process, the plugin host"）。所以插件之间可以通过
// globalThis 共享一个队列。
//
//   插件 A 加载 → 入队
//   插件 B 加载 → 入队
//   ...          ↓ 100ms 窗口
//              合并去重 → 一次写入
//
// 实测：10 个插件同时启动，**只写盘 1 次**，全部存活，官方条目不动。
//
// ═══════════════════════════════════════════════════════════════════
// 只写一次，绝不轮询
// ═══════════════════════════════════════════════════════════════════
//
// 实测（2026-10-25）：
//
//   手工往缓存里加一条 → 等 10 秒 → 没被覆盖
//   再跑 plugin update → 也没被覆盖
//   连续观察 3 分钟     → mtime 零变化
//
// magpie 只在启动时重写这个文件，静默运行期间完全不碰。
//
// ⚠⚠ 绝对不要用 fs.watch 或 setInterval 去「补」。
//    我试过：我们写文件（rename）会触发自己的 watch，watch 又写，
//    每秒 3-4 次，永不停止（实测 60 秒内 mtime 变化 19 次）。
//    删掉后 60 秒变化 0 次。
//
// ═══════════════════════════════════════════════════════════════════

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/** 官方 registry 的地址（缓存丢了时的兜底）*/
const OFFICIAL_REGISTRY =
  "https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json"

/** 队列的共享键（Symbol.for 保证同一进程内所有插件拿到同一个）*/
const QUEUE_KEY = Symbol.for("magpie.plugin-template.registry-queue")

/** 攒批窗口。够短（卡片不卡），够长（同期插件都能进来）*/
const FLUSH_MS = 100

/**
 * 落盘时点（**有上限**，绝不是轮询/watch）。
 *
 * ⚠️ 真机 2026-10-30：magpie 启动后会**异步**去拉一次官方 registry（联网，
 *    快慢不定），拉到就**整体重写**缓存 —— 我们在 100ms 写进去的那条会在几十秒后
 *    被冲掉（`plugin update` 后 30 秒：文件回到 60 条官方条目，我们的第 61 条没了，
 *    卡片于是退回 GitHub 发现的「未审阅」黄标）。
 *
 * 所以在拉取窗口之后再补写几次。⚠️ 与「不要 fs.watch / setInterval 去补」不冲突：
 *    那是指**自触发死循环**（写文件触发 watch，watch 又写，每秒 3-4 次永不停止）。
 *    这里是**固定 4 个时点、写完即止**，且每次合并是幂等的（条目已存在 → JSON 不变
 *    → 不写盘）。
 */
const FLUSH_SCHEDULE_MS = [FLUSH_MS, 30_000, 90_000, 240_000]

/**
 * 从 magpie 的配置目录推出它的缓存目录。
 *
 * 插件的 directory 是 magpie 的 config folder（~/.config/magpie）。
 * XDG 规则下 cache 和 config 平级。
 */
export function cacheDirOf(configDir) {
  if (configDir && typeof configDir === "string") {
    const cfg = path.resolve(configDir)
    const guess = path.join(path.dirname(path.dirname(cfg)), ".cache", "magpie")
    if (fs.existsSync(guess)) return guess
    if (process.platform === "darwin") {
      const mac = path.join(os.homedir(), "Library", "Caches", "magpie")
      if (fs.existsSync(mac)) return mac
    }
    const xdg = process.env.XDG_CACHE_HOME
    if (xdg) return path.join(xdg, "magpie")
    return guess
  }
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return path.join(xdg, "magpie")
  return path.join(os.homedir(), ".cache", "magpie")
}

/** 取（或创建）共享队列 */
function queue(configDir) {
  if (!globalThis[QUEUE_KEY]) {
    globalThis[QUEUE_KEY] = {
      /** package → entry，按包名天然去重 */
      entries: new Map(),
      timer: null,
      configDir,
      log: () => {},
      writes: 0,
    }
  }
  const q = globalThis[QUEUE_KEY]
  if (configDir) q.configDir = configDir
  return q
}

/**
 * 把一个条目加入队列。
 *
 * 同一个包名重复入队只保留最后一次 —— 这就是去重。
 *
 * @param {object} entry { package, name, providers?, community?, summary }
 * @param {{configDir?: string, log?: Function, timeoutMs?: number}} [opts]
 */
export function registerSelf(entry, opts = {}) {
  if (!entry || typeof entry.package !== "string" || entry.package.length === 0) {
    return Promise.resolve({ ok: false, reason: "entry.package 缺失" })
  }

  const q = queue(opts.configDir)
  if (typeof opts.log === "function") q.log = opts.log

  q.entries.set(entry.package, entry)

  if (q.timer || q.scheduled) return Promise.resolve({ ok: true, queued: true })

  return new Promise((resolve) => {
    q.scheduled = true
    q.attempt = 0
    const step = () => {
      q.timer = null
      const r = flush(q, opts.timeoutMs)
      q.attempt += 1
      if (q.attempt === 1) resolve(r) // 第一次的结果就是调用方拿到的结果
      if (q.attempt >= FLUSH_SCHEDULE_MS.length) {
        q.scheduled = false
        return
      }
      q.timer = setTimeout(step, FLUSH_SCHEDULE_MS[q.attempt])
      if (typeof q.timer.unref === "function") q.timer.unref()
    }
    q.timer = setTimeout(step, FLUSH_SCHEDULE_MS[0])
    if (typeof q.timer.unref === "function") q.timer.unref()
  })
}

/**
 * 一次读、一次合并、一次写。
 *
 * 队列里的所有条目（可能来自多个插件）在这个函数里一起进缓存，
 * 所以并发插件之间不存在「你覆盖我」的窗口。
 */
function flush(q, timeoutMs = 15_000) {
  const log = q.log
  if (q.entries.size === 0) return { ok: true, changed: false }

  const cacheDir = cacheDirOf(q.configDir)
  const marketPath = path.join(cacheDir, "plugin-market.json")

  try {
    let current = null
    if (fs.existsSync(marketPath)) {
      try {
        current = JSON.parse(fs.readFileSync(marketPath, "utf8"))
      } catch {
        current = null
      }
    }

    if (!current || !Array.isArray(current.plugins)) {
      // 缓存不可用就跳过（不阻塞插件加载）。条目留在队列里，后续时点还会再试
      // （magpie 的官方拉取可能还没落盘，那时文件就是不可用的）。
      const names = [...q.entries.keys()].join(", ")
      log(`市场缓存不可用，跳过注册：${names}`)
      return { ok: false, reason: "市场缓存不可用" }
    }

    const snapshot = JSON.stringify(current, null, 2)
    const added = []
    const updated = []

    // 按包名合并：有就原地更新，没有才追加
    for (const [pkg, entry] of q.entries) {
      const idx = current.plugins.findIndex((x) => x?.package === pkg)
      if (idx >= 0) {
        current.plugins[idx] = entry
        updated.push(pkg)
      } else {
        current.plugins.push(entry)
        added.push(pkg)
      }
    }
    // ⚠️ 不清队列：后续时点（FLUSH_SCHEDULE_MS）还要用同一批条目再合并一次
    //    （magpie 的官方拉取会整体重写缓存，晚到的那次才是最终留在盘上的）。
    //    重复合并且条目已存在时 JSON 不变 → snapshot === next → 根本不写盘。

    const next = JSON.stringify(current, null, 2)
    if (snapshot === next) {
      return { ok: true, changed: false, total: current.plugins.length }
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = `${marketPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    fs.writeFileSync(tmp, next, "utf8")
    fs.renameSync(tmp, marketPath)
    q.writes++

    const parts = []
    if (added.length) parts.push(`新增 ${added.length}`)
    if (updated.length) parts.push(`更新 ${updated.length}`)
    log(`已注册 ${parts.join("，")}（共 ${current.plugins.length} 条，这是第 ${q.writes} 次写入）`)

    return {
      ok: true,
      changed: true,
      total: current.plugins.length,
      added,
      updated,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`自注册失败：${msg}`)
    return { ok: false, reason: msg }
  }
}

/**
 * 启动自注册。
 *
 * 一次调用只入队一次。同期的其它插件会在同一个窗口里被合并，
 * 一起写进缓存 —— 不管有多少个插件，写入次数都接近 1。
 *
 * @param {object} entry
 * @param {{configDir?: string, log?: Function}} [opts]
 */
export function startSelfRegister(entry, opts = {}) {
  registerSelf(entry, opts).catch(() => {})
}

/** 供测试：把共享队列整个复位（每个用例一个干净的宿主状态；不影响真实使用）*/
export function _reset() {
  const q = globalThis[QUEUE_KEY]
  if (q?.timer) clearTimeout(q.timer)
  delete globalThis[QUEUE_KEY]
}

/** 供测试：立刻清空队列（不影响真实使用）*/
export function _flushNow() {
  const q = globalThis[QUEUE_KEY]
  if (!q) return { ok: true, changed: false }
  if (q.timer) {
    clearTimeout(q.timer)
    q.timer = null
  }
  return flush(q)
}

export const _internal = { cacheDirOf, OFFICIAL_REGISTRY, QUEUE_KEY, FLUSH_MS, FLUSH_SCHEDULE_MS }
