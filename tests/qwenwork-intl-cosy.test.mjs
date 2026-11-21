// COSY 信封的离线测试 —— 全部纯函数，不发网络请求。
//
// 覆盖：字母表/body 编解码（含往返与上游逐字节对照）、签名路径与公式、
// userBlob 的 AES-128-CBC(key 即 IV) 结构、信封 payload、两类请求头的差异。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'

import {
  COSY_ALPHABET,
  COSY_CHAT_PATH,
  COSY_MODELS_PATH,
  COSY_RSA_KEY,
  COSY_VERSION,
  chatHeaders,
  cosyEnvelope,
  cosyHeaders,
  cosySignPath,
  cosySignature,
  decodeBody,
  encodeBody,
  machineHostname,
  machineOS,
  segmentEncode,
  swapThirds,
  userBlob,
} from '../src/qwenwork-intl-cosy.mjs'

/** 上游解包产物（本机存在时用来做逐字节对照；不存在则跳过那一条）。 */
const UPSTREAM = 'D:/qwenwork-intl/_inspect/package/index.mjs'

const FIXED_KEY_HEX = '0123456789abcdef0123456789abcdef'
const ACCOUNT = { uid: 'u-1', name: '张三', email: 'z@example.com', access: 'AT-1', machineId: 'm-1' }

// ── 常量 ──────────────────────────────────────────────────────────────────

test('常量：字母表正好 64 个、互不重复、且不含 $（$ 只是补位符）；路径是 /algo 那两条', () => {
  assert.equal(COSY_ALPHABET.length, 64)
  assert.equal(new Set(COSY_ALPHABET).size, 64, '字母表不能有重复字符')
  assert.equal(COSY_ALPHABET.includes('$'), false, '`$` 不进字母表，只用于补位')
  assert.ok(COSY_ALPHABET.includes('_') && COSY_ALPHABET.includes('#'), '与标准 base64 的关键差别')
  assert.equal(COSY_VERSION, '1.1.69')
  assert.match(COSY_MODELS_PATH, /^\/algo\/api\/v2\/model\/list/)
  assert.match(COSY_CHAT_PATH, /^\/algo\/api\/v2\/service\/pro\/sse\/agent_chat_generation/)
  // 上游注释说该路由要 Encode=1，漏了这个参数就是另一条路由
  assert.match(COSY_MODELS_PATH, /Encode=1/)
  assert.match(COSY_CHAT_PATH, /Encode=1/)
})

test('RSA 公钥：是 1024 位 PEM（RSA 包裹后 base64 长度 172）', () => {
  assert.match(COSY_RSA_KEY, /^-----BEGIN PUBLIC KEY-----/)
  assert.match(COSY_RSA_KEY, /-----END PUBLIC KEY-----$/)
  const { key } = userBlob(ACCOUNT, { keyHex: FIXED_KEY_HEX })
  // 128 字节密文 → base64 172 字符；长度变了说明公钥或填充方式变了
  assert.equal(key.length, 172)
})

// ── body 编解码 ───────────────────────────────────────────────────────────

test('segmentEncode：6 bit 分组、末尾补 $ 到 4 的倍数', () => {
  for (const [n, want] of [[0, 0], [1, 4], [2, 4], [3, 4], [4, 8]]) {
    const out = segmentEncode(Buffer.alloc(n))
    assert.equal(out.length, want, `${n} 字节 → ${want} 字符`)
  }
  // 零字节编码成字母表第 0 个字符（'_'），不是补位符 —— 补位符只在末尾
  // 4 字节 = 32 bit → 5 个整 6 bit + 剩 2 bit = 6 个字符，再补 2 个 `$`
  assert.equal(segmentEncode(Buffer.alloc(4)), COSY_ALPHABET[0].repeat(6) + '$$')
  // 1 字节 = 8 bit → 1 个整 6 bit + 剩 2 bit = 2 个字符，再补 2 个 `$`
  assert.equal(segmentEncode(Buffer.alloc(1)), COSY_ALPHABET[0].repeat(2) + '$$')
})

