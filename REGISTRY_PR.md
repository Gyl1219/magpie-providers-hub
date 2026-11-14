# REGISTRY_PR.md — 上架 magpie 社区（registry.json）的 PR 材料

> 目标：让插件在 magpie 的「发现」页带**绿标「magpie 社区」**（现在是 GitHub 话题
> 巡检器搜到的黄色「未审阅」卡）。
>
> 证据链：社区仓库里每一张绿标卡都对应 `registry.json` 里的一条，且都是**外部作者提
> PR 合进来的** —— `git log` 实测：
> ```
> 47cda88 2026-10-28 MYCF711  registry: add OfficeAce (officeace-auth) (#399)
> 6a9c528 2026-10-29          loomy: add the iFlytek Loomy plugin (#175)
> eeb344f 2026-10-29          catpaw: add the Meituan CatPaw plugin (#174)
> 3104d00 2026-10-29          registry: add ComfyUI local model bridge (#497)
> ```

## 〇、审核红线（先自查，否则会被 block）

MYCF711 的 #399 在 2026-10-27 被卡住的原话：

> The 10-27 review blocked it on `src/self-register.mjs` in officeace-auth 0.1.8,
> which rewrote magpie's `~/.cache/magpie/plugin-market.json` on every load. …
> grep over index.mjs and src/: **no fs writes, child_process, eval or HOME/cache paths**.

本仓库已按这条标准整改（2026-10-30，有回归网 `tests/no-host-writes.test.mjs`）：

| 项 | 状态 |
|---|---|
| 自注册（写 magpie 市场缓存） | **已移出发布包** → `tools/self-register.mjs`（仓库内手工工具，不进 npm） |
| 加载探针：市场缓存 mtime/内容零变化 | 通过（审核同款探针，见测试红线③） |
| 登录用 Chromium 一次性 profile | 从 `~/.cache/magpie` 挪到系统临时目录 |
| `child_process` 用途 | ① AutoClaw 桌面端凭据探测（execFileSync）② MagiCrew 浏览器登录（spawn Chrome）—— **仅在登录时，加载时不跑**（v0.12.0 起已不再 spawn 通知进程） |
| 凭据落点 | **只在两处**：magpie 账号槽（`client.auth.set` / `getAuth`）+ 本进程内存。v0.5.0 起不再写 `~/.config/magpie/<channel>-credential.json`（#502 审核第 2 条：那里默认 0644） |
| 只读引用 | magpie 的模型缓存（只读，作目录兜底） |

## 一、提交方式（不用手动 fork）

1. 打开 https://github.com/magpie-community/plugins/blob/main/registry.json
2. 右上角铅笔 **Edit**
3. 在 `plugins` 数组末尾（最后一个 `}` 前）粘下面这段
4. **Propose changes** → GitHub 会提示「你没有写写权限，已为你创建 fork」→ 这就是自动 fork
5. 填标题/正文（下面有草稿）→ **Create pull request**

## 二、registry.json 要加的条目（v0.13.0：十二条随包渠道，含公开 marvis）

> ⚠️ 这张表**不要手抄**。它是 `package.json` 的 `files` 的函数：
>
> ```bash
> node tools/registry-entry.mjs          # 打条目片段（id 从 files 实推，顺序稳定）
> node tools/registry-entry.mjs --check  # 校验：条数=12 / 随包渠道与 files 一致 / 摘要字数
> ```
>
> 当前实跑结果：**12 条渠道，`summary.zh` 605 字，`summary.en` 1268 字符**。

