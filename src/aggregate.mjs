// 聚合层：一个供应商，内部聚合多个渠道；凭据进 **magpie 账号槽**（多账号）。
//
// ## 形态：一个供应商，多渠，多账号
//
// 参照 ofm（our-free-model）：**一个供应商条目**覆盖多个渠道，模型 id 带渠道前缀
// （`officeace/glm-5.3`）。在此之上，凭据按 magpie 的**账号槽**存放（社区插件同款）：
// 每次登录 = 一个账号条目，auth 里带 `channel` 字段标记归属渠道 ——
// 同渠道可挂多个账号（不再互相覆盖），magpie 网关在额度耗尽时自动换槽。
//
// ## 存储：账号槽为主，旁路文件为兜底（双写）
//
// - **主**：magpie 账号槽存 `{type:'oauth', channel, ...凭据, expires}` ——
//   loader/refresh/checkin/usage 全部以 `getAuth()` 拿到的账号为口径；
// - **兜底**：`~/.config/magpie/<channel>-credential.json` 旁路文件继续写
//   （迁移前已登录的账号不至于失效；magpie 轮到**别的渠道**的账号槽时，
//   请求靠它照常发出去 —— 旁路内容 = 最近一次成功使用的该渠道凭据）。
//
// ## 为什么去重闸按「凭据身份」而不是渠道 id 键控
//
// refresh_token 会轮换的渠道（minimaxintl / accio / officeace STS），同渠道
// 两个账号并发续期是**合法**场景 —— 按渠道键控会让第二个账号共享第一个的
// 续期结果（拿到别人的凭据）。按 `channel + refresh_token`（或 access）键控：
// 同一凭据并发共享一个在途请求，不同凭据各走各的。

import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { loadCredential, saveCredential, notSignedIn, untilText, readMagpieAuthSlots, debugLog } from './shared.mjs'
import { officeaceChannel } from './officeace.mjs'
import { astudioChannel } from './astudio.mjs'
import { minimaxintlChannel } from './minimaxintl.mjs'
import { accioChannel } from './accio.mjs'
import { autoclawChannel, autoclawIntlChannel } from './autoclaw.mjs'
import { loomyChannel } from './loomy.mjs'
import { lobsteraiChannel } from './lobsterai.mjs'
import { magicrewChannel, magicrewIntlChannel } from './magicrew.mjs'
import { startSelfRegister } from './self-register.mjs'
import { sanitizeXff } from './minimax-transport.mjs'

const PROVIDER = 'providers-hub'
const PROVIDER_NAME = 'Providers Hub'

/** magpie 在到期前这么多毫秒调 auth.refresh（对齐各渠道 10 分钟临期口径）。 */
const REFRESH_LEAD_MS = 10 * 60 * 1000

/**
 * loader 的占位 baseURL。
 *
 * ⚠️ 不能留空串：magpie 会据此判「无处可发」（`nowhere to send its requests`）。
 *    本插件的请求全部在 `loader().fetch` 里按渠道前缀改写到各上游，这个域名不会被真正访问；
 *    用 `.invalid` 保留域（RFC 2606）保证即使漏拦截也不会打到真实主机。
 */
const PLACEHOLDER_BASE = 'https://providers-hub.invalid'

/** 注册进来的渠道。加渠道 = 往这里加一项（并在上面 import）。 */
/** 注册进来的渠道。加渠道 = 往这里加一项（并在上面 import）。 */
const CHANNELS = [officeaceChannel, astudioChannel, minimaxintlChannel, accioChannel, autoclawChannel, autoclawIntlChannel, loomyChannel, lobsteraiChannel, magicrewChannel, magicrewIntlChannel]

// 供测试遍历 stub（authorize 契约测试必须覆盖每一个渠道，漏一个就会真发网络请求）
export { CHANNELS as REGISTERED_CHANNELS }

// ── 账号（auth）与凭据的形状工具 ──────────────────────────────────────────

/**
 * auth 是否属于该渠道（登录回调写入的 `channel` 字段是唯一判据）。
 *
 * ⚠️ **type 要认两种**（真机 bug）：登录回调写进账号槽的是 `type: 'success'`
 *    （magpie 的 auth 形状），而这里若只认 `'oauth'` 就**永不匹配** ——
 *    于是每个账号槽都掉进「旁路全渠道扫」分支，**每个槽都显示全部渠道的额度**
 *    （用户报障：登录一个渠道后所有账号卡的额度一模一样）。
 *    `'success'` 与 `'oauth'` 都接受，判据仍是 `channel` 字段。
 */
const authOfChannel = (auth, channel) =>
  (auth?.type === 'oauth' || auth?.type === 'success') && auth?.channel === channel.id

/** 从 auth 剥出裸凭据（旁路文件存这个形状，与渠道函数的入参一致）。 */
function credentialOfAuth(auth) {
  const { type, channel, expires, accountId, ...credential } = auth ?? {}
  return credential
}

/**
 * 凭据的到期时刻（毫秒）。三渠道的字段形态各不相同：
 * - officeace：`expiresAt` 是 ISO 字符串；
 * - minimaxintl：`expires_at` 是毫秒**数字串**（本实现写入）；
 * - accio：`expires_at` 是毫秒数字（秒→毫秒已在兑换层归一）。
 * 数字串/数字都兼容秒级（`> 1e12` 视为毫秒）；astudio 无到期字段 → undefined。
 */
export function expiresMsOf(credential) {
  if (typeof credential?.expiresAt === 'string') {
    const t = Date.parse(credential.expiresAt)
    if (Number.isFinite(t)) return t
  }
  const raw = credential?.expires_at
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (n > 0) return n > 1e12 ? n : n * 1000
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000
  }
  return undefined
}

/** 续期去重闸的键：渠道 + 凭据身份（refresh_token 优先，退 access）。 */
const identityOf = (credential) =>
  String(credential?.refreshToken ?? credential?.refresh_token ?? credential?.access ?? credential?.access_token ?? '')

// ── 旁路文件（兜底）：内存缓存 + 磁盘 ────────────────────────────────────

const sidecar = new Map()
/** 最近一次写旁路的凭据身份（身份没变就不重复写盘 —— 请求热路径不做 IO）。 */
const sidecarIdentity = new Map()

function sidecarCredentialOf(channel) {
  if (sidecar.has(channel.id)) return sidecar.get(channel.id)
  const stored = loadCredential(channel.id)
  if (stored) sidecar.set(channel.id, stored)
  return stored
}

