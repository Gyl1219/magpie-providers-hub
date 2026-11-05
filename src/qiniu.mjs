// 七牛云 MaaS（Modelink）渠道 —— 供应商 id `hub-qiniu`，显示名「七牛云」。
//
// ⚠️ 归属：本文件是 **移植**，不是原创。
//   上游实现：lakegan/opencode-qiniu-auth（MIT），即 magpie-community/plugins 的 PR #374
//   「Add Qiniu MaaS (Conatus Free) provider plugin」。该 PR 于 2026-11-01 由作者本人
//   以「Superseded by magpie-providers-hub (hub-qiniu)」关闭，并明确授权：
//     「授权照 MIT 即可，不需要别的；署名引用到 lakegan/opencode-qiniu-auth、保留 LICENSE 原文」
//   移植范围：模型目录/命名/排序（lib/models.mjs）、目录快照（lib/catalog.mjs）、
//   AK/SK 签名（lib/sign.mjs）、今日用量（lib/usage.mjs）的全部逻辑。
//   本仓库新增：magpie「一渠道一供应商」形态的 apiAuth 粘贴登录、chat 代理、窗口组装。
//   LICENSE 原文见 LICENSES/opencode-qiniu-auth-MIT.txt。
//
// 登录：七牛云控制台创建的 API Key（`sk-` 开头，Bearer 认证）——只调模型。
//       查「今日已用」另需 AccessKey/SecretKey（控制台 → 密钥管理），两者是两套凭证，
//       绝不复用（AK/SK 权限极高，只用于读用量接口）。
// 协议：OpenAI 兼容 `{base}/chat/completions`；目录 `{base}/models`（可匿名读）。
//       默认接入点 https://api.qnaigc.com/v1。
//
// ⚠️⚠️ 模型 id 里带斜杠（`deepseek/deepseek-v4-pro`），但聚合层的 resolve() 只取
//   **最后一段**（`hub-qiniu/deepseek-v4-pro` → `deepseek-v4-pro`）。所以：
//   目录的 key = 去厂商前缀的短名，chat 收到短名后再由本文件的映射表还原成完整 id。
//   映射由整份 id 列表算出（planKeys），与列表顺序无关。

import { createHmac } from 'node:crypto'

// ── 常量 ──────────────────────────────────────────────────────────────

const BASE = 'https://api.qnaigc.com/v1'
/** 控制台里创建 API Key 的页面（宿主自己决定怎么渲染，插件不碰宿主配置）。 */
const KEYS_URL = 'https://portal.qiniu.com/ai-inference/api-key'
/** AccessKey / SecretKey 所在的「密钥管理」页。 */
const KEYS_AKSK_PAGE = 'https://portal.qiniu.com/developer/user/key'
const MODELS_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 10 * 60 * 1000
/** 活动额度只覆盖免费模型，算百分比时按这个词过滤。 */
const FREE_MODEL_FILTER = '-free'

/**
 * 1024 程序员节活动档位 → 每日 token 额度。
 *
 * 档位只能由用户自己声明：七牛的用量接口只返回已消耗量，
 * 没有任何套餐 / 实名状态字段，插件无从判断账号在哪一档。
 *
 * 档位判定（活动规则）：
 *   verified       实名认证                  → 1 亿 / 天
 *   verified-plus  实名 + 累计充值满 100 元    → 10 亿 / 天
 *
 * ⚠️「每天」是**每日重置**，不是活动期一次性总额。
 */
const ACTIVITY_TIERS = {
  verified: 1e8,
  'verified-plus': 1e9,
}

const TIER_HINTS = {
  verified: '实名认证 → 1 亿 / 天',
  'verified-plus': '实名 + 充值满 100 元 → 10 亿 / 天',
}

/**
 * 活动截止日。过了这一天，档位不再代表任何真实额度 ——
 * 继续按 1 亿 / 10 亿算百分比就是编造额度（那正是 PR #374 评审里被打回的 bug 同类）。
 * 这里刻意只写「截止」，因为本渠道**没有**带作废时间的额度包：
 * 额度窗口是「每日重置」语义（靠 resetsAt 表达），滚动指针分档工具（AGENTS.md 第 1 条）
 * 不适用 —— 与 accio 同属重置型渠道。
 */
const ACTIVITY_ENDS_AT = '2026-11-30'

/** 目录快照抓取时间（上游 lib/catalog.mjs 生成物，原样移植）。 */
const CATALOG_FETCHED_AT = '2026-10-26T04:09:08.916Z'

/**
 * 模型目录快照：`[id, 上下文长度, 最大输出]`。
 * 来源 GET https://api.qnaigc.com/v1/models（该接口可匿名读），原样移植。
 * 有它才能在未登录 / 断网时也列出模型。
 */
