// 分组目录解析的离线自检（不联网、不需要真 token）。
// 真机 `model/list` 是分组形状，本仓 catalog 要认它，否则国际站目录永远退成兜底表。
// 用法：node verify-qwenwork-grouped-catalog.mjs   → 期望最后一行 "OK"、退出码 0。
// 依赖：仅 Node 22+（ESM、全局 fetch/Response）。
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const { catalog, FALLBACK_MODEL_IDS } = await import(pathToFileURL(`${process.cwd()}/src/qwenwork-intl.mjs`).href)

/** 兜底三条按上游顺序排序后的期望（从常量算，别在这里手抄 id —— 抄一份漂一份）。 */
const FALLBACK_SORTED = [...FALLBACK_MODEL_IDS].sort()

// 形状取自对 `/algo/api/v2/model/list?Encode=1` 的匿名签名探针响应（组里才是条目）
const GROUPED = {
  chat: {
    models: [
      { key: 'auto', display_name: '自动', is_default: true, context_config: { max_input_tokens: 262144 } },
      { key: 'qwen3.8-max', display_name: 'Qwen3.8-Max', is_reasoning: true, max_input_tokens: 131072 },
    ],
  },
  qwork: { items: [{ key: 'qwork-pro', display_name: '办公高级', context_config: { max_input_tokens: 65536, max_output_tokens: 16384 } }] },
  qcode: [{ key: 'qcode-coder', display_name: '代码' }],
  assistant: { list: [] },
  byok_teams: { models: [{ key: 'byok-x', display_name: '自带 Key' }] },
}

// 目录已迁到 /algo + COSY 签名：凭据必须带 uid 与 machineId，否则 catalog 直接退兜底表
// （缺身份时打过去必然是 401，白挨一次）。
const CRED = { access_token: 'AT-OFFLINE', uid: 'u-offline', machineId: 'mid-offline' }

const withStub = async (body, fn) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    calls.push(typeof input === 'string' ? input : input.url)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const models = await withStub(GROUPED, () => catalog(CRED))
assert.deepEqual(
  Object.keys(models).sort(),
  ['auto', 'qcode-coder', 'qwen3.8-max', 'qwork-pro'],
  '三组条目的 key 都该进目录；空组与 byok_* 组不该进',
)
assert.equal(models.auto.name, '自动')
assert.equal(models.auto.limit.context, 262144, 'context_config.max_input_tokens 要认')
assert.equal(models['qwen3.8-max'].limit.context, 131072, '顶层 max_input_tokens 也要认')
assert.equal(models['qwork-pro'].limit.output, 16384, 'context_config.max_output_tokens 要认')
assert.equal('byok-x' in models, false, 'byok 组要用用户自己的 key，列出来只会 400')

// 全空的分组 → 退回兜底表，不能返回空目录（空目录会让下拉框整个消失）
const empty = await withStub({ chat: { models: [] }, assistant: [] }, () => catalog(CRED))
assert.deepEqual(Object.keys(empty).sort(), FALLBACK_SORTED, '空分组要退回兜底三条')

// 扁平形状仍优先（旧路线没被这次改动破坏）
const flat = await withStub({ object: 'list', data: [{ id: 'flat-1', context_length: 32000 }] }, () => catalog(CRED))
assert.deepEqual(Object.keys(flat), ['flat-1'])
assert.equal(flat['flat-1'].limit.context, 32000)

// 缺 COSY 身份 → 一个请求都不发，直接兜底（打了必然 401）
// ⚠️ 计数必须在 catalog 跑完之后取，否则是恒真式（0 == 0 什么也没证明）
const anonModels = await withStub(GROUPED, (calls) => catalog({ access_token: 'AT-OFFLINE' })
  .then((m) => ({ m, sent: calls.length })))
assert.equal(anonModels.sent, 0, '缺 uid/machineId 时不得发请求（发了必 401）')
assert.deepEqual(Object.keys(anonModels.m).sort(), FALLBACK_SORTED)

console.log('OK 分组=%d 条、空分组退兜底、扁平形状不受影响、缺身份不发请求', Object.keys(models).length)