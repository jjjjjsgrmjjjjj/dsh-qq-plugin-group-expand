/**
 * 第三步能力探针：**实现之前必须先跑它**。
 *
 * ## 为什么必须有这一步
 *
 * 按钮与流式都有"类型里写着、但实际行为未知"的地方，而**猜错会让功能静默失效**——
 * 手机上不显示按钮、点击没有任何反应、消息卡在"生成中"。这类失败不会报错，
 * 只会在用户那里表现为"点了没用"。
 *
 * 这与第一步的 9/9 能力体检是同一套路：**先用一个只观测、不假设的脚本把事实钉下来**。
 *
 * ## 需要人工参与
 *
 * 有几项必须用手点按钮（点击回流、回执超时、观感），脚本只能把日志记下来。
 * 所以它的产物是「一次运行 + 一份日志」，由用户把日志交回。
 *
 * ## 用法
 *
 *   node smoke/step3-probe.mjs
 *
 * 然后按屏幕提示在 QQ 里操作。日志同时写到 `smoke/step3-probe.log`。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QQBot } from '@tencent-connect/qqbot-nodejs'

const here = dirname(fileURLToPath(import.meta.url))
const LOG = join(here, 'step3-probe.log')

/** 追加一行日志，同时打到控制台。 */
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(stamped)
  appendFileSync(LOG, `${stamped}\n`, 'utf8')
}

/**
 * 从第一步的烟测凭据里取 appId / appSecret。
 *
 * **按候选列表找，而不是写死一个路径**：第一步的凭据落在 `qq-plugin/smoke/`，
 * 而本探针在 `dsh-qq/smoke/`。写死任何一个都会在另一处运行时以
 * `ENOENT ... credentials.json` 收场——那是个与探针目的完全无关的失败，
 * 却要花时间去查。所以两个位置都找，并把"找过哪里"写进错误里。
 *
 * 仍然**不复制凭据文件**：凭据只该有一份，副本会带来"哪份才是最新的"这种问题。
 */
function loadCredentials() {
  const candidates = [
    join(here, 'credentials.json'), // dsh-qq/smoke/
    join(here, '..', '..', 'smoke', 'credentials.json'), // qq-plugin/smoke/（第一步的烟测目录）
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) {
    throw new Error(
      `找不到凭据文件。找过这些位置：\n${candidates.map((p) => `  ${p}`).join('\n')}\n` +
        '请先在第一步的烟测里完成扫码绑定（smoke/bind.mjs），或手工放一份 credentials.json。',
    )
  }
  log(`凭据读自 ${found}`)
  const parsed = JSON.parse(readFileSync(found, 'utf8'))
  if (typeof parsed.appId !== 'string' || typeof parsed.appSecret !== 'string') {
    throw new Error(`${found} 里缺 appId 或 appSecret`)
  }
  return parsed
}

const { appId, appSecret, userOpenid } = loadCredentials()
writeFileSync(LOG, '', 'utf8')
log(`探针启动 appId=${appId} openid=${userOpenid ?? '(未记录)'}`)

/** 收到过的交互事件（用于回执超时与重复点击的观测）。 */
const interactions = []

const bot = new QQBot({
  appId,
  appSecret,
  // 只关心私聊；交互事件单独在下面观察。
  intents: undefined,
})

// ---------------------------------------------------------------- 观测点

