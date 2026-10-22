// 回归：`modelApiUrlBase` 是**不带协议的裸域名**，必须补 https:// 才能拼 URL。
//
// 真实踩到的 bug：上游 `/v1/claw/client-permission-validate` 返回
// `"modelApiUrlBase": "officeace.cn-southwest-2.huaweicloud-agentarts.com"`（无协议），
// 直接拼 `/v2/models` 会 `TypeError: Failed to parse URL`，症状是「目录永远为空、对话永远失败」，
// 但登录看起来完全成功 —— 最容易误判成「没开通 MaaS」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCredential } from '../src/shared.mjs'
import { officeaceChannel } from '../src/officeace.mjs'

const BASE = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com'

/** 用假凭据 + 拦 fetch，观察最终拼出的 URL（不发真请求）。 */
const captureUrl = async (modelApiUrlBase) => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (input) => {
    captured = typeof input === 'string' ? input : input.url
    // 目录要返回可解析的壳；对话直接回 200
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const cred = { modelAppKey: 'k', modelAppSecret: 's', modelApiUrlBase }
    await officeaceChannel.catalog(cred)
    const catalogUrl = captured
    await officeaceChannel.chat(cred, { body: { model: 'x', messages: [] } })
    return { catalogUrl, chatUrl: captured }
  } finally {
    globalThis.fetch = original
  }
}

test('裸域名（无协议）必须补 https://', async () => {
  const { catalogUrl, chatUrl } = await captureUrl('officeace.cn-southwest-2.huaweicloud-agentarts.com')
  assert.equal(catalogUrl, `${BASE}/v2/models`)
  assert.equal(chatUrl, `${BASE}/v2/chat/completions`)
})

test('已带 https:// 的不重复加', async () => {
  const { catalogUrl } = await captureUrl(BASE)
  assert.equal(catalogUrl, `${BASE}/v2/models`)
})

test('带尾部斜杠的不产生双斜杠', async () => {
  const { catalogUrl } = await captureUrl(`${BASE}/`)
  assert.equal(catalogUrl, `${BASE}/v2/models`)
  assert.ok(!catalogUrl.includes('//v2'), '不应出现双斜杠')
})

test('缺失 modelApiUrlBase 时回落官方直连域', async () => {
  const { catalogUrl } = await captureUrl(undefined)
  assert.equal(catalogUrl, 'https://api.modelarts-maas.com/v2/models')
})

test('真实凭据（若有）能拼出可解析的 URL', async () => {
  const cred = loadCredential('officeace')
  if (!cred) return // 未登录时跳过：这是可选的实机断言
  const base = cred.modelApiUrlBase?.startsWith('http')
    ? cred.modelApiUrlBase
    : `https://${cred.modelApiUrlBase}`
  assert.doesNotThrow(() => new URL(`${base.replace(/\/+$/, '')}/v2/models`))
})
