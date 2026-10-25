// 各渠道共享的小工具：凭据落盘、信封解析。
//
// 每个渠道一份凭据文件，互不干扰。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * 凭据目录。⚠️ **惰性求值**（每次现取 homedir）：模块级常量会在首次 import
 * 时固化 —— 测试按用例切换 HOME 时会读到别的沙箱的凭据文件（状态泄漏）。
 */
const storeDir = () => join(homedir(), '.config', 'magpie')

export function credentialPath(name) {
  return join(storeDir(), `${name}-credential.json`)
}

export function loadCredential(name) {
  try {
    const p = credentialPath(name)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function saveCredential(name, credential) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(credentialPath(name), JSON.stringify(credential, null, 2), 'utf8')
  } catch {
    // 存不下不致命：本次会话仍可用，重启后重新登录。
  }
}

/**
 * 上游信封 `{code, message, data}`；`code === 0` 为成功。
 * 非 JSON 或 code 非 0 都抛出可读错误（不静默吞掉）。
 */
export async function parseEnvelope(response, what) {
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`${what} 响应不是 JSON（HTTP ${response.status}）`)
  }
  const code = typeof parsed?.code === 'number' ? parsed.code : NaN
  if (code !== 0) {
    throw new Error(`${what} 失败：${parsed?.message ?? `HTTP ${response.status}`}`)
  }
  return parsed?.data
}

/** 未登录错误：带 signIn 标记，让 magpie 提示重新登录而不是报普通错。 */
export function notSignedIn(message) {
  return Object.assign(new Error(message), { signIn: 'expired' })
}
