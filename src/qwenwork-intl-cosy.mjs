// 千问办公（国际版）的 COSY 信封 —— 纯函数，不发网络请求、不读磁盘。
//
// ## 为什么需要它
//
// 实测（2026-11-21，匿名打 openapi.qoder.sh）：
//   · /api/v1/models                     → 401 {"errorCode":"Unauthorized","errorMessage":"User not authenticated"}
//   · /api/v1/chat/completions            → 401 同上，**带假 Bearer 也是这一条**（不是「token 无效」）
//   · /algo/api/v2/model/list?Encode=1    → 403 {"code":"101","message":"Signature invalid"}（带假 Bearer 也一样）
//   · 不存在的随机路径                    → 404
// 结论：/algo 路由存在，但它不认普通 Bearer、只认 COSY 签名；/api/v1/* 那条用 Bearer
// 的写法不但没验过，连「路径存在」都只能靠 401 猜。目录与对话都必须走 /algo + 本文件。
//
// ## 来源
//
// 逻辑逐条移植自上游 @magpie-community/opencode-qoder-auth@0.3.0 的解包产物
// `D:\qwenwork-intl\_inspect\package\index.mjs` 的 userBlob / cosyHeaders /
// chatHeaders / machineOS / machineHostname / segmentEncode / swapThirds / encodeBody。
// 只搬纯逻辑：不搬宿主调用、不搬 asar 里的其它内容。RSA 公钥是该协议公开常量
// （客户端里就有），按 admin 的许可内联。
//
// ## 没验的
//
// 签名只在离线可复现：payload/sig/body 编码都能对着上游公式逐字节重建，
// 但**没有一条真机把 COSY 头打活过**（需要真 token + uid + machineId）。

import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { domainToASCII } from 'node:url'

// ── 常量 ──────────────────────────────────────────────────────────────────

/** 客户端构建号；上游注释：跟桌面端 app（0.4.8 / 79743374）走，不是 CLI 的号。 */
export const COSY_VERSION = '1.1.69'

/** COSY 信封里的 AES-128 密钥被这把 1024 位 RSA 公钥包裹（客户端 cosy 常量）。 */
export const COSY_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/**
 * 客户端打乱过的 base64 字母表（`$` 补位）。这是协议常量，顺序错了 body 就解不出来。
 * 注意里面既有 `$` 也有 `#`，别按普通 base64 处理。
 */
export const COSY_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'

/** 目录与对话的真实路径（上游 CHAT_PATH / MODELS_PATH 原样）。 */
export const COSY_CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
export const COSY_MODELS_PATH = '/algo/api/v2/model/list?Encode=1'

// ── 机器标识 ──────────────────────────────────────────────────────────────

/** `x86_64_win32` / `aarch64_darwin`：只重命名 x64 与 arm64，其它按 Node 原值。 */
export function machineOS(arch = process.arch, platform = process.platform) {
  const renamed = { x64: 'x86_64', arm64: 'aarch64' }[arch] ?? arch
  return `${renamed}_${platform}`
}

const HOST_SAFE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u

/**
 * `Cosy-MachineHostname`：可打印 ASCII 原样发；否则 punycode；再否则清洗后带原串
 * 的 8 位哈希；上限 96 字符。空名 → 空串（调用方据此决定发不发）。
 */
export function machineHostname(name = hostname()) {
  const hash = (v) => createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 8)
  const cap = (v) => {
    if (v.length <= 96) return v
    const head = v.slice(0, 96 - 8 - 1).replace(/[-\s]+$/u, '')
    return head ? `${head}-${hash(v)}` : `unknown-${hash(v)}`
  }
  const value = String(name ?? '').trim()
  if (!value) return ''
  if (HOST_SAFE.test(value)) return cap(value)
  const ascii = domainToASCII(value)
  if (ascii && HOST_SAFE.test(ascii)) return cap(ascii)
  const safe = value.replace(/[^\x21-\x7e]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^-+|-+$/gu, '')
  return cap(safe ? `${safe}-${hash(value)}` : `unknown-${hash(value)}`)
}

// ── body 编解码 ───────────────────────────────────────────────────────────

/**
 * 按 COSY_ALPHABET 做 6 bit 分组编码，末尾用 `$` 补到 4 的倍数。
 * 逐字节移植自上游 segmentEncode（24 位累加器，与标准 base64 同构、只换字母表）。
 */
export function segmentEncode(bytes) {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += COSY_ALPHABET[(acc >> bits) & 63]
    }
  }
  if (bits > 0) out += COSY_ALPHABET[(acc << (6 - bits)) & 63]
  while (out.length % 4) out += '$'
  return out
}

/** 首尾各三分之一对调（中间不动）。长度不是 3 的倍数时 t 向下取整。 */
export function swapThirds(s) {
  const t = Math.floor(s.length / 3)
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s
}

/** 请求体上线形态：JSON 文本 → segmentEncode → swapThirds。签名必须签这个串。 */
export const encodeBody = (text) => swapThirds(segmentEncode(Buffer.from(text, 'utf8')))

/** encodeBody 的逆（只给测试与排查用；宿主不需要解自己的请求）。 */
export function decodeBody(wire) {
  const s = swapThirds(wire)
  const out = []
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== '$').map((c) => COSY_ALPHABET.indexOf(c))
    if (vals.some((v) => v < 0)) throw new Error('COSY body 里有字母表外的字符')
    let x = 0
    for (const v of vals) x = x * 64 + v
    const n = Math.floor((6 * vals.length) / 8)
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255)
  }
  return Buffer.from(out).toString('utf8')
}

