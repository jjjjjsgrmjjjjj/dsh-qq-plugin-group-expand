/**
 * 诊断日志。
 *
 * 为什么单独一个模块：宿主自己的控制台在桌面端**看不见**，桌面壳把启动失败显示在一个从不写盘的
 * 对话框里。所以插件必须自己落盘，否则 apply 阶段出问题时没有任何可查的痕迹。
 *
 * 三段式（`entered` / `mounted` / `FAILED`）沿用微信插件的约定，出了问题一眼能看出卡在哪一步。
 *
 * @module dsh-qq/log
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 超过这个大小就把当前日志改名留档、重新开一个。 */
const MAX_LOG_BYTES = 512 * 1024

let logFile

/**
 * 设定日志文件位置。`apply` 一进来就调用，之后所有日志都写这里。
 *
 * @param home - DSH 主目录。
 */
export function configureLog(home) {
  logFile = join(home, 'qq', 'boot.log')
  /*
   * ★ 这一行必须吞掉异常，因为它在 `apply` 的**最前面、而且在它的 try 之外**
   * （`index.js`：`configureLog(home)` 在第 55 行，`try {` 在第 58 行）。
   *
   * 抛出去的后果是**插件完全起不来，而且没有任何地方能记下这次失败**——日志文件正是这一行要建的，
   * 桌面壳那个失败对话框又从不写盘。审计的对照实验（同一台机器，两个场景）实测：
   *
   *   建不出**日志**目录（在 try 之外）→ apply 抛 ENOTDIR，插件自己往 console 打了 **0 行**，
   *                                       boot.log **不存在** ← 连痕迹都没有
   *   建不出**工作**目录（在 try 之内）→ 有 `apply: FAILED: …` 与 `apply: stack: …` 共 3 行
   *
   * 所以这里吞掉，并且**保留 `logFile` 赋值**：`appendFileSync` 自己会失败、`bootLog` 会退回
   * console。`bootLog` 本来就有 try/catch，且**无论写不写盘都 `console.log` 一份**——
   * 于是同一个故障从"零输出"变成"至少一行看得见的输出"。
   *
   * ⚠️ 可达性（如实说明，不夸大）：这需要 `$DSH_HOME` 本身不可创建，而那种情况下
   * DSH 自己大概也起不来。所以这一条的价值是**防御纵深 + 让失败可见**，
   * 不是"新用户一定会撞上的首次运行缺陷"。
   */
  try {
    mkdirSync(dirname(logFile), { recursive: true })
  } catch {
    // 见上：诊断手段不能变成故障源，更不能让插件因为"日志目录建不出来"而起不来。
  }
}

/** 日志文件路径，供设置页读取。 */
export function logPath() {
  return logFile
}

/**
 * 写一行日志。**绝不抛错**——诊断手段不能变成故障源。
 *
 * @param message - 内容。
 */
export function bootLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    if (logFile === undefined) {
      console.log(`[dsh-qq-plugin-group-expand] ${line.trimEnd()}`)
      return
    }
    rotateIfNeeded()
    appendFileSync(logFile, line)
  } catch {
    // 日志失败不能影响任何业务路径。
  }
  console.log(`[dsh-qq-plugin-group-expand] ${line.trimEnd()}`)
}

function rotateIfNeeded() {
  try {
    if (statSync(logFile).size <= MAX_LOG_BYTES) return
  } catch {
    return // 文件还不存在，无需轮转。
  }
  try {
    renameSync(logFile, `${logFile}.1`)
  } catch {
    // 轮转失败也不影响继续追加。
  }
}

/**
 * 把任意抛出物转成一行可读文本。
 *
 * @param error - 抛出物。
 */
export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 只在第一次见到某个桶时记录，避免长回合把日志刷爆。
 *
 * 微信插件用它来"从观测中学习宿主字段名"（而不是猜第二遍），这里沿用同样的思路：
 * 宿主帧结构是宿主拥有的，未知形态应当被记录一次，而不是靠再猜一个字段名。
 *
 * @param seen - 调用方持有的 Set。
 * @param bucket - 桶名。
 * @param line - 内容。
 * @returns 本次是否真的记录了。
 */
export function recordOnce(seen, bucket, line) {
  if (seen.has(bucket)) return false
  seen.add(bucket)
  bootLog(`${bucket} ${line}`)
  return true
}
