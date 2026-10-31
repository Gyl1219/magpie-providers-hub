// LobsterAI（有道龙虾）账号导入：解析官方客户端导出的账号 JSON / 手动粘贴的 token。
//
// ## 为什么需要它
//
// magpie 走网页登录 = 第三方反向代理，上游会风控（实测 code 40302：「账号暂时
// 无法使用相关服务…勿通过第三方反向代理或插件转接」）。而官方客户端导出的账号
// JSON 本身是合法凭据 —— 让用户把自己手上的 token 直接贴进来，比每次走网页登录
// 更稳，也能一次导入多个小号。
//
// ## 字段真相（官方客户端导出，2026-10 实测）
//
//   { user_id: 151290, uid: 151290, nickname: '170****7196',
//     yid: 'urs-phoneyd….@163.com', access_token: 'eyJ…', refresh_token: 'eyJ…',
//     expires_at: 1796051474, account_mode: 'personal' }
//
//   ⚠️ expires_at 是**秒**，本渠道 expired() 只认**毫秒** → 必须换算。
//   ⚠️ 键名不统一：user_id / uid 同时存在且可能只有其一；accessToken 这种 camel
//      形态也有（别只认一种）；数组 / {accounts:[…]} / JSONL 都要能读。
//
// ## 分层
//
// 本模块只管「文本 → 凭据」的纯逻辑 + 账号展示名；联网校验由渠道注入
// （createImporter 的 verify），这样纯函数可以单测、也不把 fetch 形状写死。

/** 非空字符串（数字也转字符串：user_id 常是 number）。 */
function textOf(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** 秒/毫秒都认 → 毫秒（本渠道 expired() 只认毫秒）。 */
function toEpochMs(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? n : n * 1000
}

/** 从各种到期键里取毫秒：ISO / 空格时间 / 秒 / 毫秒 / expires_in 全认。 */
function expiryOfRow(row) {
  // expiry / expiration 是别的导出工具（OAuth 通用命名）会用的键 —— 用户从别处
  // 抄来的 JSON 里常见，认了不吃亏（实测官方客户端只用 expires_at）。
  const keys = ['expires_at', 'expiresAt', 'expire_at', 'expires', 'expired_at', 'expiry', 'expiration']
  for (const key of keys) {
    const raw = row?.[key]
    if (typeof raw === 'string' && /[-T:]/.test(raw)) {
      const parsed = Date.parse(raw.replace(' ', 'T'))
      if (Number.isFinite(parsed)) return parsed
    }
    const ms = toEpochMs(raw)
    if (ms !== undefined) return ms
  }
  const seconds = Number(row?.expires_in ?? row?.expiresIn)
  if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000
  return undefined
}

/** JWT 载荷（只读 payload 段；解不开就当普通字符串 token）。 */
function jwtClaims(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json)
    return typeof claims === 'object' && claims !== null ? claims : undefined
  } catch {
    return undefined
  }
}

/** 一行账号对象 → 本渠道凭据（字段缺失返回 error，由调用方汇总成提示）。 */
function credentialFromRow(row) {
  const access = textOf(row?.access_token) ?? textOf(row?.accessToken)
    ?? textOf(row?.access) ?? textOf(row?.token) ?? textOf(row?.accessKey)
  if (access === undefined) return { error: '缺少 access_token' }
  if (access.length < 20) return { error: 'access_token 太短，看起来不是真 token' }
  const refresh = textOf(row?.refresh_token) ?? textOf(row?.refreshToken) ?? textOf(row?.refresh)
  const claims = jwtClaims(access)
  const uid = textOf(row?.uid) ?? textOf(row?.union_id)
  const userId = textOf(row?.user_id) ?? textOf(row?.userId)
    ?? textOf(claims?.uid) ?? textOf(claims?.user_id)
  const credential = { access_token: access }
  if (refresh !== undefined) credential.refresh_token = refresh
  const expires = expiryOfRow(row) ?? toEpochMs(claims?.exp)
  // ⚠️ 统一存**毫秒字符串**（与渠道 toCredential 的口径一致；秒会被当毫秒读成 1970）
  if (expires !== undefined) credential.expires_at = String(Math.round(expires))
  if (uid !== undefined) credential.uid = uid
  if (userId !== undefined) {
    credential.user_id = userId
    if (credential.uid === undefined) credential.uid = userId
  }
  const nickname = textOf(row?.nickname) ?? textOf(row?.nickName) ?? textOf(row?.displayName)
  if (nickname !== undefined) credential.nickname = nickname
  const yid = textOf(row?.yid)
  if (yid !== undefined) credential.yid = yid
  const note = textOf(row?.note) ?? textOf(row?.remark) ?? textOf(row?.label)
  if (note !== undefined) credential.note = note
  return { credential }
}

