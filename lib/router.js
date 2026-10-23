/**
 * 会话路由：一个 QQ 私聊映射到一个 DSH 会话，用户用聊天内指令在它们之间切换。
 *
 * 从 `dsh-wechat/packages/core/src/router.ts` **逐函数移植**。为什么用指令而不是选择器：
 * QQ 给频道的也只有一个聊天界面，所以会话列表必须活在消息流里。指令在每个客户端上今天就能用。
 *
 * 会话 id 由本模块按 DSH 自己的格式（`session-<8位hex>-<uuid>`）铸造，
 * 中间的 8 位前 6 位既是 `/list` 打印的短 id，也是 `/switch` 接受的输入——
 * 两者一致才能用手机键盘切换。
 *
 * ## 会话清单分两层，每屏 10 条（照搬微信）
 *
 * `/list` 直接进本工作区那一层，`/list all` 进**会话夹**那一层；两层都用「查看其余」
 * 往下翻十条，编号**跨屏连续**（1–10，然后 11–20）。这取代了原来"一份扁平清单切一刀"的做法：
 * 切掉的那些会话是存在的，却够不着，而数出它们的那句话是它们存在过的唯一证据。
 *
 * 编号会过期（用户读清单时会话还在跑），所以每行末尾带一个最多 6 个字符的短 id，
 * 而**引用那条清单消息**再回编号时，编号按那条消息印的算——
 * 为此本模块把发出去的每一屏记在浏览位置旁边（见 {@link SessionRouter#delivered}）。
 *
 * @module dsh-qq/router
 */
import { randomUUID } from 'node:crypto'
import { isSameWorkspace } from './session-index.js'

/**
 * 路由一条入站消息。
 *
 * @typedef {object} SessionBinding
 * @property {string} conversationId
 * @property {string} accountId
 * @property {string} peerId
 * @property {string} sessionId - DSH 会话 id，`session-<uuid>` 形态。
 * @property {string} title - `/list` 里显示的人类标签。
 * @property {number} createdAt
 * @property {number} lastUsedAt
 */

/**
 * 一条编号真正需要的那两个字段。
 *
 * 刻意只有这两个：编号会被写进状态文件（好让一次引用把它钉住），
 * 而它指的那一行在重启之后仍然要能切过去——标题与 id 就够做到这件事。
 *
 * @typedef {object} NumberedSession
 * @property {string} sessionId
 * @property {string} title
 */

/**
 * 一行编号，以及印在它第一行旁边的那个数字。
 *
 * 两者一起走，因为数字离开偏移就没有意义：编号跨屏连续，第二屏的十条从 11 开始，
 * 而把"13"当成第 1 行读会指到一个用户从没见过的会话。
 *
 * @typedef {object} NumberedRows
 * @property {NumberedSession[]} sessions
 * @property {number} first - `sessions[0]` 旁边印的数字。第一屏是 1，第二屏是 11。
 */

/**
 * 一个对话在两层浏览器里站的位置。
 *
 * 因为它**要被记下来**：「查看其余」没有目标，它的意思是"我正在看的那份的下十条"，
 * 而这份记录是唯一知道"我正在看哪份"的东西。按对话分别记，因为一个插件服务多个聊天。
 *
 * @typedef {object} BrowsePosition
 * @property {'folders'|'sessions'} level - `folders` 是会话夹清单，`sessions` 是某个会话夹里的会话。
 * @property {string} workspace - `sessions` 层显示的目录；空串是本频道自己的工作区。
 * @property {number} page - 最后一次显示的屏号，1 起。
 * @property {number} at - 最后一次推进的时间，好让一个被丢下的位置过期。
 */

/**
 * 一个工作区，按浏览器的第一层列出的样子。
 *
 * 是"夹"而不是"行"：第一层回答的是"哪个项目"，不是"哪个对话"，
 * 而一个对话只有选定了项目之后才够得着。
 *
 * @typedef {object} SessionFolder
 * @property {string} path - 绝对目录；空串表示本频道自己的工作区。
 * @property {string} label - 清单里印的、也是进入时接受的名字。
 * @property {number} count - 里面的会话数，好让用户分得清自己在用的项目和不在用的。
 */

/**
 * 一个对话绑定的那条会话还能不能收活。
 *
 * 三种答案，因为从手机上看起来**完全一样**的两种失败其实是两回事：
 *
 * - `archived`：会话**还在磁盘上**，`prompt` 也照常"接受"——归档不是磁盘标记，
 *   DSH 把这件事记在工作区注册表里，然后拒绝提示词提出的那个**步骤**，
 *   于是回合以 `blocked` 结束：**没有错误、没有日志、用户什么都没收到**。
 * - `missing`：磁盘上根本没有这条会话的记录，提示词落进空处。
 * - `usable`：可以照常复用。
 *
 * 两种失败都表现为"消息被无声吞掉"，而这个词汇存在的意义就是把那种沉默**说出名字**。
 *
 * @typedef {'usable'|'archived'|'missing'} SessionState
 */

/**
 * 一条绑定必须存在多久，`missing` 这个判定才可信。
 *
 * 这不是讲究，是一次**实盘代价**换来的（微信报告者踩出来的）：第一版只要探针回答 `missing`
 * 就换绑，机器上立刻出现**无限新建会话**——会话在**第一个回合写下记录之前磁盘上什么都没有**，
 * 于是每条消息都把刚创建的那条判成 missing，再建一条。用户看到的是"每条消息一个新对话"。
 *
 * 区分"记录还没写"和"真的没了"的是**绑定自己的年龄**：绑定先于会话的首个提示词建立，
 * 所以年轻绑定的无记录是**预期之内**的，而一条老的绑定仍然没有记录，那才是被删掉的会话。
 * 两分钟远长于首次写入所需，又短到被删的会话能在用户本来会丢掉消息的那次交互里修好。
 *
 * `archived` **刻意不受这个宽限期约束**：归档集合住在工作区注册表里，它立刻就能回答，
 * 而且完全不知道记录写没写——这里没有竞态要容忍，而一条被归档的会话也不会因为等待而变得可用。
 */
export const MISSING_BINDING_GRACE_MS = 2 * 60 * 1000

/**
 * 本路由需要宿主提供的会话面。
 *
 * 保持窄接口意味着路由规则**不用启动 DSH 就能单测**，同时也写明了频道依赖哪些宿主调用。
 *
 * 每一行会话可以带一个 `workspace`（它自己的工作目录）：`/list all` 的会话夹就是按它分组的。
 * 没有这个字段的行算本频道自己的——那是只有一个对话能为之背书的工作区。
 *
 * ## `sessionState`（**可选**）
 *
 * 一条对话已经绑定的那条会话还能不能收活。
 *
 * 必须**在复用一条既有绑定之前**问一次——因为两种死法在下游全都是静默的：
 * 提示词被接受，然后永远没有回答，而没有任何一层记下一个字。
 * 只有在这里、在复用之前问，频道才有机会分辨"能用的会话"和"会把消息吞掉的会话"。
 *
 * ⚠️ **可选，而且没有它时路由的行为与加它之前完全一样。** 答不出来的宿主不该让用户丢消息，
 * 所以探针缺席**不是错误、也不是换绑的理由**——绑定照旧复用。
 *
 * 探针抛错一律按 `usable`：**抛错不是判定**。坏掉的探针弄丢用户的消息，
 * 比一条过期的绑定严重得多。两种情况都会写一行诊断。
 *
 * @name SessionGateway#sessionState
 * @function
 * @param {string} sessionId - 正要被复用的那条会话。
 * @returns {Promise<SessionState>} 三种判定之一。
 */
export class SessionRouter {
  #gateway
  #store
  #titlePrefix
  #ownWorkspace
  #ownWorkspaceLabel
  #onDiagnostic
  #bindings
  /** 浏览位置与已发出的编号清单，见 {@link SessionRouter#delivered}。 */
  #routeState
  /** 进行中的加载；并发路由共享它，免得两次读各建一份状态。 */
  #routeLoading

  /**
   * @param options.gateway - 宿主会话接口。
   * @param options.store - 绑定持久化。可选实现 `loadRouteState()` / `saveRouteState(state)`，
   *   给了就把浏览位置与编号清单一起存起来（重启后「查看其余」与引用仍然有效）；
   *   没给就只活在内存里。
   * @param options.titlePrefix - 自动生成会话标题时用的前缀。
   * @param options.ownWorkspace - 本频道自己的会话目录，用来决定哪些行属于"本工作区"。
   * @param options.ownWorkspaceLabel - 本工作区在清单里的标题。
   * @param options.onDiagnostic - 记一行日志；路由自己不能写日志（core 不 import 宿主）。
   */
  constructor(options) {
    this.#gateway = options.gateway
    this.#store = options.store
    this.#titlePrefix = options.titlePrefix ?? 'QQ'
    this.#ownWorkspace = options.ownWorkspace
    this.#ownWorkspaceLabel = options.ownWorkspaceLabel ?? 'QQ 会话'
    this.#onDiagnostic = options.onDiagnostic
  }

  /**
   * 路由一条入站消息。
   *
   * @param params.conversationId - 稳定的对话键。
   * @param params.accountId - 消息到达的机器人账号。
   * @param params.peerId - 对方用户 id。
   * @param params.text - 消息文本（**不含引用的正文**，见 `params.quoted`）。
   * @param params.quoted - 被引用消息的正文，若这条消息引用了一条。
   *   QQ 的引用直接给正文（`prompt.js` 的 `quotedText`），所以"引用一屏清单再回编号"
   *   靠比对正文来认出那一屏——比微信的引用 id 更直接，但需要正文够长。
   * @param params.heldHint - "其余的在哪"那句话的措辞；打字与说话要用不同的说法。
   * @returns `{ kind: 'reply', text }` 直接回复（可能带 `numbered` / `browse`），
   *   或 `{ kind: 'prompt', decision }` 交给会话。
   */
  async route(params) {
    const text = params.text.trim()
    const routeState = await this.#loadRoute()
    /*
     * 编号的来源在这里定一次，两个入口共用：
     * 引用里的那一屏（用户指着它说"第 3 个"），否则本对话最近收到的那一屏。
     * 都没有时是 `undefined`，`#switchTo` 会退回**活**的本工作区清单——旧行为，也是仅剩的答案。
     */
    const numbered =
      params.numbered === undefined
        ? this.#numberedFor(routeState, params.conversationId, params.quoted)
        : params.numbered
    const routed = { ...params, numbered }

    if (text.startsWith('/')) return await this.#command(routed, text)

    /*
     * 清单就在眼前时，回一个编号、名字或行尾 id 就是对它的回答，不必打 `/switch`。
     *
     * 必须在这里决定，因为浏览位置是频道自己的账本：agent 看到「2」无从判断
     * 那是会话夹、会话，还是它刚提的问题的答案。本路由知道，所以由它决定；
     * 而当这条消息根本不构成"一步"时返回 `undefined`，一句普通搭话照旧交给 agent。
     */
    if (text !== '') {
      const position = await this.#liveBrowse(routeState, params.conversationId)
      if (position !== undefined) {
        const browsed = await this.#browseReply(routed, text, position)
        /*
         * ★ 把这一步的判定记下来。
         *
         * 加它的原因是一次真实的排查失败：用户报「/list all 之后回 1 没反应」，
         * 而日志里**一个字都没有**——路由不记成功的操作，也不记"认不出来"。
         * 于是"消息没到"、"位置过期"、"没匹配上"三种完全不同的原因，
         * 在日志里长得一模一样：**一片空白**。
         *
         * 加上这一行之后，那个问题一眼可辨：
         *   - 没有这行 → 消息压根没进路由（或位置不存在）
         *   - `不是一个选择` → 匹配失败，而这正是"没反应"的成因
         *   - `→ 回复` → 路由答了，那问题就在送达
         */
        this.#diagnose(
          browsed === undefined
            ? `browse: 站在 ${position.level} 第 ${String(position.page)} 页，「${text}」不是一个选择 → 交给 agent`
            : `browse: 站在 ${position.level} 第 ${String(position.page)} 页，「${text}」→ 已回复`,
        )
        if (browsed !== undefined) return browsed
      }
    }

