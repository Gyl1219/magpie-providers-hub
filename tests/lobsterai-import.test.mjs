// 账号导入（手动 / 文件）+ 一次性本地页面。
//
// 全本地用例：不触网、不落盘到真实配置目录（tests/setup.mjs 已把 HOME 与
// DSH_HUB_SNAPSHOT_PATH 重定向到临时目录）。
//
// ⚠️ 这里验证的是三件真机必踩的事：
//   1. 官方客户端导出的 expires_at 是**秒**，本渠道 expired() 只认毫秒；
//   2. 导入页面必须带一次性 nonce 才能 POST（本地端口也怕 CSRF）；
//   3. 导入结果要落到**账号槽**（client.auth.set），且槽 key 不能把已有账号冲掉。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseImportPayload, createImporter } from '../src/lobsterai-import.mjs'
import { startImportWindow } from '../src/import-window.mjs'
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

const nonceOf = (html) => {
  const hit = /var NONCE = "([^"]+)"/.exec(html)
  assert.ok(hit, '导入页面里应有一次性 nonce')
  return hit[1]
}

const postSubmit = (base, nonce, body) => fetch(base + 'submit', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-import-nonce': nonce },
  body: JSON.stringify(body),
})

const readJson = async (response) => ({ status: response.status, body: await response.json() })

const waitFor = async (check, timeoutMs = 3_000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
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

test('手动页直接粘整段 JSON 也走同一个解析器', () => {
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

test('没有 token / token 太短 → 抛错（页面显示红字，窗口不关）', () => {
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

test('一次性页面：GET 出表单、POST 必须带 nonce、提交后 server 关闭', async () => {
  const calls = []
  const win = await startImportWindow({
    title: '导入 测试渠道 账号',
    subtitle: '这是副标题',
    onSubmit: async (payload) => {
      calls.push(payload)
      return { accounts: [{ access_token: 't'.repeat(32) }], message: '已解析 1 个账号' }
    },
  })
  assert.match(win.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)

  const page = await (await fetch(win.url)).text()
  assert.ok(page.includes('手动导入') && page.includes('文件导入'), '页面两个 tab 都要在')
  assert.ok(page.includes('导入 测试渠道 账号') && page.includes('这是副标题'))
  const nonce = nonceOf(page)

  const rejected = await readJson(await fetch(win.url + 'submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  assert.equal(rejected.status, 403, '没有 nonce 的 POST 必须被拒')

  const wrong = await readJson(await postSubmit(win.url, nonce + 'x', { mode: 'manual', fields: {} }))
  assert.equal(wrong.status, 403)

  const accepted = await readJson(await postSubmit(win.url, nonce, { mode: 'manual', fields: { accessToken: TOKEN } }))
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.ok, true)
  assert.equal(accepted.body.message, '已解析 1 个账号')

  const outcome = await win.result
  assert.equal(outcome.ok, true)
  assert.equal(outcome.mode, 'manual')
  assert.equal(outcome.accounts.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].fields.accessToken, TOKEN)

  // 提交完成即关端口（一次性页面）
  await assert.rejects(() => fetch(win.url))
})

test('页面提交出错：400 + 窗口仍然可用（改完能再点一次）', async () => {
  let attempt = 0
  const win = await startImportWindow({
    onSubmit: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('没有解析出任何账号（JSON 里没有账号对象？）')
      return { accounts: [{ access_token: 'z'.repeat(32) }] }
    },
  })
  let settled = false
  void win.result.then(() => { settled = true })
  const page = await (await fetch(win.url)).text()
  const nonce = nonceOf(page)

  const first = await readJson(await postSubmit(win.url, nonce, { mode: 'file', fields: { text: '{}' } }))
  assert.equal(first.status, 400)
  assert.match(first.body.message, /没有解析出任何账号/)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(settled, false, '解析失败不应结束会话')

  const second = await readJson(await postSubmit(win.url, nonce, { mode: 'file', fields: { text: '{"access_token":"y"}' } }))
  assert.equal(second.status, 200)
  const outcome = await win.result
  assert.equal(outcome.ok, true)
})

test('close() → cancelled（用户点取消/关掉卡片）', async () => {
  const win = await startImportWindow({ onSubmit: async () => ({ accounts: [] }) })
  assert.equal(win.close(), true)
  const outcome = await win.result
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'cancelled')
})

test('聚合层：导入入口挂在登录方式末尾，导入结果写账号槽', async () => {
  const writes = []
  const toasts = []
  const input = {
    client: {
      auth: { set: async ({ path, body }) => { writes.push({ key: path.id, body }) } },
      tui: { showToast: (payload) => { toasts.push(payload.body) } },
    },
  }
  const plugin = await makeHubPlugin(lobsteraiChannel)(input, { notify: false })
  const labels = plugin.auth.methods.map((method) => method.label)
  assert.equal(labels.length, 3, '登录 + 手动导入 + 文件导入')
  assert.equal(labels[0].startsWith('登录'), true)
  assert.deepEqual(labels.slice(1), [
    lobsteraiChannel.importCredential.manualLabel,
    lobsteraiChannel.importCredential.fileLabel,
  ])

  // ① 手动导入（整段 JSON：带 nickname，账号名认得出）
  const manual = plugin.auth.methods[1]
  const handle = await manual.authorize()
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.equal(handle.method, 'auto')
  const page = await (await fetch(handle.url)).text()
  const payload = {
    mode: 'manual',
    verify: false,
    fields: { accessToken: JSON.stringify({ nickname: '小号 A', access_token: 'k'.repeat(32) }) },
  }
  const posted = await postSubmit(handle.url, nonceOf(page), payload)
  assert.equal(posted.status, 200)
  assert.equal(await waitFor(() => writes.length === 1), true, '提交后应写入账号槽')

  assert.equal(writes[0].key, 'hub-lobsterai')
  assert.equal(writes[0].body.type, 'success')
  assert.equal(writes[0].body.channel, 'lobsterai')
  assert.equal(writes[0].body.accountId, '小号 A')
  // ⚠️ 不含 refresh 键：宿主 save() 见到 refresh 会整体替换槽（甚至连 ws 提示都变）
  assert.equal('refresh' in writes[0].body, false)

  // ② 文件导入两个账号：第一条占用本体槽，第二条必须另起一个槽，不能互相覆盖
  const fileMethod = plugin.auth.methods[2]
  const fileHandle = await fileMethod.authorize()
  const filePage = await (await fetch(fileHandle.url)).text()
  const text = JSON.stringify([
    { nickname: '乙', access_token: 'b'.repeat(32) },
    { nickname: '丙', access_token: 'c'.repeat(32), refresh_token: 'd'.repeat(32) },
  ])
  const multi = await postSubmit(fileHandle.url, nonceOf(filePage), { mode: 'file', verify: false, fields: { text } })
  assert.equal(multi.status, 200)
  assert.equal(await waitFor(() => writes.length === 3), true, '两个账号都要落槽')

  assert.equal(writes[1].key, 'hub-lobsterai')
  assert.match(writes[2].key, /^hub-lobsterai#[0-9a-f]{6}$/)
  assert.deepEqual(writes.slice(1).map((write) => write.body.accountId), ['乙', '丙'])
  assert.ok(toasts.some((toast) => String(toast.message).includes('已导入')), '应弹出导入结果提示')
})
