# Notice

## 项目归属

**原项目：** [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) ｜ **作者：** [JetLi](https://github.com/iJetLi)

**本仓库是原项目的第三方 Magpie 适配版本，不是原项目官方发布。**

- **来自原项目**：账号渠道、EAC 授权流程、本地服务与管理界面。
  这些功能的主要实现归**原作者及其上游贡献者**所有。
- **本仓库新增**：Magpie 供应商接口、自动服务管理、浏览器管理入口、兼容测试。

## 本仓库做了什么

把原项目（DSH Providers Hub）里 **Magpie 社区与 Our Free Model（ofm）都没有的渠道**
适配为 **Magpie / OpenCode 供应商插件**。

**不依赖 DSH**，不依赖 DSH 桌面版是否运行：登录、续期（渠道支持时）、模型目录、请求转发
全部在插件内完成。它不包含原项目的源码，也不读取原项目的凭据库；各渠道凭据存在
Magpie 配置目录下（`~/.config/magpie/<channel>-credential.json`），每渠道一份。

## 渠道与协议来源

协议细节来自对**公开 Web 端点**的实测观察（请求路径、参数、响应结构），
不是逆向任何客户端二进制，也不分发任何第三方代码。

| 渠道 | 归属 | 登录 | 推理端点 |
|---|---|---|---|
| `officeace` | 华为云 AgentArts | 华为云 OAuth（PKCE + DPoP + 云侧轮询） | `{maas}/v2/chat/completions`（Basic） |
| `astudio` | 讯飞 AstronStudio | 本地载体页（极验 + 短信 / 密码 / 微信） | `{maas}/model-gateway/v1/chat/completions`（Bearer） |
| `minimaxintl` | MiniMax Code 国际版 | OAuth 设备码 + PKCE（官方客户端同款，client `mcode-public`） | `{api}/mavis/api/v1/llm/v1/messages`（Anthropic，Bearer） |
| `accio` | Accio Work（阿里） | OAuth PKCE + 本地 loopback 回调（client `accio-work`，公开客户端无 secret） | `{gateway}/api/adk/llm/generateContent`（Gemini 风格，token 在 body） |

MiniMax 渠道的协议事实（端点、OAuth 常量、设备码形态、307 地理分流行为、思考档位语义）
来自官方开源客户端 `MiniMax-AI/minimax-code` 与公开端点的真机实测对照（与 DSH 上游
`iJetLi/dsh-providers-hub` 的记录一致）。

各渠道的商标与产品名称归各自权利人所有。本插件只是让用户在 Magpie 里使用
**自己的账号**访问这些服务 —— 不绕过任何付费墙、不共享任何账号、不代理他人流量。

## 与 ofm 的关系

本插件**只做 ofm 没有的渠道**。ofm（`magpie-our-free-model`）已覆盖 13 个渠道
（CodeArts、WorkBuddy 国内/国际、LobsterAI、Qoder 国内/国际、TRAE、Cline、Loomy、
Raccoon、MiniMax Code、ZCode、Gemini），故这些**不在**本插件内 —— 重复实现没有价值。

## 无法独立实现的部分

原项目的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分派给其它渠道），
不是真实渠道。独立实现它等于重写整个调度层，故不在本插件范围内；
那部分仍需依赖原项目 Hub 网关的桥接插件。

## 第三方组件

- 极验（Geetest）：登录页加载**官方** `https://static.geetest.com/static/js/gt.0.4.9.js`。
  本插件**不破解、不模拟**滑块，只把官方回调给出的 `challenge` / `validate` / `seccode`
  原样提交给账号后端。
- 华为云 APIG 签名（SDK-HMAC-SHA256）：按公开的签名规则本地实现。
