// 账号导入（手动 / 文件）+ magpie 原生表单（type:'api' + keyless）。
//
// 全本地用例：不触网、不落盘到真实配置目录（tests/setup.mjs 已把 HOME 与
// DSH_HUB_SNAPSHOT_PATH 重定向到临时目录）。
//
// ⚠️ 这里验证的是真机必踩的几件事：
//   1. 官方客户端导出的 expires_at 是**秒**，本渠道 expired() 只认毫秒；
//   2. 导入入口是 magpie 原生表单（prompts 逐题问、keyless 不渲染 API key 框），
//      不再起本地页面、不监听端口；
//   3. 结果**必须带 refresh 键**（宿主 save() 只看 'refresh' in result）——第一个账号
//      以 oauth 形状交回宿主 settle 落槽，第 2..N 个插件自己 auth.set，槽 key 不互相冲掉。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseImportPayload, createImporter } from '../src/lobsterai-import.mjs'
import { lobsteraiChannel } from '../src/lobsterai.mjs'
import { makeHubPlugin } from '../src/aggregate.mjs'

const TOKEN = 'a'.repeat(48)
const REFRESH = 'r'.repeat(48)

// 官方客户端导出的形状（C:\Users\h2147\Desktop\lobsterai-1.json 实测）
const OFFICIAL = {
  user_id: 151290,
  uid: 151290,
  nickname: '170****7196',
  yid: 'urs-phoneyd.x@163.com',
  access_token: TOKEN,
  refresh_token: REFRESH,
  expires_at: 1796051474,
  account_mode: 'personal',
}

/** 建一个插件实例：记录 auth.set 的写入与 toast 文案。 */
const build = async (channel = lobsteraiChannel, input = {}) => {
  const writes = []
  const toasts = []
  const client = {
    auth: { set: async ({ path, body }) => { writes.push({ key: path.id, body }) } },
    tui: { showToast: (payload) => { toasts.push(payload.body) } },
    ...(input.client ?? {}),
  }
  const plugin = await makeHubPlugin(channel)({ ...input, client }, { notify: false })
  return { plugin, writes, toasts }
}

/**
 * 换掉渠道的导入器（只换 submit，其余字段照旧）。
 * ⚠️ createImporter() 在模块加载时就捕获了 verify，改 importCredential.verify 无效；
 *    要「不联网跑通导入」只能换掉整个 submit。
 */
const withImporter = async (spec, run) => {
  const original = lobsteraiChannel.importCredential
  lobsteraiChannel.importCredential = { ...original, ...spec }
  try {
    return await run()
  } finally {
    lobsteraiChannel.importCredential = original
  }
}