/** 写旁路（仅当凭据身份变化时落盘；首次见到也写）。 */
function writeSidecar(channel, credential) {
  const identity = identityOf(credential)
  sidecar.set(channel.id, credential)
  if (sidecarIdentity.get(channel.id) === identity) return
  sidecarIdentity.set(channel.id, identity)
  saveCredential(channel.id, credentialOfAuth(credential))
}

// ── 续期：去重闸 + 双写落盘 ──────────────────────────────────────────────

/**
 * **聚合层级的续期去重闸**：同一凭据同一时刻只允许一个在途续期。
 *
 * ⚠️ 键是 `channel + 凭据身份`（见文件头）—— 同渠道多账号互不串号，
 *    同一账号的并发入口（loader 临期软续期 / chat 401 硬续期 / magpie refresh）
 *    共享同一个在途请求。
 *
 * ⚠️ refresh_token 一次性渠道（officeace STS）的「消费即落盘」纪律：
 *    渠道 refresh 的第二参 persist 回调只写**旁路**（此刻 modelInfo 还没合并，
 *    写账号槽会丢 channel 等字段）；账号槽在最终结果处一次写齐。
 */
const renewInFlight = new Map()

function gatedRenew(channel, current) {
  const key = channel.id + '\n' + identityOf(current)
  const pending = renewInFlight.get(key)
  if (pending !== undefined) return pending
  const bare = credentialOfAuth(current)
  const task = channel.refresh(bare, (partial) => writeSidecar(channel, partial))
    .then((next) => {
      // current 是 auth（带 channel 字段）就合并回 auth 形状；是裸凭据就保持裸
      // ⚠️ type 认 'success'（我们写进账号槽的形状）与 'oauth'（社区插件形状）
      const merged = current?.type === 'oauth' || current?.type === 'success'
        ? { ...current, ...next }
        : next
      writeSidecar(channel, merged)
      return merged
    })
    .finally(() => renewInFlight.delete(key))
  renewInFlight.set(key, task)
  return task
}

/**
 * 软续期（失败不抛错、沿用原凭据）：loader 临期路径与 ensure() 共用。
 * 真正确凿的失效由渠道 chat 的 401 那条路（硬续期）兜底。
 */
async function renewSoft(channel, current) {
  try {
    return await gatedRenew(channel, current)
  } catch (error) {
    console.warn(`[${channel.id}] 续期未成功，沿用原凭据：${error.message}`)
    return current
  }
}

/** 旁路路径的取凭据 + 临期软续期（迁移前的账号走这条）。 */
async function ensure(channel) {
  let current = sidecarCredentialOf(channel)
  if (!current) throw notSignedIn(`未登录：请先在插件里登录 ${channel.displayName}`)
  if (channel.expired?.(current)) current = await renewSoft(channel, current)
  return current
}

/**
 * 账号路径的取凭据 + 临期软续期。**账号是活的就顺带刷新旁路**
 * （旁路内容 = 最近一次成功使用的该渠道凭据 —— 目录/兜底路径靠它）。
 */
async function ensureAuth(channel, auth) {
  let current = auth
  if (channel.expired?.(auth)) current = await renewSoft(channel, auth)
  writeSidecar(channel, current)
  return current
}

/** 已登录渠道（旁路口径 —— 目录合并用；账号槽由 magpie 自管）。 */
const signedIn = (channel) => Boolean(sidecarCredentialOf(channel))

// ── 目录：合并渠道目录，模型 id 加渠道前缀 ────────────────────────────────

/**
 * 目录里的模型 id 只带**渠道**前缀：`officeace/glm-5.3`
 * （与 jethub 同形态：那里 `loomy/GLM-5.3-Flash` 的 `loomy` 也是渠道）。
 * magpie 展示/选择时会自动补供应商名前缀，呈现为 `providers-hub/officeace/glm-5.3`。
 */
function prefixed(channelId, modelId) {
  return `${channelId}/${modelId}`
}

/**
 * 合并所有渠道的目录。⚠️ **按渠道分别回落**：已登录渠道拉真实目录、
 * 未登录渠道用兜底目录（否则「officeace 登录后 astudio 的模型凭空消失」）。
 */
async function discoverModels(fallback) {
  const merged = {}
  for (const channel of CHANNELS) {
    let models
    if (signedIn(channel)) {
      try {
        const credential = await ensure(channel)
        models = await channel.catalog(credential)
      } catch {
        // 单渠道失败不影响其它渠道；退回该渠道自己的兜底目录
        models = undefined
      }
    }
    if (!models || Object.keys(models).length === 0) {
      models = channel.fallbackModels ?? {}
    }
    for (const [id, def] of Object.entries(models)) {
      merged[prefixed(channel.id, id)] = def
    }
  }
  return Object.keys(merged).length > 0 ? merged : fallback
}

// ── 页面快照（侧边栏 Providers Hub 页用的只读数据）──────────────────────
//
// 页面跑在沙盒里（connect-src 'none'，没有 fetch），只能加载本文件夹的 JS ——
// 所以由宿主（Bun，有文件权限）把**非敏感**状态写进 page/snapshot.js，页面
// 用 <script src="snapshot.js"> 读。机制与 magpie-jet-hub 同款（同机验证过）。
//
// ⚠️ 绝不写凭据：access_token / refresh_token / secret_* / STS AK·SK 一律不出现。
//    只写「是否登录 / 是否过期 / 桶 / 签到结果 / 模型数」。

// ⚠️ **必须是文件路径字符串**，不能留 file:// URL 对象：原子写要拼 `.tmp` 后缀
//    （模板串会把 URL 对象变成 "file:///…" 字符串，renameSync 直接失败且被
//    catch 吞掉 —— 快照从此静默不再更新，真机「等半天没刷新」的根因）。
const SNAPSHOT_PATH = process.env.DSH_HUB_SNAPSHOT_PATH
  ?? fileURLToPath(new URL('../page/snapshot.js', import.meta.url))

/**
 * 快照写入开关 —— 由工厂按 options.notify 设置（模块层变量：writeSnapshot
 * 在模块层，引用工厂内的 const 会 ReferenceError 且被静默吞掉 ——
 * 真机 2026-10-27：快照从此一次都没写过，「等半天没刷新」的根因）。
 * 测试里 npm test 的 --import setup 重定向快照路径，配合此开关双保险。
 */
let snapshotWritesDisabled = false

/** 最近一次 usage / checkin 的成果缓存（models 钩子没有桶数据，靠它拼快照）。 */
const snapshotCache = { buckets: new Map(), checkin: new Map(), modelCount: undefined, at: 0 }

/** read('refresh') 的宿主侧限流：上游最多每 15 秒被全渠道查一次。 */
const SWEEP_MIN_INTERVAL_MS = 15_000
let lastSweepAt = 0
let lastSweepSnapshot = undefined

