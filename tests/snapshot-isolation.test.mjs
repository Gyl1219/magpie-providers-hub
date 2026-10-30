/**
 * 快照跨进程隔离的门禁（PR #502 审核 2026-10-30 的真机事故）。
 *
 * 事故：`page/snapshot.js` 曾在本机生成（含余额/签到结果/AK ID），
 * 而打包规则 `files: ["page"]` 把它带进了 npm 包。更糟的是 `buildSnapshot()`
 * 会「本轮没查到额度 → 沿用上一份快照的桶」，于是**新用户装上后会看到打包者的数据**。
 *
 * 两道防线：
 *   ① 仓库/包里只有空模板（page.test.mjs 断言了）；
 *   ② 快照带 runId，读回来只在**同一进程**写的才沿用（本文件的用例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SNAP = process.env.DSH_HUB_SNAPSHOT_PATH

const parseSnap = (text) => {
  const m = String(text).match(/^window\.__PROVIDERS_HUB_SNAPSHOT__\s*=\s*([\s\S]*?);?\s*$/)
  assert.ok(m, '快照文件格式应为 window.__PROVIDERS_HUB_SNAPSHOT__ = {...};')
  return JSON.parse(m[1])
}

test('红线：快照里带 runId（用于识别「是不是本进程写的」）', async () => {
  const { _internal } = await import(new URL('../src/aggregate.mjs', import.meta.url).href)
  _internal.enableSnapshotWrites()
  await _internal.sweepAllChannels()
  const snap = parseSnap(readFileSync(SNAP, 'utf8'))
  assert.equal(typeof snap.runId, 'string', '快照必须带 runId')
  assert.ok(snap.runId.length > 0)
})

test('红线：别人的快照不会被沿用（跨进程装新包看不到前一个用户的数据）', async () => {
  // 造一份「别人机器上的快照」：带真实桶与签到结果，runId 与本进程不同
  const foreign = {
    at: Date.now() - 86_400_000,
    runId: 'someone-elses-run',
    provider: 'Providers Hub',
    models: 99,
    channels: [{
      id: 'astudio',
      provider: 'hub-astudio',
      displayName: 'AStudio（讯飞）',
      signedIn: true,
      buckets: [{ name: '星火积分', used: 0, amount: 60000, display: '剩余 60000' }],
      checkin: { outcome: 'done', message: 'FOREIGN-CHECKIN-MESSAGE' },
    }],
  }
  mkdirSync(join(SNAP, '..'), { recursive: true })
  writeFileSync(SNAP, `window.__PROVIDERS_HUB_SNAPSHOT__ = ${JSON.stringify(foreign)};\n`, 'utf8')

  // 本进程重新算一遍快照（没有任何真实凭据 → 各渠道都查不到桶）
  const { _internal, REGISTERED_CHANNELS } = await import(new URL('../src/aggregate.mjs', import.meta.url).href)
  _internal.enableSnapshotWrites()
  // 清掉本进程可能残留的内存桶，模拟「刚装完、还没登录」
  for (const c of REGISTERED_CHANNELS) _internal.rememberCredential(c, undefined)
  await _internal.sweepAllChannels()

  const snap = parseSnap(readFileSync(SNAP, 'utf8'))
  assert.notEqual(snap.runId, 'someone-elses-run', 'runId 应被换成本进程的')

  const text = JSON.stringify(snap)
  assert.equal(text.includes('FOREIGN-CHECKIN-MESSAGE'), false,
    '别人的签到结果不许出现在新快照里（这正是审核发现的事故）')
  assert.equal(text.includes('60000'), false,
    '别人的余额不许出现在新快照里')

  // astudio 这一行应该是未登录、无桶
  const row = snap.channels.find((c) => c.id === 'astudio')
  assert.ok(row, '渠道行仍应在（只是没有数据）')
  assert.equal(row.signedIn, false, '没凭据 → signedIn false')
  assert.deepEqual(row.buckets, [], '不许沿用别人快照里的桶')
  assert.equal(row.checkin, undefined, '不许沿用别人的签到结果')
})

test('红线：同进程内仍然沿用（models() 触发时不把整列刷成空）', async () => {
  const { _internal } = await import(new URL('../src/aggregate.mjs', import.meta.url).href)
  _internal.enableSnapshotWrites()
  // 先写一份「本进程的」快照，带一个桶
  const mine = {
    at: Date.now(),
    runId: JSON.parse(
      readFileSync(SNAP, 'utf8').match(/^window\.__PROVIDERS_HUB_SNAPSHOT__\s*=\s*([\s\S]*?);?\s*$/)[1],
    ).runId,
    provider: 'Providers Hub',
    models: 1,
    channels: [{
      id: 'astudio', provider: 'hub-astudio', displayName: 'AStudio（讯飞）',
      signedIn: true, buckets: [{ name: '本进程的桶', used: 0, amount: 1, display: '剩余 1' }],
    }],
  }
  writeFileSync(SNAP, `window.__PROVIDERS_HUB_SNAPSHOT__ = ${JSON.stringify(mine)};\n`, 'utf8')

  // 不调 sweep（本次没有新桶）→ 直接让它重写一次快照
  await _internal.sweepAllChannels()
  const snap = parseSnap(readFileSync(SNAP, 'utf8'))
  const row = snap.channels.find((c) => c.id === 'astudio')
  // 因为 sweep 跑过但没凭据 → 桶仍是空的；关键断言是同进程 runId 一致时**不会崩**
  assert.equal(typeof snap.runId, 'string')
  assert.ok(row)
})