    const bindings = await this.#load()
    let binding = bindings[params.conversationId]
    let created = false
    /** 换过绑定时要先说给用户听的那句话；没换就是 `undefined`。 */
    let notice
    if (binding === undefined) {
      /*
       * 创建时**显式给出会话标题**，由用户自己的话推导（`deriveSessionTitle`）。
       *
       * 不给的话宿主会拿首条消息的措辞当标题（`fallbackSessionTitle`），而那条消息是
       * 频道拼出来的：用户的话 + 附件描述 + 渠道说明——标题里会混进渠道说明。
       * 这里给的是 `text`（用户这一条，已经 trim），语义与宿主那条回退一致。
       *
       * 推导不出东西时（只有附件、没有文字）传 `undefined`：那时确实没有可命名的
       * 用户措辞，让宿主自己从首条消息取比我们编一个强。⚠️ 那条消息的第一行是附件描述
       * （那正是用户唯一给的东西），而它**后面还跟着渠道说明**——所以这种情况也就是
       * "只发一张图、一个字都没打"时，标题仍可能沾上说明的开头。要用附件描述当标题，
       * 就得把附件行也交到这里来（现在只交正文），那是另一次改动。
       */
      binding = await this.#bind(params, deriveSessionTitle(text) || undefined)
      created = true
    } else {
      /*
       * ★ 复用这条绑定之前，先问一句它绑的那条会话还活着没有。
       *
       * 两种死法从这里往下都是**静默**的：归档的会话照常接受提示词、然后它提出的**步骤**
       * 被壳的门卫拒掉（回合以 `blocked` 结束），而磁盘上没有的会话什么都收不到。
       * 用户看到的是一句话都没回、日志里一个字都没有——这正是这个检查存在的理由。
       */
      const dead = await this.#deadState(binding)
      if (dead !== undefined) {
        /*
         * 死掉的绑定是**换掉**，不是修、也不是取消归档。
         *
         * 对话必须继续能用，而唯一确定还能用的一条会话就是本频道自己新建的那条；
         * 取消归档等于插件伸手去推翻用户在桌面端做的决定，而磁盘上被删掉的会话
         * 已经没有东西可修。`/switch` 仍然留给想把旧对话找回来的人。
         */
        const previous = binding
        binding = await this.#bind(params, undefined)
        created = true
        notice = replacedBindingNotice(previous.title, dead, binding.title)
        this.#diagnose(
          `会话状态：绑定已换 conversation=${params.conversationId} ` +
            `from=${previous.sessionId} to=${binding.sessionId} state=${dead} ` +
            `bindingAge=${String(Math.round((Date.now() - previous.createdAt) / 1000))}s`,
        )
      } else {
        // DSH 可能在这条绑定之后重启过；交提示词之前先确保会话还活着。
        // **不带标题**：采纳一条已有会话不该改名（标题只在创建那一刻给，见 `#bind`）。
        await this.#gateway.ensureSession(binding.sessionId)
      }
    }

    binding.lastUsedAt = Date.now()
    await this.#store.save(bindings)

    return {
      kind: 'prompt',
      decision: {
        sessionId: binding.sessionId,
        prompt: text,
        created,
        ...(notice === undefined ? {} : { notice }),
      },
    }
  }

  /** 某对话当前绑定的会话，没有则 `undefined`。 */
  async current(conversationId) {
    return (await this.#load())[conversationId]
  }

  /**
   * 本频道自己的工作区换了（用户在设置页改了会话文件夹）。
   *
   * 必须**通知**而不是让它继续用构造时那份：`/list` 用它决定哪些会话算"本工作区自己的"，
   * 而那是它唯一能为之背书的东西。留着旧路径会把旧目录的会话说成这里的，
   * 而新目录的会话被说成别的工作区的。
   *
   * @param path - 新的工作区目录。
   */
  setOwnWorkspace(path) {
    this.#ownWorkspace = path
  }

  /**
   * 一条回复**真的到了用户手上**之后，由运行时调用。
   *
   * 与微信的分工一致：路由决定"这一屏是什么"，送达与否只有发送方知道。
   * 两件事都只在这一刻落定：
   *
   * 1. **这一屏的编号被钉在这条消息的正文上**——用户之后引用它再回编号时，
   *    编号按这条消息印的算，而不是按"现在最新的会话"重算一遍。会话在用户读清单时还在跑，
   *    所以重算出来的第 3 行完全可能是另一个会话。
   * 2. **浏览位置推到这一屏**（回复不带 `browse` 时清掉）——一个没送到的消息不该让位置前进，
   *    那会让下一次「查看其余」跳过一整屏。
   *
   * @param conversationId - 回复发往的对话。
   * @param result - {@link SessionRouter#route} 的返回值；`prompt` 表示用户已经走开，
   *   于是位置被清掉（与微信"交给 agent 的任何东西都结束浏览"同一条）。
   */
  async delivered(conversationId, result) {
    if (result?.kind !== 'reply') return await this.#trackBrowse(conversationId, undefined)
    const routeState = await this.#loadRoute()
    if (result.numbered !== undefined && result.numbered.sessions.length > 0) {
      await this.#rememberListing(routeState, conversationId, result.text, result.numbered, Date.now())
    }
    await this.#trackBrowse(conversationId, result.browse)
  }

  async #command(params, text) {
    const { command, args } = splitCommand(text)
    const bindings = await this.#load()

    switch (command) {
      case '/help':
        return { kind: 'reply', text: HELP_TEXT }

      case '/new': {
        const binding = await this.#bind(params, args || undefined)
        // 重新绑定正是 `/new` 的意义：这个对话从此**就是**新会话，
        // 否则下一条消息会落进旧会话，新会话存在却够不着。
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return {
          kind: 'reply',
          text: `已新建对话「${binding.title}」。\n${shortId(binding.sessionId)}\n\n从现在起，你的消息发到这里。`,
        }
      }

      case '/list': {
        /*
         * 两层、每屏十条。
         *
         * `/list` 直接开本工作区自己的会话——那才是人们真正要的那份清单，
         * 为了够到它先让人选一个会话夹是白加一步。`/list all` 开会话夹清单，
         * 而那是够到其余工作区的唯一一条路。
         */
        const all = await this.#gateway.listSessions()
        const own = await this.#ownSessions(all)
        const currentId = bindings[params.conversationId]?.sessionId
        const now = Date.now()

        if (args.trim().toLowerCase() === 'all') {
          const folders = this.#folders(all)
          if (folders.length === 0) {
            return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
          }
          return {
            kind: 'reply',
            text: renderFolderScreen(folders, 1),
            browse: { level: 'folders', workspace: '', page: 1, at: now },
          }
        }

        if (own.length === 0) {
          const ownIds = new Set(own.map((session) => session.sessionId))
          const held = all.filter((session) => !ownIds.has(session.sessionId))
          if (held.length === 0) {
            return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
          }
          /*
           * 没有东西可翻，于是**不留位置**：「查看其余」没有第二屏可展示，
           * 而一个永远只回"已经到底了"的位置比没有更糟。
           */
          return { kind: 'reply', text: heldOnlyList(held, this.#ownWorkspaceLabel) }
        }

        const screen = renderSessionScreen(this.#rowsIn('', all, own), {
          label: this.#ownWorkspaceLabel,
          page: 1,
          ...(currentId === undefined ? {} : { currentId }),
          ...this.#heldHintFor(own, all, params.heldHint),
        })
        return {
          kind: 'reply',
          text: screen.text,
          numbered: screen.numbered,
          browse: { level: 'sessions', workspace: '', page: 1, at: now },
        }
      }

      case '/switch': {
        // 与"在会话夹里回一个编号"共用同一段：同一个编号/名字/id，无论怎么打出来都指同一件事。
        const switched = await this.#switchTo(params, args, { mode: 'command' })
        /*
         * `mode: 'command'` 每一种结果都会回一句，所以这里到不了；
         * 它存在只是为了把这件事写进代码而不是写成断言——将来若有改动让指令解析不出结果，
         * 那时得到的是一句人话，而不是沉默。
         */
        return switched ?? { kind: 'reply', text: UNKNOWN_TARGET }
      }

      case '/model': {
        /*
         * 无参数 = 列出，有参数 = 切换或换等级。这是本项目唯一的"可选参数"指令。
         *
         * 模型是**会话级**的（宿主把它记成会话自己的 `model/selection` 事件），
         * 所以和 `/switch` `/current` 一样必须先有一条绑定；没有对话时不能凭空调模型。
         *
         * 「推理等级」这一维照搬微信（`router.ts` 的 `/model` 与 `#selectLevel`）：
         * 等级是**模型自己的属性**，所以两种写法都需要先定下一个模型——
         * 用户点名的那个（`/model 2 等级 high`），或者当前在用的那个（`/model 等级 high`）。
         * 等级名必须是清单里印的那些（本机适配器发布 `off/low/high/max`，印成 `Off/Low/High/Max`）：
         * 写 `/model 等级 高` 也解析得出等级形式，但 `resolveLevel` 只认 id 或 name，于是得到
         * 「找不到这个等级」——可用的写法以 `HELP_TEXT` 那两行为准。
         */
        const binding = bindings[params.conversationId]
        const models = (await this.#gateway.listModels?.()) ?? []
        const current =
          binding === undefined ? undefined : await this.#gateway.currentModel?.(binding.sessionId)
        const asked = parseModelCommand(args)

        // `等级` 出现即"这一句在说等级"，模型那一半可以省（省 = 当前模型）。
        if (asked.levelForm) return await this.#selectLevel(binding, models, current, asked)

        if (args === '') {
          if (binding === undefined) {
            return { kind: 'reply', text: '当前没有对话，先发一条消息再切模型。' }
          }
          return { kind: 'reply', text: renderModelList(models, current) }
        }

        const target = resolveModel(args, models)
        if (target === undefined) {
          // 有歧义与不存在走同一条回复：两者对用户的下一步动作是同一个（照清单重说一次）。
          return { kind: 'reply', text: `找不到这个模型。\n\n${renderModelList(models, current)}` }
        }
        if (binding === undefined) {
          return { kind: 'reply', text: '当前没有对话，先发一条消息再切模型。' }
        }
        if (this.#gateway.selectModel === undefined) {
          return { kind: 'reply', text: '当前组合不支持切换模型。' }
        }
        try {
          /*
           * 模型自己声明的默认等级**随选择一起交下去**（微信同一条注释）：
           * 不交的话，"用哪个等级"就交给了一个用户看不见的解析步骤，
           * 而同一个模型在不同等级上是两个不同的回答。
           */
          const selected = await this.#gateway.selectModel(
            binding.sessionId,
            target.provider,
            target.model,
            target.defaultLevel,
          )
          const name = modelLabel(selected ?? target)
          const label = levelName(selected?.reasoningEffort, target.levels ?? [])
          const lines = [`已切换模型：${name}。`]
          if (label !== undefined) lines.push(`推理等级：${label}`)
          lines.push('', '对下一步生效，正在跑的那一步不受影响。')
          return { kind: 'reply', text: lines.join('\n') }
        } catch (error) {
          // **失败必须说出来**：宿主拒绝时若照常回一句"已切换"，用户会以为生效了。
          const reason = error instanceof Error ? error.message : String(error)
          return { kind: 'reply', text: `切换模型没有成功：${reason}\n\n发「/model」看清单。` }
        }
      }

      case '/current': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话，发任意消息就会新建一个。' }
        return {
          kind: 'reply',
          text: `当前对话「${binding.title}」\n${shortId(binding.sessionId)}\n最后使用：${new Date(binding.lastUsedAt).toLocaleString('zh-CN')}`,
        }
      }

      case '/cancel': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话。' }
        await this.#gateway.cancel(binding.sessionId)
        return { kind: 'reply', text: '已请求中断当前任务。' }
      }

      default:
        return { kind: 'reply', text: `未知指令 ${command}。\n\n${HELP_TEXT}` }
    }
  }

  /**
   * 回答一条来自"正站在清单里"的对话的消息。
   *
   * 「查看其余」没有目标，所以只能对着用户站的位置来理解——这正是位置要被记下来的全部理由。
   * 编号或名字则按他所在的那一层读：第一层是会话夹，第二层是会话。
   *
   * 不是"一步"时返回 `undefined`。这是有意的、也是承重的：清单在屏幕上时敲进来的一句闲话
   * （一个问题、一条指令、对 agent 某个提问的回答）必须照旧到达 agent，
   * 所以浏览器只认领它真能解析的东西。
   *
   * @param params - 路由参数（含引用钉下的编号与调用方的措辞）。
   * @param text - 消息文本，已 trim。
   * @param position - 这个对话在浏览器里站的位置。
   * @returns 带新位置的回复，或 `undefined`。
   */
  async #browseReply(params, text, position) {
    const bindings = await this.#load()
    const all = await this.#gateway.listSessions()
    const own = await this.#ownSessions(all)
    const currentId = bindings[params.conversationId]?.sessionId
    const now = Date.now()

    if (position.level === 'folders') {
      const folders = this.#folders(all)
      if (isShowRest(text)) {
        const { pages } = browsePage(folders, position.page)
        if (position.page >= pages) {
          return {
            kind: 'reply',
            text: `会话夹只有 ${String(pages)} 页，已经到底了。\n回复编号或名字进入。`,
            // 留着而不是清掉：什么都没变，而用户显然还在读。
            browse: position,
          }
        }
        return {
          kind: 'reply',
          text: renderFolderScreen(folders, position.page + 1),
          browse: { ...position, page: position.page + 1, at: now },
        }
      }

      const resolution = resolveFolder(text, folders)
      if (resolution.kind === 'ambiguous') {
        return {
          kind: 'reply',
          text: ambiguousFolderMessage(text, resolution.candidates, folders),
          browse: position,
        }
      }
      if (resolution.kind === 'none') {
        /*
         * ★ 认不出来时**必须留下痕迹**。
         *
         * 这一支刻意返回 `undefined`（一句普通搭话要照旧到达 agent），但那让
         * "用户回了个编号却没进去"与"用户随口说了句话"在可观测上完全相同——
         * 用户看到的是**没有任何反应**，而日志是**空白**。
         *
         * 所以这里记下：用户敲了什么、清单里有几个夹子、分别叫什么。
         * 有这三样，空清单与匹配失败当场可分。
         */
        this.#diagnose(
          `browse: 会话夹选择「${text}」没匹配上（清单里有 ${String(folders.length)} 个：${
            folders.length === 0 ? '空' : folders.map((folder) => folder.label).join(' / ')
          }）`,
        )
        return undefined
      }

      const folder = resolution.folder
      const rows = this.#rowsIn(folder.path, all, own)
      const screen = renderSessionScreen(rows, {
        label: folder.label,
        page: 1,
        ...(currentId === undefined ? {} : { currentId }),
        ...(this.#isOwnFolder(folder.path) ? this.#heldHintFor(own, all, params.heldHint) : {}),
      })
      /*
       * 进入会话夹**只改浏览位置，不改绑定**：真要切过去，还要在里面再选一个会话
       * （微信的原话）。绑定只由 {@link SessionRouter#switchTo} 改。
       */
      return {
        kind: 'reply',
        text: screen.text,
        numbered: screen.numbered,
        browse: { level: 'sessions', workspace: folder.path, page: 1, at: now },
      }
    }

    const rows = this.#rowsIn(position.workspace, all, own)
    if (isShowRest(text)) {
      const { pages } = browsePage(rows, position.page)
      if (position.page >= pages) {
        return {
          kind: 'reply',
          text: `【${this.#folderLabel(position.workspace)}】只有 ${String(pages)} 页，已经到底了。\n回复编号或行尾 6 位 id 切换。`,
          browse: position,
        }
      }
      const label = this.#folderLabel(position.workspace)
      const screen = renderSessionScreen(rows, {
        label,
        page: position.page + 1,
        ...(currentId === undefined ? {} : { currentId }),
        ...(this.#isOwnFolder(position.workspace)
          ? this.#heldHintFor(own, all, params.heldHint)
          : {}),
      })
      return {
        kind: 'reply',
        text: screen.text,
        numbered: screen.numbered,
        browse: { ...position, page: position.page + 1, at: now },
      }
    }

    /*
     * 其余一切按 `/switch` 的读法读，所以编号、行尾 id 与名字三种写法都成立，
     * 而两条路解析出来的东西是同一个。
     *
     * 把这一屏作为最后一条退路传下去：万一那一屏没被钉住（比如写盘失败），
     * 回一个编号仍然能用。调用方给的编号优先，因为那才是用户正看着的那份。
     */
    return await this.#switchTo(params, text, {
      mode: 'reply',
      fallback: screenRows(rows, position.page),
    })
  }

  /**
   * 把本对话移到参数点名的那个会话上。
   *
   * `/switch` 与会话夹里的一次回复共用它：**一个解析器**，
   * 于是同一个编号对打出来的指令与对回出来的消息不可能指两件事。
   *
   * @param params - 路由参数。
   * @param args - 用户打出来或回出来的那个目标。
   * @param options.mode - `command` 失败时以引导作答；`reply` 则什么都不回，
   *   好让一条只是没点中会话的消息照旧到达 agent。
   * @param options.fallback - 调用方没有钉住的编号时，用来读数字的那一屏。
   * @returns 确认文案，或调用方要求闭嘴时的 `undefined`。
   */
  async #switchTo(params, args, options) {
    /*
     * 数字读的是**用户看到过的那份清单**，绝不从活着的会话里重算。
     *
     * 这正是编号存在的意义：用户读清单时会话还在跑，所以按"现在最新的是什么"解析出来的数字
     * 完全可能落到别处。调用方传进来的，是引用钉住的那一屏，或本对话最近收到的那一屏；
     * 两者都不知道时，才回落到活清单。
     */
    const bindings = await this.#load()
    const all = await this.#gateway.listSessions()
    const own = await this.#ownSessions(all)
    const pinned =
      params.numbered !== undefined && params.numbered.sessions.length > 0
        ? params.numbered
        : options.fallback
    /*
     * 顺序在本文件里定，而不是信宿主的：用户敲的数字指的是**某份清单**里的位置，
     * 而清单是按这里的顺序排的。若宿主恰好按目录顺序把行交出来，
     * 同一个数字就会因为"之前有没有看过清单"而指到两处。
     */
    const pool =
      pinned !== undefined && pinned.sessions.length > 0
        ? pinned
        : { sessions: [...own].sort(compareSessionsNewestFirst), first: 1 }
    // id 与标题在整台机器上仍然可搜，所以"说出名字"而不是"报编号"的那些也够得着——
    // 包括只有那一屏知道的会话。
    const known = new Map(all.map((session) => [session.sessionId, session]))
    for (const session of pool.sessions) {
      if (!known.has(session.sessionId)) known.set(session.sessionId, session)
    }
    const resolution = resolveTarget(args, [...known.values()], pool)
    if (resolution.kind === 'ambiguous') {
      if (options.mode === 'reply') return undefined
      return { kind: 'reply', text: ambiguousTargetMessage(args.trim(), resolution.candidates) }
    }
    if (resolution.kind === 'none') {
      if (options.mode === 'reply') return undefined
      return { kind: 'reply', text: UNKNOWN_TARGET }
    }
    const target = resolution.session
    // **不带标题**：采纳一条已有会话不该改名（标题只在创建那一刻给，见 `#bind`）。
    await this.#gateway.ensureSession(target.sessionId)
    const previous = bindings[params.conversationId]
    const binding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId: target.sessionId,
      /*
       * 标题三级回退，比微信插件多一级。
       *
       * 微信是 `target.title || this.#titlePrefix`。当目标会话在索引里还没有标题时
       * （DSH 要等第一个回合结束才写标题），绑定标题会退化成光秃秃的前缀——
       * 实测就撞上了：`/new` 之后立刻 `/switch` 回它，`/current` 会显示「当前对话「QQ」」。
       *
       * 所以中间插一级"沿用这个对话原来的标题"：那总比一个光前缀有信息量，
       * 且不改变任何其它行为。
       */
      title: target.title || previous?.title || this.#titlePrefix,
      createdAt: previous?.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    // 没有 `browse`：这条回复点名了一个正在被使用的会话，所以它来自的那份清单已经读完了，
    // 下一次「查看其余」不该接着它往下翻。
    return { kind: 'reply', text: `已切换到「${binding.title}」。\n${shortId(binding.sessionId)}` }
  }

  /**
   * `/model 等级 …` 那一半：报出一个模型的等级，或把对话切到其中一个。
   *
   * 照搬微信 `router.ts` 的 `#selectLevel`。等级是**模型**的属性，所以两种写法都要先定下模型：
   * 用户点名的那个（`/model 2 等级 high`），或当前在用的那个（`/model 等级 high`，只改等级时更省字）。
   * 等级名用的是清单里印的那些（本机适配器发布 `off/low/high/max`），不是中文说法——
   * `/model 等级 高` 会被解析成等级形式，然后以「找不到这个等级」收场。
   * 因此"改一个当前不在用的模型的等级"本身就是一次模型切换，报告也按切换说。
   *
   * @param binding - 本对话的绑定；从没说过话时为 `undefined`。
   * @param models - 宿主的模型目录（顺序即编号）。
   * @param current - 宿主报出的当前选择，可能属于另一个模型。
   * @param asked - {@link parseModelCommand} 的结果。
   */
  async #selectLevel(binding, models, current, asked) {
    const option =
      asked.target === ''
        ? models.find((row) => row.provider === current?.provider && row.model === current?.model)
        : resolveModel(asked.target, models)

    if (option === undefined && asked.target !== '') {
      return { kind: 'reply', text: `找不到这个模型。\n\n${renderModelList(models, current)}` }
    }
    const levels = option?.levels ?? []
    if (option === undefined || levels.length === 0) {
      /*
       * 三条路都到这里：还没有选中任何模型、当前模型已不在目录里、模型确实没有等级。
       * 对用户是同一件事（没有等级可切），下一步也同一个（去看清单）。
       */
      return { kind: 'reply', text: `${NO_LEVELS}。回复 /model 看清单。` }
    }

    // 只是**问**一个模型的等级：什么都不改，所以不需要有对话。
    if (asked.level === undefined) return { kind: 'reply', text: renderLevels(option, current, levels) }

    const level = resolveLevel(asked.level, levels)
    if (level === undefined) {
      // 合法取值整份印出来：适配器没发布的等级 id 不是用户猜得出来的，而这个集合很小。
      return {
        kind: 'reply',
        text:
          `${NOT_FOUND_LEVEL}「${asked.level}」。${option.name} 可以用的推理等级：` +
          `${levels.map((entry) => entry.name).join('、')}。`,
      }
    }

    if (binding === undefined) {
      return { kind: 'reply', text: '当前没有对话，先发一条消息再切推理等级。' }
    }
    if (this.#gateway.selectModel === undefined) {
      return { kind: 'reply', text: '当前组合不支持切换推理等级。' }
    }
    const sameModel =
      current !== undefined && current.provider === option.provider && current.model === option.model
    try {
      const selected = await this.#gateway.selectModel(
        binding.sessionId,
        option.provider,
        option.model,
        level.id,
      )
      /*
       * 等级标签按**宿主归一化后**的结果查，而不是按用户敲的那个：
       * 两者不同正是"宿主另有决定"的时候，而用户要看的是生效的那个。
       */
      const label = levelName(selected?.reasoningEffort, levels) ?? level.name
      const lines = sameModel
        ? [`已把「${binding.title}」的推理等级切到 ${label}（${option.name}）。`]
        : [`已切换模型：${modelLabel(selected ?? option)}。`, `推理等级：${label}`]
      lines.push('', '对下一步生效，正在跑的那一步不受影响。')
      return { kind: 'reply', text: lines.join('\n') }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const opening = sameModel ? FAILED_LEVEL : FAILED_MODEL
      return { kind: 'reply', text: `${opening}：${reason}\n\n发「/model」看清单。` }
    }
  }

  /**
   * 创建一个绑定、它的会话，并持久化。
   *
   * ## 两个标题，两种归属
   *
   * - **绑定标签**（`title`）是本频道自己的显示名：`/current` 与 `/new` 的确认文案印它。
   *   没有标题时退化成前缀 + 短 id。
   * - **会话标题**交给宿主，那是桌面端会话列表里显示的东西。它取自 `requestedTitle`：
   *   `/new <标题>` 是用户打的那个，普通消息是由用户原话推导出来的那个
   *   （调用方给，见 {@link deriveSessionTitle}）。为空时传 `undefined`——让宿主自己
   *   从首条消息取，因为那时确实没有可命名的东西（`/new` 不带参数就是这样：
   *   用户还没说任何话）。
   *
   * ⚠️ **只有创建走这条路**：`#switchTo` 与后续消息用的是 `ensureSession`，
   * 它不动标题，所以采纳一条已有会话永远不会改名。
   *
   * @param params - 路由参数。
   * @param requestedTitle - 这次创建要用的标题；空或缺失表示没有标题可给。
   */
  async #bind(params, requestedTitle) {
    const bindings = await this.#load()
    const sessionId = mintSessionId()
    const asked = requestedTitle?.trim() ?? ''
    const title = asked === '' ? `${this.#titlePrefix} ${shortId(sessionId)}` : asked
    /*
     * 空标题**不传空串**：宿主会把空标题归一化成空并拒绝它（`session/title-invalid`）。
     * `undefined` 的含义是"我没有标题给你"，两件事不能用同一个值表示。
     */
    await this.#gateway.createSession(sessionId, asked === '' ? undefined : asked)
    const now = Date.now()
    const binding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId,
      title,
      createdAt: now,
      lastUsedAt: now,
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    return binding
  }

  async #load() {
    this.#bindings ??= await this.#store.load()
    return this.#bindings
  }

  /**
   * 一条绑定绑着的会话是不是已经收不了活，因此必须被换掉。
   *
   * 三种结果，每一种都是刻意的：
   *
   * - **宿主没有探针** → `undefined`，绑定照旧复用。这是探针存在之前的行为，
   *   而一个答不出来的组合不该为此受罚。
   * - **探针抛错** → `undefined` 外加一行诊断。坏掉的探针**不是**"会话已死"的证据，
   *   按它换绑会扔掉一个好好的对话；当成可用才能让消息继续往前走。
   * - **`missing` 而绑定的年龄小于 {@link MISSING_BINDING_GRACE_MS}** → `undefined` 外加一行诊断。
   *   会话的记录是它**第一个回合**写下的，所以一条刚建立的绑定**本来就应该**看起来是 missing；
   *   信了它就是那个"每条消息都新建一个会话"的实盘 bug。
   *
   * 其余情况（`archived`，以及过了宽限期的 `missing`）返回判定本身，调用方据此换绑。
   *
   * @param binding - 正要被复用的那条绑定。
   * @returns 必须换绑时返回 `archived` / `missing`，可以复用则 `undefined`。
   */
  async #deadState(binding) {
    const probe = this.#gateway.sessionState
    if (typeof probe !== 'function') return undefined

    let state
    try {
      state = await probe.call(this.#gateway, binding.sessionId)
    } catch (error) {
      this.#diagnose(
        `会话状态：探针失败 conversation=${binding.conversationId} ` +
          `session=${binding.sessionId} error=${JSON.stringify(describeError(error))} —— 按可用处理`,
      )
      return undefined
    }

    if (state === 'usable' || state === undefined) return undefined

    if (state === 'missing') {
      const ageMs = Date.now() - binding.createdAt
      if (ageMs < MISSING_BINDING_GRACE_MS) {
        this.#diagnose(
          `会话状态：${binding.sessionId} 报 missing，但它的绑定只有 ` +
            `${String(Math.round(ageMs / 1000))}s（宽限 ${String(MISSING_BINDING_GRACE_MS / 1000)}s）` +
            `—— 继续复用，它的第一个回合大概还没写下记录`,
        )
        return undefined
      }
    }

    return state
  }

  /**
   * 本对话在浏览器里站的位置，**还活着**的那个。
   *
   * 一个被丢下的位置会被丢掉并按"不在浏览"回答：「查看其余」的意思是
   * "我正在看的那份的下十条"，而用户一旦走开，这句话就没有可接着的东西了，
   * 跳到上次离开的地方读起来是故障而不是方便。
   *
   * @param routeState - 路由状态。
   * @param conversationId - 对话键。
   */
  async #liveBrowse(routeState, conversationId) {
    const stored = routeState.browsing[conversationId]
    if (stored === undefined) return undefined
    if (Date.now() - stored.at <= BROWSE_IDLE_MS) return stored
    delete routeState.browsing[conversationId]
    this.#diagnose(`browse expired: conversation=${conversationId} page=${String(stored.page)}`)
    await this.#saveRoute()
    return undefined
  }

  /**
   * 读一份编号：引用钉住的那一屏优先，否则本对话最近收到的那一屏。
   *
   * 引用优先是因为**用户指着它**：那一屏的编号在消息发出时就冻住了，
   * 所以不管机器之后怎么动，"3" 仍然是用户看得见的那一行。
   * 没有引用（或引用的是别的东西）时用最近那一屏，那是多半还在他屏幕上的那份。
   *
   * @param routeState - 路由状态。
   * @param conversationId - 消息到达的对话。
   * @param quoted - 被引用消息的正文。
   * @returns 用来读数字的编号，或 `undefined`（这个对话从没收到过清单）。
   */
  #numberedFor(routeState, conversationId, quoted) {
    const own = routeState.sessionLists[conversationId] ?? []
    if (quoted !== undefined && quoted.trim() !== '') {
      const found = findListingByText(routeState.sessionLists, conversationId, quoted)
      if (found !== undefined) return { sessions: found.sessions, first: found.first }
      // 引用到的不是清单：落到"最近一屏"，与没有引用时同一条路。
    }
    const latest = own.at(-1)
    return latest === undefined ? undefined : { sessions: latest.sessions, first: latest.first }
  }

  /**
   * 把一屏清单记在它的正文旁边，好让一次引用能把它认回来。
   *
   * 微信按**消息 id** 钉（引用里带 id）；QQ 的引用直接给正文，所以这里按正文钉。
   * 正文超长时截断保存：引用本身也可能是截断的，而前缀匹配照样认得出。
   *
   * @param routeState - 路由状态。
   * @param conversationId - 清单发往的对话。
   * @param text - 那条消息的正文。
   * @param numbered - 它印的编号。
   * @param at - 发出的时间，用于淘汰。
   */
  async #rememberListing(routeState, conversationId, text, numbered, at) {
    const history = (routeState.sessionLists[conversationId] ??= [])
    history.push({
      text: text.slice(0, LISTING_TEXT_LIMIT),
      // 逐字段抄出来：存下来的必须是读者会校验的那些字段，
      // 这样以后改行的形状也不可能夹带一个没被校验的值进来。
      sessions: numbered.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: (session.title ?? '').slice(0, LISTING_TITLE_LIMIT),
      })),
      first: numbered.first,
      at,
    })
    if (history.length > LISTING_HISTORY) history.splice(0, history.length - LISTING_HISTORY)
    await this.#saveRoute()
  }

  /**
   * 把浏览位置推到某一屏，或忘掉它。
   *
   * @param conversationId - 对话键。
   * @param next - 新位置，或 `undefined` 表示忘掉。
   */
  async #trackBrowse(conversationId, next) {
    const routeState = await this.#loadRoute()
    const current = routeState.browsing[conversationId]
    /*
     * `at` 也比：同屏再列一次要重新起算空闲时钟。
     * 漏掉它看着像省一次写，实际是个 bug——空闲窗口里连打两次 `/list` 会留着第一次的时间戳，
     * 于是用户还在用它，位置就过期了。
     */
    if (
      current !== undefined &&
      next !== undefined &&
      current.level === next.level &&
      current.workspace === next.workspace &&
      current.page === next.page &&
      current.at === next.at
    ) {
      return
    }
    if (current === undefined && next === undefined) return
    if (next === undefined) delete routeState.browsing[conversationId]
    else {
      routeState.browsing[conversationId] = {
        level: next.level,
        workspace: next.workspace,
        page: next.page,
        at: next.at,
      }
    }
    await this.#saveRoute()
  }

  /**
   * 把路由状态写回宿主。
   *
   * 失败只记一行：代价是"引用钉不住编号"或"少翻一屏"，
   * 而这条消息本身比它重要。写的是**副本**：宿主那份会进 JSON，
   * 若与本对象共享引用，之后任何一次改动都会绕过本方法进入下一次写盘。
   */
  async #saveRoute() {
    const save = this.#store.saveRouteState
    if (save === undefined || this.#routeState === undefined) return
    const state = this.#routeState
    const snapshot = {
      browsing: { ...state.browsing },
      sessionLists: Object.fromEntries(
        Object.entries(state.sessionLists).map(([key, entries]) => [
          key,
          entries.map((entry) => ({ ...entry, sessions: entry.sessions.map((row) => ({ ...row })) })),
        ]),
      ),
    }
    try {
      await save.call(this.#store, snapshot)
    } catch (error) {
      this.#diagnose(`route-state: 保存失败：${describeError(error)}`)
    }
  }

  async #loadRoute() {
    if (this.#routeState !== undefined) return this.#routeState
    this.#routeLoading ??= (async () => {
      const load = this.#store.loadRouteState
      try {
        const stored = load === undefined ? undefined : await load.call(this.#store)
        this.#routeState = normalizeRouteState(stored)
      } catch (error) {
        this.#diagnose(`route-state: 读取失败，按空状态继续：${describeError(error)}`)
        this.#routeState = normalizeRouteState(undefined)
      }
      return this.#routeState
    })()
    return await this.#routeLoading
  }

  /** 记一行诊断；路由自己不能写日志（core 不 import 宿主）。 */
  #diagnose(line) {
    this.#onDiagnostic?.(line)
  }

  /**
   * 属于本频道自己的工作区的那些会话。
   *
   * @param fallback - 全量清单；宿主分不出两者时用它。没有工作区感知的宿主会把每条都算成
   *   本工作区自己的，那是旧行为，也是当时能给出的最好答案。
   */
  async #ownSessions(fallback) {
    return (await this.#gateway.listOwnSessions?.()) ?? fallback
  }

  /** 这台机器上出现过会话的工作区，按第一层打印的顺序。 */
  #folders(rows) {
    return sessionFolders(rows, {
      ...(this.#ownWorkspace === undefined ? {} : { ownWorkspace: this.#ownWorkspace }),
      ownLabel: this.#ownWorkspaceLabel,
    })
  }

  /** 某个会话夹是不是本频道自己的工作区。 */
  #isOwnFolder(path) {
    if (path === '') return true
    return this.#ownWorkspace !== undefined && isSameWorkspace(path, this.#ownWorkspace)
  }

  /**
   * 一个会话夹里的会话，最新在前。
   *
   * 本工作区按名字问，而不是从全量里过滤出来，这样"分开report"的宿主也不会让自己的行漏掉。
   *
   * 排序在这里做而不是信宿主的，理由与 `#switchTo` 排自己的池子相同：
   * 用户回的那个数字是**这个**顺序里的位置，而一个按目录顺序交行的宿主
   * 会让同一个数字因为来自哪份清单而指到两处。
   *
   * @param path - 会话夹目录，空串是本频道自己的。
   * @param all - 这台机器知道的全部会话。
   * @param own - 本频道自己的会话。
   */
  #rowsIn(path, all, own) {
    const rows = this.#isOwnFolder(path)
      ? own
      : all.filter(
          (session) => session.workspace !== undefined && isSameWorkspace(session.workspace, path),
        )
    return [...rows].sort(compareSessionsNewestFirst)
  }

  /** 一个会话夹被印出来、也被认回来的那个名字。 */
  #folderLabel(path) {
    if (this.#isOwnFolder(path)) return this.#ownWorkspaceLabel
    return workspaceLabel(path) || path
  }

  /**
   * 一屏会话清单末尾那句"它显示不了的会话"。
   *
   * 只有本频道自己的会话夹会有这一句：用户要的是这个工作区的会话，其余的不是他没问的地方，
   * 所以数出来、点名，而不是让它们彻底看不见。进了别人的会话夹这句就是噪声——
   * 那是他自己选的夹子，里面的东西就是他正在看的东西。
   *
   * @param own - 本频道自己的会话。
   * @param all - 这台机器知道的全部会话。
   * @param hint - 调用方对"怎么够到其余的"的措辞（打字与说话不同）。
   */
  #heldHintFor(own, all, hint) {
    const ownIds = new Set(own.map((session) => session.sessionId))
    const held = all.filter((session) => !ownIds.has(session.sessionId))
    if (held.length === 0) return {}
    return {
      held: { count: held.length, names: heldNames(held) },
      ...(hint === undefined ? {} : { heldHint: hint }),
    }
  }
}

