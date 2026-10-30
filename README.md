# magpie-providers-hub

> **原项目：** [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) ｜ **作者：** [JetLi](https://github.com/iJetLi)
>
> **本仓库是原项目的第三方 Magpie 适配版本，不是原项目官方发布。**
> 账号渠道、EAC 授权流程、本地服务与管理界面来自原项目，这些功能的主要实现归
> 原作者及其上游贡献者。本仓库新增 Magpie 供应商接口、自动服务管理、浏览器管理入口和兼容测试。

Magpie / OpenCode 供应商插件 —— 把 **DSH Providers Hub 里的渠道**做成**独立实现**。

> **v0.5.0 起只提供 5 条渠道**：与社区 registry 里已有插件重叠的五条（OfficeAce、
> AutoClaw 国内/国际、Loomy、MiniMax 国际版）**已从包里删除**（PR #502 审核结论）。
> 老用户改装对应社区插件即可，见下方「迁移」一节。

**不依赖 DSH**，不依赖 DSH 桌面版是否运行：登录、续期（渠道支持时）、模型目录、请求转发
全部在插件内完成。

## 形态：一个插件，五条供应商（v0.5.0）

**装一次，Magpie 里出现五条供应商**，一个渠道一条：

```
hub-astudio   hub-accio   hub-lobsterai   hub-magicrew   hub-magicrew-intl
```

- 一个 git 仓库 / 一个 npm 包 / 一条安装命令 —— provider id 不是包，插件包可以注册任意多个
  （社区 `opencode-trae-auth` 一个包两个供应商、`opencode-qoder-auth` 一个包四个，同理）；
- 每个供应商有自己的登录按钮、额度卡、rpm 与开关，**可以单独关掉**；
- magpie 的故障转移是 provider 粒度 ⇒ **能跨渠道切**（`hub-astudio` 被限流时可以换到
  `hub-accio` 的账号）；
- 模型 id 由 magpie 拼成 `hub-astudio/spark-x`（目录里我们返回的是裸模型名 `spark-x`）。

> **从 0.4.x 升级（重要）**：包里删掉了 OfficeAce / AutoClaw 国内+国际 / Loomy /
> MiniMax 国际版 四条渠道的代码（原因见下节）。这五条供应商会从 Magpie 里消失，
> **改装对应的社区插件即可**：
> - OfficeAce → `officeace-auth`
> - AutoClaw（国内/国际）→ `opencode-autoclaw-auth`
> - Loomy → `opencode-loomy-auth`
> - MiniMax Code 国际版 → `opencode-minimax-auth`
>
> 剩下的五条（astudio / accio / lobsterai / magicrew×2）**登录态不受影响**。
> 另外：插件已不再往 `~/.config/magpie/` 写任何凭据文件，旧的
> `<渠道>-credential.json` 可以手工删掉。

## 为什么删掉那五条

PR #502 的一轮审核（magpie-community/plugins）指出两件事，都成立：

1. **一个订阅两个入口**：registry 里已经有 OfficeAce / AutoClaw / Loomy / MiniMax 国际版
   的社区插件，再出一个同名能力的供应商，用户会搞不清该装哪个；
2. **它们各自带着与本插件无关的敏感能力**：AutoClaw 那套要**解密本机桌面端凭据**
   （DPAPI masterKey + AES-256-GCM），MiniMax 国际版带着**伪造 XFF 绕地区分流**。
   这两样只服务那两条渠道，留着就是白送风险面。

删代码而不是「默认不注册」，是因为审核在意的是**包里有什么**，不是默认开没开。

## 当前渠道

| 渠道 id | 供应商 id | 归属 | 登录方式 | 模型 | 续期 |
|---|---|---|---|---|---|
| `astudio` | `hub-astudio` | 讯飞 AstronStudio | 本地载体页（极验 + 短信 / 密码 / 微信） | `/api/v1/model-manager/models` | ❌ 不支持（会话一年，不滑动） |
| `accio` | `hub-accio` | Accio Work（阿里） | OAuth PKCE + 本地 loopback 回调 | `POST /api/llm/config/v2` | ✅ refresh（⚠️ 轮换 refresh_token，已串行化） |
| `lobsterai` | `hub-lobsterai` | 有道 LobsterAI（龙虾） | 官方门户 OAuth + 本机 loopback 回调 | `/api/models/available` | ✅ 标准 refresh_token 轮换 |
| 超级麦吉（国内） | `hub-magicrew` | 超级麦吉（letsmagic.cn） | 载体页：CDP 浏览器登录 / 手机号密码 / 粘贴 JWT | `/api/v1/flows/models` | ✅ refresh_token（⚠️ PUT 一次轮换一次）+ `mgw_` api_key 2h 自续 |
| MagiCrew（国际） | `hub-magicrew-intl` | MagiCrew 国际版（magicrew.ai） | 同上（国际站同协议） | 同上 | ✅ 同左 |

### astudio

登录**不走讯飞的授权页**，而是本地起一个 HTTP 服务承载登录页（与 DSH 的
`startAstudioLoginFlow` 同机制）：页面里完成极验 + 短信/密码/微信，拿到会话后去
`bot/models/configs` 换推理凭据。

⚠️ 两个实测坑：
- `/model-gateway/v1/models` 恒 **404**；目录在 `/api/v1/model-manager/models`（两个基址不共用前缀）
- 推理端只认**裸 slug**；发 `builtin/<base64>` 会 502（`builtin/` 是 acode 内核内部别名）

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

### lobsterai

有道 LobsterAI（龙虾，`lobsterai-server.youdao.com`）。登录是官方门户 OAuth +
**本机 loopback 回调**换 token。三个坑：**信封统一 `{code,msg,data}`**，`code !== 0`
即失败 —— 唯一例外是 chat，它返回**裸 SSE 不套信封**；**refresh 不带
Authorization**（带着会被拒，匿名头只有 Accept/Content-Type/User-Agent 三个）；
**模型列表必须带 `X-LobsterAI-Client-Capabilities` + `X-LobsterAI-Client-Version`**，
否则只回 25 个模型且缺 `kimi-k3`。

### magicrew / magicrew-intl（超级麦吉）

超级麦吉：**国内 `letsmagic.cn` 与国际 `magicrew.ai` 是两个渠道**（账号体系隔离，
同 autoclaw 的两个站点）。模型网关是 OpenAI 兼容，但要先换 `mgw_` api_key。

凭据是**三段式**：登录 JWT → `POST /api/v1/model-gateway/tokens` 签发 `mgw_` api_key
（**只活 2 小时**，提前 10 分钟自续）→ 续期用 `PUT` 同一个端点，**refresh_token 7 天、
PUT 一次轮换一次（一次性，必须串行 + 立即落盘）**。登录三种方式：CDP 浏览器登录
（复用本机 Edge/Chrome 登录态，一次性 profile 用完即删）、手机号+密码、粘贴 JWT 与
组织码。签到 = 每日登录赠送（+200/+50 积分，幂等）+ 新手福利任务。

⚠️ 上游网关有两条协议债，已在 `chat` 里改写：**`max_tokens` < 512 会被 reasoning
吃光导致返回空 content**（统一抬到 512）；**可用积分不足时上游回 HTTP 400**（改写成
402，否则 magpie 不会换账号重试）。另 `tool` schema 的 `additionalProperties: {}` /
`items: {}` 会被网关拒（分别改成 `true` / 删除）。

## 安装与使用

```bash
magpie plugin add <本仓库路径或 github:Gyl1219/magpie-providers-hub>
magpie plugin login hub-astudio       # 登录某个渠道（五条供应商各登各的）
```

模型在选择器里长这样（magpie 自动补供应商名）：`hub-astudio/spark-x`、
`hub-accio/<模型>`、`hub-magicrew/<模型>`…

改代码后重载（终端每次按文件夹当前内容加载；应用里需关掉再打开）：

```bash
magpie plugin off "<目录>"
magpie plugin on  "<目录>"
```

⚠️ 插件选项是**插件级**（所有实例共享同一个 options 对象）：
`magpie plugin options hub-astudio '{"snapshotRefreshMinutes":10}'`
（`snapshotRefreshMinutes` 控制页面快照的刷新周期，默认 5 分钟，0 = 关闭）

## 为什么做这些

选型原则：**只做社区 / ofm 还没有的渠道**，重复实现没有价值（这也是 v0.5.0 删掉
OfficeAce / AutoClaw / Loomy / MiniMax 国际版的原因 —— 社区插件已经覆盖了）。

保留的五条里：AStudio 与 Accio 是 magpie 社区至今没有的实现；LobsterAI 与
MagiCrew（国内/国际）有社区包但这里保留了各自修过的真机坑（见下节各渠道小节）。

**AutoClaw 国内/国际**是后来应需求加入的（虽与社区插件覆盖重叠）：上游 DSH 对该渠道
做过四轮审计修复（X-Version 硬校验、406 白名单、档位本地门禁、JWT exp 权威过期、
`display:false` 钱包过滤、流水净额批次），社区插件跟进慢，且一键导入桌面端凭据 +
Z.ai OAuth 的完整登录、与其它渠道统一的三档用量汇总，只有这里有。

⚠️ hub 的 `aggregate` / `jet-hub-auto` 是**池路由**（hub 内部把请求分派给其它渠道），不是真实
渠道，独立实现等于重写整个调度层 ⇒ **不在范围内**，那部分仍需依赖 DSH Hub 网关的桥接插件。

**Loomy / LobsterAI / 超级麦吉**（`loomy` / `lobsterai` / `magicrew` / `magicrew-intl`）虽与
ofm、社区包有覆盖重叠，仍收进本仓库：它们各自有必须真机取证才能通的协议坑（见上两节），
且收进来后**登录载体页、凭据续期、三档用量、签到**四件事是同一套形态 —— 一个供应商里
一次配齐，不用为每个站点各装一个包、各学一套交互。

## 已知边界

### 为什么从「聚合」改成「一个插件多条供应商」

0.3.x 是一个 provider id 包住十个渠道（ofm 同款）。问题出在 magpie 的粒度
（[#1](https://github.com/Gyl1219/magpie-providers-hub/issues/1) 里由
[@MYCF711](https://github.com/MYCF711) 指出，属实）：

- **故障转移不跨渠道**：failover 按 provider 粒度运作 —— OfficeAce 被限流时不会切到
  AStudio，而是原样返回错误；
- **设置按 provider 粒度**：关掉一个渠道 = 关掉全部；fallback / preset 无法只针对单渠道。

v0.4.0 拆开后这两点都没了（每渠道一条供应商），代价是**模型名一次性变化**
（`providers-hub/<渠道>/x` → `hub-<渠道>/x`）与旧账号槽需要迁移（插件自动做）。

社区仍有独立包可选（如 [@MYCF711/magpie-officeace](https://github.com/MYCF711/magpie-officeace)，
它在本插件 officeace 实现的基础上补了 V11 签名订阅 API 与 bonus 签到）。
我们用 `hub-` 前缀就是为了**不与它们抢 provider id**，两条路线可以同时装、同时用。

- **officeace 需先开通 ModelArts MaaS**：未开通时 `permission-validate` 不返回
  `model_app_key`，插件会明确提示去华为云控制台开通。
- **`refresh_token` 一次性**（华为云 STS5.1806）：续期一旦失败即永久失效，必须重新登录。
  失败会 `console.warn` 留痕，**绝不静默吞掉**。
- **astudio 无程序化续期**：`refresh()` 直接抛错说明要人工重登，不假装有。
- 极验**不破解**：加载官方 `gt.js`，把回调给的 `challenge`/`validate`/`seccode` 原样提交。
- **旁路-only 渠道的签到**：一键导入的 AutoClaw 这类没有 magpie 账号（magpie 不会为它调
  checkin）⇒ 由插件的 5 分钟 sweep **每日补签一次**，结果只进页面快照。

## 加一个新渠道

1. 写 `src/<channel>.mjs`，导出渠道对象：`{ id, displayName, fallbackModels, login, refresh, expired, catalog, chat }`
2. 在 `src/aggregate.mjs` 的 `CHANNELS` 里加一项
3. 在 `index.mjs` 加一个 `export const Hub<名字>Plugin = makeHubPlugin(channel)` + 塞进 `HUB_PLUGINS`

⚠️ 入口模块里**每个函数导出都是一个供应商**：工厂/工具函数不能从 `index.mjs` 导出。
供应商 id 自动是 `hub-<渠道 id>`，显示名默认取渠道的 `displayName`（可在
`PROVIDER_NAME_OVERRIDES` 覆盖）。

## 测试

```bash
npm test
```

覆盖签名三处坑、前缀分派、未登录回落、单渠道失败隔离、无续期声明、
OfficeAce 续期五缺口、MiniMax 传输（307 保凭据/白名单/地理路由）、
OpenAI↔Anthropic 翻译、目录口径、设备码认证、额度到期分档（滚动指针门禁）、
超级麦吉凭据三段式（api_key 自续 / `isoMs` 过期判定 / 内嵌 base64 JWT）、
签到归属与判定顺序、AutoClaw 的 chat body 清洗（tidyWire）。

## 结构

```
index.mjs                  十个具名插件导出（每个渠道一个供应商）+ HUB_PLUGINS
src/aggregate.mjs          供应商工厂：makeHubPlugin(channel)、模块级快照/sweep/迁移
src/officeace.mjs          华为云渠道
src/astudio.mjs            讯飞渠道
src/minimaxintl.mjs        MiniMax 国际版渠道（设备码 + PKCE）
src/minimax-transport.mjs  MiniMax 传输层（307 保凭据跟随、传输重试、地理路由）
src/minimax-bridge.mjs     OpenAI↔Anthropic 翻译桥（含 SSE）
src/accio.mjs              Accio（阿里）渠道（Gemini 风格信封 + 工具分片合并）
src/autoclaw.mjs           AutoClaw 国内+国际渠道（MD5 签名 / 406 白名单 / Z.ai OAuth / 凭据导入）
src/loomy.mjs              Loomy（讯飞）渠道（双认证头 / 短信三步流 / 每日额度签到）
src/lobsterai.mjs          LobsterAI（有道）渠道（信封 + 裸 SSE 对话 / 门户 OAuth 回调）
src/magicrew.mjs           超级麦吉国内+国际渠道（三段式凭据 / 积分到期分档 / 签到与新手任务）
src/magicrew-browser.mjs   超级麦吉 CDP 浏览器登录（复用本机 Edge/Chrome 登录态）
src/shared.mjs             凭据存取、信封解析、到期分档
tests/                     node --test
NOTICE.md                  协议来源与边界声明
```

## 归属

本仓库与原项目的关系详见 [UPSTREAM.md](UPSTREAM.md) 与 [NOTICE.md](NOTICE.md)。

## License

MIT — 见 [LICENSE](LICENSE)。渠道商标与产品名称归各自权利人所有；本插件只是让用户用
**自己的账号**访问这些服务。
