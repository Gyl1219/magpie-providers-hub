// 百智云（BaiZhiCloud）渠道 —— 移植自 DSH `baizhi.ts` / `baizhi-product.ts` /
// `baizhi-adapter.ts` / `baizhi-credits.ts` / `cap-pow.ts`（2026-11-04 上游 master）。
//
// ## 协议总览（上游实测注释逐条核对）
//
// ```
// 模型网关  https://ai-models.app.baizhi.cloud/api/anthropic
//   POST /v1/messages   认证：x-api-key: sk-… + anthropic-version: 2023-06-01
//                       返回标准 Anthropic SSE / JSON
//   GET  /v1/models     ⇒ {data:[{id,type:'model',display_name,created_at}]}（实测 45 id，
//                          **无能力字段** ⇒ 窗口/图片能力从已知表补，未知不写）
// 主站控制台  https://baizhi.cloud（只认网页 cookie，x-api-key 一律 401）
//   GET  /api/v1/user/wallet/balance        ⇒ *_credit_cents（单位 = 1/100 积分）
//   GET  /api/v1/user/wallet/app-credit-usage?period=week|month|year
//   GET  /api/v1/user/api-keys              ⇒ items[].key = 明文 sk-…
//   POST /api/v1/public/captcha/challenge   ⇒ {token, challenge:{c,s,d}}（Cap PoW）
//   POST /api/v1/public/captcha/redeem      ⇒ {token:'<8hex>:<15hex>'}
//   POST /api/v1/user/wallet/daily-temporary-credit {captcha_token}
//                                           ⇒ {claimed, amount_credit_cents, expires_at}
// ```
//
// ## 两套凭据（关键，上游 2026-11-02 报障后定案）
//
// | 用途 | 凭据 | 认证头 |
// |---|---|---|
// | 发消息（模型网关） | sk-… 长期静态 Key | x-api-key |
// | 积分/用量/Key 列表（控制台） | 网页登录态 cookie | cookie |
//
// 凭据里带 `session_cookie`（`sl-session=…; baizhi_session=…`，domain 精确
// `baizhi.cloud`，两枚都要）才能读积分/签到；只有 sk- 的账号「能发消息但看不到
// 积分」—— 不是 bug，是两套凭据的分工。
//
// ## 协议事实（上游实测，勿改）
//
// - 账号级上下文硬上限 1,048,576（400 原文 "This model's maximum context length
//   is 1048576 tokens"——是服务级上限，不冒充 per-model 窗口）；
// - `max_tokens=100000` 实测可成功；思考 `{type:'enabled',budget_tokens}` 生效，
//   顶层 `effort` 无实际作用 ⇒ 不暴露 effort 档位；支持图片（Anthropic image 块）；
// - 凭据是长期静态 Key：无 refresh 端点、无 expires_at（与 qiniu/modelscope 同型），
//   401 = Key 错/被吊销，重取同一份字符串没有意义；
// - 控制台每日临时积分要走 **Cap PoW**（挑战 → 本地求解 → 兑换），算法与平台
//   前端逐字节同构（FNV-1a 32 + xorshift32 派生 + SHA-256 前缀碰撞），见
//   `solveCapChallenge` 段。纯计算、无规避：题目就是让你算的，网页版也在算。

import { createHash } from 'node:crypto'
import {
  buildAnthropicPayload,
  anthropicSseToOpenAi,
  anthropicJsonToOpenAi,
  rememberModelMeta,
} from './anthropic-bridge.mjs'

export const CHANNEL_ID = 'baizhi'
export const DISPLAY_NAME = '百智云'

const API_BASE = 'https://ai-models.app.baizhi.cloud/api/anthropic'
const MESSAGES_PATH = '/v1/messages'
const MODELS_PATH = '/v1/models'
const PLATFORM_BASE = 'https://baizhi.cloud'
const WALLET_BALANCE_PATH = '/api/v1/user/wallet/balance'
const WALLET_USAGE_PATH = '/api/v1/user/wallet/app-credit-usage'
const CAPTCHA_CHALLENGE_PATH = '/api/v1/public/captcha/challenge'
const CAPTCHA_REDEEM_PATH = '/api/v1/public/captcha/redeem'
const DAILY_CREDIT_PATH = '/api/v1/user/wallet/daily-temporary-credit'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 60_000
const CATALOG_TIMEOUT_MS = 10_000