```json
  ,
  {
    "package": "magpie-providers-hub",
    "name": "Providers Hub",
    "providers": [
      "hub-astudio",
      "hub-accio",
      "hub-lobsterai",
      "hub-magicrew",
      "hub-magicrew-intl",
      "hub-marvis",
      "hub-autoclaw",
      "hub-autoclaw-cn",
      "hub-loomy",
      "hub-monkeycode",
      "hub-monkeycode-intl",
      "hub-qiniu"
    ],
    "community": true,
    "summary": {
      "en": "Twelve providers in one install: AStudio, Accio, LobsterAI, MagiCrew (CN + Intl), AutoClaw (Intl + CN), Loomy, MonkeyCode (CN + Intl), Qiniu MaaS and Tencent Marvis. One provider per channel (hub-<channel>): each has its own sign-in, metering, on/off switch and failover. AStudio: Spark + DeepSeek with daily check-in credits; the standalone astudio plugin uses Responses, and both draw on one points pool. Accio: 15 models priced by multiplier. LobsterAI: DeepSeek/GLM/Kimi, image input. MagiCrew: credit packs banded by expiry. AutoClaw: reads the desktop app login or takes a pasted token; importing rotates the one-time refresh token and signs the AutoClaw desktop app out, so it asks for sign-in again; web OAuth and SMS are not supported here (use opencode-autoclaw-auth for those), and both plugins read one account's balance. Loomy: WeChat QR or SMS; opencode-loomy-auth has SMS and pasted session only, and both read one account's balance. MonkeyCode: sign-in swaps the key, three quota tiers. Qiniu MaaS: pay-as-you-go with check-in credits, the only Qiniu entry. Marvis: QQ / WeChat OAuth or importing the local sign-in, no paste entry; no standalone package for this channel. Third-party adapter of iJetLi/dsh-providers-hub (MIT); no DSH needed at runtime.",
      "zh": "十二家供应商一起装：AStudio（讯飞）、Accio（阿里）、LobsterAI（有道龙虾）、超级麦吉 MagiCrew（国内+国际）、AutoClaw（国内+国际）、Loomy（讯飞）、MonkeyCode（国内+国际）、七牛云 MaaS、腾讯 Marvis。一渠道一供应商（hub-渠道），各自登录、额度、开关与故障转移。AStudio：星火与 DeepSeek，签到送积分；独立的 astudio 插件走 Responses，两边共用同一积分池。Accio：15 模型按倍率计费。LobsterAI：DeepSeek/GLM/Kimi，可看图。MagiCrew：积分按到期日分档。AutoClaw：读桌面登录态或贴 token；导入会轮换一次性 refresh_token，桌面客户端会被登出、之后需重新登录；不支持网页 OAuth 与短信（那些用 opencode-autoclaw-auth）；与它共用同一账号积分。Loomy：微信扫码或短信；opencode-loomy-auth 只有短信与粘贴 session；两边共用同一积分。MonkeyCode：登录换 Key，三档额度。七牛云：按量计费 + 签到，七牛唯一入口。Marvis：QQ/微信 OAuth 或导入本机登录态，无粘贴入口；registry 无同渠道独立包。第三方适配 iJetLi/dsh-providers-hub（MIT）。"
    }
  }
```

### 摘要为什么这么写（0.12.3 修的就是这个）

旧版 `summary.zh` 有一千多字，magpie 的卡片只露出**一句话**（尾部）。用户看到的
是七牛那一段的结尾「为七牛唯一入口……」，读起来像「这是个七牛专用插件」——
清单本身没错，是**摘要写法**把人误导了。

新版规则（`tools/registry-entry.mjs` 里有门禁）：

1. **第一句就是总览**，十一条渠道名全部点名，截断也不会误读成单渠道插件；
2. 之后每渠道一句要点（登录方式 / 额度形态 / 是否可看图），**中文 400 字以内**；
3. 英文同步精简（≤900 字符），与中文同结构；
4. 不再用「为……唯一入口」这类收尾句。

## 三、PR 标题与正文（直接复制）

> ⚠️ **2026-11-14 更新：本次是「加第 12 个 provider + 换摘要」。**
> 线上 `registry.json` 已有 `magpie-providers-hub` 条目（11 条 providers），
> 本次新增 **`hub-marvis`**（腾讯 Marvis，随包发布），并把 summary 换成
> 「十二家供应商一起装…」（zh 381 字 / en 814 字符，原来是 1346 / 2782）。
> **顺序前提**：npm 必须先发出带 marvis 的版本（`0.13.0`），否则用户点安装装不到这个渠道。