/**
 * 会话标题的词数上限。**照宿主的值取**，不要自己拍一个。
 *
 * 出处：`@deepseek-ai/dsh-base/cordis.patch.yml:58`
 * （`dsh-session-title` 的 `config.fallbackMaxWords`；
 * profile 的 `cordis.patch.yml` 没有覆盖它，所以 5 就是生效值）。
 */
const SESSION_TITLE_MAX_WORDS = 5

/**
 * 会话标题的 UTF-8 字节上限。出处同上一处：`@deepseek-ai/dsh-base/cordis.patch.yml:59`
 * （`config.fallbackMaxBytes`，未覆盖）。
 *
 * 取同一个数的理由：这里给的标题应当与宿主本来会猜出来的那个**一样长**，
 * 只是不含渠道说明。不一样长的话，同一个用户的第一句话会因为"是谁命的名"而得到两个标题。
 */
const SESSION_TITLE_MAX_BYTES = 40

/**
 * 由用户自己的话推导一个会话标题。
 *
 * ## 为什么要有它
 *
 * 宿主在会话还没有标题时**从首条消息猜**（`fallbackSessionTitle`），而那条消息是频道
 * 拼出来的：用户的话 + 附件描述 + 渠道说明。猜出来的标题会把渠道说明也写进去。
 * 所以创建会话时由这里先给一个标题——用的是**用户自己的话**，不含渠道说明。
 *
 * ## 语义与宿主那条回退**逐字一致**
 *
 * 照 `dsh-session-title/lib/types/normalize.js:66` 的 `fallbackSessionTitle`：
 * 空白折叠成一个空格 → trim → 按空格切词 → 取前 {@link SESSION_TITLE_MAX_WORDS} 个 →
 * 按 UTF-8 字节（{@link SESSION_TITLE_MAX_BYTES}）截断，且不切开码点。
 *
 * 控制序列（OSC/CSI/ESC）与方向性控制符**刻意不在这里剥**：标题交给宿主时
 * `normalizeSessionTitle` 还会再清洗一遍（`normalize.js:56`），两处各写一份只会慢慢漂移，
 * 而漂移出来的差异没人看得见。
 *
 * @param text - 用户这一条的原话（调用方已 trim）。
 * @returns 标题；没有可见字符时是空串——调用方据此**不传标题**，让宿主走它自己的回退。
 */