test('encodeBody / decodeBody：中英文、JSON、二进制全往返', () => {
  const samples = [
    '',
    'a',
    '{"model":"pro","stream":true}',
    '中文 body ✓ 带全角：０１２',
    'x'.repeat(4096),
  ]
  for (let n = 1; n < 200; n++) {
    samples.push(Buffer.from(Array.from({ length: n }, (_, k) => (k * 37 + n) % 256)).toString('latin1'))
  }
  for (const text of samples) {
    const wire = encodeBody(text)
    assert.equal(swapThirds(swapThirds(wire)), wire, 'swapThirds 必须自逆')
    assert.equal(decodeBody(wire), text, `往返失败：${JSON.stringify(text.slice(0, 24))}`)
    assert.equal(decodeBody(encodeBody(text)), text)
  }
})

test('swapThirds：首尾三分之一对调、中间不动；长度 <3 时原样', () => {
  assert.equal(swapThirds('ab'), 'ab')
  assert.equal(swapThirds('abcdef'), 'efcdab')
  // 7 个字符：t=2 → 尾 2 的 'fg' + 中间 'cde' + 首 2 的 'ab'
  assert.equal(swapThirds('abcdefg'), 'fgcdeab')
  // 补位符在 swapThirds 之后会被换到**中间**（它属于原来的尾部三分之一）。
  // 这是上游的实际行为 —— 签名和服务器都按这个串算，别「修正」成正序。
  const wire = encodeBody('abcde')
  const padded = segmentEncode(Buffer.from('abcde'))
  assert.equal(padded.length % 4, 0, '编码后长度必须是 4 的倍数')
  assert.match(padded, /\$+$/, 'swap 之前补位符在末尾')
  assert.equal(wire, swapThirds(padded))
  assert.equal(/\$+$/.test(wire), false, 'swap 之后补位符不在末尾了')
  assert.ok(wire.includes('$'), '补位符仍在串里，只是位置变了')
  assert.equal(decodeBody(wire), 'abcde')
})

// ── 签名 ──────────────────────────────────────────────────────────────────

test('cosySignPath：剥掉开头 /algo（5 个字符），其它路径不动，query 不参与', () => {
  assert.equal(cosySignPath('https://openapi.qoder.sh/algo/api/v2/model/list?Encode=1'), '/api/v2/model/list')
  assert.equal(cosySignPath('https://openapi.qoder.sh/api/v1/models'), '/api/v1/models')
  assert.equal(cosySignPath(new URL('https://openapi.qoder.sh/algo/x?a=1&b=2')), '/x')
  // 只剥前缀，不剥中间的 /algo
  assert.equal(cosySignPath('https://openapi.qoder.sh/a/algo/b'), '/a/algo/b')
})

test('cosySignature：md5(payload\\nkey\\nts\\nbody\\npath)，五行、无尾换行、顺序不可换', () => {
  const args = { payload: 'PAYLOAD', wrappedKey: 'KEY', ts: 1_700_000_000, body: 'WIRE', path: '/api/v2/model/list' }
  const want = createHash('md5').update('PAYLOAD\nKEY\n1700000000\nWIRE\n/api/v2/model/list').digest('hex')
  assert.equal(cosySignature(args), want)
  // 换任意一个字段都必须变
  for (const field of ['payload', 'wrappedKey', 'ts', 'body', 'path']) {
    assert.notEqual(cosySignature({ ...args, [field]: args[field] + 'x' }), want, `${field} 未参与签名`)
  }
})

// ── 信封 ──────────────────────────────────────────────────────────────────

test('userBlob：AES-128-CBC、key 当 IV、明文是上游那五个字段；固定 key 可解回', () => {
  const { info } = userBlob(ACCOUNT, { keyHex: FIXED_KEY_HEX })
  const key = Buffer.from(FIXED_KEY_HEX.slice(0, 16))
  const decrypt = createDecipheriv('aes-128-cbc', key, key)
  const plain = Buffer.concat([decrypt.update(Buffer.from(info, 'base64')), decrypt.final()]).toString('utf8')
  assert.deepEqual(JSON.parse(plain), {
    uid: 'u-1',
    aid: '',
    name: '张三',
    email: 'z@example.com',
    security_oauth_token: 'AT-1',
  })
})

