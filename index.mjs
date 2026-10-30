// magpie / OpenCode 插件 — DSH Providers Hub 渠道的独立实现。
//
// 原项目：https://github.com/iJetLi/dsh-providers-hub ｜ 作者：JetLi（https://github.com/iJetLi）
// 本仓库是它的**第三方 Magpie 适配版本**，不是原项目官方发布。
//   来自原项目：账号渠道、EAC 授权流程、本地服务与管理界面。
//   本仓库新增：Magpie 供应商接口、自动服务管理、浏览器管理入口、兼容测试。
//
// **一个插件，多条供应商**（v0.4.0 起）：每个渠道是 magpie 里一条独立供应商
// （`hub-astudio`、`hub-accio`…），各自登录 / 额度 / 开关 / 故障转移。
// 模型 id 由 magpie 拼成 `hub-astudio/glm-5.3`（渠道前缀不再出现在我们返回的目录里）。
//
// ## 默认注册五个（v0.4.6 起）
//
// 与社区 registry 现有插件**重叠**的五个渠道（OfficeAce、AutoClaw 国内/国际、
// Loomy、MiniMax 国际版）默认不注册 —— 一个订阅两个入口会让用户搞不清装哪个
// （PR #502 的审核意见）。registry 条目列的就是默认这五个：
//   `hub-astudio` `hub-accio` `hub-lobsterai` `hub-magicrew` `hub-magicrew-intl`
//
// 要用重叠渠道（代码仍在包里，不删）—— 设环境变量后重启 magpie：
//   MAGPIE_HUB_EXTRA_CHANNELS=officeace,autoclaw,autoclawintl,loomy,minimaxintl
//   MAGPIE_HUB_EXTRA_CHANNELS=all          # 全部十个
//
// ## 入口模块的铁律
//
// ⚠️ 入口模块里**每个函数导出都是一个插件**（社区包同款：`opencode-trae-auth`
//    一个模块导出两个插件函数 = 两个供应商）。所以：
//    · 只能导出 `makeHubPlugin()` 造出来的成品函数；
//    · 工厂/工具函数不要从本文件导出（放 src/，或塞进 `HUB_PLUGINS` 这类对象里）；
//    · **未启用的渠道导出的必须是对象**（占位），导出函数就等于注册了一条供应商。
//
// 全部**独立实现**：登录、续期、转发都在本插件里，不依赖 DSH，不依赖 DSH 桌面版。
//
// 加渠道 = 在 `src/aggregate.mjs` 的 `CHANNELS` 里加一项（渠道文件导出渠道对象），
//          再在下面补一个具名导出 + `HUB_PLUGINS` 条目。
//
// ⚠️ hub 的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分给其它渠道），
//    不是真实渠道，无法独立实现 —— 那部分只能走依赖 hub 网关的桥接插件。

import {
  makeHubPlugin,
  channelRegistered,
  disabledChannelMarker,
} from './src/aggregate.mjs'
import { officeaceChannel } from './src/officeace.mjs'
import { astudioChannel } from './src/astudio.mjs'
import { minimaxintlChannel } from './src/minimaxintl.mjs'
import { accioChannel } from './src/accio.mjs'
import { autoclawChannel, autoclawIntlChannel } from './src/autoclaw.mjs'
import { loomyChannel } from './src/loomy.mjs'
import { lobsteraiChannel } from './src/lobsterai.mjs'
import { magicrewChannel, magicrewIntlChannel } from './src/magicrew.mjs'

/**
 * 渠道 → 入口导出的值。**未启用时给占位对象**（不是函数 ⇒ magpie 不注册它）。
 *
 * ⚠️ 不要写成三元之外的形态：这里漏一个函数导出 = 少一条供应商，多一个 = 多一条。
 */
const exportOf = (channelId, channel) =>
  channelRegistered(channelId) ? makeHubPlugin(channel) : disabledChannelMarker(channelId)

export const HubOfficeAcePlugin = exportOf('officeace', officeaceChannel)
export const HubAStudioPlugin = exportOf('astudio', astudioChannel)
export const HubMiniMaxIntlPlugin = exportOf('minimaxintl', minimaxintlChannel)
export const HubAccioPlugin = exportOf('accio', accioChannel)
export const HubAutoClawPlugin = exportOf('autoclaw', autoclawChannel)
export const HubAutoClawIntlPlugin = exportOf('autoclawintl', autoclawIntlChannel)
export const HubLoomyPlugin = exportOf('loomy', loomyChannel)
export const HubLobsterAIPlugin = exportOf('lobsterai', lobsteraiChannel)
export const HubMagicrewPlugin = exportOf('magicrew', magicrewChannel)
export const HubMagicrewIntlPlugin = exportOf('magicrew-intl', magicrewIntlChannel)

/**
 * provider id → 插件函数（**始终十条**，不受开关影响：测试要遍历全部渠道）。
 * ⚠️ 是对象导出，magpie 不会把它当插件 —— 真正的注册看上面的具名函数导出。
 */
export const HUB_PLUGINS = {
  HubOfficeAcePlugin: makeHubPlugin(officeaceChannel),
  HubAStudioPlugin: makeHubPlugin(astudioChannel),
  HubMiniMaxIntlPlugin: makeHubPlugin(minimaxintlChannel),
  HubAccioPlugin: makeHubPlugin(accioChannel),
  HubAutoClawPlugin: makeHubPlugin(autoclawChannel),
  HubAutoClawIntlPlugin: makeHubPlugin(autoclawIntlChannel),
  HubLoomyPlugin: makeHubPlugin(loomyChannel),
  HubLobsterAIPlugin: makeHubPlugin(lobsteraiChannel),
  HubMagicrewPlugin: makeHubPlugin(magicrewChannel),
  HubMagicrewIntlPlugin: makeHubPlugin(magicrewIntlChannel),
}

// ⚠️ 只导出**数组/对象**这类非函数值（测试用）。函数导出 = 一个供应商，别乱加。
export {
  REGISTERED_CHANNELS,
  PROVIDER_IDS,
  DEFAULT_PROVIDER_IDS,
  OVERLAPPING_CHANNEL_IDS,
  EXTRA_CHANNELS_ENV,
} from './src/aggregate.mjs'
