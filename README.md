# magpie-providers-hub

> **原项目：** [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) ｜ **作者：** [JetLi](https://github.com/iJetLi)
>
> **本仓库是原项目的第三方 Magpie 适配版本，不是原项目官方发布。**
> 账号渠道、EAC 授权流程、本地服务与管理界面来自原项目，这些功能的主要实现归
> 原作者及其上游贡献者。本仓库新增 Magpie 供应商接口、自动服务管理、浏览器管理入口和兼容测试。

Magpie / OpenCode 供应商插件 —— 把 **DSH Providers Hub 里 Magpie 社区和 Our Free Model
（ofm）都没有的渠道**做成**独立实现**。

**不依赖 DSH**，不依赖 DSH 桌面版是否运行：登录、续期（渠道支持时）、模型目录、请求转发
全部在插件内完成。

## 形态：一个供应商，内部聚合多个渠道

与 ofm 同款 —— **Magpie 的供应商列表里只有 `dsh-providers-hub` 一个条目**，而不是每个渠道
一个条目。模型 id 带渠道前缀：

```
officeace/glm-5.3        ← 目录里的形态（渠道/模型）
astudio/spark-x
```

请求进来时按前缀分派到对应渠道，发给上游时**去掉**前缀。

## 当前渠道

| 渠道 | 归属 | 登录方式 | 模型 | 续期 |
|---|---|---|---|---|
| `officeace` | 华为云 AgentArts | 华为云 OAuth（PKCE + DPoP + 云侧轮询） | `/v2/models` | ✅ STS（⚠️ refresh_token 一次性） |
| `astudio` | 讯飞 AstronStudio | 本地载体页（极验 + 短信 / 密码 / 微信） | `/api/v1/model-manager/models` | ❌ 不支持（会话一年，不滑动） |
| `minimaxintl` | MiniMax Code 国际版 | OAuth 设备码 + PKCE（浏览器确认 user_code） | `/mavis/api/v1/models?region=en` | ✅ 标准 refresh_token 轮换 |

### officeace

```
POST /v1/claw/auth/state                    → 云侧登记 state
浏览器打开 auth.huaweicloud.com（PKCE+DPoP）
轮询 GET /v1/claw/auth/code?state=…          → code
POST sts.cn-north-4/v1/oauth2/tokens         → STS 凭据（AK/SK/security_token）
GET  /v1/claw/client-permission-validate     → modelInfo（推理端点 + appKey/appSecret）
```

推理用 **Basic** 认证（`base64(appKey:appSecret)`），不是 Bearer。

### astudio

登录**不走讯飞的授权页**，而是本地起一个 HTTP 服务承载登录页（与 DSH 的
`startAstudioLoginFlow` 同机制）：页面里完成极验 + 短信/密码/微信，拿到会话后去
`bot/models/configs` 换推理凭据。

⚠️ 两个实测坑：
- `/model-gateway/v1/models` 恒 **404**；目录在 `/api/v1/model-manager/models`（两个基址不共用前缀）
- 推理端只认**裸 slug**；发 `builtin/<base64>` 会 502（`builtin/` 是 acode 内核内部别名）

### minimaxintl

MiniMax Code **国际版**（`account.minimax.io` / `agent.minimax.io`）。登录是官方客户端
同款的 **OAuth 设备码 + PKCE**（client `mcode-public`）：插件给出验证码，你在浏览器确认，
无需本地回调端口。推理端说 **Anthropic Messages** 协议，本插件内置 OpenAI↔Anthropic
翻译桥（system/tools/tool_calls/图片/思考档位/SSE 全量双向翻译）。

⚠️ 三个实测坑（都来自 DSH 的真机记录）：
- `agent.minimax.io` 恒 **307 → 中国站**（Akamai 按出口 IP 分流），而 fetch 跨域跟随会
  **剥掉 Authorization** ⇒ 插件手动逐跳跟随并**每跳重附头**（不跟就 401，且与
  「凭据失效」逐字同形）。中国大陆出口会被分流；可用
  `magpie plugin options dsh-providers-hub '{"minimaxXff":"<海外IP>"}'` 绕行（默认关）。
- `access_token` **不是 JWT**（`mmoat_` 前缀）⇒ 过期时间只能来自 `expires_in` 自算。
- 思考档位错发就是 400 或假关闭：M3.1 系**永不发** `disabled`（硬 400）；
  M2.7 系不发 thinking 字段；只有 M3 可真开关。

## 安装与使用

```bash
magpie plugin add <本仓库路径或 github:Gyl1219/magpie-providers-hub>
magpie plugin login dsh-providers-hub     # 选渠道登录
```

改代码后重载（终端每次按文件夹当前内容加载；应用里需关掉再打开）：

```bash
magpie plugin off "<目录>"
magpie plugin on  "<目录>"
```

## 为什么做这些

ofm 已覆盖 13 个渠道（CodeArts、WorkBuddy 国内/国际、LobsterAI、Qoder 国内/国际、TRAE、
Cline、Loomy、Raccoon、MiniMax Code 国内、ZCode、Gemini）⇒ **这些不做**，重复实现没有价值。
MiniMax **国际版**是例外：ofm 渠道包只有国内站（`account.minimax.cn`），magpie 社区插件的
国际版登录则卡在上游 307 丢 Authorization 的坑里（见上节）——而 DSH 已把这两个坑都
真机修通过，故移植其实现。

⚠️ hub 的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分派给其它渠道），不是真实
渠道，独立实现等于重写整个调度层 ⇒ **不在范围内**，那部分仍需依赖 DSH Hub 网关的桥接插件。

## 已知边界

- **officeace 需先开通 ModelArts MaaS**：未开通时 `permission-validate` 不返回
  `model_app_key`，插件会明确提示去华为云控制台开通。
- **`refresh_token` 一次性**（华为云 STS5.1806）：续期一旦失败即永久失效，必须重新登录。
  失败会 `console.warn` 留痕，**绝不静默吞掉**。
- **astudio 无程序化续期**：`refresh()` 直接抛错说明要人工重登，不假装有。
- 极验**不破解**：加载官方 `gt.js`，把回调给的 `challenge`/`validate`/`seccode` 原样提交。

## 加一个新渠道

1. 写 `src/<channel>.mjs`，导出渠道对象：`{ id, displayName, fallbackModels, login, refresh, expired, catalog, chat }`
2. 在 `src/aggregate.mjs` 的 `CHANNELS` 里加一项

不需要新建目录，不需要新建插件条目。

## 测试

```bash
npm test
```

覆盖签名三处坑、前缀分派、未登录回落、单渠道失败隔离、无续期声明、
OfficeAce 续期五缺口、MiniMax 传输（307 保凭据/白名单/地理路由）、
OpenAI↔Anthropic 翻译、目录口径、设备码认证。

## 结构

```
index.mjs                  导出插件函数
src/aggregate.mjs          聚合层：一个供应商，按前缀分派（含聚合级续期去重闸）
src/officeace.mjs          华为云渠道
src/astudio.mjs            讯飞渠道
src/minimaxintl.mjs        MiniMax 国际版渠道（设备码 + PKCE）
src/minimax-transport.mjs  MiniMax 传输层（307 保凭据跟随、传输重试、地理路由）
src/minimax-bridge.mjs     OpenAI↔Anthropic 翻译桥（含 SSE）
src/shared.mjs             凭据存取、信封解析
tests/                     node --test
NOTICE.md                  协议来源与边界声明
```

## 归属

本仓库与原项目的关系详见 [UPSTREAM.md](UPSTREAM.md) 与 [NOTICE.md](NOTICE.md)。

## License

MIT — 见 [LICENSE](LICENSE)。渠道商标与产品名称归各自权利人所有；本插件只是让用户用
**自己的账号**访问这些服务。
