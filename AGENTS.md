# AGENTS.md — magpie-providers-hub 开发约定

> 给所有改这个仓库的 AI / 人看。违反下面的约定，`npm test` 会红（第 1、2 条有门禁）。

## 1. 额度窗口必须走「滚动指针」（到期包型渠道）

**铁律**：任何渠道的 `usage()` 返回的窗口，只要**带到期时间**，名字必须带档位后缀
（`临期·N天` / `长期` / `永久` / `已耗尽`），且**不要**自己手拼 window 对象。

### 正确做法（唯一）

```js
import { expiryBandedWindows } from './shared.mjs'

async function usage(credential) {
  const data = await fetchSomething(credential)
  // 把每笔有到期的额度包 / 无到期的余额 都变成一个 bucket
  const buckets = [
    { label: '每日赠送', remaining: 200, expireMs: Date.parse(...), expireRaw: '2026-10-28 23:59:59' },
    { label: '积分包',  remaining: 1000, expireMs: Date.parse(...), expireRaw: '2026-11-03 13:37:44' },
    { label: '积分余额', remaining: 500, expireMs: undefined, expireRaw: '' }, // 永久
  ]
  return expiryBandedWindows(buckets)   // ← 一站式：分档 + 拼窗口 + aside 折叠
}
```

### 规则（`shared.mjs` 的 `assignExpiryBands` 已实现，别重复写）

- **临期** = **最早到期且未耗尽**的桶（FEFO 滚动指针，用完/过期自动轮下一个）
- **长期** = 其余有到期的桶
- **永久** = 无到期日（`expireMs` undefined）
- **已耗尽** = `remaining <= 0`（且 `aside: true` 折叠；**先于**永久判定）
- 窗口名一律 `{label} · {band}`；`display` 一律 `剩余 {N}[ · MM-DD 到期]`
- **不挂 `runsOutAt`**（档位名 + display 日期已够，多挂会重复一行）

### 长期包**必须合并**（用户 2026-10-28 定案）

新手任务/活动奖励每笔各成一包 —— 一条条列出来一屏全是黄胶囊（真机报障）。
所以长期桶要**合并成一个窗口**（临期指针单列，它才是服务端正在扣的）：

```
每日赠送 · 临期·1天      剩余 200 · 10-28 到期     ← 指针单列
积分包   · 长期          剩余 1350 · 共 8 批 · 最早 11-26 到期   ← 合并
积分余额 · 永久          剩余 1000                  ← 永久单独
```

实现见 `magicrew.mjs` 的 usage（assignExpiryBands 分档后把 `band==='长期'` 的桶
求和合并，多批 display 带 `共 K 批 · 最早 MM-DD 到期`，单批只带自己的到期日）。

### 为什么

固定 15 天窗被否过：两笔 3 天/12 天各一笔时只标最早的会瞒住另一笔；最早 200 天后
到期时标红是假警报。滚动指针无这两病：**永远一个红桶、永远显示真实剩余天数**。
（用户 2026-10-25 定案，见 `shared.mjs` 注释。）

### 两类渠道：到期包型 vs 余额/重置型

- **到期包型**（有作废时间）→ 全部走滚动指针：astudio / magicrew（共享工具）；
  lobsterai（自带同款实现，门禁白名单豁免）。
- **余额/重置型**（只有永久余额 + 每日重置窗，无作废包）→ **滚动指针不适用**，
  现状正确，别硬套：accio（不下发作废时间）。
- ⚠️ v0.5.0 起 minimaxintl / officeace / loomy / autoclaw 已从包里删除，不再适用本节。

## 2. 签到：归属、判定、「已领过」语义

### 归属：**谁的结果在谁下面**（用户 2026-10-28 定案）

（v0.4.0 起）**一个渠道一个供应商**：magpie 只会对**本供应商**的每个账号各调一次
`checkin(getAuth)`，所以天然「谁的结果在谁下面」。规则：

