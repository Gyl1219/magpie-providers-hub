// 多供应商层：**一个插件，五条供应商**（每个供应商 = 一个渠道）。
//
// ## 形态：一个渠道一个供应商（v0.4.0 起）
//
// `makeHubPlugin(channel)` 为每个渠道造一个插件函数；`index.mjs` 导出五个
// ⇒ magpie 里出现五条供应商（`hub-astudio`、`hub-accio`…），各自登录/额度/
// 开关/故障转移。模型 id 由 magpie 拼成 `hub-astudio/glm-5.3`（**渠道前缀已去掉**，
// 因为一个供应商只服务一个渠道）。
//
// 历史：v0.3.x 是「一个供应商 `providers-hub` 内部聚合十渠道」，模型 id 形如
// `providers-hub/officeace/glm-5.3`。拆开的原因：magpie 的 failover / 单渠道开关
// 都是 **provider 粒度**，聚合形态下二者都做不到（见 README「已知边界」）。
// v0.5.0 起只保留五条：与社区 registry 现有插件重叠的五条已从包里删除，见 index.mjs 头注。
//
// ## 凭据：只存 magpie 账号槽（多账号），插件侧只在内存里流转
//
// 每次登录 = 一个账号条目，auth 里带 `channel` 字段标记归属渠道 ——
// 同渠道可挂多个账号（不再互相覆盖），magpie 网关在额度耗尽时自动换槽。
// 旧版（聚合形态）在 `providers-hub*` 槽里的账号由 `migrateLegacySlots()` 一次性搬过来。
//
// ⚠️⚠️ **v0.5.0 起插件不写任何宿主文件**（PR #502 审核第 2 条）：
//   · 账号槽是唯一落盘位置（`client.auth.set`），magpie 自己的文件它自己写；
//   · 插件侧只在 `memoryCredentials` 里缓存本进程见过的凭据，进程结束即消失；
//   · 曾经那份「旁路凭据文件」已删 —— 它写在 magpie 的配置目录里且默认 0644，
//     本机任何用户可读（yetone 在第 2 条里点名）。
//   副作用：冷启动时 sweep 没有凭据，靠实例的 `authGetters` 向 magpie 要一次。
//
// ## 为什么去重闸按「凭据身份」而不是渠道 id 键控
//
// refresh_token 会轮换的渠道（如 accio），同渠道两个账号并发续期是**合法**场景 ——
// 按渠道键控会让第二个账号共享第一个的续期结果（拿到别人的凭据）。
// 按 `channel + refresh_token`（或 access）键控：同一凭据并发共享一个在途请求，
// 不同凭据各走各的。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { notSignedIn, untilText, readMagpieAuthSlots, readOwnAuthEntries, debugLog } from './shared.mjs'
import { join } from 'node:path'
import { astudioChannel } from './astudio.mjs'
import { accioChannel } from './accio.mjs'
import { lobsteraiChannel } from './lobsterai.mjs'
import { magicrewChannel, magicrewIntlChannel } from './magicrew.mjs'

/** 旧版（聚合形态）的供应商 id —— 账号槽迁移的读来源，别再拿去注册。 */
const LEGACY_PROVIDER = 'providers-hub'

/** 新供应商 id 前缀：`hub-<渠道 id>`。⚠️ ASCII、发布后不可改（登录态/模型名按它认领）。 */
const HUB_PREFIX = 'hub-'

/** 渠道显示名的覆盖（当前五条都用渠道自己的 displayName，保留机制备用）。 */
const PROVIDER_NAME_OVERRIDES = {}

/**
 * 所有注册进来的渠道 —— **只有五条**。
 *
 * ⚠️ 与社区 registry 现有插件重叠的五条（OfficeAce / AutoClaw 国内+国际 /
 *    Loomy / MiniMax 国际版）已在 v0.5.0 **从包里删除**（PR #502 审核意见）。
 *    删代码而不只是「不注册」的两个理由：它们各自带着与本插件无关的敏感能力
 *    （AutoClaw 的 DPAPI 解密他人凭据、MiniMax 国际版的 XFF 伪造），留着就是
 *    给审核和使用者添加风险面。老用户改装对应的社区插件即可，README 有指引。
 */
const CHANNELS = [astudioChannel, accioChannel, lobsteraiChannel, magicrewChannel, magicrewIntlChannel]

/** 供应商 id / 显示名（一个渠道一个供应商）。 */
export const providerIdOf = (channel) => `${HUB_PREFIX}${channel.id}`
export const providerNameOf = (channel) => PROVIDER_NAME_OVERRIDES[channel.id] ?? channel.displayName
export const PROVIDER_IDS = CHANNELS.map(providerIdOf)

/** registry 条目列的就是这五个（旧名，工具与文档沿用）。 */
export const DEFAULT_PROVIDER_IDS = PROVIDER_IDS

// 供测试遍历 stub（authorize 契约测试必须覆盖每一个渠道，漏一个就会真发网络请求）
export { CHANNELS as REGISTERED_CHANNELS }

/** magpie 在到期前这么多毫秒调 auth.refresh（对齐各渠道 10 分钟临期口径）。 */
const REFRESH_LEAD_MS = 10 * 60 * 1000

/**
 * loader 的占位 baseURL（每个供应商一个 `.invalid` 保留域）。
 *
 * ⚠️ 不能留空串：magpie 会据此判「无处可发」（`nowhere to send its requests`）。
 *    本插件的请求全部在 `loader().fetch` 里改写到各上游，这个域名不会被真正访问；
 *    用 `.invalid`（RFC 2606）保证即使漏拦截也不会打到真实主机。
 */
const placeholderBaseOf = (providerId) => `https://${providerId}.invalid`

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

// ── 凭据：**只在内存里**，绝不落盘 ──────────────────────────────────────
//
// ⚠️ PR #502 审核（yetone）第 2 条：插件不得往 magpie 的配置目录写文件。
//    旧实现在 magpie 的配置目录里为每个渠道写一份「旁路凭据」文件
//    （`writeFileSync` 不指定 mode ⇒ 默认 umask 0644，本机任何用户可读），
//    路径还用 `homedir()` 拼 —— 设了 `XDG_CONFIG_HOME` 或用便携版 magpie 时
//    指的就不是 magpie 真正的目录。
//    ⇒ 现在：**账号只存 magpie 账号槽**（`client.auth.set` / `getAuth`），
//      插件侧最多在内存里缓存本进程见过的那份，进程结束即消失。
const memoryCredentials = new Map()

/** 记住/更新本进程见过的凭据（纯内存，不触盘）。 */
function rememberCredential(channel, credential) {
  if (credential === undefined || credential === null) memoryCredentials.delete(channel.id)
  else memoryCredentials.set(channel.id, credential)
  return credential
}

/** 本进程缓存里该渠道的凭据（冷启动为空 —— sweep 靠下面的 authGetters 补）。 */
const cachedCredentialOf = (channel) => memoryCredentials.get(channel.id)

/**
 * 每个供应商实例的 `getAuth`（模块级收集，供模块级 sweep 取凭据）。
 * ⚠️ 插件是「每账号一份凭据」，sweep 没有 magpie 的调用栈，只能借实例的 getAuth。
 */
const authGetters = new Map()

// ── 续期：去重闸 ────────────────────────────────────────────────────────

