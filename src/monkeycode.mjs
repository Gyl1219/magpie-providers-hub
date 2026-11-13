// MonkeyCode 渠道 —— 移植自 DSH `monkeycode*.ts`（两站同构，账号不互通）。
//
// ## 协议总览（上游真机实测，含 2026-11-02/03 三轮审计修正）
//
// ```
// 推理网关（OhMyAgent）—— 只认 x-api-key + 签名，不认 cookie：
//   POST {gateway}/v1/messages      Anthropic Messages 协议（SSE）
//     x-api-key: oma_…（36 位）
//     X-OhMyAgent-Signature: v1=<hex HMAC-SHA256(signing_secret, prompt)>
//     ⚠️ 签名覆盖「prompt 文本」（system → instructions 全量 join → messages
//     首个 system → input 首个 developer/system），不是整个请求体；
//     ⚠️ max_tokens 必填（Anthropic 协议），缺它 400。
//     ⚠️ GET /v1/models 实测 405 —— 目录只有内置常量。
// 平台（cookie 认证，API Key 实测 401）—— 与推理完全解耦：
//   GET  /api/v1/users/wallet            余额（balance 千分之一积分 + 每日 token 双读数）
//   GET  /api/v1/users/subscription      订阅档位（basic/pro/ultra，辅助读数）
//   GET  /api/v1/users/status            稳定用户身份（data.user.id —— 不是 key 记录 id）
//   GET  /api/v1/users/wallet/checkin    签到状态（{checked_in:boolean}）
//   POST /api/v1/public/captcha/challenge  Cap PoW 题面（实测 c=50,s=32,d=3 ≈ 0.2s）
//   POST /api/v1/public/captcha/redeem     提交解答 → captcha_token
//   POST /api/v1/users/wallet/checkin      {captcha_token} 完成签到
//   POST /api/v1/users/api-keys            会话 cookie 换 {api_key, signing_secret}（body {}）
// ```
//
// ## 登录两路（#614：registry 无 MonkeyCode 包，无重叠）
//
// ① 浏览器登录：拉起本机 Chromium（独立一次性 profile、可见窗口，与 MagiCrew
//    登录同一套已审基建），用户在官方页登录 → CDP 读 HttpOnly 会话 cookie
//    （`document.cookie` 读不到，必须走 `Network.getCookies`）→ 换网关凭据
//    → 读稳定用户身份。② 手动粘贴：API Key + 签名密钥（+ 可选 cookie）。
//    只有 Key 也能推理，只是查不到余额、签不了到（优雅降级，上游同款）。
//
// ## 额度形状（余额/重置型，滚动指针不适用 —— AGENTS.md 第 1 条）
//
// 积分（按量扣）与每日额度（订阅档位 implicit 次日 0 点重置）不可互相折算，
// 分两个窗口：每日额度用 amount/limit + resetsAt（北京午夜）+ span 86400；
// 积分用 amount/limit 形态（balance 字段会让 magpie 关进度条）。

import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import {
  buildAnthropicPayload,
  anthropicSseToOpenAi,
  anthropicJsonToOpenAi,
  monkeycodeGatewaySignature,
  monkeycodeSigningPrompt,
} from './monkeycode-bridge.mjs'
import { findBrowser, newProfileDir, sweepProfiles, launchLoginBrowser, closeSession } from './magicrew-browser.mjs'

export const CHANNEL_ID = 'monkeycode'
export const DISPLAY_NAME = 'MonkeyCode'

// ── 站点配置（monkeycode-product.ts 逐字移植）────────────────────────────

const ANTHROPIC_VERSION = '2023-06-01'
/** 会话 cookie 名（HttpOnly —— document.cookie 读不到，必须 CDP）。 */
const SESSION_COOKIE_NAME = 'monkeycode_ai_session'

const SITES = {
  cn: {
    id: 'monkeycode',
    displayName: 'MonkeyCode',
    gatewayBaseUrl: 'https://proxy.monkeycode-ai.com/v1',
    gatewayMessagesPath: '/messages',
    platformBaseUrl: 'https://monkeycode-ai.com',
    // ⚠️ 真实路径（经 char-code 还原；上游源文件里被占位掩码，猜值会 404）
    apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
    anthropicVersion: ANTHROPIC_VERSION,
    /** 平台请求超时（product.catalogTimeoutMs）。 */
    timeoutMs: 10_000,
  },
  intl: {
    id: 'monkeycode-intl',
    displayName: 'MonkeyCode (国际版)',
    gatewayBaseUrl: 'https://proxy.monkeycode-ai.net/v1',
    gatewayMessagesPath: '/messages',
    platformBaseUrl: 'https://monkeycode-ai.net',
    // ⚠️ 真实路径（经 char-code 还原；上游源文件里被占位掩码，猜值会 404）
    apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
    anthropicVersion: ANTHROPIC_VERSION,
    // ⚠️ 国际站契约同构但上游未真机验证（他们只有国内账号）——若 404/字段不同，
    //   改这一个常量即可，不动逻辑。
    timeoutMs: 10_000,
  },
}

