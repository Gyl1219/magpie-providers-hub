# PUBLISH.md — npm 发包与社区 registry 上架清单

> 目标：让本插件获得 MYCF711/officeace-auth 同款的「magpie 社区」待遇 ——
> 市场卡片无黄框、副标题 `magpie 社区 · magpie-providers-hub`、可按包名安装。
> 三件事：npm 发包 → registry.json 提 PR → 发版纪律。
> （GitHub 的 `magpie-plugin` 话题标签只是被巡检器**搜到**，不是上架 ——
> 搜到的卡片带黄色「未审阅」警示框，读的还是抓取时点的旧 description。）

## 前置事实（2026-10-29 核过）

- npm 名 `magpie-providers-hub` **未被占用**（npmmirror 与 npmjs 同名查询均 FREE）。
- `npm pack --dry-run`：23 个文件 / 170.8 kB / 解包 508.7 kB；`files` 白名单已把
  `tests/` 排除；无凭据文件（凭据只在用户机器的 `~/.config/magpie/`）。
- registry.json 的收录格式照抄 `officeace-auth` 条目：`package` / `name` /
  `providers[]` / `community: true` / `summary{en,zh}`。
- magpie 拉包链：npm（npmmirror 镜像）→ 社区仓库 dist 分支兜底
  （`plugin update` 里那串 `@magpie-community/* 404` 就是这条链在报别的包缺 dist）。

## 一、npm 发包（人工两步，机器不碰账号）

```bash
npm login                # 浏览器授权（或 npm config set //registry.npmjs.org/:_authToken=<TOKEN>）
npm publish              # 包名 FREE 已核过；首版不带 --access public（非 scope 包默认公开）
npm view magpie-providers-hub version   # 发完验证
```

- ⚠️ 用 **npmjs 官方源**发（npmmirror 是只读镜像，会自动同步，约几分钟到几小时）。
- ⚠️ 发包用的是 `package.json` 的 `files` 白名单 —— 改了 `files` 里的目录先跑
  `npm pack --dry-run` 核对清单再发。**绝不**把 `tests/`、`.msg-*.txt`、本地凭据发上去。
- 发错版本的补救：npm 的 deprecate/unpublish 政策严格（24h 内可 unpublish 一次），
  所以**先 0.4.1 试一发**，确认市场里显示正常，再继续常规发版。

## 二、registry.json 提 PR

仓库：<https://github.com/magpie-community/plugins>（`registry.json` 在 main 分支根目录）。
Fork → 在 `plugins` 数组里、按现有条目的字段顺序追加：

```json
{
  "package": "magpie-providers-hub",
  "name": "Providers Hub",
  "providers": [
    "hub-officeace",
    "hub-astudio",
    "hub-minimaxintl",
    "hub-accio",
    "hub-autoclaw",
    "hub-autoclawintl",
    "hub-loomy",
    "hub-lobsterai",
    "hub-magicrew",
    "hub-magicrew-intl"
  ],
  "community": true,
  "summary": {
    "en": "Third-party Magpie adapter for dsh-providers-hub (by JetLi): one plugin with 10 providers, each a separate channel you can sign in to, meter and switch off on its own — OfficeAce, AStudio, MiniMax Code Intl, Accio, AutoClaw CN/Intl, Loomy, LobsterAI, Magicrew CN/Intl. Runs without DSH.",
    "zh": "dsh-providers-hub（作者 JetLi）的第三方适配：一个插件注册十个供应商（每个渠道一条，可各自登录/看额度/单独关闭）——OfficeAce（华为云）、AStudio（讯飞）、MiniMax Code 国际版、Accio（阿里）、AutoClaw 国内/国际（智谱）、Loomy（讯飞）、LobsterAI（有道）、超级麦吉/MagiCrew（国内+国际），不依赖 DSH 运行。"
  }
}
```

PR 说明里要交代的三件事（审阅者会问）：
1. **归属**：适配自 iJetLi/dsh-providers-hub（JetLi），MIT，仓库 README/UPSTREAM/NOTICE 三处声明；
2. **provider id**：`hub-<渠道 id>` 十个 id 与 npm 包内 `index.mjs` 的导出一一对应（可 `node -e "import('magpie-providers-hub').then(m=>console.log(Object.keys(m.HUB_PLUGINS)))"` 验）；
3. **无凭据外发**：凭据只落本机 `~/.config/magpie/`，页面沙盒只读快照（CSP `connect-src 'none'`）。

