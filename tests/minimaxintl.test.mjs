// minimaxintl 渠道的移植语义回归（全部 stub fetch，不打真请求）。
//
// 每一条都对应 DSH 真机实测出的事实；错了的症状写在断言消息里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  minimaxFetch,
  isGeoRoute,
  hasHostSuffix,
  isTransportError,
  inferHeaders,
  sanitizeProxy,
  proxyFetcher,
} from '../src/minimax-transport.mjs'
import {
  buildAnthropicPayload,
  anthropicSseToOpenAi,
  anthropicJsonToOpenAi,
  rememberModelMeta,
} from '../src/minimax-bridge.mjs'
import {
  parseTokenGrant,
  refreshCredential,
  expired,
  parseModelsPayload,
  normalizeModel,
  minimaxintlChannel,
  parseUserIdentity,
  fetchUserIdentity,
} from '../src/minimaxintl.mjs'

/** 按 URL/状态路由的 stub fetch，记录每次调用的头。 */
const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, headers: init?.headers, method: init?.method, body: init?.body })
    for (const route of routes) {
      const hit = typeof route.match === 'function' ? route.match(url, calls.length) : url.includes(route.match)
      if (hit) return route.respond({ url, calls })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const redirect = (location, status = 307) => new Response(null, { status, headers: { location } })
const CRED = { access_token: 'mmoat_live_token', refresh_token: 'mmort_x', expires_at: String(Date.now() + 3600_000) }

// ── 传输：issue IKMEVG（307 剥 Authorization）──────────────────────────────

test('307 第二跳保留 Authorization（社区插件国际版登不上的根因）', async () => {
  const stub = stubFetch([
    { match: 'agent.minimax.io', respond: () => redirect('https://agent.minimaxi.com/mavis/api/v1/llm/v1/messages') },
    { match: 'agent.minimaxi.com', respond: () => new Response('{"ok":true}', { status: 200 }) },
  ])
  try {
    const response = await minimaxFetch(
      'https://agent.minimax.io/mavis/api/v1/llm/v1/messages',
      () => ({ method: 'POST', headers: inferHeaders(CRED) }),
    )
    assert.equal(response.status, 200, '保凭据跟随后应拿到 200')
    const hop2 = stub.calls.find((c) => c.url.includes('minimaxi.com'))
    assert.ok(hop2, '应实际跟随到第二跳')
    assert.equal(hop2.headers.get('authorization'), `Bearer ${CRED.access_token}`,
      '第二跳必须重附 Authorization（fetch 跨域自动跟随会剥掉它）')
  } finally {
    stub.restore()
  }
})

test('不可信主机不跟随（凭据不外泄）', async () => {
  const stub = stubFetch([
    { match: 'agent.minimax.io', respond: () => redirect('https://evil.example.com/steal') },
  ])
  try {
    const response = await minimaxFetch(
      'https://agent.minimax.io/x',
      () => ({ method: 'GET', headers: inferHeaders(CRED) }),
    )
    assert.equal(response.status, 307, '原样返回 3xx，由调用方按非 2xx 处理')
    assert.ok(!stub.calls.some((c) => c.url.includes('evil.example.com')), '绝不把带凭据的请求发往不可信主机')
  } finally {
    stub.restore()
  }
})

test('后缀匹配必须带边界：evilminimaxi.com 不是可信主机', () => {
  assert.equal(hasHostSuffix('agent.minimaxi.com', 'minimaxi.com'), true)
  assert.equal(hasHostSuffix('minimaxi.com', 'minimaxi.com'), true)
  assert.equal(hasHostSuffix('evilminimaxi.com', 'minimaxi.com'), false, '裸 endsWith 会放行仿冒域')
  assert.equal(hasHostSuffix('evil-minimax.io', 'minimax.io'), false)
})

test('地理路由判定：只认 agent.minimax.io → minimaxi.com，不认 account 主机', () => {
  assert.equal(isGeoRoute('agent.minimax.io', 307, 'https://agent.minimaxi.com/x'), true)
  assert.equal(isGeoRoute('account.minimax.io', 307, 'https://account.minimaxi.com/x'), false,
    'account 主机的重定向与地理分流无关（误报会把登录失败说成网络问题）')
  assert.equal(isGeoRoute('agent.minimax.io', 302, 'https://agent.minimaxi.com/x'), false)
  assert.equal(isGeoRoute('agent.minimax.io', 307, 'https://evilminimaxi.com/x'), false)
})

test('传输错误重试、HTTP 4xx 不重试、abort 不重试', async () => {
  {
    const stub = stubFetch([
      { match: 'x', respond: ({ calls }) => (calls.length === 1
        ? (() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) })()
        : new Response('ok', { status: 200 })) },
    ])
    try {
      const response = await minimaxFetch('https://agent.minimax.io/x', () => ({ method: 'GET' }))
      assert.equal(response.status, 200)
      assert.equal(stub.calls.length, 2, '传输错误应重试一次后成功')
    } finally {
      stub.restore()
    }
  }
  {
    const stub = stubFetch([{ match: 'x', respond: () => new Response('no', { status: 401 }) }])
    try {
      await minimaxFetch('https://agent.minimax.io/x', () => ({ method: 'GET' }))
      assert.unreachable('4xx 应原样返回')
    } catch {
      // minimaxFetch 不抛 4xx（返回 Response），这条不应到达
    }
    assert.equal(stub.calls.length, 1, 'HTTP 状态错误绝不重发')
  }
})

