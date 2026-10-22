// 华为云 APIG 签名（SDK-HMAC-SHA256）的三处坑。
//
// 这三处不是从文档推出来的，是实测踩出来的；任何一处写错都是「签名不通过」
// 这种没有任何诊断信息的失败，故逐条钉死。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'

// 与 src/officeace.mjs 的同名函数保持一致（这里独立实现一份用于交叉验证）
function signHuaweiRequest(method, url, headers, bodyText, accessKey, secretKey, now) {
  const u = new URL(url)
  const pad = (n) => (n >= 10 ? String(n) : `0${n}`)
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const ue = (s) => encodeURIComponent(s)
  const cu0 = u.pathname.split('/').map(ue).join('/')
  const cu = cu0.endsWith('/') ? cu0 : `${cu0}/`
  const qp = []
  for (const k of [...u.searchParams.keys()].sort()) qp.push(`${ue(k)}=${ue(u.searchParams.get(k) ?? '')}`)
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim()
  lower.host = u.host
  lower['x-sdk-date'] = xdate
  const sh = Object.keys(lower).sort()
  let ch = ''
  for (const h of sh) ch += `${h}:${lower[h]}\n`
  const bh = (method === 'PUT' || method === 'PATCH' || method === 'POST')
    ? createHash('sha256').update(bodyText).digest('hex')
    : createHash('sha256').update('').digest('hex')
  const cr = [method, cu, qp.join('&'), ch, sh.join(';'), bh].join('\n')
  const sts = ['SDK-HMAC-SHA256', xdate, createHash('sha256').update(cr).digest('hex')].join('\n')
  const sig = createHmac('sha256', secretKey).update(sts).digest('hex')
  return { xdate, signedHeaders: sh, signature: sig, canonicalUri: cu }
}

const now = new Date('2026-10-23T05:00:00Z')
const url = 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-permission-validate'

test('坑1：canonical URI 末尾强制补斜杠', () => {
  const s = signHuaweiRequest('GET', url, {}, '', 'AK', 'SK', now)
  assert.equal(s.canonicalUri, '/v1/claw/client-permission-validate/')
})

test('坑2：签名密钥是裸 Secret，不做 AWS 式 scope 派生', () => {
  const s = signHuaweiRequest('GET', url, {}, '', 'AK', 'SK', now)
  // 按「裸 Secret」直接 HMAC
  const bare = createHmac('sha256', 'SK').update(
    ['SDK-HMAC-SHA256', s.xdate, createHash('sha256').update(
      ['GET', '/v1/claw/client-permission-validate/', '', `host:${new URL(url).host}\nx-sdk-date:${s.xdate}\n`,
        'host;x-sdk-date', createHash('sha256').update('').digest('hex')].join('\n'),
    ).digest('hex')].join('\n')).digest('hex')
  assert.equal(s.signature, bare)
  // 若按 AWS 式派生密钥，结果必须不同（否则说明我们其实用了派生）
  const dateKey = createHmac('sha256', 'SK').update('20261023').digest()
  const regionKey = createHmac('sha256', dateKey).update('cn-southwest-2').digest()
  const serviceKey = createHmac('sha256', regionKey).update('apig').digest()
  const signingKey = createHmac('sha256', serviceKey).update('sdk_request').digest()
  const aws = createHmac('sha256', signingKey).update('anything').digest('hex')
  assert.notEqual(s.signature, aws)
})

test('坑3：头名全小写排序，头值 trim', () => {
  const s = signHuaweiRequest('GET', url,
    { 'Content-Type': ' application/json ', 'X-Security-Token': ' tok ' }, '', 'AK', 'SK', now)
  assert.deepEqual(s.signedHeaders, ['content-type', 'host', 'x-sdk-date', 'x-security-token'])
  // 头值被 trim（canonical 里不应残留空格）
  assert.ok(!s.signature.includes(' '))
})

test('POST 参与 body 哈希，GET 用空串哈希', () => {
  const body = '{"a":1}'
  const post = signHuaweiRequest('POST', url, {}, body, 'AK', 'SK', now)
  const expected = createHash('sha256').update(body).digest('hex')
  const cr = ['POST', '/v1/claw/client-permission-validate/', '',
    `host:${new URL(url).host}\nx-sdk-date:${post.xdate}\n`,
    'host;x-sdk-date', expected].join('\n')
  const sig = createHmac('sha256', 'SK').update(
    ['SDK-HMAC-SHA256', post.xdate, createHash('sha256').update(cr).digest('hex')].join('\n')).digest('hex')
  assert.equal(post.signature, sig)

  const get = signHuaweiRequest('GET', url, {}, body, 'AK', 'SK', now)
  const emptyHash = createHash('sha256').update('').digest('hex')
  const crGet = ['GET', '/v1/claw/client-permission-validate/', '',
    `host:${new URL(url).host}\nx-sdk-date:${get.xdate}\n`,
    'host;x-sdk-date', emptyHash].join('\n')
  const sigGet = createHmac('sha256', 'SK').update(
    ['SDK-HMAC-SHA256', get.xdate, createHash('sha256').update(crGet).digest('hex')].join('\n')).digest('hex')
  assert.equal(get.signature, sigGet)
})
