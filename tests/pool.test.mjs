// 账号池（凭据进 magpie 账号槽）的行为契约。
//
// 核心主张：一个供应商、多渠、多账号 —— getAuth 的账号槽决定用哪份凭据；
// 旁路文件只做兜底；去重闸按凭据身份（refresh_token）键控，多账号不串号。
//
// ⚠️ 状态隔离：**每个用例**独立 HOME + 全新聚合层模块实例（URL 加查询串
// 绕过 ESM 缓存）。shared.mjs 的目录已改惰性求值，新 HOME 才真正生效；
// 聚合层的旁路内存缓存是模块级的，不换实例会跨用例泄漏。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'

const originalHome = process.env.USERPROFILE

/** 合法的 DPoP P-256 私钥（officeace 续期路径会 importKey+签名，随手编的 JWK 在 importKey 就炸）。 */
const dpopJwk = await webcrypto.subtle
  .generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  .then((k) => webcrypto.subtle.exportKey('jwk', k.privateKey))

let seq = 0
/**
 * 独立沙箱里构建插件：新 HOME → 全新 aggregate 实例 → build 完成后回调。
 * 用完清理沙箱并还原 HOME。
 */
async function isolated(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-pool-'))
  process.env.USERPROFILE = sandbox
  process.env.HOME = sandbox
  const q = `?v=${++seq}-${Date.now()}`
  const url = pathToFileURL(join(import.meta.dirname, '..', 'src', 'aggregate.mjs')).href + q
  try {
    const mod = await import(url)
    const build = async (input = {}, options = {}) => {
      const plugin = await mod.DshProvidersHubPlugin(input, options)
      const cfg = {}
      await plugin.config(cfg)
      return plugin
    }
    return await fn({ build, mod, sandbox })
  } finally {
    process.env.USERPROFILE = originalHome
    process.env.HOME = originalHome
    rmSync(sandbox, { recursive: true, force: true })
  }
}

test.after = () => {
  // aftereach 由 isolated 自己还原；此处兜底（最后一个用例异常退出时）
}

/** 构造一个 officeace 账号的 auth（magpie 存储形态：type:'oauth' + channel）。 */
const officeaceAuth = (over = {}) => ({
  type: 'oauth',
  channel: 'officeace',
  access: 'AK', secret: 'SK', securityToken: 'ST', projectId: '',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'RT-1',
  dpopPrivateJwk: dpopJwk,
  modelAppKey: 'key-1', modelAppSecret: 'sec-1',
  modelApiUrlBase: 'gw.example.com',
  ...over,
})

/** officeace auth → 裸凭据（写旁路文件用）。 */
const bareOf = (auth) => {
  const { type, channel, expires, accountId, ...bare } = auth
  return bare
}

const CHAT_BODY = (model = 'officeace/glm-5.3') => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })

