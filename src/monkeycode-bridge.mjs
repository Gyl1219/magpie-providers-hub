// MonkeyCode 的 OpenAI↔Anthropic 翻译桥。
//
// ## 来源与差异
//
// 从 v0.4.x 的 `minimax-bridge.mjs`（真机实测过、#502 时代审过的代码）适配而来，
// 协议语义逐条保留：
//
// - `system` 走顶层字段，不是 system 角色消息（Anthropic 不接受）；
// - **工具结果必须作为 user 消息里的 `tool_result` 块**，且与产生它的
//   assistant(tool_use) **成对提交** —— 逐条下发会产生连续 user 消息，上游 400；
// - 孤儿 tool_use / tool_result 都要剔除（服务端同样 400）；
// - 图片是 Anthropic `image` 块 + **裸 base64**（OpenAI 的 `image_url` 被明确拒绝）；
// - SSE 的 `signature_delta` 必须忽略（那是 thinking 块签名，不是正文）；
// - 空名 `tool_use` 整块丢弃，且上游报 `tool_use` 却无可执行调用时按 `length` 收尾。
//
// 与 minimax 版的三处差异（MonkeyCode 实测，见 _monkey-src 参考）：
// 1. **`max_tokens` 必填**且默认 4096（Anthropic 协议要求；缺它 400
//    `max_tokens: Field required`）、上限夹 1_048_576；
// 2. **思考形态**：`{type:'enabled', budget_tokens:N}` / `{type:'disabled'}`
//    （MiniMax 的 `adaptive` 会被拒）；budget 下限 1024、上限 max_tokens-1，
//    两头夹不住时降级 disabled（发非法 budget 是硬 400）；
// 3. **签名在 headers 里做**（本文件只造 payload；`X-OhMyAgent-Signature`
//    覆盖的是「prompt 文本」，由渠道层在序列化完成后计算）。

import { createHmac } from 'node:crypto'

// ── 签名（协议原语，从 monkeycode.ts 移植）───────────────────────────────

/**
 * 网关签名：`v1=<hex HMAC-SHA256(signing_secret, prompt)>`。
 * ⚠️ prompt 为空串时**仍然签名**（空串的 HMAC 是合法值）。
 */
export function monkeycodeGatewaySignature(signingSecret, prompt) {
  return `v1=${createHmac('sha256', signingSecret).update(prompt, 'utf8').digest('hex')}`
}

/** 从内容块里取文本（string 直接返回；对象取其 `text` 字段）。 */
function textOfBlock(block) {
  if (typeof block === 'string') return block
  if (typeof block !== 'object' || block === null) return undefined
  const text = block.text
  return typeof text === 'string' ? text : undefined
}

/** 从 Anthropic 的 `content`（string | 块数组）里取**第一块**文本。 */
function firstTextOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const text = textOfBlock(block)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * 取签名用的 `prompt`（SPEC §3，**顺序不能变**，服务端按同样优先级取）：
 * ① 顶层 `system`（string 或数组取第一块 text）；
 * ② 顶层 `instructions` 数组（多块按 `\n` **全量 join**，与 ① 不同 —— 实测差异）；
 * ③ `messages` 里首个 system 消息；
 * ④ `input` 里首个 developer/system 消息。全部落空 = 空串（签名照算）。
 */
export function monkeycodeSigningPrompt(payload) {
  if (typeof payload !== 'object' || payload === null) return ''
  const system = payload.system
  if (typeof system === 'string' && system.length > 0) return system
  if (Array.isArray(system)) {
    const text = firstTextOfContent(system)
    if (text !== undefined) return text
  }
  if (Array.isArray(payload.instructions)) {
    const parts = payload.instructions
      .map((block) => firstTextOfContent(block) ?? textOfBlock(block) ?? '')
      .filter((part) => part.length > 0)
    if (parts.length > 0) return parts.join('\n')
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (typeof message !== 'object' || message === null) continue
      if (message.role !== 'system') continue
      const text = firstTextOfContent(message.content)
      if (text !== undefined) return text
    }
  }
  if (Array.isArray(payload.input)) {
    for (const message of payload.input) {
      if (typeof message !== 'object' || message === null) continue
      if (message.role !== 'developer' && message.role !== 'system') continue
      const text = firstTextOfContent(message.content)
      if (text !== undefined) return text
    }
  }
  return ''
}