/**
 * **聚合层级的续期去重闸**：同一凭据同一时刻只允许一个在途续期。
 *
 * ⚠️ 键是 `channel + 凭据身份`（见文件头）—— 同渠道多账号互不串号，
 *    同一账号的并发入口（loader 临期软续期 / chat 401 硬续期 / magpie refresh）
 *    共享同一个在途请求。
 *
 * ⚠️ refresh_token 一次性渠道的「消费即记住」纪律：渠道 refresh 的第二参
 *    persist 回调只更新内存缓存；账号槽由 magpie 的 refresh 返回值和
 *    `client.auth.set` 落定（插件不写任何宿主文件）。
 */
const renewInFlight = new Map()

function gatedRenew(channel, current) {
  const key = channel.id + '\n' + identityOf(current)
  const pending = renewInFlight.get(key)
  if (pending !== undefined) return pending
  const bare = credentialOfAuth(current)
  const task = channel.refresh(bare, (partial) => rememberCredential(channel, partial))
    .then((next) => {
      // current 是 auth（带 channel 字段）就合并回 auth 形状；是裸凭据就保持裸
      // ⚠️ type 认 'success'（我们写进账号槽的形状）与 'oauth'（社区插件形状）
      const merged = current?.type === 'oauth' || current?.type === 'success'
        ? { ...current, ...next }
        : next
      return rememberCredential(channel, merged)
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

/** 内存缓存取凭据 + 临期软续期（没有 ⇒ 未登录；不再有磁盘兜底）。 */
async function ensure(channel) {
  let current = cachedCredentialOf(channel)
  if (!current) throw notSignedIn(`未登录：请先在插件里登录 ${channel.displayName}`)
  if (channel.expired?.(current)) current = await renewSoft(channel, current)
  return current
}

/** 账号路径的取凭据 + 临期软续期（只更新内存，不写文件）。 */
async function ensureAuth(channel, auth) {
  let current = auth
  if (channel.expired?.(auth)) current = await renewSoft(channel, auth)
  return rememberCredential(channel, current)
}

/** 本进程见过该渠道的凭据（内存口径 —— 目录/签到/额度共用）。 */
const signedIn = (channel) => Boolean(cachedCredentialOf(channel))

// ── 目录：单渠道目录，key 不带渠道前缀 ────────────────────────────────────

/**
 * 一个供应商只有一个渠道 ⇒ 模型 id 就是**渠道自己的模型名**（`glm-5.3`）。
 * magpie 展示/选择时自动补供应商名前缀，呈现为 `hub-officeace/glm-5.3`。
 * ⚠️ 别再加渠道前缀：那会变成 `hub-officeace/officeace/glm-5.3`。
 *
 * ⚠️⚠️ `auth` 必须由调用方（`provider.models` 的第二个参数）传进来
 * （2026-10-31 真机：magicrew 卡片显示「0 models」）。v0.5.0 去掉旁路凭据文件后，
 * 凭据只在 `memoryCredentials` 里 —— **冷启动那一刻内存是空的**，`signedIn()`
 * 为假 ⇒ 连远端目录都不去拉 ⇒ 退回兜底表；而 magicrew 这类「目录只在远端」的
 * 渠道兜底表是空的 ⇒ 0 个模型。magpie 调 `models()` 时会把当前账号的 auth
 * 作为第二参传进来（社区插件 `async models(provider, { auth })` 同款），用它即可，
 * 顺带把凭据写进内存缓存（后续 sweep / chat 就有了）。
 */
async function discoverModels(channel, fallback, auth) {
  let models
  let credential
  if (authOfChannel(auth, channel)) {
    credential = await ensureAuth(channel, auth) // 同时写进 memoryCredentials
  } else if (signedIn(channel)) {
    credential = await ensure(channel)
  }
  if (credential !== undefined) {
    try {
      models = await channel.catalog(credential)
    } catch {
      // 拉目录失败退回该渠道自己的兜底目录（选择器不会空掉）
      models = undefined
    }
  }
  if (!models || Object.keys(models).length === 0) {
    models = channel.fallbackModels ?? {}
  }
  return Object.keys(models).length > 0 ? models : fallback
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
 * 本进程的身份标记。
 *
 * ⚠️⚠️ 为什么需要它（PR #502 审核 2026-10-30，真机事故）：快照文件是**磁盘上的一份**
 *    共享状态，`buildSnapshot()` 原本会「本次没查到桶 → 沿用上一份快照的桶」。
 *    于是打包时若把本地生成的 snapshot.js 带进 npm 包，
 *    新用户装上后、还没登录时，就会把**打包者机器上的余额与签到结果**当成自己的看到。
 *    ⇒ 快照里写 runId，读回来只在 runId 相同（= 同一进程写的）时才沿用。
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

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
  // ⚠️⚠️ 只沿用**本进程**写过的快照（PR #502 审核 2026-10-30）：
  //    旧实现无条件读磁盘上那份 —— 于是「装了这个包的新用户」在还没登录时，
  //    buildSnapshot 会把**别人（打包者）机器上的余额与签到结果**当成自己的显示出来。
  //    runId 是进程启动时生成的随机串：同进程内沿用（models() 触发时桶为空不至于
  //    把整列刷成「—」），跨进程/跨安装一律不沿用（读到旧 runId 就丢弃）。
  const previousRaw = readPreviousSnapshot()
  const previous = previousRaw?.runId === RUN_ID ? previousRaw : undefined
  // 每渠道的 magpie 账号槽数：一个渠道一个供应商，槽的 key 形如 `hub-<渠道>` /
  // `hub-<渠道>#<slot>`。accountId 相同 = 原地更新（magpie 原生语义）；
  // 不同 accountId 并存 = 真多账号。
  // ⚠️ 只读**本插件自己**的槽（`hub-*` / `providers-hub*`）—— 别的供应商的 auth
  //    连值都不碰（PR #502 审核第 3 条）。
  const slots = readOwnAuthEntries()
  const channels = CHANNELS.map((channel) => {
    const credential = cachedCredentialOf(channel)
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
    // ⚠️ 只数**本供应商名下**的槽（`hub-<渠道>` / `hub-<渠道>#<slot>`）：
    //    0.3.x 的旧槽 `providers-hub#<slot>` 的 channel 也是 officeace，迁移是
    //    复制不是删（magpie 的地盘只写不删）—— 一起数会出「2 个账号」的鬼影
    //    （真机 2026-10-29：同一份凭据被算成两个账号）。
    const providerKey = providerIdOf(channel)
    const accountSlots = slots.filter(
      (s) => s.channel === channel.id && (s.key === providerKey || s.key.startsWith(`${providerKey}#`)),
    ).length
    return {
      id: channel.id,
      // 该渠道对应的 magpie 供应商 id（页面上「关掉哪个供应商会关掉它」）
      provider: providerIdOf(channel),
      displayName: channel.displayName,
      signedIn: signedInNow,
      ...(expired ? { expired: true } : {}),
      ...(accountSlots > 0 ? { accounts: accountSlots } : {}),
      modelCount: snapshotCache.perChannelModelCount?.[channel.id] ?? 0,
      buckets,
      ...(ck ? { checkin: { outcome: ck.outcome, credit: ck.credit, message: ck.message } }
        : (old?.checkin ? { checkin: old.checkin } : {})),
    }
  })
  return {
    at: Date.now(),
    // 本进程的身份标记：跨进程读回来时据此判断「这份快照是不是我写的」
    runId: RUN_ID,
    provider: 'Providers Hub',
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
  /**
   * 批大小（求和用）。
   * ⚠️ 优先读 `_qty`：LobsterAI 的 `amount` 现在是 magpie 语义的「已用量」
   *    （有分母时），不能再兼任「这批还剩多少」—— 两者语义相反。
   *    没有 `_qty` 的老行仍按 `amount` 当批大小（向后兼容）。
   */
  const qtyOf = (r) => {
    const q = r?._qty
    if (typeof q === 'number' && Number.isFinite(q)) return q
    const a = r?.amount
    return typeof a === 'number' && Number.isFinite(a) ? a : undefined
  }
  /** 输出前删掉私有字段（magpie 不认识，也不该看到）。 */
  const clean = (r) => {
    if (r === null || typeof r !== 'object' || r._qty === undefined) return r
    const { _qty, ...keep } = r
    return keep
  }
  const summable = rows.filter((r) => {
    const q = qtyOf(r)
    return typeof q === 'number' && Number.isFinite(q) && q > 0
  })
  if (summable.length <= 3) {
    // 小组数渠道保留原始命名，但**到期字段仍要剥**（浅灰行去重，用户报障）；
    // 渠道行带 runsOutAt 只是给本函数的分类输入，不该漏到卡片上。
    // ⚠️ resetsAt 例外：走势图投影虚线（even burn）只认它，剥了就没线。
    return rows.map((r) => {
      if (!summable.includes(r)) return clean(r)
      const { runsOutAt, runsOut, ...keep } = r
      return clean(keep)
    })
  }
  const rest = rows.filter((r) => !summable.includes(r))
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
      name: `临期 · 剩 ${tidyNumber(qtyOf(pointer))}`,
      // ⚠️ display 只放倒计时 —— 剩余量已在 name 里（重复了用户会看到两遍）；
      //    倒计时必须进**亮色主文本**：「将于 X 过期」辅助行浅灰看不清（用户报障）
      display: untilText(expiry) ?? `剩 ${tidyNumber(qtyOf(pointer))}`,
    })
    // ⚠️ 刻意不挂 runsOutAt/runsOut：亮色行已带倒计时，再挂会让 magpie 渲染
    //    出第三行浅灰「N 将于 X 过期」（用户报障：重复）。
    //
    // ⚠️⚠️ 但 **resetsAt 必须留下**（2026-10-31 真机，LobsterAI 卡片没有走势虚线）：
    //    magpie 的 even-burn 投影线只认窗口的 resetsAt ——
    //      let reset = l.window.resetsAt ? Date.parse(l.window.resetsAt) : last.reset
    //      if (c.reset && c.start < c.reset && !short) → 画虚线
    //    这里删掉它，26 批汇总出来的行就没有窗口终点，图上只剩空坐标轴。
    delete out[out.length - 1].runsOutAt
    delete out[out.length - 1].runsOut
  }
  const longTerm = expiring.slice(1)
  if (longTerm.length > 0) {
    const earliest = longTerm[0]
    // ⚠️ 浮点流水求和会有漂移（2158.4905040000003）—— 先求和再收口到两位
    const amount = tidyNumber(longTerm.reduce((s, r) => s + qtyOf(r), 0))
    const expiry = expiryOf(earliest)
    // ⚠️ untilText() 本身已带「…后作废」，不要再拼「作废」（否则出「作废作废」）
    const untilEarliest = untilText(expiry)
    /**
     * 合并窗口的分母：**每批分母之和**（只有当每一批都给出了 limit 才算，
     * 缺一批就不给 —— 半真半假的比例比没有更误导）。
     *
     * ⚠️⚠️ 算不出整组分母时，必须把 `...earliest` 带进来的单批
     *    limit/amount/used **一起剥掉**：否则 26 批合计 2558.49 会顶着
     *    单批的 `limit: 100` 上卡，显示成「2558.49 / 100」这种荒谬数字
     *    （2026-10-31 真机复现）。
     */
    const limits = longTerm.map((r) => r.limit)
    const amounts = longTerm.map((r) => r.amount)
    const wholeGroup = limits.every((v) => typeof v === 'number' && Number.isFinite(v))
      && amounts.every((v) => typeof v === 'number' && Number.isFinite(v))
    const limitSum = wholeGroup ? tidyNumber(limits.reduce((s, v) => s + v, 0)) : undefined
    const usedSum = wholeGroup ? tidyNumber(amounts.reduce((s, v) => s + v, 0)) : undefined
    const { limit: _dropLimit, amount: _dropAmount, used: _dropUsed, ...mergedBase } = earliest
    out.push({
      ...mergedBase,
      name: `长期（${longTerm.length} 批）· 剩 ${amount}`,
      amount: Number(amount),
      display: untilEarliest !== undefined ? `最早 ${untilEarliest}` : `剩 ${amount} · ${longTerm.length} 批`,
      ...(limitSum !== undefined && usedSum !== undefined
        ? {
            limit: Number(limitSum),
            amount: Number(usedSum),
            used: limitSum > 0 ? Math.round((usedSum / limitSum) * 100) : 0,
          }
        // ⚠️ 分母凑不齐时**仍给 used: 0**：magpie 的 quotaNoShare 判 `used == null`
        //    ⇒ 缺了它整行退化成纯文本（没有百分比、没有进度条），比"条恒满"更糟
        //    （用户 2026-10-31 的诉求就是要看到条）。只剥 limit/amount。
        : { used: 0 }),
    })
    // 同上：runsOutAt/runsOut 去掉（重复行），resetsAt 留着（走势虚线要它）
    delete out[out.length - 1].runsOutAt
    delete out[out.length - 1].runsOut
  }
  if (permanent.length > 0) {
    const amount = tidyNumber(permanent.reduce((s, r) => s + qtyOf(r), 0))
    out.push({
      name: permanent.length === 1 && typeof permanent[0].name === 'string' ? permanent[0].name : `永久 · 剩 ${amount}`,
      used: 0,
      amount: Number(amount),
      display: `剩 ${amount}`,
    })
  }
  return [...out, ...rest].map(clean)
}

/** 模块级 sweep 状态（十个实例共用一个定时器）。 */
const sweepState = { timer: undefined, everyMs: undefined, xff: undefined, proxy: undefined }

/** 当日签到记账（十个实例共享 —— 同一渠道不会重复签）。 */
const dailyCheckin = { day: '', map: new Map() }

function checkinTallyOf() {
  const day = new Date().toDateString()
  if (dailyCheckin.day !== day) {
    dailyCheckin.day = day
    dailyCheckin.map.clear()
  }
  return dailyCheckin.map
}

/**
 * 一个渠道的用量窗口（有 usage() 出分桶，没有出登录状态条；失败带原因）。
 *
 * ⚠️ 不加渠道名前缀：一个供应商卡片只有一个渠道，前缀是重复信息（旧聚合形态下
 *   才有「一张卡平铺全部渠道」的归属问题）。
 * ⚠️ **桶过多时按「指针方案」汇总成三档**（用户定的方案 A，不用上游 15 天窗口口径）：
 *   - 临期 = **当前最早到期的那一批**（指针桶，display 即真实倒计时，200 天的桶
 *     轮到它也标真实天数 —— 自解释，无假警报）；
 *   - 长期 = 其余有到期批次的合计，指向其中最早 —— 指针桶一死它自动转正；
 *   - 永久 = 无到期批次合计。
 *   AutoClaw 的流水批次一次能出 8+ 条，逐条平铺把卡片刷满（用户报障）。
 */
async function usageWindowsOf(channel, credential, extras = {}) {
  if (typeof channel.usage === 'function') {
    try {
      const rows = await channel.usage(credential, { xff: extras.xff, proxy: extras.proxy })
      if (Array.isArray(rows) && rows.length > 0) return tierSummarize(rows)
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

/** 该渠道在 magpie 里有没有账号槽（有 = 签到由 magpie 按账号调；没有 = 得自己补签）。 */
function hasAccountSlot(channel) {
  // ⚠️ 只读本插件自己的槽（前缀过滤），别人的 auth 不经过这里。
  return readOwnAuthEntries().some((entry) => entry.channel === channel.id)
}

/**
 * 旁路-only 渠道的每日补签（模块级 sweep 调用）。
 *
 * 没有走过 magpie 登录 ⇒ 没有账号槽 ⇒ magpie 永远不会为它调 checkin。
 * 结果只写页面快照（不进任何账号的返回信息）。
 *
 * ⚠️ 凭据来源：本进程内存缓存为空时（冷启动），借**实例的 getAuth** 取一次
 *   （`authGetters`），取不到就跳过 —— 不再有磁盘旁路可读。
 */
async function sweepCheckins() {
  const tally = checkinTallyOf()
  for (const channel of CHANNELS) {
    if (typeof channel.checkin !== 'function') continue
    if (!signedIn(channel)) continue
    if (hasAccountSlot(channel)) continue
    const cached = tally.get(channel.id)
    if (cached !== undefined && cached.outcome !== 'failed') continue
    try {
      const outcome = await channel.checkin(cachedCredentialOf(channel))
      tally.set(channel.id, {
        channel: channel.displayName,
        outcome: outcome.outcome,
        credit: Number.isFinite(outcome.credit) ? outcome.credit : undefined,
        message: outcome.message,
      })
    } catch (error) {
      tally.set(channel.id, {
        channel: channel.displayName,
        outcome: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const row = tally.get(channel.id)
    snapshotCache.checkin.set(channel.id, row)
  }
}

/** 迁移只做一次的 promise 缓存（每个供应商一条）。 */
const migrationsStarted = new Map()

/** 仅供测试：模块级 sweep / 迁移入口（不从 index.mjs 导出）。 */
export const _internal = {
  sweepAllChannels: async () => {
    await sweepAllChannels()
    writeSnapshot()
  },
  resetMigrations: () => migrationsStarted.clear(),
  /** 测试用：直接喂一份内存凭据（不再落盘，见 memoryCredentials）。 */
  rememberCredential: (channel, credential) => rememberCredential(channel, credential),
  /** 测试用：读回内存里的凭据（替代旧的磁盘旁路断言）。 */
  cachedCredentialOf: (channel) => cachedCredentialOf(channel),
  /** 测试里前面用过 notify:false（会关掉快照写入），这里显式打开。 */
  enableSnapshotWrites: () => { snapshotWritesDisabled = false },
}

/**
 * 旧版（聚合形态 v0.3.x）账号槽 → 新供应商槽的一次性迁移。
 *
 * 旧槽 key = `providers-hub` / `providers-hub#<slot>`，槽里有 `channel` 字段；
 * 新槽 key = `hub-<渠道 id>`。不迁移的话，用户升级后每张卡都显示「未登录」
 * （旁路凭据还在，对话其实还能用，但账号槽丢了 magpie 的换号/签到）。
 *
 * 幂等：新槽已有内容就跳过；写的是 magpie 的地盘，但只经 `client.auth.set`。
 */
async function migrateLegacySlots(authSet, channel, providerId) {
  if (typeof authSet !== 'function') return
  const started = migrationsStarted.get(providerId)
  if (started !== undefined) return started
  const task = (async () => {
    try {
      if (readMagpieAuthSlots(providerId).length > 0) return
      // ⚠️ 只读**旧版本插件自己的槽**（`providers-hub*`）；withValue 是因为要整份复制。
      const legacy = readOwnAuthEntries({ providerId: LEGACY_PROVIDER, withValue: true })
        .filter((entry) => entry.channel === channel.id)
      for (const entry of legacy) {
        try {
          await authSet({ path: { id: providerId }, body: entry.value })
          debugLog(`migrated slot ${entry.key} → ${providerId}`)
        } catch (e) {
          debugLog(`migrate failed ${entry.key}: ${e.message}`)
        }
      }
    } catch { /* 迁移失败不影响启动：旁路兜底 */ }
  })()
  migrationsStarted.set(providerId, task)
  return task
}

/**
 * 全渠道扫描（模块级定时器专用）：每渠道查额度桶 + 旁路-only 渠道补签。
 * 结果同步进快照缓存，供侧边栏页读取。
 */
async function sweepAllChannels() {
  for (const each of CHANNELS) {
    // ⚠️ 凭据来源只有两条：本进程内存缓存，或**该实例的 getAuth**（冷启动用）。
    //    不再有磁盘旁路可读（v0.5.0 起插件不写任何宿主文件）。
    const getAuth = authGetters.get(each.id)
    if (typeof getAuth === 'function') {
      let auth
      try { auth = await getAuth() } catch { auth = undefined }
      if (authOfChannel(auth, each)) {
        try { await ensureAuth(each, auth) } catch { /* 续期失败沿用原凭据 */ }
      }
    }
    if (!signedIn(each)) continue
    let credential
    try {
      credential = await ensure(each)
    } catch {
      credential = undefined
    }
    if (credential === undefined) continue
    const eachWindows = await usageWindowsOf(each, credential, {})
    snapshotCache.buckets.set(each.id, eachWindows)
  }
  await sweepCheckins()
}

/**
 * 一个渠道 → 一个插件函数（= magpie 的一个供应商）。
 *
 * ⚠️ `index.mjs` 只能导出本工厂**造出来的成品函数**；工厂本身不能从入口导出 ——
 *    magpie 把入口模块里的**每个函数导出**都当成一个插件（社区包同款：
 *    `opencode-trae-auth` 一个模块导出两个插件函数 = 两个供应商）。
 */
export const makeHubPlugin = (channel) => async (input, options = {}) => {
  const PROVIDER = providerIdOf(channel)
  const PROVIDER_NAME = providerNameOf(channel)
  const openBrowser = typeof options.openBrowser === 'function' ? options.openBrowser : undefined
  /**
   * ⚠️ **本插件不写 magpie 的任何宿主文件**（magpie 那张市场列表的缓存 JSON
   * 一次都不碰 —— 具体路径见 tools/self-register.mjs 头注）。
   *
   * 曾经做过自注册（加载时把本插件写进市场缓存，好让卡片标题/「源码」按钮出现），
   * 2026-10-30 撤掉：社区 registry 的 PR 审核明确卡这一条 —— MYCF711 的
   * `officeace-auth` #399 在 10-27 被 block，理由就是「self-register 每次加载都重写
   * magpie 的市场缓存」，他被迫在 0.1.9 里整个删掉才通过。审核的 grep 标准是
   * 「no fs writes, child_process, eval or HOME/cache paths」。
   *
   * 卡片标题/绿标的正路是 **registry.json 收录**（PR 进 magpie-community/plugins），
   * 不是本地改缓存。
   *
   * ⚠️⚠️ **也没有系统通知了**（PR #502 审核第 1 条：Windows 上 spawn PowerShell 拼
   *    字符串存在命令注入 —— 外部文案来自厂商接口，`esc()` 不转义单引号）。登录/签到
   *    结果只走 `client.tui.showToast`（宿主原生渲染，无任何文本拼接进脚本）。
   */
  // 快照写入开关（模块层 writeSnapshot 读这个变量 —— 见其定义处的说明）
  snapshotWritesDisabled = options.notify === false
  /** magpie 的 auth 存储（社区插件同款 `client.auth.set`）。 */
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
    } catch { /* magpie 存储失败不阻断 */ }
  }
  /** getAuth 的安全包装（未登录/异常 → undefined，不抛）。 */
  const safeGetAuth = async (getAuth) => {
    try {
      return typeof getAuth === 'function' ? await getAuth() : undefined
    } catch {
      return undefined
    }
  }
  // ⚠️ 模块级 sweep 取凭据靠实例的 getAuth（插件不再从磁盘读任何凭据）。
  //    magpie 的 getAuth 是按账号取的；冷启动 sweep 借它把内存缓存填上。
  authGetters.set(channel.id, async () => {
    const auth = await safeGetAuth(input?.client?.auth?.get)
    return auth
  })

  /** 请求体里的 model 可能是 `glm-5.3` / `hub-officeace/glm-5.3` / 旧 `officeace/glm-5.3`。 */
  const resolve = (modelId) => {
    const parts = String(modelId ?? '').trim().split('/').filter((s) => s !== '')
    if (parts.length === 0) return undefined
    const model = parts[parts.length - 1]
    if (model === '') return undefined
    if (parts.length === 1) return { channel, model }
    // 前缀必须属于本供应商（magpie 供应商前缀 / 渠道 id / 旧聚合形态），
    // 别的供应商的模型打到我们头上 → 404，别静默转发到本渠道。
    const prefix = parts[parts.length - 2]
    const outer = parts.length >= 3 ? parts[parts.length - 3] : undefined
    const ours = prefix === PROVIDER || prefix === channel.id || outer === PROVIDER || outer === LEGACY_PROVIDER
    return ours ? { channel, model } : undefined
  }

  // ── 宿主侧定时刷新快照（模块级唯一的定时器，十个实例共用）──
  //
  // magpie 只在用量页/目录刷新时调 usage —— 页面快照可能一小时都不更新
  // （用户报障：等半天没刷新）。宿主是常驻进程：**自己定时**查一遍已登录
  // 渠道并写快照，侧边栏页的「刷新周期」才有新东西可读。
  //
  // ⚠️ 定时器必须 only-once（十个供应商实例各起一个就是十个定时器）；放模块级。
  // ⚠️ 测试进程不弹通知（options.notify:false），但 sweep 定时器**无条件启动**
  //    （unref 不驻留进程，node --test 不会假死；生产靠它保证快照新鲜 ——
  //    ⚠️ 不能用 NODE_TEST_CONTEXT 判断测试：magpie 的 bun 宿主环境里它有值，
  //    会把生产 sweep 整个关掉）。可用 options.snapshotRefreshMinutes 调（默认 5 分钟，0 = 关闭）。
  const sweepMinutes = Number(options.snapshotRefreshMinutes)
  const sweepEveryMs = (Number.isFinite(sweepMinutes) && sweepMinutes > 0 ? sweepMinutes : 5) * 60_000
  if (sweepMinutes !== 0 && sweepState.everyMs === undefined) {
    sweepState.everyMs = sweepEveryMs
    sweepState.timer = setInterval(() => {
      void sweepAllChannels().then(() => writeSnapshot()).catch(() => {})
    }, sweepEveryMs)
    sweepState.timer.unref?.()
  }

  /** 本渠道的用量窗口。 */
  const windowsOf = (credential) => usageWindowsOf(channel, credential, {})

  // ── 账号导入（magpie 原生表单，不开浏览器窗口、不监听端口）─────────────────
  //
  // 两个入口都是 magpie 的 `type:'api'` + `keyless:true` 方法：
  //   窗口先按 `prompts` 逐题问（/api/plugin-signin/prompt → 宿主的 nextPrompt），
  //   答完以 `key:''` 调 `authorize(inputs)`。
  // 全程在 magpie 自己的供应商编辑器里 —— 主题/键盘/校验都是宿主的，
  // 不打开网页、不起 http server、不写任何宿主文件。
  //
  // ⚠️ 结果形状（宿主 save() 的两条分支）：
  //    · 带 `refresh` → setAuth(at, {type:'oauth', refresh, access, expires, ...extra})，
  //      再由 settle() 把同 accountId 的旧槽合并（重复导入不产生重复账号）；
  //    · 否则带 `key`（keyless 时是空串，falsy）→ 写成 api 槽；
  //    · 两者都没有 → **一个字段都不写**，settle 返回 false（连 auth 事件都不发，
  //      账号列表不刷新）。所以**第一个**账号以 oauth 形状交回宿主写，第 2..N 个自己写。
  // ⚠️ 宿主的槽形状是 `access`/`refresh`，而本插件 loader 与渠道读的是
  //    `access_token`/`refresh_token`/`expires_at` —— 结果里把凭据再原样带一份，
  //    它们会进 `...extra` 一起落槽（`credentialOfAuth` 只剥 type/channel/expires/accountId）。

  /** 渠道声明的导入器（没声明 importCredential 的渠道就没有导入入口）。 */
  const importSpec = channel.importCredential ?? undefined

  /**
   * 同一个 token 已经在本渠道某个槽里 → 返回那个槽。
   *
   * 为什么需要（真机实测）：官方导出的昵称是**打码的**（`170****7196`），导入时联网
   * 校验能拿到真名（`17027477196`）⇒ accountId 变了 ⇒ 宿主的 settle 认不出是同一个
   * 账号，在旧槽旁边又建一行（同一个账号两行）；而且旧槽里的 refresh_token 会随覆盖
   * 一起丢（只剩 access_token 就没法续期）。按 token 命中旧槽后：账号名沿用旧的
   * （settle 按 whoOf 合并），续期字段也补齐。
   */
  const sameSlotOf = (credential) => {
    const mine = [credential?.access_token, credential?.refresh_token]
      .filter((token) => typeof token === 'string' && token !== '')
    if (mine.length === 0) return undefined
    try {
      return readMagpieAuthSlots(PROVIDER).find((slot) => {
        if (slot.channel !== channel.id) return false
        const theirs = [slot.accessToken, slot.refreshToken]
          .filter((token) => typeof token === 'string' && token !== '')
        return theirs.some((token) => mine.includes(token))
      })
    } catch {
      return undefined
    }
  }

  /** 老槽有、这次没有的续期字段（refresh_token / expires_at / uid）—— 补上再交回去。 */
  const withPreviousSlot = (credential) => {
    const previous = sameSlotOf(credential)
    if (previous === undefined) return credential
    const filled = { ...credential }
    if (typeof filled.refresh_token !== 'string' && previous.refreshToken !== '') {
      filled.refresh_token = previous.refreshToken
    }
    if (filled.expires_at === undefined && previous.expiresAt !== '') filled.expires_at = previous.expiresAt
    if (filled.uid === undefined && previous.uid !== '') filled.uid = previous.uid
    if (filled.user_id === undefined && previous.userId !== '') filled.user_id = previous.userId
    return filled
  }

  /**
   * 旧槽比这份凭据更晚到期 → 覆盖反而是降级（抄自 magpie-wpt 的防御约定）。
   *
   * 场景：用户手上有一份半年前的导出文件（access 还有效、refresh 早被别处消费），
   * 又或者从别的小号抄错了行；导进去会把旧槽里更新鲜的凭据顶掉，账号从此更早过期。
   * 只提示**不拦** —— 判断依据是两份凭据自报的到期时间，用户可能就是要换新设备登录。
   */
  const downgradeWarningOf = (credential) => {
    const previous = sameSlotOf(credential)
    if (previous === undefined) return undefined
    const before = previous.expires ?? expiresMsOf({ expires_at: previous.expiresAt })
    const next = expiresMsOf(credential)
    if (before === undefined || next === undefined) return undefined
    if (before <= next + 60_000) return undefined
    const day = (ms) => new Date(ms).toISOString().slice(0, 10)
    return '旧账号的凭据比这份更新（旧 ' + day(before) + ' 到期 / 新 ' + day(next) + ' 到期），覆盖反而会让账号更早过期'
  }

  /** 账号卡片名（= accountId；重复导入与宿主 settle 都按它认账号）。 */
  const importAccountId = (credential) => {
    const same = sameSlotOf(credential)
    if (typeof same?.accountId === 'string' && same.accountId !== '') return same.accountId
    try {
      const id = importSpec?.accountIdOf?.(credential)
      return typeof id === 'string' && id !== '' ? id : channel.displayName
    } catch {
      return channel.displayName
    }
  }

  /** 账号槽里的 auth（本插件的形状；`expires` 是毫秒，`expires_at` 留给渠道判到期）。 */
  const importAuthOf = (rawCredential) => {
    const credential = withPreviousSlot(rawCredential)
    const expires = expiresMsOf(credential)
    return {
      type: 'success',
      channel: channel.id,
      ...credential,
      ...(expires !== undefined ? { expires } : {}),
      accountId: importAccountId(credential),
    }
  }

  /** 每个待导入账号挑一个槽 key：同账号 → 覆盖原槽；否则本体槽位空闲就用本体。 */
  const slotKeysForImport = (accountIds) => {
    const slots = readMagpieAuthSlots(PROVIDER).filter((s) => s.channel === channel.id)
    const taken = new Set()
    return accountIds.map((accountId) => {
      const existing = slots.find((s) => s.accountId === accountId)
      if (existing !== undefined) return existing.key
      if (!taken.has(PROVIDER) && !slots.some((s) => s.key === PROVIDER)) {
        taken.add(PROVIDER)
        return PROVIDER
      }
      let key = ''
      do {
        key = PROVIDER + '#' + randomBytes(4).toString('hex').slice(0, 6)
      } while (taken.has(key) || slots.some((s) => s.key === key))
      taken.add(key)
      return key
    })
  }

  /**
   * 把第 `start` 个之后的账号写进账号槽（第 0 个交回宿主写，见上面 ⚠️）。
   * 返回写成功的账号名（用于 toast）。
   */
  const commitImportedAccounts = async (accounts, start = 0) => {
    const rest = accounts.slice(start)
    const keys = slotKeysForImport(rest.map(importAccountId))
    const written = []
    for (let i = 0; i < rest.length; i += 1) {
      const credential = rest[i]
      const auth = importAuthOf(credential)
      try {
        await authSet?.({ path: { id: keys[i] }, body: auth })
        written.push(auth.accountId)
        debugLog('import: wrote slot ' + keys[i] + ' (' + channel.id + ')')
      } catch (error) {
        debugLog('import: write failed ' + keys[i] + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    for (const credential of accounts) rememberCredential(channel, credential)
    writeSnapshot()
    return written
  }

  /**
   * 裸文件名（没有任何目录分隔符）只在几个**固定**的常见目录里按名字找一次。
   *
   * 为什么需要：magpie 的登录表单是单行 <input>，没有文件选择器、也没有 drop
   * 回调（宿主只认 text/password/select，见 renderPluginAsk），所以「拖文件进
   * 来」只能靠 WebView2 的默认行为把文件名填进框里 —— Chromium 只给 basename
   * （Windows 资源管理器拖进来是 `lobsterai-1.json`，也可能是 `file:///…`）。
   * 有这条兜底，拖进来的文件名才真的能用。不是遍历目录：就这几处，命中即止。
   */
  const looseDirs = () => {
    const home = homedir()
    return [
      process.cwd(),
      home,
      join(home, 'Desktop'),
      join(home, 'OneDrive', 'Desktop'),
      join(home, 'Downloads'),
      join(home, 'Documents'),
      join(home, 'OneDrive', 'Documents'),
    ]
  }

  /** `file:///C:/x.json` / `file://localhost/C:/x.json` / `file://server/share/x` → 本地路径。 */
  const fromFileUrl = (text) => {
    const match = /^file:(\/\/[^/]*)?(.*)$/i.exec(text)
    if (match === null) return text
    const host = String(match[1] ?? '').replace(/^\/\//, '')
    let rest = String(match[2] ?? '')
    try {
      rest = decodeURIComponent(rest)
    } catch {
      /* 百分号编码坏了就按原样 */
    }
    if (host !== '' && host.toLowerCase() !== 'localhost') {
      // UNC：file://server/share/a.json → \\server\share\a.json
      return '\\\\' + host + rest.replace(/\//g, '\\')
    }
    if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1) // /C:/… → C:/…
    return rest
  }

  /**
   * 「账号 JSON」一栏既可以是文件路径，也可以直接粘 JSON。
   * 只读用户给的那一个文件（不遍历目录、不猜路径 —— 裸文件名那条例外，见上）。
   */
  const readImportSource = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') throw new Error('请填写账号 JSON 文件路径，或直接把 JSON 粘进这一栏')
    const unquoted = text.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim()
    if (unquoted.startsWith('{') || unquoted.startsWith('[')) return unquoted
    const named = fromFileUrl(unquoted)
    if (!/[/\\]/.test(named)) {
      for (const dir of looseDirs()) {
        const candidate = join(dir, named)
        if (!existsSync(candidate)) continue
        try {
          return readFileSync(candidate, 'utf8')
        } catch {
          /* 这个目录里的同名文件读不了，试下一个 */
        }
      }
    }
    const file = named.startsWith('~') ? join(homedir(), named.slice(1)) : named
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      const code = error?.code ?? 'IO'
      throw new Error('读不到文件 ' + file + '（' + code + '）；也可以直接把 JSON 粘进这一栏')
    }
  }

  /**
   * 一栏里的文本看着像**文件**吗（而不是 token）。
   * 判定归渠道（`importSpec.looksLikeFile`，与 prompts 的 condition 同源）；
   * 没声明的渠道退回一个保守的通用判断。
   */
  const looksLikeFile = typeof importSpec?.looksLikeFile === 'function'
    ? importSpec.looksLikeFile
    : (text) => (
      typeof text === 'string' && text.trim() !== '' && !text.trim().startsWith('{') && (
        /^file:/i.test(text.trim()) || /[/\\]/.test(text) || /\.(json|jsonl|txt)$/i.test(text)
      )
    )

  /** 两个导入入口（magpie 原生表单；渠道声明了 importCredential 才有）。 */
  const buildImportMethods = () => {
    if (importSpec === undefined || importSpec === null) return []

    /**
     * 提交 → 落槽 → toast → 把第一个账号以 oauth 形状交回宿主。
     * 解析/校验失败**抛错**：宿主把 error 文本显示在同一个表单里（表单不关，能改）。
     */
    const runImport = async (mode, fields) => {
      const outcome = await importSpec.submit({ mode, fields })
      const accounts = Array.isArray(outcome?.accounts) ? outcome.accounts : []
      const warnings = Array.isArray(outcome?.warnings) ? outcome.warnings : []
      if (accounts.length === 0) throw new Error(warnings.join('；') || '没有可导入的账号')
      // 降级提示要在 withPreviousSlot 补字段**之前**算：补过了就成了「没降级」。
      for (const downgrade of new Set(accounts.map(downgradeWarningOf).filter(Boolean))) warnings.push(downgrade)
      const extra = await commitImportedAccounts(accounts, 1)
      const first = withPreviousSlot(accounts[0])
      const accountId = importAccountId(first)
      const names = [accountId, ...extra]
      if (typeof first.refresh_token !== 'string') {
        warnings.push('这次只有 access_token，没有 refresh_token：到期后要重新导入（用官方导出的账号 JSON 文件导入可自动续期）')
      }
      toast(channel.displayName + '：已导入 ' + names.length + ' 个账号（' + names.join('、') + '）')
      if (warnings.length > 0) toast(channel.displayName + ' 导入提示：' + warnings.slice(0, 3).join('；'), 'warning')
      debugLog('import: ' + channel.id + ' ' + mode + ' -> ' + names.join(','))
      const expires = expiresMsOf(first)
      // ⚠️ `refresh` 必须出现在结果里（宿主用 'refresh' in result 判分支，
      //    没有 refresh_token 时也保留这个键 —— 宿主只看键存不存在）。
      const result = {
        type: 'success',
        ...first,
        channel: channel.id,
        accountId,
        refresh: typeof first.refresh_token === 'string' ? first.refresh_token : undefined,
        access: first.access_token,
      }
      if (expires !== undefined) result.expires = expires
      return result
    }

    /** 提交失败 → 宿主认的失败形状（表单里显示 error 文本，不抛栈也不弹浏览器）。 */
    const guard = async (run) => {
      try {
        return await run()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog('import failed: ' + channel.id + ': ' + message)
        toast(channel.displayName + ' 导入失败：' + message, 'error')
        return { type: 'failed', error: message }
      }
    }

    // ① 手动导入：一栏贴全（token / 整段 JSON / 文件路径）+ 缺什么才补问
    //    ⚠️ 栏位声明来自渠道（importSpec.manualPrompts）：文案是渠道自己的字段名，
    //       聚合层只负责「按声明问、把答案原样交给 submit」。
    //    为什么不是四栏并列：magpie 的登录表单一次只渲染一个 input（宿主
    //    renderPluginAsk 的硬限制），所以「一屏填完」靠第一栏全吃下 + 后三栏
    //    挂 condition 自动跳过。
    const manual = {
      type: 'api',
      // keyless：宿主不渲染「API key」输入框，直接按 prompts 提问后调 authorize
      keyless: true,
      label: importSpec.manualLabel ?? '手动导入（粘贴凭据）',
      prompts: Array.isArray(importSpec.manualPrompts) && importSpec.manualPrompts.length > 0
        ? importSpec.manualPrompts
        : [{
          key: 'token',
          type: 'password',
          message: 'ACCESS_TOKEN（必填）',
          validate: (value) => (
            typeof value === 'string' && value.trim() !== '' ? null : '请粘贴 access_token'
          ),
        }],
      async authorize(inputs = {}) {
        const text = (value) => (typeof value === 'string' ? value.trim() : '')
        return guard(() => {
          const typed = text(inputs.token)
          const fields = {
            refreshToken: text(inputs.refreshToken),
            userId: text(inputs.userId),
            note: text(inputs.note),
          }
          // 一栏里贴的其实是文件（路径 / file:/// / 拖进来的裸文件名）→ 读成 JSON 走文件导入
          if (looksLikeFile(typed)) return runImport('file', { ...fields, text: readImportSource(typed) })
          return runImport('manual', { ...fields, accessToken: typed })
        })
      },
    }

    // ② 文件导入：给路径（读那个文件）或直接粘 JSON
    const file = {
      type: 'api',
      keyless: true,
      label: importSpec.fileLabel ?? '文件导入（账号 JSON）',
      prompts: [
        {
          key: 'source',
          type: 'text',
          message: '账号 JSON 的文件路径（file:/// 也行，也可以把文件拖进这一栏），或直接粘贴 JSON',
          placeholder: 'C:\\Users\\you\\lobsterai-1.json',
          validate: (value) => (
            typeof value === 'string' && value.trim() !== ''
              ? null
              : '请填写 JSON 文件路径，或直接把 JSON 粘进来'
          ),
        },
      ],
      async authorize(inputs = {}) {
        return guard(async () => runImport('file', { text: readImportSource(inputs.source) }))
      },
    }

    return [manual, file]
  }
  // 旧版账号槽 → 本供应商槽（一次性、幂等；见函数注释）。失败不影响启动。
  if (options.migrateLegacySlots !== false) {
    await migrateLegacySlots(authSet, channel, PROVIDER)
  }

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

      // 本供应商唯一的登录入口（一个渠道一个供应商）。⚠️ 约定（对齐社区插件）：
      // authorize() 必须**立刻**返回 { url, method, callback } —— 在这里 await
      // 用户完成登录会与 magpie 双向死锁；真正等登录的是 callback()。
      // 渠道契约 beginLogin() → { url, result }。
      // 渠道可声明多登录入口（`loginMethods: [{label, arg}]`）；
      // 未声明时退化为单入口 `登录 <displayName>`。
      methods: ((channel) => {
        const buildOne = (label, arg) => ({
          type: 'oauth',
          label,
          async authorize() {
            const started = await channel.beginLogin(openBrowser, {})
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
          // ⚠️⚠️ 反馈/快照挂在**自己的完成链**上，不挂在 callback 里 ——
          //    真机实证（2026-10-27 微信扫码重登）：登录落盘后 magpie 弹了
          //    「已添加」但 **callback 从未被调用** —— magpie 对 auto 流程
          //    只监听 auth.set 事件即认定完成，未必回调。
          //    started.result 由载体服务自己 settle，必触发。
          //
          //    ⚠️⚠️ 反馈规则（用户定案）：
          //    · 新账号                                    → 「登录成功（新增账号）」
          //    · 已有账号且**未过期**（重复登录）           → 「⚠️ 账号重复」，
          //                                                  **且不覆盖原账号槽**（callback 里跳过写入）
          //    · 已有账号但**已过期**（重新登录/续期）       → 「已更新登录（已续期）」+ 写入
          //    · 登录失败                                  → 弹失败
          //    ⚠️ 全部走 toast（宿主原生渲染）—— 系统通知（spawn PowerShell）已删，
          //       外部文案拼脚本有命令注入面（PR #502 审核第 1 条）。
          void started.result.then((credential) => {
            try {
              debugLog(`chain fired: ${channel.id}`)
              const accountId = resolveAccountId(credential)
              writeSnapshot() // 快照立即跟上（不等 magpie 的 usage 轮询）
              const pre = preSlots.get(accountId)
              if (pre === undefined) {
                debugLog(`chain: 新账号 ${channel.id} ${accountId}`)
                toast(`${channel.displayName}：登录成功（新增账号）`)
              } else if (pre.expired) {
                debugLog(`chain: 过期账号重新登录 ${channel.id} ${accountId}`)
                toast(`${channel.displayName}：已更新登录（已续期）`)
              } else {
                debugLog(`chain: 账号重复（保留原槽，不覆盖）${channel.id} ${accountId}`)
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
                // 账号槽（主）+ 内存缓存（本进程内供 sweep/目录用）。
                // accountId 优先用渠道带回的账号名 —— 多账号时卡片显示真名。
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
                rememberCredential(channel, credential)
                await saveAuth(auth)
                return auth
              } catch (error) {
                // 登录失败也弹（否则「在等流程」和「失败了」分不清）
                const message = error instanceof Error ? error.message : String(error)
                toast(`${channel.displayName} 登录失败：${message}`, 'error')
                throw error
              }
            },
          }
        },
      })
      const loginMethods = Array.isArray(channel.loginMethods) && channel.loginMethods.length > 0
        ? channel.loginMethods.map((m) => buildOne(m.label, m.arg))
        : [buildOne(`登录 ${channel.displayName}`, undefined)]
      // 导入已有账号排在登录之后（用户默认先看见「登录」）
      return [...loginMethods, ...buildImportMethods()]
      })(channel),

      /**
       * 按账号发请求：`getAuth()` 拿**当前账号槽**的 auth。
       *
       * - auth 属于本渠道 → 用它（同渠道多账号：magpie 换槽即换号）；
       * - 读不到 → 本进程内存缓存兜底（本进程内登录过就有）；
       * - 都没有 → 明确的未登录响应（不炸会话）。
       */
      async loader(getAuth) {
        return {
          // ⚠️ baseURL 不能是空串：magpie 会据此判「无处可发」；真正上游在 fetch 里改写。
          baseURL: placeholderBaseOf(PROVIDER),
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
            })
            // 续期后的新凭据已由 gatedRenew 记进内存缓存；账号槽由 magpie refresh 兜
            return response
          },
        }
      },

      /**
       * 用量卡：**按账号**出本渠道的桶；读不到账号（旁路-only）走旁路兜底。
       */
      async usage(getAuth) {
        const auth = await safeGetAuth(getAuth)
        let credential
        if (authOfChannel(auth, channel)) {
          credential = await ensureAuth(channel, auth)
        } else {
          try {
            credential = await ensure(channel)
          } catch {
            // 没账号也没旁路 → 状态条「未登录」，不要报成额度查询失败
            return {
              plan: PROVIDER_NAME,
              windows: [{ name: channel.displayName, used: 0, display: `未登录（${PROVIDER}）` }],
            }
          }
        }
        const windows = await windowsOf(credential)
        snapshotCache.buckets.set(channel.id, windows)
        writeSnapshot()
        return { plan: PROVIDER_NAME, windows }
      },

      // magpie 的显式/提前续期入口（**本供应商的账号各续各的**）。
      // astudio 无 refresh_token → 返回 undefined（magpie 保持原登录不动）。
      async refresh(auth) {
        if (!authOfChannel(auth, channel)) return undefined
        if (identityOf(auth) === '') return undefined
        const next = await gatedRenew(channel, auth) // 失败抛出，magpie 如实记失败
        await saveAuth(next)
        return next
      },

      /**
       * 每日签到：**按账号**（magpie 对每个账号每天调一次 —— 社区插件同款）。
       * 该渠道无签到端点 → inactive。返回词汇表：claimed / done / inactive /
       * ineligible / failed（+credit/streak）。
       *
       * ⚠️⚠️ **只报自己**（用户定案：谁的结果在谁的卡片下面）。旧版会顺带扫其余
       *   十渠并把明细汇总返回，真机报障「Loomy 卡片挂着 OfficeAce/MiniMax 一整屏」。
       *   现在一个供应商只有一个渠道，汇总分支整个删掉。
       * ⚠️ 旁路-only 渠道（没有账号槽，magpie 轮不到它）由模块级 sweep 补签，
       *   见 `sweepCheckins()`。
       */
      async checkin(getAuth) {
        const auth = await safeGetAuth(getAuth)
        const tally = checkinTallyOf()
        if (typeof channel.checkin !== 'function') {
          snapshotCache.checkin.set(channel.id, { channel: channel.displayName, outcome: 'inactive', message: `${channel.displayName} 无每日签到` })
          writeSnapshot()
          return { outcome: 'inactive', message: `${channel.displayName} 无每日签到` }
        }
        const cached = tally.get(channel.id)
        const signedInHere = authOfChannel(auth, channel) || signedIn(channel)
        if (!signedInHere) {
          // 既没有本账号、也没有旁路凭据 → 不是「失败」，只是没登录（别把卡片涂红）
          return { outcome: 'inactive', message: `未登录 ${channel.displayName}，跳过签到` }
        }
        if (cached === undefined || cached.outcome === 'failed') {
          try {
            const credential = authOfChannel(auth, channel)
              ? await ensureAuth(channel, auth)
              : await ensure(channel)
            const outcome = await channel.checkin(credential)
            tally.set(channel.id, {
              channel: channel.displayName,
              outcome: outcome.outcome,
              credit: Number.isFinite(outcome.credit) ? outcome.credit : undefined,
              message: outcome.message,
            })
          } catch (error) {
            tally.set(channel.id, {
              channel: channel.displayName,
              outcome: 'failed',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        const own = tally.get(channel.id)
        snapshotCache.checkin.set(channel.id, own)
        writeSnapshot()
        return {
          outcome: own.outcome,
          ...(Number.isFinite(own.credit) && own.credit > 0 ? { credit: own.credit } : {}),
          message: own.message ?? '',
        }
      },
    },

    provider: {
      id: PROVIDER,
      /**
       * ⚠️ 第二参是 magpie 给的上下文：`{ auth, getAuth }`（社区插件
       * `async models(provider, { auth })` 同款）。**必须用它**——凭据只在内存，
       * 冷启动时内存为空，不传 auth 就拉不到远端目录（真机 0 models）。
       */
      async models(provider, ctx = {}) {
        const auth = ctx?.auth ?? (typeof ctx?.getAuth === 'function' ? await safeGetAuth(ctx.getAuth) : undefined)
        const models = await discoverModels(channel, provider.models, auth)
        // 本渠道模型数 + 总数，喂给页面快照（一个供应商只有一个渠道，计数即全量）
        try {
          snapshotCache.perChannelModelCount = { ...(snapshotCache.perChannelModelCount ?? {}), [channel.id]: Object.keys(models ?? {}).length }
          snapshotCache.modelCount = Object.keys(models ?? {}).length
          writeSnapshot()
        } catch { /* 快照失败不影响目录 */ }
        return models
      },
    },
  }
}
