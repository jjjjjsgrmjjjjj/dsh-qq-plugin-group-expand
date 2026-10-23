/**
 * `session_control` 工具：让 agent 用**自然语言**驱动会话切换。
 *
 * 移植自 `dsh-wechat/packages/bundle/src/host.ts`（同版本、已在生产验证）。
 *
 * ## 为什么确认策略写在"工具描述"里
 *
 * 微信的原话：**决策权在 agent**——只有它知道用户是不是真的要求了切换。
 * 把规则写在描述里，才能让这个设置生效而**不需要多一次往返**。
 * 也正因如此，设置一变就必须**重新注册**工具：注册表是按值取走描述的。
 *
 * ## 为什么切换结果由频道自己发声，而不是靠 agent 转述
 *
 * 两条都是微信踩出来的：
 *
 * 1. **成功**必须由频道说，因为 **agent 的话会被发到聊天刚刚离开的那个会话**，
 *    而那个会话已经不再代表这个对话了。
 * 2. **失败**更必须说：日志显示工具返回 `ok: false`，agent 却告诉用户
 *    「已切过去了，直接说你想问的就行」——一个从未发生过的移动，
 *    用户只有在下一条消息落进旧对话时才发现。
 *
 * ## 为什么列表也由频道自己发
 *
 * 微信日志里的代价：工具跑了、行也回来了，agent 回答「已为你列出对话列表，请看上面的消息」——
 * 指向一条**从不存在的消息**（工具结果只给 agent 看）。它后来自己编了一份列表，
 * 格式自创、没有其它工作区、也没有用户本该回复的编号。
 *
 * @module dsh-qq/session-tool
 */
// 工具 → router 是**单向**的（router 不 import 本文件），所以标题的裁法可以直接共用。
// 抄一份就是给下一次漂移留位置，而这里曾经抄漏了"压空白 + 裁到 24 字"。
import { truncateTitle } from './router.js'

/**
 * 本工具在宿主里的名字。
 *
 * ⚠️ **必须带 `qq_` 前缀，这不是风格问题。**
 *
 * 宿主作用域下 `ctx.tools.register` 的名字是**全局唯一**的：重名会抛
 * `tool "X" is already registered`，那次注册就此失败——只留一行错误，功能**静默不可用**。
 *
 * 而 `dsh-wechat-plugin` 也注册了一个叫 **`session_control`** 的工具，
 * 且它的 bundle 排在 `dsh-qq-plugin-group-expand` 前面。用同名时**先到者胜**，
 * QQ 的自然语言会话控制永远不会生效。实测到的报错：
 *
 * ```
 * 注册 session_control 失败: tool "session_control" is already registered
 * ```
 *
 * `send_to_qq` / `notify_qq` 没这个问题，是因为微信用的是
 * `send_to_wechat` / `notify_wechat`——名字里的目标本来就分开了。
 */
export const TOOL_NAME = 'qq_session_control'

/**
 * 构建工具描述。
 *
 * @param requireConfirmation - 用户是否希望动作先经确认。
 * @returns 要注册的描述文本。
 */
export function sessionToolDescription(requireConfirmation) {
  const base =
    'Manage which QQ conversation (session) this channel is talking to. Call this whenever the ' +
    'user asks to see their conversations, switch between them, start a new one, find out which ' +
    'one is in use, or stop what is running — in any wording. Do not merely describe these ' +
    'actions in a reply; call the tool. The user is on a phone and cannot see the desktop ' +
    'session list. ' +
    // 频道自己宣布移动，而切换之后只有它的话能到达聊天。在此之上再叠一句 agent 的总结
    // 就是第二条冗余消息。失败同理，而且那里更要紧：日志显示工具返回 ok:false，
    // agent 却告诉用户切换成功了。
    'Switching and creating are announced to the user by the channel — including when they fail — so ' +
    'do not repeat that outcome either way. Never tell the user a switch or a new conversation ' +
    'succeeded; read the result\'s `ok` field and, if it is false, say nothing about it because the ' +
    'channel has already told them what went wrong. ' +
    // 会话清单分两层，agent 必须说得出它刚才展示了什么：本工作区的会话，还是工作区本身。
    // 说话的人从来不打 `/list all`，所以这里的措辞比打字那一侧更要紧。
    'The list has two levels: action "list" shows this channel\'s own conversations, and target "all" ' +
    'shows the workspaces on the machine, each with how many conversations it holds. Both are paged ' +
    'ten rows at a time with numbering that runs on across pages, and the user walks them by replying ' +
    'to the channel itself — a number, a name, or 「查看其余」 for the next ten — so do not try to ' +
    'carry that on yourself. Any conversation in any workspace can be switched to, whichever ' +
    'workspace it is in. ' +
    // 模型：列出与切换同用一个 action，靠有没有 target 区分；等级是同一个选择的后一半，
    // 所以走的是同一个 action（`level` 单独一个参数）。措辞与指令一侧（/model）对应。
    'Models: action "model" without a target lists the models this conversation can use, and action ' +
    '"model" with a target switches which model serves it. Each model is listed with its reasoning ' +
    'levels, and action "model" with a level changes how hard the model thinks — with a target it ' +
    'switches the model and the level together, without one it changes the level of the model in use. ' +
    'The channel sends both the list and the ' +
    'switch outcome to the user itself, so do not repeat them. A switch applies from the next step, ' +
    'so changing the model mid-conversation is expected to work — never tell the user a model switch ' +
    'was applied to work that is already running.'
  if (requireConfirmation) {
    return (
      `${base} IMPORTANT: before acting, state what you are about to do and wait for the user to ` +
      'agree; only then call this tool. The exceptions are action "list" and action "model" with ' +
      'neither a target nor a level — both only read state and change nothing, so they may be called ' +
      'straight away.'
    )
  }
  return `${base} The user has turned confirmation off, so act on the request directly.`
}

