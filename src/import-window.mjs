// 导入窗口：插件自己起的**本地一次性页面**（127.0.0.1 + 一次性 nonce）。
//
// ## 为什么不用 magpie 的 `auth.methods[].prompts`
//
// 2026 实测（`magpie-wpt/plugin/paste.mjs` 头注）：**prompts 存不下来** ——
// 「那个字段在 magpie 的 provider 模型里存不下来（连官方插件的 prompts 都被
// 丢了），所以声明了也不会出现输入框」。要输入框只能自己起页面。
//
// ## 安全边界（对齐 paste.mjs，且比它更严）
//
// - 只监听 `127.0.0.1`，端口由内核分配（`listen(0)`）；
// - 一次性 nonce：POST 必须带 `x-import-nonce`，用 `timingSafeEqual` 比对；
// - 页面本身不含凭据，只把用户填的内容 POST 回本进程；
// - 默认 10 分钟没人提交就自动关闭（`unref` 的定时器，不驻留进程）；
// - 成功后立刻 `server.close()` —— 端口不常开。
//
// ⚠️ 不开子进程、不落盘：浏览器由 magpie 传下来的 `options.openBrowser` 拉起，
//    页面里的「选择文件」用的是浏览器 File API（文件内容在用户机器上读，
//    不会经过本插件以外的任何地方）。

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 单次提交的体积上限（账号 JSON 很小；防止误提交大文件把内存吃满）。 */
const MAX_BODY_BYTES = 256 * 1024

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/** 页面的静态骨架（nonce 在启动时替换进去；不含任何凭据）。 */
function renderPage({ title, subtitle, nonce }) {
  return "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>%TITLE%</title>\n<style>\n:root{color-scheme:dark}\n*{box-sizing:border-box}\nbody{margin:0;min-height:100vh;background:#0f1115;color:#e6e8ee;font:14px/1.5 \"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif}\n.wrap{max-width:560px;margin:0 auto;padding:28px 22px 40px}\nh1{margin:0 0 6px;font-size:19px;font-weight:650;letter-spacing:.2px}\n.sub{margin:0 0 18px;color:#8b93a7;font-size:12.5px;line-height:1.7}\n.tabs{display:flex;gap:6px;border-bottom:1px solid #23262f;margin-bottom:18px}\n.tabs button{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:#8b93a7;font-size:13.5px;padding:8px 12px;cursor:pointer}\n.tabs button.on{color:#fff;border-bottom-color:#b6f24a}\nlabel{display:block;margin:0 0 14px}\nlabel>span{display:block;margin-bottom:6px;color:#79839c;font-size:11.5px;letter-spacing:.8px;text-transform:uppercase}\ninput[type=text],textarea{width:100%;background:#171a21;border:1px solid #2a2f3b;border-radius:10px;color:#e6e8ee;padding:10px 12px;font:13px/1.5 ui-monospace,Consolas,monospace;outline:0}\ninput[type=text]:focus,textarea:focus{border-color:#b6f24a;box-shadow:0 0 0 3px rgba(182,242,74,.12)}\ntextarea{resize:vertical;min-height:44px}\n.chk{display:flex;align-items:center;gap:8px;color:#9aa3b8;font-size:12.5px;margin:0 0 16px}\n.chk input{accent-color:#b6f24a;width:14px;height:14px}\n#drop{border:1px dashed #333a49;border-radius:12px;padding:22px;text-align:center;color:#8b93a7;font-size:12.5px;margin-bottom:12px}\n#drop.hot{border-color:#b6f24a;background:rgba(182,242,74,.06);color:#dfe6d2}\n#drop button{appearance:none;border:0;background:none;color:#b6f24a;cursor:pointer;font:inherit;text-decoration:underline}\n.hint{margin:0 0 14px;color:#6e778c;font-size:11.5px}\n.row{display:flex;align-items:center;gap:12px;margin-top:4px}\n#go{appearance:none;border:0;border-radius:11px;background:#b6f24a;color:#0f1115;font:600 14px/1 inherit;padding:13px 26px;cursor:pointer}\n#go[disabled]{opacity:.55;cursor:progress}\n#state{color:#8b93a7;font-size:12.5px}\npre#log{margin:16px 0 0;padding:0;background:none;color:#9aa3b8;font:12px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}\npre#log .ok{color:#b6f24a}\npre#log .warn{color:#f5c451}\npre#log .err{color:#ff6b6b}\n.done{border:1px solid #2c3a24;background:rgba(182,242,74,.07);border-radius:12px;padding:14px 16px;margin-top:16px;color:#dfe6d2;font-size:13px}\n.hidden{display:none}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <h1>%TITLE%</h1>\n  <p class=\"sub\">%SUBTITLE%</p>\n  <nav class=\"tabs\">\n    <button type=\"button\" data-tab=\"manual\" class=\"on\">手动导入</button>\n    <button type=\"button\" data-tab=\"file\">文件导入</button>\n  </nav>\n  <section id=\"pane-manual\">\n    <label><span>User ID（可留空，自动从 token 识别）</span>\n      <input type=\"text\" id=\"m-uid\" placeholder=\"数字 userId\" autocomplete=\"off\" spellcheck=\"false\"></label>\n    <label><span>Access Token *</span>\n      <textarea id=\"m-access\" rows=\"3\" placeholder=\"粘贴 accessToken；也可以直接粘贴整段账号 JSON\" spellcheck=\"false\"></textarea></label>\n    <label><span>Refresh Token（可选）</span>\n      <textarea id=\"m-refresh\" rows=\"2\" placeholder=\"粘贴 refreshToken（可留空）\" spellcheck=\"false\"></textarea></label>\n    <label><span>备注（可选）</span>\n      <input type=\"text\" id=\"m-note\" placeholder=\"例如：手机小号 A\" autocomplete=\"off\"></label>\n    <div class=\"chk\"><input type=\"checkbox\" id=\"m-verify\" checked><label for=\"m-verify\" style=\"margin:0\">导入前联网校验 token（推荐）</label></div>\n  </section>\n  <section id=\"pane-file\" class=\"hidden\">\n    <div id=\"drop\">把导出的账号 JSON 拖到这里，或 <button type=\"button\" id=\"pick\">选择文件</button>\n      <input type=\"file\" id=\"fi\" accept=\".json,.jsonl,application/json,text/plain\" multiple hidden></div>\n    <label><span>文件内容（可编辑）</span>\n      <textarea id=\"f-text\" rows=\"7\" placeholder='{ \"user_id\": 151290, \"access_token\": \"eyJ…\", \"refresh_token\": \"eyJ…\", \"expires_at\": 1796051474 }' spellcheck=\"false\"></textarea></label>\n    <p class=\"hint\">支持单个对象、数组、{\"accounts\":[…]} 与 JSONL；<code>expires_at</code> 秒/毫秒都认，缺省则按 token 自带 exp 推算。</p>\n    <div class=\"chk\"><input type=\"checkbox\" id=\"f-verify\" checked><label for=\"f-verify\" style=\"margin:0\">导入前联网校验 token（推荐）</label></div>\n  </section>\n  <div class=\"row\"><button type=\"button\" id=\"go\">导入</button><span id=\"state\"></span></div>\n  <pre id=\"log\"></pre>\n</div>\n<script>\nvar NONCE = \"%NONCE%\";\nvar mode = \"manual\";\nvar $ = function (id) { return document.getElementById(id); };\nfunction setTab(next) {\n  mode = next;\n  var tabs = document.querySelectorAll(\".tabs button\");\n  for (var i = 0; i < tabs.length; i++) tabs[i].className = tabs[i].dataset.tab === next ? \"on\" : \"\";\n  $(\"pane-manual\").className = next === \"manual\" ? \"\" : \"hidden\";\n  $(\"pane-file\").className = next === \"file\" ? \"\" : \"hidden\";\n}\nfunction log(text, cls) {\n  var line = document.createElement(\"span\");\n  line.className = cls || \"\";\n  line.textContent = text + \"\\n\";\n  $(\"log\").appendChild(line);\n}\nfunction payload() {\n  if (mode === \"manual\") {\n    return { mode: \"manual\", verify: $(\"m-verify\").checked, fields: {\n      userId: $(\"m-uid\").value.trim(),\n      accessToken: $(\"m-access\").value.trim(),\n      refreshToken: $(\"m-refresh\").value.trim(),\n      note: $(\"m-note\").value.trim() } };\n  }\n  return { mode: \"file\", verify: $(\"f-verify\").checked, fields: { text: $(\"f-text\").value } };\n}\nasync function submit() {\n  $(\"go\").disabled = true;\n  $(\"state\").textContent = \"正在导入…\";\n  var body = payload();\n  if (mode === \"manual\" && body.fields.accessToken === \"\") { log(\"请先粘贴 access token\", \"err\"); $(\"go\").disabled = false; $(\"state\").textContent = \"\"; return; }\n  if (mode === \"file\" && body.fields.text.trim() === \"\") { log(\"请先选择或粘贴账号 JSON\", \"err\"); $(\"go\").disabled = false; $(\"state\").textContent = \"\"; return; }\n  try {\n    var res = await fetch(\"/submit\", { method: \"POST\", headers: { \"content-type\": \"application/json\", \"x-import-nonce\": NONCE }, body: JSON.stringify(body) });\n    var out = await res.json();\n    if (out && out.ok) {\n      $(\"state\").textContent = \"\";\n      var box = document.createElement(\"div\");\n      box.className = \"done\";\n      box.textContent = out.message || \"导入成功，可以关闭此页面。\";\n      $(\"log\").appendChild(box);\n      (out.warnings || []).forEach(function (w) { log(\"⚠ \" + w, \"warn\"); });\n      log(\"✓ 已写入 magpie 账号槽，可以关闭此页面。\", \"ok\");\n      $(\"go\").disabled = true;\n      return;\n    }\n    log(\"✗ \" + ((out && out.message) || \"导入失败\"), \"err\");\n  } catch (e) {\n    log(\"✗ 请求失败：\" + (e && e.message ? e.message : e), \"err\");\n  }\n  $(\"go\").disabled = false;\n  $(\"state\").textContent = \"可修改后重试\";\n}\nfunction readFile(file) {\n  if (!file) return;\n  var reader = new FileReader();\n  reader.onload = function () { $(\"f-text\").value = String(reader.result || \"\"); log(\"已读取 \" + file.name + \"（\" + file.size + \" 字节）\"); };\n  reader.onerror = function () { log(\"读取文件失败：\" + file.name, \"err\"); };\n  reader.readAsText(file);\n}\n(function wire() {\n  var tabs = document.querySelectorAll(\".tabs button\");\n  for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener(\"click\", function () { setTab(this.dataset.tab); });\n  $(\"go\").addEventListener(\"click\", submit);\n  $(\"pick\").addEventListener(\"click\", function () { $(\"fi\").click(); });\n  $(\"fi\").addEventListener(\"change\", function () { readFile(this.files && this.files[0]); });\n  var drop = $(\"drop\");\n  [\"dragenter\", \"dragover\"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.className = \"hot\"; }); });\n  [\"dragleave\", \"drop\"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.className = \"\"; }); });\n  drop.addEventListener(\"drop\", function (e) { readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });\n  setTab(\"manual\");\n})();\n</script>\n</body>\n</html>\n"
    .split('%NONCE%').join(nonce)
    .split('%TITLE%').join(title)
    .split('%SUBTITLE%').join(subtitle)
}

