// 账号池与分派的行为契约（v0.5.0 重写版）。
//
// 核心主张：一个供应商 = 一个渠道；凭据只存 magpie 账号槽（`getAuth`）；
// 插件侧凭据只在内存里流转（**不写任何宿主文件**）；续期去重闸按凭据身份键控。
//
// ⚠️ 状态隔离：**每个用例**独立 HOME + 全新聚合层模块实例（URL 加查询串绕过
//    ESM 缓存）—— `memoryCredentials` / `renewInFlight` 都是模块级的，
//    不换实例会跨用例泄漏。
// ⚠️ v0.5.0 起被测渠道只能用保留的五条（astudio / accio / lobsterai /
//    magicrew / magicrew-intl）；officeace / minimaxintl 等已从包里删除。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const originalHome = process.env.USERPROFILE

let seq = 0
/**
 * 独立沙箱里构建插件：新 HOME → 全新 aggregate 实例 → 回调。
 * 用完清理沙箱并还原 HOME。
 */
async function isolated(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-pool-'))
  const previousAuthPath = process.env.DSH_HUB_AUTH_PATH
  process.env.USERPROFILE = sandbox
  process.env.HOME = sandbox
  process.env.DSH_HUB_AUTH_PATH = join(sandbox, '.config', 'magpie', 'plugin-auth.json')
  const q = `?v=${++seq}-${Date.now()}`
  const url = pathToFileURL(join(import.meta.dirname, '..', 'src', 'aggregate.mjs')).href + q
  try {
    const mod = await import(url)
    /** 建某个供应商实例（默认 astudio）。 */
    const build = async (input = {}, options = {}, channelId = 'astudio') => {
      const channel = mod.REGISTERED_CHANNELS.find((c) => c.id === channelId)
      const plugin = await mod.makeHubPlugin(channel)(input, options)
      const cfg = {}
      await plugin.config(cfg)
      return plugin
    }
    return await fn({ build, mod, sandbox })
  } finally {
    process.env.USERPROFILE = originalHome
    process.env.HOME = originalHome
    if (previousAuthPath === undefined) delete process.env.DSH_HUB_AUTH_PATH
    else process.env.DSH_HUB_AUTH_PATH = previousAuthPath
    rmSync(sandbox, { recursive: true, force: true })
  }
}

/** 收集 toast 的 client stub（登录反馈改走 toast，不再有系统通知）。 */
const toastClient = () => {
  const toasts = []
  const saved = []
  return {
    toasts,
    client: {
      app: { log: async () => {} },
      auth: { set: async (arg) => { saved.push(arg) }, get: async () => undefined },
      tui: { showToast: async (arg) => { toasts.push(arg?.body?.message ?? '') } },
      config: { get: async () => ({ data: {} }) },
    },
    saved,
  }
}

const CHAT_BODY = (model = 'hub-astudio/spark-x') => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })

const astudioAuth = (over = {}) => ({
  type: 'oauth',
  channel: 'astudio',
  accessToken: 'AT-1',
  ssoSessionId: 'sso',
  accountId: 'acc-1',
  ...over,
})

// ── 到期时刻解析（纯函数）───────────────────────────────────────────────

test('expiresMsOf：ISO 串 / 毫秒串 / 毫秒数字 / 秒级兼容；无字段 → undefined', async () => {
  await isolated(async ({ mod }) => {
    const { expiresMsOf } = mod
    assert.equal(expiresMsOf({ expiresAt: '2026-10-25T12:00:00Z' }), Date.parse('2026-10-25T12:00:00Z'))
    assert.ok(expiresMsOf({ expires_at: String(Date.now() + 3600_000) }) > Date.now())
    assert.ok(expiresMsOf({ expires_at: Date.now() + 3600_000 }) > Date.now())
    assert.ok(expiresMsOf({ expires_at: String(Math.floor((Date.now() + 3600_000) / 1000)) }) > Date.now(), '秒级数字串要 ×1000')
    assert.equal(expiresMsOf({ fake: true }), undefined, '无到期字段 → undefined')
  })
})

// ── loader：按账号槽取凭据 ───────────────────────────────────────────────

test('loader 用 getAuth 账号的凭据（同渠道多账号 = magpie 换槽即换号）', async () => {
  await isolated(async ({ build, mod }) => {
    const channel = mod.REGISTERED_CHANNELS.find((c) => c.id === 'astudio')
    const seen = []
    const original = channel.chat
    channel.chat = async (credential) => {
      seen.push(credential.accessToken)
      return Response.json({ ok: true })
    }
    try {
      const plugin = await build({}, { notify: false })
      let { fetch: pluginFetch } = await plugin.auth.loader(async () => astudioAuth({ accessToken: 'AT-1' }))
      await pluginFetch('http://127.0.0.1/x', { method: 'POST', body: CHAT_BODY() })
      ;({ fetch: pluginFetch } = await plugin.auth.loader(async () => astudioAuth({ accessToken: 'AT-2', accountId: 'acc-2' })))
      await pluginFetch('http://127.0.0.1/x', { method: 'POST', body: CHAT_BODY() })
      assert.deepEqual(seen, ['AT-1', 'AT-2'], '每次都用当前槽的凭据')
    } finally {
      channel.chat = original
    }
  })
})

