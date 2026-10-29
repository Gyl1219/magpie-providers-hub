/**
 * 凭据落盘的两条命门（真机 2026-10-29：OfficeAce 一次性 refresh_token 被烧，
 * 卡片从此只会报 401 APIG.0301，只能重新登录）：
 *   ① 旧凭据绝不能覆盖盘上更晚到期的新凭据（下调写入会吞掉轮转出来的新 token）；
 *   ② 写盘失败必须**留痕 + 返回 false**，让调用方下一次还能重试（旧实现静默吞掉，
 *      且调用方无条件记「已写过」→ 新 refresh_token 永远没有第二次落盘机会）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { dirname } from 'node:path'
import { credentialPath, loadCredential, saveCredential, magpieAuthPath } from '../src/shared.mjs'
import { _internal } from '../src/aggregate.mjs'
import { officeaceChannel } from '../src/officeace.mjs'

const NAME = 'testcred'

test('落盘：盘上凭据更晚到期 → 拒绝下调写入（轮转出来的新 refresh_token 不被吞）', () => {
  const p = credentialPath(NAME)
  mkdirSync(dirname(p), { recursive: true })
  // 盘上是「续期成功后的新凭据」（到期晚）
  writeFileSync(p, JSON.stringify({ refreshToken: 'RT-NEW', access: 'A2', expiresAt: '2026-11-01T00:00:00.000Z' }), 'utf8')
  const ok = saveCredential(NAME, { refreshToken: 'RT-OLD', access: 'A1', expiresAt: '2026-10-27T00:00:00.000Z' })
  assert.equal(ok, false, '下调写入必须被拒')
  const kept = loadCredential(NAME)
  assert.equal(kept.refreshToken, 'RT-NEW', '盘上必须还是新 refresh_token')
  assert.equal(kept.access, 'A2')
})

test('落盘：更晚到期的凭据正常写入（重新登录不受下调保护影响）', () => {
  const p = credentialPath(NAME)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ refreshToken: 'RT-OLD', expiresAt: '2026-10-27T00:00:00.000Z' }), 'utf8')
  const ok = saveCredential(NAME, { refreshToken: 'RT-FRESH', expiresAt: '2026-12-01T00:00:00.000Z' })
  assert.equal(ok, true)
  assert.equal(loadCredential(NAME).refreshToken, 'RT-FRESH')
})

test('落盘：无到期字段的凭据照常写（不因比较不出来而拒写）', () => {
  const p = credentialPath(NAME)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ access: 'A0', expiresAt: '2026-11-01T00:00:00.000Z' }), 'utf8')
  assert.equal(saveCredential(NAME, { access: 'A9' }), true, '解析不出到期 → 不参与比较，必须写')
  assert.equal(loadCredential(NAME).access, 'A9')
})

test('落盘：写失败要返回 false 并留痕（调用方据此保留重试机会）', () => {
  // 把目标路径做成**目录** → rename(文件 → 目录) 在 Windows/Posix 都必失败
  const p = credentialPath(NAME)
  mkdirSync(dirname(p), { recursive: true })
  if (existsSync(p) && !statSync(p).isDirectory()) rmSync(p)
  mkdirSync(p, { recursive: true })
  const warnings = []
  const origin = console.warn
  console.warn = (m) => warnings.push(String(m))
  try {
    const ok = saveCredential(NAME, { refreshToken: 'X', expiresAt: '2026-12-01T00:00:00.000Z' })
    assert.equal(ok, false, 'rename 到目录必失败 → 必须返回 false（不能静默当成功）')
    assert.ok(warnings.some((w) => w.includes('落盘失败')), '失败必须 console.warn 留痕（不许静默）')
  } finally {
    console.warn = origin
    rmSync(p, { recursive: true, force: true })
  }
})

test('旁路：identity 变了就一定重写（refresh_token 轮转不被「身份未变」跳过）', () => {
  const channel = { id: 'officeace', displayName: 'OfficeAce' }
  const before = { refreshToken: 'RT-1', access: 'A1', expiresAt: '2026-10-27T00:00:00.000Z' }
  _internal.writeSidecar(channel, before)
  const p = credentialPath('officeace')
  assert.equal(loadCredential('officeace')?.refreshToken, 'RT-1')
  // 续期后的新凭据：账号没变，但 refresh_token 轮转了 → 必须落盘
  _internal.writeSidecar(channel, { refreshToken: 'RT-2', access: 'A2', expiresAt: '2026-11-02T00:00:00.000Z' })
  assert.equal(loadCredential('officeace')?.refreshToken, 'RT-2', '轮转出的新 refresh_token 必须落盘')
  assert.ok(existsSync(p))
})

test('OfficeAce 续期失败文案：refresh_token 已被消费要单独成句（不是网络抖动）', async () => {
  const originFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ error_code: 'STS5.1806', error_msg: "invalid refresh token: 'the refresh token has been used'" }), { status: 400 })
  }
  try {
    // DPoP 私钥必须是真 EC P-256（编的 JWK 会在 importKey 处先炸，测不到文案）
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
    const cred = {
      refreshToken: 'rt', access: 'a', secret: 's', securityToken: 'st',
      expiresAt: '2026-10-27T00:00:00.000Z',
      dpopPrivateJwk: jwk,
    }
    await assert.rejects(
      () => officeaceChannel.refresh(cred, () => {}),
      /已被消费/,
      'STS5.1806 必须明说「已被消费」，让用户直接去重新登录而不是反复重试',
    )
  } finally {
    globalThis.fetch = originFetch
  }
})

test('magpieAuthPath 指向 magpie 的 plugin-auth.json（凭据双写的落点）', () => {
  assert.match(magpieAuthPath(), /plugin-auth\.json$/)
})
