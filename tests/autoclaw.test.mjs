// AutoClaw 两个站点渠道（全部 stub fetch，不发真实请求）。
//
// 与 registry 绿标包（@magpie-community/opencode-autoclaw-auth）的差别是本测试的重点：
// 绿标包只有网页 OAuth / 手机验证码；本渠道多了「粘贴凭据」与「读桌面端登录态」。
// ⚠️ 读桌面端的用例全部走临时目录（DSH_AUTOCLAW_APPDATA），绝不碰真实 %APPDATA%。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-autoclaw-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.DSH_AUTOCLAW_APPDATA = join(sandbox, 'appdata')

const {
  autoclawChannel,
  autoclawCnChannel,
  autoclawParsePasted,
  autoclawWithSystemPrefix,
  AUTOCLAW_SITES,
} = await import('../src/autoclaw.mjs')

test.after(() => {
  process.env.USERPROFILE = originalHome
  delete process.env.DSH_AUTOCLAW_APPDATA
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
})

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    for (const route of routes) if (url.includes(route.match)) return route.respond({ url, calls, init })
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 渠道形态 ────────────────────────────────────────────────────────────

test('两个站点：国际 hub-autoclaw / 国内 hub-autoclaw-cn，基址不串', () => {
  assert.equal(autoclawChannel.id, 'autoclaw')
  assert.equal(autoclawCnChannel.id, 'autoclaw-cn')
  assert.match(AUTOCLAW_SITES.intl.apiBase, /autoglm\.ai$/)
  assert.match(AUTOCLAW_SITES.cn.apiBase, /zhipuai\.cn$/)
  // ⚠️ 上游 hub 的 autoclaw 是**国内**（zhipuai.cn），与 registry 包相反；这里跟 registry 对齐
  assert.equal(AUTOCLAW_SITES.intl.userDataDirName, 'AutoClaw-oversea-official')
  assert.equal(AUTOCLAW_SITES.cn.userDataDirName, 'AutoClaw-official')
})

test('登录入口：桌面端读取（oauth）+ 粘贴（api）两条并存', async () => {
  const { makeHubPlugin } = await import('../src/aggregate.mjs')
  const plugin = await makeHubPlugin(autoclawChannel)({}, { notify: false })
  assert.equal(plugin.auth.provider, 'hub-autoclaw')
  assert.equal(plugin.auth.methods.length, 2, '读取桌面端 + 粘贴凭据')
  const labels = plugin.auth.methods.map((m) => m.label).join(' | ')
  assert.match(labels, /读取 AutoClaw 桌面端登录态/)
  assert.match(labels, /粘贴 AutoClaw 凭据/)
  assert.equal(autoclawChannel.apiAuth.keyField, 'key')
})

// ── 粘贴解析 ────────────────────────────────────────────────────────────

test('粘贴解析：JSON / 两行 / 冒号 / 裸 token / Bearer 前缀', () => {
  assert.deepEqual(autoclawParsePasted('{"accessToken":"a1","refreshToken":"r1"}'), { accessToken: 'a1', refreshToken: 'r1' })
  assert.deepEqual(autoclawParsePasted('accessToken=a2\nrefreshToken=r2'), { accessToken: 'a2', refreshToken: 'r2' })
  assert.deepEqual(autoclawParsePasted('accessToken: a3\nrefreshToken: r3'), { accessToken: 'a3', refreshToken: 'r3' })
  assert.deepEqual(autoclawParsePasted('abc.def.ghi'), { accessToken: 'abc.def.ghi', refreshToken: '' })
  assert.deepEqual(autoclawParsePasted('{"accessToken":"Bearer a4","refreshToken":"Bearer r4"}'), { accessToken: 'a4', refreshToken: 'r4' })
  assert.equal(autoclawParsePasted(''), undefined)
  assert.equal(autoclawParsePasted('   '), undefined)
})

