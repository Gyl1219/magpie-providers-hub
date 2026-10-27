// node --test 的全局预载（package.json 的 test script 用 --import 引入）：
// 把快照路径重定向到本进程的临时文件 —— 测试绝不写真实的 page/snapshot.js
//（真机事故：测试跑在沙箱 HOME 里把真实快照覆盖成「全部未登录」；
//  以及 magpie-bun 环境里 NODE_TEST_CONTEXT 有值导致生产快照被吞 ——
//  故不能用 NODE_TEST_CONTEXT 判断，必须显式重定向路径）。
//
// ⚠️ 必须在测试文件 import 聚合层之前生效 —— --import 保证这一点。
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HUB_SNAPSHOT_PATH = join(tmpdir(), `dsh-hub-snapshot-${process.pid}.js`)