export function deriveSessionTitle(text) {
  const cleaned = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
  const words = cleaned.split(' ').filter(Boolean).slice(0, SESSION_TITLE_MAX_WORDS)
  return truncateUtf8(words.join(' '), SESSION_TITLE_MAX_BYTES).trimEnd()
}

/**
 * 按 UTF-8 字节截断，**不切开一个码点**。
 *
 * 与宿主的 `truncateTitleUtf8`（`normalize.js:35`）同一套做法：逐码点累加字节数，
 * 装不下就停。逐 UTF-16 码元截断会把一个 emoji 劈成两半，而那半截是无效字符。
 *
 * @param input - 待截断文本。
 * @param maxBytes - 字节上限（正整数）。
 */
function truncateUtf8(input, maxBytes) {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/** 总是带参数的指令。 */
const COMMANDS_WITH_ARG = ['/new', '/switch']

/** 从不带参数的指令。 */
const COMMANDS_BARE = ['/help', '/list', '/current', '/cancel']

/**
 * 参数可选的指令：**不写**参数与**写了**参数是两种不同的请求。
 *
 * `/model` 是本项目第一个这样的指令——不带参数是"列出有哪些模型"，带参数是"切到那个"。
 * 它单列一份而不是塞进 `COMMANDS_WITH_ARG`，是因为那两个名单的语义是"必须带参数"
 * 与"必须不带参数"，一个可选参数的指令放进去会让名单名不副实。
 *
 * 解析上两者走同一段代码（见 `splitCommand` 的循环）：空参数天然落进"没有参数"这一支。
 */
const COMMANDS_OPTIONAL_ARG = ['/model']

/**
 * 把 `/cmd args` 拆成两半。
 *
 * 分隔空格是可选的，且接受 `:` 代替它——因为这些指令是在手机键盘上敲的，掉空格是常态。
 * `/switch1`、`/switch 1`、`/switch:1` 意思相同。
 * 只是**以**指令名开头的词不会被吃掉，所以 `/news` 不是 `/new`。
 *
 * 参数可选的指令（`/model`）走的是同一段代码：空参数落进"没有参数"这一支，
 * 于是 `/model`、`/model 2`、`/model:2`、`/model2` 都解析正确。
 *
 * @param text - 原始文本。
 * @returns `{ command, args }`
 */
export function splitCommand(text) {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  const space = trimmed.search(/\s/)
  if (space >= 0) {
    return { command: lower.slice(0, space), args: trimmed.slice(space + 1).trim() }
  }

  const colon = lower.indexOf(':')
  if (colon > 0) {
    return { command: lower.slice(0, colon), args: trimmed.slice(colon + 1).trim() }
  }

  if (COMMANDS_BARE.includes(lower)) {
    return { command: lower, args: '' }
  }

  for (const command of [...COMMANDS_WITH_ARG, ...COMMANDS_OPTIONAL_ARG]) {
    if (!lower.startsWith(command)) continue
    const rest = trimmed.slice(command.length)
    // 紧跟一个 ASCII 字母说明这是另一个词，而不是这条指令粘了个参数：
    // `/news` 不能被解析成 `/new` 加 `s`。数字与非 ASCII 文本是合法的粘连参数
    // （`/switch1`、`/new我的任务`）。
    if (/^[a-z]/.test(rest)) continue
    return { command, args: rest.replace(/^[:\s]+/, '').trim() }
  }

  return { command: lower, args: '' }
}

/** `/switch` 与"会话夹里的一次回复"都用的那句"什么都没匹配上"。 */
const UNKNOWN_TARGET = '找不到这个对话。回复 /list 看清单，再回复数字或 id。'

/**
 * 一个 `/switch` 参数解析出来的结果。
 *
 * "有歧义"与"找不到"是两种结果，而不是一种。两者需要不同的回答：
 * 一个都没匹配上意味着"再看一眼清单"，而匹配到多个意味着"你的 id 太短"——
 * 后者是用户能修的那个，所以必须把候选点出来，而不是替他猜一个。
 *
 * @typedef {object} TargetResolution
 * @property {'found'|'ambiguous'|'none'} kind
 * @property {NumberedSession} [session]
 * @property {NumberedSession[]} [candidates]
 */

/**
 * 把 `/switch` 的参数解析成一条会话。
 *
 * 接受 1 起的位置序号、完整会话 id、`/list` 打印的短 id（或它的更长前缀），或标题——
 * 手机键盘让复制完整 uuid 很痛苦。
 *
 * 匹配刻意严格。会话 id 共享同一形态（`session-<短>-<uuid>`），
 * 松散的 `includes` 会匹配到多行；有歧义的参数必须失败，而不是切到一个意外的会话。
 * 由于印出来的 id 只是它中间那段十六进制的前几个字符，两个对话**可能**共用它，
 * 那时告诉用户"请用更长的 id"，而不是把先找到的那个塞给他。
 *
 * 顺序也是有意的：精确的那几种读法先试，所以一个标题看起来像十六进制片段的对话，
 * 仍然可以用那个标题够到。
 *
 * @param args - 用户在 `/switch` 后面敲的。
 * @param sessions - 所有可被点名的会话，通常是整台机器。
 * @param numbered - 数字所指向的那份清单，以及印在它第一行旁边的数字。
 *
 *   两者不是同一份东西：数字按用户**看到过的那份清单**回答，而标题或 id 可以点名
 *   任何工作区的会话——用户从清单里挑出来的那个必须能切过去，否则那份清单就是个谎。
 *   偏移也是它的一部分，因为编号跨屏连续：第二屏印 11..20，
 *   把"13"当成第 3 行会把对话移到一个那一屏从没显示过的会话上。
 * @returns {@link TargetResolution}
 */
export function resolveTarget(args, sessions, numbered = { sessions: [...sessions], first: 1 }) {
  const value = args.trim()
  if (!value) return { kind: 'none' }

  if (/^\d+$/.test(value)) {
    // 数字指的是用户看到过的那份清单里的一行，不一定是整台机器——所以用 `numbered` 而不是 `sessions`。
    const index = Number(value) - numbered.first
    const byIndex = index < 0 ? undefined : numbered.sessions[index]
    if (byIndex !== undefined) return { kind: 'found', session: byIndex }
    /*
     * 继续往下：纯数字字符串也可能是个标题或 id。
     *
     * 比这一屏第一个数字**更小**的数字不会被悄悄折成第 1 行——编号是连续的，
     * 所以从 11 开始的那一屏上回一个"3"，是用户已经翻过去的那一屏里的数字，
     * 猜他想指哪一行正是钉住编号要防的那种漂移。
     */
  }

  const exactId = sessions.find((session) => session.sessionId === value)
  if (exactId !== undefined) return { kind: 'found', session: exactId }

  const byTitle = sessions.find((session) => session.title === value)
  if (byTitle !== undefined) return { kind: 'found', session: byTitle }

  // 短 id 在中间：`session-<短>-<uuid>`，而它的任何前缀也在那里——
  // 这正是"用更长的 id"能成为一句用户可执行的建议的原因。
  if (/^[0-9a-f]+$/i.test(value)) {
    const lower = value.toLowerCase()
    const byPrefix = sessions.filter((session) => idKeyOf(session.sessionId).startsWith(lower))
    if (byPrefix.length === 1) return { kind: 'found', session: byPrefix[0] }
    if (byPrefix.length > 1) return { kind: 'ambiguous', candidates: byPrefix }
  }

  const bySuffix = sessions.filter((session) => session.sessionId.endsWith(value))
  if (bySuffix.length === 1) return { kind: 'found', session: bySuffix[0] }
  if (bySuffix.length > 1) return { kind: 'ambiguous', candidates: bySuffix }

  /*
   * 最后才是**双向**的标题包含匹配——且只在恰好一条命中时成立。
   *
   * 人用"自己怎么称呼这个对话"的方式称呼它，松紧两个方向都会出现：
   * 敲一个片段（「北京」），或者自己加词（「北京今天天气如何**会话**」）。
   * 两者与精确标题是同一个请求，而只做精确匹配在这两种情况下都失败过——
   * 对一个用户看得出能答的请求来说，这是硬失败。
   *
   * 唯一性是保险，也是它排在最后的原因。命中多条或零条都不算命中：
   * 有歧义的参数必须失败，而不是把对话移到用户没要求的地方去。
   * 短到单个字的词在这里通常命中不了，同样出于这个原因——那会是猜。
   */
  const core = (session) => session.title.includes(value) || value.includes(session.title)
  const byCore = sessions.filter((session) => session.title !== '' && core(session))
  if (byCore.length === 1) return { kind: 'found', session: byCore[0] }

  return { kind: 'none' }
}

/**
 * 短 id 是它前缀的那个标识符。
 *
 * id 是 `session-<hex>-<uuid>`，而那段 hex 重复了 uuid 的头几个字符，
 * 所以中间那一段才是用户看得见也敲得出来的东西。没有这个形状的 id 回落到它自己的裸形式，
 * 于是同一条前缀规则对别的实现铸出来的会话也成立。
 *
 * @param sessionId - 会话 id。
 * @returns 用户敲的短 id 是它前缀的那个字符串，小写。
 */
function idKeyOf(sessionId) {
  const match = /^session-([0-9a-f]+)-/i.exec(sessionId)
  return (match?.[1] ?? sessionId.replace(/^session-/, '')).toLowerCase()
}

/**
 * 一个 id 短到认不出唯一一个会话时说的话。
 *
 * 候选按它们 hex 段**最长**的那个前缀印出来，而那正是用户该回的那个更长的 id——
 * 连同标题，因为手机用户认得出的是对话，不是 id。
 *
 * @param value - 用户敲的。
 * @param candidates - 它匹配到的每一个会话。
 */
export function ambiguousTargetMessage(value, candidates) {
  const lines = candidates.map((session) => {
    const match = /^session-([0-9a-f]+)-/i.exec(session.sessionId)
    const longer = (match?.[1] ?? session.sessionId).toLowerCase()
    return `${longer} · ${(session.title || '(无标题)').trim()}`
  })
  return [
    `有多个会话匹配「${value}」，请用更长的 id（下面每一行开头的就是）：`,
    '',
    ...lines,
    '',
    '完整 id 也可以，回复 /list 能再看一次清单。',
  ].join('\n')
}

/**
 * 一次编号真正需要的两个字段之外的存储形态：正文与时间。
 *
 * 微信把编号钉在**消息 id** 上（引用里带 id）；QQ 的引用直接给正文，
 * 所以这里钉的是正文本身，外加一个用于淘汰的时间。
 *
 * @typedef {object} ListingRecord
 * @property {string} text - 那条消息的正文（超长时截断，引用也常常是截断的）。
 * @property {NumberedSession[]} sessions
 * @property {number} first
 * @property {number} at
 */

/**
 * 一屏清单的正文最多存多少字符。
 *
 * 状态文件每次变更都整份重写，而一个对话会攒五屏。十行的屏通常不到 700 字符，
 * 这个上限只是防着一行超长标题把文件撑大。截断不影响认出引用：引用也可能是截断的，
 * 而前缀匹配照样成立。
 */
const LISTING_TEXT_LIMIT = 1_200

/** 存下来的一行标题最多多长。理由同上：它只用来在确认文案里被认出来。 */
const LISTING_TITLE_LIMIT = 120

/** 每个对话保留几屏清单。 */
const LISTING_HISTORY = 5

/**
 * 引用正文短到这个长度以下就不拿它当"引用了某一屏"的证据。
 *
 * 会话夹标题那种几字的前缀太容易撞上别的东西，而认错一屏会让编号指到别处。
 */
const QUOTE_MATCH_MIN = 6

/** 引用正文与存下来的正文比对前的归一：空白折叠，首尾去掉。 */
function normalizeListingText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 在存下来的清单里找出引用指的是哪一屏。
 *
 * 精确相等优先；其次是**前缀**（引用正文被客户端截断时的形态），
 * 两个方向都试，因为存下来的正文自己也可能是截断的。
 *
 * @param sessionLists - 对话键 → 该对话发出的清单。
 * @param conversationId - 消息到达的对话（先在这里找）。
 * @param quoted - 引用正文。
 * @returns 命中的那屏，或 `undefined`。
 */
function findListingByText(sessionLists, conversationId, quoted) {
  const wanted = normalizeListingText(quoted)
  const hit = (entries) => {
    const newestFirst = [...entries].reverse()
    const exact = newestFirst.find((entry) => normalizeListingText(entry.text) === wanted)
    if (exact !== undefined) return exact
    if (wanted.length < QUOTE_MATCH_MIN) return undefined
    return newestFirst.find((entry) => {
      const stored = normalizeListingText(entry.text)
      return stored !== '' && (stored.startsWith(wanted) || wanted.startsWith(stored))
    })
  }

  const here = hit(sessionLists[conversationId] ?? [])
  if (here !== undefined) return here
  /*
   * 别的对话也找一遍：微信按消息 id 找，理由是一个 id 是唯一的；
   * 这里按正文找，理由相同——正文属于哪条消息与哪个对话无关，
   * 而用户不会引用另一个聊天的东西（真引用了，也没别的东西可以匹配）。
   */
  for (const [key, entries] of Object.entries(sessionLists)) {
    if (key === conversationId) continue
    const found = hit(entries)
    if (found !== undefined) return found
  }
  return undefined
}

/** 一个位置被丢下多久就不再算数。与微信的 `BROWSE_IDLE_MS` 同值。 */
export const BROWSE_IDLE_MS = 30 * 60 * 1000

/**
 * 路由状态的空形态。
 *
 * @returns `{ browsing: {}, sessionLists: {} }`
 */
export function emptyRouteState() {
  return { browsing: {}, sessionLists: {} }
}

/**
 * 把宿主读回来的路由状态归一成可用形态。
 *
 * 逐字段过滤而不是整体信任：状态文件可能来自旧版本、也可能被手工编辑过，
 * 而这里的东西会**决定用户回的那个数字指到哪一行**，所以一个坏值必须被丢掉，
 * 不能带进行为里。
 *
 * @param value - 宿主给的任意值。
 */
export function normalizeRouteState(value) {
  const state = emptyRouteState()
  if (typeof value !== 'object' || value === null) return state

  const browsing = value.browsing
  if (typeof browsing === 'object' && browsing !== null) {
    for (const [conversationId, raw] of Object.entries(browsing)) {
      if (typeof raw !== 'object' || raw === null) continue
      const level = raw.level
      if (level !== 'folders' && level !== 'sessions') continue
      if (!Number.isFinite(raw.page) || !Number.isFinite(raw.at)) continue
      state.browsing[conversationId] = {
        level,
        workspace: typeof raw.workspace === 'string' ? raw.workspace : '',
        page: Math.max(1, Math.trunc(raw.page)),
        at: raw.at,
      }
    }
  }

  const lists = value.sessionLists
  if (typeof lists === 'object' && lists !== null) {
    for (const [conversationId, raw] of Object.entries(lists)) {
      if (!Array.isArray(raw)) continue
      const entries = []
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue
        if (typeof entry.text !== 'string' || !Array.isArray(entry.sessions)) continue
        if (!Number.isFinite(entry.first) || !Number.isFinite(entry.at)) continue
        const sessions = []
        for (const row of entry.sessions) {
          if (typeof row?.sessionId !== 'string' || row.sessionId === '') continue
          sessions.push({
            sessionId: row.sessionId,
            title: typeof row.title === 'string' ? row.title.slice(0, LISTING_TITLE_LIMIT) : '',
          })
        }
        if (sessions.length === 0) continue
        entries.push({
          text: entry.text.slice(0, LISTING_TEXT_LIMIT),
          sessions,
          first: Math.max(1, Math.trunc(entry.first)),
          at: entry.at,
        })
      }
      if (entries.length > 0) state.sessionLists[conversationId] = entries.slice(-LISTING_HISTORY)
    }
  }

  return state
}

