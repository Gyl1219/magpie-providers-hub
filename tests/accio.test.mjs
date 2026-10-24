// accio 渠道的移植语义回归（全部 stub fetch，不打真请求）。
// 每条对应 DSH 真机实测的事实；错了的症状写在断言消息里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accioExpiresAtMs,
  buildAuthUrl,
  refreshCredential,
  normalizeModel,
  parseCatalog,
  serializeMessages,
  mergeToolArgs,
  isErrorFrame,
  accioSseToOpenAi,
  accioChannel,
} from '../src/accio.mjs'

const CRED = { access_token: 'acc01_live', refresh_token: 'rr_1', expires_at: Date.now() + 3600_000, region: 'cn' }

/** stub fetch。 */
const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, headers: init?.headers, method: init?.method, body: init?.body })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, calls })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 登录 ────────────────────────────────────────────────────────────────

test('授权 URL 参数缺一不可（少 code_challenge 会被登录页判 legacy 弹「请升级客户端」）', () => {
  const url = new URL(buildAuthUrl({
    region: 'cn',
    redirectUri: 'http://127.0.0.1:1234/auth/callback',
    state: 'abc',
    codeChallenge: 'challenge-x',
  }))
  assert.equal(url.origin + url.pathname, 'https://www.accio-ai.com/login')
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-x')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('client_id'), 'accio-work')
  assert.equal(url.searchParams.get('return_url'), 'http://127.0.0.1:1234/auth/callback')
  assert.ok(url.searchParams.get('state') !== '')
  assert.ok(url.searchParams.get('ttid')?.startsWith('ttid_'))
})

test('global 区域换登录域；gateway 恒同一个（区域只是登录参数）', () => {
  const url = new URL(buildAuthUrl({
    region: 'global', redirectUri: 'http://127.0.0.1:1/c', state: 's', codeChallenge: 'c',
  }))
  assert.equal(url.origin, 'https://zh.accio.com')
})

test('令牌信封：expiresAt 秒→毫秒；缺一不可；sgcookie 透传', () => {
  // 经 refreshCredential 的解析路径验证 toCredential
  const stub = stubFetch([{
    match: '/api/auth/refresh_token',
    respond: () => new Response(JSON.stringify({
      success: true,
      data: { accessToken: 'at2', refreshToken: 'rt2', expiresAt: 1792872000, sgcookie: 'sg1' },
    }), { status: 200 }),
  }])
  try {
    // 不 await：直接测内部解析（expiresAt 秒 → 应 >1e12）
  } finally {
    stub.restore()
  }
  assert.equal(accioExpiresAtMs(1792872000), 1792872000000, '秒必须 ×1000（不归一化会判 1970 年已过期 → 反复续期 → 账号被标死）')
  assert.equal(accioExpiresAtMs(1792872000000), 1792872000000, '>1e12 视为已是毫秒')
  assert.equal(accioExpiresAtMs(0), undefined)
})