/** 内置目录 —— 网关 /v1/models 实测 405，这份表就是全量事实（上游快照）。 */
const GATEWAY_MODELS = {
  'monkeycode-basic/deepseek-flash': { name: 'DeepSeek Flash（basic 额度）', limit: { context: 1_048_576, output: 8_192 } },
  'monkeycode-basic/deepseek-v4-flash': { name: 'DeepSeek V4 Flash（basic 额度）', limit: { context: 1_048_576, output: 8_192 } },
  'monkeycode-pro/deepseek-flash': { name: 'DeepSeek Flash（pro 额度）', limit: { context: 1_048_576, output: 8_192 } },
  'monkeycode-pro/deepseek-v4-pro': { name: 'DeepSeek V4 Pro（pro 额度）', limit: { context: 1_048_576, output: 8_192 } },
  'monkeycode-ultra/deepseek-v4-pro': { name: 'DeepSeek V4 Pro（ultra 额度）', limit: { context: 1_048_576, output: 8_192 } },
  // 不带前缀的 = 直接扣积分（与订阅档位无关）
  'deepseek-flash': { name: 'DeepSeek Flash（按积分计费）', limit: { context: 1_048_576, output: 8_192 } },
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash（按积分计费）', limit: { context: 1_048_576, output: 8_192 } },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro（按积分计费）', limit: { context: 1_048_576, output: 8_192 } },
  // ⚠️ glm-5 刻意不声明 contextWindow：不是 deepseek，窗口与 1M 毫无关系，
  //   照抄就是谎报（且会把宿主的溢出压缩推迟到不可能达到的 token 数）。
  'glm-5': { name: 'GLM-5（按积分计费）', limit: { context: 128_000, output: 8_192 } },
}

/** 目录返回裸模型名（magpie 拼 hub-monkeycode/<名>）—— 这里给一份键序稳定的快照。 */
function catalogOf() {
  return JSON.parse(JSON.stringify(GATEWAY_MODELS))
}

// ── 失败分类（monkeycode.ts 移植）───────────────────────────────────────

/**
 * 按 HTTP 状态 + 响应正文分类。判定顺序：先状态码（402/429/401/403 明确）
 * → 再文案（兜住「状态码被网关改写成 5xx、正文仍是额度文案」）→ 最后 5xx。
 * ⚠️ 5xx 排在文案之后：文案匹配用来兜住「500 + 额度文案」的改写形态。
 */
function classifyFailure(errorText, status) {
  if (status === 402) return 'quota'
  if (status === 429) return 'rate'
  if (status === 401 || status === 403) return 'auth'
  const text = String(errorText ?? '').toLowerCase()
  if (text.includes('积分已耗尽') || text.includes('额度已耗尽')) return 'quota'
  if (text.includes('insufficient') || text.includes('quota')) return 'quota'
  if (text.includes('rate limit') || text.includes('too many requests')) return 'rate'
  if (status >= 500) return 'server'
  return 'other'
}

/** 失败 → 对 magpie 的 HTTP 状态（402/429 让 magpie 的 retryable() 换账号）。 */
function statusForFailure(kind, original) {
  if (kind === 'quota') return 402
  if (kind === 'rate') return 429
  if (kind === 'auth') return 401
  return original >= 400 ? original : 502
}

// ── 网关请求头（签名覆盖 prompt 文本；body 必须已序列化）────────────────

function gatewayHeaders(credential, site, { accept, body } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: accept ?? 'text/event-stream',
    'anthropic-version': site.anthropicVersion,
    'x-api-key': credential.access_token,
  }
  const secret = credential.signing_secret
  if (typeof secret !== 'string' || secret.length === 0) return headers
  let parsed
  try {
    parsed = JSON.parse(body ?? '')
  } catch {
    parsed = undefined
  }
  headers['X-OhMyAgent-Signature'] = monkeycodeGatewaySignature(secret, monkeycodeSigningPrompt(parsed))
  return headers
}

// ── 平台（cookie）层 ────────────────────────────────────────────────────

/** 归一化会话 cookie：接受 `name=value` 整串或裸 value。 */
function normalizeSessionCookie(raw) {
  const s = String(raw ?? '').trim()
  if (s.length === 0) return undefined
  if (s.startsWith(`${SESSION_COOKIE_NAME}=`)) return s
  // 用户可能贴了一整串 Cookie 头 —— 挑出目标 cookie
  for (const part of s.split(';')) {
    const kv = part.trim()
    if (kv.startsWith(`${SESSION_COOKIE_NAME}=`)) return kv
  }
  return `${SESSION_COOKIE_NAME}=${s}`
}

function cookieOf(credential) {
  const raw = credential?.session_cookie
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return normalizeSessionCookie(raw)
}

