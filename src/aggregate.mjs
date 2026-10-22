// 聚合层：一个供应商，内部聚合多个渠道。
//
// ## 为什么是聚合而不是每渠道一个供应商
//
// 参照 ofm（our-free-model）：它**一个供应商**覆盖 13 个渠道，模型 id 带渠道前缀
// （`our-free-model/<upstream>/<model>`）。这样在 magpie 的供应商列表里只有**一个**
// 条目，而不是十几个并列的供应商。本插件同款：**一个条目，多渠**。
//
// 模型 id 形态：`dsh-hub/<channel>/<model>`，例：`dsh-hub/officeace/glm-5.3`。
// 请求进来时按前缀分派到对应渠道。
//
// ## 只做 ofm 没有的渠道
//
// ofm 已覆盖 13 个（CodeArts / WorkBuddy 国内+国际 / LobsterAI / Qoder 国内+国际 /
// TRAE / Cline / Loomy / Raccoon / MiniMax Code / ZCode / Gemini），
// 故 lobsterai、loomy **不做**。这里只补 ofm 没有的。

import { loadCredential, saveCredential, notSignedIn } from './shared.mjs'
import { officeaceChannel } from './officeace.mjs'
import { astudioChannel } from './astudio.mjs'

const PROVIDER = 'dsh-providers-hub'
const PROVIDER_NAME = 'DSH Providers Hub'

/**
 * loader 的占位 baseURL。
 *
 * ⚠️ 不能留空串：magpie 会据此判「无处可发」（`nowhere to send its requests`）。
 *    本插件的请求全部在 `loader().fetch` 里按渠道前缀改写到各上游，这个域名不会被真正访问；
 *    用 `.invalid` 保留域（RFC 2606）保证即使漏拦截也不会打到真实主机。
 */
const PLACEHOLDER_BASE = 'https://dsh-providers-hub.invalid'

/** 注册进来的渠道。加渠道 = 往这里加一项（并在上面 import）。 */
const CHANNELS = [officeaceChannel, astudioChannel]

// ── 凭据：每渠道一份文件，内存里各留一份 ──────────────────────────────────

const credentials = new Map()

function credentialOf(channel) {
  if (credentials.has(channel.id)) return credentials.get(channel.id)
  const stored = loadCredential(channel.id)
  if (stored) credentials.set(channel.id, stored)
  return stored
}

async function ensure(channel) {
  let current = credentialOf(channel)
  if (!current) throw notSignedIn(`未登录：请先在插件里登录 ${channel.displayName}`)
  if (channel.expired?.(current)) {
    current = await channel.refresh(current)
    credentials.set(channel.id, current)
    saveCredential(channel.id, current)
  }
  return current
}

/** 已登录的渠道（登录方法是**每渠道一个**，用户按需逐个登）。 */
const signedIn = (channel) => Boolean(credentialOf(channel))

// ── 目录：合并所有已登录渠道，模型 id 加渠道前缀 ──────────────────────────

/**
 * 目录里的模型 id 只带**渠道**前缀：`officeace/glm-5.3`
 * （与 jethub 同形态：那里 `loomy/GLM-5.3-Flash` 的 `loomy` 也是渠道）。
 * magpie 展示/选择时会自动补供应商名前缀，呈现为
 * `dsh-providers-hub/officeace/glm-5.3`。
 */
function prefixed(channelId, modelId) {
  return `${channelId}/${modelId}`
}

/**
 * 合并所有渠道的目录，模型 id 加渠道前缀。
 *
 * ⚠️ **按渠道分别回落**：已登录渠道拉到真实目录、未登录渠道用兜底目录。
 *    如果只在「一个渠道都没登录」时才回落（早先的写法），会造成
 *    「officeace 登录后，astudio 的模型从选择器里凭空消失」——
 *    用户看到的是模型变少，而不是「astudio 未登录」。
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

export const DshProvidersHubPlugin = async (_input, options = {}) => {
  const openBrowser = typeof options.openBrowser === 'function' ? options.openBrowser : undefined

  /** 请求体里的 model 是 `dsh-hub/<channel>/<model>`；拆出渠道。 */
  const resolve = (modelId) => {
    const raw = String(modelId ?? '')
    const parts = raw.split('/')
    // 兼容「只写了 channel/model」（不带供应商前缀）的历史选择
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
      // 每渠道一个登录入口 —— 用户按需逐个登（与 ofm 的控制台集中登录不同，
      // 各渠道登录方式不同：OAuth / 扫码 / 短信，合并不到一个按钮里）。
      //
      // ⚠️ 约定（对齐 ofm 的 `authorizeConsole`）：`authorize()` 必须**立刻**返回
      //    `{ url, method, callback }` —— 不要在这里 await 用户完成登录，否则
      //    magpie 在等 authorize 返回、用户却在等浏览器打开，双向死锁。
      //    真正等待登录完成的是 `callback()`：magpie 打开 url 之后才调它。
      //
      // 渠道统一契约：`beginLogin(openBrowser)` → `{ url, result }`
      //   - `url` 立刻可用（授权页 / 本地载体页）
      //   - `result` 兑现最终凭据（Promise）
      methods: CHANNELS.map((channel) => ({
        type: 'oauth',
        label: `登录 ${channel.displayName}`,
        async authorize() {
          const started = await channel.beginLogin(openBrowser)
          return {
            url: started.url,
            method: 'auto',
            instructions: `在打开的页面里完成 ${channel.displayName} 登录，本窗口会自动继续。`,
            async callback() {
              const credential = await started.result
              credentials.set(channel.id, credential)
              saveCredential(channel.id, credential)
              return { type: 'success', key: channel.id, metadata: { channel: channel.id } }
            },
          }
        },
      })),

      async loader() {
        return {
          // ⚠️ baseURL 不能是空串：magpie 会在发请求前据此判「无处可发」
          //    （症状：`provider test` 报 "nowhere to send its requests"）。
          //    这里只是占位 —— 真正的上游地址在下面的 fetch 里按渠道前缀改写。
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
            const credential = await ensure(hit.channel)
            // ⚠️ 发给上游的 model 必须**去掉**渠道前缀
            const upstreamBody = { ...body, model: hit.model }
            const response = await hit.channel.chat(credential, {
              body: upstreamBody,
              signal: init?.signal,
            })
            // 流式（SSE）与 JSON 都原样透传
            return response
          },
        }
      },

      async usage() {
        const windows = []
        for (const channel of CHANNELS) {
          if (!signedIn(channel)) continue
          const credential = credentialOf(channel)
          windows.push({
            name: channel.displayName,
            used: 0,
            display: channel.expired?.(credential) ? '已过期，请重新登录' : '已登录',
          })
        }
        return { plan: PROVIDER_NAME, windows }
      },

      async refresh() {
        let ok = true
        for (const channel of CHANNELS) {
          if (!signedIn(channel)) continue
          try {
            const next = await channel.refresh(credentialOf(channel))
            credentials.set(channel.id, next)
            saveCredential(channel.id, next)
          } catch {
            ok = false
          }
        }
        return { type: ok ? 'success' : 'failed' }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        return discoverModels(provider.models)
      },
    },
  }
}
