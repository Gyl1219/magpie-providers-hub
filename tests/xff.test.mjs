// XFF 白名单校验（DSH sanitizeMinimaxXff 的逐字移植 + 它的守卫用例）。
// 这个值会拼进请求头 —— 判据必须白名单字符集，防 CRLF 头注入。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeXff } from '../src/minimax-transport.mjs'

test('IPv4：四段 0-255 才放行', () => {
  assert.equal(sanitizeXff('8.8.8.8'), '8.8.8.8')
  assert.equal(sanitizeXff(' 1.1.1.1 '), '1.1.1.1', '只 trim，不改写')
  assert.equal(sanitizeXff('256.1.1.1'), undefined)
  assert.equal(sanitizeXff('1.1.1'), undefined, '三段不是 IPv4')
  assert.equal(sanitizeXff('1.1.1.1.5'), undefined)
})

test('IPv6：压缩最多一次、组数 ≤8、组内 1-4 位十六进制', () => {
  assert.equal(sanitizeXff('2001:db8::1'), '2001:db8::1')
  assert.equal(sanitizeXff('fe80::1%eth0'), 'fe80::1%eth0', 'zone 允许且原样保留')
  assert.equal(sanitizeXff('::1'), '::1')
  assert.equal(sanitizeXff('1:2:3:4:5:6:7:8'), '1:2:3:4:5:6:7:8', '无压缩恰好 8 组')
  assert.equal(sanitizeXff('1:2:3:4:5:6:7:8:9'), undefined, '10 段曾经被放行（DSH 审计修的缺口）')
  assert.equal(sanitizeXff('1:2:3:4:5:6:7:8:9'), undefined)
  assert.equal(sanitizeXff(':::1'), undefined, '::: 压缩两次')
  assert.equal(sanitizeXff(':1'), undefined)
  assert.equal(sanitizeXff('1:'), undefined)
  assert.equal(sanitizeXff('1:2:3:4:5:6:7::'), '1:2:3:4:5:6:7::', '尾压缩合法（显式 7 组 < 8）')
  assert.equal(sanitizeXff('12345::1'), undefined, '组内 5 位十六进制拒绝')
})

test('头注入与脏值：原始串查 CR/LF 必须在 trim 之前', () => {
  // DSH 初版栽过的地方：'\r' 被 trim 后变合法 IPv4 并通过 —— 头注入
  assert.equal(sanitizeXff('8.8.8.8\r'), undefined)
  assert.equal(sanitizeXff('8.8.8.8\nX-Evil: 1'), undefined)
  assert.equal(sanitizeXff('localhost'), undefined)
  assert.equal(sanitizeXff('1.2.3.4, 5.6.7.8'), undefined, 'XFF 链不是 IP 字面量')
  assert.equal(sanitizeXff(''), undefined, '空串 = 不附头（不能变空值头：空值在 Akamai 侧回退真实 IP 且污染日志）')
  assert.equal(sanitizeXff('   '), undefined)
  assert.equal(sanitizeXff('a'.repeat(129)), undefined, '超长拒绝（最长合法 IPv6 只有 45 字符）')
  assert.equal(sanitizeXff(undefined), undefined)
  assert.equal(sanitizeXff(8888), undefined)
})