/** 服务级上下文硬上限（实测 400 原文；不是 per-model 窗口）。 */
export const BAIZHI_MAX_CONTEXT = 1_048_576
/** 单次输出上限（max_tokens=100000 实测可成功）。 */
export const BAIZHI_MAX_OUTPUT_TOKENS = 100_000

// ── 已知能力表（上游 BAIZHI_KNOWN_CAPABILITIES；只记实测过的事实）──────────
//
// 省略 contextWindow = 不知道（不要编）；省略 supportsImage = 未知 ≠ 不支持。
const BAIZHI_KNOWN_CAPABILITIES = [
  // deepseek 系列（4 条，窗口与 monkeycode-product 一致）
  { id: 'deepseek-v4-pro', contextWindow: BAIZHI_MAX_CONTEXT },
  { id: 'deepseek-v4-flash', contextWindow: BAIZHI_MAX_CONTEXT },
  { id: 'deepseek-v4-flash-vision-exp', contextWindow: BAIZHI_MAX_CONTEXT, supportsImage: true },
  { id: 'deepseek-flash', contextWindow: BAIZHI_MAX_CONTEXT },
  // 其余已知 id：窗口未知、图片未逐一实测 ⇒ 只列 id
  { id: 'minimax-m2.7', supportsImage: true },
  { id: 'minimax-m2.5' },
  { id: 'glm-5.1', supportsImage: true },
  { id: 'glm-5' },
  { id: 'glm-4.7' },
  { id: 'kimi-k2.6', supportsImage: true },
  { id: 'kimi-k2.5' },
  { id: 'qwen3.6-plus' },
  { id: 'qwen3.5-plus', supportsImage: true },
  { id: 'qwen3.5-flash' },
  { id: 'qwen-flash' },
]

const capabilityOf = (modelId) => {
  const id = String(modelId ?? '').trim()
  return BAIZHI_KNOWN_CAPABILITIES.find((c) => c.id === id)
}

/** 兜底目录（远端拉不到时）：name 一律用 id，远端 display_name 拿不到就不编。 */
const FALLBACK_MODELS = Object.fromEntries(
  BAIZHI_KNOWN_CAPABILITIES.map((c) => [c.id, {
    name: c.id,
    limit: { context: c.contextWindow ?? BAIZHI_MAX_CONTEXT, output: BAIZHI_MAX_OUTPUT_TOKENS },
    tool_call: true,
    capabilities: {
      temperature: true,
      reasoning: true,
      ...(c.supportsImage === true ? { attachment: true } : {}),
    },
    options: {},
    headers: {},
    status: 'active',
    release_date: '',
  }]),
)

// ── 网关信封（Anthropic error 形态）────────────────────────────────────

/** Anthropic 错误体：`{"type":"error","error":{type,message}}`。 */
function parseAnthropicError(payload) {
  if (typeof payload === 'object' && payload !== null && payload.type === 'error'
    && typeof payload.error === 'object' && payload.error !== null) {
    return {
      kind: String(payload.error.type ?? ''),
      message: String(payload.error.message ?? ''),
    }
  }
  return undefined
}

// ── 目录 ────────────────────────────────────────────────────────────────

