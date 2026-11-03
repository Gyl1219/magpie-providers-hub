// MonkeyCode 渠道测试（上游全部真机断言；本地登录服务器直通）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-monkeycode-'))
process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')

const {
  monkeycodeChannel,
  monkeycodeIntlChannel,
  capPrng,
  capSolveChallengeYielding,
  readCapChallenge,
  readCapToken,
} = await import('../src/monkeycode.mjs')
const {
  monkeycodeGatewaySignature,
  monkeycodeSigningPrompt,
  buildAnthropicPayload,
  monkeycodeMaxTokensFor,
  monkeycodeThinkingFor,
  mapFinishReason,
  anthropicJsonToOpenAi,
} = await import('../src/monkeycode-bridge.mjs')

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('127.0.0.1')) return original(input, init)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    for (const route of routes) if (url.includes(route.match)) return route.respond({ url, calls, init })
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 签名（SPEC 顺序锁死）────────────────────────────────────────────────

test('网关签名：v1= + hex HMAC-SHA256(signing_secret, prompt)', () => {
  const sig = monkeycodeGatewaySignature('SECRET48', 'hello prompt')
  const expect = 'v1=' + createHmac('sha256', 'SECRET48').update('hello prompt', 'utf8').digest('hex')
  assert.equal(sig, expect)
  assert.ok(sig.startsWith('v1='))
})

test('签名 prompt 取值顺序：system → instructions 全量 join → messages 首个 system', () => {
  assert.equal(monkeycodeSigningPrompt({ system: 'TOP' }), 'TOP')
  assert.equal(monkeycodeSigningPrompt({ system: [{ type: 'text', text: 'FIRST' }, { type: 'text', text: 'SECOND' }] }), 'FIRST', 'system 只取第一块')
  assert.equal(monkeycodeSigningPrompt({ instructions: [{ text: 'A' }, { text: 'B' }] }), 'A\nB', 'instructions 全量 join')
  assert.equal(monkeycodeSigningPrompt({ messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'u' }] }), 'SYS')
  assert.equal(monkeycodeSigningPrompt({}), '')
})

// ── 请求体翻译 ──────────────────────────────────────────────────────────

test('payload：max_tokens 必填（默认 4096）+ 上限夹逼 + system 顶层化 + tools input_schema', () => {
  const p = buildAnthropicPayload({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
    stop: 'STOP',
  })
  assert.equal(p.max_tokens, 4096, '必填默认')
  assert.equal(p.stream, true, '上游只走流式')
  assert.equal(p.system, 'sys')
  assert.equal(p.messages[0].role, 'user')
  assert.equal(p.tools[0].input_schema.type, 'object')
  assert.deepEqual(p.stop_sequences, ['STOP'])
  assert.equal(p.thinking, undefined, '未传 effort 不发 thinking')
  assert.equal(monkeycodeMaxTokensFor(0), 4096, '0/负数 → 默认（参数错误不杀渠道）')
  assert.equal(monkeycodeMaxTokensFor(9_000_000), 1_048_576, '超上限夹到上限')
})

test('thinking：budget 两头夹（下限 1024 / 上限 max_tokens-1；放不下 → disabled）', () => {
  assert.deepEqual(monkeycodeThinkingFor('none', 4096), { type: 'disabled' })
  assert.deepEqual(monkeycodeThinkingFor('low', 4096), { type: 'enabled', budget_tokens: 2048 })
  assert.deepEqual(monkeycodeThinkingFor('high', 4096), { type: 'enabled', budget_tokens: 4095 }, '8192 夹到 max_tokens-1')
  assert.deepEqual(monkeycodeThinkingFor('high', 2000), { type: 'enabled', budget_tokens: 1999 }, '能夹就夹')
  assert.deepEqual(monkeycodeThinkingFor('high', 1024), { type: 'disabled' }, 'room < 1024 降级（发非法 budget 是硬 400）')
  assert.equal(monkeycodeThinkingFor(undefined, 4096), undefined)
})

// ── 网关 chat（签名头 + 失败分类）───────────────────────────────────────