test('userBlob：缺 uid 不抛（拼成 undefined），但字段集合与上游一致', () => {
  const { info } = userBlob({ access: 'AT-1' }, { keyHex: FIXED_KEY_HEX })
  const key = Buffer.from(FIXED_KEY_HEX.slice(0, 16))
  const decrypt = createDecipheriv('aes-128-cbc', key, key)
  const plain = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(info, 'base64')), decrypt.final()]).toString('utf8'))
  // JSON.stringify 会把 undefined 的键丢掉 —— 所以缺 uid 时明文里就没有 uid 这个键
  assert.deepEqual(Object.keys(plain).sort(), ['aid', 'email', 'name', 'security_oauth_token'])
  assert.equal('uid' in plain, false)
  assert.equal(plain.aid, '')
  assert.equal(plain.name, '')
})

test('cosyEnvelope：payload 是 base64(JSON)，version=v1、ideVersion 空串', () => {
  const env = cosyEnvelope(ACCOUNT, { keyHex: FIXED_KEY_HEX, requestId: 'req-1' })
  const payload = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'))
  assert.equal(payload.version, 'v1')
  assert.equal(payload.requestId, 'req-1')
  assert.equal(payload.cosyVersion, COSY_VERSION)
  assert.equal(payload.ideVersion, '', '上游这里就是空串，不是 undefined')
  assert.equal(payload.info, userBlob(ACCOUNT, { keyHex: FIXED_KEY_HEX }).info, '同一 key 下 info 必须可复现')
  // Cosy-Key 是 RSA-PKCS#1 v1.5 包裹结果：填充随机，**每次必然不同**，不能拿来比相等
  assert.equal(env.key.length, 172)
  assert.notEqual(env.key, userBlob(ACCOUNT, { keyHex: FIXED_KEY_HEX }).key, 'RSA 填充随机，两次包裹不该相同')
})

// ── 请求头 ────────────────────────────────────────────────────────────────

test('cosyHeaders：没有 machineId 直接抛（上游同款），说了原因', () => {
  assert.throws(() => cosyHeaders('https://openapi.qoder.sh/algo/x', { uid: 'u', access: 'a' }, ''), /machineId/)
})

test('cosyHeaders：Authorization = Bearer COSY.<payload>.<md5>，且签名对得上 body 与 path', () => {
  const url = 'https://openapi.qoder.sh/algo/api/v2/model/list?Encode=1'
  const body = ''
  const h = cosyHeaders(url, ACCOUNT, body, {}, { ts: 1_700_000_000, keyHex: FIXED_KEY_HEX, requestId: 'req-1' })
  const [scheme, payload, sig] = h.Authorization.split('.')
  assert.equal(scheme, 'Bearer COSY')
  assert.equal(payload, cosyEnvelope(ACCOUNT, { keyHex: FIXED_KEY_HEX, requestId: 'req-1' }).payload)
  // 签名必须能用**这个头自己带的 Cosy-Key** 复现（RSA 填充每次随机，key 不可 reuse）
  assert.equal(
    sig,
    cosySignature({ payload, wrappedKey: h['Cosy-Key'], ts: 1_700_000_000, body, path: '/api/v2/model/list' }),
  )
  assert.equal(sig.length, 32, 'md5 十六进制')
  // 签名串里的 body 必须是上线形态，改明文签名就对不上
  const withBody = cosyHeaders(url, ACCOUNT, encodeBody('{"a":1}'), {}, { ts: 1_700_000_000, keyHex: FIXED_KEY_HEX, requestId: 'req-1' })
  const [, p2, s2] = withBody.Authorization.split('.')
  assert.equal(s2, cosySignature({ payload: p2, wrappedKey: withBody['Cosy-Key'], ts: 1_700_000_000, body: encodeBody('{"a":1}'), path: '/api/v2/model/list' }))
  assert.equal(p2, payload, '同 keyHex/requestId 下 payload 相同（RSA 只影响 Cosy-Key，不影响 info）')
  assert.notEqual(s2, sig)
})

