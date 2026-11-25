import { randomBytes, timingSafeEqual } from 'node:crypto'

/** A fresh capability for one loopback login window. */
export function createLoginToken() {
  return randomBytes(32).toString('base64url')
}

/** The only browser origin allowed to submit a loopback login form. */
export function loginOrigin(port) {
  return `http://127.0.0.1:${port}`
}

function equalText(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Validate the capability carried in the login page URL. */
export function hasLoginToken(value, token) {
  return typeof value === 'string' && value.length > 0 && equalText(value, token)
}

/** Validate the bearer capability sent by the login page's fetch calls. */
export function hasLoginAuthorization(req, token) {
  const header = req?.headers?.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return equalText(header.slice('Bearer '.length), token)
}

/** State-changing loopback requests must be same-origin POSTs. */
export function isSameOriginPost(req, port) {
  return req?.method === 'POST' && req?.headers?.origin === loginOrigin(port)
}

/**
 * 登录窗口上任意请求的可信判据（路由之前的通用门）。
 *
 * - **POST 必须带本页 Origin**：浏览器对跨站与同源 POST 都发 Origin，所以
 *   `origin !== 本页源`（含 `Origin: null` 的沙箱 iframe）一律是跨站，挡掉。
 *   这正是挡住「任意网页拿攻击者自己的账号密码打 /password/login」的那一条。
 * - **带 Origin 的其它方法也必须同源**：跨站 fetch/XHR 会带 Origin，同源的
 *   导航与同源 fetch 不带 —— 所以「有 Origin 就校验」不会误伤页面自身。
 * - **不带 Origin 的 GET 放行**：登录页本身（`/login`）与页面里的相对取数
 *   走的正是这条，拦了就打不开页面。它们不改登录状态。
 */
export function isTrustedLoopbackRequest(req, port) {
  if (!req) return false // 拿不到请求就是失败关闭，绝不放行
  const origin = req?.headers?.origin
  if (typeof origin === 'string' && origin !== '') return origin === loginOrigin(port)
  return req?.method !== 'POST'
}
