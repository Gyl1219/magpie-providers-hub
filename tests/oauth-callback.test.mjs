import { test } from 'node:test'
import assert from 'node:assert/strict'

import { oauthCallbackConfig, oauthCallbackUrl } from '../src/shared.mjs'

test('OAuth callback：默认仍绑定 127.0.0.1 的随机端口', () => {
  const config = oauthCallbackConfig()
  assert.deepEqual(config, { bindHost: '127.0.0.1', port: 0, baseUrl: undefined })
  assert.equal(oauthCallbackUrl(config, 43123, '/auth/callback'), 'http://127.0.0.1:43123/auth/callback')
})

test('OAuth callback：公网 origin、固定端口与反向代理子路径可覆盖', () => {
  const config = oauthCallbackConfig({
    oauthCallbackBaseUrl: 'https://magpie.example.com/gateway/',
    oauthCallbackBindHost: '0.0.0.0',
    oauthCallbackPort: 34567,
  })
  assert.equal(config.bindHost, '0.0.0.0')
  assert.equal(config.port, 34567)
  assert.equal(
    oauthCallbackUrl(config, 45678, '/auth/callback'),
    'https://magpie.example.com/gateway/auth/callback',
  )
})

test('OAuth callback：非法端口和可注入 origin 必须拒绝', () => {
  assert.throws(() => oauthCallbackConfig({ oauthCallbackPort: -1 }), /0-65535/)
  assert.throws(() => oauthCallbackConfig({ oauthCallbackPort: 'abc' }), /0-65535/)
  assert.throws(() => oauthCallbackConfig({ oauthCallbackBaseUrl: 'file:///tmp/cb' }), /http 或 https/)
  assert.throws(() => oauthCallbackConfig({ oauthCallbackBaseUrl: 'https://u:p@example.com' }), /账号或密码/)
  assert.throws(() => oauthCallbackConfig({ oauthCallbackBaseUrl: 'https://example.com/?x=1' }), /query 或 hash/)
  assert.throws(() => oauthCallbackConfig({ oauthCallbackBaseUrl: 'https://example.com/#x' }), /query 或 hash/)
})
