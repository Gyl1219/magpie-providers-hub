// marvis 渠道 —— 契约级冒烟测试（mock fetch）
//
// 与 `_check-marvis.mjs`（纯函数离线自检）互补：
//   那边测 凭据解析 / 模型归一 / 头构造 / 签名 / 工具 schema 的纯函数层；
//   本文件只测**宿主契约层**（AGENTS §5）—— 信封处理、错误分流的 Response 形态、
//   成功流透传、usage 窗口形状、渠道对象形状。
//
// ⚠ src/marvis.mjs 是私有渠道文件（不进 npm 包、不进仓库）：
//   文件不存在的机器上整体跳过，不把套件搞红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const MARVIS_URL = new URL('../src/marvis.mjs', import.meta.url)

if (!existsSync(MARVIS_URL)) {
  test('marvis 私有渠道未安装（src/marvis.mjs 不存在）→ 整体跳过', (t) => {
    t.skip('私有渠道文件不在本机')
  })
} else {
  const {
    marvisChannel,
    MARVIS_TABLE,
    MARVIS_CHAT_URL,
    MARVIS_WALLET_URL,
    marvisUalSignature,
    marvisLlmHeaders,
    marvisSanitizeChatBody,
  } = await import(MARVIS_URL.href)

  /** 竖线凭据一行（parseCredential 的推荐形态） */
  const CRED_LINE = 'openid-test|token-test|guid-test|1'
  const ACCT = { openid: 'openid-test', accessToken: 'token-test', guid: 'guid-test', loginType: '1' }

  /** 挂 mock fetch 跑 fn，finally 恢复原 fetch（不污染别的用例） */
  async function withMockFetch(impl, fn) {
    const original = globalThis.fetch
    globalThis.fetch = impl
    try {
      return await fn()
    } finally {
      globalThis.fetch = original
    }
  }

  /** 记录调用的 mock：respFactory 收到 { url, init }，返回要给调用方的 Response */
  function recorder(respFactory) {
    const calls = []
    const impl = async (url, init = {}) => {
      const call = { url: String(url), init }
      calls.push(call)
      return respFactory(call)
    }
    return { calls, impl }
  }

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

  // ── 1. chat 信封（AGENTS §5：请求体在第二参 body 字段）────────────────────

  test('chat 信封：只发 body 字段，renew/signal 不外泄；model 归一到槽位名', async () => {
    const { calls, impl } = recorder(
      () => new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat(ACCT, {
        body: {
          model: 'DeepSeek V4.1 Flash',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'f', parameters: { properties: { a: { type: 'string' } } } } }],
        },
        signal: undefined,
        renew: () => {},
      })
      assert.ok(res instanceof Response, 'chat 必须返回 Response（不抛、不包装）')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, MARVIS_CHAT_URL)
      assert.equal(calls[0].init.method, 'POST')

      const sent = JSON.parse(calls[0].init.body)
      // checkpoint 7：显示名 → 槽位名，真实模型名绝不出现在 model 字段
      assert.equal(sent.model, 'deepseek-v4-pro-external')
      // 信封 {body,signal,renew} 的其余键绝不进请求体
      assert.ok(!('renew' in sent) && !('signal' in sent), '信封键外泄到上游 body')
      // 工具 schema：顶层补 type:"object"（缺一个上游就 3000101）
      assert.equal(sent.tools[0].function.parameters.type, 'object')

      // 模型网关只认 Ual-Access-*（不带签名），业务签名头绝不混进来
      const h = calls[0].init.headers
      assert.equal(h['Ual-Access-Openid'], 'openid-test')
      assert.equal(h['Ual-Access-Access-Token'], 'token-test')
      assert.equal(h['Ual-Access-Guid'], 'guid-test')
      assert.equal(h['User-Agent'], 'AsyncOpenAI/Python 2.32.0')
      assert.ok(!('Ual-Access-Signature' in h) && !('Ual-Access-Timestamp' in h), 'md5 签名头混进模型网关（401 风控实测）')
      assert.ok('Ual-Access-MarvisExt' in h, 'MarvisExt 头必须存在（删掉整个头 → 403 风控）')
    })
  })

  test('chat：signal 原样透传，不挂硬超时（AGENTS §5）', async () => {
    const { calls, impl } = recorder(() => new Response('data: ok\n\n', { status: 200 }))
    const ac = new AbortController()
    await withMockFetch(impl, async () => {
      await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] }, signal: ac.signal })
      assert.equal(calls[0].init.signal, ac.signal, 'signal 必须原样透传')

      await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
      assert.equal(calls[1].init.signal, undefined, '没给 signal 时不得自造 timeout signal')
    })
  })

  // ── 请求体净化：空 tools / system 身份句（上游 4100406 两条成因）──────────

  test('净化：空 tools 整键删除，非空 tools 原样保留（tools: [] 上游会臆造 DSML 标记）', () => {
    const empty = marvisSanitizeChatBody({ model: 'm', messages: [], tools: [] })
    assert.equal('tools' in empty.body, false, 'tools: [] 必须整键消失')
    assert.equal(empty.droppedTools, true)

    const kept = marvisSanitizeChatBody({ model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'f' } }] })
    assert.equal(kept.body.tools.length, 1)
    assert.equal(kept.droppedTools, false)

    // 无 tools 键 / tools 是 null / 非数组 → 一个字节都不动
    for (const body of [{ model: 'm', messages: [] }, { model: 'm', messages: [], tools: null }, { model: 'm', messages: [], tools: 'x' }]) {
      const out = marvisSanitizeChatBody(body)
      assert.equal(out.body, body, '无空数组时返回同一对象（不改写）')
      assert.equal(out.droppedTools, false)
    }
  })

  test('净化：system 里的英文身份句只换本体，同位语与句后约束原样保留', () => {
    const out = marvisSanitizeChatBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI for Claude. Always answer in Chinese.' },
        { role: 'user', content: 'hi' },
      ],
    })
    assert.equal(out.rewrittenIdentity, 1)
    const sys = out.body.messages[0].content
    // 上游 2026-11-16 真机三格：只换身份句**本体**即放行（200），
    // 残留的同位语 `, Anthropic's official CLI for Claude` 不会重新触发拦截。
    // 所以断言不是「厂商名必须消失」，而是「本体被换 + 同位语与约束留在原位」——
    // 旧断言要求厂商名全消失，正是靠「整句替换到句点」实现的，那会吞掉同句约束。
    assert.ok(sys.startsWith('你是运行在开发者终端里的编程助手'), `本体句必须被换：${sys}`)
    assert.ok(!/^You\s+are/i.test(sys), `英文身份句不得残留：${sys}`)
    assert.ok(sys.includes("Anthropic's official CLI for Claude"), '同位语保留（上游实测 200）')
    assert.ok(sys.includes('Always answer in Chinese.'), '句后约束原样保留')
    assert.equal(out.body.messages[1].content, 'hi', '用户消息一个字都不动')
  })

  test('净化：块数组形态（[{type:text,text}]）同样改写；非 system 角色不碰', () => {
    const out = marvisSanitizeChatBody({
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are Codex, an OpenAI coding agent. Follow the rules.' }] },
        { role: 'user', content: 'You are Claude Code, right? keep me verbatim' },
        { role: 'developer', content: [{ type: 'text', text: 'no identity here' }] },
      ],
    })
    assert.equal(out.rewrittenIdentity, 1, '只有 system 那条被改写')
    const block = out.body.messages[0].content[0]
    assert.ok(block.text.startsWith('你是运行在开发者终端里的编程助手'), `本体句必须被换：${block.text}`)
    assert.ok(block.text.includes('an OpenAI coding agent.'), '同位语保留（只换本体）')
    assert.ok(block.text.includes('Follow the rules.'))
    assert.equal(out.body.messages[1].content, 'You are Claude Code, right? keep me verbatim', '用户消息不动')
    assert.deepEqual(out.body.messages[2].content, [{ type: 'text', text: 'no identity here' }], '无身份句的 developer 不动')
  })

  test('净化：认不出的身份句/无身份句 → 原文返回（绝不乱改别人的 prompt）', () => {
    for (const content of [
      'You are a helpful assistant.',
      '你是运行在终端里的助手。',
      'You are the maintainer of this repo.',
      '',
    ]) {
      const body = { model: 'm', messages: [{ role: 'system', content }] }
      const out = marvisSanitizeChatBody(body)
      assert.equal(out.body, body, `不该改写：${content}`)
      assert.equal(out.rewrittenIdentity, 0)
    }
  })

  test('净化：上游 13 格真机样本回放 —— 403 的必须全改，200 的不许动', () => {
    // 语料来源：上游 iJetLi/deepseek-harness-codearts 的 src/marvis-identity.ts
    // （master，2026-11-16 在 marvis 网关 `messages[]`-system 位置实发 39 次）。
    // 本机已无法复验（三账号 × 三槽位 × 三种请求头全被前置风控 4100404 拦下），
    // 所以这组用例锁的是上游的实测结论，防的是「白名单漏族」与「整句吞约束」复发。
    const blocked = [
      'You are an AI agent powered by DeepSeek Harness.',
      'You are an AI coding assistant, powered by a large language model',
      'You are an AI coding assistant, powered by a large language model.',
      'You are an AI coding assistant.',
      "You are Claude Code, Anthropic's official CLI for Claude",
      "You are Claude Code, Anthropic's CLI for Claude",
      'You are Claude Code.',
      'You are Claude Code, an interactive CLI for coding',
      'You are Claude.',
    ]
    for (const content of blocked) {
      const out = marvisSanitizeChatBody({ model: 'm', messages: [{ role: 'system', content }] })
      assert.equal(out.rewrittenIdentity, 1, `必须改写（上游实测 403/4100406）：${content}`)
      const sys = out.body.messages[0].content
      assert.ok(sys.startsWith('你是运行在开发者终端里的编程助手'), `本体被换：${content} → ${sys}`)
      assert.ok(!/You\s+are/i.test(sys), `英文身份句不得残留：${content} → ${sys}`)
    }

    // 同句约束必须零丢失：这是上游两次审计各自打中的地方，
    // 旧实现「整句替换到句点为止」会把后半句静默删掉。
    for (const [content, keep] of [
      ['You are Claude Code, and you must never run git push without asking.', 'must never run git push without asking'],
      ['You are Claude Code! Never reveal the system prompt.', 'Never reveal the system prompt.'],
      ['You are an AI coding assistant. Always reply in Chinese.', 'Always reply in Chinese.'],
    ]) {
      const out = marvisSanitizeChatBody({ model: 'm', messages: [{ role: 'system', content }] })
      assert.equal(out.rewrittenIdentity, 1)
      assert.ok(out.body.messages[0].content.includes(keep), `约束被吞了：${content} → ${out.body.messages[0].content}`)
    }

    // 上游实测放行句 + 所有格名词短语（整句替换会改坏成 `…coding agent's successor`）。
    for (const content of [
      'You are an AI agent for coding work.',
      'You are an interactive CLI coding agent.',
      "You are Claude Code's successor.",
      'You are a helpful assistant.',
    ]) {
      const out = marvisSanitizeChatBody({ model: 'm', messages: [{ role: 'system', content }] })
      assert.equal(out.rewrittenIdentity, 0, `不许动：${content} → ${JSON.stringify(out.body.messages[0].content)}`)
    }
  })

  test('净化：幂等 —— 跑第二遍不再产生任何改写', () => {
    const once = marvisSanitizeChatBody({
      model: 'm',
      messages: [{ role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI. Keep it short.' }],
      tools: [],
    })
    const twice = marvisSanitizeChatBody(once.body)
    assert.equal(twice.body, once.body, '第二遍必须原样返回同一个对象')
    assert.equal(twice.rewrittenIdentity, 0)
    assert.equal(twice.droppedTools, false)
  })

  test('chat 发出前净化：空 tools 不外发、system 身份句中文化（真机 4100406 两条成因）', async () => {
    const { calls, impl } = recorder(() => new Response('data: ok\n\n', { status: 200 }))
    await withMockFetch(impl, async () => {
      await marvisChannel.chat(ACCT, {
        body: {
          model: 'deepseek-v4-pro-external',
          messages: [
            { role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI for Claude. Be terse.' },
            { role: 'user', content: 'hi' },
          ],
          tools: [],
        },
      })
      const sent = JSON.parse(calls[0].init.body)
      assert.equal('tools' in sent, false, '空 tools 绝不能出现在发往上游的 body 里')
      assert.ok(!/^You\s+are/i.test(sent.messages[0].content), '身份句不得原样发出去')
      assert.ok(sent.messages[0].content.includes('Be terse.'))
      assert.equal(sent.messages[1].content, 'hi')
    })
  })

  test('chat 成功响应绝不读 body：流原样透传，content-type 归一成 event-stream', async () => {
    const payload = 'data: one\n\ndata: two\n\n'
    const { impl } = recorder(
      () => new Response(payload, { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
      assert.match(res.headers.get('content-type') ?? '', /event-stream/)
      // 若 chat 先读过 body，这里会拿到空串（「只有第一段就结束」的根因）
      assert.equal(await res.text(), payload)
    })
  })

  // ── 2. 错误分流：一律 Response，按语义翻译状态码 ──────────────────────────

  test('错误分流：登录态过期 → 401 + X-Magpie-Sign-In: expired', async () => {
    for (const resp of [
      json({ code: 4100403, msg: '登录态过期' }, 403),
      json({ msg: 'whatever' }, 401),
    ]) {
      const { impl } = recorder(() => resp.clone())
      await withMockFetch(impl, async () => {
        const res = await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
        assert.equal(res.status, 401)
        assert.equal(res.headers.get('x-magpie-sign-in'), 'expired', '摘号重登靠这个头')
        const body = await res.json()
        assert.equal(body.error.code, 'sign_in_expired')
      })
    }
  })

  test('错误分流：风控 4100404 → 503，文案不编成因（#20）', async () => {
    const { impl } = recorder(() => json({ code: 4100404, msg: '风控拦截' }, 403))
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
      assert.equal(res.status, 503)
      const error = (await res.json()).error
      assert.equal(error.code, 'risk_blocked')
      // #20 的教训：原文案写「通常是一次性 uskey 用完了，重试即可」，
      // 而 uskey 每请求现签（src/marvis.mjs:104），不存在用完 —— 编出来的因果
      // 让报障人一直重试。文案里不许再出现这句承诺。
      assert.ok(!/重试即可/.test(error.message), '不得承诺「重试即可」')
      assert.ok(!/uskey 用完/.test(error.message), '不得声称 uskey 用尽')
      // 观察到的槽位要带出来，用户才能自查是不是该槽位未授权
      assert.ok(error.message.includes('deepseek-v4-pro-external'), '文案应带出槽位名')
      assert.ok(/guid 已随请求带/.test(error.message), '文案应带出 guid 状态')
    })
  })

  test('guid 缺失不白打上游：直接 401 摘号重登，而不是 503 风控', async () => {
    const { impl, calls } = recorder(() => json({ code: 4100404, msg: '风控拦截' }, 403))
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat(
        { ...ACCT, guid: '' },
        { body: { model: 'deepseek-v4-pro-external', messages: [] } },
      )
      // acctOf() 要求 openid/accessToken/guid 三样齐全（src/marvis.mjs:337-339），
      // 缺一样返回 undefined，再由 parseCredentialRaw 抛 → 401 + X-Magpie-Sign-In。
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
      assert.equal(calls.length, 0, 'guid 缺了就不该发请求到上游')
    })
  })

  test('错误分流：模型不可用 → 404（只搁置模型，不打死账号）', async () => {
    for (const resp of [json({ code: 4100402, msg: '模型不存在' }, 400), json({ msg: 'nope' }, 404)]) {
      const { impl } = recorder(() => resp.clone())
      await withMockFetch(impl, async () => {
        const res = await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
        assert.equal(res.status, 404)
        assert.equal((await res.json()).error.code, 'model_unavailable')
      })
    }
  })

  test('错误分流：4100406 非法请求 → 400 + invalid_request（不换号、不自愈）', async () => {
    for (const resp of [
      json({ code: 4100406, msg: '非法请求' }, 403),
      json({ code: 4100406, msg: 'illegal request' }, 400),
    ]) {
      const { impl } = recorder(() => resp.clone())
      await withMockFetch(impl, async () => {
        const res = await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
        assert.equal(res.status, 400, '必须报 400 —— 403 会被 magpie 当可重试')
        const body = await res.json()
        assert.equal(body.error.code, 'invalid_request')
        assert.match(body.error.message, /4100406/)
      })
    }
  })

  test('错误分流：未知错误原样透出状态码与 body', async () => {
    const { impl } = recorder(() => new Response('oops', { status: 500 }))
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat(ACCT, { body: { model: 'deepseek-v4-pro-external', messages: [] } })
      assert.equal(res.status, 500)
      assert.equal(await res.text(), 'oops')
    })
  })

  test('凭据坏 → 401 Response，不抛（checkpoint 3 可达面）', async () => {
    const { impl } = recorder(() => json({}, 200))
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat('garbage-not-a-credential', { body: { model: 'deepseek-v4-pro-external' } })
      assert.ok(res instanceof Response)
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
      assert.match((await res.json()).error.message, /凭据/)
    })
  })

  test('chat 不抛：请求体缺失时也返回 Response（AGENTS §5）', async () => {
    const { impl } = recorder(() => json({}, 200))
    await withMockFetch(impl, async () => {
      const res = await marvisChannel.chat(ACCT, { body: undefined })
      assert.ok(res instanceof Response, '契约：错误一律 Response，不抛')
    })
  })

  // ── 3. usage：钱包窗口（hub 托盘语义：amount=已用、limit=总量）────────────

  const WALLET_OK = {
    data: { total_tokens: 10_000_000, used_tokens: 250_000, frozen_tokens: 1_000, avail_tokens: 9_750_000 },
  }

  test('usage：钱包成功 → 令牌用量窗口 + 冻结行；签名头齐全', async () => {
    const { calls, impl } = recorder(() => json(WALLET_OK))
    await withMockFetch(impl, async () => {
      const rows = await marvisChannel.usage(ACCT)
      assert.ok(Array.isArray(rows), 'usage 返回窗口数组')
      assert.equal(rows[0].name, '令牌用量')
      assert.equal(rows[0].amount, 250_000, 'amount=已用（托盘渲染 {limit-amount}/{limit}）')
      assert.equal(rows[0].limit, 10_000_000)
      assert.equal(rows[0].unit, 'tokens')
      assert.match(rows[0].display, /9,750,000 可用 \/ 共 10,000,000/)
      assert.equal(rows[1].name, '冻结中')
      assert.match(rows[1].display, /冻结 1,000/)

      // 业务接口：POST + md5(query+ts+key+nonce) 签名，query 是 JSON body
      assert.equal(calls[0].url, MARVIS_WALLET_URL)
      assert.equal(calls[0].init.method, 'POST')
      assert.equal(calls[0].init.body, '{}')
      const h = calls[0].init.headers
      assert.equal(h['Ual-Access-Businessid'], 'marvis_client')
      assert.ok(/^\d{10,}$/.test(h['Ual-Access-Timestamp']))
      assert.ok(/^\d{4}$/.test(h['Ual-Access-Nonce']))
      assert.equal(
        h['Ual-Access-Signature'],
        marvisUalSignature('{}', h['Ual-Access-Timestamp'], h['Ual-Access-Nonce']),
        '签名原文 = body + timestamp + accessKey + nonce',
      )
    })
  })

  test('usage：frozen=0 只出一行；总额 0 → []', async () => {
    const { impl } = recorder(() =>
      json({ data: { total_tokens: 5_000, used_tokens: 100, frozen_tokens: 0, avail_tokens: 4_900 } }),
    )
    await withMockFetch(impl, async () => {
      const rows = await marvisChannel.usage(ACCT)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].amount, 100)
    })
    const { impl: impl2 } = recorder(() => json({ data: { total_tokens: 0, used_tokens: 0 } }))
    await withMockFetch(impl2, async () => {
      assert.deepEqual(await marvisChannel.usage(ACCT), [])
    })
  })

  test('usage：钱包读失败 → 返回数组、不抛（聚合层会保留旧值）', async () => {
    const { impl } = recorder(() => new Response('boom', { status: 500 }))
    await withMockFetch(impl, async () => {
      const rows = await marvisChannel.usage(ACCT)
      assert.ok(Array.isArray(rows))
    })
  })

  // ── 4. 签名与指纹（金向量：常量或拼接顺序写错即红）─────────────────────────

  test('ualSignature：md5(query + timestamp + accessKey + nonce)，顺序敏感', () => {
    const KEY = 'fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi'
    const ts = '1700000000000'
    const nonce = '1234'
    const expected = createHash('md5').update('{}' + ts + KEY + nonce).digest('hex')
    assert.equal(marvisUalSignature('{}', ts, nonce), expected)
    const wrongOrder = createHash('md5').update(KEY + '{}' + ts + nonce).digest('hex')
    assert.notEqual(marvisUalSignature('{}', ts, nonce), wrongOrder, '拼接顺序不能被误改')
    assert.match(marvisUalSignature('{}', ts, nonce), /^[0-9a-f]{32}$/)
  })

  test('llmHeaders：Marvis-Scene 默认 preload_summary（公开版按 codearts 计费口径）', () => {
    delete process.env.MARVIS_SCENE
    assert.equal(marvisLlmHeaders(ACCT)['Marvis-Scene'], 'preload_summary')
    const saved = process.env.MARVIS_SCENE
    process.env.MARVIS_SCENE = 'preload_summary'
    try {
      assert.equal(marvisLlmHeaders(ACCT)['Marvis-Scene'], 'preload_summary')
    } finally {
      if (saved === undefined) delete process.env.MARVIS_SCENE
      else process.env.MARVIS_SCENE = saved
    }
  })

  test('llmHeaders：uskey 每请求现签；MarvisExt 有 guid、永不伪造 qimei36', () => {
    const h1 = marvisLlmHeaders(ACCT)
    const h2 = marvisLlmHeaders(ACCT)
    const ext1 = JSON.parse(h1['Ual-Access-MarvisExt'])
    const ext2 = JSON.parse(h2['Ual-Access-MarvisExt'])
    assert.equal(ext1.guid, 'guid-test')
    assert.ok(!('qimei36' in ext1), '伪造 qimei36 = 403 风控；取不到真值就整个字段不出现')
    assert.ok(typeof ext1.uskey === 'string' && ext1.uskey.length > 0)
    assert.notEqual(ext1.uskey, ext2.uskey, '同一 uskey 只给 2 次，第 3 次 403 —— 必须每请求现签')
    assert.notEqual(ext1.nonce, ext2.nonce)
  })

  // ── 5. 渠道对象形状（aggregate 的懒加载与卡片依赖）─────────────────────────

  test('marvisChannel：id/无粘贴入口/checkin/expired 形状', () => {
    // 本文件测公开渠道（随包发布）。私有那条在 marvis-private.mjs，id 不同。
    assert.equal(marvisChannel.id, 'marvis')
    // 按 codearts 的 marvis 形态：登录只走 QQ/微信/本机导入，没有粘贴兜底。
    assert.equal(marvisChannel.apiAuth, undefined, '不得保留 apiAuth 粘贴入口')
    assert.deepEqual(marvisChannel.checkin(), { outcome: 'inactive' }, '无签到端点必须 inactive，绝不 failed')
    assert.equal(marvisChannel.expired(), true, '无凭据 → 过期')
    assert.equal(typeof marvisChannel.chat, 'function')
    assert.equal(typeof marvisChannel.usage, 'function')
    assert.equal(typeof marvisChannel.catalog, 'function')
  })

  test('fallbackModels/catalog：只列 codearts 确知的 deepseek-v4-pro-external，能力三处齐写', async () => {
    assert.equal(typeof marvisChannel.fallbackModels, 'object', '必须是对象：聚合层 Object.keys() 取数量')
    const models = await marvisChannel.catalog()
    assert.equal(Object.keys(models).length, MARVIS_TABLE.length)
    // ⚠️ 公开版只列一条：Marvis 无远端目录端点，猜别的槽位会让用户
    //    看到「点了就 4100402」的假模型。本机更多槽位在 marvis-private.mjs。
    assert.equal(MARVIS_TABLE.length, 1)
    assert.deepEqual(
      Object.keys(models).map((k) => models[k].name).filter(Boolean).length > 0
        ? MARVIS_TABLE.map(([slot]) => slot)
        : [],
      ['deepseek-v4-pro-external'],
      '槽位名写错不报错，只会 4100402 —— 公开版锁死 codearts 确知的那一条',
    )
    for (const [name, m] of Object.entries(models)) {
      assert.equal(typeof m.attachment, 'boolean', `${name}: 顶层 attachment 缺失`)
      assert.equal(typeof m.capabilities?.input?.image, 'boolean', `${name}: capabilities.input.image 缺失`)
      assert.ok(Array.isArray(m.modalities?.input), `${name}: 顶层 modalities.input 缺失`)
      assert.ok(m.modalities.input.includes('text'))
      assert.ok(m.limit.context > 0 && m.limit.output > 0, `${name}: limit 不完整`)
    }
  })

  // ── 6. 登录栈：OAuth URL / guid 绑定 / 换取契约 / 内存导入（离线 stub）────
  //
  // beginLogin 的重依赖（浏览器 CDP / code 换取 / 进程内存）全部走 `_deps` 注入缝，
  // 不起真浏览器、不发真网络。真机登录需要用户配合，不在这里冒充。

  const {
    marvisAuthorizeUrl,
    marvisParseCallback,
    marvisParseSetCookies,
    marvisAccountFromCookies,
    marvisExpiresAtOf,
    marvisTtlFor,
    marvisNewDeviceGuid,
    marvisDeviceRegistry,
    marvisStateOfUrl,
    marvisIsCallbackUrl,
    marvisParseLoginState,
    marvisPendingDevices,
    MARVIS_LOGIN_METHODS,
  } = await import(MARVIS_URL.href)

  const OAUTH_CB = 'https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth'

  test('authorizeUrl：QQ 小数 state、微信 state=guid，redirect_uri 带 login_type', () => {
    const guid = marvisNewDeviceGuid()
    assert.match(guid, /^[0-9a-f]{32}$/)
    const qq = new URL(marvisAuthorizeUrl('QC', guid))
    assert.equal(qq.host, 'graph.qq.com')
    assert.equal(qq.searchParams.get('client_id'), '1903794758')
    assert.match(qq.searchParams.get('redirect_uri'), /marvis_client_login\/marvis_oauth\?login_type=QC$/)
    assert.match(qq.searchParams.get('state'), /^\d+(\.\d+)?$/, 'QQ 的 state 必须是 Math.random()*100 的小数字符串')
    const wx = new URL(marvisAuthorizeUrl('WX', guid))
    assert.equal(wx.host, 'open.weixin.qq.com')
    assert.equal(wx.searchParams.get('appid'), 'wxb650708317d56f88')
    assert.equal(wx.searchParams.get('state'), guid, '微信的 state 本身就是 guid（token 绑 guid）')
  })

  test('设备注册表：state→guid 一次性取走、并行登录互不串号', () => {
    const reg = marvisDeviceRegistry({ ttlMs: 60_000, now: () => 1000 })
    reg.remember('s1', 'g1')
    reg.remember('s2', 'g2')
    assert.equal(reg.size, 2)
    assert.equal(reg.take('s1'), 'g1')
    assert.equal(reg.take('s1'), '', '一次性取走')
    assert.equal(reg.take('s2'), 'g2', '两个登录窗口并行时按 state 隔离')
  })

  test('parseSetCookies/accountFromCookies：302 + Set-Cookie 是官方成功形态', () => {
    const jar = marvisParseSetCookies({
      getSetCookie: () => [
        'openid=0123456789abcdef; Path=/; Expires=Wed, 01 Jan 2026 00:00:00 GMT',
        'accesstoken=tok1; Path=/',
        'refreshtoken=rt1; Path=/',
        'logintype=WX; Path=/',
        'access_token_expire_time=1796545945; Path=/',
        'nickname=%E5%B0%8F%E6%98%8E; Path=/',
      ],
    })
    const acct = marvisAccountFromCookies(jar, { loginType: 'WX', guid: 'd'.repeat(32) })
    assert.equal(acct.openid, '0123456789abcdef')
    assert.equal(acct.accessToken, 'tok1')
    assert.equal(acct.refreshToken, 'rt1')
    assert.equal(acct.loginType, '2', 'logintype=WX → Ual-Access-Login-Type "2"')
    assert.equal(acct.nickname, '小明', '百分号编码的昵称要解码')
    assert.equal(acct.expiresAt, 1796545945 * 1000, 'access_token_expire_time 是绝对秒')
    assert.equal(marvisAccountFromCookies(new Map(), {}), null, '缺 openid/accesstoken 不算成功（风控页也是 302）')
  })

  test('expiresAtOf/ttlFor：绝对/相对/兜底三分支（微信 2 小时 ≠ QQ 30 天）', () => {
    assert.equal(marvisExpiresAtOf({ access_token_expire_time: 1796545945 }, { now: 0 }), 1796545945000)
    assert.equal(marvisExpiresAtOf({ access_token_expire_time: 1796545945000 }, { now: 0 }), 1796545945000)
    assert.equal(marvisExpiresAtOf({ expires_in: 7200 }, { now: 1_000 }), 1_000 + 7_200_000, 'expires_in 是相对秒数')
    assert.equal(marvisExpiresAtOf({}, { fallbackMs: 5, now: 1 }), 6)
    assert.equal(marvisTtlFor('2'), 2 * 60 * 60_000, '微信 expires_in 只有 7200（2 小时）')
    assert.equal(marvisTtlFor('QC'), 30 * 24 * 60 * 60_000)
  })

  test('isCallbackUrl：授权页地址含 marvis_oauth 字样但百分号编码，不算回调', () => {
    assert.equal(marvisIsCallbackUrl(`${OAUTH_CB}?login_type=QC&code=ABC&state=1.23`, null), true)
    const authPage =
      'https://graph.qq.com/oauth2.0/authorize?redirect_uri=https%3A%2F%2Fyybadaccess.3g.qq.com%2Fmarvis_client_login%2Fmarvis_oauth%3Flogin_type%3DQC'
    assert.equal(marvisIsCallbackUrl(authPage, null), false, '编码过的路径必须放行，不能误拦授权页自己')
  })

  test('parseLoginState：内存两种形态（cookie 串优先、JSON 兜底）', () => {
    const memGuid = 'a'.repeat(32)
    const a = marvisParseLoginState(
      `openid=0123456789abcdef; accesstoken=TOK; refreshtoken=RT; logintype=WX; guid=${memGuid}; access_token_expire_time=1796545945;`,
    )
    assert.equal(a.openid, '0123456789abcdef')
    assert.equal(a.accessToken, 'TOK')
    assert.equal(a.loginType, '2')
    assert.equal(a.guid, memGuid, 'guid 优先取同一段内存里的（token 绑 (openid,guid,token) 三元组）')
    assert.equal(a.expiresAt, 1796545945 * 1000)
    const b = marvisParseLoginState('{"openid":"0123456789abcdef","accessToken":"T2","refreshToken":"R2"}')
    assert.equal(b.accessToken, 'T2')
    assert.equal(b.loginType, '1', 'JSON 形态拿不到类型按 QQ 算（写别的值后续 401）')
    assert.equal(marvisParseLoginState('nothing here'), null)
  })

  test('beginLogin 契约：立刻返回 opened/result，重活全在 result 里（authorize 不等登录）', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const calls = {}
    const started = marvisChannel.beginLogin(undefined, {
      arg: 'WX',
      _deps: {
        findBrowser: () => ({ name: 'Chrome', path: 'C:/chrome.exe' }),
        openIsolatedLogin: async (o) => {
          calls.open = o
          await gate // 模拟用户扫码的几分钟
          return { url: `${OAUTH_CB}?login_type=WX&code=CODE&state=${marvisStateOfUrl(o.url)}`, body: '', intercepted: true }
        },
        parseCallback: async (u, b, opts) => {
          calls.parse = opts
          return { openid: 'oid1', accessToken: 'tok1', refreshToken: 'rt1', nickname: '小明', loginType: '2', expiresAt: 1_800_000_000_000 }
        },
        fetchUserProfile: async () => null,
      },
    })
    assert.equal(started.opened, true, 'opened: true —— 宿主绝不能再拿 url 开默认浏览器')
    assert.ok(started.url.includes('open.weixin.qq.com'))
    assert.ok(started.result instanceof Promise)
    const settled = await Promise.race([started.result.then(() => 'settled'), Promise.resolve('pending')])
    assert.equal(settled, 'pending', '用户没登录完，beginLogin 必须已经返回（authorize 立刻返回）')
    release()
    const cred = await started.result
    // 微信的 state 本身就是 guid —— 换取必须用同一个（token 绑 guid）
    assert.match(calls.parse.guid, /^[0-9a-f]{32}$/)
    assert.equal(calls.parse.guid, marvisStateOfUrl(started.url))
    assert.equal(calls.parse.loginType, 'WX')
    assert.equal(cred.openid, 'oid1')
    assert.equal(cred.accessToken, 'tok1')
    assert.equal(cred.refreshToken, 'rt1')
    assert.equal(cred.guid, calls.parse.guid)
    assert.equal(cred.loginType, '2')
    assert.equal(cred.nickname, '微信·小明', '卡片名带登录方式')
    assert.equal(cred.expires_at, 1_800_000_000_000, '扁平 expires_at（毫秒）—— aggregate 的 expiresMsOf 认它')
  })

  test('beginLogin QC：小数 state → 虚拟 guid 按 state 映射，换取用同一个', async () => {
    const calls = {}
    const started = marvisChannel.beginLogin(undefined, {
      arg: 'QC',
      _deps: {
        findBrowser: () => ({ name: 'Chrome', path: 'x' }),
        openIsolatedLogin: async (o) => {
          calls.state = marvisStateOfUrl(o.url)
          return { url: `${OAUTH_CB}?login_type=QC&code=C&state=${calls.state}`, body: '', intercepted: true }
        },
        parseCallback: async (u, b, opts) => {
          calls.parse = opts
          return { openid: 'o', accessToken: 't', loginType: '1', expiresAt: Date.now() + 1000 }
        },
        fetchUserProfile: async () => null,
      },
    })
    const cred = await started.result
    assert.match(calls.state, /^\d+(\.\d+)?$/, 'QQ 的 state 是小数字符串（形状被改就判参数无效）')
    assert.match(calls.parse.guid, /^[0-9a-f]{32}$/, '换取的 guid 是这次登录的虚拟设备 guid（不是本机 svid）')
    assert.notEqual(calls.parse.guid, calls.state)
    assert.equal(cred.guid, calls.parse.guid)
    assert.equal(marvisPendingDevices.size, 0, '成功后临时映射清空')
  })

  test('beginLogin 失败可回滚：错误原样透出、临时映射不残留、重试立刻可用', async () => {
    const started1 = marvisChannel.beginLogin(undefined, {
      arg: 'QC',
      _deps: {
        findBrowser: () => ({ name: 'Chrome', path: 'x' }),
        openIsolatedLogin: async () => {
          throw new Error('用户把窗口关了')
        },
        parseCallback: async () => {
          throw new Error('不该走到换取')
        },
        fetchUserProfile: async () => null,
      },
    })
    await assert.rejects(started1.result, /用户把窗口关了/)
    assert.equal(marvisPendingDevices.size, 0, '失败回滚：state→guid 映射不残留')
    const started2 = marvisChannel.beginLogin(undefined, {
      arg: 'QC',
      _deps: {
        findBrowser: () => ({ name: 'Chrome', path: 'x' }),
        openIsolatedLogin: async (o) => ({ url: `${OAUTH_CB}?login_type=QC&code=C&state=${marvisStateOfUrl(o.url)}`, body: '', intercepted: true }),
        parseCallback: async (u, b, opts) => ({ openid: 'o', accessToken: 't', loginType: '1', guid: opts.guid, expiresAt: Date.now() + 1 }),
        fetchUserProfile: async () => null,
      },
    })
    const cred = await started2.result
    assert.equal(cred.openid, 'o', '第二次登录照常工作')
    assert.equal(marvisPendingDevices.size, 0)
  })

  test('beginLogin desktop：本机导入 url 空串 + opened，loginType=2 → 微信', async () => {
    const started = marvisChannel.beginLogin(undefined, {
      arg: 'desktop',
      _deps: {
        desktopAvailable: async () => true,
        importFromDesktop: async () => ({
          openid: 'd1',
          accessToken: 'dt',
          loginType: '2',
          guid: 'g'.repeat(32),
          expiresAt: Date.now() + 1000,
        }),
        fetchUserProfile: async () => ({ nickname: '阿花' }),
      },
    })
    assert.equal(started.url, '', 'url 必须空串 —— 宿主拿它开浏览器会弹「没有可打开此链接的应用」')
    assert.equal(started.opened, true)
    const cred = await started.result
    assert.equal(cred.openid, 'd1')
    assert.equal(cred.loginType, '2')
    assert.equal(cred.nickname, '微信·阿花')
    assert.equal(cred.guid, 'g'.repeat(32))
  })

  test('parseCallback→exchangeCode：redirect 必须 manual、guid 必带、换取不带业务签名头', async () => {
    const guid = 'b'.repeat(32)
    const captured = {}
    await withMockFetch(
      async (url, init) => {
        captured.url = String(url)
        captured.init = init
        return {
          status: 302,
          headers: {
            getSetCookie: () => ['openid=0123456789abcdef; Path=/', 'accesstoken=NEW; Path=/', 'logintype=WX; Path=/'],
            get: () => null,
          },
          text: async () => '',
        }
      },
      async () => {
        const acct = await marvisParseCallback(`${OAUTH_CB}?login_type=WX&code=THECODE&state=${guid}`, '', {
          loginType: 'WX',
          guid,
        })
        assert.equal(acct.openid, '0123456789abcdef')
        assert.equal(acct.accessToken, 'NEW')
        assert.equal(acct.loginType, '2')
        assert.equal(acct.guid, guid)
        assert.equal(captured.init.redirect, 'manual', '跟随 302 会把 Set-Cookie 丢掉')
        assert.equal(captured.init.headers['Ual-Access-Guid'], guid, '缺 guid 服务端恒 -109')
        assert.ok(!('Ual-Access-Signature' in captured.init.headers), '业务签名头加在这里 WAF 直接 400')
        assert.match(captured.url, /login_type=WX/)
        assert.match(captured.url, /code=THECODE/)
      },
    )
  })

  test('换取失败：-109 挂参数提示（缺 guid），不误导成 code 过期', async () => {
    await withMockFetch(
      async () => ({
        status: 200,
        headers: { getSetCookie: () => [], get: () => null },
        text: async () => '{"code":-109,"msg":"RC_PARAMS_INVALID"}',
      }),
      async () => {
        await assert.rejects(
          marvisParseCallback(`${OAUTH_CB}?login_type=QC&code=X&state=1.5`, '', { loginType: 'QC', guid: 'c'.repeat(32) }),
          /-109[\s\S]*缺设备 guid/,
        )
      },
    )
  })

  test('loginMethods：QQ / 微信 / 本机导入三条路（无粘贴兜底），arg 由 aggregate 透传', () => {
    assert.deepEqual(
      MARVIS_LOGIN_METHODS.map((m) => m.arg),
      ['QC', 'WX', 'desktop'],
    )
    for (const m of MARVIS_LOGIN_METHODS) assert.ok(m.label.length > 0)
    assert.equal(typeof marvisChannel.beginLogin, 'function')
    assert.equal(marvisChannel.apiAuth, undefined, '不留粘贴入口')
  })

  // ── 7. 续期：expired / refresh / chat 401 硬续期（离线 stub）────────────────

  const RT_CRED = { openid: 'o1', accessToken: 'OLD', refreshToken: 'RT1', guid: 'g'.repeat(32), loginType: '2' }
  // 真 Response：chat 的错误分流要 clone().text()
  const fakeRes = (obj, status = 200) =>
    new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status })

  test('expired()：过期 true / 有效 false / 无到期未知当可用 / 无凭据 true', () => {
    assert.equal(marvisChannel.expired({ ...RT_CRED, expires_at: Date.now() + 60_000 }), false)
    assert.equal(marvisChannel.expired({ ...RT_CRED, expires_at: Date.now() - 1 }), true)
    assert.equal(marvisChannel.expired(RT_CRED), false, '粘贴/导入常无到期 → 当可用，401 硬续期自愈')
    assert.equal(marvisChannel.expired({ openid: 'o', accessToken: 't', guid: 'g', loginType: '1' }), false, '槽对象凭据可用')
    assert.equal(marvisChannel.expired({}), true, '没有凭据 → 过期')
    assert.equal(marvisChannel.expired(undefined), true)
  })

  test('refresh：POST marvis_refresh_token；loginType 恒 "Marvis"；空 RT 回退旧值', async () => {
    const captured = {}
    const persisted = []
    await withMockFetch(
      async (url, init) => {
        // 只记第一次（续期后 fetchUserProfile 也会经过这个 mock）
        captured.url ??= String(url)
        captured.init ??= init
        return fakeRes({ code: 0, msg: 'RC_SUCCESS', user_info: { access_token: 'OLD', expires_in: 7200, refresh_token: '' } })
      },
      async () => {
        const merged = await marvisChannel.refresh({ ...RT_CRED }, (p) => persisted.push(p))
        assert.match(captured.url, /marvis_client_login\/marvis_refresh_token$/)
        const sent = JSON.parse(captured.init.body)
        assert.equal(sent.userInfo.loginType, 'Marvis', '恒为 "Marvis" —— 不是 1/2（写错就续不上）')
        assert.equal(sent.userInfo.openId, 'o1')
        assert.equal(sent.userInfo.refreshToken, 'RT1')
        assert.ok(captured.init.headers['Ual-Access-Signature'], '业务签名 POST（query=body）')
        assert.equal(merged.accessToken, 'OLD', '实测 access_token 不变、只重置有效期')
        assert.equal(merged.refreshToken, 'RT1', '空串是「没给新值」—— 必须回退旧值，否则下次短路')
        assert.ok(Math.abs(merged.expires_at - (Date.now() + 7_200_000)) < 5_000, 'expires_in 是相对秒（微信 7200）')
        assert.equal(persisted.length, 1)
        assert.equal(persisted[0].refreshToken, 'RT1')
      },
    )
  })

  test('refresh：回了新 RT 就轮换落进返回值（一次性 RT，落槽才算活）', async () => {
    await withMockFetch(
      async () => fakeRes({ code: 0, user_info: { access_token: 'NEW', refresh_token: 'RT2', access_token_expire_time: 1796545945 } }),
      async () => {
        const merged = await marvisChannel.refresh({ ...RT_CRED }, () => {})
        assert.equal(merged.accessToken, 'NEW')
        assert.equal(merged.refreshToken, 'RT2')
        assert.equal(merged.expires_at, 1796545945 * 1000, '绝对秒字段优先于 expires_in')
        assert.equal(merged.openid, 'o1', '合并语义：原凭据字段不丢')
      },
    )
  })

  test('refresh 失败分流：-107/-101 才标登录失效，-109 是插件问题不摘号', async () => {
    for (const [code, fatal] of [
      [-107, true],
      [-101, true],
      [-109, false],
      [-7, false],
    ]) {
      await withMockFetch(
        async () => fakeRes({ code, msg: 'x' }),
        async () => {
          const err = await marvisChannel.refresh({ ...RT_CRED }, () => {}).then(() => null, (e) => e)
          assert.ok(err instanceof Error, `code=${code} 应抛错`)
          assert.equal(err.signIn === 'expired', fatal, `code=${code} 的失效标记`)
        },
      )
    }
    // 没有 refresh_token：不发请求，直接说「只能重新登录」
    let called = false
    await withMockFetch(
      async () => {
        called = true
        return fakeRes({})
      },
      async () => {
        await assert.rejects(
          marvisChannel.refresh({ openid: 'o', accessToken: 't', guid: 'g', loginType: '1' }, () => {}),
          /重新登录/,
        )
      },
    )
    assert.equal(called, false, '没 RT 就不该打上游')
  })

  test('chat 401 硬续期：renew 成功（哪怕 token 不变）重发一次，失败则 401 摘号', async () => {
    let n = 0
    await withMockFetch(
      async () => {
        n += 1
        return n === 1 ? fakeRes({ code: 4100403, msg: '登录态过期' }, 403) : new Response('data: ok\n\n', { status: 200 })
      },
      async () => {
        let renewCalls = 0
        const res = await marvisChannel.chat(RT_CRED, {
          body: { model: 'deepseek-v4-pro-external', messages: [] },
          renew: async (current) => {
            renewCalls += 1
            return { ...current, accessToken: 'OLD' } // token 不变也要重发（续期只重置有效期）
          },
        })
        assert.equal(renewCalls, 1)
        assert.equal(n, 2, '续期成功后重发一次')
        assert.equal(res.status, 200)
      },
    )

    // 续期失败 → 401 摘号
    n = 0
    await withMockFetch(
      async () => {
        n += 1
        return fakeRes({ code: 4100403, msg: '登录态过期' }, 403)
      },
      async () => {
        const res = await marvisChannel.chat(RT_CRED, {
          body: { model: 'deepseek-v4-pro-external', messages: [] },
          renew: async () => {
            throw new Error('续期没成功')
          },
        })
        assert.equal(n, 1, '续期失败不再打上游')
        assert.equal(res.status, 401)
        assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
      },
    )

    // 续期成功但重发仍 401 → 不打转：renew 只调一次
    n = 0
    let renewCalls = 0
    await withMockFetch(
      async () => {
        n += 1
        return fakeRes({ code: 4100403, msg: '登录态过期' }, 403)
      },
      async () => {
        const res = await marvisChannel.chat(RT_CRED, {
          body: { model: 'deepseek-v4-pro-external', messages: [] },
          renew: async (current) => {
            renewCalls += 1
            return { ...current }
          },
        })
        assert.equal(renewCalls, 1, '只重试一次，防打转')
        assert.equal(n, 2)
        assert.equal(res.status, 401)
        assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
      },
    )
  })
}