/** JSON 文本 → 账号对象数组（单对象 / 数组 / {accounts:[…]} / JSONL 全认）。 */
function rowsFromJson(text) {
  const rows = []
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const key of ['accounts', 'account', 'data', 'list', 'items', 'credentials']) {
      const inner = value[key]
      if (Array.isArray(inner)) {
        for (const item of inner) collect(item)
        return
      }
      if (typeof inner === 'object' && inner !== null && inner !== value) {
        // {data:{account:{…}}} 与 {data:{access_token…}} 两种形态都收
        collect(inner)
        return
      }
    }
    rows.push(value)
  }
  const whole = (() => { try { return JSON.parse(text) } catch { return undefined } })()
  if (whole !== undefined) {
    collect(whole)
    if (rows.length > 0) return rows
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length > 1) {
    let index = 0
    for (const line of lines) {
      index += 1
      let one
      try {
        one = JSON.parse(line)
      } catch {
        throw new Error('第 ' + index + ' 行不是合法 JSON：' + line.slice(0, 40))
      }
      collect(one)
    }
    if (rows.length > 0) return rows
  }
  return rows
}

/**
 * 页面提交 → 凭据数组。
 *
 * @param {{mode?: string, fields?: Record<string, string>}} payload
 * @returns {{accounts: object[], warnings: string[]}}
 */
export function parseImportPayload(payload = {}) {
  const fields = typeof payload?.fields === 'object' && payload?.fields !== null ? payload.fields : {}
  const warnings = []
  const accessField = textOf(fields.accessToken) ?? textOf(fields.access_token) ?? ''
  const rows = []
  const looksLikeJson = accessField.startsWith('{') || accessField.startsWith('[')
  if (payload?.mode === 'file' || looksLikeJson) {
    // 文件导入；或手动页里直接粘了整段 JSON（同一个解析器）
    const text = textOf(fields.text) ?? (looksLikeJson ? accessField : undefined)
    if (text === undefined) throw new Error('没有收到账号 JSON')
    rows.push(...rowsFromJson(text))
  } else {
    rows.push({
      access_token: accessField,
      refresh_token: textOf(fields.refreshToken) ?? textOf(fields.refresh_token) ?? '',
      user_id: textOf(fields.userId) ?? textOf(fields.user_id) ?? '',
      note: textOf(fields.note) ?? textOf(fields.remark) ?? '',
    })
  }
  if (rows.length === 0) throw new Error('没有解析出任何账号（JSON 里没有账号对象？）')

  const accounts = []
  const seen = new Set()
  rows.forEach((row, index) => {
    const parsed = credentialFromRow(row)
    if (parsed.error !== undefined) {
      warnings.push('第 ' + (index + 1) + ' 个账号已跳过：' + parsed.error)
      return
    }
    const credential = parsed.credential
    if (seen.has(credential.access_token)) {
      warnings.push('第 ' + (index + 1) + ' 个账号已跳过：同一 access_token 重复')
      return
    }
    seen.add(credential.access_token)
    accounts.push(credential)
  })
  if (accounts.length === 0) throw new Error(warnings.join('；') || '没有可导入的账号')
  return { accounts, warnings }
}

/** 用 profile-summary 的返回补齐昵称/uid（导出文件里的 nickname 可能被打码得更狠）。 */
function mergeProfileInto(credential, data) {
  const user = typeof data?.userInfo === 'object' && data.userInfo !== null ? data.userInfo : {}
  const nickname = textOf(data?.nickname) ?? textOf(data?.userName) ?? textOf(data?.nickName)
    ?? textOf(user.nickname) ?? textOf(user.userName)
  if (nickname !== undefined && textOf(credential.nickname) === undefined) credential.nickname = nickname
  const uid = textOf(data?.uid) ?? textOf(user.uid)
  if (uid !== undefined && textOf(credential.uid) === undefined) credential.uid = uid
  const userId = textOf(data?.userId) ?? textOf(data?.user_id) ?? textOf(user.userId)
  if (userId !== undefined && textOf(credential.user_id) === undefined) credential.user_id = userId
}

/**
 * 造一个渠道的导入器。
 *
 * @param {object} deps
 * @param {string} deps.displayName  账号兜底显示名
 * @param {(credential: object) => Promise<{ok: boolean, signedOut?: boolean, message?: string, data?: object}>} deps.verify
 */
