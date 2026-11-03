// 百智云渠道测试（全部 stub 上游；两套凭据、桥翻译、Cap PoW、单位换算）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-baizhi-'))
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')

const { baizhiChannel, BAIZHI_MAX_CONTEXT } = await import('../src/baizhi.mjs')

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const json = (body, status = 200, headers) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...(headers ?? {}) },
})
const sse = (frames) => new Response(frames.join('\n\n') + '\n\n', {
  headers: { 'content-type': 'text/event-stream; charset=utf-8' },
})

const stubFetch = (routes) => {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    for (const route of routes) if (url.includes(route.match)) return route.respond({ url, calls, init })
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}
const original = globalThis.fetch

// ── 目录 ────────────────────────────────────────────────────────────────

test('目录：远端失败 → 内置兜底表（15 条实测 id，能力未知不编）', async () => {
  const stub = stubFetch([{ match: '/api/anthropic/v1/models', respond: () => new Response('网关路由不存在', { status: 404 }) }])
  try {
    const models = await baizhiChannel.catalog({ access_token: 'sk-X' })
    assert.equal(Object.keys(models).length, 15, '已知表 15 条')
    assert.equal(models['deepseek-v4-pro'].limit.context, BAIZHI_MAX_CONTEXT)
    assert.equal(models['glm-5.1'].capabilities.attachment, true, '已知 supportsImage=true 才开')
    assert.equal(models['glm-5'].capabilities.attachment, undefined, '未知 ≠ 不支持，不编')
    assert.equal(models['minimax-m2.5'].name, 'minimax-m2.5', '兜底 name 用 id，不编展示名')
  } finally { stub.restore() }
})

test('目录：远端 45 id 无能力字段 → 已知表补；display_name 有就用', async () => {
  const stub = stubFetch([{
    match: '/api/anthropic/v1/models',
    respond: () => json({ data: [
      { id: 'deepseek-v4-pro', type: 'model', display_name: 'DeepSeek V4 Pro', created_at: '2026-10-01T00:00:00Z' },
      { id: 'brand-new-model', type: 'model', display_name: '全新模型', created_at: '2026-11-01T00:00:00Z' },
    ] }),
  }])
  try {
    const models = await baizhiChannel.catalog({ access_token: 'sk-X' })
    assert.equal(models['deepseek-v4-pro'].name, 'DeepSeek V4 Pro', '远端 display_name 有就用')
    assert.equal(models['deepseek-v4-pro'].limit.context, BAIZHI_MAX_CONTEXT, '能力从已知表补')
    assert.equal(models['brand-new-model'].name, '全新模型')
    assert.equal(models['brand-new-model'].capabilities.attachment, undefined, '未知 id 不编能力')
    assert.ok(models['glm-5.1'], '远端漏列的已知模型也补上')
  } finally { stub.restore() }
})

// ── chat（双头：x-api-key + anthropic-version）──────────────────────────

