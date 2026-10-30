/**
 * magicrew 登录昵称自愈（上游 iJetLi/dsh-providers-hub 6fa7472 的报障）。
 *
 * 现象：昵称只在登录那一刻取一次 ⇒ 登录响应没带 name/phone 的账号（国际站尤常见），
 * 卡片一直显示产品名「MagiCrew (国际版)」而不是昵称。
 *
 * ⚠️ 自愈**只能做在登录路径里**：改昵称 = 改 accountId = 槽 key 变，而旧槽删不掉
 *    （magpie 只给 `client.auth.set`，没有 remove）⇒ 事后改会多出一个鬼影账号。
 *    登录时补查则只写一个槽，没有这个副作用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SITES = { cn: { id: 'magicrew', host: 'https://i-magic-service.letsmagic.cn', web: 'https://www.letsmagic.cn' } }
const PROFILE_PATH = '/api/v1/contact/accounts/me/users'

/** 造一个可控的 fetch 桩：记录请求，按队列返回响应。 */
function stubFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    return handler(String(url), calls.length - 1)
  }
  return { calls, impl }
}

const jsonRes = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
})

test('登录响应没有昵称 → 补查一次资料把昵称填上', async () => {
  // 直接测模块内的纯函数：用 _internal 暴露的 resolveNickname
  const mod = await import('../src/magicrew.mjs')
  const resolveNickname = mod._internal?.resolveNickname ?? mod.resolveNickname
  assert.ok(typeof resolveNickname === 'function', 'resolveNickname 必须可用（测试入口）')

  const { calls, impl } = stubFetch((url) => {
    if (url.includes(PROFILE_PATH)) return jsonRes({ code: 1000, data: { items: [{ nickname: '老张', real_name: '张伟', phone: '10000000000' }] } })
    throw new Error('不该请求别的端点：' + url)
  })
  globalThis.fetch = impl

  const got = await resolveNickname(SITES.cn, { token: 'JWT-1', organizationCode: 'ORG-1' })
  assert.equal(got, '老张')
  assert.equal(calls.length, 1, '只发一次资料请求')
  assert.match(calls[0].url, new RegExp(PROFILE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(calls[0].headers.authorization, 'Bearer JWT-1')
  assert.equal(calls[0].headers['organization-code'], 'ORG-1')
})

test('凭据里已经有昵称 → 一个请求都不发', async () => {
  const mod = await import('../src/magicrew.mjs')
  const resolveNickname = mod._internal?.resolveNickname ?? mod.resolveNickname

  const { calls, impl } = stubFetch(() => { throw new Error('已有昵称不该再请求') })
  globalThis.fetch = impl

  const got = await resolveNickname(SITES.cn, { token: 'JWT-1', organizationCode: 'ORG-1', nickname: '187****406' })
  assert.equal(got, '187****406')
  assert.equal(calls.length, 0, '零请求（已有昵称直接返回）')
})

test('资料请求失败 → 安静回落到 undefined（不把登录拖崩）', async () => {
  const mod = await import('../src/magicrew.mjs')
  const resolveNickname = mod._internal?.resolveNickname ?? mod.resolveNickname

  // 三种失败：HTTP 404（那条不带 /users 的错地址）、业务码非 1000、条目为空
  for (const res of [
    { ok: false, status: 404, text: async () => '<html>404</html>' },
    jsonRes({ code: 403, message: 'token无效' }),
    jsonRes({ code: 1000, data: { items: [] } }),
  ]) {
    globalThis.fetch = async () => res
    const got = await resolveNickname(SITES.cn, { token: 'JWT-1', organizationCode: 'ORG-1' })
    assert.equal(got, undefined, '失败应回落 undefined，而不是抛')
  }
})

test('资料里只有 real_name / phone 也能当昵称用', async () => {
  const mod = await import('../src/magicrew.mjs')
  const resolveNickname = mod._internal?.resolveNickname ?? mod.resolveNickname

  globalThis.fetch = async () => jsonRes({ code: 1000, data: { items: [{ real_name: '张伟' }] } })
  assert.equal(await resolveNickname(SITES.cn, { token: 'JWT-1' }), '张伟')

  globalThis.fetch = async () => jsonRes({ code: 1000, data: { items: [{ phone: '10000000000' }] } })
  // 只有 phone、没有 nickname/real_name ⇒ fetchProfile 仍返回（nickname 空串）⇒ 回落 undefined
  assert.equal(await resolveNickname(SITES.cn, { token: 'JWT-1' }), undefined)
})

test('端点必须带 /users（不带的那条实测 404）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/magicrew.mjs', import.meta.url), 'utf8')
  assert.match(src, /PROFILE_PATH\s*=\s*'\/api\/v1\/contact\/accounts\/me\/users'/,
    'PROFILE_PATH 必须是带 /users 的那条')
  assert.equal(/accounts\/me'/.test(src), false, '不许出现不带 /users 的地址')
})
