/**
 * 在 QQ 上回答宿主的两类交互提示。
 *
 * 有两件事 agent 不能自己决定：权限提示（这个操作能跑吗？）和结构化提问（你要哪个选项？）。
 * 两者本来都在桌面端的会话面板里回答，走一个**作用域 waterfall 事件**——
 * 应答者要么返回结果**认领**请求，要么用 `next()` 交给下一位。
 *
 * 只有手机的用户永远看不到那个面板，而宿主自带的应答者是 **fail-closed** 的，
 * 于是回合就卡在那里、没有任何继续的办法。本模块为绑定到 QQ 的对话**认领**这些请求，
 * 把提示作为聊天消息发出去，再把用户的回复翻译回宿主期望的结果。
 *
 * 未绑定的对话原样 `next()` 委托出去，所以桌面端的使用完全不受影响。
 *
 * 移植自 `dsh-wechat/packages/bundle/src/interactions.ts`（同版本、已在生产验证）。
 *
 * @module dsh-qq/interactions
 */

/** 宿主期望从权限提示拿回的结果。 */
// 'allowed-once' | 'rejected' | 'cancelled'

/** 权限词，覆盖本插件用户会写的两种语言。 */
const ALLOW_WORDS = ['允许', '同意', '可以', '好', '行', 'yes', 'y', 'allow', 'ok', 'okay']
/**
 * 否定词。
 *
 * ⚠️ 这个列表比微信插件多三项：`不可以`、`不同意`、`不用`。
 *
 * 微信那边只显式处理了「不允许」（因为它含「允许」），但**整词匹配拦不住「不可以」**——
 * 它既不在否定表里，也不与「可以」整词相等，于是落进"认不出"，
 * 提示被重发、消息被当成新请求转给 agent。
 *
 * 认不出**不会误授权**（安全方向是对的），但体验差。补上这三项只可能把
 * "认不出"变成"拒绝"，也就是**只往更安全的方向**移动，所以这个偏离是值得的。
 * 刻意不收录单字「别」这类，太容易把无关消息误读成拒绝。
 */
const DENY_WORDS = [
  '拒绝',
  '不允许',
  '不可以',
  '不同意',
  '不用',
  '不行',
  '不要',
  '否',
  'no',
  'n',
  'deny',
  'reject',
  'cancel',
  '取消',
]

/**
 * 从一条回复里读出权限决定。
 *
 * 按**整词**匹配而不是子串，这样「不可以」会拒绝、「可以」会允许，而两者不会互相遮蔽。
 * 认不出的回复返回 `undefined`，**不会**被当成拒绝。
 *
 * @param reply - 用户的消息。
 * @returns 结果，或文本不是一个决定时的 `undefined`。
 */
export function parseApprovalReply(reply) {
  const text = reply.trim().toLowerCase()
  if (text === '') return undefined
  // 先查否定：「不允许」包含「允许」，而拒绝绝不能被读成同意。
  if (DENY_WORDS.some((word) => text === word || text.startsWith(`${word} `))) return 'rejected'
  if (ALLOW_WORDS.some((word) => text === word || text.startsWith(`${word} `))) return 'allowed-once'
  return undefined
}

/**
 * 把权限提示渲染成聊天消息。
 *
 * @param request - 宿主的审批请求。
 * @returns `{ body }`
 */
export function presentApproval(request) {
  const toolName = typeof request?.toolName === 'string' ? request.toolName : '某个操作'
  const reason = [request?.displayReason, request?.reason, request?.command].find(
    (value) => typeof value === 'string' && value !== '',
  )
  const lines = [`🔐 需要你确认：${toolName}`]
  if (typeof reason === 'string') lines.push(reason, '')
  else lines.push('')
  lines.push('回复 允许 或 拒绝')
  return { body: lines.join('\n') }
}

/**
 * 把结构化提问渲染成聊天消息。
 *
 * 选项**编号**，这样回复可以只敲一个数字而不是完整标签——
 * 整件事的意义就是能在手机键盘上回答。
 *
 * @param questions - 要渲染的提问。
 * @returns `{ body }`
 */
export function presentQuestions(questions) {
  const blocks = []
  for (const [index, item] of questions.entries()) {
    const lines = []
    if (questions.length > 1) lines.push(`${String(index + 1)}. ${item.question}`)
    else lines.push(item.question)
    if (item.detail !== undefined && item.detail !== '') lines.push(item.detail)
    if (item.options !== undefined && item.options.length > 0) {
      lines.push('')
      for (const [optionIndex, option] of item.options.entries()) {
        const suffix = option.description === undefined ? '' : ` — ${option.description}`
        lines.push(`${String(optionIndex + 1)}. ${option.label}${suffix}`)
      }
      lines.push('')
      const many = item.multiSelect === true
      lines.push(many ? '回复编号（可多个，如 1,3），或直接回复你的答案' : '回复编号，或直接回复你的答案')
    } else {
      lines.push('')
      lines.push('直接回复你的答案')
    }
    blocks.push(lines.join('\n'))
  }
  return { body: blocks.join('\n\n') }
}

/**
 * 从一条回复里读出答案，每个提问一个。
 *
 * 纯数字的回复选中那些选项；其它文本成为自由回答。**文本永不被拒绝**：
 * 拒绝理解用户会把他们卡在提示上，而那正是本模块要解决的问题。
 *
 * @param questions - 正在被回答的提问。
 * @param reply - 用户的消息。
 * @returns `{ answers: [{ id, selected, custom? }] }`
 */
export function parseQuestionReply(questions, reply) {
  const text = reply.trim()
  const answers = questions.map((item) => {
    const options = item.options ?? []
    const indices = readIndices(text, options.length)
    if (indices.length > 0) {
      const selected = indices.map((index) => options[index]?.label ?? '')
      const multi = item.multiSelect === true ? selected : selected.slice(0, 1)
      return { id: item.id, selected: multi.filter((label) => label !== '') }
    }
    // 不是一组编号：把整条回复当作答案。
    // 有选项时优先取标签，否则把自由文本放进 `custom`。
    if (options.length === 0) return { id: item.id, selected: [], custom: text }
    const matched = options.find((option) => option.label === text)
    return matched === undefined
      ? { id: item.id, selected: [], custom: text }
      : { id: item.id, selected: [matched.label] }
  })
  return { answers }
}

/**
 * 读出回复里点到的选项位置。
 *
 * 接受 `2`、`1,3`、`1 3`，以及中文键盘打出的全角逗号。
 * **每个数字都必须指向真实存在的选项**，所以三个选项时回「5」不会被读成一次选择。
 *
 * @param text - 用户的回复。
 * @param optionCount - 该提问有多少个选项。
 * @returns 0 起的位置，按书写顺序。
 */
function readIndices(text, optionCount) {
  if (optionCount === 0) return []
  if (!/^[\d\s,，、]+$/.test(text)) return []
  const numbers = text.split(/[\s,，、]+/).filter((part) => part !== '')
  const indices = []
  for (const part of numbers) {
    const value = Number.parseInt(part, 10)
    if (!Number.isInteger(value) || value < 1 || value > optionCount) return []
    indices.push(value - 1)
  }
  return indices
}