// ── 请求体翻译（OpenAI → Anthropic）─────────────────────────────────────

/** 读非空字符串。 */
const str = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)

/** 解析工具参数 JSON；失败退化 `{}`（不编造参数，也不丢块）。 */
function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** data URL → { mediaType, data（裸 base64） }；非 data URL 返回 undefined。 */
function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ''))
  return match === null ? undefined : { mediaType: match[1], data: match[2] }
}

/**
 * 把 OpenAI 消息数组翻译成 Anthropic messages。
 *
 * ⚠️ 成对提交纪律：assistant 先进待发区，遇到它的工具结果（或任何非工具消息）
 * 时把「assistant + 累积结果」一起 push —— 既合并同批（不产生连续 user），
 * 也不跨 assistant 边界累积。
 */
function serializeMessages(openaiMessages) {
  // 孤儿剔除：只保留「assistant 发起的调用」与「结果回传」两边都有的 id。
  const callIds = new Set()
  const resultIds = new Set()
  for (const message of openaiMessages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string' && call.id !== '' && typeof call?.function?.name === 'string' && call.function.name.trim() !== '') {
          callIds.add(call.id)
        }
      }
    }
    if (message?.role === 'tool' && typeof message.tool_call_id === 'string') {
      resultIds.add(message.tool_call_id)
    }
  }

  const out = []
  let pendingAssistant
  let pendingToolResults = []
  const commitPending = () => {
    if (pendingAssistant !== undefined) out.push(pendingAssistant)
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
    pendingAssistant = undefined
  }

  const pushToolResult = (toolCallId, text, image) => {
    const content = []
    if (image !== undefined) {
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
    }
    if (text !== '') content.push({ type: 'text', text })
    pendingToolResults.push({
      type: 'tool_result',
      tool_use_id: toolCallId,
      // ⚠️ 工具结果内容不能为空数组（上游 400）：至少给一个空文本块。
      ...(content.length > 0 ? { content } : { content: [{ type: 'text', text: '' }] }),
    })
  }

  for (const message of openaiMessages) {
    const role = message?.role
    if (role === 'system' || role === 'developer') continue // 已并入顶层 system

    if (role === 'tool') {
      const id = message.tool_call_id
      if (typeof id !== 'string' || !callIds.has(id) || !resultIds.has(id)) continue
      const parts = Array.isArray(message.content) ? message.content : undefined
      let text = ''
      let image
      if (parts === undefined) {
        text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
      } else {
        for (const part of parts) {
          if (part?.type === 'image_url') {
            const inline = parseDataUrl(part?.image_url?.url)
            if (inline !== undefined) image = inline // 工具结果里的图读不到就跳过
          } else if (typeof part?.text === 'string') {
            text += part.text
          }
        }
      }
      pushToolResult(id, text, image)
      continue
    }

    const content = []
    if (role === 'assistant') {
      const text = typeof message.content === 'string' ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('')
          : ''
      if (text !== '') content.push({ type: 'text', text })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const id = call?.id
        const name = call?.function?.name
        if (typeof id !== 'string' || !callIds.has(id) || typeof name !== 'string' || name.trim() === '') continue
        content.push({ type: 'tool_use', id, name, input: parseToolArguments(call.function?.arguments) })
      }
      commitPending()
      if (content.length === 0) continue
      pendingAssistant = { role: 'assistant', content }
      continue
    }

    // user（或未知角色按 user 处理）
    const parts = Array.isArray(message.content) ? message.content : undefined
    if (parts === undefined) {
      const text = typeof message.content === 'string' ? message.content : ''
      if (text !== '') content.push({ type: 'text', text })
    } else {
      for (const part of parts) {
        if (typeof part?.text === 'string') {
          if (part.text !== '') content.push({ type: 'text', text: part.text })
          continue
        }
        if (part?.type === 'image_url') {
          const inline = parseDataUrl(part?.image_url?.url)
          if (inline === undefined) {
            // ⚠️ 显式抛错不静默丢图：静默丢弃会让用户以为模型看到了图片。
            throw new Error(
              'monkeycode: 暂不支持远程图片链接（只支持 base64 data URL）。'
              + '请在客户端以附件（data URL）形式发送图片。',
            )
          }
          content.push({ type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } })
        }
      }
    }
    commitPending()
    if (content.length > 0) out.push({ role: 'user', content })
  }
  commitPending()
  return out
}