/** 用人的说法描述一个错误。 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 对话被搬到新会话时，先说给用户听的那句话。
 *
 * 必须说出来，因为另一个选择是"一条悄悄换了身份的对话"：消息照常发出，回答却来自一条
 * 没有任何历史的会话，而唯一的解释在用户看不到的日志里。旧标题被点名，好让他们认出
 * 被落下的是哪个对话；新标题也点名，好让他们能在 `/list` 里找到它。
 *
 * @param previousTitle - 那条再也收不了消息的会话。
 * @param state - 它为什么被换掉。
 * @param nextTitle - 现在绑定的这条会话。
 * @returns 要发进聊天里的那句话。
 */
function replacedBindingNotice(previousTitle, state, nextTitle) {
  const why = state === 'archived' ? '已经被归档' : '在电脑上已经不存在了'
  return (
    `原对话「${previousTitle}」${why}，我已新建「${nextTitle}」并接到这里。\n` +
    '你刚发的这条会发到新对话里，之前那个的上下文不在新对话里。'
  )
}

/**
 * 最新在前，同一时间戳用会话 id 兜底。
 *
 * 兜底不是洁癖：两份清单用同一个时间戳时，先后的差别会让"数字指哪一行"在两次渲染之间变化，
 * 而那个数字是用户要回给我们的东西。
 */