PR 文案草稿：

> Title: registry: add magpie-providers-hub (10 providers, third-party dsh-providers-hub adapter)
>
> Adds magpie-providers-hub (Gyl1219), a third-party Magpie adapter of
> iJetLi/dsh-providers-hub with 10 per-channel providers (`hub-*`). MIT.
> npm package published and verified: `npm view magpie-providers-hub`.
> Summary text mirrors the package description (en/zh). Field order follows
> the existing officeace-auth entry. No middleware kind; auth-methods only.

## 三、发版纪律（每次都要）

1. `npm version patch|minor|major`（改 package.json + 打 tag 一步到位）；
2. `npm test` 全绿；
3. `git push --follow-tags`（GitHub 源的用户 `magpie plugin update` 跟 commit 走）;
4. `npm publish`（npm 源的用户 `magpie plugin update` 跟版本走）;
5. registry.json 的字段**只加不改名**：provider id 一旦进 registry 就当作已发布
   id —— 改名等于让所有人的登录态掉线（与 AGENTS.md 第 6 条同源）。

## 三之一、审核红线：包里不能写 magpie 的宿主文件（2026-10-30 取证）

社区 PR 审核卡这一条（MYCF711 的 `officeace-auth` #399 在 10-27 被 block 的原话）：

> blocked it on `src/self-register.mjs` … which rewrote magpie's
> `~/.cache/magpie/plugin-market.json` on every load. … grep: **no fs writes,
> child_process, eval or HOME/cache paths**.

本仓库的对应处置：

- `src/self-register.mjs` → **`tools/self-register.mjs`**（`files` 白名单不含 `tools`，
  不随 npm 发布）；本机想让卡片提前显示就手工跑 `node tools/register-local.mjs`；
- MagiCrew 浏览器登录的一次性 profile 从 `~/.cache/magpie` 挪到系统临时目录；
- 回归网：`tests/no-host-writes.test.mjs`（源码扫描 + **加载探针**：市场缓存
  mtime/内容必须零变化）。

## 三之二、本地自注册为什么之前没留住（黄标根因，2026-10-30 取证）

`src/self-register.mjs` 会把本插件写进 `~/.cache/magpie/plugin-market.json`
（卡片标题 / 源码按钮 / 「承载 …」的来源）。但真机观测：

```
05:32:59  [providers-hub] 已注册 新增 1（共 61 条，这是第 1 次写入）
05:33:29  plugin-market.json  mtime 变了 —— 内容回到 60 条官方条目，我们那条没了
```

magpie 启动后**异步**去拉一次官方 registry（联网，快慢不定），拉到就**整体重写**
缓存 —— 插件在 100ms 写的那一条，几十秒后被冲掉，卡片退回 GitHub 话题发现的
「未审阅」黄标。

修法：**落盘时点改成有上限的一组补写** `FLUSH_SCHEDULE_MS = [100, 30s, 90s, 240s]`
（`src/self-register.mjs`）。合并是幂等的（条目已存在 → JSON 不变 → 不写盘），
四次之后彻底停下 —— 不是 fs.watch、不是轮询（那会自触发死循环）。

本机立刻见效的验证（不用等 PR）：

```bash
magpie plugin update
# 等 1 分钟（第二次补写在 30s）
node -e "const j=require(process.env.USERPROFILE+'/.cache/magpie/plugin-market.json');console.log(j.plugins.filter(p=>p.package==='magpie-providers-hub'))"
```

⚠️ 本地缓存只是**本机**的卡片显示；要所有人都看到，仍要走第二节的 registry PR。

## 四、验证「上架成功」

- `magpie plugin remove github:Gyl1219/magpie-providers-hub` 后
  `magpie plugin add magpie-providers-hub`（按包名装得上 = npm 线通）;
- 市场/插件卡片：副标题变 `magpie 社区 · magpie-providers-hub`、黄框消失、
  summary 与 registry 一致（不再是抓取时点的旧文案）；
- 两条线都通后，`github:` spec 与 npm 包名可并存（同一仓库两个入口）。