const CATALOG = [
  ['qiniu/conatus-free', 1000000, 128000],
  ['moonshotai/kimi-k3-free', 1048576, 1048576],
  ['nvidia/nemotron-3-ultra-550b-a55b0-free', 1000000, 128000],
  ['z-ai/glm-4.5-air-free', 0, 0],
  ['deepseek/deepseek-v4-pro', 1000000, 384000],
  ['deepseek/deepseek-v4-flash', 1000000, 384000],
  ['moonshotai/kimi-k3', 1048576, 1048576],
  ['minimax/minimax-m3', 1000000, 128000],
  ['qwen/qwen3.7-max', 1000000, 64000],
  ['qwen/qwen3.8-max', 1000000, 128000],
  ['z-ai/glm-5.3-flash', 1000000, 128000],
  ['MiniMax-M1', 1000000, 80000],
  ['bytedance/doubao-seed-2-1-lite', 1024000, 256000],
  ['bytedance/doubao-seed-2-1-pro', 256000, 256000],
  ['bytedance/doubao-seed-2-1-turbo', 256000, 256000],
  ['deepseek-r1', 128000, 32000],
  ['deepseek-r1-0528', 128000, 32000],
  ['deepseek-v3', 128000, 16000],
  ['deepseek-v3.1', 128000, 32000],
  ['deepseek/deepseek-v3.1-terminus', 128000, 32000],
  ['deepseek/deepseek-v3.1-terminus-thinking', 128000, 32000],
  ['deepseek/deepseek-v3.2-251201', 128000, 32000],
  ['deepseek/deepseek-v3.2-exp', 128000, 32000],
  ['deepseek/deepseek-v3.2-exp-thinking', 128000, 32000],
  ['deepseek/deepseek-v4-flash-202605', 1000000, 384000],
  ['deepseek/deepseek-v4-flash-20260731', 1000000, 0],
  ['deepseek/deepseek-v4-flash-vision-exp', 1000000, 384000],
  ['deepseek/deepseek-v4-pro-0813', 1000000, 384000],
  ['deepseek/deepseek-v4-pro-202606', 1000000, 384000],
  ['deepseek/deepseek-v4.1-flash', 1000000, 384000],
  ['deepseek/deepseek-v4.1-flash-1017', 1000000, 384000],
  ['doubao-1.5-pro-32k', 128000, 12000],
  ['doubao-1.5-thinking-pro', 128000, 16000],
  ['doubao-1.5-vision-pro', 128000, 16000],
  ['doubao-seed-1.6', 256000, 32000],
  ['doubao-seed-1.6-flash', 256000, 32000],
  ['doubao-seed-1.6-thinking', 256000, 32000],
  ['doubao-seed-2.0-code', 256000, 128000],
  ['doubao-seed-2.0-lite', 256000, 32000],
  ['doubao-seed-2.0-mini', 256000, 32000],
  ['doubao-seed-2.0-pro', 256000, 128000],
  ['glm-4.5', 131072, 98304],
  ['kimi-k2', 128000, 128000],
  ['meituan/longcat-flash-lite', 256000, 320000],
  ['minimax/minimax-m2', 200000, 128000],
  ['minimax/minimax-m2.1', 204800, 128000],
  ['minimax/minimax-m2.5', 204800, 128000],
  ['minimax/minimax-m2.5-highspeed', 204800, 128000],
  ['minimax/minimax-m2.7', 204800, 128000],
  ['minimax/minimax-m3.1-flash', 1000000, 512000],
  ['moonshotai/kimi-k2-thinking', 256000, 100000],
  ['moonshotai/kimi-k2.5', 256000, 256000],
  ['moonshotai/kimi-k2.6', 262000, 262000],
  ['moonshotai/kimi-k2.7-code', 262144, 262144],
  ['moonshotai/kimi-k3.1-pro', 1048576, 1048576],
  ['moonshotai/kimi-k3.1-pro-highspeed', 1048576, 1048576],
  ['qwen-max-2025-01-25', 128000, 4096],
  ['qwen-turbo', 1000000, 0],
  ['qwen-vl-max-2025-01-25', 128000, 0],
  ['qwen/qwen3.5-plus', 1000000, 64000],
  ['qwen/qwen3.6-27b', 262100, 262100],
  ['qwen/qwen3.6-plus', 1000000, 64000],
  ['qwen/qwen3.7-flash', 1000000, 128000],
  ['qwen/qwen3.7-plus', 1000000, 64000],
  ['qwen/qwen3.8-flash-next', 1000000, 128000],
  ['qwen2.5-vl-72b-instruct', 128000, 8192],
  ['qwen3-235b-a22b', 128000, 32000],
  ['qwen3-235b-a22b-instruct-2507', 262144, 64000],
  ['qwen3-235b-a22b-thinking-2507', 262144, 4096],
  ['qwen3-30b-a3b', 40000, 0],
  ['qwen3-30b-a3b-instruct-2507', 128000, 32000],
  ['qwen3-30b-a3b-thinking-2507', 126000, 32000],
  ['qwen3-32b', 40000, 0],
  ['qwen3-coder-480b-a35b-instruct', 262000, 4096],
  ['qwen3-max', 262144, 65536],
  ['qwen3-max-preview', 256000, 64000],
  ['qwen3-next-80b-a3b-instruct', 131072, 32768],
  ['qwen3-next-80b-a3b-thinking', 131072, 32768],
  ['qwen3-vl-30b-a3b-thinking', 128000, 32000],
  ['qwen3.5-397b-a17b', 256000, 64000],
  ['stepfun/step-3.7-flash', 256000, 256000],
  ['tencent/hy3-preview', 262144, 262144],
  ['tencent/hy4-preview', 1000000, 128000],
  ['xiaomi/mimo-v2.6-flash', 1000000, 128000],
  ['xiaomi/mimo-v2.6-pro', 1000000, 128000],
  ['z-ai/glm-4.6', 200000, 200000],
  ['z-ai/glm-4.7', 200000, 200000],
  ['z-ai/glm-5', 200000, 128000],
  ['z-ai/glm-5.1', 200000, 128000],
  ['z-ai/glm-5.2', 1000000, 128000],
  ['z-ai/glm-5.3', 1000000, 128000],
]