export function compareSessionsNewestFirst(a, b) {
  const left = Number.isFinite(a?.updatedAt) ? a.updatedAt : 0
  const right = Number.isFinite(b?.updatedAt) ? b.updatedAt : 0
  if (left !== right) return right - left
  if (a?.sessionId === b?.sessionId) return 0
  return String(a?.sessionId) < String(b?.sessionId) ? -1 : 1
}

/**
 * 一个工作区被用户认出来的名字。
 *
 * 存储里记的是绝对目录，而聊天消息里塞一条完整路径是噪声。
 * 最后一段正是桌面端侧边栏显示的东西，所以那才是用户认得出的。
 *
 * @param path - 某条会话记录的工作目录。
 * @returns 它的最后一段路径，没有可裁的就返回原值。
 */
export function workspaceLabel(path) {
  const parts = String(path ?? '')
    .split(/[\\/]+/)
    .filter((part) => part !== '')
  return parts.at(-1) ?? String(path ?? '')
}

/**
 * 把 `/model` 的参数解析成一个可用模型。
 *
 * 接受 1 起的位置序号、模型 id、显示名（大小写不敏感）、`provider/model`，
 * 以及**恰好命中一个**的子串。与 `resolveTarget` 同一条原则：
 * 有歧义的参数必须失败，而不是切到用户没要求的模型上去。
 *
 * 序号是必需的，不是锦上添花：`renderModelList` 打印了编号，
 * 而"列出一样够不着的东西"正是 `resolveTarget` 注释里记下的那个失败。
 *
 * @param args - 用户在 `/model` 后面敲的。
 * @param models - {@link renderModelList} 展示的那份清单，顺序即编号。
 * @returns 命中的模型行，或 `undefined`。
 */
export function resolveModel(args, models) {
  const value = args.trim()
  if (value === '') return undefined

  // `provider/model` 形式：多提供方时这是无歧义的写法。
  const slash = value.indexOf('/')
  if (slash > 0) {
    const provider = value.slice(0, slash).trim()
    const rest = value.slice(slash + 1).trim()
    const exact = models.find((row) => row.provider === provider && (row.model === rest || row.name === rest))
    if (exact !== undefined) return exact
  }

  // 数字先当编号，编号越界再当名字——纯数字也可能是个模型名。
  if (/^\d+$/.test(value)) {
    const byIndex = models[Number(value) - 1]
    if (byIndex !== undefined) return byIndex
  }

  const byId = models.find((row) => row.model === value)
  if (byId !== undefined) return byId

  const lower = value.toLowerCase()
  const byName = models.find((row) => row.name.toLowerCase() === lower)
  if (byName !== undefined) return byName

  const byPart = models.filter(
    (row) => row.model.toLowerCase().includes(lower) || row.name.toLowerCase().includes(lower),
  )
  if (byPart.length === 1) return byPart[0]

  return undefined
}

/**
 * 把 `/model` 的参数解析成"说的是模型还是等级"。
 *
 * 照搬微信 `router.ts` 的 `parseModelCommand`：`/model 等级 high`、`/model 2 等级 high`
 * 与 `/model level high` 都把等级**明写**出来，而不是让插件去猜哪一半是模型。
 * 别的写法一概不认：等级 id 是适配器发布的一个单词，任何按位置切分的规则都得先猜
 * "多词的模型名到哪里结束"，而猜错就是选错模型或选错等级，两者都只能从下一条回答里发现。
 *
 * `等级` 按**后缀**匹配，所以设置项的完整名字（`推理等级`、`思考等级`）不用第二张拼写表。
 * 没有模型叫这个名字。
 *
 * @param args - `/model` 后面的原文。
 * @returns `{ target, level?, levelForm }`；没有等级关键字时 `levelForm` 为 false。
 */
export function parseModelCommand(args) {
  const trimmed = args.trim()
  if (trimmed === '') return { target: '', levelForm: false }

  const tokens = trimmed.split(/\s+/)
  const at = tokens.findIndex(isLevelWord)
  // 没有关键字：整段就是模型，与等级出现之前完全一样。
  if (at < 0) return { target: trimmed, levelForm: false }

  const level = tokens.slice(at + 1).join(' ').trim()
  return {
    target: tokens.slice(0, at).join(' '),
    ...(level === '' ? {} : { level }),
    levelForm: true,
  }
}

/** 一个词是不是"后面跟的是等级"的那个词。 */
function isLevelWord(token) {
  const lower = token.toLowerCase()
  return lower === 'level' || lower === 'effort' || lower === 'reasoning' || token.endsWith('等级')
}

/**
 * 把用户写的等级解析到模型发布的那几个上。
 *
 * id 与名字都收，大小写不敏感：本机自带的适配器两者几乎一样（`high` / `High`），
 * 而手机键盘会把大小写变成用户的麻烦。**不做部分匹配**：等级猜错会悄悄改变模型想多深，
 * 而那不是用户能从回答里看出来的错。
 *
 * @param value - 用户敲的。
 * @param levels - 模型发布的等级。
 */
export function resolveLevel(value, levels) {
  const lower = value.trim().toLowerCase()
  if (lower === '') return undefined
  return (
    levels.find((level) => level.id.toLowerCase() === lower) ??
    levels.find((level) => level.name.toLowerCase() === lower)
  )
}