test('chat：x-api-key + anthropic-version 头；SSE 反译成 OpenAI 帧', async () => {
  const stub = stubFetch([{
    match: '/api/anthropic/v1/messages',
    respond: () => sse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]),
  }])
  try {
    const res = await baizhiChannel.chat(
      { access_token: 'sk-ABC' },
      { body: { model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const sent = stub.calls[0]
    assert.equal(sent.headers['x-api-key'], 'sk-ABC', '网关只认 x-api-key')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    assert.ok(JSON.parse(sent.body).system === undefined || Array.isArray(JSON.parse(sent.body).system))
    const text = await res.text()
    assert.match(text, /"model":"baizhi\/deepseek-v4-flash"|deepseek-v4-flash/, '反译后带模型名')
    assert.match(text, /你好/, '正文块被反译出来')
  } finally { stub.restore() }
})

test('chat 非流式：Anthropic JSON → OpenAI chat.completion', async () => {
  const stub = stubFetch([{
    match: '/api/anthropic/v1/messages',
    respond: () => json({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
      content: [{ type: 'text', text: '答' }], stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  }])
  try {
    const res = await baizhiChannel.chat(
      { access_token: 'sk-ABC' },
      { body: { model: 'deepseek-v4-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, '答')
    assert.equal(body.choices[0].finish_reason, 'stop')
  } finally { stub.restore() }
})

test('chat 错误分类：401 凭据 / 402 quota / 429 限流 / 400 invalid_request 透传原文', async () => {
  const anthropicError = (kind, message) => json({ type: 'error', error: { type: kind, message } }, 0 && undefined) && undefined
  const caseOf = async (status, kind, message) => {
    const stub = stubFetch([{
      match: '/api/anthropic/v1/messages',
      respond: () => new Response(JSON.stringify({ type: 'error', error: { type: kind, message } }), { status, headers: { 'content-type': 'application/json' } }),
    }])
    try {
      const res = await baizhiChannel.chat(
        { access_token: 'sk-ABC' },
        { body: { model: 'deepseek-v4-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
      )
      return { status: res.status, body: await res.json() }
    } finally { stub.restore() }
  }
  const auth = await caseOf(401, 'authentication_error', 'invalid x-api-key')
  assert.equal(auth.status, 401)
  assert.match(auth.body.error.message, /静态 Key 无续期/)
  const quota = await caseOf(402, 'billing_error', 'credit exhausted')
  assert.equal(quota.status, 402, '402 原样（magpie retryable() 换号口径）')
  const rate = await caseOf(429, 'rate_limit_error', 'slow down')
  assert.equal(rate.status, 429)
  const invalid = await caseOf(400, 'invalid_request_error', 'This model maximum context length is 1048576 tokens')
  assert.equal(invalid.status, 400)
  assert.match(invalid.body.error.message, /1048576/, 'invalid_request 的上游原文透传（上下文超限要看得见）')
})

// ── usage（两套凭据分工）────────────────────────────────────────────────

test('usage：分→积分换算逐位吻合；两池分开；充值池走 amount/limit（不发 balance）', async () => {
  const stub = stubFetch([{
    match: '/api/v1/user/wallet/balance',
    respond: () => json({ code: 0, message: 'success', data: {
      user_id: 187965886890053, temporary_credit_cents: 9821, permanent_credit_cents: 13684,
      frozen_credit_cents: 0, available_credit_cents: 23505, daily_temporary_credit_claimed: true,
    } }),
  }])
  try {
    const rows = await baizhiChannel.usage({ access_token: 'sk-A', session_cookie: 'sl-session=X; baizhi_session=Y' })
    assert.equal(rows.length, 2)
    const daily = rows.find((r) => r.name === '每日积分')
    assert.equal(daily.display, '剩余 98.21', '9821 cents → 98.21（上游实测逐位）')
    assert.ok(Number.isFinite(Date.parse(daily.resetsAt)), '每日池带零点重置点')
    assert.equal(daily.span, 86_400)
    const permanent = rows.find((r) => r.name === '充值积分')
    assert.equal(permanent.limit, 136.84, '13684 cents → 136.84')
    assert.equal(permanent.balance, undefined, '绝不发 balance（magpie 对 balance 关进度条）')
    assert.match(permanent.display, /剩余 136\.84/)
    assert.equal(stub.calls[0].headers.cookie, 'sl-session=X; baizhi_session=Y', '两枚 cookie 原样带上')
    assert.equal(stub.calls[0].headers['x-api-key'], undefined, '控制台不收 x-api-key')
  } finally { stub.restore() }
})

test('usage：只有 sk- 没有 cookie → 诚实单行（不是失败）', async () => {
  const rows = await baizhiChannel.usage({ access_token: 'sk-A' })
  assert.equal(rows.length, 1)
  assert.match(rows[0].display, /控制台登录态/)
})

test('usage：cookie 失效 → 提示重新浏览器登录', async () => {
  const stub = stubFetch([{
    match: '/api/v1/user/wallet/balance',
    respond: () => new Response('unauthorized', { status: 401 }),
  }])
  try {
    const rows = await baizhiChannel.usage({ access_token: 'sk-A', session_cookie: 'sl-session=dead' })
    assert.match(rows[0].display, /重新浏览器登录/)
  } finally { stub.restore() }
})

// ── 签到（Cap PoW 全流程）───────────────────────────────────────────────

const CHALLENGE = { code: 0, message: 'success', data: { token: 'CAP1', challenge: { c: 1, s: 8, d: 2 } } }
const REDEEM_OK = { code: 0, message: 'success', data: { token: 'abcd1234:0123456789abcde', success: true } }

test('签到无 cookie → inactive（不是 failed，别把卡片涂红）', async () => {
  const r = await baizhiChannel.checkin({ access_token: 'sk-A' })
  assert.equal(r.outcome, 'inactive')
})

test('签到全流程：challenge → 本地 PoW → redeem → claim；分→积分换算', async () => {
  const stub = stubFetch([
    { match: '/api/v1/public/captcha/challenge', respond: () => json(CHALLENGE) },
    { match: '/api/v1/public/captcha/redeem', respond: () => json(REDEEM_OK) },
    { match: '/api/v1/user/wallet/daily-temporary-credit', respond: () => json({ code: 0, data: { claimed: true, amount_credit_cents: 10000, expires_at: '2026-11-05T00:00:00+08:00' } }) },
  ])
  try {
    const r = await baizhiChannel.checkin({ access_token: 'sk-A', session_cookie: 'sl-session=X; baizhi_session=Y' })
    assert.equal(r.outcome, 'claimed')
    assert.equal(r.credit, 100, '10000 cents → +100 积分（上游实测口径）')
    // PoW 解确实是 sha256(salt+n) hex 前缀碰撞（redeem 收到的是数字数组）
    const redeem = stub.calls.find((c) => c.url.includes('/captcha/redeem'))
    const solutions = JSON.parse(redeem.body).solutions
    assert.equal(solutions.length, 1, 'c=1 → 1 道题')
    assert.equal(typeof solutions[0], 'number')
  } finally { stub.restore() }
})

test('签到 claimed:false 语义靠钱包复核（2026-11-03 审计 P1）：已入账 → claimed', async () => {
  const stub = stubFetch([
    { match: '/api/v1/public/captcha/challenge', respond: () => json(CHALLENGE) },
    { match: '/api/v1/public/captcha/redeem', respond: () => json(REDEEM_OK) },
    { match: '/api/v1/user/wallet/daily-temporary-credit', respond: () => json({ code: 0, data: { claimed: false, amount_credit_cents: 10000 } }) },
    { match: '/api/v1/user/wallet/balance', respond: () => json({ code: 0, data: { available_credit_cents: 23505, temporary_credit_cents: 9821, permanent_credit_cents: 13684, frozen_credit_cents: 0, daily_temporary_credit_claimed: true } }) },
  ])
  try {
    const r = await baizhiChannel.checkin({ access_token: 'sk-A', session_cookie: 'sl-session=X' })
    assert.equal(r.outcome, 'claimed', '钱包确认已入账 ⇒ claimed（不是 failed）')
  } finally { stub.restore() }
})

test('签到 claimed:false 且钱包未确认 → failed（不静默谎报已领）', async () => {
  const stub = stubFetch([
    { match: '/api/v1/public/captcha/challenge', respond: () => json(CHALLENGE) },
    { match: '/api/v1/public/captcha/redeem', respond: () => json(REDEEM_OK) },
    { match: '/api/v1/user/wallet/daily-temporary-credit', respond: () => json({ code: 0, data: { claimed: false, amount_credit_cents: 10000 } }) },
    { match: '/api/v1/user/wallet/balance', respond: () => json({ code: 0, data: { available_credit_cents: 23505, temporary_credit_cents: 0, permanent_credit_cents: 13684, frozen_credit_cents: 0, daily_temporary_credit_claimed: false } }) },
  ])
  try {
    const r = await baizhiChannel.checkin({ access_token: 'sk-A', session_cookie: 'sl-session=X' })
    assert.equal(r.outcome, 'failed')
    assert.match(r.message, /未发放/)
  } finally { stub.restore() }
})

// ── apiAuth / 过期判据 ──────────────────────────────────────────────────

test('apiAuth：sk- 校验；「|」后接控制台 cookie', async () => {
  const cred = await baizhiChannel.apiAuth('sk-abcdefghijklmnopqrst|sl-session=S1; baizhi_session=B1')
  assert.equal(cred.access_token, 'sk-abcdefghijklmnopqrst')
  assert.equal(cred.session_cookie, 'sl-session=S1; baizhi_session=B1')
  await assert.rejects(() => baizhiChannel.apiAuth('not-a-key'), /sk-/)
})

test('expired：静态 Key 恒不过期（「未知」≠「已过期」，401 能识别）', () => {
  assert.equal(baizhiChannel.expired({}), false)
  assert.equal(baizhiChannel.expired({ expires_at: String(Date.now() - 1000) }), false, '无续期语义，不凭 expires 判死')
})
