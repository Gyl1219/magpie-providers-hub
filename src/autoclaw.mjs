// AutoClaw（智谱清言桌面端协议）—— 国内 + 国际两个渠道，一套实现。
//
// 移植自上游 dsh-providers-hub 的 autoclaw-{product,oauth,credits,adapter}.ts 终态。
//
// ## 为什么是两个渠道（上游实测裁决，三条判据全中）
//
// 账号体系不互通（手机号 vs 邮箱 OAuth）+ API 主机不同 + 登录方式不同；
// 实测国内 token 打国际基址 → 410000/401 全拒。appId/appKey 两站通用。
//
// ## 协议要点（每条都来自上游真机取证，别凭直觉改）
//
// - 签名：X-Auth-Sign = MD5(appId & ts & appKey)，ts 为秒级字符串。
// - `X-Version: '2.1.1'` 是推理**硬校验头**：缺它 → HTTP 500 且响应体为空
//   （不像 401/400/406 给原因），真机二分实测唯此头关键。
// - 406 绕过：messages[0] 必须是 system 且内容**完全精确等于**固定前缀，
//   原生人设放 messages[1]（prepareAutoclawMessages）。
// - max_tokens：官方阈值 >= 10000（低了 406）或**完全不发**；上限按模型声明夹取。
// - 思考档位（low/high/max）：上游对非法档位**回 200 并按最贵档跑** ——
//   必须本地拦截（不发该字段），不能指望上游拒绝。
// - 过期：**JWT 的 exp 是唯一权威**（iat→exp 实测恒 86400s；登录/续期响应的
//   声明值会偏大 6 天 —— 上游曾因此编造 7 天导致凭据过期后不自愈，真实 P0）。
// - refresh_token 可为空：**可用 ≠ 可续期**（两码事，不由同一判据回答）。

import { createHash, createDecipheriv, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { loadCredential, saveCredential, untilText } from './shared.mjs'

const REQUEST_TIMEOUT_MS = 60_000
const CREDITS_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 5 * 60_1000
const PHONE_RE = /^1[3-9]\d{9}$/

const CHAT_PATH = '/autoclaw-proxy/proxy/autoclaw/chat/completions'
const REFRESH_PATHS = ['/userapi/v1/refresh', '/userapi/v1/agent-refresh']
const MODEL_CONFIG_PATH = '/autoclaw-proxy/proxy/autoclaw-model-config'
const WALLETS_PATH = '/agent-assetmgr/api/v2/wallets'
const LEDGERS_PATH = '/agent-assetmgr/api/v1/ledgers_std'
/** 每日签到：POST /userapi/v1/user-info（幂等判据在响应体，不在状态码）。 */
const DAILY_CLAIM_PATH = '/userapi/v1/user-info'
const SEND_CODE_PATH = '/userapi/v1/agent-send-code'
const LOGIN_PATH = '/userapi/v1/agent-login'
/** 国际版 OAuth：换 token（overseasv1 命名空间，仅国际站有；两 vendor 同构）。 */
const OAUTH_EXCHANGE_PATH = '/userapi/overseasv1'
/**
 * ⚠️⚠️ 授权页地址**必须向上游要**（`POST /userapi/overseasv1/<vendor>-oauth-url`），
 *    绝不能自己打开 `https://chat.z.ai/auth`（真机 2026-10-29）：
 *    那是**网页端路由**，未登录访客会被 CDN 按 IP 弹「请切换至中国站点 →
 *    zchat.z.ai」，OAuth 流程永远回不了回调端口；而 `<vendor>-oauth-url` 返回的
 *    是官方客户端「用 Google/z.ai 登录」按钮背后调的**专用授权页**，没有网页端
 *    的地域弹窗 —— 这就是社区 opencode-autoclaw-auth 不跳国内、我们会跳的全部原因。
 *    （对齐社区 packages/autoclaw 的 /open-auth 实现，含 state 校验。）
 */
const OAUTH_URL_PATH = '/userapi/overseasv1'

/** OAuth 回调端口候选（与官方客户端逐字相同，按序试；官方白名单只认这组端口）。 */
const OAUTH_CALLBACK_PORTS = [18432, 19654, 19723, 53699]

const CLIENT_VERSION = '2.1.1'
const SOURCE_ID = 'autoclaw'
const REQUIRED_SYSTEM_PREFIX = 'You are AutoClaw. Answer the user directly and concisely'
/** 上游实测的官方网关 max_tokens 下限（低于回 406）；或不发该字段。 */
const MAX_TOKENS_FLOOR = 10_000
/** 声明的思考档位（上游取证：相邻档位推理量波动 16 倍区间重叠，只给三个端点档）。 */
const DECLARED_EFFORTS = ['low', 'high', 'max']

// ── 产品常量（两站只差 id / 显示名 / 基址 / userData 目录）────────────────

const AUTOCLAW = {
  id: 'autoclaw',
  displayName: 'AutoClaw (智谱)',
  apiBase: 'https://autoglm-acceleration-api.zhipuai.cn',
  appId: '100003',
  appKey: '38d2391985e2369a5fb8227d8e6cd5e5',
  userDataDirName: 'AutoClaw-official',
  intl: false,
}

const AUTOCLAW_INTL = {
  id: 'autoclawintl',
  displayName: 'AutoClaw (国际版)',
  apiBase: 'https://autoglm-api.autoglm.ai',
  appId: AUTOCLAW.appId,
  appKey: AUTOCLAW.appKey,
  userDataDirName: 'AutoClaw-oversea-official',
  intl: true,
}

/**
 * 兜底模型表（上游 2026-10-17 真机取证 + 2026-10-21 二轮审计订正）。
 *
 * ⚠️ `zai_glm-5.3-flash` 不在远端目录里，但直接调用仍 200 —— 保留它，
 *    且 `isFree` 已订正为 false（实测走统一积分钱包扣减，并非免费）。
 * ⚠️ 四模型 supportsImage 全部 true（实测；远端对 zai_auto 漏报 input）。
 */
const FALLBACK_MODELS = [
  { id: 'zai_glm-5.3-flash', name: 'GLM-5.3 Flash (AutoClaw)', contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  { id: 'zaicoding_glm-5.3', name: 'GLM-5.3 (AutoClaw)', contextWindow: 1_048_576, maxOutputTokens: 307_200 },
  { id: 'zai_auto', name: 'Auto (AutoClaw)', contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  { id: 'zai_auto-fast', name: 'Auto-Fast (AutoClaw)', contextWindow: 1_048_576, maxOutputTokens: 131_072 },
]

const WALLET_TYPE_LABELS = {
  reward: '奖励积分', daily: '每日积分', subscription: '签约积分',
  'fuel_pack': '加油包积分', other: '其他积分',
}

// ── 签名与凭据纯函数 ─────────────────────────────────────────────────────

const md5 = (s) => createHash('md5').update(s).digest('hex')
const sign = (product, ts) => md5(`${product.appId}&${ts}&${product.appKey}`)
const cleanBearer = (raw) => (typeof raw === 'string' ? raw.trim().replace(/^Bearer\s+/i, '').trim() : '')

/** 解 JWT payload（不验签 —— 上游网关自己也只按 exp/user_id 读）。 */
function jwtPayload(token) {
  const parts = cleanBearer(token).split('.')
  if (parts.length !== 3) return undefined
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * JWT 的 exp 是唯一权威死线（毫秒）。读不到 → undefined（= 不知道，
 * 调用方按「该续期」处理）—— 绝不编造数字（上游 P0 教训）。
 */
function jwtExpiresAtMs(token) {
  const exp = jwtPayload(token)?.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
  return exp > 1e12 ? Math.floor(exp) : exp > 1e9 ? Math.floor(exp * 1000) : undefined
}

function readUserIdFromJwt(token) {
  const raw = jwtPayload(token)?.user_id
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return undefined
}

/** 归一化过期值（毫秒串/秒数/相对秒/ISO → 毫秒）。 */
function expiresAtMs(value) {
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) {
      const n = Number(value)
      return n > 1e12 ? n : n > 1e9 ? n * 1000 : Date.now() + n * 1000
    }
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.floor(value) : value > 1e9 ? Math.floor(value * 1000) : Math.floor(Date.now() + value * 1000)
  }
  return undefined
}

/**
 * 归一凭据：access_token 是唯一硬条件（refresh 空 = 可用但不可续期）。
 * expires_at 一律以 JWT exp 优先（声明值会偏大 6 天）。
 */
export function normalizeCredential(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return undefined }
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw
  const access = cleanBearer(typeof c.access_token === 'string' ? c.access_token : c.accessToken)
  if (access === '') return undefined
  const refresh = cleanBearer(
    typeof c.refresh_token === 'string' ? c.refresh_token : (typeof c.refreshToken === 'string' ? c.refreshToken : ''),
  )
  const declared = expiresAtMs(c.expires_at) ?? expiresAtMs(c.expiresAt) ?? expiresAtMs(c.expires_in)
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: jwtExpiresAtMs(access) ?? declared,
    user_id: c.user_id ?? c.userId ?? readUserIdFromJwt(access),
    device_id: typeof c.device_id === 'string' ? c.device_id : undefined,
    user_name: c.user_name ?? c.userName,
    user_phone: c.user_phone ?? c.userPhone,
  }
}