/** 未指定 `max_tokens` 时的默认值（保守下限，兜住标题生成这类一次性小请求）。 */
export const MONKEYCODE_DEFAULT_MAX_TOKENS = 4096
/** 输出上限的「荒谬值」兜底（实测 10 万 token 正常、百万不报错）。 */
export const MONKEYCODE_MAX_OUTPUT_TOKENS = 1_048_576
/** `budget_tokens` 硬下限（SPEC：N >= 1024，小于被拒）。 */
export const MONKEYCODE_MIN_THINKING_BUDGET = 1024

/** 归一化 max_tokens：非正/非有限 ⇒ 4096；超上限夹到上限（一个参数错误不该杀整个渠道）。 */
export function monkeycodeMaxTokensFor(maxTokens) {
  const raw = typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.max(1, Math.floor(maxTokens))
    : MONKEYCODE_DEFAULT_MAX_TOKENS
  return Math.min(raw, MONKEYCODE_MAX_OUTPUT_TOKENS)
}

/**
 * 思考档位 → MonkeyCode 形态（`{type:'enabled', budget_tokens:N}` / `{type:'disabled'}`）。
 * ⚠️ 两头夹：下限 1024、上限 max_tokens-1（Anthropic 要求 budget 严格小于 max_tokens）；
 * room 放不下最小预算时降级 disabled（至少拿到正文）。
 * 返回 `undefined` = 不发 thinking 字段（harness 没传 effort 时让服务端用默认）。
 */
export function monkeycodeThinkingFor(effort, maxTokens) {
  if (effort === undefined) return undefined
  if (effort === 'none') return { type: 'disabled' }
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return undefined
  const wanted = effort === 'low' ? 2048 : effort === 'medium' ? 4096 : 8192
  const budget = Math.max(MONKEYCODE_MIN_THINKING_BUDGET, wanted)
  const room = maxTokens - 1
  return room < MONKEYCODE_MIN_THINKING_BUDGET
    ? { type: 'disabled' }
    : { type: 'enabled', budget_tokens: Math.min(budget, room) }
}

/**
 * OpenAI chat 请求体 → Anthropic Messages 请求体。
 * @returns `{ payload }`（图片问题走 messages 的抛错路径）
 */
export function buildAnthropicPayload(body) {
  const model = str(body?.model) ?? ''
  if (model === '') throw new Error('monkeycode: 请求缺少 model')

  // system：OpenAI 的 system/developer 消息并入顶层 system 字段。
  const systemParts = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const text = typeof message.content === 'string' ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('\n')
          : ''
      if (text !== '') systemParts.push(text)
    }
  }
  const systemText = systemParts.join('\n\n')

  // tools：OpenAI function → Anthropic input_schema。
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool) => typeof tool?.function?.name === 'string' && tool.function.name.trim() !== '')
    .map((tool) => ({
      name: tool.function.name,
      ...(typeof tool.function.description === 'string' ? { description: tool.function.description } : {}),
      input_schema: typeof tool.function.parameters === 'object' && tool.function.parameters !== null
        ? tool.function.parameters
        : { type: 'object', properties: {} },
    }))

  const maxTokens = monkeycodeMaxTokensFor(Number(body?.max_tokens))
  const stop = Array.isArray(body?.stop)
    ? body.stop.filter((s) => typeof s === 'string' && s !== '')
    : (typeof body?.stop === 'string' && body.stop !== '' ? [body.stop] : [])

  const payload = {
    model,
    // ⚠️ 上游所有适配器只走流式（消费与错误处理都按 SSE 设计），恒 true；
    //   调用方要非流式时由桥聚合 chunks。
    stream: true,
    messages: serializeMessages(Array.isArray(body?.messages) ? body.messages : []),
    max_tokens: maxTokens,
  }
  if (systemText !== '') payload.system = systemText
  if (typeof body?.temperature === 'number' && Number.isFinite(body.temperature)) payload.temperature = body.temperature
  if (stop.length > 0) payload.stop_sequences = stop
  if (tools.length > 0) payload.tools = tools
  const thinking = monkeycodeThinkingFor(
    typeof body?.reasoning_effort === 'string' && body.reasoning_effort.trim() !== '' ? body.reasoning_effort.trim() : undefined,
    maxTokens,
  )
  if (thinking !== undefined) payload.thinking = thinking
  return payload
}

