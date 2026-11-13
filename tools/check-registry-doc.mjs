#!/usr/bin/env node
// REGISTRY_PR.md ↔ 代码 一致性检查（不进发布包：files 未列 tools/）。
//
// 检查什么：
//   1. REGISTRY_PR.md 里那段 registry.json 条目能被 JSON.parse；
//   2. 它的 providers 与 tools/registry-entry.mjs 从 package.json files 实推的 11 条逐项相等；
//   3. 它的 summary 与 registry-entry.mjs 的 SUMMARY 同文（防止只改了一处）；
//   4. summary.zh 在 700 字以内、开头是总览句、不以七牛收尾。
//
// 为什么要它：手改 package.json 的 files 却忘了改 REGISTRY_PR.md，是最容易漏的一步。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fence = '```'
const fenceJson = `${fence}json`

function extractEntry(markdown) {
  const start = markdown.indexOf(fenceJson)
  if (start < 0) throw new Error(`REGISTRY_PR.md 里没有 ${fenceJson} 片段`)
  const bodyStart = markdown.indexOf('{', start)
  if (bodyStart < 0) throw new Error('片段里没有 JSON 对象起点')
  const bodyEnd = markdown.indexOf(`${fence}`, bodyStart)
  if (bodyEnd < 0) throw new Error('片段没有闭合的代码围栏')
  const raw = markdown.slice(bodyStart, bodyEnd).trim()
  return { raw, entry: JSON.parse(raw) }
}

export function checkRegistryDoc(markdown, { shippedIds, summary }) {
  const problems = []
  let entry
  try {
    ({ entry } = extractEntry(markdown))
  } catch (error) {
    return [`REGISTRY_PR.md 片段解析失败：${error.message}`]
  }
  if (entry.package !== 'magpie-providers-hub') problems.push(`package 应为 magpie-providers-hub，实际 ${entry.package}`)
  if (entry.community !== true) problems.push('community 必须为 true（否则拿不到绿标）')
  if (!Array.isArray(entry.providers)) return [...problems, 'providers 不是数组']
  if (entry.providers.length !== shippedIds.length) {
    problems.push(`providers 条数 ${entry.providers.length}，files 实推 ${shippedIds.length}`)
  }
  for (const id of shippedIds) {
    if (!entry.providers.includes(id)) problems.push(`providers 少了 ${id}`)
  }
  for (const id of entry.providers) {
    if (!shippedIds.includes(id)) problems.push(`providers 多了 ${id}（package.json files 里没有对应渠道文件）`)
  }
  if (new Set(entry.providers).size !== entry.providers.length) problems.push('providers 有重复 id')
  const zh = entry.summary?.zh ?? ''
  const en = entry.summary?.en ?? ''
  if (zh !== summary.zh) problems.push('REGISTRY_PR.md 的 summary.zh 与 tools/registry-entry.mjs 的 SUMMARY.zh 不同文')
  if (en !== summary.en) problems.push('REGISTRY_PR.md 的 summary.en 与 tools/registry-entry.mjs 的 SUMMARY.en 不同文')
  const zhLen = [...zh].length
  if (zhLen > 700) problems.push(`summary.zh ${zhLen} 字，超过 700`)
  // 总览句头随渠道数走：条数变了这里也要变（与 registry-entry.mjs 的 ZH_HEAD 同源较松）
  if (![...zh].slice(0, 14).join('').startsWith('十二家供应商一起装')) problems.push('summary.zh 开头不是总览句')
  if (/七牛[^。]*$/.test(zh)) problems.push('summary.zh 以七牛收尾，卡片截断会像七牛专用插件')
  return problems
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const markdown = readFileSync(join(root, 'REGISTRY_PR.md'), 'utf8')
  const { SHIPPED_IDS, SUMMARY, shippedIdsFromPackage, assertSummary } = await import('./registry-entry.mjs')
  const shipped = shippedIdsFromPackage()
  const problems = [
    ...checkRegistryDoc(markdown, { shippedIds: shipped, summary: SUMMARY }),
    ...assertSummary(SUMMARY),
  ]
  if (problems.length > 0) {
    console.error(`REGISTRY_PR.md 一致性检查失败：\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }
  const { entry } = extractEntry(markdown)
  console.log(
    `REGISTRY_PR.md 与代码一致：${entry.providers.length} 条渠道，summary.zh ${[...entry.summary.zh].length} 字，summary.en ${entry.summary.en.length} 字符`,
  )
  void SHIPPED_IDS
}