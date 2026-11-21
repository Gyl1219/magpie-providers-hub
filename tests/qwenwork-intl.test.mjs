// 千问办公国际版（qwenwork.ai）渠道测试 —— fetch 全部 mock，不发真实网络请求。
//
// 覆盖：粘贴串解析（三种形态）、PKCE、到期判定、换 token、读身份、目录、
// chat 契约（信封 / 原始 Response / 错误分流）、登录载体的「立刻返回」契约。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-qwenwork-intl-'))
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')

// stubFetch 会替换全局 fetch；本地回环页（127.0.0.1）必须用真 fetch 访问，
// 否则页面与 /paste 请求都会被 stub 吃掉。
const realFetch = globalThis.fetch

/** 上游解包产物（本机存在时才做逐字节对照；不存在则 skip，不伪造通过）。 */
const UPSTREAM_PKG = 'D:/qwenwork-intl/_inspect/package/index.mjs'

const {
  qwenworkIntlChannel,
  fallbackModels,
  FALLBACK_MODEL_IDS,
  createPkce,
  buildAuthorizeUrl,
  parsePasted,
  expired,
  expiresAtMs,
  exchangeCode,
  fetchIdentity,
  refresh,
  catalog,
  chat,
} = await import('../src/qwenwork-intl.mjs')

const { decodeBody, encodeBody, COSY_CHAT_PATH, COSY_MODELS_PATH } = await import('../src/qwenwork-intl-cosy.mjs')

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * 一份「COSY 齐全」的凭据：`access_token` + `uid` + `machineId`。
 * 后两个只在登录时拿得到（签名要 `Cosy-User` 与设备身份），缺一个就打不了 /algo 路由。
 */
const CRED = { access_token: 'AT-1', uid: 'u-1', machineId: 'mid-1' }

/** 记录调用的 fetch stub（不碰网络）。 */
const stubFetch = (respond) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // 本地回环（登录页 / paste / status）必须走真 fetch，否则页面内容断言会被 stub 吃掉
    if (/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init)
    calls.push({ url, init, body: init?.body })
    return respond({ url, init })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── PKCE / 授权 URL ──────────────────────────────────────────────────────

test('PKCE：verifier 86 字符（b64url(randomBytes(64))，同上游）、challenge = base64url(sha256(verifier))', () => {
  const { verifier, challenge } = createPkce()
  assert.equal(verifier.length, 86, '上游 intlSignIn 是 b64url(randomBytes(64))')
  assert.ok(verifier.length >= 43 && verifier.length <= 128, 'Ory 要求 43~128')
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.ok(!/[+/=]/.test(challenge), '必须 base64url（无 + / =）')
})

test('授权 URL：client/redirect/scope/PKCE 齐全，且 redirect 是网关那条唯一的', () => {
  const { challenge } = createPkce()
  const url = new URL(buildAuthorizeUrl({ state: 'a'.repeat(32), challenge }))
  assert.equal(url.origin, 'https://qwenwork.ai')
  assert.equal(url.pathname, '/oauth2/auth')
  const q = url.searchParams
  assert.equal(q.get('client_id'), 'qwenwork-desktop-app')
  assert.equal(q.get('redirect_uri'), 'https://gateway.qwenwork.ai/oauth/callback', '环回回调会被 Ory 拒')
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('code_challenge'), challenge)
  assert.match(q.get('scope') ?? '', /offline_access/, '要 refresh_token 必须带 offline_access')
  assert.ok((q.get('state') ?? '').length >= 32, 'Ory 拒短 state')
  // 上游 state/nonce 都是 randomUUID()
  assert.match(q.get('nonce') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})

// ── 粘贴串解析 ───────────────────────────────────────────────────────────

test('粘贴解析：qwenwork:// 深链 / https 回调 / 裸 code 三种形态都认', () => {
  const deep = parsePasted('qwenwork://oauth/callback?code=ABC123xyz&state=deadbeef')
  assert.equal(deep.code, 'ABC123xyz')
  assert.equal(deep.state, 'deadbeef')

  const https = parsePasted('https://gateway.qwenwork.ai/oauth/callback?code=XYZ789&state=cafe')
  assert.equal(https.code, 'XYZ789')
  assert.equal(https.state, 'cafe')

  const bare = parsePasted('  AbCdEf123456  ')
  assert.equal(bare.code, 'AbCdEf123456', '裸 code 直接当 code')
})

test('粘贴解析：Ory 报错形态 / 空输入 / 说明文字 → 明确的中文原因', () => {
  const rejected = parsePasted('https://gateway.qwenwork.ai/oauth/callback?error=access_denied&error_description=user+denied')
  assert.match(rejected.error, /access_denied/)
  assert.match(rejected.error, /user denied/)
  assert.match(parsePasted('').error, /为空/)
  assert.match(parsePasted('请把地址栏复制过来').error, /没有找到 \?code/)
  assert.match(parsePasted('https://x/cb?state=only').error, /没有 code/)
})

// ── 到期判定 ─────────────────────────────────────────────────────────────

test('到期：日期字符串走 Date.parse（不能 Number）；未知当可用', () => {
  assert.equal(expired({}), false, '无到期字段 = 未知 ≠ 已过期')
  assert.equal(expired({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }), false)
  assert.equal(expired({ expires_at: new Date(Date.now() - 3_600_000).toISOString() }), true)
  // 临期提前量 10 分钟
  assert.equal(expired({ expires_at: Date.now() + 60_000 }), true, '10 分钟内到期视为临期')
  // 秒级数字
  assert.equal(expiresAtMs({ expires_at: 1_800_000_000 }), 1_800_000_000_000, '秒 → 毫秒')
  assert.equal(expiresAtMs({ expires_at: '1800000000000' }), 1_800_000_000_000, '毫秒数字串')
  assert.equal(expiresAtMs({ expires_at: '不是日期' }), undefined)
})

// ── 换 token ─────────────────────────────────────────────────────────────