/** 与 shared.mjs 的 pointer 分档一致：≤15 天算临期，其后长期，无到期则永久。 */
const WEB_EXPIRING_WINDOW_DAYS = 15

/** 数字收口：最多两位小数，去尾零（`3994.5640045714285` → `3994.56`）。 */
function tidyNumber(text) {
  return String(text).replace(/-?\d+\.\d{3,}/g, (m) => {
    const n = Number(m)
    if (!Number.isFinite(n)) return m
    return String(Math.round(n * 100) / 100)
  })
}

/**
 * 一个桶的到期档位（页面据此上色）。
 *
 * ⚠️ **不靠桶名里的字样猜**：OfficeAce 这类渠道的桶名是「个人体验版 / 新用户专属福利」，
 *    到期信息只在结构化字段里 —— 按名字匹配会让它们全变灰（真机报障）。
 *
 * 判据优先级：
 * 1. 名字里已有档位（聚合层汇总过的「临期 · 剩 N」/「长期（7 批）」）→ 直接用；
 * 2. 有**作废**时刻（expiresAtMs / runsOutAt）→ 按 ≤15 天分临期/长期；
 * 3. 只有 **resetsAt（重置回满）** → 同样按剩余时间分档：
 *    ⚠️ 用户口径：「每日赠送 21 小时后」不是永久 —— 那个额度明天就清零，
 *       属于**该赶紧用掉**的那类，必须标红（用户真机报障：绿胶囊写着「21 小时后」）。
 *    重置与作废的**损失**不同，但**紧迫性**同源，故共用同一时间窗；
 * 4. 两者都没有 → 永久。
 */
function bandOfWindow(w, now) {
  const name = typeof w?.name === 'string' ? w.name : ''
  for (const known of ['临期', '长期', '永久', '已耗尽']) {
    if (name.includes(known)) return known
  }
  // 状态条/错误条（没有额度语义）不分档
  if (typeof w?.display === 'string' && /查询失败|不可用|未登录|已过期|无积分明细|请重新登录/.test(w.display)) {
    return undefined
  }
  if (!Number.isFinite(w?.used) && !/剩 /.test(name) && w?.display === undefined) return undefined
  const raw = w?.expiresAtMs ?? w?.runsOutAt ?? w?.runsOut ?? w?.resetsAt
  const ms = typeof raw === 'string' ? Date.parse(raw) : (typeof raw === 'number' ? raw : NaN)
  if (!Number.isFinite(ms)) return '永久'
  const days = Math.ceil((ms - now) / 86_400_000)
  if (days <= 0) return '已耗尽'
  return days <= WEB_EXPIRING_WINDOW_DAYS ? '临期' : '长期'
}

function sanitizeWindows(windows) {
  const now = Date.now()
  const out = []
  for (const w of Array.isArray(windows) ? windows : []) {
    if (typeof w !== 'object' || w === null) continue
    // 只留展示字段 —— 不猜上游结构，也不透传任何未知键（防未来某渠道塞凭据进来）
    out.push({
      // 名字里的长小数同样收口（OfficeAce 的「剩 3994.5640045714285」）
      name: typeof w.name === 'string' ? tidyNumber(w.name) : '',
      band: bandOfWindow(w, now),
      used: Number.isFinite(w.used) ? w.used : undefined,
      // 长小数收口：上游算出来的 3994.5640045714285 直接怼到界面上很难看
      display: typeof w.display === 'string' ? tidyNumber(w.display) : undefined,
      // 作废时刻优先（resetsAt 是重置语义，页面不拿它算倒计时）
      runsOutAt: (() => {
        const raw = w.expiresAtMs ?? w.runsOutAt
        const ms = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Date.parse(raw) : NaN)
        return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
      })(),
      resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : undefined,
      aside: w.aside === true ? true : undefined,
    })
  }
  return out
}

/**
 * 构建快照对象（writeSnapshot 与 read('refresh') 共用）。
 * 调用点（写盘）：auth.usage()（有桶）、auth.checkin()（有签到）、provider.models()（有模型数）。
 *
 * ⚠️⚠️ **不得用空数据覆盖已有数据**（真机报障：插件重载只触发 models()，
 *    此时桶缓存是空的 —— 直接写会把上一份有数据的快照覆盖成全空，
 *    页面随即整列显示「—」）。
 *    修法：本次没有桶的渠道，**沿用上一份快照里的桶**（快照本身也当缓存用）。
 */
function buildSnapshot() {
  const previous = readPreviousSnapshot()
  // 每渠道的 magpie 账号槽数：accountId 相同 = 原地更新（同账号重登不重复，
  // magpie 原生语义）；不同 accountId 并存 = 真多账号。槽数 >1 说明该渠道
  // 登了多个账号，>0 且旁路也有 = 正常。
  const slots = readMagpieAuthSlots(PROVIDER)
  const channels = CHANNELS.map((channel) => {
    const credential = sidecarCredentialOf(channel)
    const signedInNow = Boolean(credential)
    let expired
    if (signedInNow && typeof channel.expired === 'function') {
      try { expired = Boolean(channel.expired(credential)) } catch { expired = undefined }
    }
    const ck = snapshotCache.checkin.get(channel.id)
    const fresh = snapshotCache.buckets.get(channel.id)
    // 本次没查到桶 → 沿用上一份快照的（没有过期的旧数据也别长期挂着）
    const old = previous?.channels?.find((c) => c && c.id === channel.id)
    const oldBuckets = Array.isArray(old?.buckets) ? old.buckets : []
    const buckets = fresh !== undefined ? sanitizeWindows(fresh) : oldBuckets
    const accountSlots = slots.filter((s) => s.channel === channel.id).length
    return {
      id: channel.id,
      displayName: channel.displayName,
      signedIn: signedInNow,
      ...(expired ? { expired: true } : {}),
      ...(accountSlots > 0 ? { accounts: accountSlots } : {}),
      // 逐渠道模型数：从合并目录按 `<channel>/` 前缀统计（没有则 0）
      modelCount: snapshotCache.perChannelModelCount?.[channel.id] ?? 0,
      buckets,
      ...(ck ? { checkin: { outcome: ck.outcome, credit: ck.credit, message: ck.message } }
        : (old?.checkin ? { checkin: old.checkin } : {})),
    }
  })
  return {
    at: Date.now(),
    provider: PROVIDER_NAME,
    models: snapshotCache.modelCount,
    channels,
  }
}

