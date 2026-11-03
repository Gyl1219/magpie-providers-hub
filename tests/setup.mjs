// node --test 的全局预载（package.json 的 test script 用 --import 引入）：
//
// 1. 把快照路径重定向到本进程的临时文件 —— 测试绝不写真实的 page/snapshot.js
//   （真机事故：测试跑在沙箱 HOME 里把真实快照覆盖成「全部未登录」；
//    以及 magpie-bun 环境里 NODE_TEST_CONTEXT 有值导致生产快照被吞 ——
//    故不能用 NODE_TEST_CONTEXT 判断，必须显式重定向路径）。
// 2. 把 HOME 指到临时目录 —— 凭据目录是 `~/.config/magpie/<渠道>-credential.json`，
//    不隔离的话测试会读到**本机真实凭据**，于是「未登录回落」类用例真的去请求上游
//    （实测每个死凭据要等 10s 超时），既慢又不稳定。
//
// ⚠️ 必须在测试文件 import 聚合层之前生效 —— --import 保证这一点。
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), `dsh-hub-home-${process.pid}`)
mkdirSync(join(sandbox, '.config', 'magpie'), { recursive: true })
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

process.env.DSH_HUB_SNAPSHOT_PATH = join(tmpdir(), `dsh-hub-snapshot-${process.pid}.js`)
process.env.DSH_HUB_AUTH_PATH = join(sandbox, '.config', 'magpie', 'plugin-auth.json')

// 重叠渠道开关：测试一律跑「默认态」（只注册不重叠的五条）。
// 本机若为了自己用设了 MAGPIE_HUB_EXTRA_CHANNELS，不能让测试结果跟着变；
// 开关文件也重定向到沙箱（不存在 = 默认态），真机的 providers-hub.json 不参与。
process.env.MAGPIE_HUB_EXTRA_CHANNELS = ''
process.env.DSH_HUB_SWITCH_PATH = join(sandbox, '.config', 'magpie', 'providers-hub.json')

// ── 网络哨兵：测试里出现未打桩的**外网**请求 → 立刻失败 ──────────────────
// （#652 评审：沙箱屏蔽网络时用例靠「连接失败也算过」蒙混，在联网机器上
//   会真的请求 astronstudio / lobsterai 等上游 —— 测试不许碰真实网络。）
// 放行 127.0.0.1 / localhost：magicrew 登录测试会起本地服务器自测，那是环内。
// 各测试文件用 stubFetch 替换 globalThis.fetch 时哨兵自然被绕开；restore 后
// 哨兵回归。谁漏打桩，谁的用户例就带着这句明确报错红掉。
const __realFetchForLoopback = globalThis.fetch
globalThis.fetch = (...args) => {
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? String(args[0]))
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) {
    return __realFetchForLoopback(...args)
  }
  throw new Error(`测试发起了未打桩的真实网络请求：${url} —— 请在该用例里 stub 这个地址`)
}
