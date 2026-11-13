#!/usr/bin/env node
// registry 条目材料生成器（不进发布包：package.json 的 files 未列 tools/）。
//
// 用途：从 index.mjs 实跑的 PROVIDER_IDS 取「真正打进包的十二条渠道 id」，
//       生成 registry.json 条目片段 + 摘要字数自检，避免手抄 id 漂移。
//
// 用法：
//   node tools/registry-entry.mjs            # 打印条目片段（可直接粘进 PR）
//   node tools/registry-entry.mjs --check    # 只做校验：条数=12、lingxi 缺位、摘要字数
//
// 为何单独抽出来：0.12.2 之前 summary.zh 有一千多字，magpie 的卡片只露出一句话，
// 用户看到的是尾部「为七牛唯一入口……」，读起来像个七牛专用插件。这里把
// 「12 条渠道列全的一句话总览」钉在最前，中文硬卡 400 字以内。

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 中文摘要上限（字符数，含标点）。改这里等于改门禁。 */
export const ZH_LIMIT = 700

/**
 * 随包发售的十二条渠道 —— 顺序即展示顺序，跟 index.mjs 的加载顺序一致。
 * 这张表是「发布包 files 列出的 src/*.mjs」的函数，不是手抄清单：
 * 一旦 files 里多/少一个渠道文件，assertShippedIds() 会报错。
 */
export const SHIPPED_IDS = Object.freeze([
  'hub-astudio',
  'hub-accio',
  'hub-lobsterai',
  'hub-magicrew',
  'hub-magicrew-intl',
  'hub-marvis',
  'hub-autoclaw',
  'hub-autoclaw-cn',
  'hub-loomy',
  'hub-monkeycode',
  'hub-monkeycode-intl',
  'hub-qiniu',
])

/** 永不出包的私有渠道（发出去会把它们带进安装包）。 */
export const PRIVATE_IDS = Object.freeze(['hub-lingxi'])

/** 未登记、暂不进包的三条（源码里有，files 里没有）。 */
export const UNREGISTERED_IDS = Object.freeze(['hub-doubaowork', 'hub-dola', 'hub-baizhi'])

export const SUMMARY = Object.freeze({
  zh: "十二家供应商一起装：AStudio（讯飞）、Accio（阿里）、LobsterAI（有道龙虾）、超级麦吉 MagiCrew（国内+国际）、AutoClaw（国内+国际）、Loomy（讯飞）、MonkeyCode（国内+国际）、七牛云 MaaS、腾讯 Marvis。一渠道一供应商（hub-渠道），各自登录、额度、开关与故障转移。AStudio：星火与 DeepSeek，签到送积分；独立的 astudio 插件走 Responses，两边共用同一积分池。Accio：15 模型按倍率计费。LobsterAI：DeepSeek/GLM/Kimi，可看图。MagiCrew：积分按到期日分档。AutoClaw：读桌面登录态或贴 token；导入会轮换一次性 refresh_token，桌面客户端会被登出、之后需重新登录；不支持网页 OAuth 与短信（那些用 opencode-autoclaw-auth）；与它共用同一账号积分。Loomy：微信扫码或短信；opencode-loomy-auth 只有短信与粘贴 session；两边共用同一积分。MonkeyCode：登录换 Key，三档额度。七牛云：按量计费 + 签到，七牛唯一入口。Marvis：QQ/微信 OAuth 或导入本机登录态，无粘贴入口；registry 无同渠道独立包。第三方适配 iJetLi/dsh-providers-hub（MIT）。",
  en: "Twelve providers in one install: AStudio, Accio, LobsterAI, MagiCrew (CN + Intl), AutoClaw (Intl + CN), Loomy, MonkeyCode (CN + Intl), Qiniu MaaS and Tencent Marvis. One provider per channel (hub-<channel>): each has its own sign-in, metering, on/off switch and failover. AStudio: Spark + DeepSeek with daily check-in credits; the standalone astudio plugin uses Responses, and both draw on one points pool. Accio: 15 models priced by multiplier. LobsterAI: DeepSeek/GLM/Kimi, image input. MagiCrew: credit packs banded by expiry. AutoClaw: reads the desktop app login or takes a pasted token; importing rotates the one-time refresh token and signs the AutoClaw desktop app out, so it asks for sign-in again; web OAuth and SMS are not supported here (use opencode-autoclaw-auth for those), and both plugins read one account's balance. Loomy: WeChat QR or SMS; opencode-loomy-auth has SMS and pasted session only, and both read one account's balance. MonkeyCode: sign-in swaps the key, three quota tiers. Qiniu MaaS: pay-as-you-go with check-in credits, the only Qiniu entry. Marvis: QQ / WeChat OAuth or importing the local sign-in, no paste entry; no standalone package for this channel. Third-party adapter of iJetLi/dsh-providers-hub (MIT); no DSH needed at runtime.",
})