/** 展示名：脱敏手机号 → 用户名 → 用户<id>（ScreenName 类自动名无法区分多账号）。 */
export function displayNickname(credential, fallbackId = 'AutoClaw') {
  if (credential === undefined) return fallbackId
  const phone = typeof credential.user_phone === 'string' ? credential.user_phone.trim() : ''
  if (phone !== '') return PHONE_RE.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone
  const name = typeof credential.user_name === 'string' ? credential.user_name.trim() : ''
  if (name !== '') return name
  if (credential.user_id !== undefined && String(credential.user_id).trim() !== '') return `用户${credential.user_id}`
  return fallbackId
}

/** 临期判据（提前 10 分钟）；无过期信息保守视为未过期（401 路径兜底）。 */
export function expired(credential) {
  const at = credential?.expires_at
  if (at === undefined) return false
  return at - Date.now() < 10 * 60_000
}

// ── 请求头三套 ───────────────────────────────────────────────────────────

/** chat 头：X-Version 硬校验 + 签名三件套 + X-Authorization（不是 Authorization）。 */
function chatHeaders(product, credential, modelId, stream) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const headers = {
    'Content-Type': 'application/json',
    'X-Version': CLIENT_VERSION,
    'X-Auth-Appid': product.appId,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign(product, ts),
    'X-Authorization': `Bearer ${cleanBearer(credential.access_token)}`,
    'X-Request-Model': modelId,
    'X-Product': SOURCE_ID,
  }
  if (stream) headers.Accept = 'text/event-stream'
  return headers
}

/** credits 头：X-Authorization 与 Authorization 同值各发一次（上游实测形态）。 */
function creditsHeaders(product, credential) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const auth = `Bearer ${cleanBearer(credential.access_token)}`
  return {
    'Content-Type': 'application/json',
    'X-Auth-Appid': product.appId,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign(product, ts),
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'User-Agent': `AutoClaw/2.1.0 (win)`,
    'X-Authorization': auth,
    Authorization: auth,
  }
}

/** auth/refresh/exchange 头（国际 exchange 另需 X-Tm/X-Lang/UA）。 */
function authHeaders(product, { intl = false } = {}) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-Appid': product.appId,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign(product, ts),
  }
  if (intl) {
    // ⚠️ 这三个头缺一不可（实测缺 → 410000「用户未登录」，其实压根没进登录逻辑）
    headers['X-Version'] = CLIENT_VERSION
    headers['X-Tm'] = 'win'
    headers['X-Product'] = SOURCE_ID
    headers['X-Lang'] = 'en-US'
    headers['X-Channel'] = 'official'
    headers['User-Agent'] = `AutoClaw/${CLIENT_VERSION} (win)`
  } else {
    headers['X-Lang'] = 'zh-CN'
    headers['X-Channel'] = 'official'
  }
  return headers
}

// ── 406 绕过 / max_tokens / 档位门禁 ─────────────────────────────────────