test('换 token：form 编码 + 四个必填参数；expires_in 换成绝对毫秒', async () => {
  const stub = stubFetch(() => json({
    access_token: 'AT-1', refresh_token: 'RT-1', id_token: 'ID-1',
    token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access',
  }))
  try {
    const out = await exchangeCode({ code: 'CODE1', verifier: 'V'.repeat(43) })
    assert.equal(out.ok, true)
    assert.equal(out.token.access_token, 'AT-1')
    assert.equal(out.token.refresh_token, 'RT-1')
    assert.ok(out.token.expires_at > Date.now() + 3_500_000, 'expires_in 必须换成绝对时刻')

    const sent = stub.calls[0]
    assert.equal(sent.url, 'https://qwenwork.ai/auth/oauth/token', '不是 /oauth2/token（404）')
    assert.equal(sent.init.method, 'POST')
    assert.match(String(sent.init.headers['content-type']), /x-www-form-urlencoded/)
    const form = new URLSearchParams(String(sent.body))
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'CODE1')
    assert.equal(form.get('code_verifier'), 'V'.repeat(43))
    assert.equal(form.get('redirect_uri'), 'https://gateway.qwenwork.ai/oauth/callback')
    assert.equal(form.get('client_id'), 'qwenwork-desktop-app')
  } finally { stub.restore() }
})

test('换 token 失败：错误体里取原因，不抛；缺 access_token 也算失败', async () => {
  const rejected = stubFetch(() => json({ error: 'invalid_grant', error_description: 'code expired' }, 400))
  try {
    const out = await exchangeCode({ code: 'BAD', verifier: 'V'.repeat(43) })
    assert.equal(out.ok, false)
    assert.match(out.error, /invalid_grant/)
    assert.match(out.error, /code expired/)
  } finally { rejected.restore() }

  const empty = stubFetch(() => json({ token_type: 'Bearer' }))
  try {
    const out = await exchangeCode({ code: 'X', verifier: 'V'.repeat(43) })
    assert.equal(out.ok, false)
    assert.match(out.error, /没有 access_token/)
  } finally { empty.restore() }
})

// ── 续期 ─────────────────────────────────────────────────────────────────

test('续期：refresh 走标准 OAuth（qwenwork.ai/auth/oauth/token）+ RT 轮换写回；/user/info 也打 qwenwork.ai', async () => {
  const persisted = []
  const stub = stubFetch(({ url }) => {
    if (url === 'https://qwenwork.ai/auth/oauth/token') {
      return json({
        access_token: 'AT-2', refresh_token: 'RT-2', token_type: 'Bearer',
        expires_in: 3600, scope: 'openid offline_access',
      })
    }
    if (url === 'https://qwenwork.ai/user/info') return json({ preferred_username: 'wangwu' })
    return new Response(`unexpected ${url}`, { status: 500 })
  })
  try {
    const credential = {
      access_token: 'AT-1', refresh_token: 'RT-1',
      channel: 'qwenwork-intl', machineId: 'mid-1',
    }
    const next = await refresh(credential, (c) => persisted.push(c))

    const sent = stub.calls[0]
    assert.equal(sent.url, 'https://qwenwork.ai/auth/oauth/token', '标准 issuer 端点，不是网关')
    assert.equal(sent.init.method, 'POST')
    assert.match(String(sent.init.headers['content-type']), /x-www-form-urlencoded/)
    assert.match(String(sent.init.headers.accept), /application\/json/)
    const form = new URLSearchParams(String(sent.body))
    assert.equal(form.get('grant_type'), 'refresh_token')
    assert.equal(form.get('refresh_token'), 'RT-1')
    assert.equal(form.get('client_id'), 'qwenwork-desktop-app')

    assert.equal(next.access_token, 'AT-2')
    assert.equal(next.refresh_token, 'RT-2', 'RT 轮换后必须换成新的')
    assert.equal(next.channel, 'qwenwork-intl', '凭据上的其它字段要留着')
    assert.equal(next.machineId, 'mid-1')
    assert.ok(next.expires_at > Date.now() + 3_500_000, 'expires_in 换成绝对毫秒')
    assert.equal(persisted.length, 1, 'RT 轮换要立刻写回（并发入口不能拿旧 RT）')
    assert.equal(persisted[0].refresh_token, 'RT-2')

    // 身份接口同样在 issuer 上（与 token 端点同一个 host）
    const identity = await fetchIdentity(next.access_token)
    assert.equal(identity.ok, true)
    assert.equal(identity.identity.nickname, 'wangwu')
    const info = stub.calls.at(-1)
    assert.equal(info.url, 'https://qwenwork.ai/user/info')
    assert.equal(info.init.headers.authorization, 'Bearer AT-2')
  } finally { stub.restore() }

  // 没有 RT → 明确报错（不是静默返回旧凭据）
  await assert.rejects(() => refresh({ access_token: 'AT-1' }), /没有 refresh_token/)

  // 上游拒绝 → 抛带原因的错误，且不写回（不能把坏凭据持久化）
  const rejected = stubFetch(() => json({ error: 'invalid_grant', error_description: 'refresh expired' }, 400))
  const writes = []
  try {
    await assert.rejects(
      () => refresh({ access_token: 'AT-1', refresh_token: 'RT-OLD' }, (c) => writes.push(c)),
      (error) => {
        assert.match(error.message, /续期被拒/)
        assert.match(error.message, /HTTP 400/)
        assert.match(error.message, /refresh expired/)
        return true
      },
    )
    assert.equal(writes.length, 0)
    assert.equal(rejected.calls.length, 1)
  } finally { rejected.restore() }
})

// ── 身份 ─────────────────────────────────────────────────────────────────

test('身份：优先 name → preferred_username → nickname；email/sub 单独取', async () => {
  const stub = stubFetch(() => json({ preferred_username: 'alice', email: 'a@example.com', sub: 'sub-1' }))
  try {
    const out = await fetchIdentity('AT-1')
    assert.equal(out.ok, true)
    assert.equal(out.identity.nickname, 'alice', 'name 缺失时退到 preferred_username')
    assert.equal(out.identity.email, 'a@example.com')
    assert.equal(out.identity.subject, 'sub-1')
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer AT-1')
  } finally { stub.restore() }

  // 什么 claim 都没有 → 空对象（聚合层退化成渠道显示名，不编）
  const bare = stubFetch(() => json({}))
  try {
    const out = await fetchIdentity('AT-1')
    assert.deepEqual(out.identity, {})
  } finally { bare.restore() }
})

