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

- **到期包型**（有作废时间）→ 全部走滚动指针：astudio / minimaxintl / officeace /
  magicrew（共享工具）；autoclaw ×2 / lobsterai（自带同款实现，门禁白名单豁免）。
- **余额/重置型**（只有永久余额 + 每日重置窗，无作废包）→ **滚动指针不适用**，
  现状正确，别硬套：loomy（永久积分 + 每日赠送 resetsAt）、accio（不下发作废时间）。

## 2. 签到：归属、判定、「已领过」语义

### 归属：**谁的结果在谁下面**（用户 2026-10-28 定案）

聚合层 `checkin(getAuth)` 会被 magpie 对**每个账号**各调一次。规则：

- 有渠道的账号 → **只返回自己渠道的结果**（outcome/credit/message 都是自己）。
  旁路补签（无账号槽的渠道，如 sidecar-only 的 minimaxintl）照跑，但结果
  **只进页面快照**（`snapshotCache.checkin`），**绝不**进本账号的返回信息。
  —— 真机报障：全渠道明细怼到每个账号底下（Loomy 卡片挂着 OfficeAce/MiniMax/
  AutoClaw 一整屏），用户原话「谁失败在谁下面啊，你全怼到一块干嘛」。
- 无渠道上下文（api key 形态）→ 才返回全渠道汇总。

### 判定顺序：claimed → done → failed → inactive

- 领到新额度 = claimed；**都签过了（全是 done）= done，哪怕个别渠道失败**；
  一个没签且有失败 = failed。旧顺序（failed 先于 done）曾让任一渠道失败把
  所有账号判成「签到失败，magpie 稍后重试」。
- 一个渠道失败只影响**它自己**的账号行 + 页面快照，不连坐。

### 「今天已领过」要报 claimed，不是 done

magpie 的渲染：`claimed/done` + **`again:true`**（magpie 对**中午前的 done**自动标）
→ 黄色「回复已签到…稍后再问」；`claimed` 无 again → 绿色「今日已签到 +N」。
所以：渠道签到发现「今天已领过」时，**今日的奖励确实入账了** → 报
`claimed` + 今日发放量（loomy 的 alreadyProcessed → claimed+dailyQuota；
magicrew 的 granted:false → claimed+site.dailyGrant）。done 只留给
「确实无可领」（如 officeace 无活动）。

### 占位必须 inactive

渠道无签到端点/不做签到 → `outcome: 'inactive'`。**绝不返回 failed**（会把聚合
判定拖成失败，每个账号挂红字）。参照 lobsterai/minimaxintl 的 inactive 用法。

## 3. 门禁

`tests/expiry-bands-required.test.mjs`：
1. 锁死 `expiryBandedWindows` 的分档语义（临期/长期合并/永久/已耗尽/aside/不挂 runsOutAt）；
2. 源码扫描 —— 渠道有到期逻辑却没引用 banding 工具 → 红。
   白名单 `GRANDFATHERED`（autoclaw/lobsterai/loomy）是存量豁免，
   **新增渠道不得加入**。

## 4. 环境与宿主陷阱（真机踩过，别再踩）

- **不要用 `NODE_TEST_CONTEXT` 判测试**：magpie 给 bun 宿主的环境里它也有值，
  会把生产通知/快照写入整个吞掉。测试隔离用显式 `options.notify === false` +
  `tests/setup.mjs` 的 `DSH_HUB_SNAPSHOT_PATH` 重定向。
- **快照路径必须是字符串**，不能是 `file://` URL 对象（拼 `.tmp` 会炸且被吞，
  快照从此静默不更新）。
- **writeSnapshot 在模块层**，引用工厂内的 const 会 ReferenceError 被静默吞掉 ——
  用模块层开关（`snapshotWritesDisabled`）。
- **Windows 通知**走 spawnSync PowerShell WinRT（`notify`）：
  两个程序集都要先加载（Notifications + XmlDocument）、绝对路径、
  spawnSync 捕获 stderr（detached+ignore 让报错不可见，排查两天）。
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

- 渠道 `id` = magpie 供应商 id，一旦发布不能改（用户登录态按它认领）
- 登录走 `beginLogin(openBrowser)` → `{ url, result }`；`authorize()` 立刻返回，
  真正等登录的是 `callback()`；**通知/快照挂自己的完成链**
  （`started.result.then`）—— magpie 对 auto 流程未必回调 callback（真机实证）
- 防重复登录：登录前记账号槽快照；**未过期的重复登录不覆盖原槽**
  （callback 跳过 saveAuth/writeSidecar），报「账号重复」；过期重登 = 覆盖 +
  「已更新登录（已续期）」
- 凭据双写：magpie 账号槽（`client.auth.set`）+ 旁路 sidecar（`saveCredential`）
- OfficeAce 的 refresh_token 一次性（STS5.1806）：STS 成功**立即落盘** +
  并发去重闸（refreshInFlight）—— 已消费的救不回，只能重登
- 提交信息用 `-F <file>`（PowerShell 内联多行会乱）；临时草稿文件进 .gitignore
