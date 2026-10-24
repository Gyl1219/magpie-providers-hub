// MiniMax 的 OpenAI↔Anthropic 翻译桥。
//
// ## 为什么需要它
//
// 聚合 provider 注册为 `@ai-sdk/openai-compatible`（magpie 发 OpenAI 形状请求进来），
// 而 MiniMax Code 的推理端点只说 **Anthropic Messages**（`/mavis/api/v1/llm/v1/messages`）。
// 协议语义移植自 DSH `src/minimax-messages.ts`（真机实测的每一条都在）：
//
// - `system` 走顶层字段，不是 system 角色消息（Anthropic 不接受）；
// - **工具结果必须作为 user 消息里的 `tool_result` 块**，且与产生它的
//   assistant(tool_use) **成对提交** —— 逐条下发会产生连续 user 消息，
//   上游 400 `tool call result does not follow tool call (2013)`；
// - 孤儿 tool_use / tool_result 都要剔除（服务端同样 400）；
// - 图片是 Anthropic `image` 块 + **裸 base64**（OpenAI 的 `image_url` 被明确拒绝）；
// - 思考档位决策表（错一个就是 400 或假关闭，见 thinkingDecide）；
// - SSE 的 `signature_delta` 必须忽略（那是 thinking 块签名，不是正文）；
// - 空名 `tool_use` 整块丢弃，且上游报 `tool_use` 却无可执行调用时按
//   `length` 收尾（否则消费方会等一个永远不来的调用）。

/** M3.1 系必须 adaptive thinking：传 disabled 会被硬拒（400 code 2013）。 */
const ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1'

/** 模型元数据（channel 的目录步骤填充；chat 时查表）。 */
const metaByModel = new Map()

export function rememberModelMeta(entries) {
  for (const entry of entries) {
    metaByModel.set(entry.id, entry)
  }
}

function modelMeta(model) {
  return metaByModel.get(model)
}

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
 * ⚠️ 成对提交纪律（移植自 DSH `serializeMinimaxMessages`）：assistant 先进待发区，
 * 遇到它的工具结果（或任何非工具消息）时把「assistant + 累积结果」一起 push ——
 * 既合并同批（不产生连续 user），也不跨 assistant 边界累积。
 */
function serializeMessages(openaiMessages, { systemText }) {
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
            if (inline !== undefined) image = inline // 工具结果里的图读不到就跳过（不抛错，DSH 同款区别对待）
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
              'minimax: 暂不支持远程图片链接（只支持 base64 data URL）。'
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
  void systemText
  return out
}

/**
 * 思考档位决策（移植 DSH `buildMinimaxMessagesPayload` 的实测决策表）：
 *
 * | 情形 | 请求体 |
 * |---|---|
 * | effort='none'（仅 switchable 可达） | `thinking:{type:'disabled'}` |
 * | effort='on'（仅 switchable 可达，M3 不发时默认不思考） | `thinking:{type:'adaptive'}` |
 * | 有档位 effort（在声明表内） | `thinking:{type:'adaptive'}` + `output_config.effort` |
 * | M3.1 系（无 effort） | `thinking:{type:'adaptive'}`（必须，否则 400） |
 * | 其余（M2.7 系） | **整个不发**（服务端默认思考；发 disabled 被静默忽略） |
 */
function thinkingDecide(model, requestedEffort, meta) {
  const requiresAdaptive = model.startsWith(ADAPTIVE_ONLY_PREFIX)
  const mode = meta?.thinkingMode
  const efforts = meta?.effortOptions
  let effort = typeof requestedEffort === 'string' && requestedEffort.trim() !== '' ? requestedEffort.trim() : undefined
  if (effort === 'none' || effort === 'on') {
    // 这两档只对 switchable 模型可达 —— 发给别的模型是猜测。
    if (mode !== 'switchable') effort = undefined
  } else if (effort !== undefined && efforts !== undefined && !efforts.includes(effort)) {
    effort = undefined
  }
  if (effort === 'none') return { thinking: { type: 'disabled' } }
  if (effort === 'on') return { thinking: { type: 'adaptive' } }
  if (requiresAdaptive) {
    return effort !== undefined
      ? { thinking: { type: 'adaptive' }, output_config: { effort } }
      : { thinking: { type: 'adaptive' } }
  }
  if (effort !== undefined) return { thinking: { type: 'adaptive' }, output_config: { effort } }
  return {}
}