function platformHeaders(cookie, site) {
  return {
    cookie,
    accept: 'application/json',
    referer: `${site.platformBaseUrl}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
}

/** HTTP 失败 → 能行动的中文原因（401/403 = cookie 过期，唯一需要单独成句的）。 */
function describeFailure(status, text) {
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  const suffix = excerpt.length === 0 ? '' : `：${excerpt}`
  if (status === 401 || status === 403) {
    return `网页登录态未生效（HTTP ${status}）—— 平台接口只认已登录的会话，请重新浏览器登录`
  }
  return `平台接口返回 HTTP ${status}${suffix}`
}

/** 发平台请求并解 JSON（「200 + HTML」是 SPA catch-all 的假 200，必须拦）。 */
async function platformRequest(cookie, url, init, site) {
  const headers = platformHeaders(cookie, site)
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(site.timeoutMs),
    })
  } catch (error) {
    return { ok: false, status: 0, error: `平台接口请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) return { ok: false, status: response.status, error: describeFailure(response.status, text) }
  if (text.trim().length === 0) return { ok: true, data: undefined }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return {
      ok: false,
      status: response.status,
      error: `平台接口返回了非 JSON 响应（HTTP 200，可能是会话失效被重定向到登录页）：${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
    }
  }
}

/** 解 `{ code, data }` 信封（code 0 = OK）。 */
function unwrapEnvelope(data) {
  if (typeof data !== 'object' || data === null) return { ok: false, error: '平台报文不是对象（上游形态可能已变）' }
  if (data.code === 0 || data.code === '0' || data.code === undefined) {
    return { ok: true, value: (typeof data.data === 'object' && data.data !== null ? data.data : data) }
  }
  const message = typeof data.message === 'string' && data.message.length > 0 ? data.message : `业务错误 ${String(data.code)}`
  return { ok: false, error: message }
}

const readNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * 会话 cookie 换网关凭据（浏览器登录的最后一跳）。
 * ⚠️ 返回里的 `id` 是「这把 Key 的记录 id」（每次兑换都变），**不是**平台用户 id，
 *   不得写进凭据 —— 稳定身份走 /api/v1/users/status。
 * ⚠️ 不抛错：兑换失败可退回「只有 cookie」的状态（额度签到可用、推理不可用——
 *   但这种账号在面板上像已配置而一用就错，所以登录流程里兑换失败会明确报错）。
 */
async function exchangeSessionForKey(cookie, site) {
  const result = await platformRequest(cookie, `${site.platformBaseUrl}${site.apiKeysPath}`, { method: 'POST', body: {} }, site)
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const record = unwrapped.value ?? {}
  const apiKey = typeof record.api_key === 'string' ? record.api_key : ''
  const signingSecret = typeof record.signing_secret === 'string' ? record.signing_secret : ''
  if (apiKey.length === 0 || signingSecret.length === 0) {
    return { ok: false, error: '兑换响应缺少 api_key / signing_secret（上游形态可能已变）' }
  }
  return { ok: true, apiKey, signingSecret }
}

/** 平台用户资料（稳定 user_id + 昵称）。失败返回 undefined（优雅降级）。 */
async function fetchProfile(cookie, site) {
  const result = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/users/status`, { method: 'GET' }, site)
  if (!result.ok) return undefined
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return undefined
  const user = unwrapped.value?.user
  if (typeof user !== 'object' || user === null) return undefined
  const userId = typeof user.id === 'string' && user.id.length > 0 ? user.id : undefined
  const nickname = typeof user.nickname === 'string' && user.nickname.length > 0 ? user.nickname : undefined
  return { ...(userId !== undefined ? { userId } : {}), ...(nickname !== undefined ? { nickname } : {}) }
}

// ── Cap PoW 求解器（cap-pow.ts 逐字移植；MonkeyCode / 百智云共用协议）────

/** 每题尝试上限（防死循环）。 */
const MAX_POW_ATTEMPTS_PER_QUESTION = 20_000_000
/**
 * 一次签到的**总**尝试预算：现网 c=50,s=32,d=3 ≈ 0.2s；留 500 万次（≈7s），
 * 比真实形态宽 20 倍以上，又不可能把事件循环冻住数小时（上游审计 P1）。
 */
const MAX_POW_ATTEMPTS_TOTAL = 5_000_000

/**
 * FNV-1a 32 位（与平台前端逐字符同构）：输入是 **UTF-16 code unit**（不是
 * UTF-8 字节）；乘法 Math.imul 等价于前端的五次移位相加；只有返回才 >>> 0。
 * 改任一处 → 全部签到失败。
 */