- 有账号上下文 → **只返回本渠道的结果**（outcome/credit/message 都是自己）。
  别的渠道的签到结果**绝不**进本账号的返回信息。
  —— 真机报障（0.3.x 聚合形态）：全渠道明细怼到每个账号底下（Loomy 卡片挂着
  OfficeAce/MiniMax/AutoClaw 一整屏），用户原话「谁失败在谁下面啊，你全怼到一块干嘛」。
- 没账号槽、只有内存凭据的渠道（magpie 不会为它调 checkin）→ 由**模块级 sweep
  每日补签一次**，结果**只进页面快照**
  （`snapshotCache.checkin`）。
- 既没账号也没内存凭据 → `inactive`（不是 failed，别把卡片涂红）。

### 判定顺序：claimed → done → failed → inactive

- 领到新额度 = claimed；**都签过了（全是 done）= done，哪怕个别渠道失败**；
  一个没签且有失败 = failed。旧顺序（failed 先于 done）曾让任一渠道失败把
  所有账号判成「签到失败，magpie 稍后重试」。
- 一个渠道失败只影响**它自己**的账号行 + 页面快照，不连坐。

### 「今天已领过」要报 claimed，不是 done

magpie 的渲染：`claimed/done` + **`again:true`**（magpie 对**中午前的 done**自动标）
→ 黄色「回复已签到…稍后再问」；`claimed` 无 again → 绿色「今日已签到 +N」。
所以：渠道签到发现「今天已领过」时，**今日的奖励确实入账了** → 报
`claimed` + 今日发放量（lobsterai 的 alreadyProcessed → claimed+dailyQuota；
magicrew 的 granted:false → claimed+site.dailyGrant）。done 只留给
「确实无可领」。

### 占位必须 inactive

渠道无签到端点/不做签到 → `outcome: 'inactive'`。**绝不返回 failed**（会把聚合
判定拖成失败，每个账号挂红字）。参照 lobsterai / accio 的 inactive 用法。

## 3. 门禁

`tests/expiry-bands-required.test.mjs`：
1. 锁死 `expiryBandedWindows` 的分档语义（临期/长期合并/永久/已耗尽/aside/不挂 runsOutAt）；
2. 源码扫描 —— 渠道有到期逻辑却没引用 banding 工具 → 红。
   白名单 `GRANDFATHERED`（lobsterai）是存量豁免，
   **新增渠道不得加入**。

## 4. 环境与宿主陷阱（真机踩过，别再踩）

- **不要用 `NODE_TEST_CONTEXT` 判测试**：magpie 给 bun 宿主的环境里它也有值，
  会把生产通知/快照写入整个吞掉。测试隔离用显式 `options.notify === false` +
  `tests/setup.mjs` 的 `DSH_HUB_SNAPSHOT_PATH` 重定向。
- **快照路径必须是字符串**，不能是 `file://` URL 对象（拼 `.tmp` 会炸且被吞，
  快照从此静默不更新）。
- **writeSnapshot 在模块层**，引用工厂内的 const 会 ReferenceError 被静默吞掉 ——
  用模块层开关（`snapshotWritesDisabled`）。
- **没有系统通知，也不许再加**：老实现用 spawnSync 跑 PowerShell 拼 toast XML，
  外部文案（厂商报错、账号昵称）拼进单引号字符串 ⇒ **命令注入**（PR #502 审核
  实测可执行任意命令）。现在所有反馈只走 `client.tui.showToast`，且**插件不再
  spawn 子进程**（唯一例外：MagiCrew 登录要拉起本机 Chrome 读 localStorage）。
- **不写任何宿主文件**：凭据只在内存（`memoryCredentials`）+ magpie 账号槽；
  诊断日志要 `DSH_HUB_DEBUG=1` 才写，落点是**系统临时目录**。
- **插件更新**：GitHub 源（`github:owner/repo` spec）走 `magpie plugin update`
  拉 codeload tarball（不经被墙的 raw）；本地路径 spec 不会远程更新。
- **页面沙盒**：只能读快照（`page/snapshot.js`），没有网络、没有 `magpie.read`；
  `display` 是 magpie 一定渲染的兜底（结构化字段 resetsAt/runsOutAt 实测会被
  quotas.json 丢掉，重要时间要写进 display）。

## 5. 渠道 chat 契约（真机 502 踩过）