test('isTransportError 沿 cause 链找真因', () => {
  assert.equal(isTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(isTransportError(new Error('HTTP 401')), false, '业务错误不是传输错误')
})

// ── 翻译桥：请求向 ────────────────────────────────────────────────────────

rememberModelMeta([
  { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: true, effortOptions: ['default', 'low', 'high'], defaultEffort: 'default', thinkingMode: 'forced_on' },
  { id: 'MiniMax-M3', name: 'M3', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: true, thinkingMode: 'switchable' },
  { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 200_000, maxTokens: 128_000, supportsImage: false, thinkingMode: 'forced_on' },
])

test('system 消息并入顶层 system 字段（Anthropic 不接受 system 角色）', () => {
  const payload = buildAnthropicPayload({
    model: 'MiniMax-M3',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
  })
  assert.equal(payload.system, '你是助手')
  assert.ok(!payload.messages.some((m) => m.role === 'system'))
  assert.deepEqual(payload.messages, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
})

test('tool_calls → tool_use；tool 角色 → 紧随 assistant 的 user(tool_result)，成对提交', () => {
  const payload = buildAnthropicPayload({
    model: 'MiniMax-M3',
    messages: [
      { role: 'user', content: '查天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25 度' },
    ],
  })
  const [user, assistant, toolUser] = payload.messages
  assert.deepEqual(assistant.content, [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '北京' } }])
  assert.equal(toolUser.role, 'user')
  assert.deepEqual(toolUser.content, [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '晴 25 度' }] }])
  // 成对：tool_result 的 user 紧跟 assistant(tool_use) —— 中间不能插别的消息
  assert.equal(payload.messages.indexOf(toolUser), payload.messages.indexOf(assistant) + 1)
  void user
})

test('孤儿 tool_use / tool_result 被剔除（服务端 400 的根源）', () => {
  const payload = buildAnthropicPayload({
    model: 'MiniMax-M3',
    messages: [
      { role: 'tool', tool_call_id: 'ghost', content: '孤儿结果' },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal(payload.messages.length, 1)
  assert.deepEqual(payload.messages[0].content, [{ type: 'text', text: 'hi' }])
})

test('思考档位决策表：M3.1 永不发 disabled；M3 可关；M2.7 整个不发', () => {
  // M3.1（forced_on）：请求「关闭」被忽略，落成 adaptive（发 disabled 是硬 400 2013）
  const m31 = buildAnthropicPayload({ model: 'MiniMax-M3.1-Flash-Preview', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'none' })
  assert.deepEqual(m31.thinking, { type: 'adaptive' })
  // M3.1 带合法档位 → adaptive + output_config.effort
  const m31low = buildAnthropicPayload({ model: 'MiniMax-M3.1-Flash-Preview', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'low' })
  assert.deepEqual(m31low.thinking, { type: 'adaptive' })
  assert.deepEqual(m31low.output_config, { effort: 'low' })
  // M3（switchable）：none 真的关掉
  const m3 = buildAnthropicPayload({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'none' })
  assert.deepEqual(m3.thinking, { type: 'disabled' })
  // M2.7（forced_on 无档位）：整个不发（发 disabled 被静默忽略）
  const m27 = buildAnthropicPayload({ model: 'MiniMax-M2.7', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'none' })
  assert.equal(m27.thinking, undefined)
})

test('max_tokens 必填兜底；图片走裸 base64 的 Anthropic 形状', () => {
  const payload = buildAnthropicPayload({
    model: 'MiniMax-M3',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    }],
  })
  assert.equal(payload.max_tokens, 128_000, '没带 max_tokens 时按目录 output 上限兜底')
  assert.deepEqual(payload.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
  })
  assert.ok(!JSON.stringify(payload).includes('image_url'), 'OpenAI 的 image_url 形状被服务端明确拒绝，不得外发')
})

