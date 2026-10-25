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

与 ofm 同款 —— **Magpie 的供应商列表里只有 `providers-hub` 一个条目**，而不是每个渠道
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
| `accio` | Accio Work（阿里） | OAuth PKCE + 本地 loopback 回调 | `POST /api/llm/config/v2` | ✅ refresh（⚠️ 轮换 refresh_token，已串行化） |
| `autoclaw` | 智谱 AutoClaw 国内 | 本地载体页（**一键导入桌面端凭据** / 短信验证码） | `/autoclaw-proxy/proxy/autoclaw-model-config` | ✅ 标准 refresh_token 轮换 |
| `autoclawintl` | 智谱 AutoClaw 国际版 | Z.ai OAuth（授权页回调）+ 本地导入 | 同上（两站同协议） | ✅ 同左 |

### autoclaw / autoclawintl

智谱清言桌面端（AutoClaw）协议，**国内与国际是两个渠道**：账号体系物理隔离
（手机号 vs 邮箱 OAuth）、API 主机不同、登录方式不同 —— 实测国内 token 打
国际基址全拒，不可能用一个站点参数切换；`appId`/`appKey` 两站通用。

- 登录：国内载体页支持**一键读取本机桌面端凭据**（Electron 凭据解密：
  DPAPI masterKey + AES-256-GCM）或短信验证码；国际版走 Z.ai OAuth
  （`state` 由官方授权页生成随回调带回，插件透传），桌面端已登录也可一键导入。
- ⚠️ 实测坑（都来自上游真机取证）：`X-Version` 是推理**硬校验头**（缺 →
  HTTP 500 空响应体）；`messages[0]` 必须逐字等于白名单前缀（否则 406）；
  `max_tokens` ≥ 10000 或不发；思考档位集合外**不发**（上游对非法档位回
  200 按最贵档跑）；过期时间以 **JWT exp 为权威**（登录响应的声明值偏大 6 天）。

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
  `magpie plugin options providers-hub '{"minimaxXff":"<海外IP>"}'` 绕行（默认关）。
- `access_token` **不是 JWT**（`mmoat_` 前缀）⇒ 过期时间只能来自 `expires_in` 自算。
- 思考档位错发就是 400 或假关闭：M3.1 系**永不发** `disabled`（硬 400）；
  M2.7 系不发 thinking 字段；只有 M3 可真开关。

### accio

Accio Work（阿里）—— **协议与其它渠道都不同：Gemini 风格信封**
（`contents`/`parts`，键 snake_case），不是 OpenAI 也不是 Anthropic。登录是
PKCE + **本地 loopback 回调**（Accio 对 `return_url` 无白名单校验，故回调端口
由插件自起自管），目录按**计费倍率升序**（跨度 0.013~2.8 倍，是选型最重要的信号，
已拼进展示名）。

⚠️ 四个实测坑（都来自 DSH 的真机记录）：
- **token 必须放 body 的 `token` 字段** —— 放 `Authorization` 头恒流内 402
  （且错误以 `HTTP 200 + {"error_code":"402"}` 帧下发，不识别会误报「模型不回复」）；
- **`agent` 侧 HTTP 200 也可能是风控拦截页**（缺 utdid 时阿里网关回 200 +
  `text/html` 跳转脚本）⇒ 插件按 content-type 判别并把原文带进错误；
- **上行必须用 `modelCode`**（`1Drift-…` 非人类可读的内部代号），发 slug 会
  请求打空；对外 id 是展示名的 slug（`qwen-3-8-flash`）；
- **工具调用分片到达**（首帧只有 id/name，后续帧重复全量参数）⇒ 按 id 缓冲、
  `mergeToolArgs` 合并成一次调用（重放会重复执行工具）。

另：`system_instruction` 必须是**字符串**（照 Gemini 包成对象恒 400）；思考档位
仅作展示（上游无任何受控字段，实测四类字段全部无效）。

## 安装与使用

```bash
magpie plugin add <本仓库路径或 github:Gyl1219/magpie-providers-hub>
magpie plugin login providers-hub     # 选渠道登录
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

**AutoClaw 国内/国际**是后来应需求加入的（虽与社区插件覆盖重叠）：上游 DSH 对该渠道
做过四轮审计修复（X-Version 硬校验、406 白名单、档位本地门禁、JWT exp 权威过期、
`display:false` 钱包过滤、流水净额批次），社区插件跟进慢，且一键导入桌面端凭据 +
Z.ai OAuth 的完整登录、与其它渠道统一的三档用量汇总，只有这里有。

⚠️ hub 的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分派给其它渠道），不是真实
渠道，独立实现等于重写整个调度层 ⇒ **不在范围内**，那部分仍需依赖 DSH Hub 网关的桥接插件。

## 已知边界

### 聚合形态的两个取舍（有意为之，但要知道）

一个 provider id 意味着 magpie 把六个渠道当成**一个**供应商，由此有两点与
「每渠道一个独立包」的形态不同（[#1](https://github.com/Gyl1219/magpie-providers-hub/issues/1)
里由 [@MYCF711](https://github.com/MYCF711) 指出，属实）：

- **故障转移不跨渠道**：magpie 的 failover（换账号/换模型）按 provider 粒度运作 ——
  OfficeAce 被限流时不会自动切到 AStudio，而是原样返回该渠道的错误。
- **设置按 provider 粒度**：关掉一个渠道 = 关掉整个 `providers-hub`；
  fallback / preset 也无法只针对单渠道。

对应的补偿：渠道级的配额冷却/轮换在**聚合层内部**按渠道区分（`gatedRenew` 去重闸、
单渠道失败不拖垮其它渠道的目录与转发）；需要跨渠道转移会话时，在模型选择器里
换 `providers-hub/<另一个渠道>/…` 即可。

如果你更需要「单渠道独立开关 + 原生 failover」，社区有独立包可选
（如 [@MYCF711/magpie-officeace](https://github.com/MYCF711/magpie-officeace)，
它在本插件 officeace 实现的基础上补了 V11 签名订阅 API 与 bonus 签到）。
两条路线 provider id 不同，可以共存。

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
src/accio.mjs              Accio（阿里）渠道（Gemini 风格信封 + 工具分片合并）
src/autoclaw.mjs           AutoClaw 国内+国际渠道（MD5 签名 / 406 白名单 / Z.ai OAuth / 凭据导入）
src/shared.mjs             凭据存取、信封解析、到期分档
tests/                     node --test
NOTICE.md                  协议来源与边界声明
```

## 归属

本仓库与原项目的关系详见 [UPSTREAM.md](UPSTREAM.md) 与 [NOTICE.md](NOTICE.md)。

## License

MIT — 见 [LICENSE](LICENSE)。渠道商标与产品名称归各自权利人所有；本插件只是让用户用
**自己的账号**访问这些服务。
