/**
 * 把一条入站 QQ 消息拼成给 agent 的提示词。
 *
 * 抽成纯函数是为了**可测**：这段决定"agent 到底看到了什么"，
 * 而它是整条链路上最该被钉住的行为——拼错不会报错，只会让 agent 答非所问。
 *
 * @module dsh-qq/prompt
 */

/**
 * @param message - SDK 归一化后的入站消息。
 * @returns 提示词文本（可能为空串，调用方据此丢弃该消息）。
 */
export function composePrompt(message) {
  const parts = []

  // 引用：只有当 `msg_elements` 里确实带着被引内容时才加，避免产生空壳「[引用]」。
  const quoted = quotedText(message)
  if (quoted !== undefined) parts.push(`[引用] ${quoted}`)

  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  if (text !== '') parts.push(text)

  for (const attachment of message?.attachments ?? []) {
    // 语音优先用服务端转写——QQ 自带 ASR，因此**不需要 SILK 解码**。
    const voiceText = attachment?.asr_refer_text
    if (typeof voiceText === 'string' && voiceText.trim() !== '') {
      parts.push(`[语音转写] ${voiceText.trim()}`)
      continue
    }
    const label = attachment?.filename ?? attachment?.content_type ?? '附件'
    const url = typeof attachment?.url === 'string' ? attachment.url : ''
    parts.push(`[附件 ${label}] ${url}`.trim())
  }
  return parts.join('\n')
}

/**
 * 把一条入站消息拆成"交给路由的正文"与"被引用的正文"。
 *
 * ## 为什么必须拆开
 *
 * 路由靠**以 `/` 开头**认出指令，而 `composePrompt` 会把引用接在正文之前。
 * 于是"引用一屏清单，再回 `/switch 3`"合成出来的文本以 `[引用]` 开头，
 * 看起来不是指令，整条落进 agent 那一支——引用列表再按编号切换这件事就永远不成立。
 *
 * 引用本身仍然有用：路由靠**比对它的正文**认出被引的是哪一屏清单
 * （微信按消息 id 钉，QQ 的引用直接给正文）。所以两者都要留下。
 *
 * @param message - SDK 归一化后的入站消息。
 * @returns `{ text, quoted?, composed }`：
 *   `text` 给路由与指令解析（不含引用），`quoted` 给路由认清单，
 *   `composed` 是**原来那个**合成结果（引用在前），交互拦截与交付给 agent 时用它，
 *   免得这条路径上的行为悄悄变了样。
 */
export function splitRouteText(message) {
  const composed = composePrompt(message)
  const quoted = quotedText(message)
  if (quoted === undefined) return { text: composed, composed }
  return { text: composePrompt({ ...message, refMsgIdx: undefined }), quoted, composed }
}

/**
 * 一次交付给 agent 的文本。
 *
 * ## 形状：一个列表，而它**恒定只有一个元素**
 *
 * 用户的话在最前，附件描述在中间，渠道说明（`presenceNote`）在最后。
 *
 * 曾经不是这样：会话的**第一条**消息（DSH 拿它给会话命名）被拆成两条独立提交——
 * 先「用户的话」、再「渠道说明」——理由是不让说明污染标题。代价正是用户报的那个
 * bug：agent 收到两条**先后独立的用户消息**，而第一轮往往只看得到第一条。
 *
 * 现在标题在**创建会话时显式交给宿主**（`router.js` 的 `#bind` →
 * `sessionController.rename`），首条消息不必再为标题让路，所以这里不再有第二个元素。
 * 返回值保持列表形状，是因为提交那一步按元素逐个提交（`steer` 被拒再退 `queue`），
 * 而"那条消息只提交一次"正是 `scripts/verify.mjs` 钉住的性质。
 *
 * 附件描述走文本而不是原生图片内容：那条路要求模型支持视觉，否则整条提示词被拒，
 * 而路径描述对每个模型、每种文件都成立。
 *
 * @param params.promptText - 用户的话（引用在前、正文在后，见 `runtime.#deliverPrompt`）。
 * @param params.attachmentLines - 附件描述行，可能为空。
 * @param params.note - 渠道说明；空串表示不留。
 * @returns 要提交的文本：0 个元素（什么都没有）或 1 个。
 */
export function composeDelivery({ promptText, attachmentLines = [], note = '' }) {
  const lines = [promptText, ...attachmentLines, note].filter((line) => line !== '')
  return [lines.join('\n\n')].filter((text) => text !== '')
}

/**
 * 从入站消息里取出被引用消息的内容。
 *
 * QQ 的形态：`msg_elements[]` 里某一条的 `msg_idx` 等于本消息的 `refMsgIdx`，
 * 那条的 `content` 就是被引正文。
 *
 * **逐项核对而不是直接取 `[0]`**：拿错一条会把"用户在回复什么"讲反，
 * 而那比完全没有引用更糟。
 *
 * 这是相对微信的一处白送：iLink 的 `ref_msg` 只有 `type:0 + msg_id`，
 * 微信插件为此自建了一套引用缓存，而 QQ 协议直接给了正文。
 *
 * @param message - SDK 归一化后的入站消息。
 * @returns 被引内容，或 `undefined`。
 */
function quotedElement(message) {
  const refIdx = message?.refMsgIdx
  if (typeof refIdx !== "string" || refIdx === "") return undefined
  const elements = Array.isArray(message?.msgElements) ? message.msgElements : []
  return elements.find((element) => element?.msg_idx === refIdx)
}

/**
 * 被引用消息里的附件（图片/文件）。
 *
 * QQ 把被引消息的附件放在 `msg_elements[<refMsgIdx>].attachments` 里。
 * 只取引用元素里的，不取当前消息的附件：两者性质不同（前者是"我引用的那张图"，
 * 后者是"我这次发的图"）。
 *
 *  message - SDK 归一化后的入站消息。
 *  附件数组；没有引用或引用没有附件时为空数组。
 */
export function quotedAttachments(message) {
  const element = quotedElement(message)
  return Array.isArray(element?.attachments) ? element.attachments : []
}

export function quotedText(message) {
  const element = quotedElement(message)
  if (element === undefined) return undefined
  const content = typeof element.content === "string" ? element.content.trim() : ""
  if (content !== "") return content
  // 引用的是纯媒体消息：正文为空时给一句占位；附件本身由 `quotedAttachments`
  // 下载成路径后交给 agent，这里只说类型，避免 `[引用]` 变成空壳。
  const kinds = (element.attachments ?? [])
    .map((item) => item?.content_type)
    .filter((kind) => typeof kind === "string" && kind !== "")
  if (kinds.length > 0) return `（引用了${kinds.join("、")}）`
  return undefined
}
