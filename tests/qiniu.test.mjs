// 七牛云渠道（全部 stub fetch，不发真实请求）。
//
// ⚠️ 本渠道是**移植**：上游 lakegan/opencode-qiniu-auth（MIT），
//    见 magpie-community/plugins PR #374 及 src/qiniu.mjs 文件头。
//    这里覆盖三件容易回归的事：
//      ① 模型 key ↔ 完整 id 的映射（id 带斜杠，聚合层只取最后一段）；
//      ② 免费模型排在 agent 能看到的前 24 个里（否则渠道主打的东西 agent 看不到）；
//      ③ AK/SK 用量口径（`total` 要乘 unit_size_default，否则少三个数量级）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-qiniu-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const {
  qiniuChannel,
  QINIU_CATALOG,
  QINIU_BASE,
  QINIU_FREE_MODEL_FILTER,
  QINIU_ACTIVITY_ENDS_AT,
  qiniuPrettify,
  qiniuPlanKeys,
  qiniuSortModelIds,
  qiniuSignToken,
  qiniuShanghaiDay,
  qiniuRfc3339,
  qiniuTokenFactor,
  qiniuSumUsage,
  qiniuResolveDailyLimit,
  qiniuReadCredentials,
  qiniuResolveUpstreamId,
  qiniuResetModelCache,
} = await import('../src/qiniu.mjs')

test.after(() => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
})

const CRED = { key: 'sk-FAKE_API_KEY' }

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('127.0.0.1')) return original(input, init)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, calls, init })
    }
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 鉴权形态 ──────────────────────────────────────────────────────────

test('鉴权：单条粘贴型入口（只填 API Key 一格）', async () => {
  const { makeHubPlugin } = await import('../src/aggregate.mjs')
  const plugin = await makeHubPlugin(qiniuChannel)({}, { notify: false })
  assert.equal(plugin.auth.provider, 'hub-qiniu')
  assert.equal(plugin.auth.methods.length, 1, '七牛云只有粘贴型登录（没有浏览器登录）')
  const method = plugin.auth.methods[0]
  assert.equal(method.type, 'api')
  assert.match(method.label, /API Key/)
  assert.match(method.placeholder, /sk-/)
  assert.equal(qiniuChannel.apiAuth.keyField, 'key')
  // ⚠️ 关键：只有一格（与 magpie「自定义供应商」一样轻）。
  //    早前把 AK/SK/档位做成问项，登录要填四格，真机还被填成同一个 key。
  assert.equal(method.prompts, undefined, '登录不该再问 AK/SK/档位')
  assert.equal(qiniuChannel.apiAuth.credentialFields, undefined)
  assert.equal(qiniuChannel.beginLogin, undefined, '没有浏览器登录入口')
})

