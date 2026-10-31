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

/**
 * 单栏「一次贴全」认的键名 → 内部字段名。
 *
 * 真机上「四栏并列」做不到（magpie 的登录表单一次只渲染一个 input，见
 * docs/AGENTS：宿主 nextPrompt/renderPluginAsk 的硬限制），退而求其次：
 * **第一栏贴什么都收**（裸 token / 整段 JSON / `access=… refresh_token=…`
 * 这种键值对 / 文件路径），贴全了后面几栏就自动跳过 —— 一屏填完。
 *
 * 键名照官方客户端导出 + OAuth 通用命名 + 中文备注，长键在前（access_token
 * 不能被 access 抢走）。
 */
const INLINE_FIELDS = {
  access_token: 'accessToken',
  accesstoken: 'accessToken',
  access: 'accessToken',
  token: 'accessToken',
  refresh_token: 'refreshToken',
  refreshtoken: 'refreshToken',
  refresh: 'refreshToken',
  user_id: 'userId',
  userid: 'userId',
  uid: 'userId',
  note: 'note',
  remark: 'note',
  label: 'note',
  备注: 'note',
}

/** 键值对里的分隔符：空格 / 换行 / & ; , |（粘进单行 input 后换行可能被吃掉，故不强求）。 */
function inlinePattern() {
  const keys = Object.keys(INLINE_FIELDS).sort((a, b) => b.length - a.length).join('|')
  return new RegExp('(' + keys + ')\\s*[=:]\\s*', 'gi')
}

/**
 * `access=… refresh_token=… uid=… note=…`（`:` 也行、`&`/逗号/分号/换行都行）→ 字段。
 * 值的终点 = 下一处键名的起点。看着不像键值对 → undefined（调用方当裸 token 处理）。
 */