/** Anthropic `stop_reason` → OpenAI `finish_reason`。 */
export function mapFinishReason(reason) {
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

/** Anthropic usage → OpenAI usage。只物化**给过**的字段（缺的不写 0）。 */
function readUsage(raw) {
  const u = typeof raw === 'object' && raw !== null ? raw : {}
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined)
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  const thinking = num(u.output_tokens_details?.thinking_tokens)
  return {
    ...(input !== undefined || output !== undefined
      ? {
          prompt_tokens: input ?? 0,
          completion_tokens: output ?? 0,
          total_tokens: (input ?? 0) + (output ?? 0),
        }
      : {}),
    ...(input !== undefined ? { prompt_tokens_details: { cache_read: num(u.cache_read_input_tokens) ?? 0 } } : {}),
    ...(thinking !== undefined ? { completion_tokens_details: { reasoning_tokens: thinking } } : {}),
  }
}

/** 合并两份**原始 Anthropic usage**（message_start 与 message_delta 各带一半）。 */
function mergeAnthropicUsage(a, b) {
  const out = { ...(typeof a === 'object' && a !== null ? a : {}) }
  for (const [key, value] of Object.entries(typeof b === 'object' && b !== null ? b : {})) {
    out[key] = value
  }
  return out
}

/**
 * 消费 Anthropic Messages SSE，产出 **OpenAI chunk 的 JSON 对象流**。
 *
 * 实测纪律（minimax 版逐条保留）：
 * - SSE 里 `event: error` 必须抛错（只认 OpenAI 的 `{error:{message}}` 会把错误帧当「正常结束」）；
 * - `signature_delta` 刻意忽略；
 * - 名字不可用的 `tool_use` 一个 chunk 都不产出；
 * - 流被截断时 buffer 余量按整行再走一遍（否则最后一条 message_delta 被静默丢弃）；
 * - usage 原样累积、结束一次转换（message_delta 缺 input_tokens，提前物化会把
 *   prompt_tokens 覆盖成 0）。
 */
