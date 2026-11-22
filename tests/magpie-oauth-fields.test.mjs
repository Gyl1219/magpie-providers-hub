// 回归：magpie 的 keptAs() 只认 access / refresh / key（驼峰），
// 各渠道自己的凭据字段名五花八门，登录返回必须额外带上这两个名字，
// 否则 magpie 报 "sign-in gave nothing to keep"（PR #17 的真机报障）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { magpieOAuthFieldsOf } = await import('../src/aggregate.mjs')

test('下划线凭据：access_token / refresh_token 映射成 access / refresh', () => {
  assert.deepEqual(
    magpieOAuthFieldsOf({ access_token: 'at-1', refresh_token: 'rt-1' }),
    { access: 'at-1', refresh: 'rt-1' },
  )
})

test('驼峰凭据：accessToken / refreshToken 同样映射', () => {
  assert.deepEqual(
    magpieOAuthFieldsOf({ accessToken: 'at-2', refreshToken: 'rt-2' }),
    { access: 'at-2', refresh: 'rt-2' },
  )
})

test('token 兜底（magicrew 形态）+ 缺 refresh 时只给 access', () => {
  assert.deepEqual(magpieOAuthFieldsOf({ token: 'tok-3', refreshToken: 'rt-3' }), { access: 'tok-3', refresh: 'rt-3' })
  assert.deepEqual(magpieOAuthFieldsOf({ accessToken: 'at-4' }), { access: 'at-4' })
})

test('空串与缺字段不产出键（magpie 的 keptAs 要非空 access 才收）', () => {
  assert.deepEqual(magpieOAuthFieldsOf({}), {})
  assert.deepEqual(magpieOAuthFieldsOf({ access_token: '', refresh_token: '' }), {})
  assert.deepEqual(magpieOAuthFieldsOf(null), {})
})

test('同名值冲突时以渠道自己的字段为准（插件读的是它，magpie 必须被告知同一个值）', () => {
  assert.deepEqual(
    magpieOAuthFieldsOf({ access: 'canonical', refresh: 'canonical-rt', access_token: 'other', refresh_token: 'other-rt' }),
    { access: 'other', refresh: 'other-rt' },
  )
  // 渠道没有自己的字段名时，才退回已经叫 access / refresh 的那个
  assert.deepEqual(magpieOAuthFieldsOf({ access: 'canonical', refresh: 'canonical-rt' }), { access: 'canonical', refresh: 'canonical-rt' })
})