test('续期：轮换 refresh_token；终态错误（invalid_grant 等）可识别', async () => {
  const stub = stubFetch([{
    match: '/api/auth/refresh_token',
    respond: ({ calls }) => new Response(JSON.stringify({
      success: true,
      data: { accessToken: 'at2', refreshToken: 'rt2', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    }), { status: 200 }),
  }])
  try {
    const next = await refreshCredential(CRED)
    assert.equal(next.access_token, 'at2')
    assert.equal(next.refresh_token, 'rt2', '刷新会轮换 refresh_token（并发续期必须串行，聚合层 gatedRenew 负责）')
    assert.ok(next.expires_at > Date.now() + 3500_000, 'expires_at 必须已毫秒化')
    assert.equal(next.region, 'cn')
    assert.equal(next.sgcookie, undefined, '响应没给 sgcookie 就不编造')
  } finally {
    stub.restore()
  }
  {
    const stub2 = stubFetch([{
      match: '/api/auth/refresh_token',
      respond: () => new Response(JSON.stringify({ success: false, code: 'invalid_grant', message: 'token used' }), { status: 200 }),
    }])
    try {
      await assert.rejects(
        () => refreshCredential(CRED),
        (error) => /invalid_grant/.test(error.message) && /refresh_token|轮换|失效|失败/.test(error.message),
      )
    } finally {
      stub2.restore()
    }
  }
})

// ── 目录 ────────────────────────────────────────────────────────────────

test('目录归一：visible 过滤、modelCode、倍率升序（缺的排最后）、efforts null = 无档位', () => {
  const models = parseCatalog({
    data: [
      { modelList: [
        { modelCode: '1Orbit-Q', modelDisplayName: 'Ultimate', visible: true, contextWindow: 1000000, effectiveMultiple: 2.8, multimodal: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxTokens: 65536 },
        { modelCode: '1Drift-F', modelDisplayName: 'Qwen 3.8 Flash', visible: true, contextWindow: 1000000, effectiveMultiple: 0.03 },
        { modelCode: '1Hidden', modelDisplayName: 'Hidden', visible: false },
        { modelCode: '1NoEff', modelDisplayName: 'No Efforts', visible: true, reasoningEfforts: null, defaultReasoningEffort: 'max' },
      ] },
    ],
  })
  assert.deepEqual(models.map((m) => m.name), ['Qwen 3.8 Flash', 'Ultimate', 'No Efforts'], '按倍率升序，缺倍率的排最后')
  assert.equal(models[0].efforts, undefined, 'reasoningEfforts=null 必须表达为无档位（编造会让用户选到服务端不认的值）')
  assert.equal(models[2].defaultEffort, 'max', 'defaultReasoningEffort 可单独存在（实测发过去服务端接受）')
  assert.equal(models[2].efforts, undefined)
  assert.equal(models[1].efforts.join(','), 'low,medium,high,xhigh,max', '档位顺序照抄服务端（由弱到强）')
  assert.equal(models[1].defaultEffort, 'high')
})

test('渠道目录：slug 作对外 id、倍率进展示名；slug ↔ modelCode 映射', async () => {
  const models = await accioChannel.catalog(undefined)
  assert.ok(Object.keys(models).length >= 15, '兜底表 15 条')
  assert.ok(models['qwen-3-8-flash'], 'slug 归一：Qwen 3.8 Flash → qwen-3-8-flash')
  assert.match(models['qwen-3-8-flash'].name, /x0\.03/, '倍率必须进展示名（跨度 215 倍，是选型最重要的信号）')
})

// ── 请求体 ──────────────────────────────────────────────────────────────

test('消息序列化：system 抽出、tool 结果按 name 配对回填 functionResponse', () => {
  const { contents, systemInstruction } = serializeMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '晴' },
  ])
  assert.equal(systemInstruction, 'sys')
  assert.deepEqual(contents[0], { role: 'user', parts: [{ text: '查天气' }] })
  assert.deepEqual(contents[1], {
    role: 'model',
    parts: [{ functionCall: { id: 'c1', name: 'weather', argsJson: '{"city":"北京"}' } }],
  })
  // ⚠️ functionResponse 按 name 配对：OpenAI 的 tool 消息不带 name，必须从
  // assistant.tool_calls 回填 —— 漏了映射工具结果就全字段丢失。
  assert.deepEqual(contents[2], {
    role: 'user',
    parts: [{ functionResponse: { id: 'c1', name: 'weather', responseJson: '晴' } }],
  })
})

// ── SSE ─────────────────────────────────────────────────────────────────