function writeSnapshot() {
  try {
    // ⚠️ 测试进程禁止写真快照（真机事故：node --test 跑在沙箱 HOME 里，
    //    sidecarCredentialOf 全空 → 把真实快照覆盖成「全部未登录」）。
    //    测试统一用 tests/setup.mjs 把 DSH_HUB_SNAPSHOT_PATH 重定向到临时文件 ——
    //    ⚠️ **不能用 NODE_TEST_CONTEXT 判测试**：真机实证 magpie 给 bun 宿主的
    //    环境里它也有值 → 生产快照被这一行整个吞掉（「等半天没刷新」的根因）。
    if (snapshotWritesDisabled) return
    const snap = buildSnapshot()
    // ⚠️ 原子写（临时文件 + 改名）：页面/读侧随时可能在读这份文件，
    //    截断式写入会让人读到半截 JSON（快照瞬态「未登录」的另一半根因）。
    const tmp = `${SNAPSHOT_PATH}.tmp`
    writeFileSync?.(tmp, `window.__PROVIDERS_HUB_SNAPSHOT__ = ${JSON.stringify(snap)};\n`, 'utf8')
    renameSync?.(tmp, SNAPSHOT_PATH)
  } catch {
    /* 写不进去就算了 */
  }
}

/** 读回上一份快照（兜底用；读不到返回 undefined）。 */
function readPreviousSnapshot() {
  try {
    const text = readFileSync?.(SNAPSHOT_PATH, 'utf8')
    if (typeof text !== 'string' || text.length === 0) return undefined
    const body = text.replace(/^window\.__PROVIDERS_HUB_SNAPSHOT__\s*=\s*/, '').replace(/;\s*$/, '')
    const obj = JSON.parse(body)
    return obj && typeof obj === 'object' ? obj : undefined
  } catch {
    return undefined
  }
}



/**
 * 桶过多时按「指针方案」三档汇总（方案 A）。
 *
 * - 只动**可求和**的桶（amount 为数字）；状态条/失败条原样透传。
 * - 可求和的桶 ≤ 3 时**原样返回**（小组数渠道保留原始命名，信息更足）。
 * - 临期 = 最早到期的**那一批**（amount 只算它自己 —— 指针桶数字必须如实）；
 *   长期 = 其余有到期批次合计（到期时刻 = 其中最早 —— 烧桶一死自动转正）；
 *   永久 = 无到期批次合计。
 *
 * ⚠️ 到期字段输出 **runsOutAt + runsOut**（作废语义，magpie 渲染「N 积分
 *   将于 X 过期」紧急条），**不用 resetsAt**（「重置于」暗示会回满 ——
 *   这些批次过期即作废，语义相反）。输入侧 runsOutAt ?? resetsAt 都认
 *   （resetsAt 是旧形态兼容）。
 */
export function tierSummarize(rows) {
  const summable = rows.filter((r) => typeof r?.amount === 'number' && Number.isFinite(r.amount) && r.amount > 0)
  if (summable.length <= 3) {
    // 小组数渠道保留原始命名，但**到期字段仍要剥**（浅灰行去重，用户报障）；
    // 渠道行带 runsOutAt 只是给本函数的分类输入，不该漏到卡片上。
    return rows.map((r) => {
      if (!(typeof r?.amount === 'number' && Number.isFinite(r.amount) && r.amount > 0)) return r
      const { runsOutAt, runsOut, resetsAt, ...keep } = r
      return keep
    })
  }
  const rest = rows.filter((r) => !(typeof r?.amount === 'number' && Number.isFinite(r.amount) && r.amount > 0))
  const expiryOf = (r) => r.runsOutAt ?? r.resetsAt
  const permanent = summable.filter((r) => expiryOf(r) === undefined)
  const expiring = summable
    .filter((r) => expiryOf(r) !== undefined)
    .sort((a, b) => Date.parse(expiryOf(a)) - Date.parse(expiryOf(b)))
  const out = []
  if (expiring.length > 0) {
    const pointer = expiring[0]
    const expiry = expiryOf(pointer)
    out.push({
      ...pointer,
      // 长小数收口（LobsterAI 的 creditItems 是浮点流水：72.01688…）
      name: `临期 · 剩 ${tidyNumber(pointer.amount)}`,
      // ⚠️ display 只放倒计时 —— 剩余量已在 name 里（重复了用户会看到两遍）；
      //    倒计时必须进**亮色主文本**：「将于 X 过期」辅助行浅灰看不清（用户报障）
      display: untilText(expiry) ?? `剩 ${tidyNumber(pointer.amount)}`,
    })
    // ⚠️ 刻意不挂 runsOutAt/runsOut：亮色行已带倒计时，再挂会让 magpie 渲染
    //    出第三行浅灰「N 将于 X 过期」（用户报障：重复）。
    delete out[out.length - 1].runsOutAt
    delete out[out.length - 1].runsOut
    delete out[out.length - 1].resetsAt
  }
  const longTerm = expiring.slice(1)
  if (longTerm.length > 0) {
    const earliest = longTerm[0]
    // ⚠️ 浮点流水求和会有漂移（2158.4905040000003）—— 先求和再收口到两位
    const amount = tidyNumber(longTerm.reduce((s, r) => s + r.amount, 0))
    const expiry = expiryOf(earliest)
    // ⚠️ untilText() 本身已带「…后作废」，不要再拼「作废」（否则出「作废作废」）
    const untilEarliest = untilText(expiry)
    out.push({
      ...earliest,
      name: `长期（${longTerm.length} 批）· 剩 ${amount}`,
      amount: Number(amount),
      display: untilEarliest !== undefined ? `最早 ${untilEarliest}` : `剩 ${amount} · ${longTerm.length} 批`,
    })
    delete out[out.length - 1].runsOutAt
    delete out[out.length - 1].runsOut
    delete out[out.length - 1].resetsAt
  }
  if (permanent.length > 0) {
    const amount = tidyNumber(permanent.reduce((s, r) => s + r.amount, 0))
    out.push({
      name: permanent.length === 1 && typeof permanent[0].name === 'string' ? permanent[0].name : `永久 · 剩 ${amount}`,
      used: 0,
      amount: Number(amount),
      display: `剩 ${amount}`,
    })
  }
  return [...out, ...rest]
}

