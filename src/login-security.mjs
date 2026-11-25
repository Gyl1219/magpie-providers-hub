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