function fnv1a32(data) {
  let hash = 2166136261
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/** 由 seed 派生 length 位十六进制串（平台 xorshift32 变体；13 左/17 右/5 左）。 */
export function capPrng(seed, length) {
  let state = fnv1a32(seed)
  let out = ''
  while (out.length < length) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0
    state = (state ^ (state >>> 17)) >>> 0
    state = (state ^ ((state << 5) >>> 0)) >>> 0
    out += state.toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/** 解一道题：最小 n 使 sha256(salt+n) 的 **hex 前缀**（不是字节）等于 target。 */
function solveOne(salt, target, budget) {
  for (let n = 0; n < MAX_POW_ATTEMPTS_PER_QUESTION; n += 1) {
    budget.remaining -= 1
    if (budget.remaining < 0) {
      throw new Error(`签到验证题累计求解超过 ${MAX_POW_ATTEMPTS_TOTAL} 次（target=${target}）—— 上游可能提高了难度，请稍后重试`)
    }
    const digest = createHash('sha256').update(salt + String(n)).digest('hex')
    if (digest.startsWith(target)) return n
  }
  throw new Error(`签到验证题求解超过 ${MAX_POW_ATTEMPTS_PER_QUESTION} 次仍未命中（target=${target}）—— 上游可能提高了难度`)
}

/**
 * 解整个挑战：每题让出一次事件循环（上游调高难度时不独占宿主）。
 * ⚠️ 题号 **从 1 开始**（`i+1`），写 0 会让 redeem 必然失败且文案只说「验证失败」。
 */
export async function capSolveChallengeYielding(token, challenge, budget = { remaining: MAX_POW_ATTEMPTS_TOTAL }) {
  const solutions = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = capPrng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = capPrng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
    await new Promise((resolve) => { setImmediate(resolve) })
  }
  return solutions
}

/** 读挑战报文（已解包后的业务对象）：`{token, challenge:{c,s,d}}` + 防御性上限。 */
export function readCapChallenge(data) {
  if (data === null || typeof data !== 'object') return { error: '签到验证题报文不是对象（上游形态可能已变）' }
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  if (token.length === 0) return { error: '签到验证题报文里没有 token（上游形态可能已变）' }
  const challenge = data.challenge
  if (challenge === null || typeof challenge !== 'object') return { error: '签到验证题报文里没有 challenge（上游形态可能已变）' }
  const count = readNumber(challenge.c)
  const saltLength = readNumber(challenge.s)
  const targetLength = readNumber(challenge.d)
  if (count === undefined || saltLength === undefined || targetLength === undefined) {
    return { error: '签到验证题的 c/s/d 字段缺失或不是数字（上游形态可能已变）' }
  }
  if (count < 1 || count > 500 || saltLength < 1 || saltLength > 256 || targetLength < 1 || targetLength > 16) {
    return { error: `签到验证题参数超出合理范围（c=${count}, s=${saltLength}, d=${targetLength}）` }
  }
  return { token, challenge: { count: Math.floor(count), saltLength: Math.floor(saltLength), targetLength: Math.floor(targetLength) } }
}

/** 从 redeem 响应取验证 token（`<8hex>:<15hex>`；success:false → undefined）。 */
export function readCapToken(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.success === false) return undefined
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  return token.length === 0 ? undefined : token
}

// ── 余额（两池：每日 token 额度 + 积分）─────────────────────────────────

async function fetchWallet(credential, site) {
  const cookie = cookieOf(credential)
  if (cookie === undefined) {
    return { ok: false, error: '未配置会话（session_cookie）—— 余额 / 额度 / 签到接口只认网页登录态；只有 API Key 的账号能发消息但查不到余额' }
  }
  const result = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/users/wallet`, { method: 'GET' }, site)
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const raw = unwrapped.value ?? {}
  // ⚠️ 平台下发的 balance 是**千分之一积分**（网页前端 /1000 显示）；
  //   先 round 再除，避免浮点尾巴。
  const milli = readNumber(raw.balance)
  if (milli === undefined) return { ok: false, error: '钱包报文里没有 balance 字段（上游形态可能已变）' }
  return {
    ok: true,
    wallet: {
      balance: Math.round(milli) / 1000,
      ...(readNumber(raw.daily_token_balance) !== undefined ? { dailyTokenBalance: readNumber(raw.daily_token_balance) } : {}),
      ...(readNumber(raw.daily_token_limit) !== undefined ? { dailyTokenLimit: readNumber(raw.daily_token_limit) } : {}),
    },
  }
}

async function fetchPlan(credential, site) {
  const cookie = cookieOf(credential)
  if (cookie === undefined) return undefined
  const result = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/users/subscription`, { method: 'GET' }, site)
  if (!result.ok) return undefined
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return undefined
  const plan = typeof unwrapped.value?.plan === 'string' ? unwrapped.value.plan.trim().toLowerCase() : ''
  return plan === 'basic' || plan === 'pro' || plan === 'ultra' ? plan : undefined
}

const PLAN_LABELS = { basic: 'Basic', pro: 'Pro', ultra: 'Ultra' }
const PLAN_DAILY_LIMIT = { basic: 10_000_000, pro: 100_000_000, ultra: 300_000_000 }

/** 下一北京午夜（每日额度 implicit 重置点；上游不下发时刻，这是唯一不编造的推法）。 */
function nextUtc8DayStartMs(nowMs) {
  const nowBeijing = new Date(nowMs + 8 * 3600_000)
  return Date.UTC(nowBeijing.getUTCFullYear(), nowBeijing.getUTCMonth(), nowBeijing.getUTCDate() + 1) - 8 * 3600_000
}

/**
 * usage —— 两池分开（积分与 token 额度不可互相折算，加总没有语义）。
 * 无 cookie 时优雅降级：推理可用，只是查不到余额（一条说明窗，不是错误）。
 */