/**
 * 起一个一次性导入页面。
 *
 * @param {object} options
 * @param {string} options.title      页面标题（同时也是 GUI 卡片的说明来源）
 * @param {string} options.subtitle   页面副标题
 * @param {(payload: {mode?: string, verify?: boolean, fields?: Record<string, string>}) => Promise<{accounts: unknown[], warnings?: string[], message?: string}>} options.onSubmit
 *        解析 + 校验；返回账号列表（抛错 = 在页面上显示红色错误、页面继续可用）
 * @param {number} [options.timeoutMs]
 * @param {(url: string) => unknown} [options.opener]  magpie 的 openBrowser
 * @returns {Promise<{url: string, result: Promise<{ok: boolean, accounts?: unknown[], warnings?: string[], mode?: string, reason?: string, message?: string}>, close: () => boolean}>}
 */
export async function startImportWindow({
  title = '导入账号',
  subtitle = '',
  onSubmit,
  timeoutMs = 10 * 60 * 1000,
  opener,
} = {}) {
  if (typeof onSubmit !== 'function') throw new Error('startImportWindow 缺少 onSubmit')

  const nonce = randomBytes(18).toString('base64url')
  const page = renderPage({ title, subtitle, nonce })

  let settle
  const result = new Promise((resolve) => { settle = resolve })
  let finished = false
  let timer
  let server

  const finish = (value) => {
    if (finished) return false
    finished = true
    clearTimeout(timer)
    try { server?.close() } catch { /* 已关闭 */ }
    // 已经写出的响应要先送达浏览器：keep-alive 连接稍后再断（unref 定时器，不驻留进程）
    const reap = setTimeout(() => {
      try { server?.closeAllConnections?.() } catch { /* 老 Node 没有这个方法 */ }
    }, 500)
    reap.unref?.()
    settle(value)
    return true
  }

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('提交内容太大（上限 256 KiB）')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const authorized = (req) => {
    const given = Buffer.from(String(req.headers['x-import-nonce'] ?? ''), 'utf8')
    const want = Buffer.from(nonce, 'utf8')
    return given.length === want.length && timingSafeEqual(given, want)
  }

  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(page),
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
        })
        res.end(page)
        return
      }
      if (req.method === 'POST' && url.pathname === '/submit') {
        if (!authorized(req)) {
          sendJson(res, 403, { ok: false, message: '页面已过期（nonce 不匹配），请回到 magpie 重新点一次导入' })
          return
        }
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch (error) {
          sendJson(res, 400, { ok: false, message: `提交内容不是 JSON：${errorMessage(error)}` })
          return
        }
        try {
          const out = await onSubmit(payload ?? {})
          const accounts = Array.isArray(out?.accounts) ? out.accounts : []
          if (accounts.length === 0) throw new Error('没有解析出任何账号')
          const warnings = Array.isArray(out?.warnings) ? out.warnings.filter((w) => typeof w === 'string') : []
          sendJson(res, 200, {
            ok: true,
            message: out?.message ?? `已解析 ${accounts.length} 个账号`,
            warnings,
          })
          finish({ ok: true, accounts, warnings, mode: payload?.mode })
        } catch (error) {
          // 页面不关：用户改完可以重试
          sendJson(res, 400, { ok: false, message: errorMessage(error) })
        }
        return
      }
      sendJson(res, 404, { ok: false, message: 'not found' })
    })().catch((error) => {
      try { sendJson(res, 500, { ok: false, message: errorMessage(error) }) } catch { /* 头已发 */ }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(undefined)
    })
  })
  // ⚠️ 不驻留进程：测试进程跑完就能退出（生产里 magpie 常驻，无影响）
  server.unref?.()

  timer = setTimeout(() => {
    finish({ ok: false, reason: 'timeout', message: `等了 ${Math.round(timeoutMs / 60000)} 分钟没有提交，导入页面已关闭` })
  }, timeoutMs)
  timer.unref?.()

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}/`
  if (typeof opener === 'function') {
    try { void opener(url) } catch { /* 打不开浏览器也不致命：GUI 卡片上有链接 */ }
  }

  return {
    url,
    result,
    close: () => finish({ ok: false, reason: 'cancelled', message: '导入已取消' }),
  }
}
