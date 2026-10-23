/**
 * 发送路径自检：用**假 SDK** 真跑一遍 `QqRuntime` 的发送路径。
 *
 * 为什么必须有这个文件：`#send` 那条路径上有三件安全攸关的事——被动→主动降级、
 * `ReplyLimiter` 限流、超长分块。它们只在"真的调用 `bot.sendText`"时才执行，
 * 所以纯函数级自检（`verify.mjs`）碰不到。这个文件是那条路径**唯一**的测试。
 *
 * ## 假 SDK 怎么进去的
 *
 * 用 `node:module` 的 `register()` 装一个 `resolve` 钩子，把
 * `@tencent-connect/qqbot-nodejs` 映射到内联的假实现。**`node_modules` 一个字节都不动**：
 * 这个仓库以前的做法是改写 `node_modules` 里的 `dist/index.js` 再还原，
 * 那东西一旦还原失败就会把用户装好的插件弄坏。
 *
 * `@tencent-connect/qqbot-nodejs/protocol` **不伪造**，仍然加载真包——
 * 这一测的正是 `ReplyLimiter` 与 `chunkText` 的真实行为。
 *
 * ## 入口的选择
 *
 * 大部分场景从 `push()` 进（它直接转发给 `#send`）。但 `push()` 丢掉返回值，
 * 而"返回 true/false"是安全语义（待发队列靠它决定入不入队），所以返回值那几条
 * 改从 `notifyFromTool()`（`notify_qq`）进——那是 `#deliverOrQueue` 这一条真实消费路径，
 * "文本已发送"与"文本已排队"就是 `#send` 的 true/false。
 *
 * 用法：node scripts/verify-send-path.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

let failures = 0

/** 断言相等。 */
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${String(expected)}，实际 ${String(actual)}`}`)
}

/** 断言为真（用于 `includes` 这类谓词）。 */
function checkThat(label, actual) {
  check(label, actual === true, true)
}

