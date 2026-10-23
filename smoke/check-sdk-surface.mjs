/**
 * 检查探针用到的 SDK 成员是否真实存在。
 *
 * 目的：**别等探针跑起来才发现方法名写错了**。类型定义里读到的东西与实际导出的成员
 * 可能对不上（例如只在 `api` 子对象上、或名字稍有差异）。这个脚本只做存在性核对。
 */
import * as sdk from '@tencent-connect/qqbot-nodejs'

const proto = sdk.QQBot.prototype
const checks = [
  'sendTextWithKeyboard',
  'sendMarkdown',
  'send',
  'openStream',
  'on',
  'start',
  'recallMessage',
  'sendFile',
]
for (const name of checks) {
  console.log(`  ${typeof proto[name] === 'function' ? '✓' : '✗'} QQBot.${name}  ${typeof proto[name]}`)
}

const interesting = Object.getOwnPropertyNames(proto).filter((n) => /stream|keyboard|interact|recall/i.test(n))
console.log(`  含 stream/keyboard/interact/recall 的成员: ${interesting.length > 0 ? interesting.join(' ') : '(无)'}`)

console.log(`  InteractionType = ${JSON.stringify(sdk.InteractionType)}`)
console.log(`  StreamInputState = ${JSON.stringify(sdk.StreamInputState)}`)
console.log(`  StreamInputMode = ${JSON.stringify(sdk.StreamInputMode)}`)
console.log(`  StreamContentType = ${JSON.stringify(sdk.StreamContentType)}`)
console.log(`  MsgType = ${JSON.stringify(sdk.MsgType)}`)

// api 上是否真有 acknowledgeInteraction（回执必须走它）
const apiProto = Object.getPrototypeOf(sdk.QQBot.prototype)
console.log(`  QQBot.prototype 自身的成员数: ${Object.getOwnPropertyNames(proto).length}`)
console.log(`  api 是 getter 吗: ${JSON.stringify(Object.getOwnPropertyDescriptor(proto, 'api') ?? Object.getOwnPropertyDescriptor(apiProto, 'api') ?? null) !== 'undefined'}`)
