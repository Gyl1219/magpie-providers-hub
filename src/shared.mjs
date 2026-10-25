// 各渠道共享的小工具：凭据落盘、信封解析。
//
// 每个渠道一份凭据文件，互不干扰。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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

export function loadCredential(name) {
  try {
    const p = credentialPath(name)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function saveCredential(name, credential) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(credentialPath(name), JSON.stringify(credential, null, 2), 'utf8')
  } catch {
    // 存不下不致命：本次会话仍可用，重启后重新登录。
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
