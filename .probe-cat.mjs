import { officeaceChannel } from './src/officeace.mjs'
import { loadCredential } from './src/shared.mjs'

const cred = loadCredential('officeace')
const models = await officeaceChannel.catalog(cred)
// 打印可疑别名的完整定义，看有没有状态字段被我们丢了
for (const id of ['glm-5.3-flash', 'glm-5.3', 'glm-5.3-test', 'glm-5.2-zx', 'openpangu-2.0-flash']) {
  console.log(id, '→', JSON.stringify(models[id] ?? '(不在目录)'))
}
process.exit(0)