// ── 模型命名 / 能力位 / 排序（移植自上游 lib/models.mjs）───────────────

const VENDOR_NAMES = {
  qiniu: 'Qiniu',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  'z-ai': 'Z.ai',
  z: 'Z.ai',
  moonshotai: 'Moonshot',
  minimax: 'MiniMax',
  bytedance: 'ByteDance',
  tencent: 'Tencent',
  xiaomi: 'Xiaomi',
  stepfun: 'StepFun',
  nvidia: 'NVIDIA',
  meituan: 'Meituan',
}

const ACRONYMS = {
  glm: 'GLM',
  vl: 'VL',
  ai: 'AI',
  llm: 'LLM',
  gpt: 'GPT',
  mcp: 'MCP',
  moe: 'MoE',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  doubao: 'Doubao',
  nemotron: 'Nemotron',
  longcat: 'LongCat',
  hy: 'HY',
  mimo: 'MiMo',
  seed: 'Seed',
  step: 'Step',
  conatus: 'Conatus',
}

/** 官方页面明确支持图像输入的模型。 */
const VISION_IDS = new Set([
  'qiniu/conatus-free',
  'moonshotai/kimi-k3',
  'moonshotai/kimi-k3-free',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2.7-code',
  'minimax/minimax-m3',
  'minimax/minimax-m3.1-flash',
  'xiaomi/mimo-v2.6-pro',
  'xiaomi/mimo-v2.6-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  'z-ai/glm-5.3-flash',
  'qwen3.5-397b-a17b',
  'qwen/qwen3.7-max',
  'qwen/qwen3.7-plus',
  'qwen/qwen3.7-flash',
  'qwen/qwen3.8-max',
  'qwen/qwen3.8-flash-next',
  'doubao-1.5-vision-pro',
])

const VISION_RE = /(?:^|[-/])(?:vl|vision)(?:[-/]|$)/i
const DOUBAO_SEED_RE = /^(?:bytedance\/)?doubao-seed-/i

/** 官方标注「深度思考」的模型家族。 */
const REASONING_IDS = new Set([
  'qiniu/conatus-free',
  'moonshotai/kimi-k3',
  'moonshotai/kimi-k3-free',
  'minimax/minimax-m3',
  'minimax/minimax-m3.1-flash',
  'nvidia/nemotron-3-ultra-550b-a55b0-free',
  'tencent/hy4-preview',
])

const REASONING_RE = /(thinking|reasoner|(?:^|[-/])r1(?:[-/]|$)|deepseek-v3\.[12]|deepseek-v4|glm-5|qwen3|mimo-|doubao-seed-2)/i

/**
 * 名字带 instruct 的是指令微调（非思考）模型，即使家族名命中 REASONING_RE 也不能标成推理模型
 * （`qwen3-coder-480b-a35b-instruct`、`qwen3-235b-a22b-instruct-2507` …，上游 PR #374 评审第 3 条）。
 */
const INSTRUCT_RE = /(?:^|[-/])instruct(?:[-/]|$)/i

const FREE_RE = /-free$|conatus-free$/i

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 8192

const hasVision = (id) => VISION_IDS.has(id) || VISION_RE.test(id) || DOUBAO_SEED_RE.test(id)

const hasReasoning = (id) => {
  if (INSTRUCT_RE.test(id)) return false
  return REASONING_IDS.has(id) || REASONING_RE.test(id)
}

const isFree = (id) => FREE_RE.test(id)

function titleCase(word) {
  if (!word) return word
  const lower = word.toLowerCase()
  if (ACRONYMS[lower]) return ACRONYMS[lower]
  if (/^[a-z]{1,3}\d[\d.]*$/i.test(word)) return word.toUpperCase()
  if (/^\d/.test(word)) return word
  return word[0].toUpperCase() + word.slice(1)
}

/** `qiniu/conatus-free` → "Conatus Free"；`deepseek/deepseek-v4-pro` → "DeepSeek V4 Pro"。 */
function prettify(id) {
  const raw = String(id)
  const slash = raw.indexOf('/')

  let vendorRaw = ''
  let modelRaw = raw
  if (slash > 0) {
    vendorRaw = raw.slice(0, slash)
    modelRaw = raw.slice(slash + 1)
  } else {
    const hit = Object.keys(VENDOR_NAMES)
      .filter((name) => name.length > 2)
      .find((name) => raw.toLowerCase().startsWith(`${name}-`))
    if (hit) {
      vendorRaw = hit
      modelRaw = raw.slice(hit.length + 1)
    }
  }

  const vendor = vendorRaw ? VENDOR_NAMES[vendorRaw.toLowerCase()] ?? titleCase(vendorRaw) : ''
  const dupPrefix = `${vendorRaw.toLowerCase()}-`
  const trimmed = modelRaw.toLowerCase().startsWith(dupPrefix) ? modelRaw.slice(dupPrefix.length) : modelRaw
  const model = trimmed
    .split(/[-_]/)
    .map(titleCase)
    .join(' ')
    .replace(/\b(\d) (\d)\b/g, '$1.$2')

  if (!vendor || vendor === 'Qiniu') return model || id
  if (model.toLowerCase().startsWith(vendor.toLowerCase())) return model
  return `${vendor} ${model}`
}