/** 远端 45 id 无能力字段 ⇒ 已知表补窗口/图片，未知不写（照抄上游 parseBaizhiModelList）。 */
async function fetchCatalog(credential) {
  let remote
  try {
    const r = await fetch(`${API_BASE}${MODELS_PATH}`, {
      headers: {
        Accept: 'application/json',
        'x-api-key': credential.access_token,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
    if (r.ok) remote = await r.json().catch(() => undefined)
  } catch {
    remote = undefined
  }
  const rows = Array.isArray(remote?.data) ? remote.data : []
  if (rows.length === 0) {
    // 远端失败（含 10s 超时）⇒ 内置兜底表（至少 12 条实测 id）
    return { ...FALLBACK_MODELS }
  }
  const models = {}
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id.length === 0) continue
    const known = capabilityOf(id)
    const declared = typeof row.display_name === 'string' && row.display_name.length > 0
      ? row.display_name
      : id
    models[id] = {
      // 远端 display_name 有就用（真实命名），能力仍按已知表（远端没有能力字段）
      name: declared,
      limit: {
        // ⚠️ 服务级硬上限不冒充 per-model 窗口：已知表实测过才写，未知给服务级
        //    上限并接受上游 400 兜底（上游原文就是服务级口径）
        context: known?.contextWindow ?? BAIZHI_MAX_CONTEXT,
        output: BAIZHI_MAX_OUTPUT_TOKENS,
      },
      tool_call: true,
      capabilities: {
        temperature: true,
        reasoning: true,
        // supportsImage 未知 ≠ 不支持：已知表明确 true 才开 attachment
        ...(known?.supportsImage === true ? { attachment: true } : {}),
      },
      options: {},
      headers: {},
      status: 'active',
      release_date: typeof row.created_at === 'string' ? row.created_at.slice(0, 10) : '',
    }
  }
  // 远端清单里没有的已知模型也补上（远端有时漏列，已知表是实测过的）
  for (const c of BAIZHI_KNOWN_CAPABILITIES) {
    if (models[c.id] === undefined) models[c.id] = { ...FALLBACK_MODELS[c.id] }
  }
  return models
}

// ── chat（OpenAI 进 → Anthropic Messages 出 → OpenAI 响应回）────────────

/**
 * 网关响应分类（上游 classifyBaizhiError 同口径）：
 *   401/403 auth（静态 Key 重取无意义）· 429 rate_limit · 402 quota ·
 *   400/422 invalid_request · 5xx/transport server。已是人类可读的描述进 message。
 */
function classifyStatus(status, upstreamKind, upstreamMessage) {
  if (status === 401 || status === 403) return '登录凭据被拒绝（Key 错误或已吊销）——静态 Key 无续期，请重新粘贴或换号'
  if (status === 402) return '积分不足（quota）——充值或等每日临时积分'
  if (status === 429) return '限流（rate limit）——稍后自动重试'
  if (upstreamKind === 'invalid_request_error' || status === 400 || status === 422) {
    return upstreamMessage !== '' ? upstreamMessage : '请求被上游拒绝（invalid_request）'
  }
  return upstreamMessage !== '' ? upstreamMessage : `网关返回 HTTP ${status}`
}

function errorResponse(status, upstreamKind, upstreamMessage) {
  return Response.json(
    { error: { type: 'provider_error', message: `百智云：${classifyStatus(status, upstreamKind, upstreamMessage)}` } },
    { status },
  )
}

/** SSE 流包装（minimaxintl 同款）：桥的 OpenAI 块 → `data:` 帧 Response。 */
function sseResponse(generator) {
  const encoder = new TextEncoder()
  const iterator = generator[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {})
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function chat(credential, { body, signal }) {
  const payload = buildAnthropicPayload(body)
  const response = await fetch(`${API_BASE}${MESSAGES_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: payload.stream === true ? 'text/event-stream' : 'application/json',
      'x-api-key': credential.access_token,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
    ...(signal !== undefined ? { signal } : {}),
  })

  // 401/403 = Key 错/吊销（静态 Key，无 renew 可做——诚实报错让用户换号/重贴）
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const parsed = (() => { try { return JSON.parse(text) } catch { return undefined } })()
    const err = parseAnthropicError(parsed)
    return errorResponse(
      response.status >= 400 ? response.status : 502,
      err?.kind ?? '',
      err?.message ?? text.slice(0, 300),
    )
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('application/json')) {
    // 非流式：Anthropic JSON message → OpenAI chat.completion
    const json = await response.json().catch(() => undefined)
    if (typeof json !== 'object' || json === null) {
      return Response.json(
        { error: { type: 'provider_error', message: '百智云：返回了无法解析的响应' } },
        { status: 502 },
      )
    }
    const err = parseAnthropicError(json)
    if (err !== undefined) {
      const status = err.kind === 'rate_limit_error' ? 429
        : err.kind === 'authentication_error' || err.kind === 'permission_error' ? 401
          : err.kind === 'billing_error' ? 402
            : 502
      return errorResponse(status, err.kind, err.message)
    }
    const out = anthropicJsonToOpenAi(json, { model: body?.model })
    return Response.json(out, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
  }

  // 标准 Anthropic SSE → OpenAI SSE 帧
  return sseResponse(anthropicSseToOpenAi(response.body, { model: body?.model, signal }))
}

// ── 控制台层（cookie 凭据；两枚 cookie 拼串，domain 精确 baizhi.cloud）────

/** 控制台请求头（cookie 只认网页登录态；x-api-key 打控制台一律 401）。 */
function platformHeaders(cookie) {
  return {
    Accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    cookie,
  }
}

async function platformRequest(path, cookie, init = {}) {
  const response = await fetch(`${PLATFORM_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...platformHeaders(cookie),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  })
  let parsed
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, error: `控制台响应不是 JSON（${path}，HTTP ${response.status}）`, status: response.status }
  }
  // 控制台信封：{code:0,message:'success',data}
  if (typeof parsed !== 'object' || parsed === null || parsed.code !== 0) {
    const message = typeof parsed?.message === 'string' && parsed.message.length > 0
      ? parsed.message
      : `业务错误 ${String(parsed?.code ?? '(缺少 code)')}`
    return { ok: false, error: message, status: response.status }
  }
  return { ok: true, data: parsed.data, status: response.status }
}

