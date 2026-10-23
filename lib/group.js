/**
 * 群聊策略：**只在被点名时说话**，以及"关键词 / 语境"接话的判定。
 *
 * ## 为什么单独一个模块
 *
 * 群聊与私聊是两套不同的礼貌规则。私聊里每条消息都是对机器人说的；群聊里绝大多数
 * 不是——一个在群里对每句话都应声的机器人是噪音，不是人格。所以门禁必须是**一条明确的
 * 判定**，能单独测试，而不是散在 `runtime.js` 的 `if` 里。本文件全是纯函数：
 * 输入一条消息、设置、最近几条群消息，输出一个决定。
 *
 * ## 门禁（用户的原话：「没有提及人格的时候不发言」）
 *
 * 人格是**鲸鱼娘**。「大肥鱼」是一个旧绰号，**默认不认**（用户要求忽略它）；
 * 群里如果还这么叫，把绰号加进设置里的人格名列表就能重新认。
 *
 * | 情况 | 决定 | 理由 |
 * |---|---|---|
 * | 被 @ | `agent` | @ 本身就是点名，立即回答 |
 * | 文字里点名人格，且像在提问 | `agent` | 「鲸鱼娘你觉得呢？」值得一个真回答 |
 * | 文字里点名人格，其他语气 | `auto` | 用短句 + 表情包接一句，不烧模型 |
 * | 当前消息含关键词，且前文刚提过人格 | `auto` | 这是"语境"：话题还在人格身上 |
 * | 前文刚提过人格，当前消息是一个接话信号 | `auto` | 「哈哈」「真的假的」——它接得住 |
 * | 其余 | `ignore` | **没提人格，就不说话** |
 *
 * 表里有两个刻意保守的选择：
 *
 * 1. **关键词单独出现不算数。** 一个群友说「哈哈」时，机器人不该以为在叫自己；
 *    必须有"前文提到过人格"这一层语境托着。默认关键词表里放着人格名本身，
 *    所以"点名 → 接话"这条路不依赖前文。
 * 2. **@ 永远优先。** 即使设置里关掉了自动接话，@ 仍然会得到一个回答——用户要的
 *    「有@消息时及时发言」不该被一个自动发言开关顺手关掉。
 *
 * ## 平台限制（必须写在这里，否则会被当成 bug）
 *
 * QQ 官方机器人网关默认只推送 **`GROUP_AT_MESSAGE_CREATE`**（群里 @ 机器人）。
 * 普通机器人看不到群里的普通聊天，所以"关键词/语境自动接话"只在两种情况下有输入：
 * 机器人有"群消息全量"权限（平台会推 `GROUP_MESSAGE_CREATE`），或者群里有人 @ 它。
 * 这不是本模块的判断问题——**没有收到消息，就没有东西可判定**。日志里会把
 * `rawEventType` 打出来，便于确认平台到底推了什么。
 *
 * @module dsh-qq/group
 */

/**
 * 「这条不需要回应」的标记。
 *
 * @ 后的连续对话窗口里，每条消息都交给 agent **自己判断**要不要回答。判断为不需要时，
 * agent 只输出这个标记；运行时看到它就把整条回复丢弃，**不在群里发任何东西**。
 *
 * 为什么用标记而不是"什么都不输出"：模型被要求回答时几乎总会说点什么（"好的""收到"），
 * 空白输出不可靠。给它一个明确的动作（输出标记），才是可测试的约定。
 */
export const NO_REPLY_MARKER = '[[NO_REPLY]]'

/**
 * 这条回复是不是"判断不需要回应"。
 *
 * 用 `includes` 而不是全等：模型即使严格按提示，也可能在标记前后带一个换行或句号。
 * 只要标记出现，就按"不回应"处理——把 [[NO_REPLY]] 原样发到群里是最糟的结果。
 *
 * @param text - agent 的回复正文。
 * @returns 是否应当静默丢弃。
 */