/**
 * OpenAI chat 请求体 → Anthropic Messages 请求体。
 *
 * @param body OpenAI 请求体（model 已去掉渠道前缀）
 * @returns `{ payload, imageErrors }`（图片问题已并入 messages 的抛错路径）
 */
export function buildAnthropicPayload(body) {
  const model = str(body?.model) ?? ''
  if (model === '') throw new Error('minimax: 请求缺少 model')
  const meta = modelMeta(model)

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

  // max_tokens：Anthropic 必填。请求没带就按目录的 output 上限兜底。
  const requestedMax = Number(body?.max_tokens)
  const maxTokens = Number.isSafeInteger(requestedMax) && requestedMax > 0
    ? requestedMax
    : (Number.isSafeInteger(meta?.maxTokens) && meta.maxTokens > 0 ? meta.maxTokens : 8192)

  const stop = Array.isArray(body?.stop)
    ? body.stop.filter((s) => typeof s === 'string' && s !== '')
    : (typeof body?.stop === 'string' && body.stop !== '' ? [body.stop] : [])

  const payload = {
    model,
    stream: body?.stream === true,
    messages: serializeMessages(Array.isArray(body?.messages) ? body.messages : [], { systemText }),
    max_tokens: maxTokens,
  }
  if (systemText !== '') payload.system = systemText
  if (typeof body?.temperature === 'number' && Number.isFinite(body.temperature)) payload.temperature = body.temperature
  if (stop.length > 0) payload.stop_sequences = stop
  if (tools.length > 0) payload.tools = tools
  Object.assign(payload, thinkingDecide(model, body?.reasoning_effort, meta))
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
 * 移植自 DSH `consumeMinimaxSse` 的实测事实：
 * - `pending` 是 HTTP 200 形态之外，SSE 里 `event: error` 必须抛错
 *   （只认 OpenAI 的 `{error:{message}}` 会把错误帧当「正常结束」）；
 * - `signature_delta` 刻意忽略；
 * - 名字不可用的 `tool_use` 一个 chunk 都不产出；
 * - 流被截断时 buffer 余量要按整行再走一遍（否则最后一条
 *   `message_delta`——正是带 stop_reason/usage 的帧——被静默丢弃）。
 */
export async function* anthropicSseToOpenAi(body, { model, signal } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const id = `chatcmpl-minimax-${Date.now().toString(36)}`
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
  /**
   * **原始 Anthropic usage**（message_start 给 input、message_delta 给 output）。
   *
   * ⚠️ 不能在每帧就转成 OpenAI 形状再合并：`message_delta` 缺 `input_tokens`，
   * `readUsage` 会把 `prompt_tokens` 物化成 0 **覆盖**掉 start 帧的 10 ——
   * usage 全为 0（真机形态，DSH 的 `usage = {...usage, ...readUsage(...)}` 同坑）。
   * 原样累积、结束一次转换。
   */
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
      // ⚠️ 本家混用两种信封：Anthropic 形状 `{error:{type,message}}` 与
      // 自家 `{code,message}`（401 实测没有 error 对象）。message 回退读顶层。
      const nested = typeof frame.error === 'object' && frame.error !== null ? frame.error : {}
      const message = str(nested.message) ?? str(frame.message) ?? '未知错误'
      const kind = str(nested.type) ?? str(frame.type)
      const code = frame.code !== undefined ? `（code=${String(frame.code)}）` : ''
      throw new Error(`minimax: 流内错误${kind && kind !== 'error' ? `（${kind}）` : ''}：${message}${code}`)
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
        // ⚠️ 名字随每一片下发（openai-node 的 function.name 只从 delta 里取）。
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
    throw new Error(`minimax: 模型未返回任何内容块${sample === '' ? '' : `（响应原文：${sample.slice(0, 500)}）`}`)
  }
  {
    // 空名 tool_use 丢弃且没有合法调用时按 length 收尾（DSH 同款：可重试、
    // 避免消费方等一个永远不来的调用）。
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
    id: str(message?.id) ?? `chatcmpl-minimax-${Date.now().toString(36)}`,
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