export function createImporter({ displayName, verify } = {}) {
  const fallbackName = typeof displayName === 'string' && displayName.length > 0 ? displayName : '账号'

  /**
   * 账号卡片的展示名（= 账号槽的 accountId；重复导入认它）。
   *
   * ⚠️ 顺序：**用户填的备注** > 上游昵称 > yid > user_id > uid > 渠道名。
   *    备注排第一是刻意的：官方导出/接口给的昵称要么打码（`170****7196`）、
   *    要么是一串手机号，两个小号根本分不清；用户手写的「手机小号 A」才是他
   *    在 magpie 账号列表里想看到的东西。
   *    重复导入时不会因此改名 —— aggregate 的 importAccountId 让旧槽的
   *    accountId 优先（按 token 命中），只更新内容不换行。
   */
  const accountIdOf = (credential) => textOf(credential?.note) ?? textOf(credential?.nickname) ?? textOf(credential?.yid)
    ?? textOf(credential?.user_id) ?? textOf(credential?.uid) ?? fallbackName

  /**
   * 页面 onSubmit：解析 +（可选）校验 → {accounts, warnings}。
   * 抛错 = 页面显示红字且窗口不关（用户改完还能再点一次导入）。
   */
  const submit = async (payload = {}) => {
    const parsed = parseImportPayload(payload)
    const warnings = [...parsed.warnings]
    if (payload?.verify === false || typeof verify !== 'function') {
      return { accounts: parsed.accounts, warnings }
    }
    const accepted = []
    for (const credential of parsed.accounts) {
      let outcome
      try {
        outcome = await verify(credential)
      } catch (error) {
        outcome = { ok: false, signedOut: false, message: error instanceof Error ? error.message : String(error) }
      }
      const label = accountIdOf(credential)
      if (outcome?.ok) {
        mergeProfileInto(credential, outcome.data)
        accepted.push(credential)
        continue
      }
      if (outcome?.signedOut) {
        warnings.push(label + '：token 无效（' + (outcome.message ?? '未知原因') + '），已跳过')
        continue
      }
      // 风控 / 断网 ≠ token 无效：只提示，不拦（40302 期间目录和额度也是同一个错）
      warnings.push(label + '：未能联网校验（' + (outcome?.message ?? '未知原因') + '），已按原样导入')
      accepted.push(credential)
    }
    if (accepted.length === 0) throw new Error(warnings.join('；') || '没有可导入的账号')
    return { accounts: accepted, warnings }
  }

  /**
   * 手动导入的四个栏位（magpie 原生表单逐题问的就是这些）。
   *
   * 只放**声明**（文案/占位/校验），不放问的顺序 —— 宿主按数组顺序问。
   * 顺序照官方客户端导出文件里的字段排：user_id → access → refresh → 备注。
   *
   * ⚠️ refresh_token 故意**不做硬必填**：
   *    真机上「只有 access_token」的账号正是最需要导进来的那批（客户端登录态还在、
   *    refresh 已被别的地方消费）；要求必填等于把能用的账号挡在门外。缺它时
   *    导入照常进行，只提示「到期要重新导入」（见 aggregate 的 warning）。
   */
  const manualPrompts = [
    {
      key: 'userId',
      type: 'text',
      message: 'USER ID（可选，留空自动从 token 里识别）',
      placeholder: '数字 user_id',
    },
    {
      key: 'token',
      type: 'password',
      message: 'ACCESS_TOKEN（必填）',
      placeholder: '粘贴 accessToken',
      validate: (value) => (
        typeof value === 'string' && value.trim() !== ''
          ? null
          : '请粘贴 accessToken（也可以直接把整段账号 JSON 粘进来）'
      ),
    },
    {
      key: 'refreshToken',
      type: 'password',
      message: 'REFRESH_TOKEN（可选，建议填写：用来续期；只有 access 也能导入，到期要重新导入）',
      placeholder: '粘贴 refreshToken',
    },
    {
      key: 'note',
      type: 'text',
      message: '备注（可选，留空 = 用上游昵称；填了就是账号列表里显示的名字）',
      placeholder: '例如：手机小号 A',
    },
  ]

  return {
    manualLabel: '手动导入（粘贴凭据）',
    fileLabel: '文件导入（账号 JSON）',
    manualHint: '四个栏位：user_id（留空自动识别）/ access_token（必填）/ refresh_token（建议填，用来续期）/ 备注；ACCESS_TOKEN 那一栏也可以直接把整段账号 JSON（lobsterai-1.json）粘进来。',
    fileHint: '选择官方客户端导出的账号 JSON（单对象 / 数组 / {accounts:[…]} / JSONL 都可）。',
    manualPrompts,
    submit,
    parse: parseImportPayload,
    accountIdOf,
    verify,
  }
}