export const DshProvidersHubPlugin = async (input, options = {}) => {
  const openBrowser = typeof options.openBrowser === 'function' ? options.openBrowser : undefined
  /**
   * 自注册：把本插件写进 magpie 的本地市场缓存（`~/.cache/magpie/plugin-market.json`）。
   *
   * 没有条目时插件卡片的标题退回包名（`magpie-providers-hub`）且没有「源码」按钮。
   * magpie 只在启动时整体重写这个缓存、静默期间不碰（模板作者实测），故写一次即稳、
   * 绝不轮询。移植自 MYCF711/magpie-plugin-template（MIT），见 src/self-register.mjs 头注。
   */
  startSelfRegister({
    package: 'magpie-providers-hub',
    name: 'Providers Hub',
    providers: [PROVIDER],
    community: true,
    summary: {
      en: 'Third-party Magpie adapter for dsh-providers-hub (by JetLi): one provider aggregating 10 channels — OfficeAce, AStudio, MiniMax Code Intl, Accio, AutoClaw CN/Intl, Loomy, LobsterAI, Magicrew CN/Intl. Runs without DSH.',
      zh: 'dsh-providers-hub（作者 JetLi）的第三方适配：一个供应商聚合十个渠道——OfficeAce（华为云）、AStudio（讯飞）、MiniMax Code 国际版、Accio（阿里）、AutoClaw 国内/国际（智谱）、Loomy（讯飞）、LobsterAI（有道）、超级麦吉/MagiCrew（国内+国际），不依赖 DSH 运行。',
    },
  }, {
    configDir: typeof input?.directory === 'string' ? input.directory : undefined,
    log: (msg) => {
      try {
        input?.client?.app?.log?.({ service: 'providers-hub', level: 'info', message: msg })
      } catch { /* 日志失败不影响注册 */ }
    },
  })
  /**
   * MiniMax 国际版的可选绕行 IP（`magpie plugin options providers-hub
   * '{"minimaxXff":"<海外IP>"}'` 设置）。⚠️ 默认关闭；`sanitizeXff` 白名单
   * （IP 字面量）防 CRLF 头注入，非法值静默不附头。
   */
  const minimaxXff = sanitizeXff(options.minimaxXff)
  /**
   * MiniMax 国际版的可选**出口代理**（'{"minimaxProxy":"http://127.0.0.1:7890"}'）。
   *
   * 与 XFF 的分工：XFF 是声明式（上游信不信随它）；代理是**真换出口**
   *（流量实际出海，TLS 指纹分流也无效）—— 设了代理后 XFF 自动降为兜底。
   * ⚠️ 只作用于 minimaxintl 的调用链（中国站类渠道境内直连最优，刻意不全局）；
   * 只支持 http(s)://（Bun 原生 init.proxy；socks5 等真有需求再补）。
   * 非法值静默直连（填错的体验是「仍被分流」，geo 报错文案教他核对）。
   */
  const minimaxProxy = typeof options.minimaxProxy === 'string' ? options.minimaxProxy : undefined
  // 快照写入开关（模块层 writeSnapshot 读这个变量 —— 见其定义处的说明）
  snapshotWritesDisabled = options.notify === false
  /**
   * Windows 系统通知（PowerShell WinRT toast）—— 登录/签到结果的**可靠反馈**：
   * magpie 桌面 GUI 没有 toast 渲染端（TUI 才显示），系统通知是绕开它的正解。
   *
   * 实现：spawn PowerShell `-EncodedCommand`（base64 UTF-16LE，免一切引号转义），
   * AppId 用 PowerShell 自己的 AUMID（无需注册）；fire-and-forget（不阻塞、不等待）。
   * ⚠️ 测试进程不弹：显式 options.notify === false 关闭（**不用** NODE_TEST_CONTEXT
   *    判断 —— 真机实证 magpie 给 bun 宿主的环境里它有值，会把生产通知全吞掉）。
   * 非 Windows 平台静默跳过。
   */
  const notifyDisabled = options.notify === false
  const notify = (title, message) => {
    if (notifyDisabled) return
    if (process.platform !== 'win32') return
    debugLog(`notify entered: ${title}`)
    try {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const ps = [
        // ⚠️ 两个 WinRT 程序集**都要先加载**：只加载 Notifications 的话，
        //    XmlDocument 解析不到（New-Object TypeNotFound）→ 整条链失败
        //    （真机 2026-10-27：toast 静默失败，一条通知都弹不出来）。
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
        '$d = New-Object Windows.Data.Xml.Dom.XmlDocument',
        `$d.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(message)}</text></binding></visual></toast>')`,
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe\').Show([Windows.UI.Notifications.ToastNotification]::new($d))',
      ].join('; ')
      // ⚠️ **spawnSync + 捕获输出**：detached+ignore 让 PowerShell 的报错完全
      //    不可见（真机排查两天找不到原因）——同步跑、把退出码/stderr 记进日志。
      //    阻塞 ~1-2 秒可接受（登录/签到反馈是低频操作）。
      const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      const r = spawnSync(psExe, ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 20_000,
      })
      debugLog(`notify spawn: status=${r.status} err=${(r.stderr?.toString() ?? '').slice(0, 200) || '(空)'}`)
    } catch (e) {
      debugLog(`notify threw: ${e.message}`)
    }
  }
  /** magpie 的 auth 存储（社区插件同款 `client.auth.set`；不可用则只写旁路）。 */
  const authSet = typeof input?.client?.auth?.set === 'function' ? input.client.auth.set : undefined
  /**
   * 宿主 toast（登录结果反馈 —— 用户报障「登录后一点提示都没有」）。
   * ⚠️ 形状是 OpenCode 的 `tui.showToast({body:{message, variant}})`；调用全部
   *    包 try —— toast 失败不致命（GUI/TUI 的接受形状可能随版本变化）。
   */
  const toast = (message, variant = 'info') => {
    try { void input?.client?.tui?.showToast?.({ body: { message, variant } }) } catch { /* 忽略 */ }
    try { void input?.client?.app?.log?.({ level: 'info', message }) } catch { /* 忽略 */ }
  }
  const saveAuth = async (auth) => {
    try {
      await authSet?.({ path: { id: PROVIDER }, body: auth })
    } catch { /* magpie 存储失败不阻断：旁路已有兜底 */ }
  }
  /** getAuth 的安全包装（未登录/异常 → undefined，不抛）。 */
  const safeGetAuth = async (getAuth) => {
    try {
      return typeof getAuth === 'function' ? await getAuth() : undefined
    } catch {
      return undefined
    }
  }
  /** 当日签到记账（checkin 的全渠道合并 —— 见 auth.checkin 注释）。 */
  const checkinTally = { day: '', map: new Map() }

  /** 请求体里的 model 是 `<channel>/<model>`（可能带供应商前缀）；拆出渠道。 */
  const resolve = (modelId) => {
    const raw = String(modelId ?? '')
    const parts = raw.split('/')
    const channelId = parts.length >= 2 ? parts[parts.length - 2] : ''
    const inner = parts[parts.length - 1] ?? ''
    const channel = CHANNELS.find((c) => c.id === channelId)
    return channel ? { channel, model: inner } : undefined
  }

  // ── 宿主侧定时刷新快照 ──
  //
  // magpie 只在用量页/目录刷新时调 usage —— 页面快照可能一小时都不更新
  // （用户报障：等半天没刷新）。宿主是常驻进程：**自己定时**查一遍已登录
  // 渠道并写快照，侧边栏页的「刷新周期」才有新东西可读。
  //
  // ⚠️ 测试进程不弹通知（options.notify:false），但 sweep 定时器**无条件启动**
  //    （unref 不驻留进程，node --test 不会假死；生产靠它保证快照新鲜 ——
  //    ⚠️ 不能用 NODE_TEST_CONTEXT 判断测试：magpie 的 bun 宿主环境里它有值，
  //    会把生产 sweep 整个关掉）。可用 options.snapshotRefreshMinutes 调（默认 5 分钟，0 = 关闭）。
  const sweepMinutes = Number(options.snapshotRefreshMinutes)
  const sweepEveryMs = (Number.isFinite(sweepMinutes) && sweepMinutes > 0 ? sweepMinutes : 5) * 60_000
  const sweepTimer = setInterval(() => {
    void sweepAllUsage().then(() => writeSnapshot()).catch(() => {})
  }, sweepEveryMs)
  sweepTimer.unref?.()

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: '@ai-sdk/openai-compatible',
        api: '',
        models: {},
      }
    },

    /**
     * ⚠️⚠️ **没有 read 钩子，也不该有**：magpie 的页面读通道只服务两个内建项
     *    （usage:summary / providers:list，见 docs/subsystems/plugin-runtime.md
     *    「Nothing secret is readable」）—— 自造的 read('login')/read('refresh')
     *    会被服务端拒绝（页面沙盒连窗口都开不了，登录取代方案是供应商编辑器的
     *    auth.methods 按钮，magpie 原生渲染）。页面的「刷新周期」只重读快照文件，
     *    数据新鲜度跟随 magpie 自己的 usage 刷新节奏。
     */

    auth: {
      provider: PROVIDER,
      // magpie 在到期前 LEAD 调 refresh（多账号时按各账号自己的 auth 调）
      refreshLead: REFRESH_LEAD_MS,

      // 每渠道一个登录入口。⚠️ 约定（对齐社区插件）：authorize() 必须**立刻**
      // 返回 { url, method, callback } —— 在这里 await 用户完成登录会与 magpie
      // 双向死锁；真正等登录的是 callback()。渠道契约 beginLogin() → { url, result }。
      methods: CHANNELS.map((channel) => ({
        type: 'oauth',
        label: `登录 ${channel.displayName}`,
        async authorize() {
          // xff 只对 minimaxintl 有意义，其余渠道忽略该参数
          const started = await channel.beginLogin(openBrowser, { xff: minimaxXff, proxy: minimaxProxy })
          // 登录前的账号槽状态（accountId → 此前凭据是否已过期）—— 判据见下
          const preSlots = new Map(
            readMagpieAuthSlots(PROVIDER)
              .filter((s) => s.channel === channel.id)
              .map((s) => [s.accountId, { expired: s.expires !== undefined && s.expires <= Date.now() }]),
          )
          const resolveAccountId = (credential) =>
            (typeof credential?.nickname === 'string' && credential.nickname !== ''
              ? credential.nickname
              : channel.displayName)
          /** 是否「重复登录一个仍然有效的账号」= 该弹「账号重复」且**不覆盖原槽**。 */
          const isHealthyDuplicate = (credential) => {
            const pre = preSlots.get(resolveAccountId(credential))
            return pre !== undefined && !pre.expired
          }
          // ⚠️⚠️ 通知/快照挂在**自己的完成链**上，不挂在 callback 里 ——
          //    真机实证（2026-10-27 微信扫码重登）：登录落盘后 magpie 弹了
          //    「已添加」但 **callback 从未被调用**（notify 日志不存在）——
          //    magpie 对 auto 流程只监听 auth.set 事件即认定完成，未必回调。
          //    started.result 由载体服务自己 settle，必触发。
          //
          //    ⚠️⚠️ 通知规则（用户定案）：
          //    · 新账号                                    → 弹「登录成功（新增账号）」
          //    · 已有账号且**未过期**（重复登录）           → 弹「⚠️ 账号重复」，
          //                                                  **且不覆盖原账号槽**（callback 里跳过写入）
          //    · 已有账号但**已过期**（重新登录/续期）       → 弹「已更新登录（已续期）」+ 写入
          //    · 登录失败                                  → 弹失败
          void started.result.then((credential) => {
            try {
              debugLog(`chain fired: ${channel.id}`)
              const accountId = resolveAccountId(credential)
              writeSnapshot() // 快照立即跟上（不等 magpie 的 usage 轮询）
              const pre = preSlots.get(accountId)
              if (pre === undefined) {
                debugLog(`chain: 新账号 ${channel.id} ${accountId}`)
                notify('Providers Hub', `${channel.displayName}：登录成功（新增账号）`)
                toast(`${channel.displayName}：登录成功（新增账号）`)
              } else if (pre.expired) {
                debugLog(`chain: 过期账号重新登录 ${channel.id} ${accountId}`)
                notify('Providers Hub', `${channel.displayName}：已更新登录（已续期）`)
                toast(`${channel.displayName}：已更新登录（已续期）`)
              } else {
                debugLog(`chain: 账号重复（保留原槽，不覆盖）${channel.id} ${accountId}`)
                notify('⚠️ 账号重复', `${channel.displayName} 的「${accountId}」此前已登录且仍有效 —— 本次未覆盖原账号槽`)
                toast(`${channel.displayName}：账号重复 —— 已保留原账号（未覆盖）`, 'warning')
              }
            } catch (e) { debugLog(`chain threw: ${e.message}`) }
          }).catch((e) => { debugLog(`chain rejected: ${e.message}`) })
          return {
            url: started.url,
            method: 'auto',
            instructions: started.instructions
              ?? `在打开的页面里完成 ${channel.displayName} 登录，本窗口会自动继续。`,
            async callback() {
              debugLog(`magpie callback invoked: ${channel.id}`)
              try {
                const credential = await started.result
                const expires = expiresMsOf(credential)
                // 双写：账号槽（主，magpie 按 auth.channel 归属这个账号）+ 旁路（兜底）。
                // accountId 优先用渠道带回的账号名（minimaxintl 登录时查真名）——
                // 多账号时卡片显示真名而不是同一个渠道名。
                const auth = {
                  type: 'success',
                  channel: channel.id,
                  ...credential,
                  ...(expires !== undefined ? { expires } : {}),
                  accountId: resolveAccountId(credential),
                }
                // ⚠️ 防重复：重复登录一个仍然有效的账号 → **不覆盖原账号槽**
                //    （保留原凭据/账号；仍把 auth 返回给 magpie 以免流程报错）。
                if (isHealthyDuplicate(credential)) {
                  debugLog(`callback: 账号重复，跳过写入（保留原槽）${channel.id} ${auth.accountId}`)
                  return auth
                }
                writeSidecar(channel, { type: 'oauth', channel: channel.id, ...credential })
                await saveAuth(auth)
                return auth
              } catch (error) {
                // 登录失败也弹（否则「在等流程」和「失败了」分不清）
                const message = error instanceof Error ? error.message : String(error)
                notify(`${channel.displayName} 登录失败`, message)
                toast(`${channel.displayName} 登录失败：${message}`, 'error')
                throw error
              }
            },
          }
        },
      })),

      /**
       * 按账号发请求：`getAuth()` 拿**当前账号槽**的 auth。
       *
       * - auth 属于目标渠道 → 用它（同渠道多账号：magpie 换槽即换号）；
       * - auth 属于**别的**渠道（多渠供应商轮到别的账号）或读不到 →
       *   旁路兜底（旁路 = 最近一次成功使用的该渠道凭据）；
       * - 都没有 → 明确的未登录响应（不炸会话）。
       */
      async loader(getAuth) {
        return {
          // ⚠️ baseURL 不能是空串：magpie 会据此判「无处可发」；真正上游在 fetch 里改写。
          baseURL: PLACEHOLDER_BASE,
          async fetch(input, init) {
            let body
            try {
              body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
            } catch {
              body = undefined
            }
            const hit = resolve(body?.model)
            if (!hit) {
              return Response.json(
                { error: { type: 'invalid_request_error', message: `无法识别的模型：${body?.model ?? '(空)'}` } },
                { status: 404 },
              )
            }
            const auth = await safeGetAuth(getAuth)
            let credential
            if (authOfChannel(auth, hit.channel)) {
              credential = await ensureAuth(hit.channel, auth)
            } else {
              try {
                credential = await ensure(hit.channel)
              } catch (error) {
                return Response.json(
                  { error: { type: 'authentication_error', message: error.message } },
                  { status: 401 },
                )
              }
            }
            // ⚠️ 发给上游的 model 必须**去掉**渠道前缀
            const upstreamBody = { ...body, model: hit.model }
            const response = await hit.channel.chat(credential, {
              body: upstreamBody,
              signal: init?.signal,
              // **硬**续期（异常透传）：渠道靠它区分「续期没成功」与「续期成功但没变」；
              // 走凭据身份键控的去重闸（同账号并发共享，多账号不串号）。
              renew: (current) => gatedRenew(hit.channel, current),
              // MiniMax 国际版的可选绕行 IP（其余渠道忽略该字段）
              xff: minimaxXff, proxy: minimaxProxy,
            })
            // 续期后渠道拿到新凭据时同步双写（chat 的 renew 返回值不经手，这里
            // 由 gatedRenew 内部的 writeSidecar 完成；账号槽由 magpie refresh 兜）
            return response
          },
        }
      },

      /**
       * 用量卡：**按账号**（getAuth 的渠道）出该渠道的桶；读不到账号时
       * 退回「旁路口径的全渠道扫」（迁移前/异常路径的行为保持不变）。
       */
      async usage(getAuth) {
        const auth = await safeGetAuth(getAuth)
        const channel = CHANNELS.find((c) => authOfChannel(auth, c))
        if (channel !== undefined) {
          const credential = await ensureAuth(channel, auth)
          const windows = await usageWindowsOf(channel, credential)
          snapshotCache.buckets.set(channel.id, windows)
          writeSnapshot()
          return { plan: PROVIDER_NAME, windows }
        }
        const windows = await sweepAllUsage()
        writeSnapshot()
        return { plan: PROVIDER_NAME, windows }
      },

      // magpie 的显式/提前续期入口：**按 auth.channel 分发**（多账号各续各的）。
      // astudio 无 refresh_token → 返回 undefined（magpie 保持原登录不动）。
      async refresh(auth) {
        const channel = CHANNELS.find((c) => authOfChannel(auth, c))
        if (channel === undefined) return undefined
        if (identityOf(auth) === '') return undefined
        const next = await gatedRenew(channel, auth) // 失败抛出，magpie 如实记失败
        await saveAuth(next)
        return next
      },

      /**
       * 每日签到：**按账号**（magpie 对每个账号每天调一次 —— 社区插件同款）。
       * 该渠道无签到端点 → inactive；读不到账号 → 旁路口径全渠道扫（兼容）。
       * 返回词汇表：claimed / done / inactive / ineligible / failed（+credit/streak）。
       *
       * ⚠️⚠️ **当日全渠道记账**（用户真机缺口）：magpie 的每日签到**按账号槽**
       * 调用 —— 旁路-only 渠道（如一键导入的 AutoClaw，没走过 magpie 登录）
       * 永远轮不到 ⇒ 它们的签到从没人替它执行（卡片只 +100）。修法：每次
       * checkin 调用 = 本账号渠道照签 + 顺带扫掉当日还没签的旁路渠道，
       * 返回**当日合计**（credit 求和）—— 服务端幂等（已签 → done/0），
       * 与其它账号槽的并发调用也不双计；magpie 无论取最后一次还是求和都对。
       * 失败的渠道不缓存（下次调用重试）；claimed/done 当日缓存不重打。
       */
      async checkin(getAuth) {
        const auth = await safeGetAuth(getAuth)
        const channel = CHANNELS.find((c) => authOfChannel(auth, c))
        const day = new Date().toDateString()
        if (checkinTally.day !== day) {
          checkinTally.day = day
          checkinTally.map.clear()
        }
        const tally = checkinTally.map

        if (channel !== undefined && typeof channel.checkin === 'function') {
          const cached = tally.get(channel.id)
          if (cached === undefined || cached.outcome === 'failed') {
            try {
              const credential = await ensureAuth(channel, auth)
              const outcome = await channel.checkin(credential, { xff: minimaxXff, proxy: minimaxProxy })
              tally.set(channel.id, { channel: channel.displayName, outcome: outcome.outcome, credit: Number.isFinite(outcome.credit) ? outcome.credit : undefined, message: outcome.message })
            } catch (error) {
              tally.set(channel.id, { channel: channel.displayName, outcome: 'failed', message: error instanceof Error ? error.message : String(error) })
            }
          }
        }
        // 其余有旁路的渠道：账号槽没覆盖到的在这里补签（含本账号渠道无签到端点的情况）。
        // ⚠️⚠️ 这些结果**只进页面快照**，绝不进本账号的返回信息 —— 真机报障：
        //   全渠道的签到明细被怼到**每个**账号底下（Loomy 卡片挂着 OfficeAce /
        //   MiniMax / AutoClaw… 一整屏），用户原话「谁失败在谁下面啊，你全怼到一块干嘛」。
        for (const c of CHANNELS) {
          if (typeof c.checkin !== 'function') continue
          if (tally.has(c.id)) continue
          if (!signedIn(c)) continue
          try {
            const outcome = await c.checkin(sidecarCredentialOf(c), { xff: minimaxXff, proxy: minimaxProxy })
            tally.set(c.id, { channel: c.displayName, outcome: outcome.outcome, credit: Number.isFinite(outcome.credit) ? outcome.credit : undefined, message: outcome.message })
          } catch (error) {
            tally.set(c.id, { channel: c.displayName, outcome: 'failed', message: error instanceof Error ? error.message : String(error) })
          }
        }

        // 快照同步（tally 以 displayName 为 key，反查回 channel.id）—— 全渠道都记，
        // 旁路渠道的失败在这里可见（Providers Hub 页的签到列），不打扰别的账号。
        for (const r of tally.values()) {
          const ch = CHANNELS.find((c) => c.displayName === r.channel)
          if (ch) snapshotCache.checkin.set(ch.id, r)
        }
        writeSnapshot()

        // ⚠️⚠️ 返回值：**有渠道的账号只报自己**（谁的结果在谁的卡片下面）。
        //   无渠道上下文（api key 形态）才返回全渠道汇总。
        if (channel !== undefined) {
          const own = tally.get(channel.id)
            ?? { outcome: 'inactive', message: `${channel.displayName} 无每日签到` }
          return {
            outcome: own.outcome,
            ...(Number.isFinite(own.credit) && own.credit > 0 ? { credit: own.credit } : {}),
            message: own.message ?? '',
          }
        }
        const all = [...tally.values()]
        if (all.length === 0) return { outcome: 'inactive', message: '无已登录渠道' }
        const claimed = all.filter((r) => r.outcome === 'claimed')
        const failed = all.filter((r) => r.outcome === 'failed')
        const done = all.filter((r) => r.outcome === 'done')
        const creditSum = claimed.reduce((s, r) => s + (r.credit ?? 0), 0)
        return {
          // 判定顺序：claimed（领到新额度）→ done（都签过了）→ failed → inactive
          outcome: claimed.length > 0
            ? 'claimed'
            : done.length > 0
              ? 'done'
              : failed.length > 0
                ? 'failed'
                : 'inactive',
          ...(creditSum > 0 ? { credit: creditSum } : {}),
          message: all.map((r) => `${r.channel}：${r.message ?? (r.outcome === 'claimed' ? `已领 ${r.credit ?? ''}` : r.outcome)}`).join('；'),
          channels: all,
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        const models = await discoverModels(provider.models)
        // 逐渠道模型数（key 形如 `<channel>/<model>`）+ 总数，喂给页面快照
        try {
          const perChannel = {}
          for (const key of Object.keys(models ?? {})) {
            const slash = key.indexOf('/')
            if (slash <= 0) continue
            const channelId = key.slice(0, slash)
            perChannel[channelId] = (perChannel[channelId] ?? 0) + 1
          }
          snapshotCache.perChannelModelCount = perChannel
          snapshotCache.modelCount = Object.keys(models ?? {}).length
          writeSnapshot()
        } catch { /* 快照失败不影响目录 */ }
        return models
      },
    },
  }

  /**
   * 单渠道的用量窗口（有 usage() 出分桶，没有出登录状态条；失败带原因）。
   *
   * ⚠️ **所有桶的 name 统一加渠道前缀**：一张卡平铺全部渠道的桶，
   *   没前缀时「每日签到 ×7」与别的渠道的桶混在一起无法归属（用户真机报障）。
   * ⚠️ **桶过多时按「指针方案」汇总成三档**（用户定的方案 A，不用上游
   *   15 天窗口口径）：
   *   - 临期 = **当前最早到期的那一批**（指针桶，resetsAt 即真实倒计时，
   *     200 天的桶轮到它也标真实天数 —— 自解释，无假警报）；
   *   - 长期 = 其余有到期批次的合计，resetsAt 指向其中最早 —— 指针桶一死
   *     它自动转正（12 天桶在 3 天桶烧完前显示长期，转正时还剩 9 天，
   *     来得及看到）；
   *   - 永久 = 无到期批次合计。
   *   AutoClaw 的流水批次一次能出 8+ 条，逐条平铺把卡片刷满（用户报障）。
   */
  async function usageWindowsOf(channel, credential) {
    // 已带本渠道前缀的不叠双前缀（防御旧形态旁路/测试夹具）
    const withPrefix = (name) => name.startsWith(`${channel.displayName} · `)
      ? name
      : `${channel.displayName} · ${name}`
    if (typeof channel.usage === 'function') {
      try {
        let rows = await channel.usage(credential, { xff: minimaxXff, proxy: minimaxProxy })
        if (Array.isArray(rows) && rows.length > 0) {
          rows = tierSummarize(rows)
          return rows.map((row) => ({ ...row, name: withPrefix(typeof row?.name === 'string' ? row.name : '') }))
        }
      } catch (error) {
        return [{
          name: channel.displayName,
          used: 0,
          display: `额度查询失败：${error instanceof Error ? error.message : String(error)}`,
        }]
      }
    }
    return [{
      name: channel.displayName,
      used: 0,
      display: channel.expired?.(credential) ? '已过期，请重新登录' : '已登录',
    }]
  }

  /**
   * 旁路口径的全渠道扫（auth.usage 无账号上下文时 / 页面 read('refresh') 共用）。
   * 每个已登录渠道走 ensure（临期软续期）再查桶；结果同步进快照缓存。
   */
  async function sweepAllUsage() {
    const windows = []
    for (const each of CHANNELS) {
      if (!signedIn(each)) continue
      // ⚠️ 走 ensure（临期软续期）：AutoClaw 的 access_token 只活 24h，
      //    旁路凭据不续期的话卡片第二天就报「额度查询失败」。
      let credential
      try {
        credential = await ensure(each)
      } catch {
        credential = sidecarCredentialOf(each)
      }
      if (credential === undefined) continue
      const eachWindows = await usageWindowsOf(each, credential)
      snapshotCache.buckets.set(each.id, eachWindows)
      windows.push(...eachWindows)
    }
    return windows
  }
}