async function usageFor(site, credential) {
  const wallet = await fetchWallet(credential, site)
  if (!wallet.ok) {
    const noSession = /未配置会话/.test(wallet.error)
    return [{
      name: DISPLAY_NAME,
      used: 0,
      display: noSession ? '推理可用（未配置网页会话，余额/签到不可用）' : `余额查询失败：${wallet.error}`,
    }]
  }
  const plan = await fetchPlan(credential, site)
  const windows = []
  const { balance, dailyTokenBalance, dailyTokenLimit } = wallet.wallet
  // 每日额度：amount/limit 形态（used 按真实消耗算 —— used 是路由排序的输入）；
  // resetsAt = 下一北京午夜（implicit 次日 0 点重置），span 86400 让 magpie 识别为周期窗
  if (dailyTokenLimit !== undefined && dailyTokenBalance !== undefined) {
    const used = Math.max(0, dailyTokenLimit - dailyTokenBalance)
    windows.push({
      name: '每日额度',
      used: Math.max(0, Math.min(100, Math.round((used / dailyTokenLimit) * 100))),
      amount: used,
      limit: dailyTokenLimit,
      unit: 'token',
      span: 86_400,
      resetsAt: new Date(nextUtc8DayStartMs(Date.now())).toISOString(),
      display: `剩余 ${dailyTokenBalance}${plan !== undefined ? ` · ${PLAN_LABELS[plan]}档` : ''}`,
    })
  }
  // 积分：amount/limit 形态（balance 字段会关进度条）；上游只给当前余额，不给总额
  windows.push({
    name: '积分余额',
    used: 0,
    amount: 0,
    limit: balance,
    unit: '积分',
    display: `剩余 ${balance}`,
  })
  return windows
}

// ── 签到（Cap PoW 全流程）───────────────────────────────────────────────

/** 从签到响应里 best-effort 取「本次到账积分」（只认明确的奖励字段名）。 */
function readRewardedCredit(data) {
  if (data === null || typeof data !== 'object') return undefined
  for (const key of ['credit', 'credits', 'reward', 'reward_credit', 'amount', 'points']) {
    const value = readNumber(data[key])
    if (value !== undefined && value > 0) return value
  }
  return undefined
}