bot.on('message', async (first, second) => {
  /*
   * ⚠️ 这个 try/catch 不是防御性编程，是必需品。
   *
   * 第一版这里写了 `${arguments.length}`——而**箭头函数没有自己的 `arguments`**，
   * ESM 顶层也没有这个绑定。于是处理函数**第一行就 ReferenceError**，
   * 在任何日志写出之前就死了，SDK 又没接住它。
   * 现象是：探针连上了（`★ ready` 出现过），但发消息**毫无反应**，
   * 日志里一行都没有——看起来像"事件没到"，实际是"到了但处理函数当场炸了"。
   *
   * 一个自己会静默死掉的探针，比没有探针更糟：它会让人去查错的方向。
   */
  try {
    // 类型说签名是 `(ctx, msg)`。两种都打出来，让"哪个才是消息"成为日志里可见的事实。
    const message = second ?? first
    log(`入站回调 first=${describe(first)} second=${describe(second)}`)
    log(`入站 kind=${message?.kind} sender=${message?.senderId} content=${JSON.stringify(message?.content ?? '')}`)
    if (message?.kind !== 'c2c') {
      log(`（kind 不是 c2c，忽略）`)
      return
    }
    await runBattery(message)
  } catch (error) {
    log(`✗ 入站处理函数抛错：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  }
})

/** 把一个回调参数描述成"有哪些键"，而不是整份 JSON（可能很大）。 */
function describe(value) {
  if (value === undefined) return '(undefined)'
  if (value === null) return '(null)'
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`
  return `{${Object.keys(value).join(',')}}`
}

/*
 * 点击回流。**不假设 `data.type` 的值**——只记录它，并看 `button_data` 是否存在。
 * 这是刻意的：`InteractionType` 里只导出 CONFIG_QUERY/CONFIG_UPDATE 两个配置类交互
 * （而且从根模块导入时是 `undefined`），按钮点击的取值未确认，
 * 所以处理逻辑不能依赖它。
 */
bot.on('interaction', async (first, second) => {
  try {
    const at = Date.now()
    /*
     * 类型说签名是 `(ctx, event)`。这里**两种都试**并把结果写进日志：
     * 探针的职责是把事实查出来，而不是替事实做假设。
     */
    const event = second ?? first
    interactions.push({ at, event })
    log(`★ 交互事件 #${String(interactions.length)} first=${describe(first)}`)
    log(`★ 交互事件 #${String(interactions.length)} second=${describe(second)}`)
    log(`★ 完整事件=${JSON.stringify(event)}`)
    const data = event?.data?.resolved?.button_data
    const id = event?.id
    if (typeof data === 'string') log(`    button_data = ${data}`)
    if (typeof id === 'string') {
      try {
        // ⚠️ QQBot 上的回执**不收 creds**（`api` 上那个才收）。
        // 签名：acknowledgeInteraction(interactionId, code?, data?)
        await bot.acknowledgeInteraction(id, 0)
        log(`    ★ 已回执（收到后 ${String(Date.now() - at)} ms）`)
      } catch (error) {
        log(`    ✗ 回执失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      log('    ✗ 事件里没有 id，无法回执')
    }
  } catch (error) {
    log(`✗ 交互处理函数抛错：${error instanceof Error ? error.message : String(error)}`)
  }
})

/*
 * 把 SDK 自己的错误也记下来。
 *
 * 没有这一条，被吞掉的异常在日志里就是**一片空白**——而空白正是最难查的现象。
 */
bot.on('error', (error) => {
  log(`✗ SDK error 事件：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
})

// ---------------------------------------------------------------- 按键定义

/** QQ 文档：style 0 = 灰、1 = 蓝。这里两种都用上，好看清观感差异。 */
function button(label, data, style = 0) {
  return {
    id: `b-${data}`.slice(0, 60),
    render_data: { label, visited_label: `${label} ✓`, style },
    action: { type: 2, permission: { type: 0 }, data, click_limit: 5 },
  }
}

const keyboard = (rows) => ({ content: { rows: rows.map((buttons) => ({ buttons })) } })

// ---------------------------------------------------------------- 体检项

async function runBattery(message) {
  // 类型说入站消息上的回复目标是 `replyTarget`；探针顺带把它打出来，
  // 免得后面写实现时又要猜字段名。
  const target = message.replyTarget
  log(`replyTarget = ${JSON.stringify(target)}  （msgId=${String(target?.msgId ?? '(无)')} 表示在被动窗口内）`)
  log('--- 开始能力体检 ---')

  /*
   * ⚠️⚠️ 第一轮实测已经得出的结论，写在这里免得下次又踩：
   *
   * **键盘只在 msg_type=2（markdown）下渲染。**
   *
   * 第一轮里 ①③④ 全走 `sendTextWithKeyboard`、只有 ② 走 `sendMarkdown`，
   * 结果是**只有 ② 的按钮能用**。原因不是三个不同的失败，而是一条：
   * `QQBotOptions.markdownSupport` 默认 `false` → `sendText` 发 msg_type=0
   * → 纯文本不渲染键盘。
   *
   * 所以下面**所有**键盘测试一律走 `sendMarkdown`，否则 ③④ 测的是
   * "纯文本不支持键盘"，而不是它们本该测的行列上限与长度上限。
   */
  const sendWithKeyboard = (text, kb) => bot.sendMarkdown(target, text, { keyboard: kb })

  // ① 对照组：纯文本 + 键盘。**保留它是为了把结论钉住**——
  //    它应当**没有**按钮，而②应当有。两条一起看，根因就没有第二种解释。
  try {
    const sent = await bot.sendTextWithKeyboard(
      target,
      '① 对照组：这一条是纯文本 + 键盘。**预期：没有按钮**（纯文本不渲染键盘）。',
      keyboard([[button('不该出现', 'plain:none', 0)]]),
    )
    log(`① 纯文本对照组已发出 id=${sent?.id ?? '(无)'}（若这条也有按钮，说明结论要改）`)
  } catch (error) {
    log(`① 纯文本对照组失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ② markdown + 键盘：上一轮唯一生效的那条，现在是基线
  try {
    const sent = await sendWithKeyboard('② **markdown** + 键盘（基线）。这一条应当有按钮。', keyboard([[button('灰色', 'md:grey', 0), button('蓝色', 'md:blue', 1)]]))
    log(`② markdown 基线已发出 id=${sent?.id ?? '(无)'}`)
  } catch (error) {
    log(`② markdown 基线失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ③ markdown 下的 5×5 矩阵：这次才真正测到行列上限
  try {
    const rows = []
    for (let r = 0; r < 5; r += 1) {
      const row = []
      for (let c = 0; c < 5; c += 1) row.push(button(`${String(r + 1)}-${String(c + 1)}`, `grid:${String(r)}:${String(c)}`, 0))
      rows.push(row)
    }
    const sent = await sendWithKeyboard('③ 5×5 按钮矩阵（markdown）。**看是否完整、有没有被截断。**', keyboard(rows))
    log(`③ 5×5（markdown）已发出 id=${sent?.id ?? '(无)'}`)
  } catch (error) {
    log(`③ 5×5（markdown）失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ④ 超长 label 与超长 data（markdown）
  try {
    const longLabel = '这是一个非常长的按钮标签用来试探长度上限究竟在哪里'
    const longData = `long:${'x'.repeat(300)}`
    const sent = await sendWithKeyboard('④ 超长标签 + 超长 data（markdown）。', keyboard([[button(longLabel, longData, 0)]]))
    log(`④ 超长（markdown）已发出 id=${sent?.id ?? '(无)'}`)
  } catch (error) {
    log(`④ 超长（markdown）失败：${error instanceof Error ? error.message : String(error)}`)
  }

  /*
   * ⑤ markdown 转义 —— 这一项纯粹是因为"必须走 markdown"才出现的风险。
   *
   * 我们的消息里**天然含下划线**（工具名 `qq_session_control`、目录名 `dsh_qq`、
   * 字段名 `pendingInteractions`）。在 markdown 里 `_` 是斜体标记，于是
   * `qq_session_control` 很可能渲染成 qq<em>session</em>control——**看起来像工具名坏了**。
   *
   * 所以这条要测：反引号（代码块）能否护住下划线；以及裸下划线是否真的被吃掉。
   */
  try {
    await sendWithKeyboard(
      [
        '⑤ markdown 转义测试（这决定按钮消息里的工具名怎么写）：',
        '',
        '裸下划线：qq_session_control 与 dsh_qq',
        '反引号包住：`qq_session_control` 与 `dsh_qq`',
        '反斜杠转义：qq\\_session\\_control',
      ].join('\n'),
      keyboard([[button('转义测试', 'escape:one', 0)]]),
    )
    log('⑤ markdown 转义测试已发出')
  } catch (error) {
    log(`⑤ markdown 转义测试失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ⑥ openStream：被动窗口内开流，update 三次再 complete
  try {
    const session = bot.openStream({ target, throttleMs: 300 })
    log('⑥ openStream 已开启（throttleMs=300）')
    for (const part of ['正在', '正在生成', '正在生成中…']) {
      await session.update(part)
      log(`   update(${JSON.stringify(part)}) 已调用`)
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    await session.complete()
    log('⑥ complete() 已调用')
  } catch (error) {
    log(`⑥ openStream 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ⑦ 流式结束后补发文件（验证 maxReplyChars 降级在流式之后是否仍可行）
  try {
    await bot.sendFile(target, { localPath: join(here, 'step3-probe.log') }, { fileName: 'probe-log.txt' })
    log('⑦ 流式后补发文件成功')
  } catch (error) {
    log(`⑦ 流式后补发文件失败：${error instanceof Error ? error.message : String(error)}`)
  }

  log('--- 体检项已全部发出 ---')
  log('')
  log('请在手机上确认并操作，然后把这份日志交回：')
  log('  A. ① 有没有按钮？（预期：没有——它是纯文本对照组）')
  log('  B. ② 有没有按钮？灰色与蓝色能分辨吗？')
  log('  C. ③ 的 5×5 是否完整？实际几行几列？')
  log('  D. ④ 的按钮标签显示成什么样？（被截断了吗）')
  log('  E. ⑤ 三种写法的下划线**各显示成什么**？（这决定按钮消息里工具名怎么写）')
  log('  F. ⑥ 的消息是逐字更新出现的，还是只出现最后一条？')
  log('  G. 逐个点按钮（尤其 ②③④⑤ 的），看上面的日志里出现了哪些 button_data、回执是否成功。')
  log('  H. 同一个按钮连点两次，第二次还有反应吗？')
}

// ---------------------------------------------------------------- 启动

/*
 * ⚠️ **`start()` 是长驻的，不会 resolve——绝对不能 `await` 它。**
 *
 * 第一次写这份探针时我写了 `await bot.start()`，于是它永远停在「正在连接…」。
 * 证据其实一直在手边：插件自己的代码是
 *
 *     void bot.start().catch((error) => { … })
 *
 * 不 await、只接住 rejection——如果它会 resolve，当初就没必要那么写。
 */
bot.on('ready', () => {
  log('★ ready：已连上网关。现在请在 QQ 里给机器人发一条消息，体检项会自动发出。')
})

log('正在连接…')
void bot.start().catch((error) => {
  log(`✗ 连接失败：${error instanceof Error ? error.message : String(error)}`)
  log('  （若提示 token 或鉴权问题，多半是凭据过期；若是超时，检查网络与代理。）')
})
log('已发出连接请求（`start()` 长驻不 resolve，所以这里不 await 它）。')
log('（观察 3 分钟后按 Ctrl+C 结束；日志在 smoke/step3-probe.log）')
log('')
log('⚠️ 注意：本探针用的是**与插件相同的 appId**。同一个机器人的两条连接可能互相踢，')
log('   表现为「插件忽然不回消息了」或「探针收不到事件」。所以：')
log('   1. 先在 DSH 设置页把 QQ 通道**关掉**，再跑本探针；')
log('   2. 探针跑完后，把通道重新打开。')
log('   若两条连接能共存，那更好——但不要假定它成立。')