const hasConsoleSession = (credential) =>
  typeof credential?.session_cookie === 'string' && credential.session_cookie.length > 0

const readNumber = (record, key) => {
  const n = Number(record?.[key])
  return Number.isFinite(n) ? n : undefined
}

/**
 * 钱包（单位换算：*_credit_cents / 100 = 面板上的积分）。
 * 上游实测 9821 → 98.21、23505 → 235.05 逐位吻合。
 */
async function fetchWallet(credential) {
  const result = await platformRequest(WALLET_BALANCE_PATH, credential.session_cookie)
  if (!result.ok) return { ok: false, error: result.error }
  const data = result.data
  const availableCents = readNumber(data, 'available_credit_cents')
  if (availableCents === undefined) {
    return { ok: false, error: '上游未下发积分余额（响应里没有 available_credit_cents）' }
  }
  const toCredit = (cents) => (cents === undefined ? 0 : cents / 100)
  return {
    ok: true,
    wallet: {
      available: toCredit(availableCents),
      temporary: toCredit(readNumber(data, 'temporary_credit_cents')),
      permanent: toCredit(readNumber(data, 'permanent_credit_cents')),
      frozen: toCredit(readNumber(data, 'frozen_credit_cents')),
      dailyClaimed: data.daily_temporary_credit_claimed === true,
    },
  }
}

/**
 * usage：两池分开（与控制台钱包页三行数字同口径）。
 * - 「每日积分」= temporary（零点过期 ⇒ resetsAt = 下一北京午夜，span 86400s）；
 * - 「充值积分」= permanent（长期有效 ⇒ amount/limit 形态，无作废时间）。
 * ⚠️ used 按真实消耗算（路由排序输入，硬编码 0 = 满额误排）。
 * 没有 session_cookie 的账号：诚实单行（不是失败）。
 */
async function usage(credential) {
  if (!hasConsoleSession(credential)) {
    return [{
      name: DISPLAY_NAME,
      used: 0,
      display: '已可对话；积分面板需控制台登录态（浏览器登录后自动补齐）',
    }]
  }
  const wallet = await fetchWallet(credential)
  if (!wallet.ok) {
    const expiredHint = /401|unauthor|登录|session/i.test(wallet.error)
    return [{
      name: DISPLAY_NAME,
      used: 0,
      display: expiredHint ? '控制台登录态已失效，请重新浏览器登录' : `积分查询失败：${wallet.error}`,
    }]
  }
  const { temporary, permanent, available } = wallet.wallet
  const windows = []
  // 每日积分（temporary）：零点过期 ⇒ 重置点 = 下一北京午夜
  const nowBeijing = new Date(Date.now() + 8 * 3600_000)
  const nextMidnight = Date.UTC(nowBeijing.getUTCFullYear(), nowBeijing.getUTCMonth(), nowBeijing.getUTCDate() + 1) - 8 * 3600_000
  windows.push({
    name: '每日积分',
    used: 0,
    span: 86_400,
    resetsAt: new Date(nextMidnight).toISOString(),
    display: `剩余 ${temporary}`,
  })
  // 充值积分（permanent）：长期有效 ⇒ amount/limit 形态（balance 会让 magpie 关进度条）
  windows.push({
    name: '充值积分',
    used: 0,
    amount: 0,
    limit: Math.round(permanent * 100) / 100,
    unit: '积分',
    display: `剩余 ${permanent}`,
  })
  // available 与 temporary+permanent-frozen 有差时才提示（frozen 一般为 0）
  const derived = temporary + permanent
  if (Math.abs(available - derived) > 0.005) {
    windows[1].display = `剩余 ${permanent}（冻结 ${wallet.wallet.frozen}，另见每日积分）`
  }
  return windows
}

