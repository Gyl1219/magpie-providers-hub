// magpie / OpenCode 插件 — DSH Providers Hub 渠道的独立实现。
//
// 原项目：https://github.com/iJetLi/dsh-providers-hub ｜ 作者：JetLi（https://github.com/iJetLi）
// 本仓库是它的**第三方 Magpie 适配版本**，不是原项目官方发布。
//   来自原项目：账号渠道、EAC 授权流程、本地服务与管理界面。
//   本仓库新增：Magpie 供应商接口、浏览器管理入口、兼容测试。
//
// **一个插件，五条供应商**（v0.5.0）：每个渠道是 magpie 里一条独立供应商
// （`hub-astudio`、`hub-accio`…），各自登录 / 额度 / 开关 / 故障转移。
// 模型 id 由 magpie 拼成 `hub-astudio/glm-5.3`（渠道前缀不再出现在我们返回的目录里）。
//
// ## 为什么只有五条
//
// 与社区 registry 里已有插件重叠的五条（OfficeAce / AutoClaw 国内+国际 / Loomy /
// MiniMax 国际版）**已从本包删除**（PR #502 审核结论）：
//   · 一个订阅两个入口会让用户搞不清装哪个；
//   · 它们各自带着与本插件无关的敏感能力（AutoClaw 的 DPAPI 解密他人凭据、
//     MiniMax 国际版的 XFF 伪造绕地区限制）。
// 老用户改装对应社区插件即可（officeace-auth / opencode-autoclaw-auth /
// opencode-loomy-auth / opencode-minimax-auth），登录态需重新走一遍。
//
// 保留的五条：AStudio（讯飞）、Accio（阿里）、LobsterAI（有道）、
//             超级麦吉 MagiCrew 国内 / 国际 —— 全部是各厂商正牌登录流程。
//
// ## 入口模块的铁律
//
// ⚠️ 入口模块里**每个函数导出都是一个插件**（社区包同款：`opencode-trae-auth`
//    一个模块导出两个插件函数 = 两个供应商）。所以：
//    · 只能导出 `makeHubPlugin()` 造出来的成品函数；
//    · 工厂/工具函数不要从本文件导出（放 src/，或塞进 `HUB_PLUGINS` 这类对象里）。
//
// 全部**独立实现**：登录、续期、转发都在本插件里，不依赖 DSH，不依赖 DSH 桌面版。
//
// 加渠道 = 在 `src/aggregate.mjs` 的 `CHANNELS` 里加一项（渠道文件导出渠道对象），
//          再在下面补一个具名导出 + `HUB_PLUGINS` 条目。
//
// ⚠️ hub 的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分给其它渠道），
//    不是真实渠道，无法独立实现 —— 那部分只能走依赖 hub 网关的桥接插件。

import { makeHubPlugin } from './src/aggregate.mjs'
import { astudioChannel } from './src/astudio.mjs'
import { accioChannel } from './src/accio.mjs'
import { lobsteraiChannel } from './src/lobsterai.mjs'
import { magicrewChannel, magicrewIntlChannel } from './src/magicrew.mjs'

export const HubAStudioPlugin = makeHubPlugin(astudioChannel)
export const HubAccioPlugin = makeHubPlugin(accioChannel)
export const HubLobsterAIPlugin = makeHubPlugin(lobsteraiChannel)
export const HubMagicrewPlugin = makeHubPlugin(magicrewChannel)
export const HubMagicrewIntlPlugin = makeHubPlugin(magicrewIntlChannel)

/** provider id → 插件函数（测试用；**对象**导出不会被 magpie 当插件）。 */
export const HUB_PLUGINS = {
  HubAStudioPlugin,
  HubAccioPlugin,
  HubLobsterAIPlugin,
  HubMagicrewPlugin,
  HubMagicrewIntlPlugin,
}

// ⚠️ 只导出**数组/对象**这类非函数值（测试用）。函数导出 = 一个供应商，别乱加。
export { REGISTERED_CHANNELS, PROVIDER_IDS, DEFAULT_PROVIDER_IDS } from './src/aggregate.mjs'