test('鉴权：登录只带 API Key，chat 走真实链路（模型短名 → 完整 id）', async () => {
  const { makeHubPlugin } = await import('../src/aggregate.mjs')
  // 走真实的调用链：aggregate 的 loader → 渠道 chat，断言上游收到的 Authorization
  const plugin = await makeHubPlugin(qiniuChannel)({}, { notify: false })
  const auth = { type: 'api', key: 'sk-KEY' }
  const loader = await plugin.auth.loader(async () => auth)
  const stub = stubFetch([{ match: '/chat/completions', respond: () => json({ ok: true }) }])
  try {
    await loader.fetch('https://placeholder.invalid/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-qiniu/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const sent = stub.calls.find((c) => c.url.includes('/chat/completions'))
    assert.match(sent.url, /^https:\/\/api\.qnaigc\.com\/v1\/chat\/completions$/)
    assert.equal(sent.headers.authorization, 'Bearer sk-KEY')
    // 上游模型名必须是**完整 id**（目录短名 → vendor/model）
    assert.equal(JSON.parse(sent.body).model, 'deepseek/deepseek-v4-pro')
  } finally {
    stub.restore()
  }
})

test('鉴权：插件 options 真的能传进 usage（AK/SK 靠它，不靠登录问项）', async () => {
  const { makeHubPlugin } = await import('../src/aggregate.mjs')
  // options 是 magpie 交给插件的那一份（`magpie plugin options <插件> '{…}'` 写的）
  const plugin = await makeHubPlugin(qiniuChannel)({}, {
    notify: false,
    qiniuAccessKey: 'AK_FROM_OPTIONS',
    qiniuSecretKey: 'SK_FROM_OPTIONS',
  })
  const auth = { type: 'api', key: 'sk-KEY' }
  const stub = stubFetch([{
    match: '/ai/inapi/v3/stat/new',
    respond: () => json({
      status: true,
      data: [{ name: 'qiniu/conatus-free', items: [{ key: 'output', unit_name: 'token', unit_size_default: 1000, total: 3 }] }],
    }),
  }])
  try {
    const res = await plugin.auth.usage(async () => auth)
    assert.equal(res.windows.length, 1)
    assert.match(res.windows[0].display, /今日已用 3000/, '读到真数字 = options 里的 AK/SK 生效了')
    assert.match(stub.calls[0].headers.authorization, /^Qiniu AK_FROM_OPTIONS:/)
  } finally {
    stub.restore()
  }
})

// ── 模型目录 ──────────────────────────────────────────────────────────

test('模型命名：厂商 + 型号，去掉重复前缀', () => {
  assert.equal(qiniuPrettify('qiniu/conatus-free'), 'Conatus Free')
  assert.equal(qiniuPrettify('deepseek/deepseek-v4-pro'), 'DeepSeek V4 Pro')
  assert.equal(qiniuPrettify('moonshotai/kimi-k2.7-code'), 'Moonshot Kimi K2.7 Code')
  assert.equal(qiniuPrettify('bytedance/doubao-seed-2-1-pro'), 'ByteDance Doubao Seed 2.1 Pro')
  assert.equal(qiniuPrettify('MiniMax-M1'), 'MiniMax M1')
  assert.equal(qiniuPrettify('qwen3-coder-480b-a35b-instruct'), 'Qwen3 Coder 480b A35b Instruct')
})

test('模型 key：去掉厂商前缀且唯一；顺序无关（评审第 5 条）', () => {
  const ids = QINIU_CATALOG.map((row) => String(row[0]))
  const keys = qiniuPlanKeys(ids)
  assert.equal(new Set([...keys.values()]).size, ids.length, '91 个模型必须有 91 个不同的 key')
  for (const key of keys.values()) assert.ok(!key.includes('/'), `key 不能含斜杠：${key}`)
  // 同一份列表，倒序传入 → 同一份映射
  const reversed = qiniuPlanKeys([...ids].reverse())
  for (const id of ids) assert.equal(keys.get(id), reversed.get(id))
})

test('排序：免费模型在最前（agent 只看得到前 24 个，评审第 1 条）', () => {
  const ids = QINIU_CATALOG.map((row) => String(row[0]))
  const order = qiniuSortModelIds(ids)
  const first24 = order.slice(0, 24)
  assert.equal(first24[0], 'qiniu/conatus-free', 'conatus 固定第一')
  for (const free of ids.filter((id) => /-free$/.test(id))) {
    assert.ok(first24.includes(free), `免费模型 ${free} 必须在 agent 能看到的前 24 个里`)
  }
})

test('目录：线上列表优先，快照里已下线的模型不再出现（评审第 3 条）', async () => {
  qiniuResetModelCache()
  const liveRows = [
    { id: 'deepseek/deepseek-v4-pro', context_length: 1000000, max_tokens: 384000 },
    { id: 'qiniu/conatus-free', context_length: 1000000, max_tokens: 128000 },
  ]
  const stub = stubFetch([{ match: '/v1/models', respond: () => json({ data: liveRows }) }])
  try {
    const models = await qiniuChannel.catalog(CRED)
    assert.deepEqual(Object.keys(models).sort(), ['conatus-free', 'deepseek-v4-pro'])
    // ⚠️ 线上那条路也必须排序：magpie 只取前 24 个给 agent
    assert.equal(Object.keys(models)[0], 'conatus-free', '线上目录同样把 conatus 排第一')
    // 快照里有、线上没有的（`kimi-k2`）绝不能留着
    assert.equal(models['kimi-k2'], undefined, '线上没有的模型必须消失')
    assert.equal(models['conatus-free'].name, 'Conatus Free')
    assert.equal(models['conatus-free'].limit.context, 1000000)
    assert.equal(models['conatus-free'].free, true)
    for (const row of Object.values(models)) {
      assert.equal(row.id, undefined, '目录行不能带 id（会与聚合层 resolve 打架）')
    }
  } finally {
    stub.restore()
  }
})

test('目录：线上失败 → 回落快照（未登录/断网也看得到模型）', async () => {
  qiniuResetModelCache()
  const stub = stubFetch([{ match: '/v1/models', respond: () => json({ error: 'boom' }, 500) }])
  try {
    const models = await qiniuChannel.catalog(CRED)
    assert.equal(Object.keys(models).length, QINIU_CATALOG.length)
    assert.ok(models['conatus-free'], '快照必须有 conatus')
  } finally {
    stub.restore()
  }
})

test('目录：线上返回空列表 → 回落快照（不返回空目录）', async () => {
  qiniuResetModelCache()
  const stub = stubFetch([{ match: '/v1/models', respond: () => json({ data: [] }) }])
  try {
    const models = await qiniuChannel.catalog(CRED)
    assert.equal(Object.keys(models).length, QINIU_CATALOG.length)
  } finally {
    stub.restore()
  }
})

test('兜底目录：未登录也出模型（顺序与线上一致）', async () => {
  const models = qiniuChannel.fallbackModels
  const keys = Object.keys(models)
  assert.equal(keys.length, QINIU_CATALOG.length)
  assert.equal(keys[0], 'conatus-free', '兜底目录同样把 conatus 排第一')
  assert.equal(models['GLM-5.3']?.name ?? models['glm-5.3']?.name, 'Z.ai GLM 5.3')
})

test('能力位：instruct 不算思考模型，视觉模型标 image', () => {
  const models = qiniuChannel.fallbackModels
  assert.equal(models['qwen3-coder-480b-a35b-instruct'].reasoning, false, 'instruct 必须排除（评审第 3 条）')
  assert.equal(models['deepseek-v4-pro'].reasoning, true)
  assert.deepEqual(models['conatus-free'].modalities.input, ['text', 'image'])
  assert.deepEqual(models['deepseek-r1'].modalities.input, ['text'])
})

// ── 对话 ──────────────────────────────────────────────────────────────

test('对话：短名还原成完整 id，透传流式请求，返回原始 Response', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }),
  }])
  try {
    const res = await qiniuChannel.chat(CRED, {
      body: { model: 'kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    assert.equal(await res.text(), 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
    const sent = stub.calls[0]
    assert.equal(sent.headers.authorization, 'Bearer sk-FAKE_API_KEY')
    const payload = JSON.parse(sent.body)
    assert.equal(payload.model, 'moonshotai/kimi-k3', '上游要的是完整 id')
    assert.equal(payload.stream, true)
    assert.equal(sent.url, `${QINIU_BASE}/chat/completions`)
  } finally {
    stub.restore()
  }
})

test('对话：完整 id 与未知串都能透传（不猜 id）', () => {
  assert.equal(qiniuResolveUpstreamId('deepseek-v4-pro'), 'deepseek/deepseek-v4-pro')
  assert.equal(qiniuResolveUpstreamId('deepseek/deepseek-v4-pro'), 'deepseek/deepseek-v4-pro')
  assert.equal(qiniuResolveUpstreamId('some/future-model'), 'some/future-model')
})

test('对话：key 失效（401 auth_api_key_invalid）→ 补 x-magpie-sign-in: expired', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ error: { code: 'auth_api_key_invalid', message: 'invalid api key' } }, 401),
  }])
  try {
    const res = await qiniuChannel.chat(CRED, { body: { model: 'kimi-k3', messages: [] } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
    // 响应体仍然可读（剥了 content-length 但内容要完整）
    assert.match(await res.text(), /auth_api_key_invalid/)
  } finally {
    stub.restore()
  }
})