// ── Cap PoW（逐字节移植 cap-pow.ts；改任一处 = 全部签到失败）─────────────

/** 每题尝试上限 / 总预算（上游 2026-11-03 审计定案：防上游调难度冻死宿主）。 */
const MAX_POW_ATTEMPTS_PER_QUESTION = 20_000_000
const MAX_POW_ATTEMPTS_TOTAL = 5_000_000

/**
 * FNV-1a 32 位（@cap.js/core 逐字符同构）：输入是 **UTF-16 code unit**，
 * 乘法 Math.imul 等价于前端的五次移位相加，只有返回时 >>> 0。
 * ⚠️ 不要顺手改成 UTF-8 字节——非 ASCII seed（含中文的 token）会漂。
 */
function fnv1a32(data) {
  let hash = 2166136261
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/** 平台 xorshift32 变体：由 seed 派生 length 位十六进制（13 左 / 17 右 / 5 左）。 */
function prng(seed, length) {
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

/**
 * 解一题：找最小 n 使 sha256(salt + n) 的十六进制**前缀**等于 target。
 * ⚠️ 比较口径是 hex 前缀（不是字节比较）——字节版会被 redeem 判 invalid。
 */
function solveOne(salt, target, budget) {
  for (let n = 0; ; n += 1) {
    budget.remaining -= 1
    if (budget.remaining < 0) {
      throw new Error('签到验证求解超出总预算（上游可能调高了难度）——已中止以免冻住宿主')
    }
    const digest = createHash('sha256').update(`${salt}${n}`, 'utf8').digest('hex')
    if (digest.startsWith(target)) return n
  }
}

/** 读挑战报文（{token, challenge:{c,s,d}}，已解包）；防御性上限防 c=10^9 卡死。 */
function readCapChallenge(data) {
  if (data === null || typeof data !== 'object') return { error: '签到验证题报文不是对象（上游形态可能已变）' }
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  if (token.length === 0) return { error: '签到验证题报文里没有 token（上游形态可能已变）' }
  const challenge = data.challenge
  if (challenge === null || typeof challenge !== 'object') return { error: '签到验证题报文里没有 challenge（上游形态可能已变）' }
  const count = readNumber(challenge, 'c')
  const saltLength = readNumber(challenge, 's')
  const targetLength = readNumber(challenge, 'd')
  if (count === undefined || saltLength === undefined || targetLength === undefined) {
    return { error: '签到验证题的 c/s/d 字段缺失或不是数字（上游形态可能已变）' }
  }
  if (count < 1 || count > 500 || saltLength < 1 || saltLength > 256 || targetLength < 1 || targetLength > 16) {
    return { error: `签到验证题参数超出合理范围（c=${count}, s=${saltLength}, d=${targetLength}）` }
  }
  return { token, challenge: { count: Math.floor(count), saltLength: Math.floor(saltLength), targetLength: Math.floor(targetLength) } }
}

/**
 * 解整卷挑战（每题让出一次事件循环，PoW 不独占宿主）。
 * 题号是 **1-based**（`${token}${ordinal}`，1-based 的 i+1 漂移 = 必然签到失败）。
 */
async function solveCapChallenge(token, challenge, budget = { remaining: MAX_POW_ATTEMPTS_TOTAL }) {
  const solutions = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
    await new Promise((resolve) => { setImmediate(resolve) })
  }
  return solutions
}

/**
 * 签到（领每日临时积分）：challenge → 本地 PoW → redeem → claim。
 * `claimed:false` 不能靠猜（2026-11-03 审计 P1）：可能是「今天已领过」也可能是
 * 「上游没发放」——唯一可靠判据是**再读一次钱包**的 daily_temporary_credit_claimed。
 */
async function checkin(credential) {
  if (!hasConsoleSession(credential)) {
    // 有账号但没控制台登录态：领不了（不是 failed，别把卡片涂红）
    return { outcome: 'inactive', message: '每日积分需控制台登录态（浏览器登录后可领）' }
  }
  const challengeResult = await platformRequest(CAPTCHA_CHALLENGE_PATH, credential.session_cookie, { method: 'POST', body: '{}' })
  if (!challengeResult.ok) {
    return { outcome: 'failed', message: `获取签到验证题失败：${challengeResult.error}` }
  }
  const challenge = readCapChallenge(challengeResult.data)
  if ('error' in challenge) return { outcome: 'failed', message: challenge.error }

  let solutions
  try {
    solutions = await solveCapChallenge(challenge.token, challenge.challenge)
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }

  const redeemResult = await platformRequest(CAPTCHA_REDEEM_PATH, credential.session_cookie, {
    method: 'POST', body: JSON.stringify({ token: challenge.token, solutions }),
  })
  if (!redeemResult.ok) {
    return { outcome: 'failed', message: `提交签到验证答案失败：${redeemResult.error}` }
  }
  const captchaToken = typeof redeemResult.data?.token === 'string' && redeemResult.data.token.length > 0
    ? redeemResult.data.token
    : undefined
  if (captchaToken === undefined) {
    return { outcome: 'failed', message: '签到验证没有通过（redeem 响应里没有 token）——可能是验证题已过期，请重试一次' }
  }

  const claimResult = await platformRequest(DAILY_CREDIT_PATH, credential.session_cookie, {
    method: 'POST', body: JSON.stringify({ captcha_token: captchaToken }),
  })
  if (!claimResult.ok) {
    return { outcome: 'failed', message: `领取每日积分失败：${claimResult.error}` }
  }
  const record = typeof claimResult.data === 'object' && claimResult.data !== null ? claimResult.data : {}
  const amountCents = readNumber(record, 'amount_credit_cents')
  const amount = amountCents === undefined ? undefined : amountCents / 100
  if (record.claimed === false) {
    // 再读一次钱包定语义：claimed=true ⇒ already-claimed；false ⇒ 真失败
    const after = await fetchWallet(credential)
    if (after.ok && after.wallet.dailyClaimed === true) {
      return {
        outcome: 'claimed',
        credit: amount ?? 0,
        message: '今日每日积分已领取（上游报 claimed:false，钱包确认已入账）',
      }
    }
    return { outcome: 'failed', message: '上游未发放每日积分（claimed:false 且钱包未确认入账）' }
  }
  return { outcome: 'claimed', credit: amount ?? 0, message: `每日临时积分 +${amount ?? '?'}` }
}

// ── 渠道对象 ────────────────────────────────────────────────────────────

export const baizhiChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  fallbackModels: FALLBACK_MODELS,
  // 粘贴 sk- Key（可附控制台 cookie：`sk-…|cookie串`——高级用法，见 README）
  async apiAuth(raw) {
    const text = String(raw ?? '').trim()
    const pipe = text.indexOf('|')
    const key = (pipe >= 0 ? text.slice(0, pipe) : text).trim()
    const cookie = pipe >= 0 ? text.slice(pipe + 1).trim() : ''
    if (!/^sk-[A-Za-z0-9]{16,}$/.test(key)) {
      throw new Error('百智云凭据应以 sk- 开头（大模型商店生成的 API Key）；可选在末尾用「|」接控制台 cookie 以显示积分')
    }
    return {
      access_token: key,
      ...(cookie !== '' ? { session_cookie: cookie } : {}),
    }
  },
  loginMethods: [{ label: '粘贴 API Key（sk-…；控制台 cookie 可选）' }],
  // 静态 Key：无 refresh 端点（诚实标记，与上游同口径）
  async refresh() {
    throw new Error('百智云无自动续期：API Key 长期有效，401 时请重新粘贴')
  },
  expired: () => false, // 无 expires_at：「未知」≠「已过期」，拿去试（401 能识别）
  catalog: fetchCatalog,
  chat,
  checkin,
  usage,
}
