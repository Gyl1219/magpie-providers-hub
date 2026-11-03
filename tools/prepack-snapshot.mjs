// prepack：把 page/snapshot.js 强制还原成占位 —— 防本机实时快照进 tarball。
// #502 出过一次（华为云 IAM AK 泄进 0.5.0），#652 评审又抓到一次（0.7.1 带了
// 全部 11 渠道的余额/登录态）。npm 在 pack/publish 前都会跑 prepack。
import { copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const placeholder = join(here, '..', 'page', 'snapshot.placeholder.js')
const target = join(here, '..', 'page', 'snapshot.js')
copyFileSync(placeholder, target)
console.log('[prepack] page/snapshot.js → placeholder（防泄露）')