/** 某个等级 id 该印成什么，或 `undefined`（模型没发布它）。 */
function levelName(effort, levels) {
  if (effort === undefined) return undefined
  return resolveLevel(effort, levels)?.name ?? effort
}

/**
 * 渲染一个模型的推理等级，标出生效的那个。
 *
 * 标的是对话**正踩在**的那个等级；对别的模型标的是宿主自己的默认值，
 * 因为那才是切过去会落在的地方。两者对同一个模型不可能同时成立——
 * 这个标记的意思是"你在这里停手，就会得到它"。
 *
 * @param option - 要展示等级的模型。
 * @param current - 宿主报出的选择，可能是另一个模型的。
 * @param levels - 该模型发布的等级。
 */
export function renderLevels(option, current, levels) {
  const onThisModel =
    current !== undefined && current.provider === option.provider && current.model === option.model
  const inEffect = onThisModel ? (current.reasoningEffort ?? option.defaultLevel) : option.defaultLevel
  // 只有**这就是本对话的模型**时才写「（当前）」：在别的模型上标的是宿主的默认值，
  // 把它叫成"当前"是在对一个没人用的模型下断言。
  const mark = onThisModel ? '（当前）' : '（默认）'
  const rows = levels
    .map((level) => `${level.name}${level.id === inEffect ? mark : ''}`)
    .join(' · ')
  const example = levels[0]?.id ?? ''
  return [
    `${option.name} 的推理等级：`,
    '',
    rows,
    '',
    `回复 /model 等级 ${example} 切换。`,
  ].join('\n')
}

/** "没有等级可切"这一类结果的统一措辞。 */
const NO_LEVELS = '当前模型不支持推理等级'
/** `/model` 三种失败的开门见山，放在一起免得措辞各自漂移。 */
const NOT_FOUND_LEVEL = '找不到这个等级'
const FAILED_LEVEL = '切换推理等级没有成功'
const FAILED_MODEL = '切换模型没有成功'

/**
 * 把模型选择渲染成 `provider/model`。
 *
 * 同时接受目录行（`model` 是 id）与选择结果（`model` 也是 id），两者同形是刻意的：
 * 一处渲染、两个来源，用户看到的写法就不会有两套。
 *
 * @param row - `{ provider, model }`。
 */
export function modelLabel(row) {
  const provider = (row?.provider ?? '').trim()
  const model = (row?.model ?? '').trim()
  if (model === '') return provider
  return provider === '' ? model : `${provider}/${model}`
}

/**
 * 渲染模型清单里的一行。
 *
 * 行首的形态沿用本项目原来的（`名字（id） · provider`），等级那一行照抄微信：
 * 等级排在最后，标记方式与会话标题一致——对话**正在用**的那个标「（当前）」，
 * 其余模型标宿主自己的默认值「（默认）」，因为那才是切过去会落在的等级。
 *
 * @param row - `{ provider, providerName, model, name, levels?, defaultLevel? }`。
 * @param index - 0 起的位置，渲染成回复用的 1 起编号。
 * @param current - 当前生效的选择（`{ provider, model, reasoningEffort? }`），在清单里标出。
 */
export function renderModelRow(row, index, current) {
  const isCurrent = row.provider === current?.provider && row.model === current?.model
  const mark = isCurrent ? '  ← 当前' : ''
  // id 与显示名相同时不重复打印，否则每行都会变成"名字（名字）"。
  const id = row.model === row.name ? '' : `（${row.model}）`
  const levels = row.levels ?? []
  const line = `${index + 1}. ${row.name}${id} · ${row.provider}${mark}`
  if (levels.length === 0) return line
  /*
   * 当前模型若没报出等级，就拿它自己的默认等级来标：宿主在没被指名等级时应用的正是那个值
   * （微信在 host 侧补的也是同一个值，见其 `#modelInUse`）。不补的话，
   * "正在用哪个等级"在列表里就没有答案，而那是用户唯一能看到它的地方。
   */
  const inEffect = isCurrent ? (current?.reasoningEffort ?? row.defaultLevel) : row.defaultLevel
  const levelMark = isCurrent ? '（当前）' : '（默认）'
  const printed = levels
    .map((level) => `${level.name}${level.id === inEffect ? levelMark : ''}`)
    .join(' · ')
  return `${line}\n   推理等级：${printed}`
}

/**
 * 渲染可用模型清单。
 *
 * 与 `renderSessionScreen` 一样，编号必须能被 `/model <编号>` 选到——
 * 两个函数是同一份编号契约的两端。
 *
 * 每个模型带上它的推理等级（有的话），因为"用哪个模型"与"它想多深"是同一个选择的两半：
 * 只印前一半，用户就得再问一次，而等级在手机上**别处**看不到（微信的原话）。
 *
 * @param models - {@link resolveModel} 用的那份清单，顺序即编号。
 * @param current - 当前生效的选择，或 `undefined`（会话还没跑过任何请求）。
 */
export function renderModelList(models, current) {
  if (models.length === 0) {
    // **不能安静地回一个空清单**：那与"模型一个都没有"分不清，
    // 而两者的下一步动作完全不同（改配置 vs 换个名字重说）。
    return '宿主没有报出可用的模型。可能是这个组合没配置任何模型提供方，或提供方的凭据还没配好。'
  }
  const at = current === undefined ? undefined : currentLevelName(current, models)
  const now =
    current === undefined ? '' : `，当前是 ${modelLabel(current)}${at === undefined ? '' : ` · ${at}`}`
  const lines = models.map((row, index) => renderModelRow(row, index, current))
  /*
   * 只有真有模型带等级时才提这件事：邀请用户去改一个没有任何模型支持的设置，
   * 是在许一个下一条回复必须食言的诺。
   */
  const anyLevels = models.some((row) => (row.levels?.length ?? 0) > 0)
  const levelHint = anyLevels
    ? [`回复 /model 等级 <等级> 切换推理等级，例如 /model 等级 ${exampleLevelId(models)}。`]
    : []
  return [
    `共 ${String(models.length)} 个可用模型${now}：`,
    '',
    lines.join('\n'),
    '',
    '回复名字或编号即可切换，例如「2」。',
    ...levelHint,
  ].join('\n')
}

/** 当前选择所在模型的等级标签（宿主归一化后印得出名字的那个），查不到则 `undefined`。 */
function currentLevelName(current, models) {
  const row = models.find(
    (candidate) => candidate.provider === current.provider && candidate.model === current.model,
  )
  return levelName(current.reasoningEffort ?? row?.defaultLevel, row?.levels ?? [])
}

/**
 * 打印成例子用的等级 id。
 *
 * 取模型的**默认等级**而不是它发布的第一个：第一个常常是 `off`，
 * 而向一个刚说"给我看看"的人示范关掉思考，是个糟糕的建议。值一律取自数据，
 * 所以它永远不可能指到一个不存在的等级。
 */
function exampleLevelId(models) {
  for (const row of models) {
    const level = row.defaultLevel ?? row.levels?.[0]?.id
    if (level !== undefined && level !== '') return level
  }
  return ''
}

/**
 * 按 DSH 自己的格式铸造会话 id。
 *
 * 形态是 `session-<8位hex>-<uuid>`，因为宿主把这个形态当作它的原生会话身份。
 * 前一段取自随机 uuid，这样 `/list` 显示的紧凑形式也正是 `/switch` 接受的形式——
 * 两者相同才能用手机键盘切换。
 *
 * @param random - 注入用的随机源（测试）。
 */
export function mintSessionId(random = randomUUID) {
  const uuid = random()
  const tail = uuid.replace(/-/g, '').slice(0, 8)
  return `session-${tail}-${uuid}`
}

/**
 * 会话 id 印给用户看的长度。
 *
 * 六个十六进制字符仍然短到能在手机上读和重打，而它取值的空间是 16 777 216 个而不是
 * 四位时的 65 536 个：一台几百条会话的机器上，四位撞得足够频繁、已经被注意到了，
 * 多出来的两个字符是免费的。印出来的形态是 id 的**前缀**，所以撞了之后的答案是
 * "多给几个字符"，而不是失败。这个上限是要求，不是偏好：
 * 一个需要用户复制粘贴的标识符，就不是他会去用的标识符。
 */
export const SHORT_ID_LENGTH = 6

/** 给用户看的紧凑标识，也是 `/switch` 接受的输入。 */
export function shortId(sessionId) {
  const match = /^session-([0-9a-f]+)-/i.exec(sessionId)
  if (match) return match[1].slice(0, SHORT_ID_LENGTH)
  return sessionId.replace(/^session-/, '').slice(0, SHORT_ID_LENGTH)
}

/**
 * 一层浏览清单一屏显示多少行。
 *
 * 十条，因为那是一屏手机装得下的、也是原清单本来的量。两层的意义不是一屏塞更多，
 * 而是让每一个会话都够得着，同时一次从不印超过一眼读得完的量——
 * 那正是原来"切一刀"做不到的事。
 */
export const BROWSE_PAGE_SIZE = 10

/** 不管在哪一层，往下走一屏都用的那句话。 */
export const SHOW_REST = '查看其余'

/**
 * 一条消息是不是"往下翻"那句话。
 *
 * 末尾的句读被剥掉，因为手机键盘会顺手加上而用户是在写一句话，不是在敲一个词。
 * 别的写法一概不认：这句话没有目标，猜一个近似的就等于把用户送到他没要求的地方。
 *
 * @param text - 入站消息。
 */
export function isShowRest(text) {
  return text.trim().replace(/[。．.!！?？]+$/, '') === SHOW_REST
}

/**
 * 把行分组成第一层列出的那些会话夹。
 *
 * 本频道自己的工作区排最前，因为那正是这个聊天创建出来的对话；其余按最近活跃排，
 * 目录名作平手时的次序，好让同一台机器每次给出同一份清单。没有说明自己住哪的行
 * 算本频道自己的——那是一个对话唯一能为之背书的工作区。
 *
 * 数出**条数**，而不是列出行：第一层回答的是"哪个项目"，
 * 而它的行必须小到十条就点名十个项目。空夹子不列——一行点开是空清单，
 * 那是把死路装扮成一个选项。
 *
 * @param rows - 这台机器知道的全部会话。
 * @param options.ownWorkspace - 本频道自己的会话所在的目录。
 * @param options.ownLabel - 那个目录印出来的名字。
 * @returns 非空的会话夹，按显示顺序。
 */
export function sessionFolders(rows, options) {
  let own = 0
  const byPath = new Map()
  for (const row of rows) {
    const path = row.workspace
    const isOwn =
      path === undefined ||
      path === '' ||
      (options.ownWorkspace !== undefined && isSameWorkspace(path, options.ownWorkspace))
    if (isOwn) {
      own += 1
      continue
    }
    const seen = byPath.get(path)
    const at = Number.isFinite(row.updatedAt) ? row.updatedAt : 0
    if (seen === undefined) byPath.set(path, { count: 1, newest: at })
    else {
      seen.count += 1
      if (at > seen.newest) seen.newest = at
    }
  }

  const others = [...byPath.entries()]
    .map(([path, stats]) => ({ path, ...stats }))
    .sort((a, b) => {
      if (a.newest !== b.newest) return b.newest - a.newest
      if (a.path === b.path) return 0
      return a.path < b.path ? -1 : 1
    })

  const folders = []
  if (own > 0) folders.push({ path: options.ownWorkspace ?? '', label: options.ownLabel, count: own })
  for (const group of others) {
    folders.push({
      path: group.path,
      label: workspaceLabel(group.path) || group.path,
      count: group.count,
    })
  }
  return folders
}

/**
 * 从一份排好序的序列里切出一屏十条。
 *
 * @param rows - 整份序列，已排好序。
 * @param page - 要切的屏号，1 起；**夹到范围内**，所以一个已经不存在的存下来的屏号
 *   仍然能渲染出东西，而不是一条空消息。
 * @returns 那一屏的行、它在第几屏、共几屏、从第几行开始。
 */
export function browsePage(rows, page) {
  const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE_SIZE))
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 1
  const current = Math.min(Math.max(wanted, 1), pages)
  const start = (current - 1) * BROWSE_PAGE_SIZE
  return { items: rows.slice(start, start + BROWSE_PAGE_SIZE), page: current, pages, start }
}

