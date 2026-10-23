/**
 * 第四步能力探针：**选型之前必须先跑它**。
 *
 * ## 为什么必须有这一步
 *
 * 本步骤的候选能力有一个共同特征：**类型定义与 USAGE.md 里几乎什么都没说**。
 * `recallMessage`、`sendWakeup`、`ark`、`embed`、`MESSAGE_REACTION_*` 在
 * `USAGE.md` / `README.md` 里**一次都没出现**（只有 `.d.ts` 里的一句 JSDoc）。
 * 而本插件已经有过两次"没实测就实现 → 静默失效"的事故（`docs/POSTMORTEM.md` 005/006），
 * 所以**宁可先花一轮把事实钉下来**。
 *
 * ## 本脚本只做一件事：把观测写清楚，不做任何假设
 *
 * 每一项都是"发出去 → 记录返回值/错误码 → 请用户在手机上确认看到什么"。
 * 它**不会**因为某项失败就中断，因为"哪一项会失败"本身就是产物。
 *
 * ## ⚠️ 为什么不能自动跑
 *
 * 需要真实凭据 + 一部装了 QQ 的手机 + 用户亲手点/看。
 * **代理/CI 里不要跑它。**
 *
 * ## 用法
 *
 *   node smoke/step4-probe.mjs
 *
 * 按屏幕提示在 QQ 里操作。日志写到 `smoke/step4-probe.log`，请把整份日志交回。
 *
 * ## 与 `smoke/step4-surface.mjs` 的分工
 *
 * - `step4-surface.mjs`：**离线**，只核对 SDK 的导出面与依赖是否装上。可以随时跑。
 * - 本脚本：**联网**，核对 QQ 服务端的真实行为。需要人。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MsgType, QQBot } from '@tencent-connect/qqbot-nodejs'

const here = dirname(fileURLToPath(import.meta.url))
const LOG = join(here, 'step4-probe.log')

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(stamped)
  appendFileSync(LOG, `${stamped}\n`, 'utf8')
}

/** 与 step3-probe.mjs 同一套凭据查找逻辑：两个位置都找，并把"找过哪里"写进错误。 */
function loadCredentials() {
  const candidates = [
    join(here, 'credentials.json'),
    join(here, '..', '..', 'smoke', 'credentials.json'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) {
    throw new Error(
      `找不到凭据文件。找过这些位置：\n${candidates.map((p) => `  ${p}`).join('\n')}\n` +
        '请先完成扫码绑定（smoke/bind.mjs），或手工放一份 credentials.json。',
    )
  }
  log(`凭据读自 ${found}`)
  const parsed = JSON.parse(readFileSync(found, 'utf8'))
  if (typeof parsed.appId !== 'string' || typeof parsed.appSecret !== 'string') {
    throw new Error(`${found} 里缺 appId 或 appSecret`)
  }
  return parsed
}

/**
 * 把一次调用结果压成一行可读的事实。
 *
 * **必须把 `ApiError` 的三个字段都记下来**（`USAGE.md:526-534`）：
 * `httpStatus` / `bizCode` / `bizMessage`。只记 `err.message` 会把
 * "权限不足"和"参数错"混成同一行字，那正是 005/006 那类事故的温床。
 */
async function attempt(label, fn) {
  try {
    const result = await fn()
    const id = result?.id ?? result?.message?.id ?? result?.upload?.file_uuid ?? '(无 id)'
    log(`  ✅ ${label} → id=${id} | ${JSON.stringify(result)?.slice(0, 300) ?? 'undefined'}`)
    return { ok: true, result }
  } catch (error) {
    const fields = {
      name: error?.name,
      message: error?.message,
      httpStatus: error?.httpStatus,
      bizCode: error?.bizCode,
      bizMessage: error?.bizMessage,
      path: error?.path,
    }
    log(`  ❌ ${label} → ${JSON.stringify(fields)}`)
    return { ok: false, error }
  }
}

const { appId, appSecret, userOpenid } = loadCredentials()
writeFileSync(LOG, '', 'utf8')
log(`探针启动 appId=${appId} openid=${userOpenid ?? '(未记录)'}`)

/*
 * ⚠️ handler 里抛错会被 SDK 接住打到 logger.error（USAGE.md:265），
 * 不传 logger 就落到默认空 logger —— 现象是"连上了但毫无反应"。
 * STEP3 已经为此浪费过一整轮（STEP3 文档顶部第 5 条）。
 */
const bot = new QQBot({
  appId,
  appSecret,
  logger: {
    info: (m) => log(`sdk info  ${m}`),
    warn: (m) => log(`sdk warn  ${m}`),
    error: (m) => log(`sdk error ${m}`),
  },
  // markdownSupport 刻意保持默认 false：本探针要单独验证"逐条显式 markdown"这条路，
  // 而不是把全局开关翻掉（那会一次性改变所有 sendText 的行为，见报告候选 1）。
})

/** 观测到的原始网关事件类型（反应事件的唯一观测途径）。 */
const seenRawEvents = new Set()
bot.on('rawEvent', (ctx) => {
  if (!seenRawEvents.has(ctx.eventType)) {
    seenRawEvents.add(ctx.eventType)
    log(`★ rawEvent 首次出现: ${ctx.eventType}  payload=${JSON.stringify(ctx.data)?.slice(0, 400)}`)
  }
})

const interactions = []
bot.on('interaction', (ctx, event) => {
  interactions.push(event)
  log(`★ interaction: id=${event.id} type=${event.type} data.type=${event.data?.type} resolved=${JSON.stringify(event.data?.resolved)}`)
})

/** 入站消息要留住的上下文：没有它们后面所有发送都无从谈起。 */
let userMsgId
let peerId
let ready = false
bot.on('ready', () => {
  ready = true
  log('★ ready')
})

/**
 * 一条入站消息就触发整轮探针。
 *
 * 之所以挂在消息上而不是自己定时触发：QQ 的被动回复窗口要求挂在一条
 * **5 分钟内**的入站消息上（`USAGE.md:462`），主动推送的规则又说不清——
 * 用第一条入站消息当锚点，所有被动路径都能测到。
 */
let ran = false
bot.on('message', async (ctx, message) => {
  if (message.replyTarget?.scope !== 'c2c') {
    log(`  忽略非 c2c 消息 kind=${message.kind}`)
    return
  }
  userMsgId = message.messageId
  peerId = message.replyTarget.targetId
  if (ran) return
  ran = true

  const target = message.replyTarget

  try {
    log(`\n===== P1 逐条显式 markdown（不翻全局开关） =====`)
    await attempt('sendMarkdown 标题+粗体+斜体', () =>
      bot.sendMarkdown(target, '# H1 标题\n## H2 标题\n**粗体** 与 *斜体* 与 ***粗斜体***'),
    )
    await attempt('sendMarkdown 下划线（STEP3 的结论复核）', () =>
      bot.sendMarkdown(
        target,
        '裸下划线：qq_session_control 与 dsh_qq\n反引号：`qq_session_control`\n反斜杠转义：qq\\_session\\_control',
      ),
    )
    await attempt('sendMarkdown 列表', () =>
      bot.sendMarkdown(target, '- 无序一\n- 无序二\n\n1. 有序一\n2. 有序二\n\n> 引用块\n\n---\n\n[链接](https://q.qq.com/)'),
    )
    await attempt('sendMarkdown 代码', () =>
      bot.sendMarkdown(target, '行内 `code` 之后：\n\n```js\nconst a = 1\nconsole.log(a)\n```'),
    )
    await attempt('sendMarkdown 表格', () =>
      bot.sendMarkdown(target, '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |'),
    )
    // QQ 专属 markdown 图片语法（src/protocol/utils/image-size.ts:218-231）
    await attempt('sendMarkdown QQ 尺寸图片语法 ![#Wpx #Hpx](url)', () =>
      bot.sendMarkdown(
        target,
        '![#120px #120px](https://q.qq.com/favicon.ico)',
      ),
    )

    log(`\n===== P2 全局 markdownSupport=true 的副作用（关掉进程后单独跑） =====`)
    log('  这一项**不能在本进程里改**：markdownSupport 是构造期选项。')
    log('  请用 QQBOT_MARKDOWN=1 或另写一个 QQBot 实例单独验证，要回答三个问题：')
    log('    a) 普通 sendText（含下划线/星号/方括号）是否仍原样显示')
    log('    b) 是否报 40034090（USAGE.md:197-198 提到的权限错误码）')
    log('    c) 主动推送（无 msgId）是否也变成 markdown（src/protocol/api/messages.ts:340-342）')

    log(`\n===== P3 撤回 recallMessage =====`)
    const sent = await attempt('先发一条用于撤回的消息', () => bot.sendText(target, '这条应该会被撤回'))
    if (sent.ok && sent.result?.id) {
      await attempt('立即撤回（0 秒）', () => bot.recallMessage(target, sent.result.id))
      const s2 = await attempt('再发一条，留 60 秒后再撤', () => bot.sendText(target, '这条会等 60 秒再撤回'))
      if (s2.ok && s2.result?.id) {
        log('  等待 60 秒…')
        await new Promise((r) => setTimeout(r, 60_000))
        await attempt('60 秒后撤回', () => bot.recallMessage(target, s2.result.id))
      }
      // 撤回一条「别人发的」消息：看错误码，用来区分"只能撤自己的"
      await attempt('撤回用户刚发的那条（预期失败，记录错误码）', () =>
        bot.recallMessage(target, userMsgId),
      )
      // 撤回一条不存在的 id
      await attempt('撤回一个假 id（记录错误码）', () =>
        bot.recallMessage(target, 'probe-nonexistent-id'),
      )
    }

    log(`\n===== P4 同一 msgId 的被动回复配额（reply-limiter 说 4 次/小时） =====`)
    log('  连发 6 条被动回复，观察第几条开始报错 —— 用来验证 src/protocol/utils/reply-limiter.ts:5,42-43')
    log('  的「4 per hour」到底是不是平台真规则（这决定"撤回+重发"能不能做实时状态）。')
    for (let i = 1; i <= 6; i++) {
      await attempt(`被动回复第 ${i} 条`, () => bot.sendText(target, `配额探测 ${i}/6`))
    }

    log(`\n===== P5 输入中提示（C2C only，插件已在用） =====`)
    await attempt('sendTyping 30 秒', () => bot.sendTyping(target, 30))

    log(`\n===== P6 ARK / EMBED（USAGE.md 与 README 里完全没有） =====`)
    // 形状来自 src/QQBot.ts:85 / :87。template_id 需要平台侧申请，这里用 0 探错误码。
    await attempt('send msgType=ARK + ark.template_id=0', () =>
      bot.send({ target, msgType: MsgType.ARK, ark: { template_id: 0, kv: [] } }),
    )
    await attempt('send msgType=EMBED + 空 embed', () =>
      bot.send({ target, msgType: MsgType.EMBED, embed: {} }),
    )
    log('  → 看错误码：如果是"模板不存在/未申请"说明只是缺模板；')
    log('    如果是"不支持的消息类型"则说明 C2C 根本不接受 3/4。这两者含义完全不同。')

    log(`\n===== P7 ARK/EMBED 的自动 msg_type 推断（不显式传 msgType） =====`)
    await attempt('只传 ark 字段（应被推断为 msg_type=3）', () =>
      bot.send({ target, ark: { template_id: 0, kv: [] } }),
    )
    await attempt('只传 embed 字段（应被推断为 msg_type=4）', () =>
      bot.send({ target, embed: {} }),
    )

    log(`\n===== P8 语音 sendVoice（依赖 silk-wasm / ffmpeg，当前均未安装） =====`)
    log('  先跑 smoke/step4-surface.mjs 确认依赖；装了 silk-wasm 再来测这一项。')
    log('  要回答：.wav 直传是否显示为语音气泡？时长上限是多少？')
    if (process.env.PROBE_VOICE_PATH) {
      await attempt(`sendVoice ${process.env.PROBE_VOICE_PATH}`, () =>
        bot.sendVoice(target, { localPath: process.env.PROBE_VOICE_PATH }),
      )
    } else {
      log('  已跳过（设 PROBE_VOICE_PATH=<绝对路径> 可启用）')
    }

    log(`\n===== P9 大文件分块上传 + 日额度错误 =====`)
    if (process.env.PROBE_BIG_FILE) {
      await attempt(`sendFile ${process.env.PROBE_BIG_FILE}（应自动走分块）`, () =>
        bot.sendFile(target, { localPath: process.env.PROBE_BIG_FILE }, { fileName: 'probe-big.bin' }),
      )
      log('  → 若抛 UploadDailyLimitExceededError，它的 bizCode 应为 40093002')
      log('    （src/protocol/api/retry.ts:157 UPLOAD_PREPARE_FALLBACK_CODE）')
    } else {
      log('  已跳过（设 PROBE_BIG_FILE=<绝对路径，建议 ≥6MiB> 可启用）')
    }

    log(`\n===== P10 is_wakeup / sendWakeup =====`)
    await attempt('sendWakeup（is_wakeup: true 的主动消息）', () =>
      bot.sendWakeup({ scope: 'c2c', targetId: peerId }, '唤醒探测：这条是 is_wakeup'),
    )
    log('  → 要回答：它算不算一条普通消息？和普通主动消息走的是同一套规则吗？')
    log('    更要紧的是：它**是不是"召回"而不是"撤回"** —— JSDoc 里的 recall 一词有歧义，')
    log('    与 recallMessage（撤回）只差一个字符，极容易搞混。请对照手机上看到的效果判断。')

    log(`\n===== 人工观察项（脚本测不到，请回报） =====`)
    log('  1. 【反应事件】请对我方任意一条消息**加一个表情回应**，')
    log('     然后看我方是否出现 rawEvent: MESSAGE_REACTION_ADD。')
    log('     本插件只做私聊 —— 如果私聊里这个事件永远不来，该能力对本插件即为不可用。')
    log('  2. 【撤回】哪几条真的在手机上消失了？60 秒后那条呢？')
    log('  3. 【markdown】上面 P1 的六条各自渲染成了什么？表格有没有变成一行竖线？')
    log('  4. 【按钮】这一步不测按钮（STEP3 已定案：指令按钮 action.type=2）。')

    log(`\n===== 本轮出现过的 rawEvent 类型汇总 =====`)
    log(`  ${[...seenRawEvents].join(', ') || '(一条都没有)'}`)
    log(`  interaction 事件数：${interactions.length}`)
    log('\n探针跑完。请把 smoke/step4-probe.log 整份交回。')
  } catch (error) {
    // 这个 catch 不是防御性编程：未接住的 rejection 在宿主里是致命错误，
    // 而且会让"探针自己炸了"看起来像"平台没反应"。
    log(`探针本体抛错：${error?.stack ?? String(error)}`)
  }
})

log('正在连接…（连上后在 QQ 里给机器人发任意一句话即开始）')
await bot.start()
if (!ready) log('⚠️ 从未收到 ready —— 检查 appId/appSecret 与网络')
