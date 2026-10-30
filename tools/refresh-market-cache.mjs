// 手动把官方 registry 合并进本地市场缓存（模拟 magpie 启动时的拉取）
// 用途：magpie 启动时那次网络请求失败时，本地缓存会停在旧版本（我们的条目就会"消失"）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const REGISTRY_URL = 'https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json'
const cacheDir = join(homedir(), '.cache', 'magpie')
const marketPath = join(cacheDir, 'plugin-market.json')

const main = async () => {
  // 1) 拉官方 registry（走 GitHub API：raw.githubusercontent 常被墙）
  const token = process.env.GH_TOKEN
  const apiUrl = 'https://api.github.com/repos/magpie-community/plugins/contents/registry.json?ref=main'
  const res = await fetch(apiUrl, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/vnd.github+json',
      'User-Agent': 'providers-hub',
    },
  })
  if (!res.ok) throw new Error(`拉取失败 HTTP ${res.status}`)
  const json = await res.json()
  const text = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf8')
  const official = JSON.parse(text)
  if (!Array.isArray(official.plugins)) throw new Error('官方 registry 结构异常')

  console.log('官方 registry 条目数:', official.plugins.length)
  const mine = official.plugins.find((p) => p.package === 'magpie-providers-hub')
  console.log('含 magpie-providers-hub:', mine ? `是（providers=${mine.providers.length}）` : '否')

  // 2) 备份旧缓存
  if (existsSync(marketPath)) {
    const bak = `${marketPath}.bak-${Date.now()}`
    writeFileSync(bak, readFileSync(marketPath))
    console.log('旧缓存已备份到:', bak)
  }

  // 3) 写入（保持 magpie 的 {version, plugins} 形状）
  mkdirSync(cacheDir, { recursive: true })
  const out = { version: official.version ?? 1, plugins: official.plugins }
  writeFileSync(marketPath, JSON.stringify(out, null, 2), 'utf8')

  const after = JSON.parse(readFileSync(marketPath, 'utf8'))
  const m2 = after.plugins.find((p) => p.package === 'magpie-providers-hub')
  console.log('写入后条目数:', after.plugins.length)
  console.log('我们的条目:', m2 ? `在，providers=${m2.providers.length}，community=${m2.community}` : '不在')
  console.log('缓存路径:', marketPath)
}

await main()
