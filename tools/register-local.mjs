// 本机自注册：把 Providers Hub 写进 magpie 的市场缓存 —— **手工跑，不在插件里跑**
//
// ⚠️ 为什么它不在 src/ 里：社区 registry 的 PR 审核卡「插件加载时改写 magpie 的
//    ~/.cache/magpie/plugin-market.json」（MYCF711 的 officeace-auth #399 就栽在这，
//    0.1.9 删掉才过审）。所以 npm 包里零宿主文件写入，这个能力只留成仓库里的工具。
//
// 用法：
//   node tools/register-local.mjs            # 写一次（100ms + 30s/90s/240s 补写）
//   node tools/register-local.mjs --once     # 只写一次就退出（magpie 已启动时用这个）
//   node tools/register-local.mjs --remove   # 把自己的条目从缓存里删掉
//
// ⚠️ 只是**本机显示**：卡片标题/「源码」按钮/绿标。要所有人都看到，得 registry.json
//    收录（PR 进 magpie-community/plugins）—— 见 REGISTRY_PR.md。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDirOf, registerSelf, _reset } from './self-register.mjs'

const CONFIG_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.config', 'magpie')

export const REGISTRY_ENTRY = {
  package: 'magpie-providers-hub',
  name: 'Providers Hub',
  // registry 条目只列**默认注册**的五个（与社区已有插件不重叠）。
  // 重叠的五个（OfficeAce/AutoClaw×2/Loomy/MiniMax 国际版）打进包里但默认不注册，
  // 设 MAGPIE_HUB_EXTRA_CHANNELS 才启用 —— PR #502 审核的「一个订阅一个入口」。
  providers: [
    'hub-astudio',
    'hub-accio',
    'hub-lobsterai',
    'hub-magicrew',
    'hub-magicrew-intl',
  ],
  community: true,
  summary: {
    en: 'Third-party Magpie adapter for dsh-providers-hub (by JetLi): one package, five providers, each a separate channel you can sign in to, meter and switch off on its own — AStudio, Accio, LobsterAI, MagiCrew (CN & Intl). Channels that overlap with existing registry plugins are not shipped. Runs without DSH.',
    zh: 'dsh-providers-hub（作者 JetLi）的第三方适配：五条供应商（每渠道一条，可各自登录/看额度/单独关闭）——AStudio（讯飞）、Accio（阿里）、LobsterAI（有道）、超级麦吉/MagiCrew（国内+国际）。与社区 registry 已有插件重叠的渠道不随包提供（改装对应社区插件）。不依赖 DSH 运行。',
  },
}

function marketPath() {
  const dir = cacheDirOf(CONFIG_DIR)
  return join(dir, 'plugin-market.json')
}

function remove() {
  const p = marketPath()
  if (!existsSync(p)) {
    console.log('缓存不存在，无需清理：' + p)
    return
  }
  const j = JSON.parse(readFileSync(p, 'utf8'))
  const before = j.plugins.length
  j.plugins = j.plugins.filter((x) => x?.package !== REGISTRY_ENTRY.package)
  writeFileSync(p, JSON.stringify(j, null, 2), 'utf8')
  console.log(`已移除（${before} → ${j.plugins.length} 条）：${p}`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--remove')) return remove()
  _reset()
  const r = await registerSelf(REGISTRY_ENTRY, {
    configDir: CONFIG_DIR,
    log: (m) => console.log('[providers-hub] ' + m),
  })
  console.log(r.ok ? `已写入：${marketPath()}` : `未写入：${r.reason}（magpie 还没生成缓存？先启动一次 magpie）`)
  if (args.includes('--once')) process.exit(r.ok ? 0 : 1)
  // 默认：等 magpie 启动后的官方拉取（异步联网）再补写几次，之后自动退出
  console.log('保持运行 4 分钟，补上 magpie 官方拉取可能冲掉的条目…（Ctrl+C 可提前结束）')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
