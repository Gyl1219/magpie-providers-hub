# QwenWork 国际版（qwenwork.ai）接入交接

> 来自 `qwenwork-intl` 群的成果，供 `magpie-providers-hub` 使用。
> 全部结论都是实测（HTTP 实打 + 解包国际版桌面端 app.asar），不是推测。

## 一句话

qwenwork.ai 是**独立的 Ory/OIDC 发行方**，登录不是设备码，而是「外部浏览器授权 + 回调落在网关 + 插件拿不到回调」，
所以只能做粘贴式；模型与 API 走 `https://openapi.qoder.sh`。

## 端点与常量（实测）

| 项 | 值 | 来源 |
|---|---|---|
| issuer | `https://qwenwork.ai` | `.well-known/openid-configuration` 200 |
| authorization | `https://qwenwork.ai/oauth2/auth` | 同上 |
| token | `https://qwenwork.ai/auth/oauth/token` | 同上（`/oauth2/token` 是 404） |
| userinfo | `https://qwenwork.ai/user/info` | 同上 |
| revoke | `https://qwenwork.ai/oauth2/revoke` | 同上 |
| device_authorization | `https://qwenwork.ai/oauth2/device/auth` | 声明存在，但该 client 无 device_code grant（实测 invalid_grant） |
| scopes | `openid profile email offline_access qwen_work` | 国际版 app.asar 的 `auth.browserLoginDeployments.scope` |
| client_id | `qwenwork-desktop-app` | 同上；在 .ai 上有效，`wukong` 在 .ai 是 invalid_client |
| redirect_uri | `https://gateway.qwenwork.ai/oauth/callback` | 唯一被接受；环回端口与各种 `qwenwork://` 变体全部 "does not match any of the pre-registered redirect urls" |
| 登录策略 | `native-oauth` + `external-browser` | app.asar `auth.browserLoginDeployments` |
| API / openapi | `https://openapi.qoder.sh` | app.asar `GLOBAL_AUTHORITIES`（`qwenwork-global-prod`） |
| 网关 | `https://gateway.qwenwork.ai` | app.asar `brand.gatewayDomain`、`auth.sources.authBaseUrl` |
| accessStatus | `https://qwenwork.ai/biz/user/v1/access-status` | app.asar |
| product / 深链 | appId `com.qwenwork.desktop`、deeplinkScheme `qwenwork`、updateReleaseLine `qwenwork-global` | app.asar |

国内站对照（同一套软件、只换 host）：issuer `https://qwenwork.cn`，网关与 API 都是 `https://gateway.qwenwork.cn`，
其 `/device/selectAccounts` 接受 `redirect_uri=qwenwork-cn://` 并 302 到 Ory —— 国际站这个路由对任何 query 都 400
`INVALID_DEVICE_FLOW / field=query / reason=not_allowed`，所以**国际版不能用设备流**。

## 已完成的上游实现（可直接抄常量与流程）

仓库 `magpie-community/plugins`，包 `packages/qoder`（本地 checkout `D:\qwenwork-intl\plugins`，**未提交**）：

- `index.mjs` 的 `SITES["qwenwork-intl"]`：站点常量（见上表）
- `index.mjs` 的 `intlSignIn(site)`：PKCE S256 + state + nonce → 授权 URL；回调是**用户粘贴**回来的
  深链/`code`，再用 `code_verifier` 在 issuer 换 token，然后读 `/user/info` 取身份
- `export QwenWorkIntlAuthPlugin`：`makePlugin(base)` 后把默认 oauth method 换成 `intlSignIn`
- `packages/qoder/intl.test.mjs`：6 个 hermetic 测试（fetch 全 mock）
- 实测：生成的真实授权 URL 打过去 302 到登录页（Ory 接受 client/redirect/scope/PKCE）

## 落到 hub 的映射（渠道契约）

新增 `src/qwenwork-intl.mjs`，导出 `{ id, displayName, fallbackModels, login, refresh, expired, catalog, chat }`：

- `id: 'qwenwork-intl'` → 供应商 `hub-qwenwork-intl`（id 一旦发布不可改；ASCII）
- `login`：hub 的 `beginLogin(openBrowser)` 是「打开 URL + 等回调」，而国际版**回调在网关、插件收不到**，
  所以要落成「打开授权页 → 让用户把页面末尾那条 `qwenwork://` 深链或 `?code=` 粘回来」的形态；
  注意 AGENTS.md 第 6 条：`authorize()` 立刻返回，真正等登录的是 `callback()`
- `refresh`：`POST https://qwenwork.ai/auth/oauth/token`，`grant_type=refresh_token`、`client_id=qwenwork-desktop-app`
- `expired`：按 token 的 `expires_at`/`expires_in` 判，别用 `Number()` 解析日期字符串（AGENTS.md 第 5 条）
- `catalog` / `chat`：host 用 `https://openapi.qoder.sh`
- `checkin`：国际站没有签到端点 → `{ outcome: 'inactive' }`（**不要 failed**）
- `usage`：若将来有到期包，必须走 `shared.mjs` 的 `expiryBandedWindows`（门禁会扫）

## 可复跑的证据脚本（`default-workspace` 根目录）

| 脚本 | 作用 |
|---|---|
| `check-qwenwork-oidc.mjs` | 两站 OIDC 端点对照 |
| `probe-intl-redirects.mjs` | 找出 .ai 上已注册的 redirect_uri |
| `probe-qwenwork-gateway.mjs` | 两站 `/device/selectAccounts` 与 poll 对照 |
| `probe-intl-schemes.mjs` | 11 个 scheme × 2 client 穷举（证明设备流走不通） |
| `scan-asar-strings.mjs` | 流式扫 app.asar 取常量（`QW_CTX_BEFORE/AFTER` 调窗口） |
| `verify-intl-facts.mjs` | 四件事一次复核（discovery/redirect/scope/openapi host 出处） |

## 未决 / 别当成已验证

- **端到端真登录没验过**：需要真实国际站账号走一次「浏览器登录 + 粘贴回调」。上游实现只验到
  「授权页接受请求」与全部单测。
- `refresh_token` 能否用于该客户端换新 token：**未实测**。
- 国际站是否存在「免费领会员/积分」类活动：未知，别照搬国内站的活动与 attributionId。