test('loader：账号槽属于别的渠道 → 401（v0.5.0 起没有旁路兜底了）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build({}, { notify: false })
    const { fetch: pluginFetch } = await plugin.auth.loader(async () => ({
      // magicrew 是另一个供应商的账号 —— 本实例是 astudio，绝不能用它
      type: 'oauth', channel: 'magicrew', access_token: 'OTHER',
    }))
    const response = await pluginFetch('http://127.0.0.1/x', { method: 'POST', body: CHAT_BODY() })
    // ⚠️ 关键规则：别的渠道的凭据**不许**拿来用（旧版会掉进旁路兜底把别人的 token 发出去）
    assert.equal(response.status, 401, '别的渠道的凭据不能顶用')
    const payload = await response.json()
    assert.match(payload.error.message, /未登录/)
  })
})

test('loader：无账号也无内存凭据 → 401 + 明确未登录文案（不炸会话）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build({}, { notify: false })
    const { fetch: pluginFetch } = await plugin.auth.loader(async () => undefined)
    const response = await pluginFetch('http://127.0.0.1/x', { method: 'POST', body: CHAT_BODY() })
    assert.equal(response.status, 401)
    const payload = await response.json()
    assert.match(payload.error.message, /未登录/)
  })
})

// ── refresh：按 auth.channel 分发 ─────────────────────────────────────────

test('refresh：别的渠道的 auth → undefined（不动登录）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build({}, { notify: false })
    const next = await plugin.auth.refresh({ type: 'oauth', channel: 'magicrew', access_token: 'X' })
    assert.equal(next, undefined)
  })
})

test('refresh：astudio 无 refresh_token → undefined（不假装能续期）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build({}, { notify: false })
    // astudio 的凭据字段是 accessToken（identityOf 只认 refreshToken/refresh_token/access/access_token）
    const next = await plugin.auth.refresh(astudioAuth())
    assert.equal(next, undefined, 'identityOf 为空 → 不碰 magpie 的登录')
  })
})

test('refresh：accio 有 access_token → 走渠道续期，结果回给 magpie 保存', async () => {
  await isolated(async ({ build, mod }) => {
    const channel = mod.REGISTERED_CHANNELS.find((c) => c.id === 'accio')
    const original = channel.refresh
    channel.refresh = async (bare) => ({ ...bare, access_token: 'NEW-TOKEN' })
    try {
      // ⚠️ 必须建 **accio** 实例：build 默认是 astudio，stub 的却是 accio 的 channel
      const plugin = await build({}, { notify: false }, 'accio')
      const next = await plugin.auth.refresh({
        type: 'oauth', channel: 'accio', access_token: 'OLD', refresh_token: 'RT-1',
      })
      assert.equal(next.access_token, 'NEW-TOKEN')
      assert.equal(next.channel, 'accio', 'channel 字段不能丢（丢了下次分发就错了）')
    } finally {
      channel.refresh = original
    }
  })
})

test('refresh：同一凭据并发只续一次（去重闸按凭据身份键控）', async () => {
  await isolated(async ({ build, mod }) => {
    const channel = mod.REGISTERED_CHANNELS.find((c) => c.id === 'accio')
    let calls = 0
    const original = channel.refresh
    channel.refresh = async (bare) => {
      calls += 1
      await new Promise((r) => setTimeout(r, 30))
      return { ...bare, access_token: 'NEW' }
    }
    try {
      const plugin = await build({}, { notify: false }, 'accio')
      const auth = { type: 'oauth', channel: 'accio', access_token: 'OLD', refresh_token: 'RT-SAME' }
      const results = await Promise.all([
        plugin.auth.refresh({ ...auth }),
        plugin.auth.refresh({ ...auth }),
        plugin.auth.refresh({ ...auth }),
      ])
      assert.equal(calls, 1, '同一 refresh_token 的并发续期必须共享一次在途请求（否则第二个去消费已作废的 token）')
      assert.ok(results.every((r) => r?.access_token === 'NEW'))
    } finally {
      channel.refresh = original
    }
  })
})

// ── checkin：按账号槽分发 ────────────────────────────────────────────────

test('checkin 按账号槽的渠道分发（本渠道才签）', async () => {
  await isolated(async ({ build, mod }) => {
    const channel = mod.REGISTERED_CHANNELS.find((c) => c.id === 'lobsterai')
    const original = channel.checkin
    channel.checkin = async () => ({ outcome: 'claimed', credit: 30, message: 'ok' })
    try {
      // ⚠️ 建 lobsterai 实例（build 默认 astudio）
      const plugin = await build({}, { notify: false }, 'lobsterai')
      const own = await plugin.auth.checkin(async () => ({ type: 'success', channel: 'lobsterai', access_token: 'T' }))
      assert.equal(own.outcome, 'claimed')
      assert.equal(own.credit, 30)
    } finally {
      channel.checkin = original
    }
  })
})