function show(label, value) {
  console.log(`      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

// ---------------------------------------------------------------- 假 SDK 注入

/**
 * 假 `QQBot`。`sendText` 的每一次尝试逐次记进 `attempts`；成功的同时进 `sent`。
 * 拒绝与否由构造后的 `plan` 决定（默认全放行）。
 *
 * 每个实例都进 `instances`，因为**运行时的 bot 是它自己 new 的**（`start()` 里
 * `new QQBot(...)`），外部塞不进去——测试只能从这份名册里把运行时那一个领回来。
 *
 * `start()` 返回一个立刻兑现的 Promise 并**结束**，不是永不兑现的：
 * 运行时那边是 `void bot.start().catch(...)`，挂着一个永不落定的 Promise
 * 会让这个测试进程永远不退出（也不报错，只是挂着）。
 */
const FAKE_SDK_SOURCE = `
import { EventEmitter } from 'node:events'

export const instances = []

export class QQBot extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.attempts = []
    this.plan = () => ({ ok: true })
    instances.push(this)
  }

  async start() {}

  stop() {}

  async sendText(target, content) {
    // 记的是**值**，不是引用：里面那个 target 对象可能在别处被复用。
    const attempt = {
      target: { scope: target?.scope, targetId: target?.targetId, msgId: target?.msgId },
      text: content,
    }
    this.attempts.push(attempt)
    const verdict = this.plan(attempt, this.attempts.length)
    if (verdict.ok) {
      this.sent.push(attempt)
      return { ok: true }
    }
    throw new Error(verdict.why ?? '假 SDK 拒绝发送')
  }

  // 群聊自动接话会走这两条：typing 属于"尽力而为"，图片在测试里不真的发。
  async sendTyping() {}

  async sendImage() {
    return { upload: { ok: true }, message: { ok: true } }
  }
}
`

// 真 protocol 的入口。这里拿到的是**官方那个文件**：钩子只拦截裸包名，
// 不碰它，所以原样交给 Node 加载——`ReplyLimiter` / `chunkText` 用的都是真货。
// 不能用 `createRequire().resolve()` 取：那个包只声明了 `import` 条件，CJS 条件解不开它。
const PROTOCOL_URL = import.meta.resolve('@tencent-connect/qqbot-nodejs/protocol')
const FAKE_SDK_URL = `data:text/javascript;base64,${Buffer.from(FAKE_SDK_SOURCE, 'utf8').toString('base64')}`

const HOOK_SOURCE = `
const FAKE = ${JSON.stringify(FAKE_SDK_URL)}
const PROTOCOL = ${JSON.stringify(PROTOCOL_URL)}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@tencent-connect/qqbot-nodejs') {
    return { url: FAKE, shortCircuit: true }
  }
  if (specifier === '@tencent-connect/qqbot-nodejs/protocol') {
    return { url: PROTOCOL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`

register(
  `data:text/javascript;base64,${Buffer.from(HOOK_SOURCE, 'utf8').toString('base64')}`,
  pathToFileURL(`${process.cwd()}/`),
)

const { QQBot: FakeQQBot, instances } = await import('@tencent-connect/qqbot-nodejs')
const protocol = await import('@tencent-connect/qqbot-nodejs/protocol')
const { TEXT_CHUNK_LIMIT } = protocol
const { conversationKey } = await import('../lib/state.js')

checkThat(
  '注入生效：QQBot 换成了假实现',
  FakeQQBot.name === 'QQBot' && typeof FakeQQBot.prototype.sendText === 'function' && Array.isArray(instances),
)
check('protocol 仍走真包', typeof TEXT_CHUNK_LIMIT, 'number')
show('TEXT_CHUNK_LIMIT', TEXT_CHUNK_LIMIT)

// ---------------------------------------------------------------- 测试脚手架

/** 假会话控制器记录下来的提示词（第 9 节用它断言"连续对话"真的进了 agent）。 */
const prompted = []
/** 权限预设施加记录（第 9 节用它断言新会话默认被强制只读）。 */
const presetCalls = []
/** 每个会话已有的消息：渠道说明只随第一条提示词走一次。 */
const sessionMessages = new Map()

/** 宿主上下文：只提供工具、权限预设目录、会话存储与会话控制器，其余服务缺失应当被容忍。 */
const services = {
  tools: { register: () => () => {} },
  permissionPresets: {
    names: ['read-only', 'workspace-write', 'danger-full-access', 'auto'],
    set: (session, name) => {
      presetCalls.push({ sessionId: session?.id, name })
    },
  },
  sessions: {
    get: (id) => ({ id, deriveMessages: () => sessionMessages.get(id) ?? [] }),
  },
  sessionController: {
    create: async () => {},
    rename: async () => {},
    prompt: async (request) => {
      prompted.push(request)
      sessionMessages.set(request.sessionId, [
        ...(sessionMessages.get(request.sessionId) ?? []),
        { role: 'user' },
      ])
    },
    cancel: async () => {},
  },
}
const ctx = { get: (name) => services[name], sessionController: services.sessionController }

const APP_ID = '1905760478'
const credentials = {
  available: true,
  save: async () => ({}),
  load: async () => ({ appId: APP_ID, appSecret: 'fake-secret' }),
  remove: async () => {},
  describe: async () => ({ configured: true }),
}

/**
 * 起一个**全新的**运行时，并连上一个假 bot。
 *
 * 每个场景一个实例：`ReplyLimiter` 是实例状态，共用实例会让上一个场景攒下的
 * 计数泄漏到下一个（第 7 条正是靠这个计数攒满 4 次）。
 *
 * @param options.peerId - 预先写进状态文件的绑定；`undefined` 表示没有绑定。
 * @param options.connected - `false` 表示不调用 `start()`，即"未连接"。
 */
async function newRuntime({ peerId, connected = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-send-path-'))
  const { QqRuntime } = await import('../lib/runtime.js')

  const bindings = {}
  if (peerId !== undefined) {
    const conversationId = conversationKey(APP_ID, peerId)
    bindings[conversationId] = {
      conversationId,
      accountId: APP_ID,
      peerId,
      sessionId: 'session-send-path',
      title: 'qq',
      lastUsedAt: Date.now(),
    }
  }
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      accounts: { [APP_ID]: { appId: APP_ID, enabled: true } },
      bindings,
      autoStart: true,
    }),
    'utf8',
  )

  const runtime = new QqRuntime(ctx, {
    home: dir,
    stateFile: join(dir, 'state.json'),
    workspace: join(dir, 'dsh_qq'),
    credentials,
  })
  if (!connected) return { runtime, dir, bot: undefined, conversationId: conversationKey(APP_ID, peerId ?? '') }

  // 运行时的 bot 是 `start()` 内部 new 出来的，所以从名册里领运行时刚造的那一个。
  const before = instances.length
  await runtime.start(APP_ID)
  checkThat('脚手架：假 bot 已挂上运行时', runtime.connected === true)
  check('脚手架：运行时恰好新造了一个假 bot', instances.length, before + 1)
  const bot = instances[instances.length - 1]
  return { runtime, dir, bot, conversationId: conversationKey(APP_ID, peerId ?? '') }
}

/**
 * 让运行时"见过"一条入站消息，于是它记住了这个对话的 `msgId`。
 *
 * 走的是运行时真正的入站入口（`bot.on('message')`），不是内部字段——测的才是真实链路。
 * 正文故意留空：`#handleInbound` 记下 `msgId` 后会提前返回，不碰 DSH 会话，
 * 于是这里只覆盖发送路径本身。
 */
async function seeInbound(bot, { peerId, msgId }) {
  bot.emit('message', {}, { kind: 'c2c', messageId: msgId, senderId: peerId, content: '', attachments: [] })
  // `#handleInbound` 记下 msgId 之前有若干 `await`，让出一拍等它落定。
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/**
 * 发一条群消息，等处理落定。
 *
 * 走真实的 `bot.on('message')` 入口与群聊门禁（`lib/group.js`）。带 @ 的消息
 * 会进入 agent 路径，所以第 9 节给宿主补了一个假的 `sessionController`。
 *
 * @param options.rawEventType - 平台事件类型；`GROUP_AT_MESSAGE_CREATE` 表示 @。
 */
async function emitGroup(bot, { groupId, content, msgId, rawEventType = 'GROUP_MESSAGE_CREATE' }) {
  bot.emit('message', {}, {
    kind: 'group',
    rawEventType,
    groupOpenid: groupId,
    senderId: 'MEMBER-1',
    senderName: '群友甲',
    messageId: msgId,
    content,
    attachments: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
}

/** 最近若干条错误里有没有含这段文字的。 */
async function errorMatches(runtime, needle) {
  const errors = (await runtime.status()).errors
  return errors.some((line) => line.includes(needle))
}

// ---------------------------------------------------------------- 1. 被动窗口内

{
  const { runtime, dir, bot, conversationId } = await newRuntime({ peerId: 'PEER_A' })
  try {
    await seeInbound(bot, { peerId: 'PEER_A', msgId: 'MSG-1' })

    // 返回值那一半：`notify_qq` 走的正是"看 #send 的返回值决定入不入队"。
    const outcome = await runtime.notifyFromTool({ text: '窗口内的回复' }, { agent: { session: { id: 'session-send-path' } } })
    checkThat('1. 窗口内：报"文本已发送"（#send 返回 true）', outcome.includes('文本已发送'))

    check('1. 只调了一次 sendText', bot.sent.length, 1)
    check('1. target 带 msgId', bot.sent[0]?.target.msgId, 'MSG-1')
    check('1. target 指向对方', bot.sent[0]?.target.targetId, 'PEER_A')
    check('1. scope 是 c2c', bot.sent[0]?.target.scope, 'c2c')
    check('1. 文本原样送达', bot.sent[0]?.text, '窗口内的回复')
    check('1. 没有错误', (await runtime.status()).errors.length, 0)
    show('1. 对话键', conversationId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 2. 被动失败 → 主动兜底

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_B' })
  try {
    await seeInbound(bot, { peerId: 'PEER_B', msgId: 'MSG-2' })
    // 带 msgId 的那次被拒（窗口过期的真实形态），不带 msgId 的放行。
    bot.plan = (attempt) => (attempt.target.msgId === undefined ? { ok: true } : { ok: false, why: '窗口已过期' })

    const outcome = await runtime.notifyFromTool({ text: '兜底推送' }, { agent: { session: { id: 'session-send-path' } } })
    checkThat('2. 兜底成功后报"文本已发送"（#send 返回 true）', outcome.includes('文本已发送'))
    check('2. 试了两次', bot.attempts.length, 2)
    check('2. 第一次带 msgId', bot.attempts[0]?.target.msgId, 'MSG-2')
    check('2. 第二次不带 msgId', bot.attempts[1]?.target.msgId, undefined)
    check('2. 第二次仍是 c2c', bot.attempts[1]?.target.scope, 'c2c')
    check('2. 第二次仍打到同一个人', bot.attempts[1]?.target.targetId, 'PEER_B')
    check('2. 只有主动那次算成功', bot.sent.length, 1)
    check('2. 兜底时两块文本一致', bot.attempts[0]?.text, bot.attempts[1]?.text)
    check('2. 兜底成功不留下"发送失败"', await errorMatches(runtime, '发送失败'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 3. 两条路都失败

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_C' })
  try {
    await seeInbound(bot, { peerId: 'PEER_C', msgId: 'MSG-3' })
    bot.plan = () => ({ ok: false, why: '平台拒绝' })

    let threw
    let outcome
    try {
      outcome = await runtime.notifyFromTool({ text: '发不出去' }, { agent: { session: { id: 'session-send-path' } } })
    } catch (error) {
      threw = error
    }
    check('3. 没有抛出', threw, undefined)
    checkThat('3. 转成"已排队"（#send 返回 false）', String(outcome).includes('文本已排队'))
    check('3. 两次都试过了', bot.attempts.length, 2)
    check('3. 成功零条', bot.sent.length, 0)
    // `describeError` 的形态是 `<name>: <message>`，所以这里连 `Error:` 一起对。
    checkThat('3. 错误里记下被动那次', await errorMatches(runtime, '发送失败: Error: 平台拒绝'))
    checkThat('3. 错误里记下主动那次', await errorMatches(runtime, '主动推送也失败: Error: 平台拒绝'))
    show('3. status().errors', (await runtime.status()).errors)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 4. 超长文本分块

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_D' })
  try {
    await seeInbound(bot, { peerId: 'PEER_D', msgId: 'MSG-4' })
    const long = 'a'.repeat(TEXT_CHUNK_LIMIT * 2 + 10)

    await runtime.push(conversationKey(APP_ID, 'PEER_D'), long)
    check('4. 切成 3 块', bot.sent.length, 3)
    check('4. 第一块正好是上限', bot.sent[0]?.text.length, TEXT_CHUNK_LIMIT)
    check('4. 第二块正好是上限', bot.sent[1]?.text.length, TEXT_CHUNK_LIMIT)
    check('4. 第三块是余数', bot.sent[2]?.text.length, 10)
    check('4. 每块都带上同一条 msgId', bot.sent.every((one) => one.target.msgId === 'MSG-4'), true)
    check('4. 拼回来不丢字符', bot.sent.map((one) => one.text).join('').length, long.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 5. bot 未连接

{
  const { runtime, dir } = await newRuntime({ peerId: 'PEER_E', connected: false })
  try {
    let threw
    try {
      await runtime.push(conversationKey(APP_ID, 'PEER_E'), '没连上')
    } catch (error) {
      threw = error
    }
    check('5. 没有抛出', threw, undefined)
    check('5. 确实没连上', runtime.connected, false)
    checkThat('5. 记下"未连接 QQ"', await errorMatches(runtime, '未连接 QQ，消息丢弃'))
    // 返回值那一半：未连接时待发队列必须接管，否则这条消息就凭空消失了。
    const outcome = await runtime.notifyFromTool({ text: '没连上' }, { agent: { session: { id: 'session-send-path' } } })
    checkThat('5. 转成"已排队"（#send 返回 false）', String(outcome).includes('文本已排队'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 6. 找不到 peerId

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_F' })
  try {
    // 对话键只有一段：既没有入站记录可取，也切不出第二段。
    let threw
    try {
      await runtime.push(APP_ID, '没有收件人')
    } catch (error) {
      threw = error
    }
    check('6. 没有抛出', threw, undefined)
    check('6. 一条都没发出去', bot.attempts.length, 0)
    checkThat('6. 记下"找不到对话的 peerId"', await errorMatches(runtime, '找不到对话的 peerId'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 7. ReplyLimiter 用尽

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_G' })
  try {
    await seeInbound(bot, { peerId: 'PEER_G', msgId: 'MSG-7' })

    // 同一条 msgId 前 4 次走被动，第 5 次必须由 ReplyLimiter 判定降级为主动。
    for (let i = 0; i < 5; i += 1) {
      const outcome = await runtime.notifyFromTool(
        { text: `第 ${String(i + 1)} 条` },
        { agent: { session: { id: 'session-send-path' } } },
      )
      checkThat(`7. 第 ${String(i + 1)} 条报"文本已发送"`, outcome.includes('文本已发送'))
    }

    const msgIds = bot.sent.map((one) => one.target.msgId)
    check('7. 5 次都发出去了', bot.sent.length, 5)
    check('7. 前 4 次被动（带 msgId）', JSON.stringify(msgIds.slice(0, 4)), JSON.stringify(['MSG-7', 'MSG-7', 'MSG-7', 'MSG-7']))
    check('7. 第 5 次转主动（不带 msgId）', msgIds[4], undefined)
    check('7. 转主动后仍打到同一个人', bot.sent[4]?.target.targetId, 'PEER_G')
    check('7. 转主动不是靠重试（每次只调一次）', bot.attempts.length, 5)
    check('7. 没有留下错误', (await runtime.status()).errors.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 8. 群聊自动接话

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_H' })
  try {
    // 关掉图片概率并拉长冷却，这样断言只关心"发到哪、说了没有"。
    runtime.applySettings({ groupStickerChance: 0, groupSpeakCooldownMs: 60_000, groupCollectStickers: false })

    await emitGroup(bot, { groupId: 'GROUP-1', content: '鲸鱼娘', msgId: 'GM-1' })
    check('8. 点名人格后接了一句', bot.sent.length, 1)
    check('8. 接话 scope 是 group', bot.sent[0]?.target.scope, 'group')
    check('8. 接话发到群而不是成员', bot.sent[0]?.target.targetId, 'GROUP-1')
    check('8. 接话带被动 msgId', bot.sent[0]?.target.msgId, 'GM-1')
    checkThat('8. 接话正文非空（短句 + emoji 兜底）', typeof bot.sent[0]?.text === 'string' && bot.sent[0].text.length > 0)

    // 冷却期内再说一次：不该刷屏。
    await emitGroup(bot, { groupId: 'GROUP-1', content: '鲸鱼娘', msgId: 'GM-2' })
    check('8. 冷却期内不重复接话', bot.sent.length, 1)

    // 没提人格：一条都不发，也不建会话。
    await emitGroup(bot, { groupId: 'GROUP-1', content: '今天吃什么', msgId: 'GM-3' })
    check('8. 没提人格就不发言', bot.sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 9. @ 后连续对话

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_I' })
  try {
    prompted.length = 0
    presetCalls.length = 0
    // 窗口开 3 秒，关掉表情包收藏，避免后台下载干扰。
    runtime.applySettings({ groupFollowUpWindowMs: 3_000, groupCollectStickers: false })

    // 先 @ 一次：这是窗口的起点，也是唯一一次需要 @。
    await emitGroup(bot, {
      groupId: 'GROUP-F',
      content: '鲸鱼娘在吗',
      msgId: 'GF-1',
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    checkThat('9. @ 后被交给 agent（会话收到提示词）', prompted.length >= 1)
    checkThat(
      '9. 新会话默认被强制「仅可查看」',
      presetCalls.some((call) => call.name === 'read-only'),
    )
    const firstPromptText = prompted[0]?.content?.[0]?.text ?? ''
    checkThat('9. 首条提示词带渠道上下文说明', firstPromptText.includes('[渠道：QQ]'))
    const afterAt = prompted.length

    /*
     * 群回复必须复用最近一次 @ 的 msg_id。
     *
     * 非 @ 消息自己的 id 不是平台认可的被动回复凭据；用它会被当成主动消息，
     * 而未发布/未认证的官方机器人没有群主动消息权限。这里直接看发出的 target。
     */
    await runtime.push(conversationKey(APP_ID, 'GROUP-F', 'GROUP-F'), '被动目标测试')
    check('9. 群回复用最近 @ 的 msgId', bot.sent.at(-1)?.target.msgId, 'GF-1')
    check('9. 群回复 scope 仍是 group', bot.sent.at(-1)?.target.scope, 'group')

    // 不再 @，只是接着说话：窗口内应当继续交给 agent。
    await emitGroup(bot, { groupId: 'GROUP-F', content: '那你接着说', msgId: 'GF-2' })
    checkThat('9. 窗口内不 @ 也接着交给 agent', prompted.length > afterAt)
    const secondPromptText = prompted[afterAt]?.content?.[0]?.text ?? ''
    check('9. 第二条起不再重复渠道说明', secondPromptText.includes('[渠道：QQ]'), false)
    checkThat('9. 但群聊说明仍然每条都带', secondPromptText.includes('[群聊]'))
    const afterFollowUp = prompted.length

    // 把窗口关掉：同样的"接着说话"不该再触发。
    runtime.applySettings({ groupFollowUpWindowMs: 0 })
    await emitGroup(bot, { groupId: 'GROUP-F', content: '接着说', msgId: 'GF-3' })
    check('9. 窗口关掉后不 @ 不再提交', prompted.length, afterFollowUp)

    // 关掉强制只读锁之后，新的会话才按预设走。
    runtime.applySettings({ newSessionsReadOnly: false, permissionPreset: 'danger-full-access' })
    await emitGroup(bot, {
      groupId: 'GROUP-F',
      content: '鲸鱼娘再说一句',
      msgId: 'GF-4',
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    })
    check('9. 关掉强制只读后按预设施加完全访问', presetCalls.at(-1)?.name, 'danger-full-access')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
