// AGENTS.md 跟进 v0.5.0：五条渠道 / 零宿主写入 / 无系统通知
import { readFileSync, writeFileSync } from 'node:fs'

const p = 'AGENTS.md'
let s = readFileSync(p, 'utf8')
const before = s.length

// ① §1 到期包型渠道清单
s = s.replace(
  /- \*\*到期包型\*\*（有作废时间）→ 全部走滚动指针：astudio \/ minimaxintl \/ officeace \/\n  magicrew（共享工具）；autoclaw ×2 \/ lobsterai（自带同款实现，门禁白名单豁免）。\n- \*\*余额\/重置型\*\*（只有永久余额 \+ 每日重置窗，无作废包）→ \*\*滚动指针不适用\*\*，\n  现状正确，别硬套：loomy（永久积分 \+ 每日赠送 resetsAt）、accio（不下发作废时间）。/,
  `- **到期包型**（有作废时间）→ 全部走滚动指针：astudio / magicrew（共享工具）；
  lobsterai（自带同款实现，门禁白名单豁免）。
- **余额/重置型**（只有永久余额 + 每日重置窗，无作废包）→ **滚动指针不适用**，
  现状正确，别硬套：accio（不下发作废时间）。
  ⚠️ v0.5.0 起 minimaxintl / officeace / loomy / autoclaw 已从包里删除，不再适用本节。`,
)

// ② §2 签到归属：旁路 → 内存
s = s.replace(
  /- 没账号槽、只有旁路凭据的渠道（一键导入的 AutoClaw 这类，magpie 不会为它调\n  checkin）→ 由\*\*模块级 sweep 每日补签一次\*\*，结果\*\*只进页面快照\*\*/,
  `- 没账号槽、只有内存凭据的渠道（magpie 不会为它调 checkin）→ 由**模块级 sweep
  每日补签一次**，结果**只进页面快照**`,
)
s = s.replace(
  '- 既没账号也没旁路 → `inactive`（不是 failed，别把卡片涂红）。',
  '- 既没账号也没内存凭据 → `inactive`（不是 failed，别把卡片涂红）。',
)
s = s.replace(
  '判定拖成失败，每个账号挂红字）。参照 lobsterai/minimaxintl 的 inactive 用法。',
  '判定拖成失败，每个账号挂红字）。参照 lobsterai / accio 的 inactive 用法。',
)
s = s.replace(
  '`claimed` + 今日发放量（loomy 的 alreadyProcessed → claimed+dailyQuota；',
  '`claimed` + 今日发放量（lobsterai 的 alreadyProcessed → claimed+dailyQuota；',
)
s = s.replace(
  '「确实无可领」（如 officeace 无活动）。',
  '「确实无可领」。',
)

// ③ §3 门禁白名单
s = s.replace(
  '白名单 `GRANDFATHERED`（autoclaw/lobsterai/loomy）是存量豁免，',
  '白名单 `GRANDFATHERED`（lobsterai）是存量豁免，',
)

// ④ §4 环境陷阱：Windows 通知已删
s = s.replace(
  /- \*\*Windows 通知\*\*走 spawnSync PowerShell WinRT（`notify`）：\n[\s\S]*?  spawnSync 捕获 stderr（detached\+ignore 让报错不可见，排查两天）。/,
  `- **没有系统通知，也不许再加**：老实现用 spawnSync 跑 PowerShell 拼 toast XML，
  外部文案（厂商返回的报错、账号昵称）拼进单引号字符串 ⇒ **命令注入**
  （PR #502 审核实测可执行任意命令）。现在所有反馈只走
  \`client.tui.showToast\`，且**插件不再 spawn 任何子进程**（唯一例外是
  MagiCrew 登录要拉起本机 Chrome 读 localStorage，见 magicrew-browser.mjs）。
- **不写任何宿主文件**：凭据只在内存（\`memoryCredentials\`）+ magpie 账号槽；
  诊断日志 \`DSH_HUB_DEBUG=1\` 才写，落点是**系统临时目录**。`,
)

// ⑤ §6 凭据双写 → 内存
s = s.replace(
  /- 凭据双写：magpie 账号槽（`client\.auth\.set`）\+ 旁路 sidecar（`saveCredential`）\n- OfficeAce 的 refresh_token 一次性（STS5\.1806）：STS 成功\*\*立即落盘\*\* \+\n  并发去重闸（refreshInFlight）—— 已消费的救不回，只能重登\n- \*\*凭据落盘的两条命门\*\*（真机 2026-10-29：OfficeAce 新 refresh_token 从未落盘 →\n  下次续期 STS5\.1806，卡片只会报 401 APIG\.0301）：\n  ① `saveCredential` \*\*拒绝下调\*\*：盘上凭据到期更晚就不覆盖（旧凭据回写不能吞掉\n     轮转出来的新 token）；写失败\*\*必须 console\.warn 并返回 false\*\*（不许静默）。\n  ② `writeSidecar` \*\*写盘成功才记 identity\*\*：否则这一次的新 refresh_token\n     再没有第二次落盘机会。/,
  `- **凭据只在两处**：magpie 账号槽（\`client.auth.set\` / \`getAuth\`）+ 本进程内存
  （\`memoryCredentials\`）。**没有旁路凭据文件**（v0.5.0 起，
  \`~/.config/magpie/<渠道>-credential.json\` 不再写 —— PR #502 审核第 2 条：
  那里默认 0644，本机任何用户可读）。
- 续期去重闸按**凭据身份**键控（\`channel + refresh_token|access_token\`）：
  同一凭据并发共享一次在途请求，多账号不串号。refresh_token 一次性的渠道
  消费后救不回，只能重登。`,
)

// ⑥ §7 标题与要点
s = s.replace(
  '## 7. 形态：一个插件，十个供应商（v0.4.0）',
  '## 7. 形态：一个插件，五条供应商（v0.5.0）',
)
s = s.replace(
  /0\.3\.x 是「一个 provider id `providers-hub` 内部聚合十渠道」。v0\.4\.0 拆成/,
  `0.3.x 是「一个 provider id \`providers-hub\` 内部聚合十渠道」。v0.4.0 拆成`,
)
s = s.replace(
  '- 目录返回**裸模型名**（`glm-5.3`），由 magpie 拼成 `hub-officeace/glm-5.3`；',
  '- 目录返回**裸模型名**（`spark-x`），由 magpie 拼成 `hub-astudio/spark-x`；',
)
s = s.replace(
  /`snapshotCache`（页面快照）、`sweepState`（5 分钟扫额度 \+ 旁路渠道补签）、\n  `checkinTally`（当日记账）、`migrationsStarted`（旧槽迁移只做一次）、\n  `selfRegistered`（市场缓存只注册一次）。/,
  `\`snapshotCache\`（页面快照）、\`sweepState\`（5 分钟扫额度 + 补签）、
  \`checkinTally\`（当日记账）、\`migrationsStarted\`（旧槽迁移只做一次）、
  \`memoryCredentials\`（本进程见过的凭据，不落盘）、\`authGetters\`（各实例的
  getAuth，供 sweep 冷启动取凭据）。`,
)
s = s.replace(
  /关掉。搬不动的旁路 sidecar 凭据照常供对话\/额度\/签到使用。/,
  '关掉。',
)

writeFileSync(p, s, 'utf8')
console.log('AGENTS.md:', before, '→', s.length, '字符')