function pairsFromText(text) {
  const re = inlinePattern()
  const marks = []
  let match
  while ((match = re.exec(text)) !== null) {
    const field = INLINE_FIELDS[String(match[1]).toLowerCase()]
    if (field === undefined) continue
    marks.push({ field, from: re.lastIndex, at: match.index })
    if (re.lastIndex === match.index) re.lastIndex += 1
  }
  if (marks.length === 0) return undefined
  const fields = {}
  marks.forEach((mark, index) => {
    const to = index + 1 < marks.length ? marks[index + 1].at : text.length
    const value = text.slice(mark.from, to)
      .replace(/^[\s;&,|]+/, '')
      .replace(/[\s;&,|]+$/, '')
      .replace(/^["'`]+/, '')
      .replace(/["'`]+$/, '')
      .trim()
    if (value !== '' && fields[mark.field] === undefined) fields[mark.field] = value
  })
  return Object.keys(fields).length > 0 ? fields : undefined
}

/** 一行账号对象 → 只挑「导入栏里问的那四样」（JSON 里别的字段不管）。 */
function fieldsOfRow(row) {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = textOf(row?.[key])
      if (value !== undefined) return value
    }
    return undefined
  }
  const accessToken = pick('access_token', 'accessToken', 'access', 'token', 'accessKey')
  const fields = {}
  if (accessToken !== undefined) fields.accessToken = accessToken
  const refreshToken = pick('refresh_token', 'refreshToken', 'refresh')
  if (refreshToken !== undefined) fields.refreshToken = refreshToken
  const userId = pick('user_id', 'userId', 'uid')
    ?? textOf(jwtClaims(accessToken)?.uid) ?? textOf(jwtClaims(accessToken)?.user_id)
  if (userId !== undefined) fields.userId = userId
  const note = pick('note', 'remark', 'label', '备注')
  if (note !== undefined) fields.note = note
  return fields
}

/**
 * 一栏里贴进来的东西 → 能认出哪些字段（纯解析，不碰文件系统：路径由聚合层读）。
 *
 * @param {string} text
 * @returns {{accessToken?: string, refreshToken?: string, userId?: string, note?: string, json?: string, rows?: number}}
 *   `json` 有值 = 这段文本本身就是账号 JSON（`rows` 是里面认出的账号数）。
 */
export function inlineFieldsOf(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return {}
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let rows
    try {
      rows = rowsFromJson(raw)
    } catch {
      rows = []
    }
    if (rows.length === 0) return {}
    return { ...fieldsOfRow(rows[0]), json: raw, rows: rows.length }
  }
  return pairsFromText(raw) ?? {}
}

/**
 * 一栏里的文本看着像**账号文件**吗（而不是 token）。
 *
 * `file:///…` / 带目录分隔符 / `.json` `.jsonl` `.txt` 结尾 → 当文件；
 * JSON 本身不算（先认 `{` `[`）。JWT 里没有 `/` `\\`，也不会以 .json 结尾，
 * 不会误判成路径。
 *
 * 两处共用：聚合层决定「要不要读盘」，prompts 的 `condition` 决定「后面几栏还问不问」
 * —— 贴的是文件时文件里什么都有，不必再一栏栏补问（否则真机上贴路径还要被问三题）。
 */
export function looksLikeImportFile(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return false
  if (raw.startsWith('{') || raw.startsWith('[')) return false
  return /^file:/i.test(raw) || /[/\\]/.test(raw) || /\.(json|jsonl|txt)$/i.test(raw)
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
  const box = textOf(fields.accessToken) ?? textOf(fields.access_token) ?? ''
  // 另外几栏（手动导入的第二~四栏）；一栏贴全时它们通常是空的
  const explicit = {
    accessToken: textOf(fields.accessToken) ?? textOf(fields.access_token),
    refreshToken: textOf(fields.refreshToken) ?? textOf(fields.refresh_token),
    userId: textOf(fields.userId) ?? textOf(fields.user_id),
    note: textOf(fields.note) ?? textOf(fields.remark),
  }
  const rows = []
  const pastedJson = textOf(fields.text)
  if (payload?.mode === 'file' || pastedJson !== undefined) {
    // 文件导入（文件内容 / 直接粘的 JSON）
    if (pastedJson === undefined) throw new Error('没有收到账号 JSON')
    rows.push(...rowsFromJson(pastedJson))
  } else {
    // 手动导入：第一栏可能是 裸 token / 整段 JSON / `access=… refresh=…` 键值对
    const inline = inlineFieldsOf(box)
    if (typeof inline.json === 'string') rows.push(...rowsFromJson(inline.json))
    else rows.push({
      access_token: inline.accessToken ?? box,
      refresh_token: inline.refreshToken ?? '',
      user_id: inline.userId ?? '',
      note: inline.note ?? '',
    })
  }
  // 手填的那几栏盖过 JSON：单账号时才算得清（一个文件里多个账号时不猜给谁）
  if (rows.length === 1) {
    const row = rows[0]
    // ⚠️ access_token 不在这里：手动页的第一栏就是 accessToken/JSON/路径本身，
    //    拿它当「手填覆盖」会把整段文本写进 token（真机踩过）。
    const override = {
      refresh_token: explicit.refreshToken,
      user_id: explicit.userId,
      note: explicit.note,
    }
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined && value !== '') row[key] = value
    }
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
   * 顺序：凭据（什么都收）→ user_id → refresh → 备注，后三栏各带 condition。
   *
   * ⚠️ refresh_token 故意**不做硬必填**：
   *    真机上「只有 access_token」的账号正是最需要导进来的那批（客户端登录态还在、
   *    refresh 已被别的地方消费）；要求必填等于把能用的账号挡在门外。缺它时
   *    导入照常进行，只提示「到期要重新导入」（见 aggregate 的 warning）。
   */
  // ⚠️ 一栏贴全：第一栏就是「全都能贴」，并且它**必须排在最前** ——
  //    magpie 的登录表单一次只渲染一个问题（宿主 renderPluginAsk 的硬限制，
  //    四栏并列做不到），所以「一屏填完」只能靠第一栏把四样都吃下；
  //    后面三栏用 condition 按「第一栏里有没有」决定问不问。
  //    贴的 JSON 里带了 user_id/refresh/备注 → 那几栏自动跳过；
  //    贴的是**文件路径**（或拖进来的文件名）→ 文件里什么都有，三栏全跳过。
  const hasInline = (inputs, field) => inlineFieldsOf(inputs?.token)?.[field] !== undefined
  const skipWhenInline = (field) => (inputs) => {
    const box = inputs?.token
    if (looksLikeImportFile(box)) return false
    return !hasInline(inputs, field)
  }

  const manualPrompts = [
    {
      key: 'token',
      type: 'password',
      message: '凭据（必填）：accessToken / 整段账号 JSON / 账号文件路径，一次贴全就不再问后面几栏',
      placeholder: '粘贴 accessToken，或整段 {"access_token":…}，或 C:\\…\\lobsterai-1.json',
      validate: (value) => (
        typeof value === 'string' && value.trim() !== ''
          ? null
          : '请粘贴 accessToken（也可以整段账号 JSON、或账号文件路径）'
      ),
    },
    {
      key: 'userId',
      type: 'text',
      message: 'USER ID（可选，留空自动从 token 里识别）',
      placeholder: '数字 user_id',
      // 上面那一栏已经贴了 user_id（JSON / uid=…）→ 不再问
      condition: skipWhenInline('userId'),
    },
    {
      key: 'refreshToken',
      type: 'password',
      message: 'REFRESH_TOKEN（可选，建议填写：用来续期；只有 access 也能导入，到期要重新导入）',
      placeholder: '粘贴 refreshToken',
      condition: skipWhenInline('refreshToken'),
    },
    {
      key: 'note',
      type: 'text',
      message: '备注（可选，留空 = 用上游昵称；填了就是账号列表里显示的名字）',
      placeholder: '例如：手机小号 A',
      condition: skipWhenInline('note'),
    },
  ]

  return {
    manualLabel: '手动导入（粘贴凭据）',
    fileLabel: '文件导入（账号 JSON）',
    manualHint: '一栏贴全：第一栏贴 accessToken，或整段账号 JSON，或账号文件路径（拖文件进那一栏也行）；贴全了就不再问 user_id / refresh_token / 备注，缺哪样才问哪样。',
    fileHint: '账号 JSON 的文件路径（支持 file:///、带引号、~、裸文件名）或直接粘贴 JSON（单对象 / 数组 / {accounts:[…]} / JSONL 都可）。',
    // 一栏里的文本像不像文件 —— 聚合层用它决定「读盘还是当 token」。
    // 声明归渠道（聚合层不猜别的渠道的导入长什么样），与 prompts 的 condition 同源。
    looksLikeFile: looksLikeImportFile,
    manualPrompts,
    submit,
    parse: parseImportPayload,
    accountIdOf,
    verify,
  }
}