test('对话：普通 401 不标记重新登录（交给 magpie 常规处理）', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => json({ error: { message: 'quota exceeded' } }, 401),
  }])
  try {
    const res = await qiniuChannel.chat(CRED, { body: { model: 'kimi-k3', messages: [] } })
    assert.equal(res.headers.get('x-magpie-sign-in'), null)
  } finally {
    stub.restore()
  }
})

test('对话：未登录 / 缺模型 / 连不上 都给明确错误（不抛）', async () => {
  const noKey = await qiniuChannel.chat({}, { body: { model: 'kimi-k3' } })
  assert.equal(noKey.status, 401)
  assert.match((await noKey.json()).error.message, /未登录/)

  const noModel = await qiniuChannel.chat(CRED, { body: {} })
  assert.equal(noModel.status, 400)

  const stub = stubFetch([{ match: '/chat/completions', respond: () => { throw new Error('ECONNREFUSED') } }])
  try {
    const broken = await qiniuChannel.chat(CRED, { body: { model: 'kimi-k3', messages: [] } })
    assert.equal(broken.status, 502)
    assert.match((await broken.json()).error.message, /连接七牛云失败/)
  } finally {
    stub.restore()
  }
})

// ── 额度 ──────────────────────────────────────────────────────────────

test('用量签名：与官方签名规则一致（GET 无 body 的签名串形态）', () => {
  const ak = 'MY_ACCESS_KEY'
  const sk = 'MY_SECRET_KEY'
  const path = '/ai/inapi/v3/stat/new?g=day&start=2026-10-24T00%3A00%3A00%2B08%3A00'
  const host = 'api.qiniu.com'
  // 独立算一遍签名串（不调被测代码的拼装分支），比对 header
  const signing = `GET ${path}\nHost: ${host}\n\n`
  const expected = `${ak}:${createHmac('sha1', sk).update(signing).digest().toString('base64').replace(/\+/g, '-').replace(/\//g, '_')}`
  assert.equal(qiniuSignToken(ak, sk, 'GET', path, host), expected) // 无 content-type 时不做 base64 padding 之外的加工
})