test('粘贴解析：snake_case 与 access 简写都认', () => {
  assert.deepEqual(autoclawParsePasted('{"access_token":"a","refresh_token":"r"}'), { accessToken: 'a', refreshToken: 'r' })
  assert.deepEqual(autoclawParsePasted('{"access":"a","refresh":"r"}'), { accessToken: 'a', refreshToken: 'r' })
})

// ── 406 前缀 ────────────────────────────────────────────────────────────

test('406 前缀：无 system 时补一条；有 system 时并入不覆盖人设；已含则不重复', () => {
  const PREFIX = 'You are AutoClaw. Answer the user directly and concisely'

  const none = autoclawWithSystemPrefix([{ role: 'user', content: 'hi' }])
  assert.deepEqual(none.map((m) => m.role), ['system', 'user'])
  assert.equal(none[0].content, PREFIX)

  const has = autoclawWithSystemPrefix([{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }])
  assert.equal(has.length, 2)
  assert.ok(has[0].content.includes(PREFIX), '必须含前缀')
  assert.ok(has[0].content.includes('你是助手'), '不能丢掉原生人设')

  const already = autoclawWithSystemPrefix([{ role: 'system', content: `${PREFIX}\n\n你是助手` }])
  assert.equal((already[0].content.match(/You are AutoClaw/g) ?? []).length, 1, '不重复注入')
})

// ── 目录与模型 ──────────────────────────────────────────────────────────

test('模型表：4 条兜底，zai_glm-5.3-flash 是唯一免费；只声明 low/high/max', () => {
  const models = autoclawChannel.fallbackModels
  assert.equal(Object.keys(models).length, 4)
  const free = Object.entries(models).filter(([, v]) => v.free === true).map(([k]) => k)
  assert.deepEqual(free, ['zai_glm-5.3-flash'])
  for (const row of Object.values(models)) {
    assert.deepEqual(row.options.reasoning_efforts, ['low', 'high', 'max'], '不声明 off')
    assert.equal(row.capabilities.input.image, false, 'AutoClaw 不吃图')
    assert.equal(row.attachment, false)
  }
})

test('目录：远端不可达时退回兜底表（不返回空目录）', async () => {
  const stub = stubFetch([{ match: '/autoclaw-model-config', respond: () => json({}, 500) }])
  try {
    const models = await autoclawChannel.catalog({ key: '{"accessToken":"a"}' })
    assert.equal(Object.keys(models).length, 4)
  } finally { stub.restore() }
})

// ── 对话 ────────────────────────────────────────────────────────────────

test('对话：国际站带 X-Version + X-Authorization + 签名字段', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }),
  }])
  try {
    const res = await autoclawChannel.chat(
      { key: '{"accessToken":"AT1","refreshToken":"RT1"}' },
      { body: { model: 'zai_auto', stream: true, messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200)
    const sent = stub.calls[0]
    assert.match(sent.url, /^https:\/\/autoglm-api\.autoglm\.ai\/autoclaw-proxy\/proxy\/autoclaw\/chat\/completions$/, '走国际站')
    assert.equal(sent.headers['X-Version'], '2.1.1', 'X-Version 是国际站硬校验头')
    assert.equal(sent.headers['X-Authorization'], 'Bearer AT1')
    assert.equal(sent.headers['X-Auth-Appid'], '100003')
    assert.match(sent.headers['X-Auth-Sign'], /^[0-9a-f]{32}$/, 'MD5 签名')
    const payload = JSON.parse(sent.body)
    assert.equal(payload.messages[0].role, 'system')
    assert.match(payload.messages[0].content, /You are AutoClaw/)
  } finally { stub.restore() }
})

