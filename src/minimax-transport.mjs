// MiniMax 传输层 —— 移植自 DSH `src/minimax.ts`（issue IKMEVG 的完整修复）。
//
// ## 为什么不能裸 fetch（这是社区插件国际版登不上的根因）
//
// `agent.minimax.io` 对**所有**路径恒返 `307 → agent.minimaxi.com`
// （Akamai 按出口 IP 地理分流）。而按 fetch 规范，**跨 origin 跟随会剥掉
// `Authorization`** ⇒ 第二跳无凭据 ⇒ `401 {"error":"invalid access token"}`，
// 与「凭据真失效」逐字同形。唯一正解：`redirect: 'manual'` 自己逐跳跟随，
// **每一跳重建请求头**。
//
// ⚠️ 白名单闸门：跟随 3xx 等于把带凭据的请求发到服务端指定的任意主机 ——
// 只放行本家自有域（带边界的后缀匹配，`evil-minimax.io` 不得命中）。

/** 跳数上限：实测只有一跳，留 3 是余量；再多就是重定向环，必须停。 */
export const REDIRECT_MAX_HOPS = 3

/** 允许携带凭据跟随的主机后缀（**带边界**匹配）。 */
const TRUSTED_HOST_SUFFIXES = ['minimax.io', 'minimax.cn', 'minimaxi.com', 'xaminim.com']

/**
 * 主机名是否等于该域或是它的子域。
 *
 * ⚠️ 唯一实现处：`evilminimaxi.com` **不能**命中 `minimaxi.com`（DSH 红队
 * 审计打穿过裸 `endsWith` 版本），故用「整名相等或 `.后缀` 结尾」。
 */
export function hasHostSuffix(hostname, suffix) {
  const host = String(hostname ?? '').trim().toLowerCase()
  const bare = String(suffix ?? '').trim().toLowerCase()
  if (host.length === 0 || bare.length === 0) return false
  return host === bare || host.endsWith(`.${bare}`)
}

export function isTrustedHost(hostname) {
  return TRUSTED_HOST_SUFFIXES.some((suffix) => hasHostSuffix(hostname, suffix))
}

const FOLLOWABLE = new Set([301, 302, 303, 307, 308])

/**
 * 该错误是否为**传输级**（值得原样重发的瞬时故障）。
 *
 * ⚠️ 必须沿 `cause` 链找真因：undici 把底层错误包成 `TypeError: fetch failed`。
 * 只重试这类错误 —— 4xx/5xx 是服务端的明确答复（401 要续期、402 要充值、
 * 429 要冷却），重发只会原样失败且掩盖真因。
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

const sleep = (ms) => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

/** 传输级重试：2 次、400ms 指数退避；abort 绝不重试；耗尽抛最后的错误。 */
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

/**
 * 该 3xx 是否是「国际站被地理路由」（而不是普通域名迁移）。
 *
 * ⚠️ 起点必须是**数据面主机**（`agent.` 前缀 + 边界后缀 `minimax.io`）：
 * `account.minimax.io` 也是那个后缀，但它的 OAuth 重定向与地理分流**无关** ——
 * 把它算进来会把登录失败误报成「换个网络就好」。
 * 目标域用同一个带边界判据（`evilminimaxi.com` 不得命中）。
 */
export function isGeoRoute(fromHost, status, location) {
  if (status !== 307 && status !== 308) return false
  if (typeof location !== 'string' || location.length === 0) return false
  const from = String(fromHost ?? '').trim().toLowerCase()
  if (!from.startsWith('agent.') || !hasHostSuffix(from, 'minimax.io')) return false
  try {
    return hasHostSuffix(new URL(location).hostname, 'minimaxi.com')
  } catch {
    return false
  }
}

/**
 * 地理路由的可操作提示。
 *
 * ⚠️ 业务错误原文必须放**前面**：`307 → 402 insufficient_balance` 时用户该做的是
 * 充值，不是折腾网络（DSH 真实缺陷：旧文案把「去充值」整个顶掉了）。
 */
export function describeGeoRoute(detail) {
  const base = 'MiniMax 国际站按**出口 IP 所在区域**分流：当前出口 IP 被判成中国区'
    + '（内网或无法解析的地址也会被判成中国区），请求已被重定向到中国站 —— '
    + '这不是凭据问题。建议先确认本机出口 IP（例如浏览器打开 ifconfig.me），然后二选一：'
    + '① 给本插件设置一个海外 IP（magpie plugin options providers-hub '
    + '\'{"minimaxXff":"<海外IP>"}\'）；② 用代理把出口 IP 改到海外。'
  const trimmed = typeof detail === 'string' ? detail.trim() : ''
  if (trimmed.length === 0) return base
  const clipped = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
  return `上游还返回了：${clipped}。另外：${base}`
}

/**
 * 归一化 MiniMax 国际站绕分流用的 `X-Forwarded-For` 值 —— 逐字移植 DSH 的
 * `sanitizeMinimaxXff`（DSH 用它管面板设置；我们用它管 plugin options）。
 *
 * ## ⚠️ 为什么必须校验，而不是「用户填什么就发什么」
 *
 * 这个值会被原样拼进 HTTP 请求头。不校验的话，填入
 * `1.2.3.4\r\nX-Evil: 1` 就能向上游注入任意请求头（CRLF 头注入）。
 * 故判据必须是**白名单字符集**，不是「挡掉已知坏字符」。
 *
 * ## 取值口径（DSH 实测定的）
 *
 * - 只接受 **IP 字面量**：IPv4（四段 0-255）与 IPv6（`::` 压缩最多一次、
 *   组数 ≤8、组内 1~4 位十六进制；`%zone` 允许且不参与段数计算）；
 * - 主机名、XFF 链（`1.2.3.4, 5.6.7.8`）⇒ `undefined`；
 * - **空串/仅空白 ⇒ `undefined`**（= 不附头；绝不能变成空值头 —— 空值在
 *   Akamai 侧被当非法并回退真实 IP，行为同不附头但污染上游日志）；
 * - 超长（>128）⇒ `undefined`（最长合法 IPv6 只有 45 字符）。
 *
 * ⚠️ 只做 trim，不改大小写不改缩写：值是用户从自己代理/VPN 抄来的，
 * 改写只会让「为什么填对了却不生效」更难查。
 */