/**
 * 告诉用户会话操作**成功了**。
 *
 * 由频道写而不是 agent 写，因为这是用户必须看到的一件事：看完之后，
 * 他的下一条消息要去别的地方了。交给 agent 提一句在实践中会变成沉默，
 * 而且 agent 的话会被投递到聊天刚刚离开的那个会话。
 *
 * 标题取自绑定而不是用户输入，因为他们通常给的是数字（「换 2」），
 * 而数字不是他们需要看到被确认的东西。
 *
 * @param action - `'switch'` 或 `'new'`。
 * @param resolvedTitle - 对话现在所在的会话标题。
 */
export function switchConfirmation(action, resolvedTitle) {
  const title = resolvedTitle.trim()
  if (action === 'new') {
    return title === ''
      ? '已新建对话，从现在起你的消息发到这里。'
      : `已新建对话「${title}」，从现在起你的消息发到这里。`
  }
  return title === '' ? '已切换对话。' : `已切换到「${title}」。`
}

/**
 * 告诉用户会话操作**没有成功**。
 *
 * 理由同上，而且更迫切：没有它，agent 就可以报告一个它从未做过的移动——
 * 失败的切换是唯一一种"聊天里什么都没变、用户无从分辨"的结果。
 *
 * @param action - `'switch'` 或 `'new'`。
 * @param target - 用户要求的目标，好让消息把它念回去。
 * @param reason - 路由自己的解释，其第一行就是用户该看的。
 */
export function switchFailure(action, target, reason) {
  const headline = reason.split('\n')[0]?.trim() ?? ''
  const what =
    action === 'switch'
      ? target === undefined || target === ''
        ? '切换对话'
        : `切换到「${target}」`
      : '新建对话'
  return `${what}没有成功。${headline}\n\n发「/list」看清单，直接回数字也能切。`
}

/**
 * 用 agent 该看到的形式渲染会话行。
 *
 * 每一行都过 core 自己的渲染器，所以"说出来的请求"与"打出来的 `/list`"
 * 发出去的东西**逐字节同形**——一份实现、两个调用者、没有第三种格式让用户去对。
 * 标题的裁法两边共用同一份（`router.truncateTitle`），见下面的 `renderRow`。
 *
 * 编号取**行自己带的那个**（`row.index`）：会话清单分两层、每屏十条，
 * 编号跨屏连续，所以第二屏的第一行是 11 而不是 1。没有 `index` 的行按位置编号，
 * 那是"一份从 1 开始的清单"的形态，也是工具在还没拿到路由编号时的落点。
 *
 * @param sessions - 已经编好号的行。
 * @param currentId - 本对话绑定的会话，在列表里标出。
 * @param now - 当前时间，可注入以便测试，也让一次渲染里的每一行对"3 分钟前"看法一致。
 */
export function renderTable(sessions, currentId, now = Date.now()) {
  return sessions.map((row, index) => renderRow(row, index, currentId, now)).join('\n')
}

