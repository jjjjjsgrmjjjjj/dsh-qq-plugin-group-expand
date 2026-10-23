/**
 * 状态文件。
 *
 * 从微信插件的 `StateStore` 移植，四条性质都是踩过坑才有的，不要简化：
 *
 * 1. **原子写**：写临时文件再 `rename`，避免半截 JSON。
 * 2. **0600**：状态文件里有会话映射与 openid，不该给别的用户读。
 * 3. **写串行**：并发 `update` 必须排队，否则后写的覆盖先写的。
 * 4. **加载单飞 + 容错**：文件缺失或损坏时返回**空状态**而不是致命；并发读共享同一次加载，
 *    否则"第二次读回退成空状态并缓存"会把真实状态抹掉。
 * 5. **rename 要重试**（第 5 条是后加的，见 `#write`）：Windows 上**另一个进程正读着目标文件时
 *    `rename` 会报 EPERM**。微信插件实测 2000 次里失败 790 次，而它那边产线上真的可达
 *    （`dsh-wechat-send` 是另一个读同一个 `state.json` 的进程）。本插件是同一个写入模式，
 *    所以只对"文件被占用"那一类错误退避重试；最终失败必须**看得见**，临时文件必须清掉。
 *
 * 与微信插件的一个刻意差异：**AppSecret 不存在这里**。QQ 的 AppSecret 是长期密钥，
 * 放 DSH 的 `ctx.credentials`（见 `credentials.js`）。本文件只放非机密状态。
 *
 * @module dsh-qq/state
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
// ★ 必须从 `node:fs/promises` 取 `readFile`。
// 从 `node:fs` 取到的是回调版 API：`await readFile(...)` 不返回内容，而是抛
// "callback must be a function"，被下面的 catch 吞掉后每次都返回空状态——
// 表现为**每次写盘都只写回当前改动的那一半，另一半静默丢失**。
// 这个 bug 曾经让 accounts 与 bindings 互相覆盖。
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizePending } from './pending.js'
// 设置项的定义**只有一份**（`lib/settings.js`：每项一个校验器 + 一个默认值）。
// 这里原来是一份手抄的九项白名单，与运行时落盘清单是两份各写各的名单——
// 那就意味着"加了设置却忘了改这里"会静默丢字段，而且**每次写盘都重新加载并重新规范化**，
// 于是下一次写盘把这份丢失持久化。见 `settings.js` 文件头。
import { normalizeSettings } from './settings.js'
// 浏览位置与编号清单的归一**只有一份实现**，在 `router.js`（那是它们的语义归属：
// 一个位置决定「查看其余」翻哪一屏、一屏编号决定用户回的那个数字指哪一行）。
// 这里借它来过滤状态文件里的值，免得两处各写一套慢慢漂移——
// 与本项目"一个判定点"的既有做法一致。
import { emptyRouteState, normalizeRouteState } from './router.js'

/** 状态文件的当前版本。字段含义变化时递增。 */
export const STATE_VERSION = 1

/**
 * `rename` 值得再试一次的错误码：**Windows 上"另一个进程正读着这个文件"就报它们**。
 *
 * 只有这一类进重试：`ENOSPC`（磁盘满）/ `EROFS`（只读文件系统）/ `ENOENT`（目录被删）之类
 * **重试多少次结果都一样**，把它们也塞进循环只会让"写不进去"这件事晚 70ms 才被说出来，
 * 还会白白占着写链。
 */
export const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * 每次重试前的等待（毫秒）：**退避递增、上限很短、总时长固定可算**。
 *
 * 与微信那批修复同一个纪律（`docs/POSTMORTEM.md` 与微信插件的 CI 教训）：
 * 不赌固定时长。这里长度决定重试次数——一共尝试 `length + 1` 次，最坏阻塞
 * `10 + 20 + 40 = 70ms`。短是**有意的**：它在同步路径上、又挡在写链上，
 * 宁可这次写失败被说出来，也不要把用户的整个应用卡住。
 */
export const WRITE_RETRY_BACKOFF_MS = [10, 20, 40]

/**
 * 同步睡一小段。
 *
 * ## 为什么不用 `await`（以及为什么不引入裸 Promise）
 *
 * `#write` 是**同步**的，而它是写链里唯一真正落盘的那一步。把它改成 async 并不会破坏
 * `update()` 的串行化（`update` 本来就是异步的），但会让落盘这一步从"`run` 里一次同步调用"
 * 变成"必须被 await 的 Promise"——而**任何一处漏掉 await 的调用都会产生一个裸 Promise**，
 * 那正是 `docs/POSTMORTEM.md` 003 记下的致命模式（脱离 await 链的异步 + 未处理 rejection＝
 * 释放整个应用）。所以这里保留同步语义，用同步睡眠：`Atomics.wait` 是真的睡（不烧 CPU），
 * 而它在 Node 的主线程上可用。
 *
 * @param ms - 毫秒。
 */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