export function isNoReply(text) {
  if (typeof text !== 'string') return false
  /*
   * 三种形态都算：
   * - 完整标记；
   * - 模型没照格式写、只写了 `NO_REPLY`（此时更不能把它发进群）；
   * - **流式分片的半截标记**（`[[NO` / `[[NO_RE`）。静默窗口到期时，文本可能正好停在
   *   标记中间；不识别的话，群里会冒出一行 `[[NO_`。
   */
  return text.includes(NO_REPLY_MARKER) || /\bNO_REPLY\b/.test(text) || /^\s*\[\[NO/.test(text)
}

/**
 * 一条群消息在历史里留下的东西。
 *
 * 只留判定需要的两样：发生时间，以及**它有没有提到人格**。
 * 不留全文是刻意的：历史会随群数量增长，而"语境"只问"话题还在不在人格身上"，
 * 不需要把群友的聊天内容一直留在内存里。
 *
 * @typedef {object} GroupHistoryEntry
 * @property {number} at - 毫秒时间戳。
 * @property {boolean} persona - 这条消息有没有提到人格名。
 */

/**
 * 关键词 / 人格名列表的分隔符。
 *
 * 中英文逗号、顿号、换行都认：用户在设置页里用哪种都行，而**不该因为用了顿号就静默失效**。
 */
const LIST_SEPARATOR = /[,，、\n]/

/**
 * 把设置页里的逗号分隔字符串拆成一个去重列表。
 *
 * @param value - 设置值。
 * @returns 去掉空白与空项、去重后的列表。
 */
export function parseList(value) {
  if (typeof value !== 'string') return []
  const seen = new Set()
  for (const part of value.split(LIST_SEPARATOR)) {
    const item = part.trim()
    if (item !== '') seen.add(item)
  }
  return [...seen]
}

/**
 * 把"每行一句"的文本拆成非空行。
 *
 * 与 {@link parseList} 分开：短句里本来就可能带逗号（「哼，才不是呢」），
 * 用逗号拆会把它拆成两句。
 *
 * @param value - 设置值。
 * @returns 非空行。
 */
export function parseLines(value) {
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 去掉正文里的 @ 标记。
 *
 * QQ 的正文里可能残留 `<@!123456>` / `<@123456>` 这类标记，而 `mentions` 数组
 * 才是权威的 @ 信息。留着标记会让"人格名匹配"看到一个混着 id 的字符串，
 * 也会让交给 agent 的正文莫名其妙——所以统一在这里剥掉。
 *
 * @param text - 原始正文。
 * @returns 剥掉标记、压缩空白后的正文。
 */
export function stripMentions(text) {
  return String(text ?? '')
    .replace(/<@!?[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 这条群消息是不是 @ 了机器人。
 *
 * 两个来源都要认：
 * - `rawEventType === 'GROUP_AT_MESSAGE_CREATE'`：平台明确告诉我们这是一条 @ 消息；
 * - `mentions[].is_you === true`：正文里 @ 的是"你"。
 *
 * ⚠️ **不认 `mentions[].bot === true`**：群里可能同时有别的机器人，@ 它不该让我们开口。
 *
 * @param message - SDK 归一化后的入站消息。
 * @returns 是否 @ 了本机器人。
 */
export function isBotMention(message) {
  if (message?.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true
  const mentions = message?.mentions
  return Array.isArray(mentions) && mentions.some((mention) => mention?.is_you === true)
}

/**
 * 像在提问吗。
 *
 * 只用来区分"点名提问"（值得交给 agent）与"随口叫一声"（自动接一句就够）。
 * 问号、疑问词、请求词都算。刻意宽松：把它交给 agent 的代价是多花一次模型调用，
 * 而把一个问题当随口叫一声的代价是**答非所问**，后者更糟。
 */
const QUESTION_CUE =
  /[?？]|吗|呢|怎么|为什么|为啥|如何|是不是|能不能|可不可以|要不要|有没有|在不在|在吗|你觉得|你说呢|帮我|请问/

/**
 * 像一句"接得住的话"吗。
 *
 * 语境接话用：群里刚聊过人格，紧接着有人笑、有人惊讶、有人追问——这种时候接一句
 * 是自然的。反过来，一条陈述句（「我今天加班」）即使前文提过人格，也不该被接。
 *
 * 覆盖：笑声、感叹、短促附和、追问。
 */
const CONTEXT_CUE =
  /^[哈嘿嘻呵嗯哦啊呀诶欸哎唉呜哇嗷嘤草6]+\s*[。！!…~～]*$|哈哈|笑死|绷不住|好耶|绝了|真的假的|什么意思|啥意思|可爱|笨蛋|太[强棒好]|牛[啊哇]|[?？]\s*$/

/**
 * 找到正文里第一次出现的人格名。
 *
 * @param text - 剥掉 @ 标记的正文。
 * @param names - 人格名列表。
 * @returns 命中的名字，没命中时 `undefined`。
 */
export function findPersona(text, names) {
  return names.find((name) => name !== '' && text.includes(name))
}

/**
 * 决定一条群消息该怎么处理。
 *
 * 纯函数：不读时间、不读全局状态。`history` 由运行时维护，`now` 由调用方给，
 * 所以这个判定可以用固定时间做穷举测试。
 *
 * @param params.message - SDK 归一化后的入站消息。
 * @param params.settings - 运行时设置（只读 `group*` 几项）。
 * @param params.history - 这个群最近的消息（**不含当前这条**），旧到新。
 * @param params.now - 当前时间。
 * @param params.followUpUntil - 「@ 后的连续对话」窗口截止时间；没开窗时 `undefined`。
 * @returns `{ action: 'agent'|'auto'|'ignore', reason: string, text?: string, persona?: string, keyword?: string }`
 */
export function decideGroupMessage({ message, settings, history = [], now = Date.now(), followUpUntil }) {
  const text = stripMentions(message?.content)

  if (settings.groupChatEnabled !== true) {
    return { action: 'ignore', reason: '群聊未开启' }
  }
  // 别的机器人发的消息一律不接：它可能正在和我们对喊。
  if (message?.senderIsBot === true) {
    return { action: 'ignore', reason: '发送者是机器人' }
  }

  const personas = parseList(settings.groupPersonaNames)
  const keywords = parseList(settings.groupAutoSpeakKeywords)
  const persona = findPersona(text, personas)
  const keyword = keywords.find((word) => word !== '' && text.includes(word))

  /*
   * 语境：最近 `groupContextWindowMs` 内，有人提到过人格。
   *
   * 只看时间窗，不看条数：一个安静的群两小时前的消息不该让现在一句「哈哈」触发接话，
   * 而一个热闹的群十条消息可能只过了十秒。时间才是"话题还在不在"的度量。
   */
  const windowMs = settings.groupContextWindowMs
  const recentPersona = history.some(
    (entry) => typeof entry?.at === 'number' && now - entry.at <= windowMs && entry.persona === true,
  )

  // @ 永远优先，且不受"自动接话"开关影响——这是用户明确要的“及时发言”。
  if (isBotMention(message)) {
    return { action: 'agent', reason: '被 @', ...(persona === undefined ? {} : { persona }) }
  }

  /*
   * ★ @ 后的连续对话窗口。
   *
   * 被 @ 过一次之后的 `groupFollowUpWindowMs` 内，**不需要再 @，也不再按关键词/人格筛**：
   * 每一条文字消息都交给 agent，由它自己判断"这条是不是在跟我说、要不要回答"。
   * 用户明确要的是「分析每一条消息并决定是否回答」，所以这一支不再看 persona/keyword。
   *
   * 三个刻意的边界：
   * - **窗口不滑动**：只有新的 @ 才会续期，聊天本身不会。否则一个热闹的群会把窗口
   *   无限延长，等于永远在应答。
   * - **空正文不算**：纯图片/贴纸没有话说，不触发一轮模型（@ 带图仍然会）。
   * - **仍然不接别的机器人**（上面的检查已经拦掉）。
   */
  if (
    typeof followUpUntil === 'number' &&
    now < followUpUntil &&
    text !== '' &&
    (settings.groupFollowUpWindowMs ?? 0) > 0
  ) {
    return {
      action: 'agent',
      reason: '被 @ 后的连续对话',
      followUp: true,
      ...(persona === undefined ? {} : { persona }),
    }
  }

  if (persona !== undefined && QUESTION_CUE.test(text)) {
    return { action: 'agent', reason: `点名「${persona}」并提问`, persona }
  }

  if (settings.groupAutoSpeak !== true) {
    return { action: 'ignore', reason: '自动接话已关闭' }
  }

  if (persona !== undefined) {
    return { action: 'auto', reason: `点名「${persona}」`, persona, ...(keyword === undefined ? {} : { keyword }) }
  }

  if (keyword !== undefined && recentPersona) {
    return { action: 'auto', reason: `关键词「${keyword}」+ 前文提到人格`, keyword, text }
  }

  if (recentPersona && CONTEXT_CUE.test(text)) {
    return { action: 'auto', reason: '语境接话', text }
  }

  return { action: 'ignore', reason: '没有提到人格' }
}

/**
 * 群聊消息交给 agent 时附在渠道说明后面的那一段。
 *
 * 三件事必须说清楚，每一件都对应一种会出错的默认行为：
 *
 * 1. **这是群**，不是一对一——否则 agent 会用私聊的口吻对所有人说话；
 * 2. **是谁说的**——否则它回答「你好」时不知道在跟谁打招呼；
 * 3. **只回应这一条**——群里的话不都是对它说的，它不该顺手评论别的消息。
 *
 * @param params.groupId - 群 openid。
 * @param params.senderName - 发送者昵称，可能为空。
 * @param params.senderId - 发送者 openid，昵称为空时用它兜底。
 * @param params.persona - 群里的人格名；没人格名时用中性说法。
 * @param params.followUp - 是否处于「@ 后的连续对话窗口」。
 * @param params.history - 这个群最近的消息，旧到新（只取最后几条进提示词）。
 * @returns 一段中文说明。
 */
export function groupPromptNote({
  groupId,
  senderName,
  senderId,
  persona,
  followUp = false,
  history = [],
}) {
  const who = (typeof senderName === 'string' && senderName.trim() !== '' ? senderName.trim() : '') ||
    String(senderId ?? '').slice(0, 8) ||
    '群友'
  const shortGroup = String(groupId ?? '').slice(0, 8) || '未知'
  const self = typeof persona === 'string' && persona !== '' ? `「${persona}」` : '群里的人格'
  const base =
    `[群聊] 这是 QQ 群（${shortGroup}…）里的一条消息，发送者是「${who}」。` +
    `你在群里的人格是${self}。群里的话不一定是对你说的；这一次只回应这条消息，` +
    '不要评论群里其它内容。回答要短、口语化，不要用 markdown。'
  const context = formatGroupHistory(history)
  if (!followUp) return context === '' ? base : `${base}\n\n${context}`
  /*
   * 连续对话窗口里，门禁交给模型。
   *
   * 这一段必须把"判断"和"不回答怎么写"都说死：只说"自己判断"时，模型倾向于
   * 还是回一句「好的」；而"不需要就什么都不说"在这里等于随机行为。给它一个明确的
   * 标记，运行时才能可靠地把整条回复丢掉。
   */
  return (
    `${base}\n\n` +
    (context === '' ? '' : `${context}\n\n`) +
    '[连续对话] 你刚被 @ 过，现在处于连续对话窗口。**先判断这条消息是否需要你回应**：' +
    '是在对你说、在问你、或需要你参与 —— 就正常回答；和你无关、只是群友之间的闲聊 —— ' +
    `就只输出 ${NO_REPLY_MARKER}，不要输出任何其它文字。`
  )
}

/** 最近几条群消息进提示词。 */
const GROUP_HISTORY_PROMPT_LINES = 8

/** 每条历史最多保留多少字（防止一条长文把上下文吃掉）。 */
const GROUP_HISTORY_PROMPT_CHARS = 120

/**
 * 把最近几条群消息排成提示词里的一段。
 *
 * 这是「仿真群友」最省 token 的一半：不额外调一次模型去判断上下文，
 * 只把**已经收到过的**消息附在本次提示词里，让 agent 自己看到前因后果。
 *
 * @param history - `{ sender, text, at, persona }` 的数组，旧到新。
 * @returns 一段 `[群聊最近消息] …`，没有历史时为空串。
 */
export function formatGroupHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const lines = history
    .slice(-GROUP_HISTORY_PROMPT_LINES)
    .map((entry) => {
      const sender = typeof entry?.sender === 'string' && entry.sender.trim() !== '' ? entry.sender.trim() : '群友'
      const raw = typeof entry?.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim() : ''
      if (raw === '') return ''
      const text = raw.length > GROUP_HISTORY_PROMPT_CHARS ? `${raw.slice(0, GROUP_HISTORY_PROMPT_CHARS)}…` : raw
      return `${sender}: ${text}`
    })
    .filter((line) => line !== '')
  if (lines.length === 0) return ''
  return `[群聊最近消息]\n${lines.join('\n')}`
}

/**
 * 挑一句接话短句。
 *
 * 避免连续两次挑到同一句：重复是"机器人"最明显的破绽。
 *
 * @param lines - 候选短句。
 * @param previous - 上一次发的那句。
 * @param random - 0..1 的随机数来源（测试注入）。
 * @returns 挑中的短句；没有候选时 `undefined`。
 */
export function pickSpeakLine(lines, previous, random = Math.random) {
  if (lines.length === 0) return undefined
  const pool = lines.length > 1 ? lines.filter((line) => line !== previous) : lines
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length))
  return pool[index]
}

/**
 * 挑一个表情包 emoji。
 *
 * @param emojis - 候选 emoji。
 * @param random - 0..1 的随机数来源。
 * @returns 挑中的 emoji；没有候选时 `undefined`。
 */
export function pickEmoji(emojis, random = Math.random) {
  if (emojis.length === 0) return undefined
  const index = Math.min(emojis.length - 1, Math.floor(random() * emojis.length))
  return emojis[index]
}
