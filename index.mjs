// magpie / OpenCode 插件 — DSH Providers Hub 渠道的独立实现。
//
// 原项目：https://github.com/iJetLi/dsh-providers-hub ｜ 作者：JetLi
// 本仓库是它的**第三方 Magpie 适配版本**，不是原项目官方发布。
//   来自原项目：账号渠道、EAC 授权流程、本地服务与管理界面。
//   本仓库新增：Magpie 供应商接口、自动服务管理、浏览器管理入口、兼容测试。
//
// **一个供应商，内部聚合多个渠道**（与 ofm 同款形态）。
//
// 模型 id 带渠道前缀（渠道/模型），例：`officeace/glm-5.3`；
// magpie 展示时会补供应商名，呈现为 `dsh-providers-hub/officeace/glm-5.3`。
// 请求进来时按前缀分派到对应渠道，发给上游时去掉前缀。
//
// 全部**独立实现**：登录、续期、转发都在本插件里，不依赖 DSH，不依赖 DSH 桌面版。
//
// ## 只做 ofm（our-free-model）没有的渠道
//
// ofm 已覆盖 13 个（CodeArts / WorkBuddy 国内+国际 / LobsterAI / Qoder 国内+国际 /
// TRAE / Cline / Loomy / Raccoon / MiniMax Code / ZCode / Gemini），
// 故 lobsterai、loomy **不做** —— 做了就是和 ofm 重复。
//
// 加渠道 = 在 `src/aggregate.mjs` 的 `CHANNELS` 里加一项（渠道文件导出渠道对象）。
// 待补：accio（阿里，登录页有「请升级客户端」校验 + 实测 502）、deepseek-account。
//
// ⚠️ hub 的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分给其它渠道），
//    不是真实渠道，无法独立实现 —— 那部分只能走依赖 hub 网关的桥接插件。

export { DshProvidersHubPlugin } from './src/aggregate.mjs'
