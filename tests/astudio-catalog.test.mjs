// AStudio 目录 / 推理信封回归（全部 stub fetch）。
//
// 覆盖两件报错才算数的事：
//   1. 目录信封是 `{code,message,data:{models:[…]}}` —— data 是**对象**不是数组，
//      且模型 id 字段叫 `slug`。旧判据吃不到 → 目录恒空 → 一直用两个手写兜底模型
//      → 那两个早就不存在 → 推理端 404（真机 2026-10-29）。
//   2. `builtin/<base64>` 是 acode 内部别名、发上去 502，必须剔除；
//      `supported_in_api:false` 的也不能进目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-astudio-'))
const originalHome = process.env.USERPROFILE
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { astudioChannel } = await import('../src/astudio.mjs')

test.after = () => {
  process.env.USERPROFILE = originalHome
  if (originalHome === undefined) delete process.env.USERPROFILE
  rmSync(sandbox, { recursive: true, force: true })
}

const CRED = { accessToken: 'tok', ssoSessionId: 's' }

const stubFetch = (routes) => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('127.0.0.1')) return original(input, init)
    for (const route of routes) if (url.includes(route.match)) return route.respond()
    return new Response('{}', { status: 200 })
  }
  return { restore: () => { globalThis.fetch = original } }
}

const catalogResponse = () => new Response(JSON.stringify({
  code: 0,
  message: 'success',
  data: {
    models: [
      { slug: 'xopglm52', display_name: 'GLM-5.2', context_window: 1_048_576, input_modalities: ['text'] },
      { slug: 'spark-x2.6', display_name: 'Spark X2.6', context_window: 262_144, input_modalities: ['text', 'image'] },
      // acode 内部别名：发推理端会 502
      { slug: 'builtin/Yml0', display_name: 'builtin' },
      // 不在 API 开放列表：选择器里点了会失败
      { slug: 'hidden-one', display_name: 'Hidden', supported_in_api: false },
    ],
  },
}), { status: 200, headers: { 'content-type': 'application/json' } })

test('目录：`data.models` 信封 + `slug` 字段（旧判据会读到 0 个模型）', async () => {
  const stub = stubFetch([{ match: '/api/v1/model-manager/models', respond: catalogResponse }])
  try {
    const models = await astudioChannel.catalog(CRED)
    const ids = Object.keys(models)
    assert.deepEqual(ids, ['xopglm52', 'spark-x2.6'], `目录不对：${ids.join(',')}`)
    assert.equal(models['xopglm52'].name, 'GLM-5.2')
    assert.equal(models['xopglm52'].limit.context, 1_048_576)
    assert.equal(models['spark-x2.6'].capabilities.attachment, true, 'input_modalities 含 image')
    assert.equal(models['xopglm52'].capabilities.attachment, false)
  } finally {
    stub.restore()
  }
})

test('目录：控制面 code≠0 要带原因抛出（HTTP 200 也算失败）', async () => {
  const stub = stubFetch([{
    match: '/api/v1/model-manager/models',
    respond: () => new Response(JSON.stringify({ code: 80000, message: '登录异常，请重新登录' }), { status: 200 }),
  }])
  try {
    await assert.rejects(() => astudioChannel.catalog(CRED), /登录异常|80000/)
  } finally {
    stub.restore()
  }
})