test('cosyHeaders：Cosy-User/Date/Version/ClientType/Key/MachineId 齐全', () => {
  const h = cosyHeaders('https://openapi.qoder.sh/algo/x', ACCOUNT, '', {}, { ts: 1_700_000_000, keyHex: FIXED_KEY_HEX })
  assert.equal(h['Cosy-User'], 'u-1')
  assert.equal(h['Cosy-Date'], '1700000000', '必须是秒字符串')
  assert.equal(h['Cosy-Version'], COSY_VERSION)
  assert.equal(h['Cosy-ClientType'], '10')
  assert.equal(h['Cosy-Business-Product'], 'app')
  assert.equal(h['Cosy-Scene'], 'app')
  assert.equal(h['Login-Version'], 'v2')
  assert.equal(h['Cosy-MachineId'], 'm-1')
  assert.equal(h['Cosy-MachineToken'], 'm-1')
  assert.ok(h['Cosy-Key'].length > 0)
  assert.equal(h['Accept-Encoding'], 'identity', '上游显式禁压缩：压缩会改 body')
})

test('chatHeaders：去掉 ClientIp/MachineToken/MachineType，再由设备身份补回后两个', () => {
  const url = `https://openapi.qoder.sh${COSY_CHAT_PATH}`
  const base = chatHeaders(url, ACCOUNT, 'WIRE', {}, { key: 'pro', source: 'qwork' }, {}, { ts: 1_700_000_000, keyHex: FIXED_KEY_HEX })
  assert.equal('Cosy-ClientIp' in base, false, '对话不发 ClientIp')
  assert.equal('Cosy-MachineToken' in base, false, '没有设备身份时就不发')
  assert.equal('Cosy-MachineType' in base, false)
  assert.equal(base.Accept, 'text/event-stream')
  assert.equal(base['Cache-Control'], 'no-cache')
  assert.equal(base['X-Model-Key'], 'pro')
  assert.equal(base['X-Model-Source'], 'qwork')

  const withDevice = chatHeaders(url, ACCOUNT, 'WIRE', {}, {}, { 'Cosy-MachineToken': 'DT-9', 'Cosy-MachineType': '9' }, { ts: 1_700_000_000, keyHex: FIXED_KEY_HEX })
  assert.equal(withDevice['Cosy-MachineToken'], 'DT-9')
  assert.equal(withDevice['Cosy-MachineType'], '9')
  assert.equal('Cosy-ClientIp' in withDevice, false, '补回设备身份也不该带回 ClientIp')
})

test('chatHeaders：签名用同一套公式（只是头集合不同）', () => {
  const wire = encodeBody('{"model":"pro"}')
  const url = `https://openapi.qoder.sh${COSY_CHAT_PATH}`
  const op = { ts: 1_700_000_000, keyHex: FIXED_KEY_HEX, requestId: 'req-1' }
  const chat = chatHeaders(url, ACCOUNT, wire, {}, {}, {}, { ...op })
  const [, payload, sig] = chat.Authorization.split('.')
  assert.equal(payload, cosyEnvelope(ACCOUNT, { keyHex: FIXED_KEY_HEX, requestId: 'req-1' }).payload)
  assert.equal(
    sig,
    cosySignature({ payload, wrappedKey: chat['Cosy-Key'], ts: 1_700_000_000, body: wire, path: cosySignPath(url) }),
    '对话的签名公式与普通调用完全相同',
  )
})

// ── 机器标识 ──────────────────────────────────────────────────────────────

test('machineOS：x64/arm64 改名，其它架构原样', () => {
  assert.equal(machineOS('x64', 'win32'), 'x86_64_win32')
  assert.equal(machineOS('arm64', 'darwin'), 'aarch64_darwin')
  assert.equal(machineOS('ia32', 'linux'), 'ia32_linux')
})