**Title**

```
registry: add hub-marvis to magpie-providers-hub (12 providers)
```

**Body**

```markdown
在 `magpie-providers-hub` 条目里增加第 12 个渠道 `hub-marvis`（腾讯 Marvis），并把 summary 换成以渠道名开头的总览 —— 逐渠道差异说明照旧保留，长度仍比原来那条短。

**新渠道**：`hub-marvis`（腾讯 Marvis）。登录走 QQ / 微信 OAuth（隔离浏览器窗口），或直接导入本机已有的 Marvis 登录态；没有粘贴 token 的入口。模型用 Marvis 自己的槽位 —— 它没有远端目录端点（9 个候选端点实测全 404），所以只列确知可用的槽位。

**摘要**：中文 605 字 / 英文 1268 字符（原来 1346 / 2782）。开头改成「十二家供应商一起装：…」，卡片截断后不再只剩来源那句；同时保留 #614 要的重叠渠道差异说明，以及 AutoClaw 导入会登出桌面端那条提醒。

**真机验证**（Windows / Node 24）：`/v1/chat/completions` 实测返回 200 与流式正文，模型 `deepseek-v4-1-flash-261017`，usage 60 tokens。包内 `npm test` 357/358，唯一失败的是发布门禁（`page/snapshot.js` 里有本机实时快照时拒绝打包）。

其余不变：`package` / `name` / `community` 未动，`registry.json` 另外 120 条逐字节一致，不写宿主文件（`tests/no-host-writes.test.mjs` 仍覆盖）。

来源：[magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub)，是 [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) 的第三方适配（MIT；署名见 README、UPSTREAM.md、NOTICE.md）。

十二条渠道 —— 一渠道一个 id（`hub-<渠道>`），各自登录、额度、开关与故障转移：

`hub-astudio` `hub-accio` `hub-lobsterai` `hub-magicrew` `hub-magicrew-intl`
`hub-autoclaw` `hub-autoclaw-cn` `hub-loomy` `hub-monkeycode` `hub-monkeycode-intl`
`hub-qiniu` `hub-marvis`
```

## 四、PR 之后的验证

```bash
magpie plugin add magpie-providers-hub     # 按包名装得上
# 发现页搜 Providers Hub → 绿标「magpie 社区」+ 十一条 provider 的「承载 …」
# 卡片摘要是「十一条供应商一起装：…」，不再以七牛收尾
```

⚠️ `scripts/new-to-npm.sh` 会把「npm 上还没有的包」标出来，但 `pr.yml` 的注释写明
**不阻断合并**（`@magpie-community/*` 从 dist 分支装）。我们是非 scope 包名，
所以 npm 发布仍要尽快落地 —— 否则用户点了「安装」会装不到 0.12.3。

## 五、本文件自带的自检

```bash
cd magpie-providers-hub

# ① 条目取材：id 从 package.json 的 files 实推，不手抄
node tools/registry-entry.mjs --check
# 期望输出：
# registry 条目校验通过：11 条渠道，summary.zh 385 字，summary.en 727 字符

# ② 文档与代码一致：本文件那段 JSON 与 files 实推、与 tools 里的常量逐项相等
node tools/check-registry-doc.mjs
# 期望输出：
# REGISTRY_PR.md 与代码一致：11 条渠道，summary.zh 385 字，summary.en 727 字符
```

第 ② 段是**文档与代码一致性**的门禁：手改了 `package.json` 的 `files`（或增删了一个
渠道文件）却忘了改本文件，它会以非 0 退出并指出是「少了 / 多了」哪个 id。

两个脚本都在 `tools/` 里，**不进 npm 包**（`files` 未列 `tools/`）；
它们不做任何宿主写入，只是读 `package.json` 与 `src/` 的文件名。