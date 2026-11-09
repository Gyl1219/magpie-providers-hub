// 多供应商层的行为契约。
//
// 只测「错了会静默出错」的地方：供应商 id 映射、模型分派、未登录回落、登录入口。
// 不测「能 import」这类没有诊断价值的断言。
//
// ⚠️ v0.5.0 起只有五条渠道（officeace / autoclaw / loomy / minimaxintl 已删），
//    本文件统一拿 **astudio** 当被测渠道（它字段齐全：beginLogin/refresh/expired/
//    catalog/chat/usage/checkin），别再引用已删的渠道文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUB_PLUGINS, REGISTERED_CHANNELS, PROVIDER_IDS } from '../index.mjs'
import { tierSummarize, providerIdOf, providerNameOf } from '../src/aggregate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 建一个供应商实例（默认 astudio）。 */
const build = async (options = {}, exportName = 'HubAStudioPlugin') => {
  const plugin = await HUB_PLUGINS[exportName]({}, options)
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, cfg, provider: cfg.provider[plugin.provider.id] }
}

test('每个实例只注册自己那一条（七条必备 + 本机按需渠道）', async () => {
  for (const id of ["hub-astudio","hub-accio","hub-lobsterai","hub-magicrew","hub-magicrew-intl","hub-autoclaw","hub-autoclaw-cn"]) assert.ok(PROVIDER_IDS.includes(id), `七条必备渠道缺 ${id}`)
  // 数量随环境变（本机多出按需渠道），发布包恒为七条 —— 一致性比绝对数重要
  assert.equal(PROVIDER_IDS.length, REGISTERED_CHANNELS.length, '每个渠道一个供应商')
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length, '供应商 id 必须唯一')
  for (const id of PROVIDER_IDS) assert.match(id, /^hub-[a-z0-9-]+$/, `供应商 id 必须是 ASCII：${id}`)
  for (const [exportName, makePlugin] of Object.entries(HUB_PLUGINS)) {
    const plugin = await makePlugin({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const keys = Object.keys(cfg.provider)
    assert.equal(keys.length, 1, `${exportName} 只能注册一个供应商，实际：${keys.join(',')}`)
    assert.ok(PROVIDER_IDS.includes(keys[0]), `${exportName} 注册的 id 不在名单里：${keys[0]}`)
    assert.equal(plugin.provider.id, keys[0], `${exportName} 的 provider.id 与 config 键不一致`)
    assert.equal(plugin.auth.provider, keys[0], `${exportName} 的 auth.provider 与 provider.id 不一致`)
  }
})

test('登录入口：oauth 在前、粘贴型在后（灵犀两条，其余一条）', async () => {
  for (const [exportName, makePlugin] of Object.entries(HUB_PLUGINS)) {
    const plugin = await makePlugin({}, {})
    const methods = plugin.auth.methods
    assert.ok(methods.length >= 1 && methods.length <= 2, `${exportName} 入口数异常：${methods.length}`)
    const apiIndexes = methods.map((m, i) => (m.type === 'api' ? i : -1)).filter((i) => i >= 0)
    const oauthMethods = methods.filter((m) => m.type === 'oauth')
    // oauth 入口必须在前（主路径），粘贴型入口在后（兜底）
    for (const i of apiIndexes) assert.equal(i, methods.length - 1, `${exportName}: 粘贴型入口必须在最后`)
    for (const m of oauthMethods) {
      // 默认文案是「登录 <显示名>」；渠道可用 loginMethods 自定义（灵犀写成「浏览器登录…」）
      assert.ok(typeof m.label === 'string' && m.label.length > 0, `${exportName}: oauth 入口要有标签`)
      assert.equal(typeof m.authorize, 'function')
    }
    for (const m of methods.filter((x) => x.type === 'api')) {
      assert.ok(typeof m.label === 'string' && m.label.length > 0, `${exportName}: api 入口要有标签`)
      assert.equal(m.authorize, undefined, 'api 入口不该有 authorize（不是 oauth 流程）')
    }
  }
})

test('目录里的模型 id 不再带渠道前缀（一个供应商只有一个渠道）', async () => {
  for (const [exportName, makePlugin] of Object.entries(HUB_PLUGINS)) {
    const plugin = await makePlugin({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const models = await plugin.provider.models(cfg.provider[plugin.provider.id])
    const ids = Object.keys(models)
    // 未登录且渠道没有兜底目录时可以是空的（登录后由 catalog 填充）——
    // 但只要非空，key 就是裸模型名。
    for (const id of ids) {
      // MonkeyCode 的 `monkeycode-{basic,pro,ultra}/…` 前缀是**上游平台的订阅档位
      // 命名空间**（发到网关的模型 id 原样带它），不是渠道前缀 —— 白名单放行。
      if (/^monkeycode-(basic|pro|ultra)\//.test(id)) continue
      assert.doesNotMatch(id, /\//, `${exportName} 的模型 id 不该带前缀：${id}`)
    }
  }
})

test('未登录也不返回空目录（回落兜底，选择器不会空掉）', async () => {
  const { plugin, provider } = await build()
  const models = await plugin.provider.models(provider)
  assert.ok(Object.keys(models).length > 0, '未登录时目录不应为空')
})

test('models() 用 magpie 传进来的 auth 拉远端目录（冷启动内存为空也不掉成兜底）', async () => {
  // 真机 2026-10-31：v0.5.0 去掉旁路凭据文件后，凭据只在内存，冷启动那一刻为空
  // ⇒ 不认 magpie 的第二参 auth 就永远拉不到远端目录（magicrew 卡片显示「0 models」，
  //   而它的兜底表是空的）。magpie 调 models() 时会把当前账号的 auth 传进来。
  const { astudioChannel } = await import('../src/astudio.mjs')
  const seen = []
  const originalCatalog = astudioChannel.catalog
  const originalExpired = astudioChannel.expired
  astudioChannel.catalog = async (credential) => {
    seen.push(credential)
    return { 'remote-only-model': { name: 'R', limit: { context: 1000, output: 100 }, tool_call: true } }
  }
  astudioChannel.expired = () => false
  try {
    const { plugin, provider } = await build()
    const models = await plugin.provider.models(provider, {
      auth: { type: 'success', channel: 'astudio', access_token: 'tok' },
    })
    assert.equal(seen.length, 1, 'ctx.auth 在位时必须去拉远端目录')
    assert.ok(Object.keys(models).includes('remote-only-model'), '目录应来自远端（不是兜底表）')
  } finally {
    astudioChannel.catalog = originalCatalog
    astudioChannel.expired = originalExpired
  }
})

test('别的供应商的模型打到本供应商 → 404（不静默转发到本渠道）', async () => {
  const { plugin } = await build()
  const { fetch: pluginFetch } = await plugin.auth.loader()
  // 本实例是 astudio，下面这些都不是它的模型
  for (const model of ['hub-accio/gpt-x', 'hub-magicrew/glm-x', '不存在的渠道/模型']) {
    const response = await pluginFetch('http://127.0.0.1/x', {
      method: 'POST',
      body: JSON.stringify({ model }),
    })
    assert.equal(response.status, 404, `${model} 应 404`)
  }
})

test('三种模型写法都认得：裸名 / hub-<渠道>/名 / 旧 渠道id/名', async () => {
  const { plugin } = await build()
  const { astudioChannel } = await import('../src/astudio.mjs')
  const seen = []
  const originalChat = astudioChannel.chat
  astudioChannel.chat = async (credential, { body }) => {
    seen.push(body.model)
    return Response.json({ ok: true })
  }
  const originalExpired = astudioChannel.expired
  astudioChannel.expired = () => false
  try {
    const { fetch: pluginFetch } = await plugin.auth.loader(async () => ({
      type: 'success', channel: astudioChannel.id, accessToken: 'a',
    }))
    for (const model of ['spark-x', 'hub-astudio/spark-x', 'astudio/spark-x']) {
      const res = await pluginFetch('http://127.0.0.1/x', {
        method: 'POST',
        body: JSON.stringify({ model }),
      })
      assert.equal(res.status, 200, `${model} 应被接受`)
    }
  } finally {
    astudioChannel.chat = originalChat
    astudioChannel.expired = originalExpired
  }
  // 发给上游的 model 必须是裸名
  assert.deepEqual(seen, ['spark-x', 'spark-x', 'spark-x'])
})

test('astudio refresh：SSO 活着 → 重换 api_key + 端点表；会话死（80000）→ 终态「请重新登录」', async () => {
  // 2026-11-01 真机：推理网关随 configs 行内 base_url 下发（会搬家），api_key 按次
  // 下发短时有效 → refresh 必须带回端点表，chat 才能按行路由。
  const { astudioChannel } = await import('../src/astudio.mjs')
  const original = globalThis.fetch
  const credential = { accessToken: 'OLD', ssoSessionId: 'sso', accountId: 'acc', token: 't' }
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        code: 0,
        data: [{ model: 'spark-x2.6', base_url: 'https://maas-api.test/v2/', api_key: 'NEW-KEY' }],
      }), { status: 200 })
    const next = await astudioChannel.refresh(credential)
    assert.equal(next.accessToken, 'NEW-KEY', '应返回重取后的 api_key')
    assert.deepEqual(next.endpoints, [{ model: 'spark-x2.6', baseUrl: 'https://maas-api.test/v2', apiKey: 'NEW-KEY' }],
      '应带端点表（base_url 去尾斜杠）')
    assert.equal(next.ssoSessionId, 'sso', 'SSO 会话字段原样保留')

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 80000, desc: '登录异常，请重新登录' }), { status: 200 })
    await assert.rejects(
      () => astudioChannel.refresh(credential),
      (error) => /重新登录/.test(error.message) && error.signIn === 'expired',
      '会话死 = 终态 notSignedIn，magpie 据此提示重新登录',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('页面只读快照，不调 magpie.read（magpie 的 read 只服务两个内建项，自造名被拒）', () => {
  const app = readFileSync(join(ROOT, 'page/app.js'), 'utf8')
  assert.doesNotMatch(app, /magpie\.read\s*\(/, '页面不得调用 magpie.read（服务端只认 usage:summary / providers:list）')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.magpie.reads, undefined, '不应声明自造 read 名（会被服务端拒绝）')
  // 页面不提供假登录按钮：登录入口是供应商编辑器的 auth.methods（magpie 原生）
  assert.doesNotMatch(app, /magpie\.read\("login"/)
})

test('账号槽的 type=' + "'success'" + ' 也要认，且只出本渠道的桶', async () => {
  // 真机 bug：登录回调写 type:'success'，而 authOfChannel 只判 'oauth'
  // → 永不匹配 → 每个账号槽掉进旁路兜底 → 每张卡额度都一样。
  const { plugin } = await build({ notify: false })
  const { astudioChannel } = await import('../src/astudio.mjs')
  const originalLogin = astudioChannel.beginLogin
  const originalUsage = astudioChannel.usage
  const originalExpired = astudioChannel.expired
  astudioChannel.beginLogin = async () => ({
    url: 'https://auth.example',
    result: Promise.resolve({ accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
  })
  astudioChannel.usage = async () => [{ name: 'astudio-only', used: 0, amount: 42 }]
  astudioChannel.expired = () => false
  try {
    const handle = await plugin.auth.methods[0].authorize()
    const auth = await handle.callback()
    assert.equal(auth.type, 'success')
    assert.equal(auth.channel, astudioChannel.id)
    const usage = await plugin.auth.usage(async () => auth)
    assert.equal(usage.windows.length, 1)
    assert.equal(usage.windows[0].name, 'astudio-only', '桶名不该再带渠道前缀')
    assert.equal(usage.windows[0].amount, 42)
  } finally {
    astudioChannel.beginLogin = originalLogin
    astudioChannel.usage = originalUsage
    astudioChannel.expired = originalExpired
  }
})


test('usage：窗口的 amount/limit/unit 必须透传（托盘 2026-11-02 改版后靠它们渲染「x / y」）', async () => {
  const { makeHubPlugin } = await import('../src/aggregate.mjs')
  const channel = {
    id: 'shape-probe',
    displayName: '形状探针',
    fallbackModels: {},
    usage: async () => [{
      name: '智点 · 永久',
      used: 3,
      display: '剩余 1100 / 1100 智点',
      amount: 12,
      limit: 1100,
      unit: '智点',
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
    }],
  }
  const plugin = await makeHubPlugin(channel)({}, { notify: false, snapshotRefreshMinutes: 0 })
  const out = await plugin.auth.usage(async () => ({ type: 'oauth', channel: 'shape-probe', key: 'x' }))
  const w = out.windows[0]
  assert.equal(w.amount, 12, 'amount（已用）必须透传 —— 托盘靠它渲染「x / y」')
  assert.equal(w.limit, 1100, 'limit（总量）必须透传')
  assert.equal(w.unit, '智点', 'unit 必须透传')
  assert.equal(w.resetsAt !== undefined, true, 'resetsAt 也要在（走势投影线）')
})

test('usage：无数值的纯文本窗口不被强加数字字段', async () => {
  const { makeHubPlugin } = await import('../src/aggregate.mjs')
  const channel = {
    id: 'shape-probe-plain',
    displayName: '纯文本探针',
    fallbackModels: {},
    usage: async () => [{ name: '额度', display: '未配置 AK/SK，读不到额度' }],
  }
  const plugin = await makeHubPlugin(channel)({}, { notify: false, snapshotRefreshMinutes: 0 })
  const out = await plugin.auth.usage(async () => ({ type: 'oauth', channel: 'shape-probe-plain', key: 'x' }))
  const w = out.windows[0]
  assert.equal(w.amount, undefined, '没有数值就不要编 amount')
  assert.equal(w.limit, undefined)
})
test('供应商 id / 显示名映射：hub- 前缀 + 中文名', () => {
  const byId = Object.fromEntries(REGISTERED_CHANNELS.map((c) => [providerIdOf(c), providerNameOf(c)]))
  assert.equal(byId['hub-astudio'], 'AStudio（讯飞）')
  assert.equal(byId['hub-magicrew'], '超级麦吉 (MagiCrew 国内)')
  assert.ok(Object.values(byId).every((name) => typeof name === 'string' && name.length > 0))
  // 已删渠道的 provider id 不许再出现
  // ⚠️ hub-autoclaw / hub-autoclaw-cn 已在 v0.6.x 重新实现（粘贴 + 读桌面端），不在此列
  // ⚠️ hub-loomy 已于 v0.8.0 回归（微信扫码 = #614 差异），不在此列
  for (const gone of ['hub-officeace', 'hub-minimaxintl']) {
    assert.equal(byId[gone], undefined, `${gone} 已从包里删除`)
  }
})

// ── 三档汇总（指针方案 A）───────────────────────────────────────────────

test('tierSummarize：≤3 桶原样返回；>3 桶汇总成 临期(指针)/长期/永久', () => {
  // 小组数渠道（≤3 桶）保留原始命名 —— 信息更足
  const small = [
    { name: '个人体验版', used: 0, amount: 500 },
    { name: '新用户福利', used: 0, amount: 3994, resetsAt: '2026-11-12T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 100, resetsAt: '2026-10-26T15:59:59Z' },
  ]
  // ≤3 桶保留原命名，但 runsOutAt 剥掉（浅灰行去重 —— 渠道行带它只是分类输入）；
  // ⚠️ resetsAt **保留**：走势图的 even-burn 投影虚线只认它（2026-10-31 真机）
  const smallOut = tierSummarize(small)
  assert.equal(smallOut.length, 3)
  assert.ok(smallOut.every((w) => w.runsOutAt === undefined), '≤3 桶的 runsOutAt 剥掉')
  assert.equal(smallOut[1].resetsAt, '2026-11-12T00:00:00Z', 'resetsAt 必须留着（虚线依据）')
  assert.equal(smallOut[0].resetsAt, undefined, '本来就没有的不会凭空出现')
  assert.equal(smallOut[1].amount, 3994, '其余字段原样保留')

  // 多批次形态：8 桶（7 笔不同到期批次 + 1 永久）→ 3 桶
  const many = [
    { name: '登录奖励', used: 0, amount: 500, resetsAt: '2026-10-26T14:47:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-26T14:58:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-29T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-30T00:00:00Z' },
    { name: '登录奖励', used: 0, amount: 500, resetsAt: '2026-10-30T12:53:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-10-31T00:00:00Z' },
    { name: '每日签到', used: 0, amount: 200, resetsAt: '2026-11-01T00:00:00Z' },
    { name: '永久奖励', used: 0, amount: 10550 },
  ]
  const out = tierSummarize(many)
  assert.equal(out.length, 3, '8 桶 → 3 桶')
  const pointer = out.find((w) => w.name.startsWith('临期'))
  // 指针桶 = 最早到期的那一批，amount 只算它自己（数字必须如实）
  assert.equal(pointer.amount, 500)
  assert.equal(pointer.runsOutAt, undefined, '三档桶不挂 runsOutAt（display 已带倒计时，再挂会出第三行浅灰重复）')
  const longTerm = out.find((w) => w.name.includes('长期'))
  assert.equal(longTerm.amount, 200 + 200 + 200 + 500 + 200 + 200, '其余 6 批合计')
  assert.equal(longTerm.runsOutAt, undefined, '长期桶同样不挂 runsOutAt（浅灰行去重）')
  // ⚠️ 但两档都要带 resetsAt：magpie 的走势投影虚线（even burn）只认窗口终点，
  //   删了就只有空坐标轴（2026-10-31 真机：LobsterAI 卡片没虚线）。
  assert.equal(pointer.resetsAt, '2026-10-26T14:47:00Z', '临期桶带 resetsAt（= 最早到期那批）')
  assert.equal(longTerm.resetsAt, '2026-10-26T14:58:00Z', '长期桶带 resetsAt（= 剩余批次里最早的那批）')
  const permanent = out.find((w) => w.name.includes('永久'))
  assert.equal(permanent.amount, 10550)
  assert.equal(permanent.resetsAt, undefined)
  // 桶序：临期在前（红桶即现在烧的）
  assert.ok(out[0].name.startsWith('临期'))
})

test('tierSummarize：状态条/失败条透传、不可求和的桶不动', () => {
  const rows = [
    { name: 'a', used: 0, amount: 1, resetsAt: '2026-10-27T00:00:00Z' },
    { name: 'b', used: 0, amount: 2, resetsAt: '2026-10-28T00:00:00Z' },
    { name: 'c', used: 0, amount: 3, resetsAt: '2026-10-29T00:00:00Z' },
    { name: 'd', used: 0, amount: 4, resetsAt: '2026-10-30T00:00:00Z' },
    { name: '状态条', used: 0, display: '已登录' },               // 无 amount → 透传
    { name: '失败条', used: 0, display: '额度查询失败：xx' },      // 无 amount → 透传
  ]
  const out = tierSummarize(rows)
  assert.ok(out.some((w) => w.name === '状态条'), '状态条透传')
  assert.ok(out.some((w) => w.display === '额度查询失败：xx'), '失败条透传')
  assert.equal(out.filter((w) => w.name.startsWith('临期')).length, 1)
  // 只有一条永久时保留原名（信息更足）
  const single = tierSummarize([
    { name: '星火积分', used: 0, amount: 60000 },
    { name: 'a', used: 0, amount: 1, resetsAt: '2026-10-27T00:00:00Z' },
    { name: 'b', used: 0, amount: 2, resetsAt: '2026-10-28T00:00:00Z' },
    { name: 'c', used: 0, amount: 3, resetsAt: '2026-10-29T00:00:00Z' },
  ])
  assert.ok(single.some((w) => w.name === '星火积分'), '单条永久保留原命名')
})

test('MonkeyCode 档位前缀模型不再 404（`monkeycode-{basic,pro,ultra}/…` 是上游订阅档位命名空间）', async () => {
  // 真机 2026-11-09：`monkeycode-basic/deepseek-v4-flash` 发网关 200，裸
  // `deepseek-v4-flash` 403 无权；resolve 把档位前缀误判成"别的供应商的前缀"
  // 直接 404（magpie 侧表现为"无法识别的模型"）。
  for (const exportName of ['HubMonkeycodePlugin', 'HubMonkeycodeIntlPlugin']) {
    const plugin = await HUB_PLUGINS[exportName]({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const { fetch: pluginFetch } = await plugin.auth.loader(async () => undefined)
    const ok = await pluginFetch('http://lubbock.invalid/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'monkeycode-basic/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(ok.status, 404, `${exportName}: 档位模型不应 404（无账号时应走未登录 401）`)
    const miss = await pluginFetch('http://lubbock.invalid/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'other-vendor/some-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(miss.status, 404, `${exportName}: 未知模型仍应 404`)
  }
})