// ⚠️ magpie 只把供应商列表的**前 24 个**模型交给 agent（"agents see up to 24 of its models"）。
//    按 id 字典序排的话，大写开头的 bytedance/…、deepseek/… 会占满前 24，
//    而小写开头的 qiniu/conatus-free、kimi-k3-free、glm-4.5-air-free 全被截断在外面 ——
//    也就是这个渠道主打的东西，agent 一个都看不到（上游 PR #374 评审第 1 条）。
const FLAGSHIP_ORDER = [
  'qiniu/conatus-free',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'moonshotai/kimi-k3',
  'minimax/minimax-m3',
  'qwen/qwen3.7-max',
  'qwen/qwen3.8-max',
  'z-ai/glm-5.3-flash',
]

const CONATUS_ID = 'qiniu/conatus-free'

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** 排序：免费模型 → 旗舰 → 其余按 id；免费组内 conatus 固定第一。 */
function sortModelIds(ids) {
  const rank = (id) => {
    if (isFree(id)) return 0
    return FLAGSHIP_ORDER.includes(id) ? 1 : 2
  }
  return [...ids].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) {
      const ca = a === CONATUS_ID
      const cb = b === CONATUS_ID
      if (ca !== cb) return ca ? -1 : 1
      return byId(a, b)
    }
    if (ra === 1) {
      const ia = FLAGSHIP_ORDER.indexOf(a)
      const ib = FLAGSHIP_ORDER.indexOf(b)
      if (ia !== ib) return ia - ib
      return byId(a, b)
    }
    return byId(a, b)
  })
}

/**
 * 按 sortModelIds 的顺序重排模型 map。
 *
 * ⚠️ 排序依据是**完整 id**（免费 / 旗舰那套规则是照 id 写的），而我们的行里
 *   **不带 `id`**（见 buildModels 注释）—— 所以要用 key → 完整 id 的映射反查，
 *   否则每个模型的 id 都取到空串、排序直接失效（免费模型会被挤到 24 名外）。
 */
function sortModels(models) {
  const idOf = (key, model) => String(model?.id ?? keyToId.get(key) ?? key)
  const order = sortModelIds(Object.entries(models).map(([key, m]) => idOf(key, m)))
  const rankOf = new Map(order.map((id, i) => [id, i]))
  return Object.fromEntries(
    Object.entries(models).sort(([ka, a], [kb, b]) => {
      const ia = rankOf.get(idOf(ka, a)) ?? Number.MAX_SAFE_INTEGER
      const ib = rankOf.get(idOf(kb, b)) ?? Number.MAX_SAFE_INTEGER
      return ia - ib
    }),
  )
}

/** 去掉与厂商重复的第一段：`deepseek/deepseek-v4-pro` → `deepseek-v4-pro`。 */
function keyFor(id) {
  const raw = String(id)
  const idx = raw.indexOf('/')
  const short = idx === -1 ? raw : raw.slice(idx + 1)
  // ⚠️ key 必须**不含斜杠**：聚合层 resolve() 只取模型 id 的最后一段，
  //    带斜杠的 key 会被截断成另一串（见文件头说明）。
  return short.includes('/') ? short.replace(/\//g, '-') : short
}

/**
 * 由整份 id 列表算出 id → key（顺序无关）。
 * 短名**全局唯一**时才用，否则该 id 保留完整 id —— 判断不依赖遍历顺序，
 * 所以同一份列表无论什么顺序返回，得到的 key 都一样（上游 PR #374 评审第 5 条）。
 */
function planKeys(ids) {
  const list = [...new Set(ids.map(String))].sort()
  const shortCount = new Map()
  for (const id of list) {
    const short = keyFor(id)
    shortCount.set(short, (shortCount.get(short) ?? 0) + 1)
  }
  const out = new Map()
  for (const id of list) {
    const short = keyFor(id)
    out.set(id, shortCount.get(short) === 1 ? short : keyFor(id))
  }
  return out
}

function clampOutput(maxOutput, context) {
  const out = Number(maxOutput) > 0 ? Number(maxOutput) : DEFAULT_OUTPUT
  return Math.min(out, context)
}

/**
 * 由 `[id, context, output]` 行构建**目录用的**模型表（key → 行）。
 *
 * ⚠️ 行里**不带 `id` 字段**：magpie 的模型 id = `<供应商>/<key>`，
 *    自己再带一个 `id`（含斜杠）会与聚合层的 resolve() 打架（见文件头）。
 *    完整 id 只存在本文件的映射表里，chat 时还原。
 *
 * `fallback` 只做逐模型覆盖，**不新增 id**：早前上游是 `{...known, ...build(rows, known)}`，
 * 快照作基底 ⇒ 七牛下线的模型会永远留着，agent 选中后必然报错（评审第 3 条）。
 */
function buildModels(rows, fallback = {}) {
  const models = {}
  const ids = []
  for (const row of rows) {
    const id = Array.isArray(row) ? row[0] : row?.id
    if (id) ids.push(String(id))
  }
  const keys = planKeys(ids)

  for (const row of rows) {
    const rawId = Array.isArray(row) ? row[0] : row?.id
    if (!rawId) continue
    const id = String(rawId)
    const key = keys.get(id) ?? keyFor(id)
    const base = fallback[key] ?? fallback[id] ?? {}
    const rawContext = Number(Array.isArray(row) ? row[1] : row?.context_length) || 0
    const rawOutput = Number(Array.isArray(row) ? row[2] : row?.max_tokens) || 0
    const context = rawContext > 0 ? rawContext : base?.limit?.context ?? DEFAULT_CONTEXT
    models[key] = {
      name: prettify(id),
      limit: { context, output: clampOutput(rawOutput || base?.limit?.output, context) },
      tool_call: true,
      reasoning: hasReasoning(id),
      modalities: { input: hasVision(id) ? ['text', 'image'] : ['text'] },
      ...(isFree(id) ? { free: true } : {}),
    }
  }
  return models
}

function compileMatcher(patterns) {
  const list = (patterns ?? []).filter((p) => typeof p === 'string' && p)
  if (!list.length) return null
  const tests = list.map((pattern) => {
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const end = pattern.lastIndexOf('/')
      const re = new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || 'i')
      return (id, key) => re.test(id) || re.test(key)
    }
    return (id, key) => id === pattern || key === pattern || id.startsWith(pattern)
  })
  return (id, key) => tests.some((test) => test(id, key))
}