test('无凭据 → 签到报 inactive（不把卡片涂红）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build({}, { notify: false })
    const outcome = await plugin.auth.checkin(async () => undefined)
    assert.equal(outcome.outcome, 'inactive')
    assert.match(outcome.message, /未登录/)
  })
})

// ── 登录：新账号 / 重复 ──────────────────────────────────────────────────

/** 建一个 login 流程已打桩的插件（stub channel.beginLogin）。 */
const loginHarness = async ({ mod, client, accountId = 'A' }) => {
  const channel = mod.REGISTERED_CHANNELS.find((c) => c.id === 'astudio')
  const original = channel.beginLogin
  channel.beginLogin = async () => ({
    url: 'https://auth.example/authorize',
    instructions: '在浏览器里完成登录',
    result: Promise.resolve({
      accessToken: 'AT-NEW',
      ssoSessionId: 'sso',
      // ⚠️ resolveAccountId 优先用 nickname，没有才退回渠道显示名 ——
      //    要让「重复登录」命中预置槽，mock 必须带 nickname
      nickname: accountId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
  })
  const plugin = await mod.makeHubPlugin(channel)({ client }, { notify: false })
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, channel, restore: () => { channel.beginLogin = original } }
}

test('登录新账号 → toast「登录成功（新增账号）」', async () => {
  await isolated(async ({ mod }) => {
    const t = toastClient()
    const h = await loginHarness({ mod, client: t.client, accountId: '新账号' })
    try {
      const handle = await h.plugin.auth.methods[0].authorize()
      await handle.callback()
      await new Promise((r) => setTimeout(r, 50))
      assert.ok(t.toasts.some((m) => /登录成功/.test(m)), `应弹登录成功，实际：${t.toasts.join(' | ')}`)
      assert.ok(t.saved.length >= 1, '凭据要交给 magpie 账号槽（client.auth.set）')
      assert.equal(t.saved[0].body.type, 'success')
      assert.equal(t.saved[0].body.channel, 'astudio')
    } finally {
      h.restore()
    }
  })
})

test('重复登录一个仍未过期的账号 → toast「账号重复」且不覆盖原槽', async () => {
  await isolated(async ({ mod, sandbox }) => {
    const t = toastClient()
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(sandbox, '.config', 'magpie'), { recursive: true })
    writeFileSync(process.env.DSH_HUB_AUTH_PATH, JSON.stringify({
      'hub-astudio': {
        type: 'success', channel: 'astudio', accountId: 'A',
        accessToken: 'AT-OLD', expires: Date.now() + 3600_000,
      },
    }), 'utf8')
    const h = await loginHarness({ mod, client: t.client, accountId: 'A' })
    try {
      const handle = await h.plugin.auth.methods[0].authorize()
      await handle.callback()
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(t.saved.length, 0, '未过期的重复登录不该覆盖原槽')
      assert.ok(t.toasts.some((m) => /账号重复/.test(m)), `应提示账号重复，实际：${t.toasts.join(' | ')}`)
    } finally {
      h.restore()
    }
  })
})

test('登录回调把 auth 交给 magpie 的 client.auth.set（账号槽为唯一落盘处）', async () => {
  await isolated(async ({ mod }) => {
    const t = toastClient()
    const h = await loginHarness({ mod, client: t.client, accountId: 'B' })
    try {
      const handle = await h.plugin.auth.methods[0].authorize()
      const auth = await handle.callback()
      assert.equal(auth.type, 'success')
      assert.equal(auth.channel, 'astudio')
      assert.equal(auth.accountId, 'B')
      assert.equal(t.saved.length, 1)
      assert.equal(t.saved[0].path.id, 'hub-astudio', '写的是本供应商的槽')
      assert.equal(auth.accessToken, 'AT-NEW')
    } finally {
      h.restore()
    }
  })
})

// ── authorize 契约：立刻返回 ──────────────────────────────────────────────

test('authorize 立刻返回（不 await 用户登录 → 不会双向死锁）', async () => {
  await isolated(async ({ mod }) => {
    const t = toastClient()
    const h = await loginHarness({ mod, client: t.client })
    try {
      const started = Date.now()
      const handle = await h.plugin.auth.methods[0].authorize()
      assert.ok(Date.now() - started < 2_000, 'authorize 不得等用户完成登录')
      assert.equal(typeof handle.url, 'string')
      assert.equal(handle.method, 'auto')
      assert.equal(typeof handle.callback, 'function')
    } finally {
      h.restore()
    }
  })
})