test('身份读失败：不影响登录（ok:false 但不抛）', async () => {
  const stub = stubFetch(() => new Response('nope', { status: 500 }))
  try {
    const out = await fetchIdentity('AT-1')
    assert.equal(out.ok, false)
    assert.match(out.error, /HTTP 500/)
  } finally { stub.restore() }
})

// ── 目录 ─────────────────────────────────────────────────────────────────

test('目录：走 /algo + COSY 签名（GET 的签名 body 是空串），认 OpenAI 形状与 models 形状', async () => {
  const openai = stubFetch(() => json({
    object: 'list',
    data: [
      { id: 'qwen3-coder-plus', display_name: 'Qwen3 Coder Plus', context_length: 262144, max_output_tokens: 65536 },
      { id: 'glm-5', context_window: 200000 },
      { id: '' },
      null,
    ],
  }))
  try {
    const models = await catalog(CRED)
    const sent = openai.calls[0]
    assert.equal(sent.url, 'https://openapi.qoder.sh/algo/api/v2/model/list?Encode=1',
      '目录真实路由是 /algo/api/v2/model/list?Encode=1')
    assert.equal(sent.init.method ?? 'GET', 'GET')
    assert.equal(sent.body, undefined, 'GET 不带请求体')
    assert.equal(sent.init.headers['Cosy-User'], 'u-1', 'Cosy-User 必须与 token 同属一人')
    assert.equal(sent.init.headers['Cosy-MachineId'], 'mid-1')
    assert.match(sent.init.headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
    assert.equal(sent.init.headers.authorization, undefined, '/algo 路由不认普通 Bearer')
    // 签名覆盖空串 body 与剥掉 /algo 的 path —— 用这个头自己的 Cosy-Key 复现
    const [, payload, sig] = sent.init.headers.Authorization.split('.')
    assert.equal(sig, createHash('md5').update(
      `${payload}\n${sent.init.headers['Cosy-Key']}\n${sent.init.headers['Cosy-Date']}\n\n/api/v2/model/list`,
    ).digest('hex'), 'GET 的签名 body 是空串')

    assert.equal(models['qwen3-coder-plus'].name, 'Qwen3 Coder Plus')
    assert.equal(models['qwen3-coder-plus'].limit.context, 262144)
    assert.equal(models['qwen3-coder-plus'].limit.output, 65536)
    assert.equal(models['glm-5'].limit.context, 200000, 'context_window 别名也要认')
    assert.equal(models['glm-5'].name, 'glm-5', '没有 display_name 就用 id')
    assert.equal(models['glm-5'].limit.output, undefined, '没给就不写（不编 8192）')
    assert.equal('' in models, false, '空 id 不入目录')
  } finally { openai.restore() }
})

test('目录：401 / 形状认不出 → 退回兜底表（上游 QWENWORK_MODELS 三条，不编新 id）', async () => {
  const expected = [...FALLBACK_MODEL_IDS].sort()
  const [first, second, third] = FALLBACK_MODEL_IDS
  for (const respond of [() => new Response('no', { status: 401 }), () => json({ unknown: true })]) {
    const stub = stubFetch(respond)
    try {
      const models = await catalog(CRED)
      assert.deepEqual(Object.keys(models).sort(), expected)
      assert.equal(models[second].name, '高级', '档位键要给中文显示名')
      assert.equal(models[third].name, 'Qwen3.8-Max')
      assert.equal(models[first].limit.context, 131072)
    } finally { stub.restore() }
  }
})

test('目录：缺 uid/machineId 的凭据不打请求，直接兜底（打了也是 401，白挨一次）', async () => {
  for (const credential of [
    { access_token: 'AT-1', uid: 'u-1' },
    { access_token: 'AT-1', machineId: 'mid-1' },
    {},
  ]) {
    const stub = stubFetch(() => json({ object: 'list', data: [{ id: 'x' }] }))
    try {
      const models = await catalog(credential)
      // 期望值从常量算：这里再抄一遍 id 字面量，等于给自己留一次漂移机会
      assert.deepEqual(Object.keys(models).sort(), [...FALLBACK_MODEL_IDS].sort(), JSON.stringify(credential))
      assert.equal(stub.calls.length, 0, '没有 COSY 身份就不要发请求')
    } finally { stub.restore() }
  }
})

test('目录：服务端回编码串（Encode=1）也能解出条目', async () => {
  const plain = JSON.stringify({ chat: { models: [{ key: 'enc-1', display_name: '编码回来的' }] } })
  // 用同一套 COSY 字母表编成上线形态，模拟服务端 Encode=1 的真实返回
  const wire = encodeBody(plain)
  assert.notEqual(wire, plain)
  const stub = stubFetch(() => new Response(wire, { status: 200, headers: { 'content-type': 'text/plain' } }))
  try {
    const models = await catalog(CRED)
    assert.deepEqual(Object.keys(models), ['enc-1'])
    assert.equal(models['enc-1'].name, '编码回来的')
  } finally { stub.restore() }
})

test('目录：真机的分组形状（chat/assistant/qwork/…）也能拆出条目，byok 组跳过', async () => {
  // 形状取自匿名签名探针对 `model/list` 的实测响应（分组，每组里才是条目）
  const stub = stubFetch(() => json({
    chat: {
      models: [
        { key: 'auto', display_name: '自动', is_default: true, context_config: { max_input_tokens: 262144 } },
        { key: 'qwen3.8-max', display_name: 'Qwen3.8-Max', is_reasoning: true, max_input_tokens: 131072 },
      ],
    },
    qwork: { items: [{ key: 'qwork-pro', display_name: '办公高级', context_config: { max_input_tokens: 65536, max_output_tokens: 16384 } }] },
    qcode: [{ key: 'qcode-coder', display_name: '代码' }],
    assistant: { list: [] },
    byok_teams: { models: [{ key: 'byok-x', display_name: '自带 Key' }] },
  }))
  try {
    const models = await catalog(CRED)
    assert.deepEqual(Object.keys(models).sort(), ['auto', 'qcode-coder', 'qwen3.8-max', 'qwork-pro'],
      '三组条目的 key 都进目录；空组与 byok_* 组不进')
    assert.equal(models.auto.name, '自动', 'display_name 优先')
    assert.equal(models.auto.limit.context, 262144, 'context_config.max_input_tokens 要认')
    assert.equal(models['qwen3.8-max'].limit.context, 131072, '顶层 max_input_tokens 也要认')
    assert.equal(models['qwork-pro'].limit.output, 16384, 'context_config.max_output_tokens 要认')
    assert.equal('byok-x' in models, false, 'byok 组要用用户自己的 key，列出来只会 400')
  } finally { stub.restore() }
})

test('目录：空的分组（每组都没条目）→ 退回兜底表，不返回空目录', async () => {
  const stub = stubFetch(() => json({ chat: { models: [] }, assistant: [] }))
  try {
    // 这张表要带 uid/machineId：目录已迁 /algo，缺 COSY 身份就不发请求（见上一条用例）
    const models = await catalog(CRED)
    // 期望按同一常量算排序值（两边同时 sort），不在这里手写任何 id 字面量
    assert.deepEqual(Object.keys(models).sort(), [...FALLBACK_MODEL_IDS].sort())
  } finally { stub.restore() }
})

test('身份：`{data:{user:{…}}}` 嵌套形状也能剥（上游 normalizeUser 同款）', async () => {
  const stub = stubFetch(() => json({
    data: { user: { id: 'uid-9', name: '李四', email: 'l@example.com' } },
  }))
  try {
    const out = await fetchIdentity('AT-1')
    assert.equal(out.ok, true)
    assert.equal(out.identity.nickname, '李四')
    assert.equal(out.identity.email, 'l@example.com')
    assert.equal(out.identity.subject, 'uid-9', '业务 id 进 subject（上游拿不到 uid 就报错）')
  } finally { stub.restore() }
})

// ── chat 契约（AGENTS §5）─────────────────────────────────────────────────

test('chat：走 /algo/**/agent_chat_generation + COSY 签名、body 是上线编码形态、返回原始 Response', async () => {
  const stub = stubFetch(() => new Response('data: {"choices":[]}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))
  const body = { model: 'qwen3-coder-plus', stream: true, messages: [{ role: 'user', content: 'hi' }] }
  try {
    const res = await chat(CRED, { body, signal: undefined, renew: () => {} })
    assert.ok(res instanceof Response)
    assert.equal(res.status, 200)

    const sent = stub.calls[0]
    assert.equal(sent.url, `https://openapi.qoder.sh${COSY_CHAT_PATH}`,
      '对话真实路由是 /algo/api/v2/service/pro/sse/agent_chat_generation')
    assert.equal(sent.init.method, 'POST')
    // 请求体不是明文 JSON：是 encodeBody(JSON) 的上线形态，且能解回原样
    assert.notEqual(sent.body, JSON.stringify(body))
    assert.equal(decodeBody(String(sent.body)), JSON.stringify(body), 'body 必须能被 COSY 字母表解回原 JSON')
    const payload = JSON.parse(decodeBody(String(sent.body)))
    assert.equal(payload.model, 'qwen3-coder-plus')
    assert.ok(!('renew' in payload) && !('signal' in payload), '信封键不外泄')

    assert.equal(sent.init.headers.authorization, undefined, '/algo 路由不认普通 Bearer')
    assert.match(sent.init.headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
    assert.equal(sent.init.headers['Cosy-User'], 'u-1')
    assert.equal(sent.init.headers.Accept, 'text/event-stream')
    assert.equal(sent.init.headers['X-Model-Key'], 'qwen3-coder-plus', '对话要带模型来源键')
    assert.equal('Cosy-ClientIp' in sent.init.headers, false, '对话不发 ClientIp')
    // 签名覆盖**上线形态**的 body（不是明文 JSON）与剥掉 /algo 的 path
    const [, sealed, sig] = sent.init.headers.Authorization.split('.')
    assert.equal(sig, createHash('md5').update(
      `${sealed}\n${sent.init.headers['Cosy-Key']}\n${sent.init.headers['Cosy-Date']}\n${sent.body}\n/api/v2/service/pro/sse/agent_chat_generation`,
    ).digest('hex'), '签名必须签 encodeBody 之后的串')
    assert.equal(sent.init.signal, undefined, '没给 signal 不得自造超时')
  } finally { stub.restore() }
})

test('chat：非流式也要编码 body，accept 跟着 stream 走', async () => {
  const stub = stubFetch(() => json({ choices: [] }))
  try {
    await chat(CRED, { body: { model: 'pro', messages: [] } })
    const sent = stub.calls[0]
    assert.equal(sent.init.headers.Accept, 'application/json')
    assert.equal(JSON.parse(decodeBody(String(sent.body))).model, 'pro')
  } finally { stub.restore() }
})

test('chat：缺 uid/machineId → 401 + 摘号（签名造不出来，让用户重登）', async () => {
  for (const credential of [
    { access_token: 'AT-1', uid: 'u-1' },
    { access_token: 'AT-1', machineId: 'mid-1' },
  ]) {
    const stub = stubFetch(() => new Response('should not be called', { status: 200 }))
    try {
      const res = await chat(credential, { body: { model: 'm', messages: [] } })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
      assert.match((await res.json()).error.message, /重新登录/)
      assert.equal(stub.calls.length, 0, '造不出签名就不要发请求（发了必 403 Signature invalid）')
    } finally { stub.restore() }
  }
})

test('chat：signal 原样透传（不挂硬超时）', async () => {
  const stub = stubFetch(() => new Response('ok', { status: 200 }))
  const controller = new AbortController()
  try {
    await chat(CRED, { body: { model: 'm', messages: [] }, signal: controller.signal })
    assert.equal(stub.calls[0].init.signal, controller.signal)
  } finally { stub.restore() }
})

test('chat 错误分流：401 摘号 / 402·429 原样换号 / 500 兜成 502', async () => {
  const cases = [
    [401, 401, 'expired'],
    [403, 401, 'expired'],
    [402, 402, undefined],
    [429, 429, undefined],
    [500, 500, undefined],
  ]
  for (const [upstream, expected, signIn] of cases) {
    const stub = stubFetch(() => new Response('upstream says no', { status: upstream }))
    try {
      const res = await chat(CRED, { body: { model: 'm', messages: [] } })
      assert.equal(res.status, expected, `上游 ${upstream} 应映射成 ${expected}`)
      assert.equal(res.headers.get('x-magpie-sign-in') ?? undefined, signIn, `上游 ${upstream} 的摘号头`)
      const body = await res.json()
      assert.equal(body.error.type, 'provider_error')
    } finally { stub.restore() }
  }
})

test('chat：403 Signature invalid 不摘号（是签名错，不是登录态），转 502 upstream_error', async () => {
  const stub = stubFetch(() => json({ code: '101', message: 'Signature invalid' }, 403))
  try {
    const res = await chat(CRED, { body: { model: 'm', messages: [] } })
    assert.equal(res.status, 502, '签名错是我们这边的问题，不是账号问题')
    assert.equal(res.headers.get('x-magpie-sign-in'), null, '摘号会让用户白重登一次也没用')
    const body = await res.json()
    assert.equal(body.error.type, 'upstream_error')
    assert.equal(body.error.code, 'signature_invalid')
    assert.match(body.error.message, /换账号与重登都无效/)
  } finally { stub.restore() }

  // 普通 403（不是签名错）仍按登录态处理
  const plain = stubFetch(() => new Response('forbidden by policy', { status: 403 }))
  try {
    const res = await chat(CRED, { body: { model: 'm', messages: [] } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
  } finally { plain.restore() }
})

test('chat：未登录 → 401 + 摘号头；请求体缺失 → 400（都不抛）', async () => {
  const anon = await chat({}, { body: { model: 'm' } })
  assert.equal(anon.status, 401)
  assert.equal(anon.headers.get('x-magpie-sign-in'), 'expired')

  const noBody = await chat(CRED, {})
  assert.equal(noBody.status, 400)
  assert.match((await noBody.json()).error.message, /请求体缺失/)
})

test('chat 非 2xx 分流：其余 4xx/5xx 一律 provider_error，状态码保留、绝不带摘号头', async () => {
  const cases = [400, 404, 409, 422, 500, 502, 503]
  for (const upstream of cases) {
    const stub = stubFetch(() => new Response(`upstream ${upstream}`, { status: upstream }))
    try {
      const res = await chat(CRED, { body: { model: 'm', messages: [] } })
      assert.equal(res.status, upstream, `上游 ${upstream} 应原样保留（只有 401/403 才改写成 401）`)
      assert.equal(res.headers.get('x-magpie-sign-in'), null, `上游 ${upstream} 不是登录态问题，不得摘号`)
      const body = await res.json()
      assert.equal(body.error.type, 'provider_error')
      assert.match(body.error.message, new RegExp(`HTTP ${upstream}`))
      assert.ok(body.error.message.includes(`upstream ${upstream}`), '上游正文要截进来，便于定位')
    } finally { stub.restore() }
  }

  // 网络层失败 → 503 provider_error（不是抛异常）
  const boom = stubFetch(() => { throw new TypeError('fetch failed') })
  try {
    const res = await chat(CRED, { body: { model: 'm', messages: [] } })
    assert.equal(res.status, 503)
    assert.match((await res.json()).error.message, /连不上网关/)
  } finally { boom.restore() }

  // 成功分支不得读 body（读了流就没了）——用一次性流验证：交回宿主时仍可读
  const ok = stubFetch(() => new Response('data: {"choices":[]}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))
  try {
    const res = await chat(CRED, { body: { model: 'm', stream: true, messages: [] } })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'data: {"choices":[]}\n\n', '成功响应必须原样、未被消费')
  } finally { ok.restore() }
})

// ── 渠道对象 / 登录载体契约 ───────────────────────────────────────────────

// ── COSY 签名复现（复核结论的回归锚点）────────────────────────────────────
//
// 实测结论：真实目录/对话走 /algo/* + COSY 签名，/api/v1/* 只认 Bearer。
// 这里离线复现签名算法（公钥是国际版 asar 里的公开常量），把三件事钉住：
// 签名公式可重现、路径要剥掉 /algo 前缀、token 不以明文出现在 payload 里。
// 同时给 chat 现状加一道「改签名时必须同步改这里」的断言。
const COSY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** 照 asar/上游 0.3.0 的 generateAuthToken 复现 COSY 信封（离线，不联网）。 */
function cosyEnvelope({ uid, accessToken, url, body, timestamp = 1_800_000_000 }) {
  const aesKey = randomUUID().replace(/-/g, '').slice(0, 16)
  const keyBytes = Buffer.from(aesKey, 'utf8')
  const cipher = createCipheriv('aes-128-cbc', keyBytes, keyBytes)
  const info = Buffer.concat([
    cipher.update(JSON.stringify({ uid, aid: '', name: '', email: '', security_oauth_token: accessToken }), 'utf8'),
    cipher.final(),
  ]).toString('base64')
  const wrappedKey = publicEncrypt(
    { key: COSY_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    keyBytes,
  ).toString('base64')
  const sealed = Buffer.from(JSON.stringify({
    version: 'v1', requestId: randomUUID(), info, cosyVersion: '1.1.69', ideVersion: '',
  }), 'utf8').toString('base64')
  let path = new URL(url).pathname
  const q = path.indexOf('?')
  if (q > 0) path = path.slice(0, q)
  if (path.startsWith('/algo')) path = path.slice(5)
  const sig = createHash('md5').update(`${sealed}\n${wrappedKey}\n${timestamp}\n${body}\n${path}`, 'utf8').digest('hex')
  return {
    path,
    sealed,
    wrappedKey,
    headers: {
      'Cosy-User': uid,
      'Cosy-Key': wrappedKey,
      'Cosy-Date': String(timestamp),
      Authorization: `Bearer COSY.${sealed}.${sig}`,
    },
  }
}

test('COSY 签名：离线可复现、路径剥 /algo、payload 不含明文 token', () => {
  const url = 'https://openapi.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
  const body = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping' }], stream: true })
  const env = cosyEnvelope({ uid: 'u-1', accessToken: 'AT-OFFLINE-SECRET', url, body })

  assert.equal(env.path, '/api/v2/service/pro/sse/agent_chat_generation', '签名里的 path 必须剥掉 /algo 且不含 query')

  const recomputed = createHash('md5')
    .update(`${env.sealed}\n${env.wrappedKey}\n1800000000\n${body}\n${env.path}`, 'utf8')
    .digest('hex')
  assert.equal(env.headers.Authorization, `Bearer COSY.${env.sealed}.${recomputed}`, 'signature 必须能用同一公式重现')
  assert.match(env.headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)

  // 1024-bit RSA 包出来的密钥固定 128 字节
  assert.equal(Buffer.from(env.wrappedKey, 'base64').length, 128, 'RSA 公钥是 1024-bit（asar 里那把）')

  // payload 里只有加密后的 info，绝不能出现 token 明文
  const payload = JSON.parse(Buffer.from(env.sealed, 'base64').toString('utf8'))
  assert.deepEqual(Object.keys(payload).sort(), ['cosyVersion', 'ideVersion', 'info', 'requestId', 'version'])
  assert.equal(payload.version, 'v1')
  assert.ok(!JSON.stringify(payload).includes('AT-OFFLINE-SECRET'), 'payload 不得含明文 access token')
  assert.ok(!Buffer.from(payload.info, 'base64').toString('utf8').includes('AT-OFFLINE-SECRET'), 'info 必须真的加密过')

  // 签名与 body 强绑定：换 body 就换签名（服务端就是靠这个挡重放/篡改）
  const other = cosyEnvelope({ uid: 'u-1', accessToken: 'AT-OFFLINE-SECRET', url, body: body + ' ' })
  assert.notEqual(other.headers.Authorization.split('.').at(-1), env.headers.Authorization.split('.').at(-1))
})

test('迁移锚点：catalog/chat 都不再走 /api/v1，两条路由都是 /algo + COSY 签名', async () => {
  const stub = stubFetch(({ url }) => (/agent_chat_generation/.test(url) ? new Response('ok', { status: 200 }) : json({ data: [] })))
  try {
    await chat(CRED, { body: { model: 'm', messages: [] } })
    await catalog(CRED)
    // 两次调用都记在同一个 stub 里：分开建两个 stub 会互相覆盖，第二个把第一个的 calls 顶掉
    const chatCall = stub.calls.find((c) => /agent_chat_generation/.test(c.url))
    const catalogCall = stub.calls.find((c) => /model\/list/.test(c.url))
    assert.ok(chatCall && catalogCall, `两次请求都要被记录：${stub.calls.map((c) => c.url).join(', ')}`)
    // `/api/v1/*` 只认普通 Bearer，实测带 COSY 信封也是 401 —— 迁走了就别回头
    for (const call of [chatCall, catalogCall]) {
      assert.equal(call.url.includes('/api/v1/'), false, `不许再打 /api/v1：${call.url}`)
      assert.match(call.url, /^https:\/\/openapi\.qoder\.sh\/algo\/api\/v2\//)
      assert.ok(call.init.headers['Cosy-Key'], 'COSY 信封必须有 Cosy-Key（RSA 包的 AES key）')
      assert.ok(call.init.headers['Cosy-Date'], '签名带时间戳')
      assert.match(call.init.headers.Authorization, /^Bearer COSY\.[^.]+\.[0-9a-f]{32}$/,
        'Authorization 是 COSY 签名头，不是普通 Bearer')
    }
    assert.equal(chatCall.url, `https://openapi.qoder.sh${COSY_CHAT_PATH}`)
    assert.equal(catalogCall.url, `https://openapi.qoder.sh${COSY_MODELS_PATH}`)
  } finally {
    stub.restore()
  }
})

test('兜底目录：对象键序 = FALLBACK_MODEL_IDS 顺序，三条齐全', () => {
  // 这里**不抄 id 字面量**：抄一份就是一次漂移机会（本机显示层会改写长 id）。
  // 真值只有两条路：常量本身（唯一出处）+ 上一条用例对上游做逐字节比对。
  assert.equal(FALLBACK_MODEL_IDS.length, 3, '上游 QWENWORK_MODELS 三条')
  assert.deepEqual(Object.keys(fallbackModels), FALLBACK_MODEL_IDS, '对象键序 = 上游顺序')
  // 这里**不断言 sort() 的具体结果**：那取决于每个 id 的真实字节（首字符谁大谁小），
  // 而真实字节只有下面那条对上游逐字节比对的用例说了算。凭显示层看到的 id 在这里
  // 写一份排序期望，就是在拿没验证过的假设当门禁。
})

test(
  '兜底目录：三个 id 与上游 QWENWORK_MODELS 逐字节一致（防手抄/显示层改写漂移）',
  { skip: !existsSync(UPSTREAM_PKG) },
  () => {
    // 本机显示层会把长 id 渲染成另一个名字：人眼读、终端打印都可能与真实字节不同。
    // 所以这里既不抄常量也不比「看起来一样」，直接用 Buffer.equals 比字节。
    const text = readFileSync(UPSTREAM_PKG, 'utf8')
    // 上游是数组 `QWENWORK_MODELS = [ { id: "flash", … }, … ]`；对象形状也认。
    // 切法必须按括号配对扫描：正则 `[\s\S]*?\n}` 会停在第一个条目的收尾行上，
    // 只拿到一条 —— 那不是「三条都对上了」，是三条里只看了一条。
    const literal = /QWENWORK_MODELS\s*=\s*([[{])/.exec(text)
    assert.ok(literal, '上游应有 QWENWORK_MODELS 字面量（= [ 或 = {）')
    const openAt = literal.index + literal[0].length - 1
    const open = text[openAt]
    const close = open === '[' ? ']' : '}'
    let depth = 0
    let endAt = -1
    for (let i = openAt; i < text.length; i += 1) {
      const ch = text[i]
      // 跳过字符串字面量，否则里面的括号会把深度算歪
      if (ch === '"' || ch === "'" || ch === '`') {
        for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === '\\') i += 1
        continue
      }
      if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') {
        depth -= 1
        if (depth === 0 && ch === close) { endAt = i; break }
      }
    }
    assert.ok(endAt > openAt, '没找到与开括号配对的收口（上游结构变了就重写这段）')
    const closed = text.slice(openAt + 1, endAt)
    const byIdField = [...closed.matchAll(/\bid\s*:\s*(["'])(.*?)\1/g)].map((m) => m[2])
    // 对象形状 `{ flash: { name: … } }`：每行键的最浅缩进才是模型 id，
    // 深层缩进是条目内部字段（name/limit/…），按「最浅缩进」过滤掉。
    const keyed = [...closed.matchAll(/^( +)(["']?)([A-Za-z0-9][\w.:-]*)\2\s*:/gm)]
      .map((m) => ({ indent: m[1].length, key: m[3] }))
    const minIndent = keyed.length > 0 ? Math.min(...keyed.map((k) => k.indent)) : 0
    const byKey = keyed.filter((k) => k.indent === minIndent).map((k) => k.key)
    const upstreamIds = byIdField.length > 0 ? byIdField : byKey
    const hex = (list) => list.map((id) => `${JSON.stringify(id)}=${Buffer.from(id, 'utf8').toString('hex')}`).join(' ')
    assert.equal(upstreamIds.length, 3, `上游应正好三条，实际认出 ${upstreamIds.length}：${hex(upstreamIds)}`)
    assert.deepEqual(
      FALLBACK_MODEL_IDS.map((id) => Buffer.from(id, 'utf8').toString('hex')),
      upstreamIds.map((id) => Buffer.from(id, 'utf8').toString('hex')),
      '顺序与字节都必须与上游一致。失败时下面两行就是真值，照上游那行改常量（别照显示层抄）：\n'
        + `  本仓 FALLBACK_MODEL_IDS: ${hex(FALLBACK_MODEL_IDS)}\n`
        + `  上游 QWENWORK_MODELS   : ${hex(upstreamIds)}`,
    )
  },
)

test('兜底目录：长 id 的字面量在全仓代码里只出现一次（注释也算漂移源）', () => {
  // 上一轮实测：同一份源码里我声称「只剩一处」，实际是两处 —— 定义行 + 注释里又抄了一份。
  // 注释不参与求值，但它是下一次手抄的起点，所以这条门禁把**注释也当命中**。
  //
  // 只查长 id：`flash` / `pro` 这种短名在别处是通用模型键（COSY 测试里大量出现），
  // 拿它们当指纹会误报；短名靠肉眼就能核，长 id 才是显示层会改写的那个。
  //
  // 比较走 hex：本环境文本搜索对长 id 不可靠（Select-String 报 0 命中，实际存在）。
  const ROOT = fileURLToPath(new URL('..', import.meta.url))
  const walk = (dir) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      // 只看代码文件：文档里的引用不影响求值，不在这条门禁的管辖范围
      else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full)
    }
    return out
  }
  const files = [
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'tests')),
    ...readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(mjs|js)$/.test(e.name))
      .map((e) => join(ROOT, e.name)),
  ]

  const longIds = FALLBACK_MODEL_IDS.filter((id) => id.length >= 8)
  assert.ok(longIds.length > 0, 'FALLBACK_MODEL_IDS 里应至少有一个长 id（否则这条门禁空转）')

  const hits = []
  for (const id of longIds) {
    const needle = Buffer.from(id, 'utf8').toString('hex')
    for (const file of files) {
      const hex = Buffer.from(readFileSync(file, 'utf8'), 'utf8').toString('hex')
      let count = 0
      for (let at = hex.indexOf(needle); at !== -1; at = hex.indexOf(needle, at + needle.length)) count += 1
      if (count > 0) hits.push(`${relative(ROOT, file)} ×${count}=${JSON.stringify(id)}`)
    }
  }

  assert.deepEqual(
    hits.sort(), longIds.map((id) => `${join('src', 'qwenwork-intl.mjs')} ×1=${JSON.stringify(id)}`).sort(),
    '每个长 id 只许在 src/qwenwork-intl.mjs 出现一次（注释里再抄一份也算）；'
      + `\n  实际命中：${JSON.stringify(hits)}`,
  )
})

test('渠道对象：id/displayName/login 别名/inactive/兜底目录来自上游常量', () => {
  assert.equal(qwenworkIntlChannel.id, 'qwenwork-intl', 'ASCII、发布后不可改')
  assert.equal(qwenworkIntlChannel.displayName, '千问办公 (国际版)')
  assert.equal(typeof qwenworkIntlChannel.beginLogin, 'function')
  assert.equal(qwenworkIntlChannel.login, qwenworkIntlChannel.beginLogin, '交办单里的 login 键')
  assert.deepEqual(qwenworkIntlChannel.checkin(), { outcome: 'inactive' }, '无签到端点 → inactive')
  assert.equal(typeof qwenworkIntlChannel.fallbackModels, 'object', 'fallbackModels 必须是对象（函数会被当空目录）')
  assert.equal(Object.keys(qwenworkIntlChannel.fallbackModels).length, 3, '上游 QWENWORK_MODELS 三条')
  assert.equal(typeof qwenworkIntlChannel.catalog, 'function')
  assert.equal(typeof qwenworkIntlChannel.chat, 'function')
  assert.equal(typeof qwenworkIntlChannel.refresh, 'function')
  assert.equal(typeof qwenworkIntlChannel.expired, 'function')
})

test('beginLogin：立刻返回 { url, result }，不等用户登录', async () => {
  const opened = []
  const startedAt = Date.now()
  const started = await qwenworkIntlChannel.beginLogin((url) => opened.push(url))
  const elapsed = Date.now() - startedAt
  try {
    assert.ok(elapsed < 2000, `必须立刻返回，实际 ${elapsed}ms`)
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/login$/)
    assert.equal(opened.length, 1, '插件自己打开浏览器（配 opened 语义）')
    assert.ok(started.result instanceof Promise)
    assert.equal(typeof started.instructions, 'string')

    // 本地页：必须同时给出授权页入口与粘贴框（回调在网关，只能粘贴）
    const page = await (await fetch(started.url)).text()
    assert.match(page, /打开授权页/)
    assert.match(page, /粘贴回调地址/)
    assert.match(page, /qwenwork\.ai\/oauth2\/auth/, '授权 URL 要出现在页面里')

    // 状态端点给阶段（后台换 token 的进度）
    const status = await (await fetch(started.url.replace('/login', '/status'))).json()
    assert.equal(typeof status.phase, 'string')

    // 粘贴一条坏串 → 明确原因，且 result 仍未 settle
    const bad = await (await fetch(started.url.replace('/login', '/paste'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: '没有 code 的一段话' }),
    })).json()
    assert.equal(bad.ok, false)
    assert.match(bad.message, /没有找到 \?code/)
  } finally {
    started.cancel?.('测试结束')
    await started.result.catch(() => {})
  }
})

test('beginLogin：粘贴合法回调 → 换 token → 读身份 → result 拿到凭据', async () => {
  const stub = stubFetch(({ url }) => {
    if (url.includes('/auth/oauth/token')) {
      return json({ access_token: 'AT-E2E', refresh_token: 'RT-E2E', expires_in: 1800 })
    }
    if (url.includes('/user/info')) return json({ name: '张三', email: 'z@example.com' })
    return new Response('unexpected', { status: 500 })
  })
  let started
  try {
    started = await qwenworkIntlChannel.beginLogin(() => {})
    const page = await (await realFetch(started.url)).text()
    // state 本来就在授权 URL 里（Ory 要求的），从页面上的授权链接取出来构造一条「真回调」
    const href = /href="([^"]*oauth2\/auth[^"]*)"/.exec(page)?.[1]
    const state = href === undefined ? undefined : new URL(href.replace(/&amp;/g, '&')).searchParams.get('state')
    assert.ok(state, '登录页必须带上本次的授权 URL（oauth2/auth 且含 state）')
    const resultPromise = started.result
    const ack = await (await realFetch(started.url.replace('/login', '/paste'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: `qwenwork://oauth/callback?code=CODE-E2E&state=${state}` }),
    })).json()
    assert.equal(ack.ok, true, JSON.stringify(ack))

    const credential = await resultPromise
    assert.equal(credential.access_token, 'AT-E2E')
    assert.equal(credential.refresh_token, 'RT-E2E')
    assert.equal(credential.nickname, '张三')
    assert.equal(credential.email, 'z@example.com')
    assert.equal(credential.channel, 'qwenwork-intl')
    assert.ok(credential.expires_at > Date.now())
  } finally {
    stub.restore()
    started?.cancel?.('测试结束')
    await started?.result.catch(() => {})
  }
})

test('beginLogin：state 不匹配的回调被拒（防本地进程投别人的 code）', async () => {
  const stub = stubFetch(() => json({ access_token: 'SHOULD-NOT-BE-USED' }))
  let started
  try {
    started = await qwenworkIntlChannel.beginLogin(() => {})
    const out = await (await realFetch(started.url.replace('/login', '/paste'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: 'https://gateway.qwenwork.ai/oauth/callback?code=EVIL&state=' + 'b'.repeat(32) }),
    })).json()
    assert.equal(out.ok, false)
    assert.match(out.message, /state 不匹配/)
    assert.equal(stub.calls.length, 0, 'state 不对时绝不能把 code 发去换 token')
  } finally {
    stub.restore()
    started?.cancel?.('测试结束')
    await started?.result.catch(() => {})
  }
})

test('beginLogin：state 被拒后本次登录仍可继续（不被坏粘贴打死），正确 state 才换 token', async () => {
  const stub = stubFetch(({ url }) => {
    if (url === 'https://qwenwork.ai/auth/oauth/token') {
      return json({ access_token: 'AT-AFTER-RETRY', refresh_token: 'RT-AFTER-RETRY', expires_in: 900 })
    }
    if (url === 'https://qwenwork.ai/user/info') return json({ preferred_username: 'zhaoliu' })
    return new Response(`unexpected ${url}`, { status: 500 })
  })
  let started
  try {
    started = await qwenworkIntlChannel.beginLogin(() => {})
    const page = await (await realFetch(started.url)).text()
    const href = /href="([^"]*oauth2\/auth[^"]*)"/.exec(page)?.[1]
    const state = href === undefined ? undefined : new URL(href.replace(/&amp;/g, '&')).searchParams.get('state')
    assert.ok(state, '授权 URL 必须带 state')
    const post = (raw) => realFetch(started.url.replace('/login', '/paste'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    }).then((r) => r.json())

    // 1) 解析不了的串先来一次（模拟用户先贴错一段文字）：明确报错、不碰网络
    const garbage = await post('把地址栏复制过来')
    assert.equal(garbage.ok, false)
    assert.match(garbage.message, /没有找到 \?code/)
    assert.equal(stub.calls.length, 0, '解析失败不得触发换 token')

    // 2) 带错 state：必须拒，且没有任何网络调用
    const before = stub.calls.length
    const wrongState = await post('qwenwork://oauth/callback?code=WRONG-2&state=' + 'c'.repeat(32))
    assert.equal(wrongState.ok, false)
    assert.match(wrongState.message, /state 不匹配/)
    assert.equal(stub.calls.length, before, '错 state 不得触发换 token')

    // 3) result 仍悬着（登录没被这次坏粘贴终止）
    let settled = false
    void started.result.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(settled, false, '一次坏粘贴不能把整次登录判死')

    // 4) 正确 state：放行并拿到凭据
    const good = await post(`qwenwork://oauth/callback?code=CODE-OK&state=${state}`)
    assert.equal(good.ok, true, JSON.stringify(good))
    const credential = await started.result
    assert.equal(credential.access_token, 'AT-AFTER-RETRY')
    assert.equal(credential.nickname, 'zhaoliu')
  } finally {
    stub.restore()
    started?.cancel?.('测试结束')
    await started?.result.catch(() => {})
  }
})