/** 模型 key → 完整上游 id 的映射（由快照算出；线上目录到来时会重建）。 */
const keyToId = new Map()
/** 快照模型表（key → 行），既当兜底目录，也当逐模型覆盖源。 */
const SNAPSHOT_MODELS = (() => {
  const ids = CATALOG.map((row) => String(row[0]))
  const keys = planKeys(ids)
  const models = buildModels(CATALOG, {})
  for (const id of ids) keyToId.set(keys.get(id) ?? keyFor(id), id)
  return models
})()

/**
 * 兜底目录：未登录 / 断网 / 接口异常时也看得到模型。
 * ⚠️ 必须是**对象**：聚合层直接对它 `Object.keys()` 取数量，给函数会被当成空目录
 *   （真机：hub-qiniu 起来时显示「0 models」）。所以要在这里就把函数调出来的结果存好。
 */
const FALLBACK_MODELS = { ...SNAPSHOT_MODELS }

/** 记录一份新目录（线上列表）的 key → id 映射。 */
function rememberKeys(ids) {
  const keys = planKeys(ids)
  for (const id of ids) keyToId.set(keys.get(id) ?? keyFor(id), String(id))
}

/**
 * 把聚合层递过来的模型名还原成七牛要的完整 id。
 * 三种写法都认：目录短名（`deepseek-v4-pro`）/ 完整 id（`deepseek/deepseek-v4-pro`）/
 * 目录里没有的串（原样透传，让上游自己去报错 —— 比我们猜一个 id 更好）。
 */
function resolveUpstreamId(model) {
  const raw = typeof model === 'string' ? model.trim() : ''
  if (raw === '') return ''
  if (keyToId.has(raw)) return keyToId.get(raw)
  if (CATALOG.some((row) => String(row[0]) === raw)) return raw
  return raw
}

// ── AK/SK 签名（移植自上游 lib/sign.mjs）─────────────────────────────
//
// 文档：https://developer.qiniu.com/kodo/1201/access-token
// 只用于 auth.usage 读「今日已用」；模型请求走 `sk-` 的 API Key，绝不经过这里。

const URLSAFE = { '+': '-', '/': '_' }

const urlsafeBase64 = (buffer) => buffer.toString('base64').replace(/[+/]/g, (ch) => URLSAFE[ch])

/** `<AccessKey>:<EncodedSign>`，直接放进 `Authorization: Qiniu <token>`。 */
function signQiniuToken(accessKey, secretKey, method, path, host, extra = {}) {
  const { contentType = '', body = '', qiniuHeaders = {} } = extra
  let signing = `${method} ${path}\nHost: ${host}`
  if (contentType) signing += `\nContent-Type: ${contentType}`
  for (const name of Object.keys(qiniuHeaders).sort()) {
    signing += `\n${name}: ${qiniuHeaders[name]}`
  }
  signing += '\n\n'
  if (body && contentType && contentType !== 'application/octet-stream') signing += body

  const digest = createHmac('sha1', secretKey).update(signing).digest()
  return `${accessKey}:${urlsafeBase64(digest)}`
}

const qiniuAuthorization = (accessKey, secretKey, method, path, host) =>
  `Qiniu ${signQiniuToken(accessKey, secretKey, method, path, host)}`

// ── 今日用量（移植自上游 lib/usage.mjs）──────────────────────────────
//
// GET https://api.qiniu.com/ai/inapi/v3/stat/new（AK/SK 签名）
//
// 三个易踩的点（上游第一版就踩了，测试已钉住）：
//   ① 计费项名在 `key`（cache / ncache / output），不是 `name`；`name` 是模型 id；
//   ② 单位在 `unit_name`（"token"），不是 `unit`；
//   ③ `total` 是「多少个 unit_size_default」—— unit_size_default=1000 时
//      total=537.1 其实是 537,100 token。漏乘就少算三个数量级，
//      用量卡会永远停在「100% 剩余」（评审第 2 组的真机报告）。

const HOST = 'api.qiniu.com'
const STAT_PATH = '/ai/inapi/v3/stat/new'
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000

const pad = (n) => String(n).padStart(2, '0')

/** 北京时间当天 00:00 ~ 次日 00:00 的毫秒时间戳。 */
function shanghaiDay(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET)
  const startLocal = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  const start = startLocal - SHANGHAI_OFFSET
  return { start, end: start + 24 * 60 * 60 * 1000 }
}

/** 毫秒 → RFC3339（+08:00）。 */
function rfc3339(ms) {
  const d = new Date(ms + SHANGHAI_OFFSET)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
  )
}

