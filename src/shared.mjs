// 各渠道共享的小工具：凭据落盘、信封解析。
//
// 每个渠道一份凭据文件，互不干扰。

import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * 凭据目录。⚠️ **惰性求值**（每次现取 homedir）：模块级常量会在首次 import
 * 时固化 —— 测试按用例切换 HOME 时会读到别的沙箱的凭据文件（状态泄漏）。
 */
const storeDir = () => join(homedir(), '.config', 'magpie')

export function credentialPath(name) {
  return join(storeDir(), `${name}-credential.json`)
}

/**
 * 全链路诊断日志（登录流程排查用）：~/.config/magpie/notify-debug.log。
 * 纯文本、无凭据；追加写。
 */
export function debugLog(line) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    appendFileSync(join(storeDir(), 'notify-debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * magpie 的账号槽存储（plugin-auth.json）—— 供「每渠道账号数」统计用。
 * ⚠️ 只读，绝不写（那是 magpie 的地盘）；路径可用 env 重定向（测试）。
 */
export function magpieAuthPath() {
  return process.env.DSH_HUB_AUTH_PATH ?? join(storeDir(), 'plugin-auth.json')
}

/**
 * 读 magpie 账号槽的**原始条目**：`[{key, channel, value}]`（value 是 magpie 存的整个 auth）。
 * 只读，绝不写（那是 magpie 的地盘）；路径可用 env 重定向（测试）。
 *
 * @param {string} [providerId] 省略 = 全部槽（调用方自己按 `channel` 过滤归属）
 */
export function readMagpieAuthEntries(providerId) {
  try {
    const obj = JSON.parse(readFileSync(magpieAuthPath(), 'utf8'))
    const out = []
    for (const [key, val] of Object.entries(obj ?? {})) {
      if (typeof val !== 'object' || val === null) continue
      if (providerId !== undefined && key !== providerId && !key.startsWith(`${providerId}#`)) continue
      const channel = typeof val.channel === 'string' ? val.channel : ''
      out.push({ key, channel, value: val })
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
  return readMagpieAuthEntries(providerId).map(({ key, value: val, channel }) => {
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

export function loadCredential(name) {
  try {
    const p = credentialPath(name)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 凭据到期时刻（毫秒）；解析不出来 → undefined（不参与比较，宁可写也不要漏写）。 */
function expiryOf(credential) {
  const raw = credential?.expiresAt ?? credential?.expires ?? credential?.expires_at ?? credential?.expireMs
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000
  if (typeof raw === 'string') {
    const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
    if (Number.isFinite(t) && t > 0) return t > 1e12 ? t : t * 1000
  }
  return undefined
}

/**
 * 是否「下调写入」：盘上已有的凭据比这次要写的**更晚到期**。
 *
 * ⚠️ 轮转型渠道（OfficeAce STS）的致命形态：续期成功后盘上是新 refresh_token(R2)，
 *    另一条调用路径仍拿着旧凭据(R1)回写一份 —— 把 R2 覆盖成 R1，下次续期拿已消费的
 *    R1 去换 → `STS5.1806 the refresh token has been used` → 凭据**永久**作废，
 *    只能重新登录（真机 2026-10-29）。
 */
function isStaleWrite(target, credential) {
  if (!existsSync(target)) return false
  try {
    const prev = JSON.parse(readFileSync(target, 'utf8'))
    const kept = expiryOf(prev)
    const incoming = expiryOf(credential)
    return kept !== undefined && incoming !== undefined && incoming < kept
  } catch {
    return false
  }
}

export function saveCredential(name, credential) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    const target = credentialPath(name)
    if (isStaleWrite(target, credential)) {
      console.warn(`[credential] 拒绝下调写入 ${name}（盘上凭据到期更晚，本次为旧凭据）`)
      return false
    }
    // ⚠️ **原子写**（临时文件 + 改名）：magpie 重启/登录并发时，宿主可能正在
    //    读这份文件 —— 非原子的截断写入会让读侧 JSON.parse 失败 → 凭据被当成
    //    「未登录」（真机瞬态：重启后快照整帧「部分未登录」）。
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(credential, null, 2), 'utf8')
    renameSync(tmp, target)
    return true
  } catch (error) {
    // ⚠️ 绝不能静默：轮转型渠道「续期成功但没落盘」= 新 refresh_token 永久丢失，
    //    上次消费掉的旧 token 下次必报 STS5.1806。静默 = 用户只能靠猜。
    console.warn(`[credential] 凭据落盘失败 ${name}：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

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
