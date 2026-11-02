// AStudio chat 自愈链 + 行路由回归（2026-11-01 真机 404 事故）：
//   推理网关随 configs 行内 base_url 下发（会搬家），api_key 按次下发短时有效。
//   旧行为（硬编码基址 + 登录时一把 key 用到底）→ 推理恒 404「API endpoint not found」
//   而目录正常（假象）。新行为：按行路由 + 401/404 时重取自愈 + 会话死明示重登。
//   全部 stub fetch，不碰真机。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CHAT_URL = 'https://maas-api.test/v2/chat/completions'
const LEGACY_URL = 'https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/chat/completions'
const CREDENTIAL = {
  accessToken: 'KEY-1',
  ssoSessionId: 'sso',
  token: 't',
  accountId: 'a',
  endpoints: [{ model: 'spark-x', baseUrl: 'https://maas-api.test/v2', apiKey: 'ROW-KEY-1' }],
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('chat：按 configs 行路由 —— 打行内 base_url，带行内 api_key（不碰旧硬编码基址）', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    seen.push({ url: String(input), auth: String(init.headers?.authorization ?? '') })
    return json({ choices: [{ message: { content: 'ok' } }] })
  }
  try {
    const res = await astudioChannel.chat(CREDENTIAL, { body: { model: 'spark-x' } })
    assert.equal(res.status, 200)
    assert.deepEqual(seen, [{ url: CHAT_URL, auth: 'Bearer ROW-KEY-1' }])
  } finally {
    globalThis.fetch = original
  }
})

test('chat：无端点表（旧凭据）→ 退回旧硬编码基址 + accessToken 兜底', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    seen.push({ url: String(input), auth: String(init.headers?.authorization ?? '') })
    return json({ choices: [] })
  }
  try {
    const res = await astudioChannel.chat({ accessToken: 'KEY-1' }, { body: { model: 'spark-x' } })
    assert.equal(res.status, 200)
    assert.deepEqual(seen, [{ url: LEGACY_URL, auth: 'Bearer KEY-1' }])
  } finally {
    globalThis.fetch = original
  }
})

test('chat：401 → 重取 api_key 后按新端点重试成功（上游 refresh-and-retry 同款）', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  const original = globalThis.fetch
  const seen = []
  let chatCalls = 0
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url === CHAT_URL) {
      chatCalls += 1
      seen.push(String(init.headers?.authorization ?? ''))
      return chatCalls === 1 ? json({ error: { message: 'Unauthorized' } }, 401) : json({ choices: [{ message: { content: 'ok' } }] })
    }
    if (String(input).includes('/bot/models/configs')) {
      return json({ code: 0, data: [{ model: 'spark-x', base_url: 'https://maas-api.test/v2', api_key: 'ROW-KEY-2' }] })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  try {
    const res = await astudioChannel.chat(CREDENTIAL, {
      body: { model: 'spark-x' },
      renew: (c) => astudioChannel.refresh(c),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(seen, ['Bearer ROW-KEY-1', 'Bearer ROW-KEY-2'], '第二次请求必须带重取后的行内 key')
  } finally {
    globalThis.fetch = original
  }
})

test('chat：404 且会话死（80000）→ 401 + 明确「请重新登录」（不装作模型不存在）', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  const original = globalThis.fetch
  let balanceProbes = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === CHAT_URL) return json({ error: { message: 'API endpoint not found', type: 'not_found_error' } }, 404)
    if (url.includes('/points/balance')) {
      balanceProbes += 1
      return json({ code: 80000, desc: '登录异常，请重新登录' })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  try {
    const res = await astudioChannel.chat(CREDENTIAL, {
      body: { model: 'spark-x' },
      renew: (c) => astudioChannel.refresh(c),
    })
    assert.equal(res.status, 401)
    assert.equal(balanceProbes, 1, '404 必须先甄别会话死活')
    const payload = await res.json()
    assert.match(payload.error.message, /重新登录/)
    assert.equal(payload.error.type, 'authentication_error')
  } finally {
    globalThis.fetch = original
  }
})

test('chat：404 且会话活着 → 重取 key 重试；仍 404 → 原样透传（模型真不存在）', async () => {
  const { astudioChannel } = await import('../src/astudio.mjs')
  const original = globalThis.fetch
  let chatCalls = 0
  let configCalls = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === CHAT_URL) {
      chatCalls += 1
      return json({ error: { message: 'API endpoint not found' } }, 404)
    }
    if (url.includes('/points/balance')) return json({ code: 0, data: { totalBalance: 100 } })
    if (url.includes('/bot/models/configs')) {
      configCalls += 1
      return json({ code: 0, data: [{ model: 'spark-x', base_url: 'https://maas-api.test/v2', api_key: 'ROW-KEY-2' }] })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  try {
    const res = await astudioChannel.chat(CREDENTIAL, {
      body: { model: 'spark-x' },
      renew: (c) => astudioChannel.refresh(c),
    })
    assert.equal(res.status, 404, '重取后仍 404 = 模型真不存在，原样透传')
    assert.equal(chatCalls, 2, '最多重试一次')
    assert.equal(configCalls, 1, '只重取一次')
  } finally {
    globalThis.fetch = original
  }
})