/**
 * 一个会话夹的某一屏印出来的编号，给"没有钉住的清单"的调用方用。
 *
 * 只是退路：用户正在看的那份编号是**冻在发出它的那条消息下面**的那份，
 * 调用方有的时候就传它。
 *
 * @param rows - 这个会话夹的全部行，已排序。
 * @param page - 这次回复在回答的那一屏。
 * @returns 那一屏的行，以及印在它们第一个旁边的数字。
 */
export function screenRows(rows, page) {
  const { items, start } = browsePage(rows, page)
  return {
    sessions: items.map((session) => ({ sessionId: session.sessionId, title: session.title })),
    first: start + 1,
  }
}

/**
 * 渲染会话夹清单的一屏。
 *
 * @param folders - 全部会话夹，按显示顺序。
 * @param page - 要印的屏号，1 起。
 */
export function renderFolderScreen(folders, page) {
  const { items, page: current, pages, start } = browsePage(folders, page)
  const sections = [`会话夹（${String(current)}/${String(pages)}）`]
  if (items.length === 0) sections.push('（还没有其它工作区）')
  items.forEach((folder, index) => {
    sections.push(`${String(start + index + 1)}. ${folder.label}  ${String(folder.count)} 个会话`)
  })
  sections.push(
    '',
    current < pages ? '回复编号或名字进入；回复「查看其余」看下十个。' : '回复编号或名字进入。',
  )
  return sections.join('\n')
}

/**
 * 渲染一个会话夹的会话清单的一屏。
 *
 * 编号**跨屏连续**，所以第二屏十条印的是 11..20——数字是用户要回给我们的东西，
 * 从 1 重新开始会让一次浏览里同一个数字有两个意思。
 *
 * @param rows - 这个会话夹里的全部会话，已排序。
 * @param options.label - 会话夹名字，印在标题里。
 * @param options.page - 要印的屏号，1 起。
 * @param options.currentId - 本对话绑定的会话，在清单里标出。
 * @param options.held - 别的会话夹里的会话；数出来、点名，而不是让它们消失。
 * @param options.heldHint - 怎么够到它们，打字与说话不同。
 * @param options.now - 当前时间，好让一条消息里的每一行对"3 分钟前"看法一致。
 * @returns 消息正文，以及它印出的编号。
 */
export function renderSessionScreen(rows, options) {
  const now = options.now ?? Date.now()
  const { items, page, pages, start } = browsePage(rows, options.page)
  const sections = [`【${options.label}】会话（${String(page)}/${String(pages)}）`]
  if (items.length === 0) sections.push('（这个会话夹还没有对话）')
  items.forEach((session, index) => {
    sections.push(renderSessionRow(session, start + index, options.currentId, now))
  })

  const held = options.held
  if (held !== undefined && held.count > 0) {
    const names = held.names ?? []
    sections.push(
      '',
      `另有 ${String(held.count)} 个对话在其它会话夹${
        names.length === 0 ? '' : `（${names.join('、')}）`
      }，${options.heldHint ?? '发 /list all 看会话夹。'}`,
    )
  }

  /*
   * 只有真有地方可去时才把这句话递出去。一屏已经没有下一页、却仍然邀请用户要更多，
   * 是在教他这条指令没用。
   *
   * 行尾那个 id 被**点名**，不只是印出来：用户真的会读了编号就回编号，
   * 而没有任何一句话说过 id 也是一条路——那才是唯一一条不会过期的路。
   */
  sections.push(
    '',
    page < pages
      ? `回复编号或行尾 ${String(SHORT_ID_LENGTH)} 位 id 切换；回复「${SHOW_REST}」看下十个。`
      : `回复编号或行尾 ${String(SHORT_ID_LENGTH)} 位 id 切换。`,
  )
  sections.push('引用这条消息再回编号，可以避免编号过期。')

  return {
    text: sections.join('\n'),
    numbered: {
      sessions: items.map((session) => ({ sessionId: session.sessionId, title: session.title })),
      first: start + 1,
    },
  }
}

/** 一行的标题印到多长就切掉。 */
const TITLE_LIMIT = 24

/**
 * 渲染会话清单里的一行。
 *
 * 标题领头，因为那是人认得出的东西；时间跟上，因为清单就是按它排的；
 * **短 id 收尾**，因为数字不够用时 `/switch` 接受的就是它——
 * 而一个工作区的标题被它下面每一行共享，所以同一个工作区里的两个对话否则无从分辨。
 *
 * 一行而不是两行：十条对话要装进**一条** QQ 消息里，而每行两行高会让一屏手机的容量翻倍。
 *
 * @param session - 要渲染的会话。
 * @param index - 0 起的位置，渲染成回复用的 1 起编号。
 * @param currentId - 本对话绑定的会话，在清单里标出。
 * @param now - 当前时间，好让一条消息里的每一行对"3 分钟前"看法一致。
 * @returns 那一行。
 */
export function renderSessionRow(session, index, currentId, now = Date.now()) {
  const mark = session.sessionId === currentId ? ' ← 当前' : ''
  const title = truncateTitle(session.title ?? '')
  // 没有可用时间戳的记录就不印日期，而不是印成 1970：存储一无所知的会话，
  // 用它的标题来描述比用它从没有过的一个纪元时刻更好。
  const at = session.updatedAt
  const when = at === undefined || !Number.isFinite(at) || at <= 0 ? '' : ` · ${relativeTime(at, now)}`
  return `${String(index + 1)}. ${title}${when}${mark}  ${shortId(session.sessionId)}`
}

/**
 * 一个会话标题印一行时的裁剪。
 *
 * 会话是按用户的第一句话命名的，而那句话经常是整整一段。整段印出来会把时间和 id 挤出屏幕，
 * 而那两样才是这一行存在的理由。
 *
 * ⚠️ **这是"标题怎么裁"的唯一实现。** 会话清单（`/list`）与 agent 那张表
 * （`session_control`，见 `session-tool.js` 的 `renderRow`）都走这里——两边印出来的
 * 行必须逐字相同，标题里一个换行就能让 agent 那张表比用户屏幕上多出一行，
 * 于是"第 4 个是哪个会话"两边就对不上。所以这里 **export**，不要另抄一份。
 *
 * @param title - 记录下来的标题。
 * @returns 装得下的标题，或 `(无标题)`。
 */
export function truncateTitle(title) {
  const trimmed = title.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return '(无标题)'
  return trimmed.length <= TITLE_LIMIT ? trimmed : `${trimmed.slice(0, TITLE_LIMIT)}…`
}

/**
 * 本工作区一个对话都没有时，`/list` 的回答。
 *
 * @param held - 别的会话夹里的会话。
 * @param ownLabel - 本频道工作区的标题。
 */
export function heldOnlyList(held, ownLabel) {
  return [
    `【${ownLabel}】还没有对话，直接发消息就会新建一个。`,
    '',
    `另有 ${String(held.length)} 个对话在其它会话夹${heldHintSuffix(held)}，发 /list all 看会话夹。`,
  ].join('\n')
}

/**
 * 一组被留下的行背后的工作区名字，用于数出它们的那句话。
 *
 * @param held - 没进清单的行。
 * @returns 去重、排好序的工作区标签。
 */
export function heldNames(held) {
  const names = new Set()
  for (const session of held) {
    if (session.workspace !== undefined && session.workspace !== '') {
      names.add(workspaceLabel(session.workspace))
    }
  }
  return [...names].sort()
}

/** `（a、b）` 那一段，没有工作区名字时是空串。 */
function heldHintSuffix(held) {
  const names = heldNames(held)
  return names.length === 0 ? '' : `（${names.join('、')}）`
}

/**
 * 一次进会话夹解析出来的结果。"有歧义"与"找不到"分开，与 `resolveTarget` 一样。
 *
 * @typedef {object} FolderResolution
 * @property {'found'|'ambiguous'|'none'} kind
 * @property {SessionFolder} [folder]
 * @property {SessionFolder[]} [candidates]
 */

/**
 * 把用户敲的东西解析到会话夹清单上。
 *
 * 接受印出来的编号、印出来的名字，或名字的一个片段——与 `resolveTarget` 对会话接受的
 * 那三种形状相同，理由也相同：编号是清单印的，名字是人记得住的。
 *
 * 两个目录共用一个末段是常事（`…/workplace` 出现在两个父目录下），而印出来的名字就是那个末段，
 * 所以一个名字匹配到多个夹子时把候选取出来，而不是替用户挑一个。
 * 进错项目的夹子比多问一句更糟。
 *
 * @param args - 用户回的东西。
 * @param folders - 全部会话夹，按清单编号的顺序。
 * @returns {@link FolderResolution}
 */
export function resolveFolder(args, folders) {
  const value = args.trim()
  if (value === '') return { kind: 'none' }

  if (/^\d+$/.test(value)) {
    const byIndex = folders[Number(value) - 1]
    if (byIndex !== undefined) return { kind: 'found', folder: byIndex }
    // 继续往下：纯数字字符串也可能是个文件夹名字。
  }

  const byLabel = folders.filter((folder) => folder.label === value)
  if (byLabel.length === 1) return { kind: 'found', folder: byLabel[0] }
  if (byLabel.length > 1) return { kind: 'ambiguous', candidates: byLabel }

  // 最后才是**双向**的核心匹配，与会话标题的读法完全一样：人按自己谈论项目的方式称呼它，
  // 所以片段、或名字加上自己的话，都必须成立。唯一性是保险。
  const byCore = folders.filter(
    (folder) => folder.label !== '' && (folder.label.includes(value) || value.includes(folder.label)),
  )
  if (byCore.length === 1) return { kind: 'found', folder: byCore[0] }
  if (byCore.length > 1) return { kind: 'ambiguous', candidates: byCore }

  return { kind: 'none' }
}

/**
 * 一个会话夹名字点到多个夹子时说的话。
 *
 * 候选带着编号印出来，因为编号是唯一不会有歧义的形态，也正是用户接下来要回的东西。
 *
 * @param value - 用户敲的。
 * @param candidates - 它匹配到的每一个夹子。
 * @param folders - 整份清单，好让每个候选带上自己的编号。
 */
export function ambiguousFolderMessage(value, candidates, folders) {
  const lines = candidates.map((folder) => {
    const number = folders.findIndex((candidate) => candidate.path === folder.path) + 1
    return `${String(number)}. ${folder.path}  ${String(folder.count)} 个会话`
  })
  return [
    `有多个会话夹匹配「${value.trim()}」，请回复编号：`,
    '',
    ...lines,
    '',
    '回复 /list all 能再看一次会话夹清单。',
  ].join('\n')
}

/**
 * 一件事过去了多久，用人的说法。
 *
 * 用相对时间而非绝对时间，因为列表回答的问题是"我刚才在弄哪个"，
 * 24 小时制只会让这件事更难，不会更容易。`昨天` 出现是因为人们真的这么说话，
 * 而且那是读的人最在意的那个界线。
 *
 * @param at - 毫秒时间戳。
 * @param now - 当前时间，可注入以便测试，也让一条消息保持一致。
 */
export function relativeTime(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  // 过了几个整天，而不是日历天：25 小时前的对话，按用户的任何一种读法都是"昨天"，
  // 而对准他的时区不值得。
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

export const HELP_TEXT = [
  '可用指令：',
  '/new [标题]      新建对话',
  '/list            列出 QQ 会话（本工作区）',
  '/list all        列出全部会话夹，回复编号或名字进入',
  '/switch <编号>   切换（引用列表消息再回编号，编号不会过期）',
  `/switch <id>     按列表行尾那个 ${String(SHORT_ID_LENGTH)} 位 id 切换，例如 /switch e716f0`,
  '/model <名字>    查看或切换模型（名字、编号或 id）',
  '/model 等级 <等级>  切换当前模型的推理等级',
  '/current         显示当前对话',
  '/cancel          中断当前任务',
  '/help            显示本帮助',
  '',
  `每屏最多 ${String(BROWSE_PAGE_SIZE)} 条，编号跨屏连续；回复「${SHOW_REST}」看下十个。`,
  '列表就在眼前时，直接回编号、名字或行尾 id 即可，不必打 /switch。',
  '',
  '直接发消息即与当前对话对话。',
  '',
  '也可以直接用大白话说，例如「查看对话列表」「换个对话」「换个模型」「把推理等级调到高」「停下」，',
  '我会先问你一次确认，确认后才执行。',
].join('\n')