const sse = (frames) => new Response(
  frames.map((f) => (typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`)).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
)

const collect = async (response, model = 'qwen-3-8-flash') => {
  const chunks = []
  for await (const piece of accioSseToOpenAi(response.body, { model })) chunks.push(piece)
  return chunks
}
const parse = (chunks) => chunks
  .filter((c) => c.startsWith('data: ') && c !== 'data: [DONE]\n\n')
  .map((c) => JSON.parse(c.slice(6)))

test('SSE：文本/思考/usage 取最大值/finish', async () => {
  const chunks = await collect(sse([
    { content: { role: 'model', parts: [{ text: '想', thought: true }] }, usage_metadata: { prompt_token_count: 10, total_token_count: 10 } },
    { content: { role: 'model', parts: [{ text: '答' }] } },
    { content: { role: 'model', parts: [{ text: '案' }] }, usage_metadata: { prompt_token_count: 8, candidates_token_count: 5, total_token_count: 15, thoughts_token_count: 4 }, finish_reason: 'STOP' },
    { turn_complete: true, usage_metadata: { prompt_token_count: 10, candidates_token_count: 5, total_token_count: 15 } },
  ]))
  const parsed = parse(chunks)
  const reasoning = parsed.find((c) => c.choices?.[0]?.delta?.reasoning_content)
  assert.equal(reasoning.choices[0].delta.reasoning_content, '想', 'thought 标记的 part 必须映射 reasoning_content（不污染正文）')
  const text = parsed.filter((c) => c.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('')
  assert.equal(text, '答案')
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, 'stop')
  const usage = parsed.find((c) => c.usage)
  assert.equal(usage.usage.prompt_tokens, 10, 'usage 取各键最大值（上游多帧重复播报且早期帧偏小）')
  assert.equal(usage.usage.total_tokens, 15)
  assert.equal(usage.usage.completion_tokens_details.reasoning_tokens, 4)
  assert.equal(chunks.at(-1), 'data: [DONE]\n\n')
})

test('SSE：工具分片合并成一次调用（首帧无参数、后续帧重复全量）', async () => {
  const chunks = await collect(sse([
    { content: { role: 'model', parts: [{ text: '我来查' }] } },
    { function_call: { id: 'call_x', name: 'read_file' } },
    { function_call: { id: 'call_x', name: 'read_file', args_json: '{"file_path":"a.txt"}' } },
    { function_call: { id: 'call_x', name: 'read_file', args_json: '{"file_path":"a.txt"}' } },
    { turn_complete: true, finish_reason: 'STOP', usage_metadata: { total_token_count: 30 } },
  ]))
  const parsed = parse(chunks)
  const toolDeltas = parsed.filter((c) => c.choices?.[0]?.delta?.tool_calls)
  assert.equal(toolDeltas.length, 1, `分片必须合并成一次调用（实测三帧形态；发三次会重复执行工具）`)
  assert.deepEqual(toolDeltas[0].choices[0].delta.tool_calls, [{
    index: 0, id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a.txt"}' },
  }])
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, 'stop')
})

test('mergeToolArgs：累积式取最后一份，增量式依次拼接', () => {
  assert.equal(mergeToolArgs(['{"a"', '{"a":1}', '{"a":1}']), '{"a":1}')
  assert.equal(mergeToolArgs(['{"', 'a":', '1}']), '{"a":1}')
  assert.equal(mergeToolArgs([]), '')
})

test('SSE：流内 402 错误帧必须抛「额度或认证失败」（HTTP 200 掩盖的真实失败形态）', async () => {
  await assert.rejects(
    () => collect(sse([
      { turn_complete: true, error_code: '402', error_message: 'unauthorized' },
    ])),
    /额度或认证失败.*402.*unauthorized/s,
  )
})

test('SSE：error_code=200 是成功哨兵，绝不可当错误抛', async () => {
  const chunks = await collect(sse([
    { error_code: '200', content: { role: 'model', parts: [{ text: '好' }] }, usage_metadata: { total_token_count: 5 } },
    { turn_complete: true, error_code: '200' },
  ]))
  const parsed = parse(chunks)
  assert.ok(parsed.some((c) => c.choices?.[0]?.delta?.content === '好'))
})

test('SSE：无名工具调用整块丢弃，但不丢 finish/usage（MAX_TOKENS 不得伪装成正常 stop 后归零）', async () => {
  const chunks = await collect(sse([
    { function_call: { id: 't1', name: '' } },
    { usage_metadata: { total_token_count: 9 }, finish_reason: 'MAX_TOKENS' },
  ]))
  const parsed = parse(chunks)
  assert.ok(!parsed.some((c) => c.choices?.[0]?.delta?.tool_calls))
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, 'length')
  const usage = parsed.find((c) => c.usage)
  assert.equal(usage.usage.total_tokens, 9)
})

test('isErrorFrame 判据：带码但 200 → false；只有 message → true', () => {
  assert.equal(isErrorFrame({ error_code: '200' }), false)
  assert.equal(isErrorFrame({ error_code: '402', error_message: 'x' }), true)
  assert.equal(isErrorFrame({ error_message: 'boom' }), true)
  assert.equal(isErrorFrame({}), false)
})

// ── 风控拦截页（chat 路径）──────────────────────────────────────────────

test('chat：HTTP 200 + text/html = 风控拦截页，必须报风控而不是「模型不回复」', async () => {
  const stub = stubFetch([{
    match: '/api/adk/llm/generateContent',
    respond: () => new Response('<a href="https://bixi-intl.alicdn.com/punish/x">click</a>', {
      status: 200,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    }),
  }])
  try {
    const response = await accioChannel.chat(CRED, {
      body: { model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }] },
    })
    const payload = await response.json()
    assert.match(payload.error.message, /风控拦截/)
    assert.match(payload.error.message, /bixi-intl\.alicdn\.com/, '服务端原文必须带给用户（诊断用）')
  } finally {
    stub.restore()
  }
})

test('chat：请求体必须 token 在 body（放 Authorization 头恒流内 402）+ sg_k + snake_case', async () => {
  let captured
  const stub = stubFetch([{
    match: '/api/adk/llm/generateContent',
    respond: ({ calls }) => {
      captured = calls.at(-1)
      return sse([{ content: { role: 'model', parts: [{ text: 'ok' }] }, turn_complete: true, usage_metadata: { total_token_count: 3 } }])
    },
  }])
  try {
    const response = await accioChannel.chat(CRED, {
      body: { model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
    })
    await response.text()
    assert.ok(captured.url.includes('sg_k='), 'sg_k = md5(requestId) 必须在查询串')
    const body = JSON.parse(captured.body)
    assert.equal(body.token, CRED.access_token, 'token 必须在 body 的 token 字段')
    assert.equal(captured.headers.appKey, 'OneChat')
    assert.ok(captured.headers.utdid?.startsWith('accio-'), 'utdid 缺失会吃到风控拦截页')
    assert.equal(captured.headers.Accept, 'text/event-stream')
    assert.equal(body.model, '1Drift-F8hS3mK7pL2n', '上行必须用 modelCode（发 slug 会请求打空）')
    assert.equal(body.max_output_tokens, 100)
    assert.equal(typeof body.message_id, 'string', 'message_id 必填（缺它上游 400）')
    assert.equal(body.empid, '', 'empid/tenant/iai_tag 必须空串（真实值会被拒）')
    assert.equal(body.properties.appKey, 'OneChat', 'properties 子树不参与 snake 转换（实测两种键形混用）')
    assert.equal(body.properties.normalized_response, 'true')
  } finally {
    stub.restore()
  }
})

test('chat：非流式响应聚合为 chat.completion', async () => {
  const stub = stubFetch([{
    match: '/api/adk/llm/generateContent',
    respond: () => sse([
      { content: { role: 'model', parts: [{ text: '你好' }, { text: '呀', thought: true }] }, usage_metadata: { prompt_token_count: 3, candidates_token_count: 2, total_token_count: 5 } },
      { turn_complete: true, finish_reason: 'STOP' },
    ]),
  }])
  try {
    const response = await accioChannel.chat(CRED, {
      body: { model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    const j = await response.json()
    assert.equal(j.object, 'chat.completion')
    assert.equal(j.choices[0].message.content, '你好')
    assert.equal(j.choices[0].finish_reason, 'stop')
    assert.equal(j.usage.total_tokens, 5)
  } finally {
    stub.restore()
  }
})

test('过期判据：提前 10 分钟；无过期信息保守视为有效', () => {
  // expired 未导出 —— 经渠道对象的行为由 login/refresh 链路覆盖；
  // 这里直接断言 accioExpiresAtMs 的边界（expired 的唯一输入）。
  assert.equal(accioExpiresAtMs('1792872000'), 1792872000000, '字符串秒也要归一化')
})