// ── 信封 ──────────────────────────────────────────────────────────────────

export const hexID = () => randomUUID().replaceAll('-', '')

/**
 * 账号在信封里的样子：AES-128-CBC，key 自己当 IV，再把 key 用 RSA 公钥包裹。
 * `u.uid` / `u.access`（登录 token）缺一不可 —— 上游同样直接拿它们拼 JSON。
 */
export function userBlob(u, { rsaKey = COSY_RSA_KEY, keyHex = hexID() } = {}) {
  const raw = JSON.stringify({
    uid: u?.uid,
    aid: '',
    name: u?.name ?? '',
    email: u?.email ?? '',
    security_oauth_token: u?.access,
  })
  const key = Buffer.from(keyHex.slice(0, 16))
  const cipher = createCipheriv('aes-128-cbc', key, key)
  const info = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]).toString('base64')
  const wrapped = publicEncrypt({ key: rsaKey, padding: constants.RSA_PKCS1_PADDING }, key).toString('base64')
  return { info, key: wrapped }
}

/** 签名路径：`new URL(url).pathname`，且剥掉开头的 `/algo`（5 个字符）。 */
export function cosySignPath(url) {
  const pathname = url instanceof URL ? url.pathname : new URL(String(url)).pathname
  return pathname.startsWith('/algo') ? pathname.slice(5) : pathname
}

/**
 * `md5(payload \n wrappedKey \n ts \n wireBody \n path)` —— 五行、`\n` 分隔、无尾换行。
 * 顺序错一位签名就废；body 必须是**上线形态**（encodeBody 之后），不是明文 JSON。
 */
export function cosySignature({ payload, wrappedKey, ts, body, path }) {
  return createHash('md5').update(`${payload}\n${wrappedKey}\n${ts}\n${body}\n${path}`).digest('hex')
}

/**
 * 造信封：payload 是 base64(JSON{v1,requestId,info,cosyVersion,ideVersion:''})。
 * `info` 就是 userBlob 的密文；wrappedKey 单独发在 `Cosy-Key` 头里，也进签名。
 */
export function cosyEnvelope(u, {
  rsaKey = COSY_RSA_KEY,
  keyHex = hexID(),
  requestId = randomUUID(),
  cosyVersion = COSY_VERSION,
} = {}) {
  const blob = userBlob(u, { rsaKey, keyHex })
  const payload = Buffer.from(JSON.stringify({
    version: 'v1',
    requestId,
    info: blob.info,
    cosyVersion,
    ideVersion: '',
  })).toString('base64')
  return { payload, key: blob.key, requestId }
}

// ── 请求头 ────────────────────────────────────────────────────────────────

/**
 * 普通 COSY 调用（目录、额度等）的头。
 *
 * `site` 只需两三个字段：`{ name, clientType, businessProduct, modelScene, cosyVersion }`，
 * 这里给默认值与上游一致（10 / app / agent / 1.1.69）。
 */
export function cosyHeaders(url, u, body, site = {}, {
  ts = Math.floor(Date.now() / 1000),
  machineId = u?.machineId,
  rsaKey = site.rsaKey ?? COSY_RSA_KEY,
  keyHex,
  requestId,
} = {}) {
  if (!machineId) throw new Error(`${site?.name ?? 'qwenwork-intl'}：账号没有 machineId，请重新登录`)
  const envelope = cosyEnvelope(u, { rsaKey, keyHex, requestId, cosyVersion: site.cosyVersion ?? COSY_VERSION })
  const path = cosySignPath(url)
  const sig = cosySignature({ payload: envelope.payload, wrappedKey: envelope.key, ts, body, path })
  return {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/json',
    Authorization: `Bearer COSY.${envelope.payload}.${sig}`,
    'Cosy-Business-Product': site.businessProduct ?? 'app',
    'Cosy-Business-Type': 'agent',
    'Cosy-ClientIp': machineId,
    'Cosy-ClientType': site.clientType ?? '10',
    'Cosy-Data-Policy': 'disagree',
    'Cosy-Date': String(ts),
    'Cosy-Key': envelope.key,
    'Cosy-MachineId': machineId,
    'Cosy-MachineToken': machineId,
    'Cosy-MachineType': '5',
    'Cosy-MachineOS': machineOS(),
    'Cosy-Scene': site.modelScene ?? 'app',
    'Cosy-User': u?.uid,
    'Cosy-Version': site.cosyVersion ?? COSY_VERSION,
    'Login-Version': 'v2',
  }
}

/**
 * 对话请求的头：从 cosyHeaders 去掉 ClientIp / MachineToken / MachineType，
 * 再按设备身份（`identity`，来自签到读到的 runtime-info）补回后两个，
 * 加 hostname，并把 Accept 换成 SSE、带上模型来源键。
 */
export function chatHeaders(url, u, body, site = {}, model = {}, identity = {}, options = {}) {
  const headers = cosyHeaders(url, u, body, site, options)
  delete headers['Cosy-ClientIp']
  delete headers['Cosy-MachineToken']
  delete headers['Cosy-MachineType']
  for (const key of ['Cosy-MachineToken', 'Cosy-MachineType']) {
    if (identity[key]) headers[key] = identity[key]
  }
  const host = machineHostname()
  if (host) headers['Cosy-MachineHostname'] = host
  return {
    ...headers,
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...(model.key ? { 'X-Model-Key': model.key } : {}),
    ...(model.source ? { 'X-Model-Source': model.source } : {}),
  }
}
