// AutoClaw 协议铁律回归（国内 + 国际一套实现两份常量）。
// 全 stub fetch / 隔离 APPDATA；每条用例对应上游真机取证的一条约束。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoclawChannel,
  autoclawIntlChannel,
  normalizeCredential,
  displayNickname,
  expired,
  prepareMessages,
  clampMaxTokens,
  effortForRequest,
  normalizeModel,
  isQuotaError,
  isAuthError,
  parseLedgerBatches,
  parseRemoteModels,
} from '../src/autoclaw.mjs'

// ── 406 绕过（上游约束：messages[0] 必须逐字等于白名单前缀）─────────────

test('prepareMessages：首条 system 拆两条（[0] 过检、[1] 保人设）；非 system 前置', () => {
  const out = prepareMessages([
    { role: 'system', content: '你是编码助手' },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, 'You are AutoClaw. Answer the user directly and concisely')
  assert.equal(out[1].content, '你是编码助手', '原生人设完整保留在 messages[1]')
  assert.equal(out[2].role, 'user')
  // 已含前缀 → 剥离避免重复
  const out2 = prepareMessages([{ role: 'system', content: 'You are AutoClaw. Answer the user directly and concisely. 补充说明' }])
  assert.equal(out2[0].content, 'You are AutoClaw. Answer the user directly and concisely')
  assert.equal(out2[1].content, '补充说明')
  // 首条不是 system → 前置
  const out3 = prepareMessages([{ role: 'user', content: 'hi' }])
  assert.equal(out3[0].content, 'You are AutoClaw. Answer the user directly and concisely')
  assert.equal(out3[1].role, 'user')
  // 已是白名单 → 原样透传
  const exact = [{ role: 'system', content: 'You are AutoClaw. Answer the user directly and concisely' }]
  assert.deepEqual(prepareMessages(exact), exact)
})

// ── max_tokens / 档位（官方阈值 + 本地门禁）──────────────────────────────

test('max_tokens：不发 / floor 10000（官方阈值，低于 406）/ 按声明夹上限', () => {
  assert.equal(clampMaxTokens(undefined, 131072), undefined, '未指定 → 不发（网关默认），绝不编造')
  assert.equal(clampMaxTokens(2000, 131072), 10000, '低于官方阈值抬到 10000（不是编造的 16384）')
  assert.equal(clampMaxTokens(500000, 393216), 393216, '超模型声明上限夹住')
  assert.equal(clampMaxTokens(50000, undefined), 50000, '声明未知时只做下限')
})

test('档位门禁：非法档位不发 reasoning_effort（上游回 200 按最贵档跑 —— 静默烧钱）', () => {
  assert.deepEqual(effortForRequest('high'), { effort: 'high' })
  assert.deepEqual(effortForRequest(undefined), { effort: undefined })
  const dropped = effortForRequest('turbo')
  assert.equal(dropped.effort, undefined, 'turbo 不在 {low,high,max} → 不发')
  assert.equal(dropped.dropped, 'turbo', '丢弃必须留痕')
})

test('模型归一：裸名 → zai_ 前缀；zaicoding_ 直通', () => {
  assert.equal(normalizeModel('glm-5.3-flash'), 'zai_glm-5.3-flash')
  assert.equal(normalizeModel('glm-5.3'), 'zaicoding_glm-5.3')
  assert.equal(normalizeModel('auto'), 'zai_auto')
  assert.equal(normalizeModel('zaicoding_glm-5.3'), 'zaicoding_glm-5.3')
  assert.equal(normalizeModel(''), 'zai_glm-5.3-flash')
})

// ── 凭据：JWT exp 权威 + refresh 空 = 可用不可续期 ────────────────────────

/** 造一个带 exp/user_id 的假 JWT（payload 不签名 —— 上游网关也只读不验签）。 */
function fakeJwt({ exp, user_id = 839684 } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ exp, user_id })}.${b64({ sig: 'x' })}`
}

test('normalizeCredential：JWT exp 优先于声明值（声明偏大 6 天是真实 P0）；refresh 空 = 可用', () => {
  const jwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
  const cred = normalizeCredential({ access_token: jwt, refresh_token: '', expires_at: Date.now() + 7 * 86400_000 })
  assert.ok(cred !== undefined, 'refresh 空 → 仍可用（可用 ≠ 可续期）')
  assert.ok(Math.abs(cred.expires_at - (Date.now() + 3600_000)) < 5000, 'JWT exp 是权威，不用偏大 6 天的声明值')
  assert.equal(cred.user_id, '839684', 'user_id 从 JWT 兜底（登录/续期响应都不下发）')
  // 无 refresh 也不是错 —— 只有 access 是硬条件
  assert.equal(cred.refresh_token, '')
  // 裸 access（非 JWT）也认（导入路径可能拿到非 JWT 形态）
  assert.ok(normalizeCredential({ access_token: 'at_secret_token_123' }) !== undefined)
})

test('expired：提前 10 分钟；无过期信息保守未过期', () => {
  assert.equal(expired({ expires_at: Date.now() + 5 * 60_000 }), true)
  assert.equal(expired({ expires_at: Date.now() + 30 * 60_000 }), false)
  assert.equal(expired({}), false)
})

test('displayNickname：脱敏手机号 → 用户名 → 用户<id>', () => {
  assert.equal(displayNickname({ user_phone: '13800138000' }), '138****8000')
  assert.equal(displayNickname({ user_name: '张三' }), '张三')
  assert.equal(displayNickname({ user_id: 123 }), '用户123')
  assert.equal(displayNickname(undefined, 'fallback'), 'fallback')
})

// ── 错误分类（先额度、再认证 —— 顺序不可颠倒）────────────────────────────

test('错误分类：先额度后认证（智谱报文可能两类词都含，颠倒会把充值错报成登录）', () => {
  assert.ok(isQuotaError('当前账号 token 有效但积分余额不足'))
  assert.ok(isQuotaError('Insufficient credits'))
  assert.ok(!isQuotaError('invalid token'))
  assert.ok(isAuthError('Invalid token'))
  assert.ok(isAuthError('用户未登录'))
  // 混合报文 → 必须归额度（去充值），不是去登录
  assert.ok(isQuotaError('token valid but 余额不足'))
})

// ── 流水批次（净额口径 + 守恒前置件）─────────────────────────────────────

test('流水批次：净额 = credit − debit − expire；负 credit 丢弃；过期批次丢弃；永久按描述分列', () => {
  const now = Date.now()
  const future = Math.floor(now / 1000) + 86400
  const past = Math.floor(now / 1000) - 86400
  const batches = parseLedgerBatches([
    { mutation_type: 'credit', amount: 200, wallet_expires_at: future, description: '每日签到' },
    { mutation_type: 'debit', amount: -50, wallet_expires_at: future },   // 消耗归批次
    { mutation_type: 'expire', amount: -10, wallet_expires_at: past },    // 已过期批次直接丢
    { mutation_type: 'credit', amount: 100, description: undefined, source: '注册奖励' },  // 永久
    { mutation_type: 'credit', amount: -30, description: '冲正' },       // 负 credit（冲正）丢弃
    { mutation_type: 'credit', amount: 500, wallet_expires_at: past, description: '早过期' },
    { mutation_type: 'transfer', amount: 99 },                            // 未知类型不认
  ], now)
  const expiring = batches.find((b) => b.expiresAtMs !== undefined)
  assert.equal(expiring.remaining, 150, '净额口径：200 − 50（消耗精确归入批次）')
  const permanent = batches.find((b) => b.expiresAtMs === undefined)
  assert.equal(permanent.remaining, 100)
  assert.equal(permanent.name, '注册奖励', '永久桶按描述分列')
  assert.equal(batches.length, 2, '过期批次 / 冲正 / 未知类型全丢弃')
})

// ── 远端目录（照抄桌面端规则）────────────────────────────────────────────

test('远端目录：ctx>=1e3、maxTokens<ctx 否则丢条、input 只认 text/image', () => {
  const parsed = parseRemoteModels({ models: [
    { id: 'zai_auto', contextWindow: 1048576, maxTokens: 393216, input: ['text', 'image'] },
    { id: 'bad1', contextWindow: 500, maxTokens: 100 },                        // ctx < 1e3 → 不采纳 ctx
    { id: 'bad2', contextWindow: 1048576, maxTokens: 2097152 },                // max > 1e6 → 不采纳
    { id: 'bad3', contextWindow: 100000, maxTokens: 200000, input: [] },       // max >= ctx → 丢条
  ] })
  assert.equal(parsed.get('zai_auto').supportsImage, true)
  assert.equal(parsed.get('zai_auto').maxOutputTokens, 393216)
  assert.equal(parsed.get('bad1').contextWindow, undefined, 'ctx<1e3 不采纳')
  assert.equal(parsed.get('bad2').maxOutputTokens, undefined, 'max>1e6 不采纳')
  assert.equal(parsed.get('bad3').maxOutputTokens, undefined, 'maxTokens 必须 < contextWindow')
})

// ── 渠道对象（两渠道同一实现、不同常量）──────────────────────────────────

test('两渠道：id/显示名/基址分离；兜底模型表 4 条全带 (AutoClaw) 后缀与三档', () => {
  assert.equal(autoclawChannel.id, 'autoclaw')
  assert.equal(autoclawIntlChannel.id, 'autoclawintl')
  const ids = Object.keys(autoclawChannel.fallbackModels)
  assert.equal(ids.length, 4)
  for (const id of ids) {
    const m = autoclawChannel.fallbackModels[id]
    assert.match(m.name, /\(AutoClaw\)$/, '跨渠道平铺需品牌后缀区分')
    assert.deepEqual(m.options.reasoning_efforts, ['low', 'high', 'max'], '只声明三个端点档（实测相邻档无差异）')
    assert.equal(m.options.default_reasoning_effort, 'high', '官方推荐默认档')
  }
  // 国际版模型表与国内逐字节相同（上游实测两站通用）
  assert.deepEqual(Object.keys(autoclawIntlChannel.fallbackModels), ids)
})

// ── chat 请求形状（X-Version 硬校验 + 406 前缀 + 档位门禁落盘）────────────

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    // ⚠️ input 可能是 string / Request / URL —— URL 对象没有 .url 字段（.href 才有）
    const url = typeof input === 'string' ? input : String(input?.url ?? input?.href ?? input)
    calls.push({ url, init })
    for (const r of routes) if (url.includes(r.match)) return r.respond({ url, init, calls })
    return new Response('{}', { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('chat 请求：X-Version/X-Auth-Sign/X-Authorization 头 + messages[0] 过检前缀 + 档位过滤', async () => {
  const stub = stubFetch([{
    match: 'chat/completions',
    respond: () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }),
  }])
  try {
    const response = await autoclawChannel.chat(
      { access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) },
      {
        body: {
          model: 'glm-5.3',
          messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
          max_tokens: 2000,
          reasoning_effort: 'turbo',
        },
        signal: AbortSignal.timeout(5000),
      },
    )
    assert.equal(response.status, 200)
    const call = stub.calls[0]
    // 头形状：X-Version 硬校验头必须在（缺 → 上游 500 空响应体）
    assert.equal(call.init.headers['X-Version'], '2.1.1')
    assert.ok(call.init.headers['X-Auth-Sign'].length === 32, 'MD5 签名 32 hex')
    assert.match(call.init.headers['X-Authorization'], /^Bearer /)
    assert.equal(call.init.headers['X-Request-Model'], 'zaicoding_glm-5.3', '模型归一')
    // 体形状
    const sent = JSON.parse(call.init.body)
    assert.equal(sent.messages[0].content, 'You are AutoClaw. Answer the user directly and concisely')
    assert.equal(sent.messages[1].content, '你是助手')
    assert.equal(sent.max_tokens, 10000, '2000 → 抬到官方阈值')
    assert.equal(sent.reasoning_effort, undefined, 'turbo 被本地门禁拦下（不发）')
    assert.equal(sent.stream, true)
    // 国际站打国际基址
    assert.ok(call.url.includes('zhipuai.cn'))
  } finally {
    stub.restore()
  }
  // 国际渠道打国际基址（同一实现、不同常量）
  const stub2 = stubFetch([{
    match: 'chat/completions',
    respond: () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }])
  try {
    await autoclawIntlChannel.chat({ access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }, {
      body: { model: 'zai_auto', messages: [{ role: 'user', content: 'x' }] },
      signal: AbortSignal.timeout(5000),
    })
    assert.ok(stub2.calls[0].url.includes('autoglm.ai'), '国际版必须打 autoglm-api.autoglm.ai')
  } finally {
    stub2.restore()
  }
})

// ── 签到（幂等判据在响应体字段，不在状态码）──────────────────────────────

test('签到：true=claimed / false=done；上游不返回积分数量（不编造 credit）', async () => {
  for (const [flag, outcome] of [[true, 'claimed'], [false, 'done']]) {
    const stub = stubFetch([{
      match: '/userapi/v1/user-info',
      respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u1', daily_check_in_completed_on_request: flag } }), { status: 200 }),
    }])
    try {
      const result = await autoclawChannel.checkin({ access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), device_id: 'dev-1' })
      assert.equal(result.outcome, outcome)
      if (flag) assert.ok(result.message.includes('不返回积分数量'), '如实说明，不显示 +0 让用户以为白签')
      const sent = JSON.parse(stub.calls[0].init.body)
      assert.equal(sent.device_id, 'dev-1', '凭据的 device_id 优先（写死常量 = 风控把不同用户当同一台设备）')
    } finally {
      stub.restore()
    }
  }
})

// ── 钱包（display:false 丢弃 —— 「每日 0」红字根因）──────────────────────

test('usage：display:false 池丢弃；批次守恒成立用批次、不成立回退钱包包', async () => {
  const walletResp = { code: 0, data: { total_balance: 150, wallets: [
    { public_wallet_type: 'reward', display_name: '奖励积分', balance: 150, display: true, priority: 1 },
    { public_wallet_type: 'daily', display_name: '每日积分', balance: 0, display: false, priority: 2 },
  ] } }
  const future = Math.floor(Date.now() / 1000) + 86400
  const ledgerResp = { code: 0, data: { entries: [
    { mutation_type: 'credit', amount: 200, wallet_expires_at: future, description: '签到奖励' },
    { mutation_type: 'debit', amount: -50, wallet_expires_at: future },
  ] } }
  const stub = stubFetch([
    { match: 'wallets', respond: () => new Response(JSON.stringify(walletResp), { status: 200 }) },
    { match: 'ledgers_std', respond: ({ init, url }) => {
      assert.ok(String(url).includes('flow_direction=all'), '只拉 income 拿不到 debit —— 批次恒不守恒')
      return new Response(JSON.stringify(ledgerResp), { status: 200 })
    } },
  ])
  try {
    const windows = await autoclawChannel.usage({ access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) })
    const batch = windows.find((w) => w.name === '签到奖励')
    assert.ok(batch !== undefined, '守恒成立（150 = 200−50）→ 用批次（带 resetsAt）')
    assert.ok(batch.runsOutAt !== undefined, '批次带 runsOutAt（tierSummarize 的分类输入；输出层剥掉）')
    assert.ok(!windows.some((w) => w.name === '每日积分'), 'display:false 的池必须丢弃')
  } finally {
    stub.restore()
  }
})

// ── 历史形态修复 + 措辞清洗（社区 0.2.9 / 0.2.10，plugins#437 / #466）──
test('tidyWire：网关读不了的历史形态就地修好（否则 500 parse response failed）', async () => {
  const { tidyWire } = await import('../src/autoclaw.mjs')
  const wire = tidyWire({
    model: 'x',
    messages: [
      { role: 'system', content: 'ok' },
      { role: 'assistant', content: null, reasoning_content: '上轮思考' , tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } } },
      ] },
      { role: 'tool', content: 'r', tool_call_id: 'c1' },
    ],
    tools: [],
    tool_choice: 'auto',
  })
  assert.equal(wire.messages[1].content, '', 'null content → ""')
  assert.equal(wire.messages[1].reasoning_content, undefined, '上轮 reasoning_content 去掉')
  assert.equal(wire.messages[1].tool_calls[0].function.arguments, '{"a":1}', 'arguments 不是字符串 → JSON')
  assert.equal(wire.tools, undefined, 'tools 空数组 → 删除')
  assert.equal(wire.tool_choice, undefined, 'tool_choice 一并删除')
})

test('tidyWire：别家 agent 的开场白指纹被改写（否则 406），用户对话内容不碰', async () => {
  const { tidyWire } = await import('../src/autoclaw.mjs')
  const wire = tidyWire({
    messages: [
      { role: 'system', content: 'You are Claude Code. This conversation is powered by GLM-5.3. You are CodeBuddy Code.' },
      { role: 'user', content: 'You are Claude Code 是什么？' },
    ],
  })
  const sys = wire.messages[0].content
  assert.ok(!/You are Claude Code/.test(sys), 'Claude Code 指纹被改写')
  assert.ok(!/powered by GLM-5\.3/.test(sys), 'GLM 开场白被改写')
  assert.ok(!/You are CodeBuddy Code/.test(sys), 'CodeBuddy 指纹被改写')
  assert.match(sys, /Claude Code CLI|CodeBuddy Code CLI|GLM-5\.3 model/)
  assert.equal(wire.messages[1].content, 'You are Claude Code 是什么？', '用户消息不动')
})

// ── 国际版 OAuth：上游现发授权页 + state 校验（2026-10-29 真机修复）───────
//
// 旧实现硬编码打开 https://chat.z.ai/auth（网页端），未登录访客被 CDN 按 IP
// 弹「请切换至中国站点」→ 授权永远回不了回调端口。新实现：
//   引导页 → POST <overseasv1>/<vendor>-oauth-url（上游现发授权页 + state）
//   → 302 回 /auth/callback-<vendor> → state 逐字校验 → <vendor>-oauth-login。
// 三条铁律各有用例钉死。

const rawFetch = globalThis.fetch  // 本地服务的请求必须走真 fetch（stub 只拦上游域）
/** 本地端口的请求带上重试：上一个用例的服务器刚 close（TIME_WAIT/未完全释放）时偶发 ECONNRESET。 */
const localFetch = async (url, init, tries = 4) => {
  let last
  for (let i = 0; i < tries; i += 1) {
    try { return await rawFetch(url, init) } catch (e) { last = e; await new Promise((r) => setTimeout(r, 120)) }
  }
  throw last
}
const intlLoginStub = () => {
  const issued = { url: '', state: '' }
  const stub = stubFetch([
    {
      match: '/userapi/overseasv1/zai-oauth-url',
      respond: () => {
        issued.state = 'S-' + Math.random().toString(36).slice(2, 8)
        issued.url = `https://auth.z.ai/authorize?client_id=client_x&state=${issued.state}&redirect_uri=http%3A%2F%2Flocalhost%3A18432%2Fauth%2Fcallback-zai`
        return new Response(JSON.stringify({ code: 0, data: { oauth_url: issued.url } }), { status: 200 })
      },
    },
    {
      match: '/userapi/overseasv1/zai-oauth-login',
      respond: ({ init }) => {
        const body = JSON.parse(init.body)
        if (body.state !== issued.state) {
          return new Response(JSON.stringify({ code: 40100, msg: 'state mismatch' }), { status: 200 })
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: 'rt-new',
            user_name: 'tester',
          },
        }), { status: 200 })
      },
    },
  ])
  return { stub, issued }
}