/**
 * 这个错误是不是"文件被占用"那一类。
 *
 * @param error - 抛出的东西。
 * @returns 值不值得再试一次。
 */
function isRetryableRenameError(error) {
  return RETRYABLE_RENAME_CODES.has(error?.code)
}

/**
 * 空状态。
 */
export function emptyState() {
  const route = emptyRouteState()
  return {
    version: STATE_VERSION,
    /** appId → 账号信息（**不含 AppSecret**）。 */
    accounts: {},
    /** conversationId → 会话绑定。 */
    bindings: {},
    /**
     * conversationId → 浏览位置 `{ level, workspace, page, at }`。
     *
     * **必须持久化**：「查看其余」没有目标，它的意思是"我正在看的那份的下十条"，
     * 而这份记录是唯一知道"我正在看哪份"的东西。重启之后位置还在，才谈得上"接着翻"。
     */
    browsing: route.browsing,
    /**
     * conversationId → 最近发出的几屏编号清单（正文 + 行 + 起始编号）。
     *
     * 微信把编号钉在**消息 id** 上；QQ 的引用直接给正文，所以这里钉的是正文本身。
     * 存下来之后，即使 DSH 重启过，一次引用仍然能按那条消息印的编号解析。
     */
    sessionLists: route.sessionLists,
    /**
     * 用户在设置页调过的项。
     *
     * **必须持久化**：这些是用户显式选择的行为，重启后静默回默认值是最糟的一种"没有效果"——
     * 用户会在下次真正需要它们的时候才发现。微信插件同样把这些存在它的状态文件里。
     * 缺字段一律回落到默认值（见 `runtime.js` 的 DEFAULT_* 常量），所以老状态文件仍然可读。
     */
    settings: {},
    /**
     * 主动推送被拒时存下来的待发消息，等用户下次说话时补发。
     *
     * 见 `pending.js`：**"发不出去"和"丢掉"是两回事**。
     */
    pendingNotifications: [],
    /** 是否在启动时自动重连。 */
    autoStart: true,
  }
}

/**
 * 把任意解析结果归一化成合法状态。
 *
 * 逐字段过滤而不是整体信任：旧版本写下的文件、手工编辑过的文件都会经过这里。
 *
 * @param value - `JSON.parse` 的结果。
 */
export function normalizeState(value) {
  const base = emptyState()
  if (typeof value !== 'object' || value === null) return base
  const record = value

  const state = { ...base, version: STATE_VERSION }

  if (typeof record.autoStart === 'boolean') state.autoStart = record.autoStart

  // 待发队列：逐条过滤，坏条目丢掉而不是整体拒绝——一条坏记录不该让所有待发消息消失。
  state.pendingNotifications = normalizePending(record.pendingNotifications)

  /*
   * 设置逐字段过滤，**由 `SETTINGS_SCHEMA` 驱动**（不再手抄字段名与类型）。
   *
   * 这样一份被手工编辑坏的状态文件不会把非法值带进运行时的行为里，
   * 而"加了设置却没加校验器"在纯 JS 里唯一的挡板就是测试——
   * 所以校验器表与运行时设置字段集的键集一致性由 `verify.mjs` 断言（见那里的注释）。
   *
   * 语义与迁移前逐条一致：越界或类型不对**丢弃该字段**（下落不明的那一项保持
   * 运行时的默认值），不是回落到默认值；空串在 `presenceNote` / `workspacePath`
   * 上都是合法值。唯一的收紧是数值项现在也施加与运行时相同的上限
   * （`CEILING_MS` / `CEILING_CHARS`）——迁移前这一层只判"非负"，上限在
   * `hydrateSettings` 里。因为读回时那边本来就会丢掉越界值，运行时的可观测行为不变。
   */
  state.settings = normalizeSettings(record.settings)

  if (typeof record.accounts === 'object' && record.accounts !== null) {
    for (const [appId, raw] of Object.entries(record.accounts)) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw
      state.accounts[appId] = {
        appId,
        userOpenid: typeof account.userOpenid === 'string' ? account.userOpenid : undefined,
        boundAt: typeof account.boundAt === 'string' ? account.boundAt : undefined,
        enabled: account.enabled !== false,
      }
    }
  }

  if (typeof record.bindings === 'object' && record.bindings !== null) {
    for (const [conversationId, raw] of Object.entries(record.bindings)) {
      if (typeof raw !== 'object' || raw === null) continue
      const binding = raw
      if (typeof binding.sessionId !== 'string') continue
      if (typeof binding.peerId !== 'string') continue
      state.bindings[conversationId] = {
        conversationId,
        accountId: typeof binding.accountId === 'string' ? binding.accountId : '',
        peerId: binding.peerId,
        sessionId: binding.sessionId,
        title: typeof binding.title === 'string' ? binding.title : '',
        createdAt: typeof binding.createdAt === 'number' ? binding.createdAt : Date.now(),
        lastUsedAt: typeof binding.lastUsedAt === 'number' ? binding.lastUsedAt : Date.now(),
      }
    }
  }

  // 浏览位置与编号清单走 `router.js` 那一份归一（见文件头的 import 注释）。
  const route = normalizeRouteState({ browsing: record.browsing, sessionLists: record.sessionLists })
  state.browsing = route.browsing
  state.sessionLists = route.sessionLists

  return state
}