export function sanitizeXff(raw) {
  if (typeof raw !== 'string') return undefined
  // ⚠️ 必须在 trim 之前查 CR/LF：'1.2.3.4\r' 被 trim 后变合法 IPv4 并通过校验
  // —— 那个 \r 就会被拼进请求头（DSH 初版栽过的地方）。
  if (/[\r\n]/.test(raw)) return undefined
  const value = raw.trim()
  if (value.length === 0 || value.length > 128) return undefined
  // 白名单字符集；仅当存在 %（IPv6 zone）时才放行字母（纯字母如 localhost 拒绝）
  const hasZone = value.includes('%')
  const allowed = hasZone ? /^[0-9A-Za-z.:%-]+$/ : /^[0-9A-Fa-f.:]+$/
  if (!allowed.test(value)) return undefined
  // IPv4：四段十进制，每段 0-255
  const parts = value.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return value
  }
  // IPv6：段数合法性（:: 压缩最多一次；有压缩则显式组数 <8，无压缩则恰好 8 组）
  if (value.includes(':')) {
    if (/:::/.test(value)) return undefined
    if (value.startsWith(':') && !value.startsWith('::')) return undefined
    if (value.endsWith(':') && !value.endsWith('::')) return undefined
    const addressPart = value.split('%')[0] ?? ''
    if (addressPart.length === 0) return undefined
    const hasCompression = addressPart.includes('::')
    if (hasCompression && addressPart.split('::').length > 2) return undefined
    const groups = addressPart.split(':').filter((g) => g.length > 0)
    if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return undefined
    if (hasCompression) {
      if (groups.length >= 8) return undefined
    } else if (groups.length !== 8) {
      return undefined
    }
    return value
  }
  return undefined
}

/** 附用户设置的 XFF（若有）。⚠️ 先查 CR/LF 再 trim（防头注入）。 */
function withXff(headers, xff) {
  if (typeof xff !== 'string') return headers
  if (/[\r\n]/.test(xff)) return headers
  const value = xff.trim()
  if (value.length === 0) return headers
  headers.set('X-Forwarded-For', value)
  return headers
}

/**
 * 推理请求头（Anthropic Messages 端点）。⚠️ 实测不需要 anthropic-version。
 *
 * @param accept 默认 `text/event-stream`（流式）；非流式请求传 `application/json`。
 */
export function inferHeaders(credential, xff, accept = 'text/event-stream') {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', accept)
  return withXff(headers, xff)
}

/** 业务请求头（目录 / 签到 / 积分）。 */
export function apiHeaders(credential, xff) {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'application/json')
  return withXff(headers, xff)
}

/**
 * 「传输级重试 + 保凭据跟随重定向」的完整发送入口。
 *
 * ⚠️ 顺序刻意：重试包在**外层** —— 传输错误在任何一跳都可能发生，
 * 重试必须罩住整条重定向链。
 *
 * @param buildInit `(currentUrl, prevStatus) => RequestInit`：**每跳调用一次**，
 *   从结构上保证「重新附头」漏不掉。prevStatus 是上一跳状态码
 *   （301/302/303 按规范应降级 GET，由 buildInit 自行处理；本家实测只出现 307）。
 */
export async function minimaxFetch(url, buildInit, options = {}) {
  const fetcher = options.fetcher ?? fetch
  const signal = options.signal
  const maxHops = options.maxHops ?? REDIRECT_MAX_HOPS
  const onGeoRoute = options.onGeoRoute

  const sendWithRedirects = async () => {
    let currentUrl = url
    let prevStatus
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const init = buildInit(currentUrl, prevStatus)
      // ⚠️ redirect:'manual'：否则 fetch 自己跟并剥掉 Authorization。
      const response = await fetcher(currentUrl, { ...init, redirect: 'manual' })
      if (!FOLLOWABLE.has(response.status)) return response
      if (signal?.aborted === true) return response
      const location = response.headers.get('location')
      if (location === null || location.length === 0) return response
      // ⚠️ 必须在**跟随之前**判地理路由（跟随后与「凭据失效」同形，分不清了）。
      try {
        if (isGeoRoute(new URL(currentUrl).hostname, response.status, location)) onGeoRoute?.()
      } catch { /* URL 解析失败不影响主流程 */ }
      let nextUrl
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        return response
      }
      // 不跟不可信主机：原样返回 3xx，由调用方按非 2xx 报错，绝不假装成功。
      if (nextUrl.protocol !== 'https:' || !isTrustedHost(nextUrl.hostname)) return response
      if (hop === maxHops) return response
      await response.body?.cancel().catch(() => undefined)
      prevStatus = response.status
      currentUrl = nextUrl.toString()
    }
    throw new Error('minimax: redirect follow exhausted')
  }

  return fetchWithRetry(sendWithRedirects, signal, options.retries)
}
