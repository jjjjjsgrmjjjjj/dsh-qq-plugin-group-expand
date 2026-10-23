/**
 * 二维码渲染。
 *
 * 移植自 `dsh-wechat/packages/core/src/render.ts` 的取舍：**懒加载** `qrcode`，
 * 拿不到时返回 `undefined` 而不是抛错——设置页少一张图，总好过整个区块崩掉。
 *
 * @module dsh-qq/render
 */

/**
 * 把一段文本渲染成 PNG data URL。
 *
 * @param text - 要编码的内容（QQ 这边是 `q.qq.com/qqbot/openclaw/connect.html?...` 那个链接）。
 * @returns `data:image/png;base64,...`，或 `qrcode` 不可用时的 `undefined`。
 */
export async function toDataUrl(text) {
  try {
    const mod = await import('qrcode')
    const QRCode = mod.default ?? mod
    // 宽度 480 与第一步烟测用的值一致：手机相机隔着显示器也扫得动。
    return await QRCode.toDataURL(text, { width: 480, margin: 2 })
  } catch {
    return undefined
  }
}