// ── 历史形态修复 + 措辞清洗（社区 0.2.9 / 0.2.10 实测，plugins#437 / #466）──
//
// ① 历史里这些形态会被网关回 500 {"message":"parse response failed"}（没有别的原因）：
//    content 为 null/缺失、上轮的 reasoning_content（AutoClaw 自己的客户端不回传）、
//    tool_calls[].function.arguments 不是字符串、tools 不是非空数组。
// ② 历史（system/developer）里出现**别家 agent 的开场白指纹**会被 406，必须改写措辞。
//
// ⚠️ 只清洗 system/developer（用户/助手的对话内容不碰）；只改**已被证明**会被拒的
//    措辞，其它原样发（改写会动到模型的自我认知，宁可少改）。
const FLAGGED = [
  [/You are a Claude agent, built on Anthropic's Claude Agent SDK\.?/gi, 'You are a coding assistant.'],
  [/(?:Anthropic's |the )?Claude Agent SDK/gi, 'the agent framework'],
  [/You are an AI agent powered by DeepSeek Harness/gi, 'You are an AI agent powered by DeepSeek-Harness'],
  [/You are Claude Code/gi, 'You are the Claude Code CLI'],
  [/You are Codex/gi, 'You are the Codex agent'],
  [/Codex CLI/gi, 'Codex command-line tool'],
  [/You are opencode/gi, 'You are the opencode agent'],
  [/You are Cursor/gi, 'You are the Cursor agent'],
  [/You are Cline/gi, 'You are the Cline agent'],
  [/You are Qwen Code/gi, 'You are the Qwen Code agent'],
  [/You are ZCode/gi, 'You are the ZCode agent'],
  [/operating inside pi, a coding agent harness/gi, 'operating inside the pi coding agent harness'],
  // "This conversation is powered by GLM-<版本>" 任何版本/任何位置都被 CN 网关拒（406）
  [/This conversation is powered by GLM-([\w-]+(?:\.[\w-]+)*)/gi, 'This conversation is powered by the GLM-$1 model'],
  [/You are CodeBuddy Code/gi, 'You are the CodeBuddy Code CLI'],
]

export function unflagged(text) {
  for (const [re, to] of FLAGGED) text = text.replace(re, to)
  return text
}

/** 措辞清洗（只动 system/developer 消息的文本） */
function unflagMessages(messages) {
  for (const m of messages) {
    if (!m || (m.role !== 'system' && m.role !== 'developer')) continue
    if (typeof m.content === 'string') m.content = unflagged(m.content)
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') part.text = unflagged(part.text)
    }
  }
}

/**
 * 发车前把「网关读不了的历史形态」就地修好（社区 tidyBody 同款）。
 * ⚠️ 修完再跑措辞清洗 —— 顺序无所谓，但两者都不能漏（各自对应 500 / 406）。
 */
export function tidyWire(wire) {
  if (Array.isArray(wire.messages)) {
    wire.messages = wire.messages.map((m) => {
      if (!m || typeof m !== 'object') return m
      const out = { ...m }
      if (out.content == null) out.content = ''
      delete out.reasoning_content // 自己客户端不回传上轮 reasoning
      if (Array.isArray(out.tool_calls)) {
        out.tool_calls = out.tool_calls.map((c) => {
          const args = c?.function?.arguments
          if (!c?.function || typeof args === 'string') return c
          return { ...c, function: { ...c.function, arguments: args == null ? '{}' : JSON.stringify(args) } }
        })
      }
      return out
    })
  }
  if ('tools' in wire && !(Array.isArray(wire.tools) && wire.tools.length > 0)) {
    delete wire.tools
    delete wire.tool_choice
  }
  unflagMessages(wire.messages ?? [])
  return wire
}

/**
 * messages[0] 必须逐字等于白名单前缀（否则 406）。原生 system 拆两条：
 * [0] 过检、[1] 保人设；首条不是 system 则前置。
 */
export function prepareMessages(messages) {
  const list = Array.isArray(messages) && messages.length > 0 ? [...messages] : []
  if (list.length === 0) return [{ role: 'system', content: REQUIRED_SYSTEM_PREFIX }]
  const first = list[0]
  if (first?.role === 'system') {
    if (first.content === REQUIRED_SYSTEM_PREFIX) return list
    const text = typeof first.content === 'string' ? first.content.trim()
      : Array.isArray(first.content)
        ? first.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n').trim()
        : String(first.content ?? '').trim()
    // 已含前缀则剥离避免重复
    let rest = text
    if (rest.startsWith(REQUIRED_SYSTEM_PREFIX)) {
      rest = rest.slice(REQUIRED_SYSTEM_PREFIX.length).trim()
      if (rest.startsWith('.')) rest = rest.slice(1).trim()
    }
    const out = [{ role: 'system', content: REQUIRED_SYSTEM_PREFIX }]
    if (rest !== '') out.push({ ...first, content: rest })
    out.push(...list.slice(1))
    return out
  }
  return [{ role: 'system', content: REQUIRED_SYSTEM_PREFIX }, ...list]
}

/** max_tokens 双向夹取：不发 / floor 10000 / 按模型声明夹上限。绝不编造。 */
export function clampMaxTokens(requested, declared) {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return undefined
  const floored = Math.max(MAX_TOKENS_FLOOR, Math.floor(requested))
  return declared !== undefined && Number.isSafeInteger(declared) && declared > 0
    ? Math.min(floored, declared)
    : floored
}

/**
 * 档位本地门禁：∈ {low,high,max} 才发 reasoning_effort；否则不发
 * （上游对非法档位回 200 并按最贵档跑 —— 静默烧钱，必须本地拦）。
 */
export function effortForRequest(requested, declared = DECLARED_EFFORTS) {
  if (typeof requested !== 'string' || requested.trim() === '') return { effort: undefined }
  const effort = requested.trim()
  if (declared.includes(effort)) return { effort }
  return { effort: undefined, dropped: effort, reason: `本模型只声明 ${declared.join('/')}` }
}

/** 模型 id 归一（裸名 → zai_ 前缀；zaicoding_ 直通）。 */
export function normalizeModel(modelId) {
  const t = typeof modelId === 'string' ? modelId.trim() : ''
  if (t === '') return 'zai_glm-5.3-flash'
  if (t.startsWith('zai_') || t.startsWith('zaicoding_')) return t
  if (t === 'glm-5.3-flash') return 'zai_glm-5.3-flash'
  if (t === 'glm-5.3' || t === 'glm-5.3-coding') return 'zaicoding_glm-5.3'
  if (t === 'auto') return 'zai_auto'
  return `zai_${t}`
}

// ── 错误分类（先额度、再认证、后状态码 —— 顺序不可颠倒）──────────────────

export function isQuotaError(bodyText) {
  const t = bodyText.toLowerCase()
  return t.includes('insufficient') || t.includes('quota') || t.includes('余额不足')
    || t.includes('额度不足') || t.includes('积分不足') || t.includes('积分已用尽')
    || t.includes('额度已用尽') || t.includes('余额已用尽')
}

export function isAuthError(bodyText) {
  const t = bodyText.toLowerCase()
  return t.includes('invalid token') || t.includes('token expired') || t.includes('unauthorized')
    || t.includes('未登录') || t.includes('登录已失效')
}

// ── 本地凭据一键导入（Electron: DPAPI masterKey + AES-256-GCM）───────────

/**
 * 读本机桌面端凭据（%APPDATA%\<userDataDirName>）。
 *
 * 三步：Local State 的 os_crypt.encrypted_key（DPAPI 前缀 5 字节）→
 * PowerShell ProtectedData.Unprotect 解 masterKey → accounts/<id>/
 * account-credentials.enc（3 前缀 + 12 nonce + ct + 16 tag）AES-256-GCM。
 *
 * ⚠️ 目录名必须按 product.userDataDirName（上游审计 P0：写死国内目录会让
 *    国际版导入到国内凭据，症状「国际卡片显示国内手机号」）。
 */
export function probeLocalCredential(product) {
  try {
    const appData = process.env.DSH_AUTOCLAW_APPDATA
      ?? process.env.APPDATA
      ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined)
    if (appData === undefined) return undefined
    const dir = path.join(appData, product.userDataDirName)
    const localStatePath = path.join(dir, 'Local State')
    if (!fs.existsSync(localStatePath)) return undefined
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
    const encKeyB64 = localState?.os_crypt?.encrypted_key
    if (typeof encKeyB64 !== 'string') return undefined
    const encKeyBuf = Buffer.from(encKeyB64, 'base64')
    if (!encKeyBuf.subarray(0, 5).equals(Buffer.from('DPAPI'))) return undefined
    const psScript = `
      Add-Type -AssemblyName System.Security
      $hex = "${encKeyBuf.subarray(5).toString('hex')}"
      $bytes = for ($i=0; $i -lt $hex.Length; $i+=2) { [Convert]::ToByte($hex.Substring($i, 2), 16) }
      $unprotected = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Convert]::ToBase64String($unprotected)
    `
    const masterKey = Buffer.from(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { encoding: 'utf8', timeout: 10_000 }).trim(),
      'base64',
    )
    const accountsDir = path.join(dir, 'accounts')
    if (!fs.existsSync(accountsDir)) return undefined
    for (const ent of fs.readdirSync(accountsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const credFile = path.join(accountsDir, ent.name, 'account-credentials.enc')
      if (!fs.existsSync(credFile)) continue
      const encData = fs.readFileSync(credFile)
      if (encData.length < 31) continue
      const nonce = encData.subarray(3, 15)
      const ctAndTag = encData.subarray(15)
      const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
      decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16))
      const parsed = JSON.parse(Buffer.concat([
        decipher.update(ctAndTag.subarray(0, ctAndTag.length - 16)),
        decipher.final(),
      ]).toString('utf8'))
      const rawAccess = parsed.accessToken ?? parsed.access_token
      const rawRefresh = parsed.refreshToken ?? parsed.refresh_token
      if (typeof rawAccess !== 'string' || typeof rawRefresh !== 'string') continue
      // profile 补身份（手机号/显示名），JWT 补 user_id/device_id/exp
      let profilePhone, profileName
      const profilePath = path.join(accountsDir, ent.name, 'account-profile.json')
      if (fs.existsSync(profilePath)) {
        try {
          const prof = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
          profilePhone = prof?.profile?.phone
          profileName = prof?.profile?.displayName
        } catch { /* profile 解析失败不影响凭据 */ }
      }
      const jwt = jwtPayload(rawAccess) ?? {}
      const jwtPhone = typeof jwt.jti === 'string' && PHONE_RE.test(jwt.jti.trim()) ? jwt.jti.trim() : undefined
      return normalizeCredential({
        access_token: rawAccess,
        refresh_token: rawRefresh,
        // JWT exp 优先（桌面端写的 expiresAt 与真实死线不同源）
        expires_at: jwtExpiresAtMs(rawAccess) ?? expiresAtMs(parsed.expiresAt),
        user_id: parsed.userId ?? jwt.user_id,
        device_id: parsed.deviceId ?? jwt.device_id,
        user_name: profileName ?? parsed.userName,
        user_phone: profilePhone ?? jwtPhone ?? parsed.userPhone ?? parsed.phone,
      })
    }
    return undefined
  } catch {
    return undefined
  }
}