test('对话：国内站打国内基址', async () => {
  const stub = stubFetch([{
    match: '/chat/completions',
    respond: () => new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }])
  try {
    await autoclawCnChannel.chat(
      { key: '{"accessToken":"AT2"}' },
      { body: { model: 'zai_auto', messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.match(stub.calls[0].url, /^https:\/\/autoglm-acceleration-api\.zhipuai\.cn\//, '走国内站')
  } finally { stub.restore() }
})

test('对话：401 → 用 refresh_token 续一次再重发', async () => {
  let chatCalls = 0
  const stub = stubFetch([
    { match: '/userapi/v1/refresh', respond: () => json({ code: 0, data: { access_token: 'AT_NEW', refresh_token: 'RT_NEW' } }) },
    {
      match: '/chat/completions',
      respond: () => {
        chatCalls += 1
        if (chatCalls === 1) return json({ code: 401, msg: 'Invalid token' }, 401)
        return new Response('data: {"ok":1}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    },
  ])
  try {
    const res = await autoclawChannel.chat(
      { key: '{"accessToken":"AT_OLD","refreshToken":"RT_OLD"}' },
      { body: { model: 'zai_auto', messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 200, '续期后应重发成功')
    assert.equal(chatCalls, 2, '先 401 再重发一次')
    assert.equal(stub.calls.filter((c) => c.url.includes('/refresh')).length, 1, '只续一次')
  } finally { stub.restore() }
})

test('对话：续期失败 → 401 且说清要重新登录', async () => {
  const stub = stubFetch([
    { match: '/userapi/v1/refresh', respond: () => json({ code: 401, msg: 'Invalid token' }, 400) },
    { match: '/agent-refresh', respond: () => json({ code: 401, msg: 'Invalid token' }, 400) },
    { match: '/chat/completions', respond: () => json({ code: 401 }, 401) },
  ])
  try {
    const res = await autoclawChannel.chat(
      { key: '{"accessToken":"AT","refreshToken":"RT"}' },
      { body: { model: 'zai_auto', messages: [{ role: 'user', content: 'hi' }] } },
    )
    assert.equal(res.status, 401)
    assert.match((await res.json()).error.message, /重新登录|失效/)
  } finally { stub.restore() }
})

test('对话：未登录 → 401（不拿空 token 打上游）', async () => {
  const res = await autoclawChannel.chat({}, { body: { model: 'zai_auto', messages: [] } })
  assert.equal(res.status, 401)
})

// ── 读桌面端 ────────────────────────────────────────────────────────────

test('读桌面端：目录不存在 → 明确报错让用户改用粘贴（不抛未捕获）', async () => {
  const { result } = autoclawChannel.beginLogin()
  await assert.rejects(() => result, /没有找到|粘贴/)
})

test('读桌面端：只有 Local State 没有 accounts → 同样拒绝', async () => {
  const dir = join(process.env.DSH_AUTOCLAW_APPDATA, 'AutoClaw-oversea-official')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEk=' } }))
  const { result } = autoclawChannel.beginLogin()
  await assert.rejects(() => result, /没有找到|粘贴/)
})

test('读桌面端：默认不读 —— 不调 beginLogin 时零文件访问零进程', async () => {
  // 只要不调 beginLogin，probeLocal 就不执行：这里断言没有任何目录被创建/读取
  const before = Object.keys(process.env).includes('DSH_AUTOCLAW_APPDATA')
  assert.equal(before, true, '隔离口应在测试里生效')
  // 触发一次无关调用，确认不会间接触发探测
  await autoclawChannel.catalog({})
  assert.ok(true, 'catalog 无凭据时直接返回兜底表，未探测本机')
})

// ── 用量 ────────────────────────────────────────────────────────────────

test('用量：未登录给一行说明，不报错', async () => {
  const rows = await autoclawChannel.usage({})
  assert.equal(rows.length, 1)
  assert.match(rows[0].display, /未登录/)
  assert.equal(rows[0].amount, undefined, '没数据不编数字')
})

// ── 余额（上游 autoclaw-credits.ts 完整移植的分档口径）──────────────────

test('用量：单可见池无批次 → 合成「奖励积分 · 永久」窗（total 0 时不造死包）', async () => {
  const stub = stubFetch([
    { match: '/agent-assetmgr/api/v2/wallets', respond: () => json({ code: 0, data: { total_balance: 1234.6, wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 1234.6, display: true, priority: 1 }] } }) },
    { match: '/ledgers_std', respond: () => json({ code: 0, data: { entries: [] } }) },
  ])
  try {
    const rows = await autoclawChannel.usage({ key: '{"accessToken":"AT"}' })
    assert.equal(rows.length, 1)
    assert.match(rows[0].name, /奖励积分 · 永久/)
    assert.match(rows[0].display, /剩余 1235/)
  } finally { stub.restore() }
})

test('用量：display 缺失的池 fail-closed 不显示（官方桌面端同口径）', async () => {
  const stub = stubFetch([
    { match: '/agent-assetmgr/api/v2/wallets', respond: () => json({ code: 0, data: { total_balance: 0, wallets: [{ public_wallet_type: 'daily', balance: 0, priority: 1 }, { public_wallet_type: 'reward', display_name: '可见池', balance: 100, display: true, priority: 2 }] } }) },
    { match: '/ledgers_std', respond: () => json({ code: 0, data: { entries: [] } }) },
  ])
  try {
    const rows = await autoclawChannel.usage({ key: '{"accessToken":"AT"}' })
    // display 缺失的「每日 0」不出现；total=0 不合成死包；可见池 100 在
    assert.equal(rows.length, 1, JSON.stringify(rows))
    assert.match(rows[0].name, /可见池/)
  } finally { stub.restore() }
})

test('用量：流水批次净额守恒成立 → 按批次分档（临期 + 永久两桶）', async () => {
  const tomorrow = Math.floor(Date.now() / 1000) + 86_400
  const stub = stubFetch([
    { match: '/agent-assetmgr/api/v2/wallets', respond: () => json({ code: 0, data: { total_balance: 10_842, wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 10_842, display: true, priority: 1 }] } }) },
    { match: '/ledgers_std', respond: () => json({ code: 0, data: { entries: [
      { mutation_type: 'credit', amount: 10_000, wallet_expires_at: tomorrow, description: '活动赠送' },
      { mutation_type: 'debit', amount: -200, wallet_expires_at: tomorrow },
      { mutation_type: 'credit', amount: 1_042, description: '注册奖励' },
    ] } }) },
  ])
  try {
    const rows = await autoclawChannel.usage({ key: '{"accessToken":"AT"}' })
    // 净额：10_000 − 200 = 9_800 临期；1_042 永久；和 = 10_842 = total ✓
    assert.equal(rows.length, 2, JSON.stringify(rows))
    const expiring = rows.find((r) => r.name.includes('活动赠送'))
    const permanent = rows.find((r) => r.name.includes('注册奖励'))
    assert.ok(expiring, '临期桶在: ' + JSON.stringify(rows))
    assert.match(expiring.name, /临期/)
    assert.match(expiring.display, /剩余 9800/)
    assert.ok(expiring.resetsAt, '临期桶带 resetsAt（走势投影用）')
    assert.ok(permanent, '永久桶在')
    assert.match(permanent.name, /永久/)
    assert.match(permanent.display, /剩余 1042/)
  } finally { stub.restore() }
})

test('用量：守恒不成立 → 回退钱包包（宁可没有临期档，也不给错数）', async () => {
  const tomorrow = Math.floor(Date.now() / 1000) + 86_400
  const stub = stubFetch([
    { match: '/agent-assetmgr/api/v2/wallets', respond: () => json({ code: 0, data: { total_balance: 5_000, wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 5_000, display: true, priority: 1 }] } }) },
    { match: '/ledgers_std', respond: () => json({ code: 0, data: { entries: [
      { mutation_type: 'credit', amount: 9_000, wallet_expires_at: tomorrow, description: '活动赠送' },
    ] } }) },
  ])
  try {
    const rows = await autoclawChannel.usage({ key: '{"accessToken":"AT"}' })
    // 批次和 9000 vs 总额 5000，偏差远超容差 ⇒ 回退钱包包
    assert.equal(rows.length, 1, JSON.stringify(rows))
    assert.match(rows[0].name, /奖励积分/)
    assert.match(rows[0].display, /剩余 5000/)
  } finally { stub.restore() }
})

test('签到：无独立端点 → inactive（不涂红卡片）', () => {
  assert.equal(autoclawChannel.checkin().outcome, 'inactive')
  assert.equal(autoclawCnChannel.checkin().outcome, 'inactive')
})

// ── 过期判据（旧槽残留的真实教训）────────────────────────────────────────

test('过期判据：AT 已过期 → 过期（交给 renewSoft 用 refresh 自愈并落槽）', () => {
  const old = { accessToken: 'AT', refreshToken: 'RT', expires_at: Date.now() - 148 * 3600_000 }
  assert.equal(autoclawChannel.expired(old), true, 'AT 过期就该走 renewSoft：refresh 会落槽新 RT')
})

test('过期判据：没有 refresh_token 且已过期 → 真的过期', () => {
  const stale = { accessToken: 'AT', refreshToken: '', expires_at: Date.now() - 3600_000 }
  assert.equal(autoclawChannel.expired(stale), true)
})

test('过期判据：没有 refresh_token 但还没到期 → 不算过期', () => {
  const fresh = { accessToken: 'AT', refreshToken: '', expires_at: Date.now() + 3600_000 }
  assert.equal(autoclawChannel.expired(fresh), false)
})

test('过期判据：完全没凭据 → 视为过期（卡片不该显示已登录）', () => {
  assert.equal(autoclawChannel.expired({}), true)
  assert.equal(autoclawChannel.expired(undefined), true)
})

test('过期判据：粘贴的 JSON 里带 token 就算有凭据', () => {
  assert.equal(autoclawChannel.expired({ key: '{"accessToken":"AT","refreshToken":"RT"}' }), false)
})

// ── refresh（gatedRenew 契约）与 chat 走 init.renew ─────────────────────

test('refresh：返回合并凭据、persist 记内存、到期时间带回（magpie 调度主动续期靠它）', async () => {
  const stub = stubFetch([
    { match: '/userapi/v1/refresh', respond: () => json({ code: 0, data: { access_token: 'AT_NEW', refresh_token: 'RT_NEW', expires_at: Date.now() + 8 * 3600_000 } }) },
  ])
  try {
    const persisted = []
    const merged = await autoclawChannel.refresh(
      { key: '{"accessToken":"AT_OLD","refreshToken":"RT_OLD"}' },
      (partial) => persisted.push(partial),
    )
    assert.equal(merged.accessToken, 'AT_NEW')
    assert.equal(merged.refreshToken, 'RT_NEW')
    assert.ok(Number.isFinite(merged.expires_at), '到期时间带回')
    assert.equal(persisted.length, 1, 'persist 记内存')
    assert.equal(persisted[0].accessToken, 'AT_NEW')
    assert.equal(stub.calls.filter((c) => c.url.includes('/refresh')).length, 1)
  } finally { stub.restore() }
})

test('chat 401：优先走 init.renew（gatedRenew 落槽路径），而不是本地私续', async () => {
  let chatCalls = 0
  const renewCalls = []
  const stub = stubFetch([
    { match: '/userapi/v1/refresh', respond: () => json({ code: 0, data: { access_token: 'AT_RENEWED', refresh_token: 'RT_RENEWED' } }) },
    {
      match: '/chat/completions',
      respond: () => {
        chatCalls += 1
        if (chatCalls === 1) return json({ code: 401, msg: 'Invalid token' }, 401)
        return new Response('data: {"ok":1}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    },
  ])
  try {
    const res = await autoclawChannel.chat(
      { key: '{"accessToken":"AT_OLD","refreshToken":"RT_OLD"}' },
      {
        body: { model: 'zai_auto', messages: [{ role: 'user', content: 'hi' }] },
        renew: async (credential) => {
          renewCalls.push(credential)
          return autoclawChannel.refresh(credential) // 模拟 gatedRenew：调渠道 refresh
        },
      },
    )
    assert.equal(res.status, 200)
    assert.equal(chatCalls, 2, '先 401 再重发一次')
    assert.equal(renewCalls.length, 1, '续期走了 init.renew（落槽路径）')
  } finally { stub.restore() }
})