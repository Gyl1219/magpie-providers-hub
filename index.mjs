// magpie / OpenCode 插件 — DSH Providers Hub 渠道的独立实现。
//
// 原项目：https://github.com/iJetLi/dsh-providers-hub ｜ 作者：JetLi（https://github.com/iJetLi）
// 本仓库是它的**第三方 Magpie 适配版本**，不是原项目官方发布。
//   来自原项目：账号渠道、EAC 授权流程、本地服务与管理界面。
//   本仓库新增：Magpie 供应商接口、自动服务管理、浏览器管理入口、兼容测试。
//
// **一个插件，十个供应商**（v0.4.0 起）：每个渠道是 magpie 里一条独立供应商
// （`hub-officeace`、`hub-astudio`…），各自登录 / 额度 / 开关 / 故障转移。
// 模型 id 由 magpie 拼成 `hub-officeace/glm-5.3`（渠道前缀不再出现在我们返回的目录里）。
//
// v0.3.x 是「一个供应商 `providers-hub` 内部聚合十渠道」，模型 id 形如
// `providers-hub/officeace/glm-5.3` —— 拆分原因：magpie 的 failover 与单渠道开关
// 都是 provider 粒度，聚合形态下二者都做不到（见 README「已知边界」）。
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
import { officeaceChannel } from './src/officeace.mjs'
import { astudioChannel } from './src/astudio.mjs'
import { minimaxintlChannel } from './src/minimaxintl.mjs'
import { accioChannel } from './src/accio.mjs'
import { autoclawChannel, autoclawIntlChannel } from './src/autoclaw.mjs'
import { loomyChannel } from './src/loomy.mjs'
import { lobsteraiChannel } from './src/lobsterai.mjs'
import { magicrewChannel, magicrewIntlChannel } from './src/magicrew.mjs'

export const HubOfficeAcePlugin = makeHubPlugin(officeaceChannel)
export const HubAStudioPlugin = makeHubPlugin(astudioChannel)
export const HubMiniMaxIntlPlugin = makeHubPlugin(minimaxintlChannel)
export const HubAccioPlugin = makeHubPlugin(accioChannel)
export const HubAutoClawPlugin = makeHubPlugin(autoclawChannel)
export const HubAutoClawIntlPlugin = makeHubPlugin(autoclawIntlChannel)
export const HubLoomyPlugin = makeHubPlugin(loomyChannel)
export const HubLobsterAIPlugin = makeHubPlugin(lobsteraiChannel)
export const HubMagicrewPlugin = makeHubPlugin(magicrewChannel)
export const HubMagicrewIntlPlugin = makeHubPlugin(magicrewIntlChannel)

/** provider id → 插件函数（测试用；**对象**导出不会被 magpie 当插件）。 */
export const HUB_PLUGINS = {
  HubOfficeAcePlugin,
  HubAStudioPlugin,
  HubMiniMaxIntlPlugin,
  HubAccioPlugin,
  HubAutoClawPlugin,
  HubAutoClawIntlPlugin,
  HubLoomyPlugin,
  HubLobsterAIPlugin,
  HubMagicrewPlugin,
  HubMagicrewIntlPlugin,
}

// ⚠️ 只导出**数组/对象**这类非函数值（测试用）。函数导出 = 一个供应商，别乱加。
export { REGISTERED_CHANNELS, PROVIDER_IDS } from './src/aggregate.mjs'
