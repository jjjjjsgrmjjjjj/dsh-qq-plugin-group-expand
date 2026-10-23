/**
 * STEP4 能力选型：**离线**表面核对（不需要凭据、不联网）。
 *
 * 目的：把「类型定义/文档里写着」与「运行期真的能用」分开。
 * `POSTMORTEM.md` 006 的教训是"工具名在类型里没问题、实际全局唯一"——
 * 所以任何一条结论都不能只凭 .d.ts 的字面存在就下判断。
 *
 * 本脚本只做 local 事实核对：
 *   1. QQBot 原型上到底有哪些方法（候选能力是否真的可达）
 *   2. 根入口 `/` 与子入口 `/protocol` 各自导出了什么
 *      （导出面决定"实现代价"——没导出就得自己写）
 *   3. 语音链路的前置依赖是否真的装上了（silk-wasm / mpg123-decoder / ffmpeg）
 *      —— 这是候选 3 的**决定性事实**，用 `import()` 探测而不是读 package.json
 *   4. `MESSAGE_REACTION_*` 是否只有字符串常量、没有配套 intent 与 payload 类型
 *
 * 运行：node smoke/step4-surface.mjs
 */
import * as sdk from '@tencent-connect/qqbot-nodejs'
import * as protocol from '@tencent-connect/qqbot-nodejs/protocol'
import { execFileSync } from 'node:child_process'

const proto = sdk.QQBot.prototype
const has = (o, k) => typeof o?.[k] === 'function'

console.log('== 1. QQBot 原型方法（候选能力的可达性） ==')
for (const name of [
  'sendText',
  'sendMarkdown',
  'sendTextWithKeyboard',
  'send',
  'recallMessage',
  'sendWakeup',
  'sendTyping',
  'openStream',
  'send',
  'sendImage',
  'sendVoice',
  'sendVideo',
  'sendFile',
  'uploadMedia',
  'sendMedia',
  'acknowledgeInteraction',
]) {
  console.log(`  ${has(proto, name) ? '有' : '无'}  QQBot.${name}`)
}

console.log('\n== 2. 导出面 ==')
const rootKeys = Object.keys(sdk).sort()
const protoKeys = Object.keys(protocol).sort()
console.log(`  根入口导出数=${rootKeys.length}  子入口(/protocol)导出数=${protoKeys.length}`)
for (const name of [
  'MsgType',
  'MediaFileType',
  'LARGE_FILE_THRESHOLD',
  'MAX_UPLOAD_SIZE',
  'CHUNKED_UPLOAD_MAX_SIZE',
  'UploadDailyLimitExceededError',
]) {
  console.log(`  根入口有 ${name}: ${name in sdk}`)
}
// 语音转码与 markdown 图片语法只在 /protocol 里 —— 决定实现代价
for (const name of [
  'audioFileToSilkBase64',
  'shouldTranscodeVoice',
  'checkSilkWasmAvailable',
  'detectFfmpeg',
  'pcmToSilk',
  'formatQQBotMarkdownImage',
  'TEXT_CHUNK_LIMIT',
  'INTENTS',
]) {
  console.log(`  根入口=${name in sdk ? '有' : '无'}  /protocol=${name in protocol ? '有' : '无'}  ← ${name}`)
}

console.log('\n== 3. 语音链路的前置依赖（候选 3 的决定性事实） ==')
const tryImport = async (spec) => {
  try {
    await import(spec)
    return '可用'
  } catch {
    return '缺失'
  }
}
console.log(`  silk-wasm        ${await tryImport('silk-wasm')}   （SILK 编解码，peerDependency，optional）`)
console.log(`  mpg123-decoder   ${await tryImport('mpg123-decoder')}   （MP3→PCM WASM 兜底，peerDependency，optional）`)
let ffmpeg = '缺失'
for (const cmd of ['ffmpeg', 'ffmpeg.exe']) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore', timeout: 5000 })
    ffmpeg = `可用 (${cmd})`
    break
  } catch {
    /* 继续试下一个 */
  }
}
console.log(`  ffmpeg           ${ffmpeg}`)
console.log('  → 三者全缺时 audioFileToSilkBase64() 对非 wav/mp3/silk 输入会返回 null（静默失败）')

console.log('\n== 4. MESSAGE_REACTION_* 到底给到了什么 ==')
console.log(`  GatewayEvent 里有 MESSAGE_REACTION_ADD: ${sdk.GatewayEvent?.MESSAGE_REACTION_ADD ?? '(根入口没导出 GatewayEvent)'}`)
const intentNames = Object.keys(protocol).filter((k) => /INTENT/i.test(k))
console.log(`  /protocol 里名字含 INTENT 的导出: ${intentNames.join(', ') || '(无)'}`)
console.log('  → 只有 FULL_INTENTS 这一个聚合值；单个 intent 位（GUILDS/GROUP_AND_C2C/...）未导出，')
console.log('    也没有任何 REACTION 专属 intent —— 反应事件只能靠 rawEvent 兜底。')
const reactionTypeNames = Object.keys(protocol).filter((k) => /reaction/i.test(k))
console.log(`  /protocol 里名字含 reaction 的导出: ${reactionTypeNames.join(', ') || '(无 —— 没有配套 payload 类型)'}`)