// ⚠️ 必须 await 回调：直接 return 一个 promise 的话 finally 会在回调跑完前就删目录，
//    第二、三次读文件就成了「读不到文件」（真机上不会发生，测试里会）。
const withTempFile = async (name, content, run) => {
  const dir = mkdtempSync(join(tmpdir(), 'lobsterai-import-'))
  const file = join(dir, name)
  writeFileSync(file, content)
  try {
    return await run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('解析官方导出文件：秒级 expires_at 换毫秒字符串', () => {
  const out = parseImportPayload({ mode: 'file', verify: false, fields: { text: JSON.stringify(OFFICIAL) } })
  assert.equal(out.accounts.length, 1)
  const credential = out.accounts[0]
  assert.equal(credential.access_token, TOKEN)
  assert.equal(credential.refresh_token, REFRESH)
  assert.equal(credential.user_id, '151290')
  assert.equal(credential.uid, '151290')
  assert.equal(credential.nickname, '170****7196')
  assert.equal(credential.yid, 'urs-phoneyd.x@163.com')
  // 与 toCredential 同口径：毫秒字符串（秒会被 expired() 当毫秒读成 1970）
  assert.equal(credential.expires_at, String(1796051474 * 1000))
})

test('多种文件形态都能读：数组 / {accounts} / JSONL，重复 token 只留一条', () => {
  const one = { nickname: '甲', access_token: 'a'.repeat(32) }
  const two = { nickName: '乙', accessToken: 'b'.repeat(32), expiresIn: 3600 }
  const arrays = parseImportPayload({ mode: 'file', fields: { text: JSON.stringify([one, two]) } })
  assert.deepEqual(arrays.accounts.map((c) => c.nickname), ['甲', '乙'])

  const wrapped = parseImportPayload({ mode: 'file', fields: { text: JSON.stringify({ accounts: [one] }) } })
  assert.equal(wrapped.accounts.length, 1)

  const jsonl = parseImportPayload({ mode: 'file', fields: { text: JSON.stringify(one) + '\n' + JSON.stringify(two) } })
  assert.deepEqual(jsonl.accounts.map((c) => c.nickname), ['甲', '乙'])

  const dup = parseImportPayload({ mode: 'file', fields: { text: JSON.stringify([one, { ...one }]) } })
  assert.equal(dup.accounts.length, 1)
  assert.match(dup.warnings.join('；'), /重复/)
})

test('手动栏直接粘整段 JSON 也走同一个解析器', () => {
  const out = parseImportPayload({
    mode: 'manual',
    verify: false,
    fields: { accessToken: JSON.stringify({ nickname: '小号 A', access_token: 'k'.repeat(32) }) },
  })
  assert.equal(out.accounts.length, 1)
  assert.equal(out.accounts[0].nickname, '小号 A')
})

test('JWT 里的 uid / exp 能补出 userId 与到期时间', () => {
  const payload = Buffer.from(JSON.stringify({ uid: 998877, exp: 1796051474 }), 'utf8').toString('base64url')
  const jwt = 'h.' + payload + '.s'
  const out = parseImportPayload({ mode: 'manual', fields: { accessToken: jwt } })
  assert.equal(out.accounts[0].uid, '998877')
  assert.equal(out.accounts[0].user_id, '998877')
  assert.equal(out.accounts[0].expires_at, String(1796051474 * 1000))
})

test('没有 token / token 太短 → 抛错（表单里显示红字，表单不关）', () => {
  assert.throws(() => parseImportPayload({ mode: 'manual', fields: {} }), /太短|缺少/)
  assert.throws(() => parseImportPayload({ mode: 'manual', fields: { accessToken: 'short' } }), /太短/)
  assert.throws(() => parseImportPayload({ mode: 'file', fields: { text: '{}' } }), /缺少 access_token/)
  assert.throws(() => parseImportPayload({ mode: 'file', fields: { text: 'not json' } }), /没有/)
})

test('联网校验三分支：通过 / token 无效跳过 / 风控只提示仍导入', async () => {
  const seen = []
  const importer = createImporter({
    displayName: '测试渠道',
    verify: async (credential) => {
      seen.push(credential.access_token)
      if (credential.access_token === 'a'.repeat(32)) return { ok: false, signedOut: true, message: 'HTTP 401' }
      if (credential.access_token === 'b'.repeat(32)) return { ok: false, signedOut: false, message: 'HTTP 403 code 40302' }
      return { ok: true, data: { userInfo: { nickname: '补出来的昵称', uid: '17' } } }
    },
  })
  const text = JSON.stringify([
    { nickname: '甲', access_token: 'a'.repeat(32) },
    { nickname: '乙', access_token: 'b'.repeat(32) },
    { access_token: 'c'.repeat(32) },
  ])
  const out = await importer.submit({ mode: 'file', verify: true, fields: { text } })
  assert.equal(seen.length, 3)
  assert.deepEqual(out.accounts.map((c) => c.access_token), ['b'.repeat(32), 'c'.repeat(32)])
  assert.match(out.warnings.join('；'), /token 无效/)
  assert.match(out.warnings.join('；'), /未能联网校验/)
  assert.equal(out.accounts[1].nickname, '补出来的昵称')
  assert.equal(out.accounts[1].uid, '17')

  // verify:false 不联网
  seen.length = 0
  const skipped = await importer.submit({ mode: 'manual', verify: false, fields: { accessToken: TOKEN } })
  assert.equal(seen.length, 0)
  assert.equal(skipped.accounts.length, 1)
})

test('导入入口是 magpie 原生表单：api + keyless + prompts', async () => {
  const { plugin } = await build()
  const labels = plugin.auth.methods.map((method) => method.label)
  assert.equal(labels.length, 3, '登录 + 手动导入 + 文件导入')
  assert.equal(labels[0].startsWith('登录'), true)
  assert.deepEqual(labels.slice(1), [
    lobsteraiChannel.importCredential.manualLabel,
    lobsteraiChannel.importCredential.fileLabel,
  ])

  const manual = plugin.auth.methods[1]
  // keyless api：宿主不渲染「API key」输入框，只按 prompts 逐题问
  assert.equal(manual.type, 'api')
  assert.equal(manual.keyless, true)
  assert.equal(typeof manual.authorize, 'function')
  // 四栏，顺序 = 官方导出文件的字段顺序（user_id → access → refresh → 备注）
  assert.deepEqual(manual.prompts.map((prompt) => prompt.key), ['userId', 'token', 'refreshToken', 'note'])
  const [userId, token, refresh, note] = manual.prompts
  assert.equal(userId.type, 'text')
  assert.match(userId.message, /USER ID/)
  assert.match(userId.message, /留空/)
  assert.equal(userId.validate, undefined, 'user_id 留空也能导入（自动从 token 识别）')
  assert.equal(token.type, 'password')
  assert.match(token.message, /ACCESS_TOKEN/)
  assert.match(token.message, /必填/)
  assert.match(token.validate(''), /请粘贴/)
  assert.match(token.validate('   '), /请粘贴/)
  assert.equal(token.validate(TOKEN), null)
  assert.equal(refresh.type, 'password')
  assert.match(refresh.message, /REFRESH_TOKEN/)
  assert.equal(refresh.validate, undefined, 'refresh_token 可选：只有 access 的账号也要能导进来')
  assert.equal(note.type, 'text')
  assert.equal(note.validate, undefined, '备注是可选项，不校验')

  const file = plugin.auth.methods[2]
  assert.equal(file.type, 'api')
  assert.equal(file.keyless, true)
  assert.equal(typeof file.authorize, 'function')
  assert.deepEqual(file.prompts.map((prompt) => prompt.key), ['source'])
  assert.match(file.prompts[0].validate(''), /请填写/)
  assert.equal(file.prompts[0].validate('C:/tmp/a.json'), null)
})

test('手动导入：结果带 refresh（宿主认的 oauth 形状），只有第 2..N 个自己落槽', async () => {
  const first = {
    nickname: '小号 A',
    access_token: TOKEN,
    refresh_token: REFRESH,
    uid: '17',
    expires_at: String(1796051474 * 1000),
  }
  const second = { nickname: '小号 B', access_token: 'b'.repeat(48) }
  await withImporter({
    submit: async ({ mode, fields }) => {
      assert.equal(mode, 'manual')
      assert.equal(fields.accessToken, TOKEN)
      assert.equal(fields.refreshToken, REFRESH)
      assert.equal(fields.userId, '151290')
      assert.equal(fields.note, '第二个号')
      return { accounts: [first, second], warnings: ['有 1 个账号 token 已失效，已跳过'] }
    },
  }, async () => {
    const { plugin, writes, toasts } = await build()
    const out = await plugin.auth.methods[1].authorize({
      token: '  ' + TOKEN + '  ', refreshToken: '  ' + REFRESH + '  ', userId: ' 151290 ', note: ' 第二个号 ',
    })

    assert.equal(out.type, 'success')
    assert.equal(out.channel, 'lobsterai')
    assert.equal(out.accountId, '小号 A')
    // ⚠️ 宿主 save() 只看 'refresh' in result：有它就按 oauth 存（access/refresh/expires）
    assert.equal('refresh' in out, true)
    assert.equal(out.refresh, REFRESH)
    assert.equal(out.access, TOKEN)
    // 渠道 loader / expired() 读的是本插件命名的字段
    assert.equal(out.access_token, TOKEN)
    assert.equal(out.refresh_token, REFRESH)
    assert.equal(out.expires, 1796051474000)

    // 第 1 个交给宿主 settle（插件不写），其余自己写 —— 且不覆盖同一个槽
    assert.equal(writes.length, 1)
    assert.equal(writes[0].body.accountId, '小号 B')
    assert.equal(writes[0].body.channel, 'lobsterai')
    assert.equal(writes[0].body.access_token, 'b'.repeat(48))
    assert.equal(writes[0].body.type, 'success')
    assert.equal('refresh' in writes[0].body, false, '自己写的槽不带 refresh（与旧版一致）')

    assert.ok(toasts.some((toast) => String(toast.message).includes('已导入 2 个账号（小号 A、小号 B）')),
      '应弹出导入结果提示')
    assert.ok(toasts.some((toast) => String(toast.message).includes('已跳过')), '解析告警也要提示')
  })
})

test('手动导入：没有 refresh_token 时结果仍带 refresh 键（宿主照常落槽）', async () => {
  await withImporter({
    submit: async () => ({ accounts: [{ nickname: '只有 access', access_token: TOKEN }], warnings: [] }),
  }, async () => {
    const { plugin, writes } = await build()
    const out = await plugin.auth.methods[1].authorize({ token: TOKEN, note: '' })
    assert.equal(out.type, 'success')
    assert.equal('refresh' in out, true)
    assert.equal(out.refresh, undefined)
    assert.equal(out.access, TOKEN)
    assert.equal(writes.length, 0, '单账号导入不需要插件自己写槽')
  })
})

test('同一个 token 重复导入：沿用旧槽账号名，并补齐 refresh_token / expires_at', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lobsterai-slot-'))
  const authPath = join(dir, 'plugin-auth.json')
  // 真机形状：官方导出的昵称是打码的（旧槽 accountId 就是它），导入时联网校验能拿到真名。
  writeFileSync(authPath, JSON.stringify({
    'hub-lobsterai#2834fe': {
      type: 'success',
      channel: 'lobsterai',
      accountId: '170****7196',
      access_token: TOKEN,
      refresh_token: REFRESH,
      expires_at: String(1796051474 * 1000),
      uid: '151290',
      user_id: '151290',
    },
    // 别的渠道的槽：同一个 token 也不许串号
    'hub-astudio': { type: 'success', channel: 'astudio', accountId: '别的渠道', access_token: TOKEN },
  }))
  const previous = process.env.DSH_HUB_AUTH_PATH
  process.env.DSH_HUB_AUTH_PATH = authPath
  try {
    await withImporter({
      submit: async () => ({
        accounts: [{ nickname: '17027477196', access_token: TOKEN, uid: '151290', user_id: '151290' }],
        warnings: [],
      }),
    }, async () => {
      const { plugin, toasts } = await build()
      const out = await plugin.auth.methods[1].authorize({ token: TOKEN, note: '' })
      assert.equal(out.type, 'success')
      // 账号名沿用旧槽 → 宿主 settle 的 whoOf 命中，覆盖旧槽而不是新建一行
      assert.equal(out.accountId, '170****7196')
      // 旧槽的续期凭据补回来（否则覆盖时 refresh_token 丢掉，access 到期只能重登）
      assert.equal(out.refresh, REFRESH)
      assert.equal(out.refresh_token, REFRESH)
      assert.equal(out.expires, 1796051474000)
      assert.equal(
        toasts.some((toast) => String(toast.message).includes('没有 refresh_token')),
        false,
        '补齐了就不该再提示缺 refresh_token',
      )
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HUB_AUTH_PATH
    else process.env.DSH_HUB_AUTH_PATH = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只有 access_token 又对不上旧槽：照常导入，但提示到期要重新导入', async () => {
  await withImporter({
    submit: async () => ({ accounts: [{ nickname: '新号', access_token: TOKEN }], warnings: [] }),
  }, async () => {
    const { plugin, toasts } = await build()
    const out = await plugin.auth.methods[1].authorize({ token: TOKEN, note: '' })
    assert.equal(out.type, 'success')
    assert.equal(out.accountId, '新号')
    assert.equal(out.refresh, undefined)
    assert.ok(toasts.some((toast) => String(toast.message).includes('没有 refresh_token')), '应提示缺 refresh_token')
  })
})

test('文件导入：既能给路径（含引号包住的），也能直接粘 JSON', async () => {
  const seen = []
  const account = { nickname: '文件账号', access_token: TOKEN, refresh_token: REFRESH }
  const raw = JSON.stringify(OFFICIAL)
  await withImporter({
    submit: async ({ mode, fields }) => {
      seen.push({ mode, fields })
      return { accounts: [account], warnings: [] }
    },
  }, async () => {
    const { plugin } = await build()
    const method = plugin.auth.methods[2]

    await withTempFile('lobsterai-1.json', raw, async (file) => {
      assert.equal((await method.authorize({ source: file })).type, 'success')
      assert.equal(seen[0].mode, 'file')
      assert.equal(seen[0].fields.text, raw, '读到的应是文件原文')

      // Windows 资源管理器「复制为路径」会带引号
      seen.length = 0
      await method.authorize({ source: '"' + file + '"' })
      assert.equal(seen[0].fields.text, raw)
    })

    // 直接粘 JSON 不读盘
    seen.length = 0
    const pasted = JSON.stringify({ access_token: TOKEN })
    await method.authorize({ source: '  ' + pasted + '  ' })
    assert.equal(seen[0].fields.text, pasted)
  })
})

test('导入失败：读不到文件 / 文件里没有账号 / 一个账号都没解析出 → type:failed + error', async () => {
  const { plugin, toasts } = await build()
  const method = plugin.auth.methods[2]

  const missing = await method.authorize({ source: join(tmpdir(), 'lobsterai-nope-' + Date.now() + '.json') })
  assert.equal(missing.type, 'failed')
  assert.match(missing.error, /读不到文件/)

  // 文件真被读到、内容是垃圾 → 报解析错（证明不是「没读盘」）
  await withTempFile('bad.json', '{"not":"an account"}', async (file) => {
    const bad = await method.authorize({ source: file })
    assert.equal(bad.type, 'failed')
    assert.match(bad.error, /缺少 access_token|没有解析出任何账号/)
  })

  await withImporter({
    submit: async () => ({ accounts: [], warnings: ['账号已过期，全部跳过'] }),
  }, async () => {
    const fresh = await build()
    const empty = await fresh.plugin.auth.methods[1].authorize({ token: TOKEN, note: '' })
    assert.equal(empty.type, 'failed')
    assert.equal(empty.error, '账号已过期，全部跳过')
  })

  await withImporter({
    submit: async () => { throw new Error('解析炸了') },
  }, async () => {
    const fresh = await build()
    const threw = await fresh.plugin.auth.methods[1].authorize({ token: TOKEN, note: '' })
    assert.equal(threw.type, 'failed')
    assert.equal(threw.error, '解析炸了')
  })

  assert.ok(toasts.some((toast) => String(toast.message).includes('导入失败')), '失败也要弹提示')
})

// ── 抄自 magpie-wpt 的两条防御约定 + 备注/手填 user_id ────────────────────

test('到期键别名：expiry / expiration 也认（ISO 与秒级都行）', () => {
  const iso = parseImportPayload({
    mode: 'file',
    fields: { text: JSON.stringify({ access_token: 'a'.repeat(32), expiry: '2027-01-02T03:04:05Z' }) },
  })
  assert.equal(iso.accounts[0].expires_at, String(Date.parse('2027-01-02T03:04:05Z')))

  const seconds = parseImportPayload({
    mode: 'file',
    fields: { text: JSON.stringify({ access_token: 'b'.repeat(32), expiration: 1796051474 }) },
  })
  assert.equal(seconds.accounts[0].expires_at, String(1796051474 * 1000), '秒级要换算成毫秒')
})

test('备注就是账号名：填了用备注，没填才用上游昵称', async () => {
  const named = parseImportPayload({
    mode: 'manual',
    fields: { accessToken: TOKEN, refreshToken: REFRESH, note: '手机小号 A' },
  })
  assert.equal(lobsteraiChannel.importCredential.accountIdOf(named.accounts[0]), '手机小号 A')

  const fallbackName = parseImportPayload({
    mode: 'file',
    fields: { text: JSON.stringify({ nickname: '170****7196', access_token: TOKEN }) },
  })
  assert.equal(lobsteraiChannel.importCredential.accountIdOf(fallbackName.accounts[0]), '170****7196')

  // 备注优先于昵称 —— 打码昵称两个小号根本分不清
  const both = parseImportPayload({
    mode: 'file',
    fields: { text: JSON.stringify({ nickname: '170****7196', note: '小号 B', access_token: TOKEN }) },
  })
  assert.equal(lobsteraiChannel.importCredential.accountIdOf(both.accounts[0]), '小号 B')
})

test('手动导入的 user_id：填了按填的，留空从 token 里识别', () => {
  const payload = Buffer.from(JSON.stringify({ uid: 998877 }), 'utf8').toString('base64url')
  const jwt = 'h.' + payload + '.s'

  const blank = parseImportPayload({ mode: 'manual', fields: { accessToken: jwt, userId: '' } })
  assert.equal(blank.accounts[0].user_id, '998877', '留空 → 从 JWT 的 uid 识别')

  const typed = parseImportPayload({ mode: 'manual', fields: { accessToken: jwt, userId: '151290' } })
  assert.equal(typed.accounts[0].user_id, '151290', '手填的优先于 token 里的 uid')
  assert.equal(typed.accounts[0].uid, '151290', 'uid 跟着手填的走（没有独立 uid 时两者同源）')
})

test('旧槽比这份凭据更新 → 提示「覆盖是降级」，但照常导入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lobsterai-downgrade-'))
  const authPath = join(dir, 'plugin-auth.json')
  const newer = Date.now() + 400 * 24 * 3600_000
  writeFileSync(authPath, JSON.stringify({
    'hub-lobsterai': {
      type: 'success',
      channel: 'lobsterai',
      accountId: '170****7196',
      access_token: TOKEN,
      refresh_token: REFRESH,
      expires_at: String(newer),
      expires: newer,
    },
  }))
  const previous = process.env.DSH_HUB_AUTH_PATH
  process.env.DSH_HUB_AUTH_PATH = authPath
  try {
    await withImporter({
      // 手上那份是半年前的导出：access 还认，但到期比槽里那份早得多
      submit: async () => ({
        accounts: [{ nickname: '170****7196', access_token: TOKEN, refresh_token: REFRESH, expires_at: String(Date.now() + 7 * 24 * 3600_000) }],
        warnings: [],
      }),
    }, async () => {
      const { plugin, toasts } = await build()
      const out = await plugin.auth.methods[1].authorize({ token: TOKEN, refreshToken: REFRESH, userId: '', note: '' })
      assert.equal(out.type, 'success', '只提示，不拦导入')
      assert.ok(
        toasts.some((toast) => String(toast.message).includes('覆盖反而')),
        '应提示旧槽更新鲜、覆盖是降级：' + JSON.stringify(toasts),
      )
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HUB_AUTH_PATH
    else process.env.DSH_HUB_AUTH_PATH = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