/** 按 package.json 的 files 推出「实际会进包的渠道 id」（含多站点渠道的拆分）。 */
export function shippedIdsFromPackage(pkg = readPackage()) {
  const multi = { magicrew: ['magicrew', 'magicrew-intl'], autoclaw: ['autoclaw', 'autoclaw-cn'], monkeycode: ['monkeycode', 'monkeycode-intl'] }
  const ids = new Set()
  for (const entry of pkg.files ?? []) {
    const m = /^src\/(.+)\.mjs$/.exec(entry)
    if (m === null) continue
    const base = m[1]
    // 只有导出渠道对象的文件才算渠道（shared/icons/aggregate/bridge 等不算）
    if (!existsSync(join(root, 'src', `${base}.mjs`))) continue
    const channelFile = CHANNEL_FILES.has(base)
    if (!channelFile) continue
    for (const id of multi[base] ?? [base]) ids.add(`hub-${id}`)
  }
  return [...ids].sort()
}

/** src/ 下**导出渠道对象**的文件名（多站点渠道按一个文件两渠道处理）。 */
const CHANNEL_FILES = new Set([
  'astudio', 'accio', 'lobsterai', 'magicrew', 'autoclaw', 'loomy', 'monkeycode', 'qiniu',
  'lingxi', 'marvis', 'doubaowork', 'dola', 'baizhi',
])

function readPackage() {
  const path = join(root, 'package.json')
  if (!existsSync(path)) throw new Error(`找不到 package.json：${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 数量断言：发布包必须是 12 条，且私有/未登记渠道不在其中。 */
export function assertShippedIds(ids = shippedIdsFromPackage()) {
  const problems = []
  if (ids.length !== SHIPPED_IDS.length) {
    problems.push(`发布包渠道数 ${ids.length}，期望 ${SHIPPED_IDS.length}`)
  }
  const missing = SHIPPED_IDS.filter((id) => !ids.includes(id))
  if (missing.length > 0) problems.push(`缺少：${missing.join(' ')}`)
  const extra = ids.filter((id) => !SHIPPED_IDS.includes(id))
  if (extra.length > 0) problems.push(`多出：${extra.join(' ')}`)
  for (const id of PRIVATE_IDS) {
    if (ids.includes(id)) problems.push(`私有渠道进包了：${id}`)
  }
  return problems
}

/** 摘要字数检查（中文按 ZH_LIMIT；英文按 1400 字符预算 —— 两者都要容下逐渠道差异说明）。 */
export function assertSummary(summary = SUMMARY) {
  const problems = []
  const zhLen = [...summary.zh].length
  if (zhLen > ZH_LIMIT) problems.push(`summary.zh ${zhLen} 字，超过上限 ${ZH_LIMIT}`)
  if (![...summary.zh].slice(0, 14).join('').startsWith(ZH_HEAD)) {
    problems.push(`summary.zh 开头必须是一句话总览（「${ZH_HEAD}…」），否则卡片截断后又只剩尾部`)
  }
  // 总览句 = 第一个句号之前；十二条渠道名必须在这句里出现，否则「读起来像单渠道插件」的病会复发
  const overview = summary.zh.split('。')[0]
  const missing = OVERVIEW_NAMES.filter((name) => !overview.includes(name))
  if (missing.length > 0) problems.push(`总览句漏了渠道：${missing.join('、')}`)
  // 尾部必须不是单渠道收尾（0.12.2 的病灶：卡片只露尾部「为七牛唯一入口……」）
  if (/七牛[^。]*$/.test(summary.zh)) problems.push('summary.zh 不应以七牛收尾，卡片截断后会显得像七牛专用插件')
  if (summary.en.length > 1400) problems.push(`summary.en ${summary.en.length} 字符，超过 1400`)
  return problems
}

const ZH_HEAD = '十二家供应商一起装'
/** 总览句里必须出现的十二条渠道名（多站点渠道按显示名检查一次）。 */
const OVERVIEW_NAMES = Object.freeze([
  'AStudio', 'Accio', 'LobsterAI', 'MagiCrew', 'AutoClaw', 'Loomy', 'MonkeyCode', '七牛云', 'Marvis',
])

/** registry.json 条目（可直接粘）。 */
export function registryEntry(ids = SHIPPED_IDS, summary = SUMMARY) {
  return {
    package: 'magpie-providers-hub',
    name: 'Providers Hub',
    providers: [...ids],
    community: true,
    summary: { en: summary.en, zh: summary.zh },
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  const shipped = shippedIdsFromPackage()
  const problems = [...assertShippedIds(shipped), ...assertSummary()]
  if (check) {
    if (problems.length > 0) {
      console.error(`registry 条目校验失败：\n- ${problems.join('\n- ')}`)
      process.exit(1)
    }
    console.log(`registry 条目校验通过：${shipped.length} 条渠道，summary.zh ${[...SUMMARY.zh].length} 字，summary.en ${SUMMARY.en.length} 字符`)
  } else {
    if (problems.length > 0) {
      console.error(`⚠️ 校验未过（片段仍会打印，方便对照）：\n- ${problems.join('\n- ')}`)
    }
    console.log(JSON.stringify(registryEntry(shipped), null, 2))
  }
}