/**
 * 会话键。
 *
 * 两种形态，私聊那条**一个字符都没变**（老状态文件里的绑定键因此继续有效）：
 *
 * - 私聊：`accountId:peerId` —— 与加群聊之前完全一致；
 * - 群聊：`accountId:group:groupId` —— 中间那一段 `group` 是作用域标记。
 *
 * 为什么群聊不用 `accountId:groupId`：群 openid 与用户 openid 是两套 id，但键空间
 * 没有必要赌它们不撞。显式的作用域标记让 {@link parseConversationKey} 能无歧义地读回来，
 * 也让日志里一眼看出这个对话是群还是私聊。
 *
 * @param accountId - 机器人 appId。
 * @param peerId - 私聊对方 openid；群聊时传群 openid（保留这个参数是为了调用点读起来一致）。
 * @param groupId - 群 openid；给了就是群聊键。
 */
export function conversationKey(accountId, peerId, groupId) {
  return typeof groupId === 'string' && groupId !== ''
    ? `${accountId}:group:${groupId}`
    : `${accountId}:${peerId}`
}

/**
 * 把会话键拆回作用域与目标 id。
 *
 * 这是键格式的**唯一一份**解析实现：`runtime.js` 的出站目标解析、typing、待发队列
 * 都走它。两处各写一遍解析，正是"群聊消息发到私聊"这类错误的来源。
 *
 * @param conversationId - 会话键。
 * @returns `{ scope: 'c2c'|'group', accountId, peerId }`；格式不认识时按私聊处理。
 */
export function parseConversationKey(conversationId) {
  const text = String(conversationId ?? '')
  const marker = ':group:'
  const index = text.indexOf(marker)
  if (index !== -1) {
    return {
      scope: 'group',
      accountId: text.slice(0, index),
      peerId: text.slice(index + marker.length),
    }
  }
  const colon = text.indexOf(':')
  /*
   * 没有冒号 = 这不是一个由 {@link conversationKey} 造出来的键（调用方传错了）。
   * 返回空 peerId 让 `#targetFor` 拒绝发送：把整段当成 peerId 会把消息发给
   * 一个叫这个 appId 的"用户"——比不发送糟得多。
   */
  if (colon === -1) return { scope: 'c2c', accountId: '', peerId: '' }
  return { scope: 'c2c', accountId: text.slice(0, colon), peerId: text.slice(colon + 1) }
}

/**
 * 串行化、原子化的状态存储。
 */
export class StateStore {
  /** @type {string} */
  #file
  /** 已排队写入的尾部 Promise，保证写操作严格串行。 */
  #writeChain = Promise.resolve()
  /** 进行中的加载；并发读共享它。 */
  #loading
  /** 非预期读失败或最终写失败的上报口（不抛错，只记录）。 */
  #onError
  /** "靠重试才写成"的上报口。**不是错误**，所以与 #onError 分开。 */
  #onRetry
  /** 真正的 `rename`；注入点，见 {@link StateStore} 的构造参数。 */
  #rename

  /**
   * @param file - 状态文件绝对路径。
   * @param options.onError - 上报非预期读失败与**最终写失败**；省略则静默。
   * @param options.onRetry - 一次写盘靠重试才成功时上报一行；省略则静默。
   * @param options.rename - 覆盖真正的 `renameSync`。**这是注入点**：Windows 的
   *   "有进程正读着文件"是操作系统行为，无法在本机按需复现（本项目有一条纪律：
   *   测试要测**我们代码的契约**，不去赌操作系统的 errno）。测试注入一个必然失败的
   *   rename 来验证重试逻辑本身；生产路径从不传它。
   */
  constructor(file, options = {}) {
    this.#file = file
    this.#onError = options.onError
    this.#onRetry = options.onRetry
    this.#rename = options.rename ?? renameSync
  }

  /** 状态文件路径。 */
  get file() {
    return this.#file
  }

