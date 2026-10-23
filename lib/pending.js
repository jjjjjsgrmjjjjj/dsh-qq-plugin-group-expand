/**
 * 待发消息队列：没送达的消息**存起来**，等用户下次说话时补发。
 *
 * 移植自 `dsh-wechat/packages/bundle/src/host.ts` 的 `#sendOrQueue` / `#flushPending` /
 * `#expirePending` 与 `dsh-wechat/packages/core/src/state.ts` 的
 * `queuePendingNotification` / `expirePendingNotifications`。
 *
 * ## 为什么需要它
 *
 * iLink 有一条硬规则：**机器人不能主动发消息**，只能在用户消息之后的窗口内回复。
 * 微信插件于是把"发不出去的通知"排队，等用户下次开口时补发。
 *
 * QQ 的情况不同——第一步实测**主动推送可用**（368 ms），所以主路径不需要队列。
 * 但主动推送随时可能失败：网络、平台拒绝，或者平台的规则改了（官方文档对主动推送
 * 的说法互相矛盾，这里**不假设任何额度**）。那条路径上我的旧代码是
 * `#recordError` 之后**把消息丢掉**：用户等的那条"干完了告诉我"就此消失，
 * 而且他永远不会知道曾经有过这条消息。
 *
 * **发不出去和丢掉是两回事。** 排队让它至少有机会送达。
 *
 * ## 两条设计上的讲究（都来自微信的注释）
 *
 * 1. **补发要排在回答之前。** 用户自己的那条消息才是"重新打开窗口"的东西，
 *    所以积压的通知属于这条回答**之前**——否则用户等着的通知会出现在一条
 *    毫不相干的回复下面。
 * 2. **文件已经不存在时丢弃而不是重试。** 一直重试会把后面所有条目堵死，
 *    而它上面的文字部分早就发出去了，留着它只会在之后每条消息上重复一遍。
 *
 * @module dsh-qq/pending
 */

/** 队列上限（条）。超出时丢最旧的——微信的理由：新消息比旧消息更可能still有意义。 */
export const PENDING_QUEUE_LIMIT = 50

/** 条目最长存活时间：超过就不再补发。过期的东西发出去比不发更糟。 */
export const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * 入队一条待发消息。
 *
 * @param state - 可变的状态对象（原地修改）。
 * @param entry - `{ conversationId, text, path? }`。
 * @param now - 当前时间（测试可注入）。
 * @returns 因队列满而被丢弃的条数。
 */
export function queuePendingNotification(state, entry, now = Date.now()) {
  const queue = (state.pendingNotifications ??= [])
  queue.push({
    id: `p-${String(now)}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: entry.conversationId,
    text: typeof entry.text === 'string' ? entry.text : '',
    ...(typeof entry.path === 'string' && entry.path !== '' ? { path: entry.path } : {}),
    queuedAt: now,
  })
  let dropped = 0
  while (queue.length > PENDING_QUEUE_LIMIT) {
    queue.shift()
    dropped += 1
  }
  return dropped
}

/**
 * 丢弃过期的条目。
 *
 * @param state - 可变状态（原地修改）。
 * @param now - 当前时间。
 * @param maxAgeMs - 最长存活时间。
 * @returns 被丢弃的条目。
 */
export function expirePendingNotifications(state, now = Date.now(), maxAgeMs = PENDING_MAX_AGE_MS) {
  const queue = state.pendingNotifications
  if (!Array.isArray(queue)) return []
  const kept = queue.filter((entry) => now - entry.queuedAt <= maxAgeMs)
  const expired = queue.filter((entry) => now - entry.queuedAt > maxAgeMs)
  if (kept.length === 0) delete state.pendingNotifications
  else state.pendingNotifications = kept
  return expired
}

/**
 * 取某对话的待发条目，**并保持队列顺序**。
 *
 * 只读不改：真正的移除由调用方在发送成功/判定为不可发之后用 {@link dropPending} 做——
 * 读的时候就删，会让"发送途中失败"的条目凭空消失。
 *
 * @param state - 状态对象。
 * @param conversationId - 对话键。
 */
export function pendingFor(state, conversationId) {
  const queue = state.pendingNotifications
  if (!Array.isArray(queue)) return []
  return queue.filter((entry) => entry.conversationId === conversationId)
}

/**
 * 从队列里移除一条。
 *
 * @param state - 可变状态（原地修改）。
 * @param id - 条目 id。
 * @returns 是否移除了。
 */
export function dropPending(state, id) {
  const queue = state.pendingNotifications
  if (!Array.isArray(queue)) return false
  const next = queue.filter((entry) => entry.id !== id)
  if (next.length === queue.length) return false
  if (next.length === 0) delete state.pendingNotifications
  else state.pendingNotifications = next
  return true
}

/**
 * 状态归一化用：把任意输入过滤成合法的待发条目。
 *
 * @param raw - `JSON.parse` 出来的字段。
 * @returns 合法条目数组。
 */
export function normalizePending(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    if (typeof entry.conversationId !== 'string' || entry.conversationId === '') continue
    if (typeof entry.queuedAt !== 'number' || !Number.isFinite(entry.queuedAt)) continue
    out.push({
      id: entry.id,
      conversationId: entry.conversationId,
      text: typeof entry.text === 'string' ? entry.text : '',
      ...(typeof entry.path === 'string' && entry.path !== '' ? { path: entry.path } : {}),
      queuedAt: entry.queuedAt,
    })
  }
  return out
}