/** 拦全局 fetch；记录每次调用（officeace 的头是普通对象，直接读属性）。 */
const stubFetch = (respond) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    return respond ? respond({ url, init, calls }) : new Response('{"choices":[]}', { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 到期时刻解析（纯函数）───────────────────────────────────────────────

test('expiresMsOf：officeace ISO 串 / minimaxintl 毫秒串 / accio 毫秒数字 / 秒级兼容', async () => {
  await isolated(async ({ mod }) => {
    const { expiresMsOf } = mod
    assert.equal(expiresMsOf({ expiresAt: '2026-10-25T12:00:00Z' }), Date.parse('2026-10-25T12:00:00Z'))
    assert.ok(expiresMsOf({ expires_at: String(Date.now() + 3600_000) }) > Date.now())
    assert.ok(expiresMsOf({ expires_at: Date.now() + 3600_000 }) > Date.now())
    assert.ok(expiresMsOf({ expires_at: String(Math.floor((Date.now() + 3600_000) / 1000)) }) > Date.now(), '秒级数字串要 ×1000')
    assert.equal(expiresMsOf({ fake: true }), undefined, 'astudio 无到期字段 → undefined')
  })
})

// ── loader：按账号槽取凭据 ───────────────────────────────────────────────

test('loader 用 getAuth 账号的凭据（同渠道多账号 = magpie 换槽即换号）', async () => {
  await isolated(async ({ build }) => {
    const stub = stubFetch()
    try {
      const plugin = await build()
      const { fetch: pluginFetch } = await plugin.auth.loader(async () => officeaceAuth({ modelAppKey: 'key-ACCOUNT-2', modelAppSecret: 'sec-2' }))
      await pluginFetch('https://x/chat/completions', { method: 'POST', body: CHAT_BODY() })
      assert.equal(stub.calls[0].init.headers.authorization,
        'Basic ' + Buffer.from('key-ACCOUNT-2:sec-2').toString('base64'),
        '发上游的凭据必须来自账号槽（而不是旁路文件里那份）')
    } finally {
      stub.restore()
    }
  })
})

test('loader：账号槽属于别的渠道 → 旁路兜底（多渠供应商轮到别的账号）', async () => {
  await isolated(async ({ build, mod }) => {
    mod // shared 的 saveCredential 经 aggregate 实例链（同沙箱目录）
    const { saveCredential } = await import('../src/shared.mjs')
    saveCredential('officeace', bareOf(officeaceAuth({ modelAppKey: 'key-SIDECAR', modelAppSecret: 'sec-S' })))
    const stub = stubFetch()
    try {
      const plugin = await build()
      const { fetch: pluginFetch } = await plugin.auth.loader(async () => ({
        type: 'oauth', channel: 'minimaxintl', access_token: 'mm', refresh_token: 'mr', expires_at: String(Date.now() + 3600_000),
      }))
      await pluginFetch('https://x/chat/completions', { method: 'POST', body: CHAT_BODY() })
      assert.equal(stub.calls[0].init.headers.authorization,
        'Basic ' + Buffer.from('key-SIDECAR:sec-S').toString('base64'),
        '渠道不匹配时用旁路凭据把请求发出去')
    } finally {
      stub.restore()
    }
  })
})

test('loader：无账号也无旁路 → 401 + 明确未登录文案（不炸会话）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build()
    const { fetch: pluginFetch } = await plugin.auth.loader(async () => undefined)
    const response = await pluginFetch('https://x/chat/completions', { method: 'POST', body: CHAT_BODY() })
    assert.equal(response.status, 401)
    const payload = await response.json()
    assert.match(payload.error.message, /未登录/)
  })
})

// ── refresh：按 auth.channel 分发 + 凭据身份键控 ──────────────────────────

/** STS/validate 双路由 stub（onTokens 回调记录 tokens 请求体，供并发断言）。 */
const stsStub = (map, onTokens) => stubFetch(({ url, init }) => {
  if (url.includes('oauth2/tokens')) {
    onTokens?.(String(init?.body))
    return new Response(JSON.stringify({
      credentials: {
        access_key_id: map.nextAccess(), secret_access_key: 'S', security_token: 'T',
        project_id: '', expiration: new Date(Date.now() + 7200_000).toISOString(),
      },
      refresh_token: map.nextToken(),
    }), { status: 200 })
  }
  if (url.includes('client-permission-validate')) {
    return new Response(JSON.stringify({
      subscription: { model_info: { model_auth_info: { model_app_key: 'k', model_app_secret: 's' }, model_api_url_base: 'gw.example.com' } },
    }), { status: 200 })
  }
  return new Response('{}', { status: 200 })
})

test('refresh 按 auth.channel 分发并返回续期后的 auth（magpie 会保存它）', async () => {
  await isolated(async ({ build, mod }) => {
    const stub = stsStub({ nextAccess: () => 'AK2', nextToken: () => 'RT-2' })
    try {
      const plugin = await build()
      const next = await plugin.auth.refresh(officeaceAuth())
      assert.equal(next.type, 'oauth', '续期结果保持 auth 形状（magpie 原样保存）')
      assert.equal(next.channel, 'officeace', 'channel 字段不能丢（丢了下次分发就错了）')
      assert.equal(next.access, 'AK2')
      assert.equal(next.refreshToken, 'RT-2')
      assert.equal(next.modelAppKey, 'k', 'modelInfo 一并合并')
      // 旁路同步到新凭据（目录/兜底路径靠它）
      const { loadCredential } = await import('../src/shared.mjs')
      assert.equal(loadCredential('officeace').refreshToken, 'RT-2')
      void mod
    } finally {
      stub.restore()
    }
  })
})

