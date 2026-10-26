import { loadCredential } from './src/shared.mjs'
import { officeaceChannel } from './src/officeace.mjs'

const cred = loadCredential('officeace')
// 复用渠道内部：先用 catalog 触发一次拿 maasBase，再手打原始端点
const orig = globalThis.fetch
let raw = null
globalThis.fetch = async (input, init) => {
  const res = await orig(input, init)
  if (String(input).includes('/v2/models') && !String(input).includes('chat')) {
    raw = await res.clone().json().catch(() => null)
  }
  return res
}
await officeaceChannel.catalog(cred)
globalThis.fetch = orig

const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.models) ? raw.models : (Array.isArray(raw?.data) ? raw.data : []))
console.log('原始行数:', rows.length, '顶层键:', raw && typeof raw === 'object' ? Object.keys(raw).join(',') : typeof raw)
console.log('\n=== 全部行的 id + 状态类字段 ===')
for (const row of rows) {
  const id = row?.model ?? row?.id ?? row?.name ?? ''
  const statusKeys = Object.keys(row ?? {}).filter((k) => /status|state|deploy|available|enable|serv|active|valid/i.test(k))
  const status = statusKeys.length > 0 ? statusKeys.map((k) => `${k}=${JSON.stringify(row[k])}`).join(' ') : '(无状态字段)'
  console.log(`${String(id).padEnd(28)} ${status}`)
}
console.log('\n=== glm-5.3-flash 整行 ===')
console.log(JSON.stringify(rows.find((r) => (r?.model ?? r?.id) === 'glm-5.3-flash')))
console.log('\n=== glm-5.3 整行（对照组，能跑）===')
console.log(JSON.stringify(rows.find((r) => (r?.model ?? r?.id) === 'glm-5.3')))
process.exit(0)
