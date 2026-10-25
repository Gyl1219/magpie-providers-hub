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

import { loadCredential, saveCredential, notSignedIn, untilText } from './shared.mjs'
import { officeaceChannel } from './officeace.mjs'
import { astudioChannel } from './astudio.mjs'
import { minimaxintlChannel } from './minimaxintl.mjs'
import { accioChannel } from './accio.mjs'
import { autoclawChannel, autoclawIntlChannel } from './autoclaw.mjs'
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
const CHANNELS = [officeaceChannel, astudioChannel, minimaxintlChannel, accioChannel, autoclawChannel, autoclawIntlChannel]

// 供测试遍历 stub（authorize 契约测试必须覆盖每一个渠道，漏一个就会真发网络请求）
export { CHANNELS as REGISTERED_CHANNELS }

// ── 账号（auth）与凭据的形状工具 ──────────────────────────────────────────

/** auth 是否属于该渠道（登录回调写入的 `channel` 字段是唯一判据）。 */
const authOfChannel = (auth, channel) =>
  auth?.type === 'oauth' && auth?.channel === channel.id

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
      const merged = current?.type === 'oauth' ? { ...current, ...next } : next
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

// ── 插件 ─────────────────────────────────────────────────────────────────

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
  if (summable.length <= 3) return rows
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
      name: `临期 · 剩 ${pointer.amount}`,
      // ⚠️ display 只放倒计时 —— 剩余量已在 name 里（重复了用户会看到两遍）；
      //    倒计时必须进**亮色主文本**：「将于 X 过期」辅助行浅灰看不清（用户报障）
      display: untilText(expiry) ?? `剩 ${pointer.amount}`,
      runsOutAt: expiry,
      runsOut: pointer.amount,
    })
    delete out[out.length - 1].resetsAt
  }
  const longTerm = expiring.slice(1)
  if (longTerm.length > 0) {
    const earliest = longTerm[0]
    const amount = longTerm.reduce((s, r) => s + r.amount, 0)
    const expiry = expiryOf(earliest)
    out.push({
      ...earliest,
      name: `长期（${longTerm.length} 批）· 剩 ${amount}`,
      amount,
      display: untilText(expiry) !== undefined ? `最早 ${untilText(expiry)}` : `剩 ${amount} · ${longTerm.length} 批`,
      runsOutAt: expiry,
      // ⚠️ runsOut 必须是**那一批**的量（最早时刻真正作废的）——
      //    写成合计会把「6 批不同时刻作废」说成「一次全没」
      runsOut: earliest.amount,
    })
    delete out[out.length - 1].resetsAt
  }
  if (permanent.length > 0) {
    const amount = permanent.reduce((s, r) => s + r.amount, 0)
    out.push({
      name: permanent.length === 1 && typeof permanent[0].name === 'string' ? permanent[0].name : `永久 · 剩 ${amount}`,
      used: 0,
      amount,
      display: `剩 ${amount}`,
    })
  }
  return [...out, ...rest]
}

export const DshProvidersHubPlugin = async (input, options = {}) => {
  const openBrowser = typeof options.openBrowser === 'function' ? options.openBrowser : undefined
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
  /** magpie 的 auth 存储（社区插件同款 `client.auth.set`；不可用则只写旁路）。 */
  const authSet = typeof input?.client?.auth?.set === 'function' ? input.client.auth.set : undefined
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

  /** 请求体里的 model 是 `<channel>/<model>`（可能带供应商前缀）；拆出渠道。 */
  const resolve = (modelId) => {
    const raw = String(modelId ?? '')
    const parts = raw.split('/')
    const channelId = parts.length >= 2 ? parts[parts.length - 2] : ''
    const inner = parts[parts.length - 1] ?? ''
    const channel = CHANNELS.find((c) => c.id === channelId)
    return channel ? { channel, model: inner } : undefined
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
          const started = await channel.beginLogin(openBrowser, { xff: minimaxXff, proxy: minimaxProxy, proxy: minimaxProxy })
          return {
            url: started.url,
            method: 'auto',
            instructions: started.instructions
              ?? `在打开的页面里完成 ${channel.displayName} 登录，本窗口会自动继续。`,
            async callback() {
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
                accountId: typeof credential?.nickname === 'string' && credential.nickname !== ''
                  ? credential.nickname
                  : channel.displayName,
              }
              writeSidecar(channel, { type: 'oauth', channel: channel.id, ...credential })
              await saveAuth(auth)
              return auth
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
          return { plan: PROVIDER_NAME, windows: await usageWindowsOf(channel, credential) }
        }
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
          windows.push(...await usageWindowsOf(each, credential))
        }
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
       */
      async checkin(getAuth) {
        const auth = await safeGetAuth(getAuth)
        const channel = CHANNELS.find((c) => authOfChannel(auth, c))
        if (channel !== undefined) {
          if (typeof channel.checkin !== 'function') {
            return { outcome: 'inactive', message: `${channel.displayName} 无每日签到` }
          }
          const credential = await ensureAuth(channel, auth)
          return { channel: channel.displayName, ...await channel.checkin(credential, { xff: minimaxXff, proxy: minimaxProxy }) }
        }
        return legacyCheckinAll()
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        return discoverModels(provider.models)
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

  /** 旁路口径的全渠道签到（无账号上下文时的兼容路径）。 */
  async function legacyCheckinAll() {
    const channels = []
    let creditSum = 0
    let hasCredit = false
    let claimed = 0
    let done = 0
    let failed = 0
    for (const channel of CHANNELS) {
      if (typeof channel.checkin !== 'function') continue
      if (!signedIn(channel)) continue
      try {
        const outcome = await channel.checkin(sidecarCredentialOf(channel), { xff: minimaxXff, proxy: minimaxProxy })
        channels.push({ channel: channel.displayName, ...outcome })
        if (outcome.outcome === 'claimed') {
          claimed += 1
          if (Number.isFinite(outcome.credit)) { creditSum += outcome.credit; hasCredit = true }
        } else if (outcome.outcome === 'done') done += 1
        else if (outcome.outcome === 'failed') failed += 1
      } catch (error) {
        failed += 1
        channels.push({ channel: channel.displayName, outcome: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    }
    const parts = channels.map((c) => `${c.channel}：${c.message ?? (c.outcome === 'claimed' ? `已领 ${c.credit ?? ''}` : c.outcome)}`)
    const outcome = claimed > 0 ? 'claimed'
      : failed > 0 ? 'failed'
        : channels.length > 0 ? 'done' : 'inactive'
    return {
      outcome,
      ...(hasCredit ? { credit: creditSum } : {}),
      ...(parts.length > 0 ? { message: parts.join('；') } : {}),
      channels,
    }
  }
}