- 签名是 `chat(credential, { body, signal, renew })` → **返回原始 Response**。
  ⚠️ 不要返回 `{ response: res }` 之类的包装（magpie 会取 `res.headers.forEach`
  → undefined → 502 `undefined is not an object`）；错误转
  `Response.json({error:{type:'provider_error',...}}, {status})`，不要抛。
- 请求体在**第二参的 `body` 字段**里 —— 别把整个第二参当请求体（会把 loader 信封
  `{body,renew,signal}` 一起发给上游）。
- `signal` 透传，**不要挂硬超时**（120s 会把长对话掐断）。
- **过期时间是日期字符串时用 `isoMs`，别用 `Number()`**：`Number("2026-10-28 03:37:02")`
  = NaN → `!isFinite(NaN)` 恒真 → 永远判「没过期」→ 拿死 key 打上游
  （magicrew 真机：HTTP 200 + 业务 403 token无效）。
- **新渠道的 chat 必须真机发一条对话验证**：登录/额度/模型/签到都测了 ≠ chat 通了
  （magicrew 的 502 就是这么漏出去的）。

### magicrew 网关的四条 body 改写（上游 0.3.23–0.3.26 实测，已移植）

① `max_tokens` < 512 → 512（reasoning 会吃光小额，content 返回空串）
② `stream:true` → 补 `stream_options.include_usage`（magicrew 流式不返回 usage，
   magpie 新版靠收尾 chunk 判定流结束，缺了会重试）
③ tools 的 `additionalProperties: {}` → `true`；④ `items: {}` → 删除
   （只走真正的 schema 位置，不碰 properties 键名 / enum / default 值）
另：上游用 **HTTP 400 报「可用积分不足」** → 改写成 **402**，否则 magpie 的
`retryable()` 不换账号（整轮失败 + 账号不 rest）。

## 6. 其它既有约定（简记）

- 供应商 id = `hub-<渠道 id>`，一旦发布不能改（用户登录态按它认领，改名 = 全部渠道集体掉线）；
  渠道 `id` 也别改（它是 provider id 与模型前缀的来源）
- 登录走 `beginLogin(openBrowser)` → `{ url, result }`；`authorize()` 立刻返回，
  真正等登录的是 `callback()`；**通知/快照挂自己的完成链**
  （`started.result.then`）—— magpie 对 auto 流程未必回调 callback（真机实证）
- 防重复登录：登录前记账号槽快照；**未过期的重复登录不覆盖原槽**
  （callback 跳过 saveAuth），报「账号重复」；过期重登 = 覆盖 +
  「已更新登录（已续期）」
- **凭据只在两处**：magpie 账号槽（`client.auth.set` / `getAuth`）+ 本进程内存
  （`memoryCredentials`）。**没有旁路凭据文件**（v0.5.0 起不再写
  `~/.config/magpie/<渠道>-credential.json` —— PR #502 审核第 2 条：
  那里默认 0644，本机任何用户可读）。
- 续期去重闸按**凭据身份**键控（`channel + refresh_token|access_token`）：
  同一凭据并发共享一次在途请求，多账号不串号。refresh_token 一次性的渠道
  消费后救不回，只能重登。
- 提交信息用 `-F <file>`（PowerShell 内联多行会乱）；临时草稿文件进 .gitignore

## 7. 账号导入入口：magpie 原生表单（v0.5.x，lobsterai）

导入已有账号**不进浏览器、不起本地 http**，用 magpie 的 api 型登录方式：

```js
{ type: 'api', keyless: true, label: '手动导入（粘贴凭据）',
  prompts: [                         // 第一栏「什么都收」，其余用 condition 跳过
    { key: 'token', type: 'password', message, placeholder, validate },
    { key: 'refreshToken', type: 'password', condition: (inputs) => !inlineHas(inputs, 'refreshToken') },
  ],
  async authorize(inputs) { ... } }
```