test('用量签名：urlsafe base64、对 method/path/host 敏感', () => {
  const token = qiniuSignToken('ak', 'sk', 'GET', '/a', 'api.qiniu.com')
  assert.match(token, /^ak:[A-Za-z0-9\-_]+=*$/, 'urlsafe base64，保留 = 填充')
  assert.notEqual(token, qiniuSignToken('ak', 'sk', 'POST', '/a', 'api.qiniu.com'))
  assert.notEqual(token, qiniuSignToken('ak', 'sk', 'GET', '/b', 'api.qiniu.com'))
  assert.notEqual(token, qiniuSignToken('ak', 'other', 'GET', '/a', 'api.qiniu.com'))
})

test('用量口径：total 必须乘 unit_size_default，否则少三个数量级', () => {
  assert.equal(qiniuTokenFactor({ key: 'output', unit_name: 'token', unit_size_default: 1000 }), 1000)
  assert.equal(qiniuTokenFactor({ key: 'output', unit_name: 'token' }), 1)
  assert.equal(qiniuTokenFactor({ key: 'requests', unit_name: '次' }), 0)
  const payload = {
    status: true,
    data: [{
      name: 'qiniu/conatus-free',
      items: [
        { key: 'cache', unit_name: 'token', unit_size_default: 1000, total: 537.1 },
        { key: 'ncache', unit_name: 'token', unit_size_default: 1000, total: 708.14 },
        { key: 'output', unit_name: 'token', unit_size_default: 1000, total: 15.73 },
      ],
    }],
  }
  assert.equal(qiniuSumUsage(payload).tokens, Math.round((537.1 + 708.14 + 15.73) * 1000))
})

test('用量窗口口径：北京时间零点重置（resetsAt 给走势虚线用）', () => {
  const now = Date.parse('2026-10-24T20:52:00+08:00')
  const { start, end } = qiniuShanghaiDay(now)
  assert.equal(new Date(start).toISOString(), '2026-10-23T16:00:00.000Z')
  assert.equal(new Date(end).toISOString(), '2026-10-24T16:00:00.000Z')
  assert.equal(qiniuRfc3339(start), '2026-10-24T00:00:00+08:00')
})