// ── 翻译桥：SSE 响应向 ────────────────────────────────────────────────────

const sse = (frames) => new Response(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''), {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
})

const collect = async (response, model = 'MiniMax-M3') => {
  const chunks = []
  for await (const piece of anthropicSseToOpenAi(response.body, { model })) chunks.push(piece)
  return chunks
}

test('SSE：文本/思考增量、工具调用（名字随每片）、finish、usage、[DONE]', async () => {
  const chunks = await collect(sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'deadbeef' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 3 } } },
  ]))
  const deltas = chunks.filter((c) => c.startsWith('data: ') && c !== 'data: [DONE]\n\n')
  const parsed = deltas.map((c) => JSON.parse(c.slice(6)))
  const reasoning = parsed.find((c) => c.choices?.[0]?.delta?.reasoning_content)
  assert.equal(reasoning.choices[0].delta.reasoning_content, '想一下')
  assert.ok(!JSON.stringify(parsed).includes('deadbeef'), 'signature_delta 是思考块签名，必须忽略')
  const text = parsed.find((c) => c.choices?.[0]?.delta?.content === '答案')
  assert.ok(text, '正文增量缺失')
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, 'stop')
  const usage = parsed.find((c) => c.usage)
  assert.equal(usage.usage.prompt_tokens, 10, 'message_start 的 input 不得被 message_delta 覆盖成 0')
  assert.equal(usage.usage.completion_tokens, 5)
  assert.equal(usage.usage.completion_tokens_details.reasoning_tokens, 3)
  assert.equal(chunks.at(-1), 'data: [DONE]\n\n', '流必须以 [DONE] 结束')
})

test('SSE：tool_use 名字随每一片下发（openai-node 只从 delta 读 name）', async () => {
  const chunks = await collect(sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'weather' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"北京"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
  ]))
  const parsed = chunks.filter((c) => c.startsWith('data: ') && c !== 'data: [DONE]\n\n').map((c) => JSON.parse(c.slice(6)))
  const toolDeltas = parsed.filter((c) => c.choices?.[0]?.delta?.tool_calls)
  assert.ok(toolDeltas.length >= 2)
  for (const delta of toolDeltas) {
    assert.equal(delta.choices[0].delta.tool_calls[0].function.name, 'weather', '每一片都必须带 name')
  }
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, 'tool_calls')
})

test('SSE：流内 error 帧必须抛错（静默结束 = 干净停止无报错）', async () => {
  await assert.rejects(
    () => collect(sse([
      { type: 'message_start', message: { usage: {} } },
      { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } },
    ])),
    /boom/,
  )
})

test('SSE：空名 tool_use 整块丢弃，finish 改报 length（不让人等一个不存在的调用）', async () => {
  const chunks = await collect(sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
  ]))
  const parsed = chunks.filter((c) => c.startsWith('data: ') && c !== 'data: [DONE]\n\n').map((c) => JSON.parse(c.slice(6)))
  assert.ok(!parsed.some((c) => c.choices?.[0]?.delta?.tool_calls), '坏块一个 chunk 都不能产出')
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, 'length')
})

