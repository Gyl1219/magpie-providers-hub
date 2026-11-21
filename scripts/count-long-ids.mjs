#!/usr/bin/env node
// scripts/count-long-ids.mjs —— 逐字节统计某渠道模块导出的长 id 在仓库里的出现次数
//
// 为什么需要它：本机显示层会把长 id（如模型 id）渲染成另一个名字，用人眼读、用
// Select-String 搜都可能得到 0 命中，实际字节却不一样。唯一可靠的是 Buffer 比对。
//
// 用法：
//   node scripts/count-long-ids.mjs src/qwenwork-intl.mjs
//   node scripts/count-long-ids.mjs src/qwenwork-intl.mjs --list   （连同 0 命中的文件一起列出）
//
// 判据：每个长 id 只允许在「目标模块」里出现恰好 1 次（定义行）；注释也算，
//       因为注释是下一次手抄的起点。短名（< 8 字符）是通用模型键，不参与统计。
//
// 依赖：node 18+ 内置模块。退出码 0 = 全部 OK，1 = 有违例，2 = 用法错误。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Windows 的 relative() 给反斜杠，命令行传正斜杠；比较前必须归一化，
// 否则明明合规的文件也会被判 BAD（本脚本第一版就栽在这里）。
const normalize = (p) => p.split(sep).join('/')

const args = process.argv.slice(2)
const listAll = args.includes('--list')
const targetArg = args.find((a) => !a.startsWith('--'))
if (!targetArg) {
  console.error('用法：node scripts/count-long-ids.mjs <渠道模块路径> [--list]')
  process.exit(2)
}

const target = normalize(relative('.', resolve(targetArg)))
const mod = await import(pathToFileURL(resolve(targetArg)).href)

// 认任何导出的字符串数组常量；按长度 ≥ 8 筛出长 id
const ids = [...new Set(Object.values(mod)
  .filter((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'))
  .flat()
  .filter((id) => id.length >= 8))]
if (ids.length === 0) {
  console.error(`${targetArg} 没有导出长 id 数组（如 FALLBACK_MODEL_IDS），无事可查`)
  process.exit(1)
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])
const walk = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // 目录不存在（例如某些仓库没有 tests/）就当空
  }
  return entries.flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return []
    const full = join(dir, e.name)
    if (e.isDirectory()) return walk(full)
    return /\.(mjs|js|cjs)$/.test(e.name) ? [full] : []
  })
}

const rootFiles = readdirSync('.', { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(mjs|js|cjs)$/.test(e.name))
  .map((e) => e.name)

const files = [...new Set([...walk('src'), ...walk('tests'), ...walk('scripts'), ...rootFiles])]

let bad = 0
for (const id of ids) {
  const needle = Buffer.from(id, 'utf8').toString('hex')
  for (const file of files) {
    const hex = Buffer.from(readFileSync(file, 'utf8'), 'utf8').toString('hex')
    let count = 0
    for (let at = hex.indexOf(needle); at !== -1; at = hex.indexOf(needle, at + needle.length)) count += 1
    if (count === 0 && !listAll) continue
    const where = normalize(relative('.', file))
    const ok = where === target && count === 1
    if (count > 0 && !ok) bad += 1
    console.log(`${count === 0 ? '--  ' : ok ? 'OK  ' : 'BAD '} ${where} ×${count}  ${JSON.stringify(id)}`)
  }
}

console.log(bad === 0
  ? `\n通过：${ids.length} 个长 id，每个只在 ${target} 里出现 1 次`
  : `\n失败：${bad} 处违例（长 id 只许在 ${target} 定义一次）`)
process.exit(bad === 0 ? 0 : 1)