test('用量：没 AK/SK → 一行提示、**不报错、不出百分比**（缺省不是故障）', async () => {
  const rows = await qiniuChannel.usage(CRED, {})
  assert.equal(rows.length, 1)
  const [w] = rows
  assert.match(w.display, /未配 AK\/SK/)
  assert.match(w.display, /无剩余额度接口/, '要说清七牛没有剩余额度接口')
  // ⚠️ 关键：不能带 used —— 带了 magpie 会画「剩余 100%」，那是编数据
  assert.equal(w.used, undefined, '没数据就不能有进度条')
  assert.equal(w.limit, undefined)
  assert.equal(w.resetsAt, undefined, '没读到用量就给不出重置点')
})

test('用量：AK/SK 被填成 API Key（真机槽里三个字段同一串）→ 当未配置，不报错', async () => {
  // 2026-11-01 真机：登录对话框的可选问项被填成 sk-… 本身，
  // 早前这里抛错，magpie 渲染成「额度查询失败：Secretke…」+ 假的「剩余 100%」
  const same = { options: { qiniuAccessKey: CRED.key, qiniuSecretKey: CRED.key } }
  const rows = await qiniuChannel.usage(CRED, same)
  assert.equal(rows.length, 1)
  assert.match(rows[0].display, /SecretKey 填成了 API Key/)
  assert.equal(rows[0].used, undefined, '不能出假百分比')
})

test('用量：填了 AK/SK → 只报已用量，不编百分比（没声明档位）', async () => {
  const stub = stubFetch([{
    match: '/ai/inapi/v3/stat/new',
    respond: () => json({
      status: true,
      data: [{ name: 'qiniu/conatus-free', items: [{ key: 'output', unit_name: 'token', unit_size_default: 1000, total: 2.5 }] }],
    }),
  }])
  try {
    const rows = await qiniuChannel.usage(CRED, { options: { qiniuAccessKey: 'AK', qiniuSecretKey: 'SK' } })
    assert.equal(rows.length, 1)
    const [w] = rows
    assert.equal(w.name, '今日已用')
    assert.equal(w.limit, undefined, '不能编一个上限出来 —— 窗口到 100% 会让 magpie 挂起账号')
    assert.equal(w.used, undefined)
    assert.match(w.display, /今日已用 2500/)
    assert.match(w.display, /qiniuDailyQuota/, '要说清怎么才能看到剩余')
    assert.equal(typeof w.resetsAt, 'string', 'reset 语义要靠 resetsAt 表达')
    assert.equal(w.resetsAt, new Date(qiniuShanghaiDay().end).toISOString())
    // 签名头确实带上了，且路径含查询串
    assert.match(stub.calls[0].headers.authorization, /^Qiniu AK:/)
    assert.match(stub.calls[0].url, /stat\/new\?/)
  } finally {
    stub.restore()
  }
})

test('用量：声明档位 → 百分比窗口，且只统计免费模型', async () => {
  const stub = stubFetch([{
    match: '/ai/inapi/v3/stat/new',
    respond: () => json({
      status: true,
      data: [
        { name: 'qiniu/conatus-free', items: [{ key: 'output', unit_name: 'token', unit_size_default: 1000, total: 100 }] },
        { name: 'deepseek/deepseek-v4-pro', items: [{ key: 'output', unit_name: 'token', unit_size_default: 1000, total: 500 }] },
      ],
    }),
  }])
  try {
    const rows = await qiniuChannel.usage(
      CRED,
      { options: { qiniuAccessKey: 'AK', qiniuSecretKey: 'SK', qiniuActivityTier: 'verified' } },
    )
    const [w] = rows
    assert.equal(w.name, '今日额度')
    assert.equal(w.limit, 1e8)
    assert.equal(w.amount, 100_000, '只算免费模型那 100 个 total（×1000）')
    assert.equal(w.display, '今日剩余 9990 万 / 共 1 亿 Token（已用 10 万）', '与控制台同一套中文量词')
    assert.ok(w.used > 0)
    // modelFilter 传给了用量接口（只有档位模式下才过滤成 -free）
    assert.match(stub.calls[0].headers.authorization, /^Qiniu AK:/)
    assert.equal(QINIU_FREE_MODEL_FILTER, '-free')
  } finally {
    stub.restore()
  }
})