- 宿主流程：先按 `prompts` 逐题问（`/api/plugin-signin/prompt` → 宿主的
  `nextPrompt`，**实时从插件读**，不读 `plugin-providers.json` 里那份缓存），
  `keyless` 时不渲染 API key 框，答完以 `key:''` 调 `authorize(inputs)`。
  `validate` 返回字符串 = 原表单显示红字，表单不关。
- 返回 `{type:'failed', error}` 是**唯一**的失败形状（宿主把 error 显示在表单里）；
  不要把错误抛出去。
- ⚠️ **结果必须带 `refresh` 键**：宿主 `save()` 只看 `'refresh' in result`。
  有它 → 按 oauth 存（`refresh/access/expires` + 其余字段进 extra）并 settle 账号名；
  没有它且 `key` 为空（keyless）→ **宿主一个字段都不写、连 auth 事件都不发**。
- 多账号：**第一个**账号的凭据作为 `authorize` 的返回值交宿主写；第 2..N 个在
  `authorize` 里自己 `client.auth.set`（key 用 `PROVIDER#rand`，先查同 `accountId`
  的旧槽以免重复账号）。
- 槽里同时留两套字段名：宿主的 `access/refresh` 与本插件的
  `access_token/refresh_token/expires_at`（后者走 `...extra`）；`credentialOfAuth`
  只剥 `type/channel/expires/accountId`，loader 与渠道仍读得到。
- 读用户给的 JSON 文件时**只读那一个文件**（不遍历目录），失败文案要把路径和
  `error.code` 说明白，并提示「也可以直接把 JSON 粘进这一栏」。
  唯一例外见下一条「拖拽兜底」：**没有任何目录分隔符的裸文件名**会在几个固定目录里
  各找一次（WebView2 把拖进来的文件只填成 basename）。

### 一栏贴全：宿主一次只渲染一个问题（2026-11-01，m01367）

用户要「四栏并列」，但宿主做不到 —— 别为这个再折腾 UI：

- 宿主 `nextPrompt(provider, index, inputs)` 遍历 `prompts`，`if (p.key in inputs) continue`
  后**立刻 return 一个** prompt 对象；前端 `renderPluginAsk(sub)` 只画一个 `<input>`
  （`key || type === 'password' ? 'password' : 'text'`）+ Next，答完重新走一遍登录流程。
  ⇒ 一次一题，**没有多栏表单**。
- 但 `applies(prompt, inputs)` 认两种跳过条件：`prompt.when {key,value,op}` 与
  `prompt.condition(inputs)`。这就是「一屏填完」的唯一杠杆：第一栏把所有字段都吃下，
  后三栏按「第一栏里有没有」自动跳过。
- 因此**第一栏必须排在 `prompts[0]`**，且它得能识别：裸 token / 整段账号 JSON /
  `access=… refresh_token=… uid=… note=…` 键值对 / 文件路径（解析在
  `src/lobsterai-import.mjs` 的 `inlineFieldsOf`，纯函数、不碰文件系统）。
- `condition` 里还要判「这一栏贴的是文件」（`looksLikeImportFile`，渠道导出在
  `importSpec.looksLikeFile`）→ 三栏全跳过。真机踩过：贴路径时宿主仍追问
  user_id / refresh_token，用户得空按三次回车。
- ⚠️ **手填覆盖里不能包含 `access_token`**：第一栏本身就是 accessToken/JSON/路径，
  拿它当 override 会把整段文本写进 token（真机前测试就红在这）。
- 页面/面板**没有写凭据的通道**（`_magpie/bridge.js` 只导出 theme/context/service/
  onTheme/onAction/options.get/options.set/read；窗口端 `answer()` 的 switch 只有
  hello/theme/options.get/options.set/read，其余抛 `No such call`）⇒ 想自建四栏表单
  提交凭据是不可能的，别往这条路上走。

### 拖拽兜底：宿主没有文件选择器

登录表单只认 `text/password/select`，没有 `file` 类型、没有 drop 回调。所以「拖文件
进来」只能靠 WebView2 的默认行为把**文件名**填进那个 `<input>`（Chromium 给的是
basename，可能是 `file:///…`）。为此 `src/aggregate.mjs` 的 `readImportSource` 认三样：