async function checkinFor(site, credential) {
  const cookie = cookieOf(credential)
  if (cookie === undefined) {
    return {
      outcome: 'failed',
      message: '未配置会话（session_cookie）—— 签到接口只认网页登录态，请用浏览器登录添加账号',
    }
  }
  try {
    // ① 预检：已签 → claimed（今日奖励确实已入账 —— AGENTS.md 第 2 条语义）
    const status = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/users/wallet/checkin`, { method: 'GET' }, site)
    if (status.ok) {
      const unwrapped = unwrapEnvelope(status.data)
      if (unwrapped.ok && unwrapped.value?.checked_in === true) {
        return { outcome: 'claimed', credit: 0, message: '今天已经签到过了' }
      }
    }
    // ② 签到前余额（读不到只影响「增量」口径）
    const walletBefore = await fetchWallet(credential, site)
    // ③ 取题
    const challengeResult = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/public/captcha/challenge`, { method: 'POST', body: {} }, site)
    if (!challengeResult.ok) return { outcome: 'failed', message: `获取签到验证题失败：${challengeResult.error}` }
    const challengeEnvelope = unwrapEnvelope(challengeResult.data)
    if (!challengeEnvelope.ok) return { outcome: 'failed', message: `获取签到验证题失败：${challengeEnvelope.error}` }
    const challenge = readCapChallenge(challengeEnvelope.value)
    if ('error' in challenge) return { outcome: 'failed', message: challenge.error }
    // ④ 本地求解（yielding：上游调高难度时不冻住事件循环）
    const solutions = await capSolveChallengeYielding(challenge.token, challenge.challenge)
    // ⑤ 兑换
    const redeemResult = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/public/captcha/redeem`, { method: 'POST', body: { token: challenge.token, solutions } }, site)
    if (!redeemResult.ok) return { outcome: 'failed', message: `提交签到验证答案失败：${redeemResult.error}` }
    const redeemEnvelope = unwrapEnvelope(redeemResult.data)
    if (!redeemEnvelope.ok) return { outcome: 'failed', message: `提交签到验证答案失败：${redeemEnvelope.error}` }
    const captchaToken = readCapToken(redeemEnvelope.value)
    if (captchaToken === undefined) {
      return { outcome: 'failed', message: '签到验证没有通过（redeem 响应里没有 token）—— 可能验证题已过期，请重试一次' }
    }
    // ⑥ 签到
    const checkinResult = await platformRequest(cookie, `${site.platformBaseUrl}/api/v1/users/wallet/checkin`, { method: 'POST', body: { captcha_token: captchaToken } }, site)
    if (!checkinResult.ok) return { outcome: 'failed', message: `签到失败：${checkinResult.error}` }
    // ⑦ 奖励金额：响应字段 → 前后余额差（实测 +100）→ 0 + 说明（绝不编造）
    const checkinEnvelope = unwrapEnvelope(checkinResult.data)
    const responseCredit = checkinEnvelope.ok ? readRewardedCredit(checkinEnvelope.value) : undefined
    let measuredCredit
    if (responseCredit === undefined && walletBefore.ok) {
      const walletAfter = await fetchWallet(credential, site)
      if (walletAfter.ok) {
        const delta = walletAfter.wallet.balance - walletBefore.wallet.balance
        const normalized = Math.round(delta * 1000) / 1000
        if (normalized > 0) measuredCredit = normalized
      }
    }
    const credited = responseCredit ?? measuredCredit
    if (credited !== undefined) return { outcome: 'claimed', credit: credited }
    return { outcome: 'claimed', credit: 0, message: '签到成功（上游不返回积分数量，请查看刷新后的余额）' }
  } catch (error) {
    // PoW 硬上限抛错是可预期的上游形态变化，不是崩溃
    return { outcome: 'failed', message: `签到失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

// ── chat（OpenAI → Anthropic Messages → OpenAI）─────────────────────────

function errorResponse(message, status) {
  return Response.json({ error: { type: 'provider_error', message } }, { status })
}

/** 非流式：聚合 SSE chunks 成一条 OpenAI chat.completion。 */
async function aggregateChunks(chunks, model) {
  let text = ''
  const toolCalls = []
  let finish = 'stop'
  let usage
  let id
  for await (const frame of chunks) {
    // ⚠️ 桥产出的是「data: {...}」SSE 字符串帧 —— 先解包再处理
    if (typeof frame !== 'string') continue
    const data = frame.replace(/^data: /, '').trim()
    if (data === '' || data === '[DONE]') continue
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    if (typeof parsed.id === 'string' && id === undefined) id = parsed.id
    if (parsed.usage !== undefined) usage = parsed.usage
    const choice = parsed.choices?.[0]
    if (!choice) continue
    if (typeof choice.delta?.content === 'string') text += choice.delta.content
    for (const call of Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : []) {
      const index = Number.isFinite(call.index) ? call.index : toolCalls.length
      const slot = toolCalls[index] ?? (toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } })
      if (typeof call.id === 'string' && call.id !== '') slot.id = call.id
      if (typeof call.function?.name === 'string' && call.function.name !== '') slot.function.name = call.function.name
      if (typeof call.function?.arguments === 'string') slot.function.arguments += call.function.arguments
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finish = choice.finish_reason
  }
  const cleaned = toolCalls.filter((c) => c.function.name !== '')
  return {
    id: id ?? `chatcmpl-monkeycode-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        ...(text !== '' ? { content: text } : cleaned.length > 0 ? { content: null } : { content: '' }),
        ...(cleaned.length > 0 ? { tool_calls: cleaned } : {}),
      },
      finish_reason: finish,
    }],
    ...(usage !== undefined ? { usage } : {}),
  }
}

async function chatFor(site, credential, { body: openaiBody, signal }) {
  const inner = String(openaiBody?.model ?? '')
  if (inner === '') return errorResponse('monkeycode: 请求缺少 model', 400)
  if (typeof credential.signing_secret !== 'string' || credential.signing_secret.length === 0) {
    return errorResponse('monkeycode: 凭据缺少 signing_secret —— 网关每个请求都要签名，请重新登录或补齐粘贴内容', 401)
  }

  let payload
  try {
    payload = buildAnthropicPayload({ ...openaiBody, model: inner })
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error), 400)
  }
  const serialized = JSON.stringify(payload)
  const response = await fetch(`${site.gatewayBaseUrl}${site.gatewayMessagesPath}`, {
    method: 'POST',
    headers: gatewayHeaders(credential, site, { accept: 'text/event-stream', body: serialized }),
    body: serialized,
    ...(signal !== undefined ? { signal } : {}),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const kind = classifyFailure(text, response.status)
    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 200) || `HTTP ${response.status}`
    return errorResponse(`MonkeyCode 返回（HTTP ${response.status}）：${detail}`, statusForFailure(kind, response.status))
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    // 非 SSE 的 200：可能是 JSON 错误信封，也可能是完整的 Anthropic message。
    const text = await response.text().catch(() => '')
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed?.content)) {
        // 完整 message（网关关掉了流）→ OpenAI 形状
        return Response.json(anthropicJsonToOpenAi(parsed, { model: inner }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      const message = typeof parsed?.error?.message === 'string' ? parsed.error.message
        : (typeof parsed?.message === 'string' ? parsed.message : text.slice(0, 200))
      const kind = classifyFailure(text, response.status)
      return errorResponse(`MonkeyCode 返回：${message}`, statusForFailure(kind, response.status))
    } catch {
      return errorResponse(`MonkeyCode 返回了非 JSON/SSE 响应（HTTP ${response.status}）：${text.slice(0, 200)}`, 502)
    }
  }

  const chunks = anthropicSseToOpenAi(response.body, { model: inner, signal })
  if (openaiBody?.stream === false) {
    // 非流式：聚合 chunks 成一条 chat.completion
    try {
      return Response.json(await aggregateChunks(chunks, inner), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 502)
    }
  }
  // 流式：把 OpenAI chunk 帧包成 SSE Response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const frame of chunks) {
          controller.enqueue(encoder.encode(frame))
        }
      } catch (error) {
        // 流内错误转一条 OpenAI 错误 JSON 帧（消费方按 data: JSON 解析）
        const message = error instanceof Error ? error.message : String(error)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`))
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

// ── 登录：本地页双路（浏览器 CDP / 手动粘贴）────────────────────────────

/** 通过 CDP 读 HttpOnly 会话 cookie（document.cookie 读不到 —— 必须 Network.getCookies）。 */
async function readSessionCookieViaCdp(port, site) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(4000) })).json()
  const page = (pages ?? []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url || '').includes(new URL(site.platformBaseUrl).host))
  if (!page) return undefined
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP 连接超时')), 8000)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP 连接失败')) })
  })
  try {
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 读取超时')), 8000)
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id !== 1) return
        clearTimeout(t)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      })
      ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [site.platformBaseUrl] } }))
    })
    const cookies = reply?.cookies ?? []
    const hit = cookies.find((c) => c.name === SESSION_COOKIE_NAME)
    return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
}