test('非流式 JSON 响应翻译成 OpenAI chat.completion', () => {
  const openai = anthropicJsonToOpenAi({
    id: 'msg_1', stop_reason: 'tool_use',
    content: [
      { type: 'text', text: '我来查' },
      { type: 'tool_use', id: 'toolu_9', name: 'weather', input: { city: '北京' } },
    ],
    usage: { input_tokens: 7, output_tokens: 9 },
  }, { model: 'MiniMax-M3' })
  assert.equal(openai.object, 'chat.completion')
  assert.equal(openai.choices[0].message.content, '我来查')
  assert.deepEqual(openai.choices[0].message.tool_calls, [{
    id: 'toolu_9', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' },
  }])
  assert.equal(openai.choices[0].finish_reason, 'tool_calls')
  assert.equal(openai.usage.total_tokens, 16)
})

// ── 目录 ─────────────────────────────────────────────────────────────────

test('目录信封解析：model_order 优先、context_window_options 取最大档', () => {
  const entries = parseModelsPayload({
    providers: [{
      providerId: 'minimax',
      config: {
        models: {
          'MiniMax-M3.1-Flash-Preview': { name: 'M3.1', limit: { context: 512_000, output: 128_000 }, context_window_options: [512_000, 1_000_000], modalities: { input: ['text', 'image'] }, effort_options: ['default', 'low'], default_effort: 'default', thinking_config: { mode: 'forced_on' } },
          'MiniMax-M3': { name: 'M3', limit: { context: 512_000, output: 128_000 }, context_window_options: [512_000, 1_000_000], thinking_config: { mode: 'switchable' } },
        },
        model_order: ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview'],
      },
    }],
  })
  assert.deepEqual(entries.map((e) => e.id), ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview'], '顺序照抄 model_order')
  assert.equal(entries[0].contextWindow, 1_000_000, '窗口取档位表最大档（填 512K 会过早压缩）')
  assert.equal(entries[0].thinkingMode, 'switchable')
  assert.equal(entries[1].defaultEffort, 'default')
  assert.equal(entries[1].supportsImage, true)
})

test('normalizeModel：非法字段不编造（0 窗口哨兵 / 无档位不出键）', () => {
  const entry = normalizeModel({ id: 'X', name: 'x', limit: { context: 0, output: -5 } })
  assert.equal(entry.contextWindow, 0, '未知窗口用 0 哨兵，不编造')
  assert.equal(entry.maxTokens, undefined, '非法 output 整键不产出')
  assert.equal(entry.thinkingMode, undefined)
})

test('渠道兜底目录含 M3.1-Flash-Preview（官方静态表没有它，漏了远端一失败就看不到）', async () => {
  const models = await minimaxintlChannel.catalog(undefined)
  assert.deepEqual(Object.keys(models), [
    'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7',
  ])
  assert.equal(models['MiniMax-M3.1-Flash-Preview'].limit.context, 1_000_000)
})

// ── 认证 ─────────────────────────────────────────────────────────────────

test('令牌解析：scope 必含 agent.default，expires_at 按 expires_in 自算（token 不是 JWT）', () => {
  const grant = parseTokenGrant({
    access_token: 'mmoat_a', refresh_token: 'mmort_b', token_type: 'Bearer',
    expires_in: 3600, scope: 'agent.default',
  })
  assert.equal(grant.token_type, 'Bearer')
  const at = Number(grant.expires_at)
  assert.ok(Number.isFinite(at) && at > Date.now() + 3500_000, 'expires_at 必须写入（不写账号永远显示未知）')
  assert.throws(
    () => parseTokenGrant({ access_token: 'a', refresh_token: 'b', token_type: 'Bearer', expires_in: 60, scope: 'other' }),
    /scope 不含 agent\.default/,
  )
  assert.throws(
    () => parseTokenGrant({ access_token: 'a', refresh_token: 'b', token_type: 'Bearer', scope: 'agent.default' }),
    /缺少 expires_in/,
  )
  assert.throws(
    () => parseTokenGrant({ access_token: 'a', refresh_token: 'b', token_type: 'basic', expires_in: 60, scope: 'agent.default' }),
    /token_type 不是 Bearer/,
  )
})

test('续期：invalid_grant + HTTP 400 标记 signedOut（唯一确凿的「被顶掉」形态）', async () => {
  const stub = stubFetch([
    { match: 'oauth2/token', respond: () => new Response('{"error":"invalid_grant"}', { status: 400 }) },
  ])
  try {
    await assert.rejects(
      () => refreshCredential(CRED),
      (error) => error.signedOut === true && /invalid_grant/.test(error.message),
    )
  } finally {
    stub.restore()
  }
})

test('临期判据：提前 10 分钟；秒/毫秒兼容；无过期信息保守视为有效', () => {
  assert.equal(expired({ expires_at: String(Date.now() + 5 * 60_000) }), true, '剩 5 分钟应判临期')
  assert.equal(expired({ expires_at: String(Date.now() + 20 * 60_000) }), false)
  assert.equal(expired({ expires_at: String(Math.floor((Date.now() + 20 * 60_000) / 1000)) }), false, '秒级时间戳按秒换算')
  assert.equal(expired({ expires_at: String(Math.floor((Date.now() + 5 * 60_000) / 1000)) }), true)
  assert.equal(expired({}), false)
  assert.equal(expired(undefined), false)
})

// ── 账号真名（上游 IKP8UA：token 非 JWT、登录响应无身份，唯一来源是 user/info）──

test('身份解析：两站判据缺一不可（statusInfo 非零码拦国内站、name 非空拦国际站）', () => {
  // 正常形态：data.userInfo.name 非空
  assert.deepEqual(parseUserIdentity({ statusInfo: { code: 0 }, data: { userInfo: { name: '8fsmz', userID: 'u1' } } }), { name: '8fsmz', userId: 'u1' })
  // 顶层 userInfo 形态（两站/两种信封都见过）
  assert.deepEqual(parseUserIdentity({ userInfo: { name: 'MiniMax909127' } }), { name: 'MiniMax909127' })
  // ① 国内站缺 biz_id 的形态：code=1200019 → 失败（statusInfo 非零码拦住）
  assert.equal(parseUserIdentity({ statusInfo: { code: 1200019 } }), undefined)
  // ② 国际站缺 biz_id 的形态：code=0 但 name 空 → 失败（只有 name 非空拦得住）
  assert.equal(parseUserIdentity({ statusInfo: { code: 0 }, data: { userInfo: { name: '', userID: 'x', realUserID: '0' } } }), undefined,
    'code=0 但 name 空 = 数据是错的；显示空白比显示内部 id 更糟')
  // 字符串 code（"0" 成功 / 非零失败）
  assert.deepEqual(parseUserIdentity({ base_resp: { status_code: '0' }, data: { userInfo: { name: 'n' } } }), { name: 'n' })
  assert.equal(parseUserIdentity({ base_resp: { status_code: '401' }, data: { userInfo: { name: 'n' } } }), undefined)
  assert.equal(parseUserIdentity(null), undefined)
})

test('身份查询：走 minimaxFetch（307 保凭据）+ 两个 query 参数一个不能少；失败不抛', async () => {
  const stub = stubFetch([
    { match: 'agent.minimax.io', respond: () => redirect('https://agent.minimaxi.com/v1/api/user/info?device_platform=web&biz_id=3') },
    { match: 'agent.minimaxi.com', respond: ({ url }) => {
      // 参数消融断言：缺 device_platform → 400 code=2；缺 biz_id → 数据错
      assert.ok(url.includes('device_platform=web'), '缺 device_platform=web → 400 code=2')
      assert.ok(url.includes('biz_id=3'), '缺 biz_id=3 → 国际站回 code=0 但 name 空（坏数据）')
      return new Response(JSON.stringify({ statusInfo: { code: 0 }, data: { userInfo: { name: '8fsmz' } } }), { status: 200 })
    } },
  ])
  try {
    const identity = await fetchUserIdentity({ access_token: 'mmoat_t' })
    assert.deepEqual(identity, { name: '8fsmz' }, '307 后第二跳带凭据拿到真名')
  } finally {
    stub.restore()
  }
  // 失败（非 JSON / 网络）→ undefined，绝不抛（昵称是展示信息，不阻塞登录）
  {
    const stub2 = stubFetch([{ match: 'x', respond: () => new Response('<html>gateway</html>', { status: 200 }) }])
    try {
      assert.equal(await fetchUserIdentity({ access_token: 't' }), undefined)
    } finally {
      stub2.restore()
    }
  }
})

test('beginLogin：登录成功后凭据带 nickname（真名进账号槽 accountId）', async () => {
  // beginLogin 的 result 在真名查询后被包装：查到 → credential.nickname
  const stub = stubFetch([
    { match: 'oauth2/device/code', respond: () => new Response(JSON.stringify({
      device_code: 'dc', user_code: 'UC-CODE', verification_uri: 'https://v.example',
      verification_uri_complete: 'https://v.example?uc=UC-CODE', expires_in: 600, interval: 5,
    }), { status: 200 }) },
    { match: 'oauth2/token', respond: () => new Response(JSON.stringify({
      access_token: 'mmoat_new', refresh_token: 'mmort_new', token_type: 'Bearer',
      expires_in: 3600, scope: 'agent.default',
    }), { status: 200 }) },
    { match: 'v1/api/user/info', respond: () => new Response(JSON.stringify({
      statusInfo: { code: 0 }, data: { userInfo: { name: '真名用户' } },
    }), { status: 200 }) },
  ])
  try {
    const started = await minimaxintlChannel.beginLogin(undefined, {})
    const credential = await started.result
    assert.equal(credential.access_token, 'mmoat_new')
    assert.equal(credential.nickname, '真名用户', '真名挂在凭据上（聚合层用它做 accountId）')
  } finally {
    stub.restore()
  }
})

// ── 出口代理（上游 minimax-proxy 取舍：真换出口，仅 minimaxintl）──────────

test('sanitizeProxy：只认 http(s)://；socks5/空/CRLF/非法串 → undefined（=直连）', () => {
  assert.equal(sanitizeProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(sanitizeProxy('  https://proxy.example.com:8443 '), 'https://proxy.example.com:8443')
  assert.equal(sanitizeProxy('http://user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890', '带认证的也认')
  assert.equal(sanitizeProxy('socks5://127.0.0.1:1080'), undefined, '第一版只支持 http(s)（Bun 原生 init.proxy）')
  assert.equal(sanitizeProxy(''), undefined)
  assert.equal(sanitizeProxy('not a url'), undefined)
  assert.equal(sanitizeProxy('http://127.0.0.1:7890\r\nX-Evil: 1'), undefined, 'CRRLF 头注入必须拦')
  assert.equal(sanitizeProxy(undefined), undefined)
})

test('proxyFetcher：无代理 → undefined（直连不改行为）；有代理 → 带 proxy 键的 fetcher；拒 Request 对象', async () => {
  assert.equal(proxyFetcher(undefined), undefined, '没配代理必须走原路径（不能改变无代理时的既有行为）')
  assert.equal(proxyFetcher('garbage'), undefined)
  const fetcher = proxyFetcher('http://127.0.0.1:7890')
  assert.equal(typeof fetcher, 'function')
  // Node 无 init.proxy 支持：验证 fetcher 把 proxy 键带进 init（真代理行为只能在 Bun 宿主验证）
  let captured
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured = { input, init }
    return new Response('{}', { status: 200 })
  }
  try {
    await fetcher('https://agent.minimax.io/x', { method: 'GET' })
    assert.equal(captured.init.proxy, 'http://127.0.0.1:7890', '代理串必须进 init.proxy（Bun 原生键）')
    assert.equal(captured.init.method, 'GET')
    await assert.rejects(
      () => fetcher(new Request('https://x.example'), {}),
      /Request 对象/,
      '{...Request} 展开会静默丢 method/body —— 必须显式拦截（上游 IKK4BY 纪律）',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('minimaxFetch 接受代理 fetcher：307 跟随与凭据保持都走它', async () => {
  const calls = []
  const proxied = async (input, init) => {
    calls.push(String(input))
    if (String(input).includes('agent.minimax.io')) {
      return new Response(null, { status: 307, headers: { location: 'https://agent.minimaxi.com/v1/x' } })
    }
    return new Response('{"ok":1}', { status: 200 })
  }
  const response = await minimaxFetch('https://agent.minimax.io/v1/x', () => ({
    method: 'GET', headers: { Authorization: 'Bearer t' },
  }), { fetcher: proxied })
  assert.equal(response.status, 200)
  assert.equal(calls.length, 2, '代理 fetcher 接管了整条重定向链（每一跳都经它）')
})
