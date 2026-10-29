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
| `child_process` 用途 | ① Windows 通知（spawnSync PowerShell/WinRT）② AutoClaw 桌面端凭据探测（execFileSync）③ MagiCrew 浏览器登录（spawn Chrome）—— **仅在登录/通知时，加载时不跑** |
| 凭据落点 | `~/.config/magpie/<channel>-credential.json`（本插件自己的旁路文件），**不碰 magpie 的账号槽文件** |
| 只读引用 | `~/.cache/magpie/models.json`（magpie 的模型缓存，只读，作目录兜底） |

## 一、提交方式（不用手动 fork）

1. 打开 https://github.com/magpie-community/plugins/blob/main/registry.json
2. 右上角铅笔 **Edit**
3. 在 `plugins` 数组末尾（最后一个 `}` 前）粘下面这段
4. **Propose changes** → GitHub 会提示「你没有写权限，已为你创建 fork」→ 这就是自动 fork
5. 填标题/正文（下面有草稿）→ **Create pull request**

## 二、registry.json 要加的条目

```json
  ,
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

## 三、PR 标题与正文（直接复制）

**Title**

```
registry: add magpie-providers-hub (10 providers, third-party dsh-providers-hub adapter)
```

**Body**

```markdown
Adds a registry entry for [magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub),
a third-party Magpie adapter of [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub)
(MIT; attribution in README, UPSTREAM.md and NOTICE.md).

One package, ten providers — each channel is its own provider id (`hub-<channel>`), so
each can be signed in to, metered and switched off separately:

`hub-officeace` `hub-astudio` `hub-minimaxintl` `hub-accio` `hub-autoclaw`
`hub-autoclawintl` `hub-loomy` `hub-lobsterai` `hub-magicrew` `hub-magicrew-intl`

Review notes (the three things I expect to be asked):

1. **Provenance.** Port of iJetLi/dsh-providers-hub (MIT), credited in three places in the
   repo; no DSH dependency at runtime (`index.mjs` and `src/` import nothing but node:
   builtins and each other).
2. **Provider ids match the code.** `node -e "import('magpie-providers-hub').then(m =>
   console.log(Object.keys(m.HUB_PLUGINS)))"` prints the ten ids above. Ids are ASCII on
   purpose (they enter model ids, CLI arguments and `<provider>/<account>` slot keys).
3. **No host files are written.** This was the blocker on #399, so I removed it up front:
   the package never touches magpie's market cache. What used to be `src/self-register.mjs`
   now lives in `tools/` (a manual, opt-in script, excluded from `files`), and the MagiCrew
   browser-login temp profile moved out of `~/.cache/magpie` into the system temp dir.
   `tests/no-host-writes.test.mjs` asserts all three (no market-cache reference in the
   published code, `files` excludes `tools/` and `tests/`, and a load probe that checks the
   market cache file's mtime and content are unchanged).

Other things worth knowing:

- Credentials go to magpie's account slots and, as a sidecar, to
  `~/.config/magpie/<channel>-credential.json`. No token is ever written to the sidebar
  page (it is sandboxed: `connect-src 'none'`, reads a snapshot only).
- `child_process` is used for Windows notifications, AutoClaw's desktop-credential probe
  and the MagiCrew browser sign-in — at sign-in/notify time only, never at load.
- npm: `magpie-providers-hub` (planned; the account is under npm's 72-hour security hold
  after a recovery-code event, publishing 2026-11-02 via `npm stage publish`).

Verification I ran: `npm test` (241 pass) with HOME redirected to a temp dir, and
`node tools/register-local.mjs` for the local card only.
```

## 四、PR 之后的验证

```bash
magpie plugin add magpie-providers-hub     # 按包名装得上
# 发现页搜 Providers Hub → 绿标「magpie 社区」+ 十个 provider 的「承载 …」
```

⚠️ `scripts/new-to-npm.sh` 会把「npm 上还没有的包」标出来，但 `pr.yml` 的注释写明
**不阻断合并**（`@magpie-community/*` 从 dist 分支装）。我们是非 scope 包名，
所以 npm 发布仍要尽快落地 —— 否则用户点了「安装」会装不到。
