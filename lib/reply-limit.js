/**
 * 长回复的降级决策。
 *
 * 抽成纯函数是为了**可测**：这段决定"用户看到的是一条消息、被截断的消息，
 * 还是一个附件"，三种结果在手机上差别很大，而它们的分支条件很容易写反。
 *
 * 语义（与 `dsh-wechat-plugin` 的 `maxReplyChars` 一致）：
 *
 * | `limit` | 行为 |
 * |---|---|
 * | `<= 0` | **不限制**，原样发送 |
 * | `> 0` 且文本不超过它 | 原样发送 |
 * | `> 0` 且文本超过它 | 先发一句 caption，正文写文件当附件发 |
 *
 * @module dsh-qq/reply-limit
 */

/**
 * 对一条回复做出投递决策。
 *
 * @param text - 已 trim 的回复正文。
 * @param limit - 字数上限；`<= 0` 表示不限制。
 * @returns `{ kind: 'send', text }` 或 `{ kind: 'file', text, caption }`
 */
export function planReply(text, limit) {
  if (limit <= 0 || text.length <= limit) {
    // `<= 0` 时截断到 max(limit,1) 是错的，所以两个条件分开处理。
    return { kind: 'send', text: limit <= 0 ? text : text.slice(0, Math.max(limit, 1)) }
  }
  return {
    kind: 'file',
    text,
    caption: `回复较长（${String(text.length)} 字），已作为文件发送。`,
  }
}

/**
 * 长回复落盘时用的文件名。
 *
 * 带时间戳是为了同一目录里多次长回复不互相覆盖；用 `.md` 是因为这些正文
 * 本来就是 Markdown（agent 的输出），用户在电脑上打开就能正常渲染。
 *
 * @param now - 时间（测试可注入）。
 * @returns 文件名。
 */
export function longReplyFileName(now = new Date()) {
  return `回复-${now.toISOString().replace(/[:.]/g, '-')}.md`
}