test('chat：x-api-key + anthropic-version + 签名覆盖 anthropic payload 的 prompt', async () => {
  const stub = stubFetch([{
    match: 'proxy.monkeycode-ai.com/v1/messages',
    respond: () => new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  }])
  try {
    const res = await monkeycodeChannel.chat(
      { access_token: 'oma_KEY', signing_secret: 'S48' },
      { body: { model: 'deepseek-v4-flash', stream: false, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200)
    const sent = stub.calls[0]
    assert.equal(sent.headers['x-api-key'], 'oma_KEY')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    const payload = JSON.parse(sent.body)
    const expectSig = 'v1=' + createHmac('sha256', 'S48').update('sys', 'utf8').digest('hex')
    assert.equal(sent.headers['x-ohmyagent-signature'] ?? sent.headers['X-OhMyAgent-Signature'], expectSig, '签名覆盖 anthropic payload 的 prompt')
    assert.equal(payload.system, 'sys', '签名针对的 payload 与发送的一致')
    const body = await res.json()
    assert.equal(body.choices[0].message.content, '你好', '非流式 = SSE 聚合')
    assert.equal(body.usage.prompt_tokens, 10)
    assert.equal(body.usage.completion_tokens, 3)
  } finally { stub.restore() }
})

test('chat：402 额度文案 → 402（magpie retryable 换账号）；401 → 401', async () => {
  const stub = stubFetch([
    { match: '/v1/messages', respond: () => new Response('积分已耗尽，调用失败', { status: 402 }) },
  ])
  try {
    const res = await monkeycodeChannel.chat(
      { access_token: 'oma_K', signing_secret: 'S' },
      { body: { model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 402)
    assert.match((await res.json()).error.message, /积分已耗尽/)
  } finally { stub.restore() }
})

test('chat：5xx + 额度文案 → 仍判 quota（文案兜住网关改写状态码）', async () => {
  const stub = stubFetch([{ match: '/v1/messages', respond: () => new Response('积分已耗尽', { status: 500 }) }])
  try {
    const res = await monkeycodeChannel.chat(
      { access_token: 'oma_K', signing_secret: 'S' },
      { body: { model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 402, '文案先于 5xx 判定（上游审计 C🟡-1）')
  } finally { stub.restore() }
})

test('chat：缺 signing_secret → 可读 401（不发给上游白吃 403）', async () => {
  const res = await monkeycodeChannel.chat(
    { access_token: 'oma_K' },
    { body: { model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
  )
  assert.equal(res.status, 401)
  assert.match((await res.json()).error.message, /signing_secret/)
})

// ── SSE 流式 ────────────────────────────────────────────────────────────

test('chat 流式：OpenAI chunk 帧 + [DONE]；signature_delta 忽略', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"xx"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  const stub = stubFetch([{ match: '/v1/messages', respond: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) }])
  try {
    const res = await monkeycodeChannel.chat(
      { access_token: 'oma_K', signing_secret: 'S' },
      { body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true } },
    )
    assert.equal((res.headers.get('content-type') ?? '').includes('text/event-stream'), true)
    const raw = await res.text()
    assert.match(raw, /"content":"A"/)
    assert.match(raw, /"reasoning_content":"hmm"/, 'thinking_delta → reasoning_content')
    assert.ok(!raw.includes('signature'), 'signature_delta 不进正文')
    assert.match(raw, /\[DONE\]/)
    assert.match(raw, /"finish_reason":"stop"/)
  } finally { stub.restore() }
})

// ── 目录 ────────────────────────────────────────────────────────────────

test('目录：内置表（glm-5 不谎报 1M 窗口）', async () => {
  const cat = await monkeycodeChannel.catalog({})
  assert.ok(cat['monkeycode-pro/deepseek-v4-pro'])
  assert.equal(cat['monkeycode-pro/deepseek-v4-pro'].limit.context, 1_048_576)
  assert.equal(cat['glm-5'].limit.context, 128_000, 'glm-5 用保守值，不照抄 deepseek 的 1M')
  const intl = await monkeycodeIntlChannel.catalog({})
  assert.ok(intl['monkeycode-basic/deepseek-flash'], '国际站同目录（同构部署）')
})

// ── 余额（两池）─────────────────────────────────────────────────────────

test('usage：每日额度（amount/limit + resetsAt 北京午夜）+ 积分（千分之一换算）', async () => {
  const stub = stubFetch([
    { match: '/api/v1/users/wallet', respond: () => json({ code: 0, data: { balance: 12345678, daily_token_balance: 8_000_000, daily_token_limit: 10_000_000 } }) },
    { match: '/api/v1/users/subscription', respond: () => json({ code: 0, data: { plan: 'pro' } }) },
  ])
  try {
    const rows = await monkeycodeChannel.usage({ access_token: 'oma_K', session_cookie: 'monkeycode_ai_session=V' })
    assert.equal(rows.length, 2)
    const daily = rows.find((r) => r.name === '每日额度')
    assert.equal(daily.limit, 10_000_000)
    assert.equal(daily.amount, 2_000_000, 'used = limit - remaining（真实消耗，路由排序输入）')
    assert.equal(daily.unit, 'token')
    assert.match(daily.display, /Pro档/)
    assert.ok(Number.isFinite(Date.parse(daily.resetsAt)))
    const credits = rows.find((r) => r.name === '积分余额')
    assert.equal(credits.limit, 12345.678, '千分之一积分换算（先 round 再除）')
    assert.equal(credits.balance, undefined, '绝不发 balance（magpie 对 balance 关进度条）')
  } finally { stub.restore() }
})

test('usage：无 cookie → 优雅降级（推理可用说明，不是报错）', async () => {
  const rows = await monkeycodeChannel.usage({ access_token: 'oma_K' })
  assert.equal(rows.length, 1)
  assert.match(rows[0].display, /未配置网页会话/)
})

// ── 签到（Cap PoW）──────────────────────────────────────────────────────

test('Cap PoW：prng 确定性 + 求解命中 hex 前缀', async () => {
  const a = capPrng('seed-token', 32)
  const b = capPrng('seed-token', 32)
  assert.equal(a, b, '同 seed 同输出')
  assert.equal(a.length, 32)
  // d=1：期望 16 次内命中
  const challenge = { count: 2, saltLength: 8, targetLength: 1 }
  const solutions = await capSolveChallengeYielding('tok', challenge)
  assert.equal(solutions.length, 2)
  for (let i = 0; i < 2; i++) {
    const ordinal = i + 1
    const target = capPrng(`tok${ordinal}d`, 1)
    const salt = capPrng(`tok${ordinal}`, 8)
    const digest = (await import('node:crypto')).createHash('sha256').update(salt + String(solutions[i])).digest('hex')
    assert.ok(digest.startsWith(target), `第 ${ordinal} 题解命中前缀（1-based 题号）`)
  }
})

test('Cap 题面解析：c/s/d 缺失报错；超范围拒绝（防事件循环冻结）', () => {
  assert.equal(readCapChallenge({ token: 'T', challenge: { c: 50, s: 32, d: 3 } }).token, 'T')
  assert.ok('error' in readCapChallenge({ token: 'T', challenge: {} }))
  assert.ok('error' in readCapChallenge({ token: 'T', challenge: { c: 10 ** 9, s: 32, d: 3 } }), 'c 超上限拒绝')
  assert.equal(readCapToken({ token: 'ABCD:1234', success: true }), 'ABCD:1234')
  assert.equal(readCapToken({ success: false }), undefined)
})

test('签到全流程：challenge → solve → redeem → checkin；奖励 = 余额差实测', async () => {
  const challenge = { c: 2, s: 8, d: 1 } // 小题量（测试快）
  const stub = stubFetch([
    { match: '/api/v1/users/wallet/checkin', respond: ({ init, calls }) => {
      if ((init?.method ?? 'GET') === 'GET') return json({ code: 0, data: { checked_in: false } })
      // POST：只有 redeem 拿到 token 后才发生
      const hadRedeem = calls.some((c) => c.url.includes('/captcha/redeem'))
      return hadRedeem ? json({ code: 0, data: { checked_in: true } }) : json({ code: 1, message: '缺 captcha_token' })
    } },
    { match: '/api/v1/users/wallet', respond: ({ calls }) => {
      // 第一次读 = 签到前（balance 1000）； redeem 之后读 = 签到后（1100）
      const hadRedeem = calls.some((c) => c.url.includes('/captcha/redeem'))
      return json({ code: 0, data: { balance: hadRedeem ? 1_100_000 : 1_000_000 } })
    } },
    { match: '/captcha/challenge', respond: () => json({ code: 0, data: { token: 'CAP-TOK', challenge } }) },
    { match: '/captcha/redeem', respond: () => json({ code: 0, data: { token: 'CAP-REDEEMED', success: true } }) },
  ])
  try {
    const r = await monkeycodeChannel.checkin({ access_token: 'oma_K', session_cookie: 'monkeycode_ai_session=V' })
    assert.equal(r.outcome, 'claimed')
    assert.equal(r.credit, 100, '响应无奖励字段 → 前后余额差实测（+100）')
  } finally { stub.restore() }
})

test('签到：已签过 → claimed（今日奖励确实已入账，不是 done）', async () => {
  const stub = stubFetch([
    { match: '/api/v1/users/wallet/checkin', respond: () => json({ code: 0, data: { checked_in: true } }) },
  ])
  try {
    const r = await monkeycodeChannel.checkin({ access_token: 'oma_K', session_cookie: 'monkeycode_ai_session=V' })
    assert.equal(r.outcome, 'claimed')
  } finally { stub.restore() }
})

test('签到：无 cookie → failed + 可行动文案（不是 inactive：这是账号配置缺口）', async () => {
  const r = await monkeycodeChannel.checkin({ access_token: 'oma_K' })
  assert.equal(r.outcome, 'failed')
  assert.match(r.message, /session_cookie/)
})

// ── 登录：本地页双路 ────────────────────────────────────────────────────

test('beginLogin：本地页渲染（浏览器状态区 + 粘贴表单）+ 粘贴路 settle', async () => {
  // 浏览器登录路会真的拉浏览器 —— stub 掉 findBrowser 不可行（内部 import）；
  // 用「不触发」断言：beginLogin 的浏览器循环独立跑，粘贴路不依赖它
  const started = await monkeycodeChannel.beginLogin()
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/login$/)
  const page = await (await fetch(started.url)).text()
  assert.match(page, /浏览器登录/)
  assert.match(page, /API Key/)
  assert.match(page, /signing_secret/)
  // 粘贴路 settle
  const paste = await (await fetch(started.url.replace('/login', '/paste'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'oma_P', secret: 'S48', cookie: 'monkeycode_ai_session=CV' }),
  })).json()
  assert.equal(paste.ok, true)
  const credential = await started.result
  assert.equal(credential.access_token, 'oma_P')
  assert.equal(credential.signing_secret, 'S48')
  assert.equal(credential.session_cookie, 'monkeycode_ai_session=CV')
})

test('过期判据：无 expires 恒 false（「未知」≠「已过期」）；给过期时间才判死', () => {
  assert.equal(monkeycodeChannel.expired({}), false)
  assert.equal(monkeycodeChannel.expired({ expires_at: String(Date.now() - 1000) }), true)
  assert.equal(monkeycodeChannel.expired({ expires_at: String(Date.now() + 1000) }), false)
})

test('intl 渠道：网关 .net / 平台 .net（同构独立账号池）', async () => {
  const stub = stubFetch([
    { match: 'proxy.monkeycode-ai.net/v1/messages', respond: () => new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) },
  ])
  try {
    const res = await monkeycodeIntlChannel.chat(
      { access_token: 'oma_I', signing_secret: 'S' },
      { body: { model: 'deepseek-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200)
    assert.ok(stub.calls[0].url.startsWith('https://proxy.monkeycode-ai.net/'), '国际站打 .net 网关')
  } finally { stub.restore() }
})

test('stop_reason 映射：tool_use → tool_calls；max_tokens → length', () => {
  assert.equal(mapFinishReason('tool_use'), 'tool_calls')
  assert.equal(mapFinishReason('max_tokens'), 'length')
  assert.equal(mapFinishReason('end_turn'), 'stop')
})

test('anthropicJsonToOpenAi：text + tool_use 块 → OpenAI message', () => {
  const out = anthropicJsonToOpenAi({
    id: 'msg_1', stop_reason: 'tool_use',
    content: [
      { type: 'text', text: '想调用' },
      { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } },
    ],
    usage: { input_tokens: 3, output_tokens: 4 },
  }, { model: 'glm-5' })
  assert.equal(out.choices[0].finish_reason, 'tool_calls')
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'search')
  assert.equal(out.usage.total_tokens, 7)
})