/** 1234567 → "1.23M"。 */
function compact(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  for (const [base, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (abs >= base) {
      const scaled = value / base
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2).replace(/\.?0+$/, '')}${suffix}`
    }
  }
  return String(Math.round(value))
}

/**
 * 中文量词写法：1e9 → "10 亿"、1.5e4 → "1.5 万"。
 * 七牛控制台的额度页就是这种写法（「今日剩余 10 亿 / 10 亿 Token」）——
 * 卡片用同一套单位，用户不必把「1B」和「10 亿」在心里对一次账。
 */
function formatTokens(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return '0'
  const trim = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(2).replace(/\.?0+$/, ''))
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${trim(value / 1e8)} 亿`
  if (abs >= 1e4) return `${trim(value / 1e4)} 万`
  return String(Math.round(value))
}

const field = (item, ...keys) => {  for (const k of keys) {
    const v = item?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 计费项 → 每个 `total` 折算多少 token（非 token 类返回 0）。 */
function tokenFactor(item) {
  const unitName = field(item, 'unit_name', 'unit').toLowerCase()
  const key = field(item, 'key', 'name').toLowerCase()
  const source = unitName.includes('token') ? unitName : key.includes('token') ? key : ''
  if (!source) return 0
  const size = Number(item?.unit_size_default ?? item?.unitSizeDefault)
  if (Number.isFinite(size) && size > 0) return size
  if (/^k\//.test(source) || /千\s*token/.test(source)) return 1000
  if (/百万|m\/token|m\s*token/.test(source)) return 1e6
  return 1
}

/** 从 /stat/new 响应累加 token 用量。 */
function sumUsage(payload, { modelFilter } = {}) {
  const groups = Array.isArray(payload?.data) ? payload.data : []
  const needle = String(modelFilter ?? '').trim().toLowerCase()
  let tokens = 0
  let requests = 0
  for (const group of groups) {
    const model = field(group, 'name')
    if (needle && !model.toLowerCase().includes(needle)) continue
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      const total = Number(item?.total)
      if (!Number.isFinite(total)) continue
      const factor = tokenFactor(item)
      if (factor) {
        tokens += total * factor
        continue
      }
      if (/^(次|请求|requests?)$/i.test(field(item, 'unit_name', 'unit'))) requests += total
    }
  }
  return { tokens, requests }
}

/** 查询账户今天的 token 用量（AK/SK 签名）。 */
async function fetchTodayUsage({ accessKey, secretKey, modelFilter, now = Date.now() }) {
  const day = shanghaiDay(now)
  const query = new URLSearchParams({
    start: rfc3339(day.start),
    end: rfc3339(Math.min(now, day.end)),
    g: 'day',
  }).toString()
  const path = `${STAT_PATH}?${query}`

  let res
  try {
    res = await fetch(`https://${HOST}${path}`, {
      headers: {
        authorization: qiniuAuthorization(accessKey, secretKey, 'GET', path, HOST),
        accept: 'application/json',
      },
    })
  } catch (err) {
    return { error: `连接七牛用量接口失败：${err?.message ?? err}` }
  }

  const text = await res.text().catch(() => '')
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch { /* 非 JSON，落到下面的错误分支 */ }

  if (res.status === 401 || res.status === 403) {
    return { error: `七牛拒绝了 AK/SK（HTTP ${res.status}），请检查 AccessKey/SecretKey` }
  }
  if (!res.ok) {
    const detail = payload?.error ?? text.slice(0, 120)
    return { error: `用量接口返回 HTTP ${res.status}${detail ? `：${detail}` : ''}` }
  }
  if (payload?.status === false) {
    return { error: `用量接口返回失败：${payload?.error ?? '未知原因'}` }
  }
  return { ...sumUsage(payload, { modelFilter }), day }
}

/**
 * 7 天不重算的「活动档位是否已结束」。
 * 截止后档位不再代表额度：退回只报已用量，绝不继续编百分比。
 */
function activityExpired(now = Date.now()) {
  const end = Date.parse(`${ACTIVITY_ENDS_AT}T23:59:59+08:00`)
  return Number.isFinite(end) ? now > end : false
}

/** 每日上限：`qiniuDailyQuota`（手填数字）优先，其次 `qiniuActivityTier`（档位名）。 */
function resolveDailyLimit(options = {}, now = Date.now()) {
  const explicit = Number(options.qiniuDailyQuota)
  if (Number.isFinite(explicit) && explicit > 0) return { limit: explicit, source: 'dailyQuota' }

  const raw = options.qiniuActivityTier
  if (raw === undefined || raw === null || String(raw).trim() === '') return { limit: 0, source: null }

  const tier = String(raw).trim().toLowerCase()
  const quota = ACTIVITY_TIERS[tier]
  if (quota === undefined) {
    throw new Error(
      `qiniuActivityTier 填错了：${raw}。可选值：`
      + Object.entries(TIER_HINTS).map(([k, hint]) => `${k}（${hint}）`).join(' / '),
    )
  }
  if (activityExpired(now)) return { limit: 0, source: null, expired: true }
  return { limit: quota, source: 'activityTier' }
}

/**
 * AK/SK 解析（来自**插件 options**，永不抛错）。
 *
 * 为什么不放登录问项：七牛有两套凭证 —— `sk-…` 的 API Key 调模型，40 位 AK/SK 只用于
 * 读用量。真机（2026-11-01）证明让用户登录时填 4 格会全被填成同一个 key
 * （槽里 key / accessKey / secretKey 同一串），卡片出现假的「剩余 100%」，
 * 而「额度查询失败：Secretke…」这种文案比不显示还糟。
 * 现在 AK/SK 是 options 里的**可选**配置：不配就只显示登录状态、照常聊天。
 *
 * @returns {{ configured: true, accessKey: string, secretKey: string } | { configured: false, hint: string }}
 */
function readCredentials(options = {}) {
  const ak = String(options?.qiniuAccessKey ?? '').trim()
  const sk = String(options?.qiniuSecretKey ?? '').trim()
  if (ak === '' || sk === '') {
    return { configured: false, hint: '未配 AK/SK，读不到额度（options.qiniuAccessKey / qiniuSecretKey）' }
  }
  if (sk.startsWith('sk-')) {
    return { configured: false, hint: 'qiniuSecretKey 填成了 API Key（应为 40 位、不带 sk-）' }
  }
  if (ak.startsWith('sk-')) {
    return { configured: false, hint: 'qiniuAccessKey 填成了 API Key（应为 40 位、不带 sk-）' }
  }
  return { configured: true, accessKey: ak, secretKey: sk }
}
// ── 渠道 ──────────────────────────────────────────────────────────────

const fail = (message, status = 502) =>
  Response.json({ error: { type: 'provider_error', message } }, { status })

/** 只有「密钥本身被拒」的 401 才标记需重新登录，其他 401 交给 magpie 常规处理。 */
async function isKeyRejected(res) {
  if (res.status !== 401) return false
  try {
    const payload = await res.clone().json()
    const code = String(payload?.error?.code ?? payload?.error_code ?? '')
    const message = String(payload?.error?.message ?? payload?.error ?? '')
    if (!code && !message) return true
    return /auth|api_?key|token|credential|unauthor/i.test(`${code} ${message}`)
  } catch {
    return true
  }
}

let cache = { at: 0, ids: null }

/** 仅供测试：清掉线上目录缓存（生产路径不需要）。 */
function resetModelCache() { cache = { at: 0, ids: null } }

/** 线上目录 `GET {base}/models`（可匿名读）→ 失败/空则回 null（由调用方退回快照）。 */
async function liveIds(apiKey) {
  if (cache.ids && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids
  try {
    const headers = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(`${BASE}/models`, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) })
    if (!res.ok) return null
    const payload = await res.json()
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
    const mapped = rows
      .map((row) => [row?.id, Number(row?.context_length) || 0, Number(row?.max_tokens) || 0])
      .filter((row) => typeof row[0] === 'string' && row[0])
    if (mapped.length === 0) return null
    cache = { at: Date.now(), ids: mapped }
    return mapped
  } catch {
    return null
  }
}

/** 目录：线上为准（只提供线上真有的 id），快照只做覆盖与降级。 */
async function catalog(credential) {
  const apiKey = typeof credential?.key === 'string' ? credential.key.trim() : ''
  const rows = await liveIds(apiKey)
  if (rows === null) return sortModels({ ...SNAPSHOT_MODELS })
  const ids = rows.map((row) => String(row[0]))
  rememberKeys(ids)
  // ⚠️ 必须排序：线上列表的返回顺序不可控，而 magpie 只取前 24 个给 agent ——
  //    不排的话免费模型（本渠道主打）会被挤到 24 名之外看不到。
  return sortModels(buildModels(rows, SNAPSHOT_MODELS))
}

/**
 * 对话：把请求原样代理到七牛（OpenAI 兼容），只做两件事 ——
 *   ① 模型名还原成完整 id（目录短名 → `vendor/model`）；
 *   ② key 失效时补 `x-magpie-sign-in: expired`，让 magpie 把账号标成
 *      「需重新登录」，而不是当成一次普通请求失败去做故障切换。
 * ⚠️ 返回**原始 Response**（hub 契约），流式不缓冲。
 */
async function chat(credential, { body, signal } = {}) {
  const apiKey = typeof credential?.key === 'string' ? credential.key.trim() : ''
  if (apiKey === '') return fail('未登录：缺少七牛云 API Key', 401)

  const model = resolveUpstreamId(body?.model)
  if (model === '') return fail('请求缺少 model', 400)

  const stream = body?.stream !== false
  let response
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify({ ...body, model }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return fail(`连接七牛云失败：${error?.message ?? error}`)
  }

  if (!(await isKeyRejected(response))) return response
  const headers = new Headers(response.headers)
  headers.set('x-magpie-sign-in', 'expired')
  // 换掉 body 流后长度/压缩头不再可信，删掉以免下游解析出错
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * 用量窗口。
 *
 * 七牛**没有**「剩余额度」接口，只给已消耗量，所以：
 *   · 没填 AccessKey/SecretKey → 返回空数组（不是错误：这两项本来就可选，补读 README）；
 *   · 没声明档位（`qiniuActivityTier` / `qiniuDailyQuota`）→ 只报「今日已用」，**不编百分比**。
 *     编一个 1 亿出来，窗口到 100% 时 magpie 会挂起账号，付费用户与用付费模型的用户都会被误伤。
 *   · 声明了档位 → 出百分比窗口，且**只统计免费模型**（活动额度只覆盖它们）。
 *
 * 窗口是「每日重置」语义：resetsAt = 北京时间次日 00:00，
 * magpie 靠它画剩余额度走势的投影虚线。
 */
async function usage(credential, extras = {}) {
  const options = extras?.options ?? {}
  const keys = readCredentials(options)

  // 没配（或填错）AK/SK：**不报错、不出百分比**，只说明为什么没有额度。
  // ⚠️ 这一行刻意不带 `used`：带了 magpie 会画成「剩余 100%」——
  //    我们根本不知道剩余多少，画满条就是编数据。
  if (!keys.configured) {
    return [{
      name: '额度',
      // ⚠️ 文案要**前置结论**：卡片窄，长句会被截断成「Secretke…」，等于没说
      display: `${keys.hint}；七牛无剩余额度接口（见 README）`,
    }]
  }

  let resolved
  try {
    // 档位来源：登录问项（账号 metadata → 凭据）优先，其次插件 options。
    // ⚠️ options 那条路实测走不通（`plugin options` 只接受插件声明过的开关），
    //    所以真正可用的是登录问项。
    resolved = resolveDailyLimit(options)
  } catch (error) {
    return [{ name: '额度', display: `档位配置有误：${error?.message ?? error}` }]
  }
  const limit = resolved.limit
  const hasLimit = limit > 0
  const modelFilter = hasLimit ? options.qiniuUsageModel ?? FREE_MODEL_FILTER : options.qiniuUsageModel

  const result = await fetchTodayUsage({ ...keys, modelFilter })
  // 读失败也**不抛**：抛了会被聚合层兜成「额度查询失败：…」+ 假 100%，看不清原因
  if (result.error) return [{ name: '额度', display: `读不到用量：${result.error}` }]

  const tokens = result.tokens ?? 0
  const day = result.day ?? shanghaiDay()
  const left = hasLimit ? Math.max(0, limit - tokens) : 0

  // ⚠️ 窗口字段白名单只有 name/used/display/resetsAt/aside —— 数字必须写进 display
  const note = resolved.expired
    ? `（活动档位 ${options.qiniuActivityTier} 已于 ${ACTIVITY_ENDS_AT} 截止，如需显示剩余请填 qiniuDailyQuota）`
    : '（配 qiniuDailyQuota 可算剩余）'

  return [{
    name: hasLimit ? '今日额度' : '今日已用',
    resetsAt: new Date(day.end).toISOString(),
    ...(hasLimit
      ? {
          used: Math.min(100, (tokens / limit) * 100),
          limit,
          amount: tokens,
        }
      : {}),
    display: hasLimit
      ? `今日剩余 ${formatTokens(left)} / 共 ${formatTokens(limit)} Token（已用 ${formatTokens(tokens)}）`
      : `今日已用 ${formatTokens(tokens)}${note}`,
  }]
}

export const qiniuChannel = {
  id: 'qiniu',
  displayName: '七牛云',

  /**
   * 粘贴型登录：**只有 API Key 一格**（`sk-…`），与 magpie 的「自定义供应商」一样轻。
   *
   * 额度是可选能力：七牛要用 40 位 AK/SK 签名才能读已用量，而 AK/SK 与调模型的
   * API Key 是两套凭证。早前把 AK/SK 做成登录问项，结果登录要填四格，真机上还被
   * 填成同一个 key（槽里 key / accessKey / secretKey 同一串），卡片出现假的「剩余 100%」。
   * 现在 AK/SK 与档位走**插件 options**，不配就只显示登录状态：
   *
   *   magpie plugin options <插件> '{`qiniuAccessKey`:…,`qiniuSecretKey`:…,`qiniuActivityTier`:`verified-plus`}'
   */
  apiAuth: {
    label: '粘贴七牛云 API Key',
    placeholder: 'sk-…（控制台 → AI 推理 → API Key）',
    keyField: 'key',
  },

  /**
   * 兜底目录：未登录 / 断网 / 接口异常时也看得到模型。
   * ⚠️ 必须是**对象**：聚合层直接对它 Object.keys() 取数量，给函数会被当成空目录
   *   （真机：hub-qiniu 起来时显示「0 models」）。
   */
  fallbackModels: FALLBACK_MODELS,

  catalog,
  chat,
  usage,

  /** 七牛没有签到端点 → inactive（绝不用 failed，会把卡片涂红）。 */
  checkin: () => ({ outcome: 'inactive' }),
}

// 供单测使用（非渠道契约的一部分）
export {
  CATALOG as QINIU_CATALOG,
  CATALOG_FETCHED_AT as QINIU_CATALOG_FETCHED_AT,
  BASE as QINIU_BASE,
  KEYS_URL as QINIU_KEYS_URL,
  ACTIVITY_TIERS as QINIU_ACTIVITY_TIERS,
  ACTIVITY_ENDS_AT as QINIU_ACTIVITY_ENDS_AT,
  FREE_MODEL_FILTER as QINIU_FREE_MODEL_FILTER,
  prettify as qiniuPrettify,
  buildModels as qiniuBuildModels,
  sortModelIds as qiniuSortModelIds,
  planKeys as qiniuPlanKeys,
  resolveUpstreamId as qiniuResolveUpstreamId,
  signQiniuToken as qiniuSignToken,
  shanghaiDay as qiniuShanghaiDay,
  rfc3339 as qiniuRfc3339,
  compact as qiniuCompact,
  tokenFactor as qiniuTokenFactor,
  sumUsage as qiniuSumUsage,
  fetchTodayUsage as qiniuFetchTodayUsage,
  resolveDailyLimit as qiniuResolveDailyLimit,
  readCredentials as qiniuReadCredentials,
  isKeyRejected as qiniuIsKeyRejected,
  resetModelCache as qiniuResetModelCache,
}