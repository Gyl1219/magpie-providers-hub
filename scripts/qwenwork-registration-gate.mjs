// 千问办公（国际版）注册态门禁的**自检器**：注入违例、跑门禁、还原、比对字节。
//
// 为什么需要它：`tests/qwenwork-intl-registration.test.mjs`（旧名 -unregistered）只有 4 条断言，
// 靠人手工「加回去一处 → 跑一遍 → 再还原」，每次都要重敲 5 处原文，还原还容易漏。
// 这个脚本把那套动作固化成四步，并且**每一步都断言预期结果**：
//
//   1. 基线（当前磁盘状态）         → 门禁必须绿
//   2. 只注入 aggregate 的 lazyChannels 一行（运行时完全不变的半加状态）
//                                  → 门禁必须红，且报「注册不完整」
//   3. 5 处全注入（A 案完整注册）   → 门禁必须绿
//   4. 还原后逐字节比对             → 必须与原始内容 sha256 相同，且门禁仍绿
//
// 第 4 步的字节比对是重点：注入脚本自己改坏文件、或者还原时丢了换行，都算脚本
// 有 bug —— 门禁绿了不代表仓库干净。
//
// 依赖：仅 node 标准库。用法（在仓库根）：
//   node scripts/qwenwork-registration-gate.mjs
// 退出码：0 = 四步全符合预期；1 = 有一步不符（会打印是哪一步、实际退出码与输出尾巴）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// 门禁文件名在某个时刻从 -unregistered 改成 -registration（旧名在 A 案接回注册后
// 名不副实）。两个名字都试，先命中磁盘上真实存在的那个 —— 这样改名脚本和本自检器
// 谁先跑都不会互相绊倒，也不需要在改名时同步改这里。
const GATE_CANDIDATES = [
  join('tests', 'qwenwork-intl-registration.test.mjs'),
  join('tests', 'qwenwork-intl-unregistered.test.mjs'),
]
const GATE =
  GATE_CANDIDATES.find((rel) => existsSync(join(ROOT, rel))) ?? GATE_CANDIDATES[0]

const FILES = ['index.mjs', join('src', 'aggregate.mjs')]
const abs = (rel) => join(ROOT, rel)
const read = (rel) => readFileSync(abs(rel), 'utf8')
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 5 个注册点：原文 → 注入后的样子（每条都要求原文唯一命中，避免改错位置）。 */
const SITES = [
  {
    file: 'index.mjs',
    what: '懒加载名单',
    from: "for (const name of ['lingxi', 'marvis-private', 'doubaowork', 'dola', 'qiniu', 'loomy', 'monkeycode', 'baizhi']) {",
    to: "for (const name of ['lingxi', 'marvis-private', 'doubaowork', 'dola', 'qiniu', 'loomy', 'monkeycode', 'baizhi', 'qwenwork-intl']) {",
  },
  {
    file: 'index.mjs',
    what: '插件函数导出（追加在 baizhi 之后）',
    from: "export const HubBaizhiPlugin = lazy.baizhi ? makeHubPlugin(lazy.baizhi.baizhiChannel) : undefined\n",
    to: "export const HubBaizhiPlugin = lazy.baizhi ? makeHubPlugin(lazy.baizhi.baizhiChannel) : undefined\n"
      + "export const HubQwenworkIntlPlugin = lazy['qwenwork-intl'] ? makeHubPlugin(lazy['qwenwork-intl'].qwenworkIntlChannel) : undefined\n",
  },
  {
    file: 'index.mjs',
    what: 'HUB_PLUGINS 条件展开',
    from: "  ...(HubBaizhiPlugin === undefined ? {} : { HubBaizhiPlugin }),\n}",
    to: "  ...(HubBaizhiPlugin === undefined ? {} : { HubBaizhiPlugin }),\n"
      + "  ...(HubQwenworkIntlPlugin === undefined ? {} : { HubQwenworkIntlPlugin }),\n}",
  },
  {
    file: join('src', 'aggregate.mjs'),
    what: 'lazyChannels 条目',
    from: "  baizhi: './baizhi.mjs',\n",
    to: "  baizhi: './baizhi.mjs',\n  'qwenwork-intl': './qwenwork-intl.mjs',\n",
  },
  {
    file: join('src', 'aggregate.mjs'),
    what: 'CHANNELS 条件展开',
    from: "  ...(lazyLoaded.baizhi ? [lazyLoaded.baizhi] : []),\n",
    to: "  ...(lazyLoaded.baizhi ? [lazyLoaded.baizhi] : []),\n  ...(lazyLoaded['qwenwork-intl'] ? [lazyLoaded['qwenwork-intl']] : []),\n",
  },
]