test('refresh：同渠道两个账号并发续期不串号（按 refresh_token 键控）', async () => {
  await isolated(async ({ build }) => {
    const bodies = []
    const stub = stsStub({
      nextAccess: () => 'AK-' + (bodies.length + 1),
      nextToken: () => 'RT-' + (bodies.length + 1),
    }, (body) => bodies.push(body))
    try {
      const plugin = await build()
      const [a, b] = await Promise.all([
        plugin.auth.refresh(officeaceAuth({ refreshToken: 'RT-A' })),
        plugin.auth.refresh(officeaceAuth({ refreshToken: 'RT-B' })),
      ])
      assert.equal(bodies.filter((x) => x.includes('RT-A')).length, 1, '账号 A 的 refresh_token 只被消费一次')
      assert.equal(bodies.filter((x) => x.includes('RT-B')).length, 1, '账号 B 的 refresh_token 只被消费一次')
      assert.ok(a.access !== b.access, `两个账号各自拿到自己的续期结果（got ${a.access}/${b.access}）`)
    } finally {
      stub.restore()
    }
  })
})

test('refresh：astudio（无 refresh_token）与未知渠道 → undefined（不动登录）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build()
    assert.equal(await plugin.auth.refresh({ type: 'oauth', channel: 'astudio', accessToken: 'x' }), undefined)
    assert.equal(await plugin.auth.refresh({ type: 'oauth', channel: 'nope' }), undefined)
  })
})

// ── checkin / usage：按账号 ─────────────────────────────────────────────

test('checkin 按账号槽的渠道分发（officeace 账号 → V11 bonus/claim）', async () => {
  await isolated(async ({ build }) => {
    let claimCalls = 0
    const stub = stubFetch(({ url }) => {
      if (url.includes('/v1/subscription/bonus/claim')) {
        claimCalls += 1
        return new Response(JSON.stringify({
          bonus_skus: [{ activity_id: 'daily', activity_name: '每日签到', points: 1000 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    })
    try {
      const plugin = await build()
      const outcome = await plugin.auth.checkin(async () => officeaceAuth())
      assert.equal(claimCalls, 1, '签到请求必须发到该账号渠道的 bonus/claim')
      assert.equal(outcome.outcome, 'claimed')
      assert.equal(outcome.credit, 1000)
    } finally {
      stub.restore()
    }
  })
})

test('usage 按账号槽的渠道出窗口（astudio 账号只出 AStudio 的）', async () => {
  await isolated(async ({ build }) => {
    const stub = stubFetch(() => new Response('{"code":0,"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      const plugin = await build()
      const usage = await plugin.auth.usage(async () => ({ type: 'oauth', channel: 'astudio', accessToken: 'x', ssoSessionId: 's' }))
      assert.equal(usage.windows.length, 1)
      assert.match(usage.windows[0].name, /AStudio/)
    } finally {
      stub.restore()
    }
  })
})

test('无账号上下文 → 旁路口径全渠道扫（迁移前行为保持）', async () => {
  await isolated(async ({ build }) => {
    const plugin = await build()
    const checkin = await plugin.auth.checkin()
    assert.equal(checkin.outcome, 'inactive', '独立沙箱无旁路凭据 → inactive')
    assert.match(checkin.message, /无已登录渠道/)
  })
})

// ── 登录回调写账号槽（saveAuth 透传给 magpie client）─────────────────────

test('登录回调把 auth 交给 magpie 的 client.auth.set（账号槽为主存储）', async () => {
  await isolated(async ({ build }) => {
    const saved = []
    const { officeaceChannel } = await import('../src/officeace.mjs')
    const plugin = await build({ client: { auth: { set: async (call) => { saved.push(call) } } } })
    const stubCred = bareOf(officeaceAuth())
    const originalBegin = officeaceChannel.beginLogin
    officeaceChannel.beginLogin = async () => ({ url: 'https://auth.example', result: Promise.resolve(stubCred) })
    try {
      const method = plugin.auth.methods.find((m) => m.label.includes('OfficeAce'))
      const handle = await method.authorize()
      const outcome = await handle.callback()
      assert.equal(saved.length, 1, 'client.auth.set 必须被调（账号槽存储）')
      assert.equal(saved[0].path.id, 'providers-hub')
      assert.equal(saved[0].body.channel, 'officeace')
      assert.ok(Number.isFinite(saved[0].body.expires), '带 expires（magpie 的到期管理靠它）')
      assert.equal(outcome.channel, 'officeace')
    } finally {
      officeaceChannel.beginLogin = originalBegin
    }
  })
})