test('machineHostname：ASCII 原样、中文走 punycode、不可转写才加哈希、超长截到 96 内、空名给空串', () => {
  assert.equal(machineHostname('DESKTOP-ABC'), 'DESKTOP-ABC')
  assert.equal(machineHostname(''), '')
  assert.equal(machineHostname('   '), '')

  const cn = machineHostname('张三的电脑')
  // domainToASCII 能吃下中文 → punycode（上游优先这一支，不带哈希）
  assert.match(cn, /^xn--[a-z0-9-]+$/)
  assert.equal(cn, machineHostname('张三的电脑'), '同一输入必须稳定')

  // punycode 也做不出来（表情、空格混排）→ 清洗 + 原串哈希
  const odd = machineHostname('a b🙂c')
  assert.match(odd, /-[0-9a-f]{8}$/, '不可转写时必须带原串哈希（否则清洗后互相撞）')
  assert.equal(odd, machineHostname('a b🙂c'))

  const long = machineHostname('a'.repeat(200))
  assert.ok(long.length <= 96, `实际 ${long.length}`)
  assert.match(long, /-[0-9a-f]{8}$/)

  assert.equal(machineHostname(), machineHostname(hostname()), '默认取本机 hostname')
})

// ── 与上游逐字节对照（本机有解包产物时才跑）──────────────────────────────

test('交叉对照：encodeBody 与上游源码逐字节一致（前置条件：本机有 _inspect 产物）', { skip: !existsSync(UPSTREAM) }, async () => {
  const text = readFileSync(UPSTREAM, 'utf8')
  const grab = (start, end) => {
    const i = text.indexOf(start)
    assert.ok(i >= 0, `上游缺 ${start}`)
    return text.slice(i, text.indexOf(end, i))
  }
  const alphabet = /const ALPHABET = "([^"]+)"/.exec(text)?.[1]
  assert.equal(alphabet, COSY_ALPHABET, '字母表必须与上游逐字符相同')

  const { createCipheriv, publicEncrypt, constants, randomUUID } = await import('node:crypto')
  const source = `
    const ALPHABET = ${JSON.stringify(alphabet)}
    ${grab('function segmentEncode(bytes)', 'function swapThirds')}
    ${grab('function swapThirds(s)', 'const encodeBody')}
    ${grab('const hexID = () =>', '// ---- the COSY envelope')}
    ${grab('function userBlob(u, rsaKey = RSA_KEY)', '// cosyHeaders signs')}
    return { segmentEncode, swapThirds, hexID, userBlob }
  `
  const upstream = new Function('Buffer', 'createCipheriv', 'publicEncrypt', 'constants', 'randomUUID', source)(
    Buffer, createCipheriv, publicEncrypt, constants, randomUUID,
  )

  const samples = ['', 'a', 'ab', 'abc', 'abcd', '{"model":"pro"}', '中文 body ✓', 'x'.repeat(1000)]
  for (let n = 1; n < 300; n++) {
    samples.push(Buffer.from(Array.from({ length: n % 97 }, (_, k) => (k * 37 + n) % 256)).toString('latin1'))
  }
  for (const s of samples) {
    assert.equal(encodeBody(s), upstream.swapThirds(upstream.segmentEncode(Buffer.from(s, 'utf8'))), JSON.stringify(s.slice(0, 20)))
  }

  // userBlob：同一明文 + 同公钥 → 密文长度/包裹后长度必须一致
  const mineBlob = userBlob(ACCOUNT, { keyHex: FIXED_KEY_HEX })
  const theirBlob = upstream.userBlob(ACCOUNT, COSY_RSA_KEY)
  assert.equal(mineBlob.key.length, theirBlob.key.length)
  assert.equal(mineBlob.info.length, theirBlob.info.length)
})

test('交叉对照：两条 /algo 路径与上游字面量逐字节一致（防手抄/显示改写漂移）', { skip: !existsSync(UPSTREAM) }, () => {
  const text = readFileSync(UPSTREAM, 'utf8')
  const chat = /const CHAT_PATH = "([^"]+)"/.exec(text)?.[1]
  const models = /const MODELS_PATH = "([^"]+)"/.exec(text)?.[1]
  assert.ok(chat && models, '上游应能找到 CHAT_PATH / MODELS_PATH')
  // 逐字节比对：任何手抄笔误（少个参数、换个路径段）都会被这条挡下
  assert.equal(COSY_CHAT_PATH, chat)
  assert.equal(COSY_MODELS_PATH, models)
  assert.equal(Buffer.from(COSY_CHAT_PATH, 'utf8').equals(Buffer.from(chat, 'utf8')), true)
})