/**
 * 渲染一行。**必须与 `router.renderSessionRow` 同形**——两者共用同一份契约。
 *
 * 标题走 `router.truncateTitle`（**唯一实现**，不在此重抄）。这一处曾经抄漏过：
 * 这里只 `trim()`，而 router 那边还压空白、裁到 24 字并加省略号。差别不只是"不好看"——
 * 标题里一个换行就让这张表里的一条会话占两行，agent 于是对"第 4 个是哪个会话"的判断
 * 与用户屏幕上的第 4 行不一致，而"agent 报的编号与用户看到的同编号"正是这张表存在的理由。
 * 制表符同理（会把列打乱）。
 *
 * 时间与短 id 仍是两份手抄的实现，改动其一务必同步另一处；
 * `scripts/verify.mjs` 里有一条断言钉着两者逐字一致，输入里带着超长/带换行/带制表符的标题，
 * **行数也是那条断言的一部分**。
 */
function renderRow(session, index, currentId, now) {
  const number = Number.isFinite(session.index) ? session.index : index + 1
  const mark = session.sessionId === currentId ? ' ← 当前' : ''
  const title = truncateTitle(session.title ?? '')
  const when =
    session.updatedAt === undefined || !Number.isFinite(session.updatedAt) || session.updatedAt <= 0
      ? ''
      : ` · ${relativeTime(session.updatedAt, now)}`
  return `${number}. ${title}${when}${mark}  ${shortId(session.sessionId)}`
}

/** 与 `router.relativeTime` 同形；同上，靠断言钉住一致。 */
function relativeTime(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

/** 与 `router.shortId` 同形；同上。 */
function shortId(sessionId) {
  const match = /^session-([0-9a-f]+)-/i.exec(sessionId)
  if (match) return match[1].slice(0, SHORT_ID_LENGTH)
  return sessionId.replace(/^session-/, '').slice(0, SHORT_ID_LENGTH)
}

/** 与 `router.SHORT_ID_LENGTH` 同值：印出来的 id 长度。 */
const SHORT_ID_LENGTH = 6

/**
 * 用户认得出某工作区的名字。
 *
 * 存储里记的是绝对路径，而聊天消息里塞一条完整路径是噪声。
 * 最后一段正是桌面端侧边栏显示的东西，所以那才是用户认得出的。
 *
 * @param path - 为某条会话记录的 cwd。
 */
export function workspaceLabel(path) {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

/**
 * 构造 `session_control` 的工具定义。
 *
 * @param options.requireConfirmation - 是否要求先确认。
 * @param options.control - `(action, target, exec) => Promise<result>`。
 * @param options.log - 记录一行日志的回调。
 * @returns 传给 `tools.register` 的定义。
 */
export function sessionToolDefinition({ requireConfirmation, control, log }) {
  return {
    name: TOOL_NAME,
    description: sessionToolDescription(requireConfirmation),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'switch', 'new', 'current', 'cancel', 'model'],
          description:
            'list: show every conversation with its number. switch: move this QQ conversation to an existing one. new: start a fresh one. current: report which one is in use. cancel: interrupt the work running in it. model: list the available models, or switch to one when target names it — add a level to change how hard it thinks.',
        },
        target: {
          type: 'string',
          description:
            'For switch, the conversation to move to: its number from list, or its title. For new, an optional title. For list, the literal "all" shows conversations from every workspace, not just this channel\'s own. For model, the model to switch to — its name, id, or its number from the model list; omit it to list the models instead.',
        },
        level: {
          type: 'string',
          description:
            'Reasoning level for action "model", spelled exactly as the model list prints it (for example "high"). With a target, the model and the level change together; without one, only the level of the model in use changes. Omit it to leave the level alone.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string' },
          ok: { type: 'boolean' },
          otherWorkspaces: { type: 'number' },
        },
        required: ['detail', 'ok'],
      },
      render: (args) => [{ type: 'text', text: `session_control ${String(args.action ?? '')}` }],
    },
    execute: async (args, exec) => {
      const target = args.target === undefined ? undefined : String(args.target)
      const level = args.level === undefined ? undefined : String(args.level)
      const result = await control(String(args.action ?? ''), target, level, exec)
      log(
        `session_control: action=${String(args.action)} target=${String(target ?? '')} ` +
          `level=${String(level ?? '')} ok=${String(result.ok)}`,
      )
      // 行被附加进去，好让 agent 能在同一个回合里就刚才描述的编号选项发问，
      // 这正是「切到那个周报的」一次就成的关键。
      const rows = renderTable(result.sessions, result.sessions.find((row) => row.current)?.sessionId)
      return {
        detail: rows === '' ? result.detail : `${result.detail}\n\n${rows}`,
        ok: result.ok,
        otherWorkspaces: result.otherWorkspaces,
      }
    },
  }
}