test('国际版登录：选择页两按钮 → vendor 步骤页带滑块 → 缺回执 open-auth 拒绝', async () => {
  const { stub, issued } = intlLoginStub()
  let openedUrl = ''
  const flow = await autoclawIntlChannel.beginLogin((u) => { openedUrl = u })
  try {
    assert.match(openedUrl, /^http:\/\/localhost:\d+\/$/, '打开的是本地引导页，不是授权网站')
    assert.doesNotMatch(openedUrl, /chat\.z\.ai/, '绝不直接打开 chat.z.ai（会弹中国站跳转）')
    // 选择页：两按钮（Google / z.ai）
    const pick = await (await rawFetch(new URL('/', openedUrl))).text()
    assert.match(pick, /vendor=google/, '选择页要有 Google 按钮')
    assert.match(pick, /vendor=zai/, '选择页要有 z.ai 按钮')
    // vendor 步骤页：滑块步骤（上游 enabled:true，缺回执会被误导性文案挡住）
    const html = await (await rawFetch(new URL('/?vendor=zai', openedUrl))).text()
    assert.match(html, /captchaBox|initAliyunCaptcha/, 'vendor 步骤页必须带滑块步骤')
    assert.doesNotMatch(html, /chat\.z\.ai/, '页面里不出现网页端地址')
    // 缺滑块回执 → open-auth 明确拒绝（不发生误导性「版本已停止服务」）
    const deny = await (await rawFetch(new URL('/open-auth', openedUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'zai' }),
    })).json()
    assert.match(deny.error ?? '', /滑块/)
    // /captcha 收回执 → open-auth 放行：上游现发授权页 + 记下 state
    await rawFetch(new URL('/captcha', openedUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt: 'aliyun-receipt-stub' }),
    })
    const r = await rawFetch(new URL('/open-auth', openedUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'zai' }),
    })
    const j = await r.json()
    assert.equal(j.error, undefined, `open-auth 不应报错：${j.error ?? ''}`)
    assert.equal(j.url, issued.url, '授权页地址必须是上游现发的')
    assert.match(j.url, /state=/)
  } finally {
    stub.restore()
    await flow.close?.()
  }
})

