// 重叠渠道的开关文件工具 —— **手工跑**，不随 npm 发布（包对开关文件只读）。
//
// 用法：
//   node tools/set-channels.mjs all                          # 十条全开
//   node tools/set-channels.mjs officeace,autoclawintl       # 只开列出的
//   node tools/set-channels.mjs --show                       # 看当前开关
//   node tools/set-channels.mjs --clear                      # 回到默认五条
//
// 写的是 `~/.config/magpie/providers-hub.json`（本插件加载时只读它）。
// ⚠️ 改完要**重启 magpie**：注册与否在插件加载那一刻决定。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { hubSwitchPath } from '../src/shared.mjs'
import { OVERLAPPING_CHANNEL_IDS, DEFAULT_PROVIDER_IDS } from '../src/aggregate.mjs'

function show() {
  const p = hubSwitchPath()
  if (!existsSync(p)) {
    console.log(`未设置（${p} 不存在）→ 默认只注册五条：\n  ${DEFAULT_PROVIDER_IDS.join('\n  ')}`)
    return
  }
  console.log(`开关文件：${p}`)
  console.log(readFileSync(p, 'utf8'))
}

function write(value) {
  const p = hubSwitchPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify({ extraChannels: value }, null, 2)}\n`, 'utf8')
  console.log(`已写入 ${p}：`)
  console.log(readFileSync(p, 'utf8'))
  console.log('⚠️ 重启 magpie 生效（注册与否在插件加载那一刻决定）。')
}

const arg = process.argv[2]?.trim()
if (!arg || arg === '--show') {
  show()
  process.exit(0)
}
if (arg === '--clear') {
  const p = hubSwitchPath()
  if (existsSync(p)) {
    write([])
    console.log('（空数组 = 回到默认五条；也可以直接删掉这个文件）')
  } else {
    console.log('本来就没有开关文件，无需清理。')
  }
  process.exit(0)
}

const ids = arg === 'all' ? 'all' : arg.split(',').map((s) => s.trim()).filter(Boolean)
if (ids !== 'all' && ids.length === 0) {
  console.error('没认出任何渠道 id。可用值：all 或逗号分隔的：' + OVERLAPPING_CHANNEL_IDS.join(','))
  process.exit(2)
}
write(ids)