export async function* anthropicSseToOpenAi(body, { model, signal } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const id = `chatcmpl-monkeycode-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null, extra = {}) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })
  const frameOf = (delta, finish = null) => `data: ${JSON.stringify(chunk(delta, finish))}\n\n`

  let eventName = ''
  let buffer = ''
  let rawSample = ''
  const sampleRaw = (text) => {
    if (text === '' || rawSample.length >= 500) return
    rawSample += text.slice(0, 500 - rawSample.length)
  }
  const indexIn = (frame) => (Number.isFinite(frame?.index) ? frame.index : 0)
  /** 工具块的元数据（index → {id, name}）。 */
  const tools = new Map()
  const dropped = new Set()
  let droppedAny = false
  let emittedTool = false
  let sawAny = false
  let stopReason
  let anthropicUsage = {}

  const emitUsage = function* () {
    const usage = readUsage(anthropicUsage)
    if (Object.keys(usage).length > 0) {
      yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`
    }
  }

  const processLine = async function* (rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      eventName = ''
      return
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '') return
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const type = typeof frame.type === 'string' ? frame.type : eventName

    if (type === 'error') {
      // 本家混用两种信封：Anthropic 形状 `{error:{type,message}}` 与
      // 自家 `{code,message}`。message 回退读顶层。
      const nested = typeof frame.error === 'object' && frame.error !== null ? frame.error : {}
      const message = str(nested.message) ?? str(frame.message) ?? '未知错误'
      const kind = str(nested.type) ?? str(frame.type)
      const code = frame.code !== undefined ? `（code=${String(frame.code)}）` : ''
      throw new Error(`monkeycode: 流内错误${kind && kind !== 'error' ? `（${kind}）` : ''}：${message}${code}`)
    }
    if (type === 'message_start') {
      sawAny = true
      anthropicUsage = mergeAnthropicUsage(anthropicUsage, frame.message?.usage)
      yield frameOf({ role: 'assistant', content: '' })
      return
    }
    if (type === 'content_block_start') {
      const index = Number.isFinite(frame.index) ? frame.index : 0
      const block = typeof frame.content_block === 'object' && frame.content_block !== null ? frame.content_block : {}
      if (block.type === 'tool_use') {
        const callId = str(block.id) ?? ''
        const name = str(block.name) ?? ''
        if (name === '') {
          // 空名整块丢弃：空名调用会执行成 unknown tool "" 并污染会话。
          dropped.add(index)
          droppedAny = true
          sawAny = true
          return
        }
        tools.set(index, { id: callId, name })
        sawAny = true
        emittedTool = true
        yield frameOf({ tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }] })
      } else if (block.type === 'text' || block.type === 'thinking') {
        sawAny = true
      }
      return
    }
    if (type === 'content_block_delta') {
      const index = Number.isFinite(frame.index) ? frame.index : 0
      const delta = typeof frame.delta === 'object' && frame.delta !== null ? frame.delta : {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        yield frameOf({ content: delta.text })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
        yield frameOf({ reasoning_content: delta.thinking })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        if (dropped.has(index)) return
        const tool = tools.get(index)
        yield frameOf({
          tool_calls: [{
            index,
            ...(tool !== undefined ? { id: tool.id } : {}),
            function: { ...(tool?.name ? { name: tool.name } : {}), arguments: delta.partial_json },
          }],
        })
      }
      // signature_delta 刻意忽略（thinking 块的签名，不是正文）。
      return
    }
    if (type === 'content_block_stop') {
      const index = indexIn(frame)
      if (dropped.has(index)) dropped.delete(index)
      return
    }
    if (type === 'message_delta') {
      sawAny = true
      if (typeof frame.delta?.stop_reason === 'string') stopReason = frame.delta.stop_reason
      anthropicUsage = mergeAnthropicUsage(anthropicUsage, frame.usage)
      return
    }
    // message_stop / ping / 未知帧：忽略。
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        if (buffer !== '') {
          const tail = buffer.split('\n')
          buffer = ''
          for (const rawLine of tail) yield* processLine(rawLine)
        }
        break
      }
      const piece = decoder.decode(value, { stream: true })
      sampleRaw(piece)
      buffer += piece
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) yield* processLine(rawLine)
      if (signal?.aborted === true) break
    }
  } finally {
    await reader.cancel?.().catch(() => {})
    reader.releaseLock?.()
  }

  if (!sawAny) {
    const sample = rawSample.trim()
    throw new Error(`monkeycode: 模型未返回任何内容块${sample === '' ? '' : `（响应原文：${sample.slice(0, 500)}）`}`)
  }
  {
    // 空名 tool_use 丢弃且没有合法调用时按 length 收尾：可重试、
    // 避免消费方等一个永远不来的调用。
    const finish = mapFinishReason(stopReason) === 'tool_calls' && droppedAny && !emittedTool
      ? 'length'
      : mapFinishReason(stopReason)
    yield frameOf({}, finish)
    yield* emitUsage()
    yield 'data: [DONE]\n\n'
  }
}

/** Anthropic 非流式响应 → OpenAI chat.completion。 */
export function anthropicJsonToOpenAi(message, { model }) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
  const toolCalls = blocks
    .filter((b) => b?.type === 'tool_use' && str(b.name) !== undefined)
    .map((b, index) => ({
      id: str(b.id) ?? `call_${index}`,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(typeof b.input === 'object' && b.input !== null ? b.input : {}) },
    }))
  const finish = mapFinishReason(message?.stop_reason)
  return {
    id: str(message?.id) ?? `chatcmpl-monkeycode-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        ...(text !== '' ? { content: text } : toolCalls.length > 0 ? { content: null } : { content: '' }),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finish,
    }],
    ...(Object.keys(readUsage(message?.usage)).length > 0 ? { usage: readUsage(message?.usage) } : {}),
  }
}
