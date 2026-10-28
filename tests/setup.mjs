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