test('国际版登录：回调 state 校验（不符拒收）+ 符合才换 token', async () => {
  const { stub, issued } = intlLoginStub()
  const flow = await autoclawIntlChannel.beginLogin(undefined)
  try {
    await localFetch(new URL('/captcha', flow.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt: 'aliyun-receipt-stub' }),
    })
    await localFetch(new URL('/open-auth', flow.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'zai' }),
    })
    // ① 伪造 state → 拒收（不触发 oauth-login）
    const bad = await localFetch(`http://localhost:${new URL(flow.url).port}/auth/callback-zai?code=evil&state=WRONG`)
    assert.match(await bad.text(), /未通过校验|state 与本会话不一致/);
    // vendor 宽容匹配：google 回调路径同样能被收（state 对即可）
    const gpath = await localFetch(`http://localhost:${new URL(flow.url).port}/auth/callback-google?code=g&state=${encodeURIComponent(issued.state)}`)
    assert.match(await gpath.text(), /已收到/, 'google 回调路径也要收（上游 302 的路径以其注册为准）')
    // ② state 原样带回 → 换 token 成功，result 兑现
    const good = await localFetch(`http://localhost:${new URL(flow.url).port}/auth/callback-zai?code=good-code&state=${encodeURIComponent(issued.state)}`)
    assert.match(await good.text(), /已收到/)
    const credential = await Promise.race([
      flow.result,
      new Promise((_, rej) => setTimeout(() => rej(new Error('result 未兑现')), 8000)),
    ])
    assert.equal(credential.access_token, fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    assert.equal(credential.refresh_token, 'rt-new')
  } finally {
    stub.restore()
    await flow.close?.()
  }
})

test('国际版登录：换 token 走 <vendor>-oauth-login（zai/google 同构）', async () => {
  const { stub } = intlLoginStub()
  const flow = await autoclawIntlChannel.beginLogin(undefined)
  try {
    await localFetch(new URL('/captcha', flow.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt: 'aliyun-receipt-stub' }),
    })
    await localFetch(new URL('/open-auth', flow.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'zai' }),
    })
    await localFetch(`http://localhost:${new URL(flow.url).port}/auth/callback-zai?code=c&state=${encodeURIComponent('S-wrong-on-purpose')}`)
    // state 错 → oauth-login 不该被调过（只有校验通过才换）
    await new Promise((r) => setTimeout(r, 400))
    const exchangeCalls = stub.calls.filter((c) => c.url.includes('-oauth-login'))
    assert.equal(exchangeCalls.length, 0, 'state 校验失败绝不能去换 token')
    assert.ok(stub.calls.some((c) => c.url.includes('zai-oauth-url')), 'oauth-url 被调用过')
  } finally {
    stub.restore()
    await flow.close?.()
  }
})