/** device_id：真实桌面端的优先（风控把它当设备身份），没有就 randomUUID。 */
function resolveDeviceId(product, explicitId) {
  if (typeof explicitId === 'string' && explicitId.trim() !== '') return explicitId.trim()
  try {
    const appData = process.env.DSH_AUTOCLAW_APPDATA ?? process.env.APPDATA
      ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
    const p = path.join(appData, product.userDataDirName, 'device', 'device-id.json')
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (typeof data.deviceId === 'string' && data.deviceId.trim() !== '') return data.deviceId.trim()
    }
  } catch { /* 读不到就随机 */ }
  return randomUUID()
}

// ── 网络：短信登录 / 刷新 / 钱包 / 流水 / 签到 ───────────────────────────

async function sendVerificationCode(product, phone, deviceId) {
  const resp = await fetch(`${product.apiBase}${SEND_CODE_PATH}`, {
    method: 'POST',
    headers: authHeaders(product),
    body: JSON.stringify({ phone, source_id: SOURCE_ID, device_id: deviceId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) return { ok: false, error: `验证码发送失败(${resp.status})` }
  if (json.code !== 0) return { ok: false, error: json.msg || `验证码发送失败(错误码: ${json.code})` }
  return { ok: true }
}

async function loginWithCode(product, phone, code, deviceId) {
  const numCode = Number(code)
  if (!Number.isSafeInteger(numCode)) return { ok: false, error: '验证码必须为纯数字' }
  const resp = await fetch(`${product.apiBase}${LOGIN_PATH}`, {
    method: 'POST',
    headers: authHeaders(product),
    body: JSON.stringify({ phone, code: numCode, source_id: SOURCE_ID, device_id: deviceId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) return { ok: false, error: `登录请求失败(${resp.status})` }
  if (json.code !== 0 || !json.data?.access_token) {
    return { ok: false, error: json.msg || `登录失败(错误码: ${json.code})` }
  }
  const d = json.data
  const declared = expiresAtMs(d.expires_at) ?? expiresAtMs(d.expires_in)
  // 绝不编造过期：JWT exp 优先，读不到就 undefined
  return {
    ok: true,
    credential: normalizeCredential({
      access_token: d.access_token,
      refresh_token: d.refresh_token ?? '',
      expires_at: jwtExpiresAtMs(d.access_token) ?? declared,
      // 登录端点不下发 user_id —— 必须从 JWT 兜底，否则续期一次丢一次身份
      user_id: d.user_id ?? readUserIdFromJwt(d.access_token),
      user_name: d.user_name,
      user_phone: d.user_phone ?? phone,
      device_id: deviceId,
    }),
  }
}

/**
 * 国际版 OAuth 授权码换 token（两 vendor 同构：`<vendor>-oauth-login`）。
 *
 * ⚠️ `state` 必须是 `oauth-url` 授予地址里带回的那个（本插件的 intl 回调 handler
 *    已逐字校验）；这里只透传不解析。
 */
async function exchangeOAuthCode(product, vendor, code, state, navigateUri, deviceId) {
  const label = vendor === 'google' ? 'Google' : 'Z.ai'
  const resp = await fetch(`${product.apiBase}${OAUTH_EXCHANGE_PATH}/${vendor}-oauth-login`, {
    method: 'POST',
    headers: authHeaders(product, { intl: true }),
    body: JSON.stringify({ code: code.trim(), state, navigate_uri: navigateUri, source_id: SOURCE_ID, device_id: deviceId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) return { ok: false, error: `${label} 授权失败(${resp.status})` }
  if (json.code !== 0 || !json.data?.access_token) {
    return { ok: false, error: json.msg || `${label} 授权失败(错误码: ${json.code})` }
  }
  const d = json.data
  const declared = expiresAtMs(d.expires_at) ?? expiresAtMs(d.expires_in)
  return {
    ok: true,
    credential: normalizeCredential({
      access_token: d.access_token,
      refresh_token: d.refresh_token ?? '',
      expires_at: jwtExpiresAtMs(d.access_token) ?? declared,
      user_id: d.user_id ?? readUserIdFromJwt(d.access_token),
      user_name: d.user_name,
      user_phone: d.user_phone,
      device_id: deviceId,
    }),
  }
}

/** 刷新（两个端点按序回退）。返回归一凭据；失败抛错。 */
async function refreshToken(product, credential) {
  const deviceId = credential.device_id ?? resolveDeviceId(product)
  let lastError
  for (const ep of REFRESH_PATHS) {
    const ts = Math.floor(Date.now() / 1000).toString()
    try {
      const resp = await fetch(`${product.apiBase}${ep}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Appid': product.appId,
          'X-Auth-TimeStamp': ts,
          'X-Auth-Sign': sign(product, ts),
        },
        body: JSON.stringify({ refresh_token: cleanBearer(credential.refresh_token), source_id: SOURCE_ID, device_id: deviceId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!resp.ok) throw new Error(`refresh HTTP ${resp.status}`)
      const json = await resp.json()
      if (json.code !== 0 || !json.data?.access_token) {
        throw new Error(`refresh code ${json.code}: ${json.msg ?? 'unknown'}`)
      }
      const declared = expiresAtMs(json.data.expires_at) ?? expiresAtMs(json.data.expires_in)
      return normalizeCredential({
        access_token: json.data.access_token,
        // 响应可能不带新 refresh —— 保留旧值
        refresh_token: json.data.refresh_token ?? credential.refresh_token,
        expires_at: jwtExpiresAtMs(json.data.access_token) ?? declared,
        // ⚠️ 刷新端点不下发 user_id —— JWT 兜底，否则续期丢身份（上游 P1）
        user_id: json.data.user_id ?? readUserIdFromJwt(json.data.access_token) ?? credential.user_id,
        user_name: credential.user_name,
        user_phone: credential.user_phone,
        device_id: deviceId,
      })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('AutoClaw 续期失败（所有端点）')
}

// ── 钱包 / 流水批次 / 签到 ───────────────────────────────────────────────

/** 钱包五池 → windows（display:false 必须丢弃 —— 「每日 0」红字的根因）。 */
function parseWallets(walletsRaw) {
  if (!Array.isArray(walletsRaw)) return []
  const items = []
  for (const raw of walletsRaw) {
    if (typeof raw !== 'object' || raw === null) continue
    items.push({
      type: typeof raw.public_wallet_type === 'string' ? raw.public_wallet_type : 'other',
      name: typeof raw.display_name === 'string' && raw.display_name.trim() !== '' ? raw.display_name.trim() : undefined,
      balance: typeof raw.balance === 'number' && Number.isFinite(raw.balance) ? raw.balance : 0,
      // ⚠️ 缺字段判为不可见（fail-closed，官方客户端同款严格判断）
      display: raw.display === true,
      priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 100,
    })
  }
  return items
    .filter((i) => i.display !== false)
    .sort((a, b) => a.priority - b.priority)
}

/**
 * 流水 → 按到期批次分桶（净额口径：credit − debit − expire）。
 *
 * ⚠️ 三种 mutation_type 都参与；负 credit（冲正）丢弃但负 debit/expire 保留。
 * ⚠️ wallet_expires_at 只认 number（秒）；已过期批次丢弃（余额里已没有）。
 * ⚠️ 永久桶按描述分列（不混一桶）。
 */
export function parseLedgerBatches(entriesRaw, nowMs = Date.now()) {
  if (!Array.isArray(entriesRaw)) return []
  const nowSec = nowMs / 1000
  const byExpiry = new Map()
  const permanentByLabel = new Map()
  for (const raw of entriesRaw) {
    if (typeof raw !== 'object' || raw === null) continue
    const type = raw.mutation_type
    if (type !== 'credit' && type !== 'debit' && type !== 'expire') continue
    const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : 0
    if (amount === 0) continue
    if (type === 'credit' && amount < 0) continue
    const meta = typeof raw.metadata === 'object' && raw.metadata !== null ? raw.metadata : {}
    const label = [meta.description, raw.description, raw.source].find((v) => typeof v === 'string' && v.trim() !== '')
    const name = typeof label === 'string' ? label.trim() : '积分发放'
    const exp = typeof raw.wallet_expires_at === 'number' && Number.isFinite(raw.wallet_expires_at) ? raw.wallet_expires_at : undefined
    if (exp === undefined || exp <= 0) {
      permanentByLabel.set(name, (permanentByLabel.get(name) ?? 0) + amount)
      continue
    }
    if (exp <= nowSec) continue
    const bucket = byExpiry.get(exp) ?? { amount: 0, label: name }
    bucket.amount += amount
    byExpiry.set(exp, bucket)
  }
  const batches = []
  for (const [expSec, batch] of [...byExpiry.entries()].sort((a, b) => a[0] - b[0])) {
    if (batch.amount > 0) batches.push({ name: batch.label, remaining: batch.amount, expiresAtMs: expSec * 1000 })
  }
  for (const [label, amount] of permanentByLabel) {
    if (amount > 0) batches.push({ name: label, remaining: amount, expiresAtMs: undefined })
  }
  return batches
}

/** 钱包 + 流水批次 → magpie usage windows（守恒安全网：偏差超容差回退钱包包）。 */
async function usage(product, credential) {
  const resp = await fetch(`${product.apiBase}${WALLETS_PATH}?biz_app_id=${SOURCE_ID}`, {
    headers: creditsHeaders(product, credential),
    signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    if (resp.status === 401) {
      const err = new Error(`AutoClaw 登录凭据失效，请重新登录（HTTP 401${text !== '' ? `：${text.slice(0, 120)}` : ''}）`)
      err.signedOut = true
      throw err
    }
    throw new Error(`AutoClaw 钱包查询失败（HTTP ${resp.status}${text !== '' ? `：${text.slice(0, 120)}` : ''}）`)
  }
  let json
  try { json = JSON.parse(text) } catch { throw new Error('AutoClaw 钱包查询失败：响应不是 JSON') }
  if (json.code !== 0) {
    if (json.code === 410000) {
      const err = new Error(`AutoClaw 登录凭据失效，请重新登录（${json.msg ?? '用户未登录'}）`)
      err.signedOut = true
      throw err
    }
    throw new Error(`AutoClaw 钱包查询失败（code ${json.code}：${json.msg ?? '未知错误'}）`)
  }
  const total = typeof json.data?.total_balance === 'number' ? json.data.total_balance : 0
  const wallets = parseWallets(json.data?.wallets)

  // ── 流水批次（唯一逐批次到期源；守恒容差：max(100, 1%) 吸收翻页误差）──
  let batches = []
  if (total > 0) {
    try {
      const entries = await fetchLedgers(product, credential)
      const parsed = parseLedgerBatches(entries)
      const sum = parsed.reduce((s, b) => s + b.remaining, 0)
      const tolerance = Math.max(100, Math.floor(total * 0.01))
      if (parsed.length > 0 && Math.abs(sum - total) <= tolerance) batches = parsed
    } catch { /* 流水不可达 → 回退钱包包（总额仍对，只是无逐批次到期） */ }
  }

  const windows = []
  const source = batches.length > 0
    ? batches
    : wallets.map((w) => ({ name: w.name ?? WALLET_TYPE_LABELS[w.type] ?? `${w.type}积分`, remaining: w.balance, expiresAtMs: undefined }))
  for (const b of source) {
    if (b.remaining <= 0) continue
    const iso = b.expiresAtMs !== undefined ? new Date(b.expiresAtMs).toISOString() : undefined
    const until = iso !== undefined ? untilText(iso) : undefined
    windows.push({
      name: b.name,
      used: 0,
      amount: b.remaining,
      // ⚠️ 倒计时拼进亮色主文本（「将于 X 过期」辅助行浅灰看不清 —— 用户报障）
      display: `${Math.round(b.remaining * 100) / 100}${until !== undefined ? ` · ${until}` : ''}`,
      // ⚠️ runsOutAt 必须带着：tierSummarize 靠它做三档分类（撤掉的当天就出过
      //    「全部归永久、时间全丢」的回归）。汇总输出层会剥掉它（浅灰行去重）。
      ...(iso !== undefined ? { runsOutAt: iso, runsOut: b.remaining } : {}),
    })
  }
  if (windows.length === 0 && total > 0) {
    windows.push({ name: '积分余额', used: 0, amount: total, display: `${total}` })
  }
  return windows
}

/** 流水翻页（flow_direction=all —— 只拉 income 拿不到 debit/expire，批次恒不守恒）。 */
async function fetchLedgers(product, credential) {
  const all = []
  let cursor
  // 整段共用一份时间预算（每页各自 arm 会让最坏耗时超过轮询周期）
  const deadline = AbortSignal.timeout(CREDITS_TIMEOUT_MS)
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({
      asset_type: 'point', wallet_type: 'all', page_size: '100', flow_direction: 'all',
    })
    if (cursor !== undefined) query.set('cursor', cursor)
    try {
      const resp = await fetch(`${product.apiBase}${LEDGERS_PATH}?${query.toString()}`, {
        headers: creditsHeaders(product, credential),
        signal: deadline,
      })
      if (!resp.ok) return all
      const json = await resp.json()
      if (json.code !== 0 || !Array.isArray(json.data?.entries)) return all
      all.push(...json.data.entries)
      const next = json.data.next_cursor ?? json.data.nextCursor
      cursor = typeof next === 'string' && next !== '' ? next : undefined
      if (cursor === undefined) break
    } catch {
      return all
    }
  }
  return all
}

/**
 * 每日签到：POST /userapi/v1/user-info。
 * 幂等判据 = data.daily_check_in_completed_on_request（true=本次领到 / false=已签）。
 * ⚠️ 上游不返回积分数量 —— credit 不编造，文案提示看刷新后的余额。
 */
async function checkin(product, credential) {
  const token = cleanBearer(credential?.access_token ?? '')
  if (token === '') return { outcome: 'failed', message: '凭据缺失，请先登录' }
  // ⚠️ device_id 绝不能写死常量（上游真机取证：共用假设备号会被风控识别）
  const deviceId = credential.device_id ?? randomUUID()
  try {
    const resp = await fetch(`${product.apiBase}${DAILY_CLAIM_PATH}`, {
      method: 'POST',
      headers: creditsHeaders(product, credential),
      body: JSON.stringify({ source_id: SOURCE_ID, device_id: deviceId }),
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    })
    const text = await resp.text().catch(() => '')
    if (!resp.ok) {
      return { outcome: 'failed', message: `签到请求失败（HTTP ${resp.status}${text !== '' ? `：${text.slice(0, 120)}` : ''}）` }
    }
    let json
    try { json = JSON.parse(text) } catch { return { outcome: 'failed', message: '签到响应不是 JSON' } }
    if (json.code !== 0) {
      return { outcome: 'failed', message: json.msg ?? `签到失败（code ${json.code}）` }
    }
    if (json.data?.daily_check_in_completed_on_request === true) {
      return { outcome: 'claimed', message: '签到成功（上游不返回积分数量，请查看刷新后的余额）' }
    }
    return { outcome: 'done', message: '今日已完成签到' }
  } catch (error) {
    return { outcome: 'failed', message: `签到网络异常：${error instanceof Error ? error.message : String(error)}` }
  }
}

// ── 目录 ─────────────────────────────────────────────────────────────────

/** 远端目录解析（照抄桌面端规则：ctx>=1e3、maxTokens<ctx 否则丢条、input 只认 text/image）。 */
export function parseRemoteModels(payload) {
  const out = new Map()
  const lists = []
  if (Array.isArray(payload)) lists.push(payload)
  else if (typeof payload === 'object' && payload !== null) {
    for (const key of ['data', 'models', 'model_list', 'modelList', 'list', 'result']) {
      const v = payload[key]
      if (Array.isArray(v)) { lists.push(v); break }
    }
  }
  for (const list of lists) {
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      if (id === '') continue
      const patch = {}
      const ctx = typeof item.contextWindow === 'number' && Number.isSafeInteger(item.contextWindow) ? item.contextWindow : undefined
      if (ctx !== undefined && ctx >= 1e3 && ctx <= 1e7) patch.contextWindow = ctx
      const max = typeof item.maxTokens === 'number' && Number.isSafeInteger(item.maxTokens) ? item.maxTokens : undefined
      if (max !== undefined && max <= 1e6 && (patch.contextWindow === undefined || max < patch.contextWindow)) {
        patch.maxOutputTokens = max
      }
      if (Array.isArray(item.input)) patch.supportsImage = item.input.some((m) => m === 'image')
      out.set(id, patch)
    }
  }
  return out
}

async function catalog(product, credential) {
  const models = {}
  let remote = new Map()
  if (credential?.access_token) {
    try {
      const resp = await fetch(`${product.apiBase}${MODEL_CONFIG_PATH}`, {
        headers: chatHeaders(product, credential, '', false),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (resp.ok) remote = parseRemoteModels(await resp.json())
    } catch { /* 远端失败回落兜底表 */ }
  }
  for (const entry of FALLBACK_MODELS) {
    const patch = remote.get(entry.id)
    const ctx = patch?.contextWindow ?? entry.contextWindow
    const output = patch?.maxOutputTokens ?? entry.maxOutputTokens
    models[entry.id] = {
      name: entry.name,
      limit: { context: ctx, output },
      tool_call: true,
      capabilities: { temperature: true, reasoning: true, attachment: patch?.supportsImage ?? true },
      options: { reasoning_efforts: DECLARED_EFFORTS, default_reasoning_effort: 'high' },
      headers: {},
      variants: {},
      status: 'active',
      release_date: '',
    }
  }
  return models
}

// ── 对话（标准 OpenAI SSE + 406 前缀 + 头三件套）─────────────────────────

async function chat(product, credential, { body, signal, renew }) {
  const upstreamModel = normalizeModel(body?.model)
  const declared = FALLBACK_MODELS.find((m) => m.id === upstreamModel)?.maxOutputTokens
  const maxTokens = clampMaxTokens(body?.max_tokens, declared)
  const effort = effortForRequest(body?.reasoning_effort)

  const wire = tidyWire({
    ...body,
    model: upstreamModel,
    messages: prepareMessages(body?.messages ?? []),
    stream: true,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  })
  // 档位：集合外的值不发（上游对非法档位回 200 按最贵档跑 —— 静默烧钱）
  if (effort.effort !== undefined) wire.reasoning_effort = effort.effort
  else delete wire.reasoning_effort
  const payload = JSON.stringify(wire)

  const send = (cred) => fetch(`${product.apiBase}${CHAT_PATH}`, {
    method: 'POST',
    headers: chatHeaders(product, cred, upstreamModel, true),
    body: payload,
    signal,
  })

  let response = await send(credential)
  // 401/403：先硬续期一次再重发（服务端撤销早于本地 expires_at 的情形）
  if ((response.status === 401 || response.status === 403) && typeof renew === 'function') {
    let renewed
    try { renewed = await renew(credential) } catch { renewed = undefined }
    if (renewed?.access_token) response = await send(renewed)
  }
  if (!response.ok) {
    // ⚠️ 先读体再分类（额度语义在正文里，body 只能读一次）
    const text = await response.text().catch(() => '')
    const kind = isQuotaError(text) ? '额度不足' : isAuthError(text) ? '凭据失效' : `HTTP ${response.status}`
    return new Response(text || `AutoClaw 请求失败：${kind}`, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'text/plain' },
    })
  }
  return response
}

// ── 登录流 ───────────────────────────────────────────────────────────────

/** 载体页 HTML：一键导入 + 短信（国内）/ OAuth 说明（国际）。 */
function renderLoginPage(product) {
  const importButton = `<button type="button" class="secondary" id="btnLocal">⚡ 一键读取本机 ${product.displayName} 桌面端凭据</button>`
  const smsBlock = product.intl ? '' : `
    <div class="divider">或者使用手机验证码登录</div>
    <div class="form-group"><label>手机号</label><input id="phone" placeholder="请输入 11 位手机号" maxlength="11"></div>
    <div class="form-group"><label>短信验证码</label>
      <div class="row"><input id="code" placeholder="6 位验证码" maxlength="6">
      <button type="button" class="code-btn" id="btnSend">获取验证码</button></div></div>
    <button type="button" class="primary" id="btnLogin">登 录</button>`
  const intlTip = product.intl ? '<p class="tip">国际版账号为邮箱注册（Z.ai/Google OAuth），无手机号通道。若桌面端已登录，推荐一键导入。</p>' : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 ${product.displayName}</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#0f172a;color:#f8fafc;
     display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;width:100%;max-width:420px}
h2{margin:0 0 8px;font-size:20px;color:#38bdf8}
.desc{color:#94a3b8;font-size:13px;margin:0 0 24px}
.secondary{width:100%;background:#334155;color:#f8fafc;border:1px solid #475569;border-radius:6px;
           padding:10px 16px;font-size:14px;cursor:pointer}
.divider{display:flex;align-items:center;text-align:center;margin:20px 0;color:#64748b;font-size:12px}
.divider::before,.divider::after{content:'';flex:1;border-bottom:1px solid #334155}
.divider::before{margin-right:.5em}.divider::after{margin-left:.5em}
label{display:block;font-size:12px;color:#cbd5e1;margin:0 0 6px}
input{width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #475569;border-radius:6px;
      padding:10px 12px;color:#f8fafc;font-size:14px;outline:none}
input:focus{border-color:#38bdf8}
.row{display:flex;gap:8px}.row input{flex:1}
.code-btn{background:#0284c7;color:#fff;border:none;border-radius:6px;padding:0 16px;font-size:13px;
          cursor:pointer;white-space:nowrap}
.code-btn:disabled{background:#475569;cursor:not-allowed}
.primary{width:100%;background:#0284c7;color:#fff;border:none;border-radius:6px;padding:11px 16px;
         font-size:15px;font-weight:500;cursor:pointer;margin-top:8px}
.primary:disabled{background:#475569;cursor:not-allowed}
.tip{color:#64748b;font-size:12px;margin:16px 0 0;line-height:1.5}
#msg{margin-top:16px;padding:10px 12px;border-radius:6px;font-size:13px;min-height:16px}
#msg.err{background:rgba(239,68,68,.15);border:1px solid #ef4444;color:#fca5a5}
#msg.ok{background:rgba(34,197,94,.15);border:1px solid #22c55e;color:#86efac}
</style></head><body>
<div class="card">
<h2>${product.displayName} 登录</h2>
<p class="desc">支持一键读取本机桌面端凭据${product.intl ? '。' : '，或通过手机验证码登录。'}</p>
${importButton}
${smsBlock}
${intlTip}
<div id="msg"></div>
</div>
<script>
const msg = (t, cls) => { const el = document.getElementById('msg'); el.textContent = t || ''; el.className = cls || '' };
document.getElementById('btnLocal').onclick = async () => {
  msg('正在读取本机桌面端凭据…');
  try {
    const r = await fetch('/autoclaw/import-local', { method: 'POST' });
    const j = await r.json();
    if (j.ok) msg('导入成功！可以关闭此页面返回', 'ok'); else msg(j.message || '未找到本机桌面端凭据（请先在桌面端登录）', 'err');
  } catch (e) { msg('导入失败：' + e.message, 'err'); }
};
${product.intl ? '' : `
let cooldown = 0;
document.getElementById('btnSend').onclick = async () => {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return msg('请填手机号', 'err');
  if (cooldown > 0) return;
  msg('正在发送验证码…');
  try {
    const r = await fetch('/autoclaw/sms/send', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ phone }) });
    const j = await r.json();
    if (j.ok) {
      msg('验证码已发送', 'ok'); cooldown = 60;
      const t = setInterval(() => { cooldown -= 1;
        document.getElementById('btnSend').textContent = cooldown > 0 ? cooldown + 's' : '获取验证码';
        if (cooldown <= 0) clearInterval(t); }, 1000);
    } else msg(j.message || '发送失败', 'err');
  } catch (e) { msg('发送失败：' + e.message, 'err'); }
};
document.getElementById('btnLogin').onclick = async () => {
  const phone = document.getElementById('phone').value.trim();
  const code = document.getElementById('code').value.trim();
  if (!phone || !code) return msg('请填手机号和验证码', 'err');
  msg('登录中…');
  try {
    const r = await fetch('/autoclaw/sms/login', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ phone, code }) });
    const j = await r.json();
    if (j.ok) msg('登录成功！可以关闭此页面返回', 'ok'); else msg(j.message || '登录失败', 'err');
  } catch (e) { msg('登录失败：' + e.message, 'err'); }
};`}
</script></body></html>`
}

/**
 * 登录流（对齐 beginLogin 契约：立即返回 url，登录在 result 推进）。
 *
 * 国内：本地载体页（一键导入 / 短信两路）。
 * 国际：本地引导页（Google 账号 / z.ai 账号两按钮）→ 上游现发**专用授权页**
 *       （`<vendor>-oauth-url`）→ 302 回调端口 → state 校验 → 换 token。
 *       + 载体页一键导入兜底（四个回调端口全被占时）。
 */
async function beginLogin(product, openBrowser) {
  if (product.intl) {
    return startIntlFlow(product, openBrowser)
  }
  return beginSmsFlow(product, openBrowser)
}

/**
 * 国际版 OAuth（对齐社区 packages/autoclaw 的 /open-auth 设计）。
 *
 * 流程：本地引导页（选 vendor）→ `POST <overseasv1>/<vendor>-oauth-url`
 * （上游**现发**授权页地址 + state）→ 引导页跳过去 → 授权页 302 回
 * `localhost:<port>/auth/callback-<vendor>` → **state 逐字校验** → 换 token。
 *
 * ⚠️ 三个「绝不能」：
 *   ① 绝不能自己拼 `https://chat.z.ai/auth`（网页端会按 IP 弹中国站跳转，
 *     OAuth 永远回不了回调 —— 见 OAUTH_URL_PATH 头注）；
 *   ② 回调的 state 绝不能不校验（等价于接受任何人塞进来的 code ——
 *     会登录成别人的账号）；
 *   ③ redirect_uri 的端口绝不能随机（官方白名单只认这四个端口 + 固定路径，
 *     其它形态回 `Redirect URI not registered for this client`）。
 */
async function startIntlFlow(product, openBrowser) {
  let server
  let actualPort
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  const closeServer = () => new Promise((resolve) => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
  const timer = setTimeout(() => {
    settleFail(new Error('AutoClaw 国际版授权超时（引导页未完成授权）'))
    void closeServer()
  }, LOGIN_TIMEOUT_MS)
  timer.unref?.()

  /** 本 vendor 的回调地址（官方白名单形态：localhost + 白名单端口 + 固定路径）。 */
  const callbackPathOf = (vendor) => `/auth/callback-${vendor}`
  const navigateUriOf = (vendor) => `http://localhost:${actualPort}${callbackPathOf(vendor)}`

  const settleWith = async (vendor, code, state) => {
    try {
      const out = await exchangeOAuthCode(product, vendor, code, state, navigateUriOf(vendor), resolveDeviceId(product))
      if (!out.ok) throw new Error(out.error)
      clearTimeout(timer)
      settleOk(out.credential)
      setTimeout(() => void closeServer(), 500)
    } catch (error) {
      clearTimeout(timer)
      settleFail(error instanceof Error ? error : new Error(String(error)))
      setTimeout(() => void closeServer(), 500)
    }
  }

  for (const port of OAUTH_CALLBACK_PORTS) {
    /** 当前待授权的会话（vendor + oauth-url 给的 state；一页一次只跑一个 vendor）。 */
    const session = { vendor: undefined, expectedState: undefined }
    const candidate = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const send = (status, type, body) => {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
        res.end(body)
      }
      try {
        // 引导页：两个登录按钮（Google 账号 / z.ai 账号）
        if (url.pathname === '/' || url.pathname === '/guide') {
          send(200, 'text/html; charset=utf-8', intlGuideHtml(product, session.vendor))
          return
        }
        // 选择 vendor 并向上游要授权页（上游现发 oauth_url + state）
        if (url.pathname === '/open-auth' && req.method === 'POST') {
          const body = await new Promise((resolve) => {
            let text = ''
            req.on('data', (c) => { text += c })
            req.on('end', () => resolve(text))
          })
          const vendor = (() => { try { return JSON.parse(body || '{}').vendor } catch { return '' } })() === 'google' ? 'google' : 'zai'
          const deviceId = resolveDeviceId(product)
          const r = await fetch(`${product.apiBase}${OAUTH_URL_PATH}/${vendor}-oauth-url`, {
            method: 'POST',
            headers: authHeaders(product, { intl: true }),
            body: JSON.stringify({ source_id: SOURCE_ID, device_id: deviceId, navigate_uri: navigateUriOf(vendor) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          const json = await r.json().catch(() => ({}))
          if (!r.ok || json.code !== 0 || !json.data) {
            send(200, 'application/json; charset=utf-8', JSON.stringify({
              error: `获取授权页失败：${json.msg || `HTTP ${r.status}${json.code !== undefined ? ` (code ${json.code})` : ''}`}`,
            }))
            return
          }
          const authorizeUrl = String(json.data.oauth_url ?? json.data.url ?? json.data.login_url ?? json.data.auth_url ?? '')
          if (authorizeUrl === '') {
            send(200, 'application/json; charset=utf-8', JSON.stringify({ error: '上游未返回授权页地址' }))
            return
          }
          let handedOutState = ''
          try { handedOutState = new URL(authorizeUrl).searchParams.get('state') ?? '' } catch { /* 非法地址按缺 state 处理 */ }
          if (handedOutState === '') {
            send(200, 'application/json; charset=utf-8', JSON.stringify({ error: '上游授权页地址缺少 state 参数，已取消登录（回调校验必需）' }))
            return
          }
          session.vendor = vendor
          session.expectedState = handedOutState
          send(200, 'application/json; charset=utf-8', JSON.stringify({ url: authorizeUrl }))
          return
        }
        // 授权页 302 回来：code + state，state 逐字比对才收
        const cbVendor = session.vendor
        if (cbVendor !== undefined && url.pathname === callbackPathOf(cbVendor)) {
          const code = url.searchParams.get('code') ?? ''
          const state = url.searchParams.get('state') ?? ''
          const accepted = code !== '' && state !== '' && state === session.expectedState
          send(200, 'text/plain; charset=utf-8', accepted
            ? `已收到 ${cbVendor === 'google' ? 'Google' : 'Z.ai'} 授权，正在换取凭据…可以关闭此页面。`
            : '回调校验失败（state 不符或缺 code）——请回到引导页重新发起登录。')
          if (accepted) void settleWith(cbVendor, code, state)
          return
        }
        send(404, 'text/plain; charset=utf-8', 'not found')
      } catch (error) {
        try {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        } catch { /* 连接已断 */ }
      }
    })
    const listenOk = await new Promise((resolve) => {
      candidate.once('error', () => resolve(false))
      candidate.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (listenOk) { server = candidate; actualPort = port; break }
  }
  if (server === undefined) {
    // 四个官方端口全被占：回退载体页（一键导入）—— 引导页起不来总比死等强
    clearTimeout(timer)
    return beginSmsFlow(product, openBrowser)
  }
  const guideUrl = `http://localhost:${actualPort}/`
  if (openBrowser) openBrowser(guideUrl)
  return {
    url: guideUrl,
    result: result.finally(() => clearTimeout(timer)),
    instructions: '在打开的引导页选 Google 账号或 z.ai 账号，跳到授权页完成后自动继续；桌面端已登录也可关掉它改用一键导入。',
    close: closeServer,
  }
}

/** 国际版引导页：两按钮（Google / z.ai）—— 授权页由上游现发，不在本页拼。 */
function intlGuideHtml(product) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 ${product.displayName}</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#0f172a;color:#f8fafc;
     display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;width:100%;max-width:420px}
h2{margin:0 0 8px;font-size:20px;color:#38bdf8}
.desc{color:#94a3b8;font-size:13px;margin:0 0 24px}
button{width:100%;background:#0284c7;color:#fff;border:none;border-radius:6px;
       padding:11px 16px;font-size:15px;font-weight:500;cursor:pointer;margin-top:10px}
button:hover{background:#0369a1}
button:disabled{background:#475569;cursor:not-allowed}
.tip{color:#64748b;font-size:12px;margin:16px 0 0;line-height:1.5}
#msg{margin-top:16px;padding:10px 12px;border-radius:6px;font-size:13px;min-height:16px;display:none}
#msg.err{display:block;background:rgba(239,68,68,.15);border:1px solid #ef4444;color:#fca5a5}
#msg.busy{display:block;color:#93c5fd}
</style></head><body>
<div class="card">
<h2>${product.displayName} 登录</h2>
<p class="desc">选择登录方式 —— 授权页由 AutoClaw 官方接口现发（不会被跳转到中国站）。</p>
<button id="btnGoogle">使用 Google 账号登录</button>
<button id="btnZai">使用 z.ai 账号登录</button>
<div id="msg"></div>
<p class="tip">点按钮后会自动跳到官方授权页；完成登录后浏览器会回到
<code>localhost</code> 回调端口，本页显示「已收到授权」即可关闭。</p>
</div>
<script>
const msg = document.getElementById('msg');
const busy = (t) => { msg.className = 'busy'; msg.textContent = t; };
const fail = (t) => { msg.className = 'err'; msg.textContent = t; };
async function openAuth(vendor) {
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    busy('正在向官方接口获取授权页…');
    const r = await fetch('/open-auth', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor }) });
    const j = await r.json();
    if (j.error) { fail(j.error);
      document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return; }
    msg.textContent = '正在跳转授权页…';
    setTimeout(() => { location.href = j.url; }, 400);
  } catch (e) { fail('请求失败：' + e.message);
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
}
document.getElementById('btnGoogle').onclick = () => openAuth('google');
document.getElementById('btnZai').onclick = () => openAuth('zai');
</script></body></html>`
}

/** 国内/兜底：本地载体页（一键导入 + 短信）。 */
async function beginSmsFlow(product, openBrowser) {
  let server
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  const closeServer = () => new Promise((resolve) => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
  const timer = setTimeout(() => {
    settleFail(new Error('登录超时'))
    void closeServer()
  }, LOGIN_TIMEOUT_MS)
  timer.unref?.()

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy() })
    req.on('end', () => { try { resolve(data === '' ? {} : JSON.parse(data)) } catch { reject(new Error('请求体不是 JSON')) } })
    req.on('error', reject)
  })
  const sendJson = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    try {
      if (pathname === '/' || pathname === '/autoclaw/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage(product))
        return
      }
      if (pathname === '/autoclaw/import-local') {
        // ⚠️ 目录按 product.userDataDirName（写死国内目录 = 国际导入国内凭据，上游审计 P0）
        const credential = probeLocalCredential(product)
        if (credential === undefined) {
          return sendJson(res, 200, { ok: false, message: '未找到本机桌面端凭据 —— 请先在 AutoClaw 桌面端登录后重试' })
        }
        sendJson(res, 200, { ok: true, message: '导入成功' })
        clearTimeout(timer)
        settleOk(credential)
        setTimeout(() => void closeServer(), 500)
        return
      }
      if (pathname === '/autoclaw/sms/send') {
        const body = await readBody(req)
        const phone = String(body.phone ?? '').trim()
        if (!PHONE_RE.test(phone)) return sendJson(res, 200, { ok: false, message: '手机号格式不正确' })
        const out = await sendVerificationCode(product, phone, resolveDeviceId(product))
        return sendJson(res, 200, out)
      }
      if (pathname === '/autoclaw/sms/login') {
        const body = await readBody(req)
        const phone = String(body.phone ?? '').trim()
        const code = String(body.code ?? '').trim()
        if (!PHONE_RE.test(phone)) return sendJson(res, 200, { ok: false, message: '手机号格式不正确' })
        if (code === '') return sendJson(res, 200, { ok: false, message: '验证码不能为空' })
        const out = await loginWithCode(product, phone, code, resolveDeviceId(product))
        if (out.ok) {
          sendJson(res, 200, { ok: true, message: '登录成功' })
          clearTimeout(timer)
          settleOk(out.credential)
          setTimeout(() => void closeServer(), 500)
          return
        }
        return sendJson(res, 200, out)
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })

  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      typeof addr === 'object' && addr !== null ? resolve(addr.port) : reject(new Error('无法获取端口'))
    })
    server.on('error', reject)
  })
  const url = `http://127.0.0.1:${port}/autoclaw/login`
  if (openBrowser) openBrowser(url)
  return { url, result: result.finally(() => clearTimeout(timer)), close: closeServer }
}

// ── 渠道工厂 ─────────────────────────────────────────────────────────────

function makeAutoclawChannel(product) {
  return {
    id: product.id,
    displayName: product.displayName,

    fallbackModels: Object.fromEntries(FALLBACK_MODELS.map((m) => [m.id, {
      name: m.name,
      limit: { context: m.contextWindow, output: m.maxOutputTokens },
      tool_call: true,
      capabilities: { temperature: true, reasoning: true, attachment: true },
      options: { reasoning_efforts: DECLARED_EFFORTS, default_reasoning_effort: 'high' },
    }])),

    beginLogin: (openBrowser) => beginLogin(product, openBrowser),

    refresh: async (credential) => {
      if (typeof credential?.refresh_token !== 'string' || credential.refresh_token.trim() === '') {
        throw new Error('凭据无 refresh_token（导入的桌面端凭据需重新登录获取）')
      }
      return refreshToken(product, credential)
    },
    expired,
    catalog: (credential) => catalog(product, credential),
    chat: (credential, context) => chat(product, credential, context),
    checkin: (credential) => checkin(product, credential),
    usage: (credential) => usage(product, credential),
  }
}

export const autoclawChannel = makeAutoclawChannel(AUTOCLAW)
export const autoclawIntlChannel = makeAutoclawChannel(AUTOCLAW_INTL)
export { AUTOCLAW, AUTOCLAW_INTL }