1. `file:///C:/…`、`file://localhost/C:/…`（`fromFileUrl`，UNC 给 `\\server\share`）；
2. 带引号 / 反引号包住的路径（Windows「复制为路径」）、`~` 展开；
3. **裸文件名**（无 `/ \`）→ 依次在 `cwd` / `home` / `Desktop` / `OneDrive\Desktop` /
   `Downloads` / `Documents` / `OneDrive\Documents` 里 `existsSync` 命中即读。
   固定清单、命中即止，**不是遍历目录**。

### 栏位声明归渠道，不问聚合层

手动导入的 `prompts` 来自 `channel.importCredential.manualPrompts`（文案是渠道自己的
字段名），aggregate 只做「按声明问 + 把答案原样交给 `submit`」。现有四栏：
`userId`（可选，留空从 JWT 取 uid）/ `token`（必填，整段 JSON 也认）/
`refreshToken`（可选）/ `note`（可选，= 账号显示名）。

- ⚠️ **refresh_token 不做硬必填**：真机上「只有 access_token」的账号正是最该导进来的
  那批；缺它照常导入，只 warning「到期要重新导入」。别为了「提醒续期」把能用的账号挡掉。
- **备注优先于昵称**（`accountIdOf`）：官方昵称打码成 `170****7196`，两个小号分不清。
  重复导入不会因此改名 —— `importAccountId` 让按 token 命中的旧槽 `accountId` 优先。
- **降级保护**（抄自 magpie-wpt）：旧槽的到期时间比这次导入的更晚 → 提示「覆盖反而是
  降级」，只提示不拦。算在 `withPreviousSlot` 补字段**之前**，否则补过就不算降级。

## 8. 形态：一个插件，五条供应商（v0.5.0）

0.3.x 是「一个 provider id `providers-hub` 内部聚合十渠道」。v0.4.0 拆成
**每个渠道一条供应商**：magpie 的 failover 与开关都是 provider 粒度，聚合形态下
跨渠道切换与单渠道关闭都做不到（issue #1）。

- **`index.mjs` 里每个函数导出 = 一个供应商**：只能导出 `makeHubPlugin(channel)`
  造出来的成品函数；工厂/工具函数不许从入口导出（否则 magpie 会当成一个新供应商，
  启动时报插件字段缺失）。测试用的映射放**对象/数组**导出（`HUB_PLUGINS`）。
- 供应商 id = `hub-<渠道 id>`，**必须 ASCII**：它会进模型名、CLI 参数、
  `<provider>/<account>` 槽 key。中文 id 会让 `magpie plugin login <id>`
  与模型 id 都出问题（故显示名用中文 `PROVIDER_NAME_OVERRIDES`，不是 id）。
- 目录返回**裸模型名**（`spark-x`），由 magpie 拼成 `hub-astudio/spark-x`；
  `resolve()` 三种写法都认：裸名 / `hub-<渠道>/名` / 旧 `渠道/名`，
  别的供应商 id → 404（不静默转发）。
- **共享的模块级状态**（所有实例共用，别塞进工厂）：
  `snapshotCache`（页面快照）、`sweepState`（5 分钟扫额度 + 补签）、
  `checkinTally`（当日记账）、`migrationsStarted`（旧槽迁移只做一次）、
  `memoryCredentials`（本进程见过的凭据，**不落盘**）、`authGetters`（各实例的
  getAuth，供 sweep 冷启动取凭据）。
  ⚠️ 定时器只能建**一次**：工厂里 `setInterval` 会随 magpie 加载多个实例起多个。
- **旧账号槽迁移**：`migrateLegacySlots()` 把 `providers-hub*` 的槽按 `channel`
  字段搬到 `hub-<渠道>`，幂等（新槽已存在就不动）、可用 `options.migrateLegacySlots:false`
  关掉。
- **测试**：`tests/setup.mjs` 把 HOME 与快照路径都重定向到临时目录 —— 否则测试会读到
  本机真实凭据，「未登录回落」类用例真的去请求上游（实测每个死凭据等 10s）。
  单测要改 HOME 的用例，记得同时改 `DSH_HUB_AUTH_PATH`（env 优先级高于 HOME）。
