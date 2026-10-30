// 各渠道共享的小工具：账号槽读取、信封解析、额度分档。
//
// ⚠️ v0.5.0 起本模块**不写任何文件**（除了显式开启的诊断日志，且落在系统临时目录）：
//    插件不碰 magpie 的配置目录，账号只存 magpie 账号槽。

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * magpie 的配置目录（**只用于读它自己的文件**：plugin-auth.json / models.json）。
 * ⚠️ 惰性求值：模块级常量会在首次 import 时固化 homedir。
 * ⚠️ 便携版 magpie 或设了 XDG_CONFIG_HOME 时这里可能指错 —— 但既然只读、
 *    读不到就回退（`readOwnAuthEntries` 的 catch 返回空数组），不会污染任何东西。
 */
const storeDir = () => join(homedir(), '.config', 'magpie')

/**
 * 全链路诊断日志（排查用）。**默认关闭**：设 `DSH_HUB_DEBUG=1` 才写。
 *
 * ⚠️ 落点是**系统临时目录**（`<tmp>/providers-hub-debug.log`），不是 magpie 的
 *    配置目录 —— 社区审核（PR #502 第 2 条）要求插件不往宿主的目录里写文件。
 */
export function debugLog(line) {
  if (process.env.DSH_HUB_DEBUG !== '1') return
  try {
    const dir = join(tmpdir(), 'providers-hub')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * magpie 的账号槽存储（plugin-auth.json）—— 供「每渠道账号数」统计与旧槽迁移用。
 * ⚠️ 只读，绝不写（那是 magpie 的地盘）；路径可用 env 重定向（测试）。
 */
export function magpieAuthPath() {
  return process.env.DSH_HUB_AUTH_PATH ?? join(storeDir(), 'plugin-auth.json')
}

/** 本插件自己的账号槽前缀（`hub-<ch>` 与 0.3.x 的 `providers-hub*`）—— 见 isOwnSlotKey。 */

/**
 * 这个 key 是不是本插件的槽。
 *
 * 认三种形态：
 *   `hub-<渠道>` / `hub-<渠道>#<slot>`   —— v0.4.0 起的槽
 *   `providers-hub` / `providers-hub#<slot>` —— v0.3.x 聚合形态的旧槽（迁移用）
 *
 * ⚠️ 别写成 `key.startsWith(p + '-')` 一把梭：`hub-` 后面直接跟渠道名
 *    （`hub-astudio`），没有第二个分隔符 —— 那样写会把所有自己的槽全漏掉
 *    （实测：`readOwnAuthEntries()` 返回空数组）。
 */
function isOwnSlotKey(key) {
  const k = String(key ?? '')
  if (k.startsWith('hub-')) return true
  if (k === 'providers-hub') return true
  return k.startsWith('providers-hub#') || k.startsWith('providers-hub-')
}

/**
 * 读 magpie 账号槽的**原始条目**：`[{key, channel, value}]`（value 是 magpie 存的整个 auth）。
 * 只读，绝不写（那是 magpie 的地盘）；路径可用 env 重定向（测试）。
 *
 * ⚠️⚠️ **必须按 key 前缀过滤后再取值**（PR #502 审核第 3 条）：不带过滤地调用会把
 *    `plugin-auth.json` 里**所有**供应商的完整 auth（包括别的插件的 token）读进内存 ——
 *    而调用方往往只用来数账号。现在默认**只返回本插件的槽**，且 `withValue:false`
 *    时连 auth 内容都不保留（直接丢弃 value）。
 *
 * @param {{providerId?: string, withValue?: boolean}} [opts]
 *   providerId 省略 = 本插件的全部槽（`hub-*` / `providers-hub*`）；
 *   withValue 只在**迁移**时才需要（要复制旧槽的 auth）。
 */
export function readOwnAuthEntries({ providerId, withValue = false } = {}) {
  try {
    const obj = JSON.parse(readFileSync(magpieAuthPath(), 'utf8'))
    const out = []
    for (const [key, val] of Object.entries(obj ?? {})) {
      // ① 先按 key 收窄：别人的槽**连值都不碰**
      if (!isOwnSlotKey(key)) continue
      if (providerId !== undefined && key !== providerId && !key.startsWith(`${providerId}#`)) continue
      if (typeof val !== 'object' || val === null) continue
      const channel = typeof val.channel === 'string' ? val.channel : ''
      // ② 不需要值时**不把 auth 放进返回对象**（凭据不经过不需要它的代码）
      out.push(withValue ? { key, channel, value: val } : { key, channel })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 读 magpie 账号槽的摘要：`[{key, type, accountId, channel, expires}]`。
 * @param {string} [providerId] 省略 = 全部槽（页面快照用，按 `channel` 归属）
 */
export function readMagpieAuthSlots(providerId) {
  // ⚠️ 这里需要 expires（判「重复登录是否已过期」），所以对本插件自己的槽取 value。
  return readOwnAuthEntries({ providerId, withValue: true }).map(({ key, value: val, channel }) => {
    const expires = Number(val.expires)
    return {
      key,
      type: typeof val.type === 'string' ? val.type : '',
      accountId: typeof val.accountId === 'string' ? val.accountId : '',
      channel,
      expires: Number.isFinite(expires) && expires > 0 ? expires : undefined,
    }
  })
}

/**
 * ⚠️ v0.5.0 起**没有** `saveCredential` / `loadCredential` / `credentialPath`：
 *    插件不再往 magpie 的配置目录写任何凭据文件（PR #502 审核第 2 条）。
 *    账号只存 magpie 账号槽，凭据只在内存里流转（见 src/aggregate.mjs 的
 *    memoryCredentials）。

/**
 * 上游信封 `{code, message, data}`；`code === 0` 为成功。
 * 非 JSON 或 code 非 0 都抛出可读错误（不静默吞掉）。
 */
export async function parseEnvelope(response, what) {
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`${what} 响应不是 JSON（HTTP ${response.status}）`)
  }
  const code = typeof parsed?.code === 'number' ? parsed.code : NaN
  if (code !== 0) {
    throw new Error(`${what} 失败：${parsed?.message ?? `HTTP ${response.status}`}`)
  }
  return parsed?.data
}

/** 未登录错误：带 signIn 标记，让 magpie 提示重新登录而不是报普通错。 */
export function notSignedIn(message) {
  return Object.assign(new Error(message), { signIn: 'expired' })
}

/** 「N 分钟 / N 小时 / N 天」的人类可读倒计时；非法/过去时刻给 undefined。 */
export function humanUntil(iso, nowMs = Date.now()) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return undefined
  const mins = Math.round((t - nowMs) / 60000)
  if (mins < 0) return undefined
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** 「X 后作废」拼进亮色主文本用（'过期'辅助行太浅看不清 —— 用户报障）。 */
export function untilText(iso, nowMs = Date.now()) {
  const t = humanUntil(iso, nowMs)
  return t === undefined ? undefined : `${t}后作废`
}

// ── 到期分档（滚动指针，用户 2026-10-25 定案）────────────────────────────
//
// 「临期」永远指向**最早到期的未耗尽桶**（FEFO 头 = 服务端正在扣的那桶），
// 它用完或过期后指针自动轮到下一桶。固定 15 天窗被否：两个桶 3 天/12 天
// 各一笔时只标最早的会瞒住另一笔，而最早 200 天后到期时标红是假警报。
// 指针方案无这两病：永远一个红桶、永远显示真实剩余天数（N 天如实可见）。

/**
 * 给桶列表分配到期档位（就地补 `band` 键）。
 *
 * @param buckets `{ expireMs?: number, remaining?: number, ... }[]`
 *   - `expireMs` 缺失/非法 = 永久桶（`band: '永久'`）；
 *   - `remaining <= 0` = 已耗尽（`band: '已耗尽'`，**不参与**指针）；
 *   - 其余按到期升序，**最早的一个** = `临期·N天`（N = 真实剩余天数），
 *     之后 = `长期`。
 */
export function assignExpiryBands(buckets, now = Date.now()) {
  const pointer = buckets
    .map((bucket, index) => ({ index, expireMs: bucket.expireMs, remaining: bucket.remaining }))
    .filter((b) => Number.isFinite(b.expireMs) && b.expireMs !== null
      && Number.isFinite(b.remaining) && b.remaining > 0)
    .sort((a, b) => a.expireMs - b.expireMs)[0]
  for (const bucket of buckets) {
    // ⚠️ 已耗尽判定**先于**永久判定：剩 0 且无到期的桶（如 AStudio 会员/购买池）
    //    应标「已耗尽」而不是「永久」—— 永久是"有额度且不过期"，剩 0 恰恰相反。
    if (!Number.isFinite(bucket.remaining) || bucket.remaining <= 0) {
      bucket.band = '已耗尽'
      continue
    }
    if (!Number.isFinite(bucket.expireMs) || bucket.expireMs === null) {
      bucket.band = '永久'
      continue
    }
    bucket.band = pointer !== undefined && bucket === buckets[pointer.index]
      ? `临期·${Math.ceil((bucket.expireMs - now) / 86_400_000)}天`
      : '长期'
  }
  return buckets
}

/**
 * 【新渠道必用】把「额度桶」一步变成 magpie 窗口数组（滚动指针全套）。
 *
 * 所有渠道的 usage() 都该走这里，别自己拼 window —— 手工拼漏了档位名，
 * `tests/expiry-bands-required.test.mjs` 会红。
 *
 * 入参 bucket：
 *   {
 *     label: string,          // 展示名（如 '每日赠送' / '积分包' / '会员积分'）
 *     remaining: number,      // 剩余量
 *     expireMs?: number,      // 到期毫秒；undefined = 永久
 *     poolTotal?: number,     // 该池总量（给 used% 用；缺省按 remaining 视为满额）
 *     expireRaw?: string,     // 原始到期串（取 MM-DD 显示用）
 *   }
 *
 * 出参：magpie window[]，每项 name 形如 `{label} · {临期·N天|长期|永久|已耗尽}`，
 *       display 形如 `剩余 {N}[ · MM-DD 到期]`，剩 0 的桶 aside 折叠。
 */
export function expiryBandedWindows(buckets, now = Date.now()) {
  assignExpiryBands(buckets, now)
  const windows = []
  for (const bucket of buckets) {
    const expiryShort = typeof bucket.expireRaw === 'string' && bucket.expireRaw !== ''
      ? String(bucket.expireRaw).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$2-$3')
      : undefined
    // used%：有 poolTotal 按实际算，否则满额=0 / 剩0=100
    const used = Number.isFinite(bucket.poolTotal) && bucket.poolTotal > 0
      ? Math.max(0, Math.min(100, Math.round(((bucket.poolTotal - bucket.remaining) / bucket.poolTotal) * 100)))
      : (Number.isFinite(bucket.remaining) && bucket.remaining > 0 ? 0 : 100)
    windows.push({
      name: `${bucket.label} · ${bucket.band}`,
      used,
      // ⚠️ 刻意不挂 runsOutAt：档位名（临期·N天）+ display 绝对日期已够，
      //   多挂会多一行浅灰重复（AStudio/officeace 同款去重，用户报障过）。
      ...(Number.isFinite(bucket.remaining) && bucket.remaining <= 0 ? { aside: true } : {}),
      display: `剩余 ${bucket.remaining}${expiryShort !== undefined ? ` · ${expiryShort} 到期` : ''}`,
    })
  }
  return windows
}

// ── 传输层重试（各渠道共用）────────────────────────────────────────────────

const sleep = (ms) => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

/**
 * 这个错误是不是**传输层**的（值得重发）。
 *
 * ⚠️ 只认网络/证书/DNS 这类「包没到或被切断」的错误；HTTP 业务错误（4xx/5xx
 *    被 fetch 正常解析成 Response）**不在此列** —— 那些重发只会原样失败、
 *    还会掩盖真因（额度/鉴权/限流各 有各 的处置）。
 * ⚠️ 追到 `cause` 链（Node 的 fetch 把真错误包在 `fetch failed` 外面）。
 */
export function isTransportError(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    if (typeof current !== 'object') break
    const name = typeof current.name === 'string' ? current.name : ''
    const message = typeof current.message === 'string' ? current.message.toLowerCase() : ''
    const code = typeof current.code === 'string' ? current.code : ''
    if (name.startsWith('UND_ERR_') || code.startsWith('UND_ERR_')) return true
    if (code.startsWith('SELF_SIGNED_CERT') || code.startsWith('CERT_')
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return true
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE'
      || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true
    if (message.includes('fetch failed')) return true
    if (message.includes('socket hang up') || message.includes('terminated')
      || message.includes('other side closed')) return true
    current = current.cause
  }
  return false
}

/** 传输级重试：默认 2 次、400ms 指数退避；abort 绝不重试；耗尽抛最后的错误。 */
export async function fetchWithRetry(fetchOnce, signal, retries = 2) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce()
    } catch (error) {
      lastError = error
      if (signal?.aborted === true) throw error
      if (!isTransportError(error)) throw error
      if (attempt === retries) break
      await sleep(400 * 2 ** attempt)
    }
  }
  throw lastError
}
