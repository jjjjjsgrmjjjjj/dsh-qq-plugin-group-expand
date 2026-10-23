/**
 * 从 `agent/assistant-stream` 的载荷里读出「哪个会话、这段可见文本、回合是否结束」。
 *
 * 直接移植自 dsh-wechat-plugin 的 `lib/services.js`（同版本、已在生产验证）。保留它的全部
 * 谨慎之处，因为这类代码**写错是静默失败**——字段名对不上，回复就凭空消失，任何地方都不报错。
 *
 * 两条最容易搞错的语义：
 *
 * 1. **只有 `frame.type === 'end'` 才算回合结束。** `finish` 每完成一个模型步骤就发一次，
 *    一个带工具调用的回合会有好几个 `finish`；拿它当结束会把一个答案拆成好几条 QQ 消息。
 * 2. `reasoning-delta` / `usage` / `block-*` 都不是用户可见文本，不能拼进回复。
 *
 * @module dsh-qq/stream-frame
 */

/**
 * @typedef {object} StreamFrame
 * @property {string} [sessionId] - 该帧属于哪个会话。
 * @property {string} [text] - 本帧新增的可见文本。
 * @property {boolean} [completed] - 回合是否结束。
 * @property {{id: string, name: string}} [toolCall] - 识别出的工具调用。
 * @property {string} [frameShape] - 未知帧的形态。**这是警报而非观测**：
 *   只在宿主发了本解析器不认识的帧时出现，见下面 `chunk === undefined` 处的说明。
 */

/**
 * @param {unknown} payload - `agent/assistant-stream` 的载荷。
 * @returns {StreamFrame}
 */
export function readStreamFrame(payload) {
  const record = asRecord(payload)
  const rawId = asRecord(asRecord(record?.agent)?.session)?.id
  const sessionId = typeof rawId === 'string' ? rawId : undefined
  const withId = sessionId === undefined ? {} : { sessionId }

  const frame = asRecord(record?.frame)
  if (frame === undefined) return withId

  // end 帧没有 chunk，它是唯一的回合结束信号。
  if (frame.type === 'end') return { ...withId, completed: true }

  const chunk = asRecord(frame.chunk)
  /*
   * 没有 `chunk` 的帧**不是我们认识的形态**——所以这里把它的形状交出去，供上层记一条日志。
   *
   * ★ 这是**警报**，不是观测探针，所以它留了下来（同组的 `chunkType` / `toolCallShape` /
   * `blockShape` 已删除，它们的知识记在 `docs/HOST-STREAM-SHAPES.md`）。
   *
   * 区别在于触发面：那三个在**正常流量上**每次都会触发，而这一个只在宿主发了
   * 我们解析不了的东西时触发。如果将来 DSH 改了事件词汇，**机器人会静默地不再回复**——
   * 这一行是唯一能让人当场看见"帧变了"的东西。
   */
  if (chunk === undefined) {
    return { ...withId, frameShape: `frame:${Object.keys(frame).join(',')};type=${String(frame.type)}` }
  }

  switch (chunk.type) {
    case 'text-delta':
      // 模型真正的输出。
      return typeof chunk.text === 'string' ? { ...withId, text: chunk.text } : withId

    case 'tool-call-delta': {
      // 观测事实：这个帧带 `type,index,id,argumentsDelta`，**不带工具名**——
      // 所以工具名只在 `block-start` 上出现（见 `docs/HOST-STREAM-SHAPES.md`）。
      const id = typeof chunk.id === 'string' ? chunk.id : undefined
      const name = typeof chunk.name === 'string' ? chunk.name : undefined
      if (id === undefined || name === undefined || name === '') return withId
      return { ...withId, toolCall: { id, name } }
    }

    case 'block-start':
    case 'block-end':
      // 工具块的边界帧。它们不承载用户可见文本。
      return withId

    default:
      // reasoning-delta / usage / finish，以及将来新增的类型：
      // 都不是用户可见文本。见文件头第 1 条——`finish` 刻意不算结束信号。
      return withId
  }
}

function asRecord(value) {
  if (typeof value !== 'object' || value === null) return undefined
  return value
}