/** 本地页 HTML：浏览器登录状态区 + 手动粘贴表单。 */
function renderLoginPage(site) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 ${site.displayName}</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#eee;
     max-width:440px;margin:40px auto;padding:24px;border-radius:12px;background:#1a1a1a}
h2{margin-top:0}h3{margin:18px 0 8px;font-size:14px;color:#ccc}
label{display:block;margin:14px 0 6px;font-size:13px;color:#aaa}
input{width:100%;padding:10px;box-sizing:border-box;border:1px solid #333;border-radius:6px;
      background:#0d0d0d;color:#eee}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:6px;background:#3b82f6;
       color:#fff;font-size:15px;cursor:pointer}
button:disabled{background:#444;cursor:not-allowed}
#status{margin-top:10px;font-size:13px;min-height:20px;color:#9ca3af}
#msg{margin-top:10px;font-size:13px;min-height:20px;color:#9ca3af}
details{margin-top:8px;font-size:12px;color:#666}
</style></head><body>
<h2>登录 ${site.displayName}</h2>
<p style="font-size:13px;color:#9ca3af">推荐浏览器登录（自动换取网关 Key）；或手动粘贴凭据。</p>

<h3>方式一：浏览器登录</h3>
<div id="status">正在拉起浏览器窗口（独立临时 profile）……<br>请在弹出的浏览器里完成官方页面登录，本页会自动继续。</div>

<h3>方式二：手动粘贴</h3>
<label>API Key（oma_…）</label><input id="key">
<label>签名密钥（signing_secret，48 位）</label><input id="secret">
<label>会话 cookie（可选，HttpOnly —— 从浏览器 DevTools 的 Cookies 里复制）</label><input id="cookie" placeholder="${SESSION_COOKIE_NAME}=…">
<button id="go">保存并登录</button>
<div id="msg"></div>
<details><summary>没有 Key？</summary>在官方网页登录后，平台会自动签发（本插件浏览器登录即走此路）；手动路径适合已有 Key 的高级用户。</details>
<script>
const msg = (t) => { document.getElementById('msg').textContent = t };
document.getElementById('go').onclick = async () => {
  const key = document.getElementById('key').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const cookie = document.getElementById('cookie').value.trim();
  if (!key || !secret) return msg('API Key 与签名密钥必填');
  msg('保存中…');
  try {
    const r = await fetch('/paste', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ key, secret, cookie }) });
    const j = await r.json();
    msg(j.ok ? '登录成功，可以关闭此页面' : (j.message || '失败'));
  } catch (e) { msg('失败：' + e.message) }
};
(async () => {
  const el = document.getElementById('status');
  while (true) {
    try {
      const r = await fetch('/login/status');
      const j = await r.json();
      if (j.phase === 'waiting-cookie') el.textContent = '浏览器已打开 —— 请在官方页面完成登录（等待会话…）';
      else if (j.phase === 'exchanging') el.textContent = '已读到会话，正在换取网关 Key…';
      else if (j.phase === 'done') { el.textContent = '登录成功，可以关闭此页面'; return }
      else if (j.phase === 'error') { el.textContent = '浏览器登录失败：' + (j.message || ''); return }
    } catch (e) {
      // 服务端已关闭（settle/超时）—— 页面如实提示，不再显示残留的「等待会话」
      document.getElementById('status').textContent = '登录会话已结束：请回到 magpie 重新发起登录';
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
})();
</script></body></html>`
}

/**
 * beginLogin：本地页（浏览器登录进度 + 粘贴兜底）。
 *
 * 浏览器路：beginLogin 即拉起 Chromium（独立一次性 profile、可见窗口、detached），
 * 服务端循环用 CDP 读 HttpOnly 会话 cookie → 换网关 Key → 读稳定身份 → settle。
 * ⚠️ 匿名会话 cookie 在窗口打开时就存在 —— 「读到 cookie」≠「已登录」，
 *   兑换 401 时必须继续等（isMonkeycodeSessionExpiredError 语义）。
 */
async function beginLoginFor(site, openBrowser) {
  // ⚠️ 15 分钟：浏览器登录要用户在官方页完成操作，6 分钟实测不够（真机 2026-11-04
  //   用户登录到一半窗口到点 → settle(false) 关服务，页面残留「等待会话」）
  const LOGIN_WINDOW_MS = 15 * 60 * 1000
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {})
  let server
  let closed = false
  let timer
  const closeServer = () => new Promise((resolve) => {
    if (closed || !server) return resolve()
    closed = true
    server.close(() => resolve())
  })
  const settle = (ok, value) => {
    if (timer !== undefined) clearTimeout(timer)
    void closeServer()
    void closeBrowser()
    ok ? settleOk(value) : settleFail(value)
  }

  // 浏览器登录状态机
  let phase = 'starting' // starting → waiting-cookie → exchanging → done | error
  let phaseMessage = ''
  let browserSession
  let browserLoopStopped = false

  const closeBrowser = async () => {
    browserLoopStopped = true
    const s = browserSession
    browserSession = undefined
    if (s !== undefined) await closeSession(s).catch(() => {})
  }

  timer = setTimeout(() => settle(false, new Error(`${site.displayName} 登录超时（15 分钟内未完成）`)), LOGIN_WINDOW_MS)
  timer.unref?.()

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      if (pathname === '/' || pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage(site))
        return
      }
      if (pathname === '/login/status') {
        return sendJson(200, { phase, ...(phaseMessage !== '' ? { message: phaseMessage } : {}) })
      }
      if (pathname === '/paste') {
        const body = await new Response(req).json().catch(() => ({}))
        const key = String(body.key ?? '').trim()
        const secret = String(body.secret ?? '').trim()
        const cookie = normalizeSessionCookie(String(body.cookie ?? ''))
        if (key.length === 0 || secret.length === 0) {
          return sendJson(200, { ok: false, message: 'API Key 与签名密钥必填' })
        }
        settle(true, {
          access_token: key,
          signing_secret: secret,
          ...(cookie !== undefined ? { session_cookie: cookie } : {}),
        })
        return sendJson(200, { ok: true })
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
      sendJson(200, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })

  const port = await new Promise((resolve, reject) => {
    let settled = false
    server.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      settled = true
      server.unref()
      server.on('error', () => {})
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    settle(false, new Error(`${site.displayName} 登录端口无法监听（${error.message}）`))
    throw error
  })

  // 浏览器登录路（服务端循环；失败不阻塞粘贴路 —— phase 停在 error 即可）
  void (async () => {
    try {
      phase = 'starting'
      browserSession = await launchLoginBrowser(site.platformBaseUrl)
      phase = 'waiting-cookie'
      const deadline = Date.now() + LOGIN_WINDOW_MS
      let lastExchangeError = ''
      while (Date.now() < deadline && !browserLoopStopped) {
        const cookieValue = await readSessionCookieViaCdp(browserSession.port, site).catch(() => undefined)
        if (cookieValue !== undefined) {
          const cookie = `${SESSION_COOKIE_NAME}=${cookieValue}`
          phase = 'exchanging'
          // ⚠️ 「读到 cookie」≠「已登录」（匿名会话也存在）—— 兑换 401 继续等
          const exchanged = await exchangeSessionForKey(cookie, site)
          if (exchanged.ok) {
            const profile = await fetchProfile(cookie, site).catch(() => undefined)
            settle(true, {
              access_token: exchanged.apiKey,
              signing_secret: exchanged.signingSecret,
              session_cookie: cookie,
              ...(profile?.userId !== undefined ? { user_id: profile.userId } : {}),
              ...(profile?.nickname !== undefined ? { nickname: profile.nickname } : {}),
            })
            phase = 'done'
            return
          }
          lastExchangeError = exchanged.error
          if (!/HTTP 40[13]|网页登录态未生效/.test(exchanged.error)) {
            // 非登录态错误（网络/上游改版）—— 重试也没有意义，交回粘贴路
            phase = 'error'
            phaseMessage = lastExchangeError
            return
          }
          phase = 'waiting-cookie'
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      if (!browserLoopStopped && phase !== 'done') {
        phase = 'error'
        phaseMessage = lastExchangeError !== '' ? lastExchangeError : '等待登录超时'
      }
    } catch (error) {
      if (!browserLoopStopped) {
        phase = 'error'
        phaseMessage = error instanceof Error ? error.message : String(error)
      }
    }
  })()

  const url = `http://127.0.0.1:${port}/login`
  if (openBrowser) openBrowser(url)
  return {
    url,
    result,
    instructions: `已为你打开登录页与官方浏览器窗口：在官方页面完成登录即可自动换取凭据；也可以在登录页手动粘贴 API Key 与签名密钥。`,
  }
}

// ── 渠道对象（两站）─────────────────────────────────────────────────────

function makeChannel(site) {
  return {
    id: site.id,
    displayName: site.displayName,
    // ⚠️ 上游模型名**自带斜杠**（`monkeycode-basic/deepseek-flash`）。
    // 不声明这个，aggregate 的 resolve() 会把 `monkeycode-basic` 当成渠道前缀、
    // 只把 `deepseek-flash` 发给网关 → 网关 403 Forbidden（真机实测）。
    modelHasSlash: true,
    fallbackModels: catalogOf(),
    beginLogin: (openBrowser) => beginLoginFor(site, openBrowser),
    loginMethods: [{ label: '浏览器登录（官方页登录自动换 Key）或手动粘贴' }],
    // ⚠️ 无 refresh 端点（诚实标记）：网关 Key 是长期静态材料
    async refresh() {
      throw new Error('MonkeyCode 无自动续期：网关凭据是长期静态材料，失效后请重新登录')
    },
    expired: (credential) => {
      // ⚠️ 无 expires_at 恒 false：网关 Key 几乎不过期，「未知」≠「已过期」
      //   （反过来写会让刚登好的 key 立刻被判死 —— qiniu 同型事故）
      const raw = Number(credential?.expires_at)
      return Number.isFinite(raw) && raw > 0 && raw <= Date.now()
    },
    catalog: async () => catalogOf(),
    chat: (credential, init) => chatFor(site, credential, init),
    checkin: (credential) => checkinFor(site, credential),
    usage: (credential) => usageFor(site, credential),
  }
}

export const monkeycodeChannel = makeChannel(SITES.cn)
export const monkeycodeIntlChannel = makeChannel(SITES.intl)