test('用量：手填 dailyQuota 优先，且不受活动截止影响', () => {
  assert.deepEqual(qiniuResolveDailyLimit({ qiniuDailyQuota: 12345 }), { limit: 12345, source: 'dailyQuota' })
  assert.equal(qiniuResolveDailyLimit({ qiniuDailyQuota: 12345 }, Date.parse('2027-01-01T00:00:00+08:00')).limit, 12345)
  assert.equal(qiniuResolveDailyLimit({}).limit, 0, '都没填 = 不出百分比')
  assert.equal(qiniuResolveDailyLimit({}).source, null)
})

test('用量：档位名填错 → 明确抛错（别让用户对着「没额度」猜）', () => {
  assert.throws(() => qiniuResolveDailyLimit({ qiniuActivityTier: 'verifed' }), /qiniuActivityTier 填错了/)
  assert.throws(() => qiniuResolveDailyLimit({ qiniuActivityTier: 'verifed' }), /verified/)
})

test('用量：活动截止后档位不再算额度（不编造）', () => {
  const after = Date.parse(`${QINIU_ACTIVITY_ENDS_AT}T23:59:59+08:00`) + 1000
  const resolved = qiniuResolveDailyLimit({ qiniuActivityTier: 'verified' }, after)
  assert.equal(resolved.limit, 0)
  assert.equal(resolved.expired, true)
})

test('用量：AK/SK 从插件 options 读，只报「配没配好」，永不抛错', () => {
  assert.equal(qiniuReadCredentials({}).configured, false)
  assert.match(qiniuReadCredentials({}).hint, /未配 AK\/SK/)
  assert.match(qiniuReadCredentials({ qiniuAccessKey: 'AK', qiniuSecretKey: 'sk-xxx' }).hint, /qiniuSecretKey 填成了 API Key/)
  assert.match(qiniuReadCredentials({ qiniuAccessKey: 'sk-xxx', qiniuSecretKey: 'SK' }).hint, /qiniuAccessKey 填成了 API Key/)
  assert.equal(qiniuReadCredentials({ qiniuAccessKey: 'AK' }).configured, false, '只配一半 = 没配，不是错')
  assert.deepEqual(
    qiniuReadCredentials({ qiniuAccessKey: 'AK', qiniuSecretKey: 'SK' }),
    { configured: true, accessKey: 'AK', secretKey: 'SK' },
  )
})

test('用量：AK/SK 被拒（401）→ 卡片上说清原因，且不画假进度条', async () => {
  const stub = stubFetch([{ match: '/ai/inapi/v3/stat/new', respond: () => json({ error: 'bad token' }, 401) }])
  try {
    const rows = await qiniuChannel.usage(CRED, { options: { qiniuAccessKey: 'AK', qiniuSecretKey: 'SK' } })
    assert.equal(rows.length, 1)
    assert.match(rows[0].display, /七牛拒绝了 AK\/SK/)
    assert.equal(rows[0].used, undefined, '读失败也不能出百分比')
  } finally {
    stub.restore()
  }
})

// ── 签到 ──────────────────────────────────────────────────────────────

test('签到：七牛没有签到端点 → inactive（绝不用 failed）', () => {
  assert.equal(qiniuChannel.checkin().outcome, 'inactive')
})

test('额度窗口是「重置型」：源码不手拼带作废时间的档位名', async () => {
  // 门禁（AGENTS.md 第 1 条）覆盖：渠道源码出现「带作废时间的额度包」逻辑才需要 banding，
  // 七牛云只有「每日重置」窗口（rescio 同款），所以这里断言窗口只靠 resetsAt 表达。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'qiniu.mjs'), 'utf8')
  assert.ok(!src.includes('到期'), '重置型渠道不该出现「到期」口径')
  assert.ok(!/expiryBandedWindows|assignExpiryBands/.test(src), '本渠道没有作废包，不需要滚动指针工具')
})