/**
 * 行尾适配：SITES 里的原文按 LF 写，但仓库在 Windows 上检出过之后可能是 CRLF。
 * 直接 `includes` 会因一个 `\r` 全盘不命中，然后报「命中 0 次」——看着像脚本坏了，
 * 其实是检出配置不同。这里按文件实际行尾把多行原文再折一遍，两种都认。
 */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n')
const fitEol = (snippet, eol) => (eol === '\n' ? snippet : snippet.replace(/\n/g, eol))

/** 当前磁盘上哪些注册点已在：`to` 命中即视为已在（已注册态里 `from` 原文必然不存在）。 */
function presentSites() {
  return SITES.map((s) => {
    const text = read(s.file)
    return { ...s, present: text.includes(fitEol(s.to, eolOf(text))) }
  })
}

/** 跑门禁，返回 { ok, code, tail }。 */
function runGate() {
  const r = spawnSync(process.execPath, ['--import', './tests/setup.mjs', GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HUB_DEBUG: '0' },
    timeout: 120_000,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // out 是完整输出，交给 extraCheck 匹配；tail 只用于打印，行数太少会把真正的断言消息
  // 截在堆栈前面（本脚本第一版就栽在这儿：门禁行为对，判定却因 tail 截断而变红）。
  return { ok: r.status === 0, code: r.status, out, tail: out.trim().split('\n').slice(-40).join('\n') }
}

const original = new Map(FILES.map((f) => [f, read(f)]))
const originalSha = new Map(FILES.map((f) => [f, sha(original.get(f))]))
const failures = []

function step(label, expectOk, extraCheck) {
  const r = runGate()
  const pass = r.ok === expectOk && (extraCheck ? extraCheck(r) : true)
  console.log(`${pass ? '✔' : '✘'} ${label}：门禁${r.ok ? '绿' : `红（退出码 ${r.code}）`}，期望${expectOk ? '绿' : '红'}`)
  if (!pass) {
    failures.push(label)
    console.log(r.tail)
  }
  return r
}

function restore() {
  for (const f of FILES) writeFileSync(abs(f), original.get(f), 'utf8')
}

function inject(sites) {
  for (const s of sites) {
    const text = read(s.file)
    const eol = eolOf(text)
    const from = fitEol(s.from, eol)
    const to = fitEol(s.to, eol)
    const hits = text.split(from).length - 1
    if (hits !== 1) throw new Error(`${s.what}：原文在 ${s.file} 命中 ${hits} 次（要求恰好 1 次；行尾按 ${eol === '\n' ? 'LF' : 'CRLF'} 折算）`)
    writeFileSync(abs(s.file), text.split(from).join(to), 'utf8')
  }
}

try {
  const mode = presentSites().filter((s) => s.present).length
  console.log(`基线：${mode} / ${SITES.length} 处注册点在位`)

  // 1) 基线必须自洽：0 处（撤回态）或 5 处（已注册态）都合法，门禁都要绿。
  step('① 基线状态自洽', true)

  // 2) 半加：只塞 lazyChannels 一行。PROVIDER_IDS / HUB_PLUGINS 都不变 ⇒
  //    纯运行时断言会漏，只有源码级断言能抓。
  if (mode === 0) {
    restore()
    inject([SITES[3]])
    step('② 半加（只 aggregate.lazyChannels 一行）被拦', false, (r) => /注册不完整/.test(r.out) && /lazyChannels/.test(r.out))
  } else {
    console.log('～ ② 跳过：基线已是注册态，半加场景不适合从注册态构造')
  }

  // 3) 5 处全在 ⇒ A 案完整注册，门禁必须绿（这一条同时也是「全加回去能不能用」的验证）。
  restore()
  if (mode === 0) inject(SITES)
  step('③ 5 处全在（A 案完整注册）通过', true)

  // 4) 还原并逐字节比对。
  restore()
  const drifted = FILES.filter((f) => sha(read(f)) !== originalSha.get(f))
  if (drifted.length > 0) {
    failures.push('④')
    console.error(`✘ ④ 还原后字节不一致：${drifted.join('、')}`)
  } else {
    console.log(`✔ ④ 还原逐字节一致（sha256 ${[...originalSha.values()].map((h) => h.slice(0, 12)).join(' / ')}）`)
  }
  step('④ 还原后门禁仍绿', true)
} finally {
  restore()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 步不符预期：${failures.join('、')}`)
  process.exit(1)
}
console.log(`\nOK：四步全符合预期，仓库已还原到运行前状态。`)