  /**
   * 读取状态。文件不存在或损坏时返回空状态。
   */
  async read() {
    if (this.#loading !== undefined) return this.#loading
    this.#loading = this.#load()
    try {
      return await this.#loading
    } finally {
      // 加载完成后释放单飞锁，让下一次读能拿到最新写盘结果。
      this.#loading = undefined
    }
  }

  async #load() {
    let text
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      // 只有"文件不存在"是预期内的。其它读失败（权限、API 用错、路径异常）必须发声——
      // 上面的回调版 readFile bug 就是被"一律当不存在"吞掉的，代价是每次写盘丢一半状态。
      if (error?.code !== 'ENOENT') {
        this.#onError?.(`读取状态文件失败（按空状态继续，可能会覆盖已有状态）: ${error?.message ?? String(error)}`)
      }
      return emptyState()
    }
    try {
      return normalizeState(JSON.parse(text))
    } catch (error) {
      // 损坏的状态不能变成致命错误；留一份坏文件供排查，然后从空状态继续。
      this.#onError?.(`状态文件损坏，已改名留档: ${error?.message ?? String(error)}`)
      try {
        renameSync(this.#file, `${this.#file}.corrupt`)
      } catch {
        // 改名失败无所谓。
      }
      return emptyState()
    }
  }

  /**
   * 原子地修改状态。
   *
   * @param mutate - 就地进行修改的函数。
   * @returns 修改后的状态。
   */
  async update(mutate) {
    const run = async () => {
      const state = await this.#load()
      mutate(state)
      this.#write(state)
      return state
    }
    // 串到写链尾部，保证不会有两个 update 交错。
    const next = this.#writeChain.then(run, run)
    this.#writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 原子写：临时文件 → `rename`。**同步**，并且会重试"文件被占用"那一类失败。
   *
   * ## 重试的两个边界
   *
   * - **只重试 `RETRYABLE_RENAME_CODES`**：那是暂时的占用，等一下就过去了。
   *   磁盘满之类一次就放弃——重试它们只是把坏消息推迟。
   * - **次数与时长都有上限**（`WRITE_RETRY_BACKOFF_MS`）：这是同步路径，它挡在写链上。
   *
   * ## 放弃时三件事都要做到
   *
   * 1. **清掉临时文件**：留下 `.tmp` 既是垃圾，也会让下一次排查误以为"写了一半"；
   * 2. **上报**（`onError`）：这次改动**没有落盘**，而调用方可能只是把它 `#fire` 掉了；
   * 3. **抛出**：保持"写失败会传到调用方"这一原有契约。
   *
   * @param state - 要落盘的状态。
   */
  #write(state) {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temp = `${this.#file}.${process.pid}.tmp`
    /** `rename` 被调用的次数；`0` 表示连临时文件都没写成。 */
    let attempts = 0
    /** 最后一次 `rename` 失败的错误码，供成功后的重试记录用。 */
    let lastCode
    try {
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      for (;;) {
        attempts += 1
        try {
          this.#rename(temp, this.#file)
          break
        } catch (error) {
          lastCode = error?.code
          // 不可重试、或退避次数用尽 → 交给下面的 catch 去清理与上报。
          if (!isRetryableRenameError(error) || attempts > WRITE_RETRY_BACKOFF_MS.length) throw error
          sleepSync(WRITE_RETRY_BACKOFF_MS[attempts - 1])
        }
      }
      /*
       * 重试成功也留一行（走 `onRetry`，不进错误环）。
       *
       * 这一行的用途不是"报警"，而是**证据**：不记它，就没有任何人能知道这台机器上是否真的
       * 会遇到那个占用错误——而微信插件那边"重试到底有没有被用到"正是它没能证实的东西。
       */
      if (attempts > 1) {
        this.#onRetry?.(
          `rename 重试后写成：file=${this.#file} attempts=${String(attempts)} code=${String(lastCode)}`,
        )
      }
      return
    } catch (error) {
      // 1. 清掉临时文件。没写成过就没有它；删不掉也不该盖住真正的原因。
      try {
        unlinkSync(temp)
      } catch {
        // 见上。
      }
      // 2. 上报：这份改动没有落盘。
      const detail =
        attempts === 0
          ? 'writeFileSync 失败'
          : `rename 尝试 ${String(attempts)} 次后放弃（` +
            `${isRetryableRenameError(error) ? '可重试的错误但次数用尽' : '不可重试的错误'}` +
            `，code=${String(error?.code)}）`
      this.#onError?.(
        `写状态文件失败，这份改动没有落盘：${detail} file=${this.#file} ` +
          `error=${error?.message ?? String(error)}`,
      )
      // 3. 抛给调用方（与加重试之前一样）。
      throw error
    }
  }
}
