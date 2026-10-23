/**
 * QQ 机器人扫码绑定。
 *
 * 走腾讯官方 `@tencent-connect/qqbot-connector`：本机申请绑定任务 → 得到
 * `q.qq.com/qqbot/openclaw/connect.html?task_id=…` → 手机 QQ 扫码 → 凭据（AppID +
 * AppSecret + 扫码人的 openid）经 AES-256-GCM 加密回传，本地解密。
 *
 * 与微信插件的 `login()` 是**同一种设计**（那边是 iLink 的
 * `get_bot_qrcode` / `get_qrcode_status`），区别只在凭据形态：
 * 微信扫码签发的是一次性 token，QQ 回传的是**长期 AppSecret**。
 *
 * ## 状态形状刻意对齐设置页客户端
 *
 * `phase` 与 `qrDataUrl` 这两个名字**照抄 `dsh-wechat-plugin` 的客户端契约**，
 * 这样设置页移植过去才能逐字一致（客户端认的是 `phase === 'running' && qrDataUrl`）。
 *
 * | 内部时机 | `phase` | 附带字段 |
 * |---|---|---|
 * | 未开始 / 已取消 | `idle` | — |
 * | 已申请任务、二维码就绪、换新码、保存中 | **`running`** | `step`、`qrUrl?`、`qrDataUrl?` |
 * | 凭据已保存 | `succeeded` | `accountId`、`userOpenid?` |
 * | 失败 | `failed` | `error` |
 *
 * ⚠️ **刻意不引入 `starting` / `saving` 这类"中间 phase"。**
 * 微信的设置页客户端只在 `phase === 'running'` 时轮询扫码状态；若 `POST /login/start`
 * 返回的是 `starting`，轮询就永不启动，二维码永远不出现——表现为「点了开始扫码什么都没发生」。
 * 中间态改用 `step` 表达（`requesting` / `waiting` / `refreshing` / `saving`），
 * 于是"是否还在进行"始终由 `phase === 'running'` 一个判据说得清。
 *
 * 客户端轮询 `snapshot()`，所以这里必须**只做状态、不发副作用**——
 * 凭据保存交给调用方（它才知道该写进哪）。
 *
 * @module dsh-qq/login
 */
import { startQrConnect } from '@tencent-connect/qqbot-connector'
import { bootLog, describeError } from './log.js'
import { toDataUrl } from './render.js'

export class QqBindSession {
  /** 当前状态，供客户端轮询。 */
  #state = { phase: 'idle' }
  /** `startQrConnect` 的停止函数。 */
  #stop
  /** 是否已被取消，避免取消后回调仍改状态。 */
  #cancelled = false
  /** 凭据保存回调。 */
  #onConfirmed

  /**
   * @param options.onConfirmed - `async (credentials) => Promise<void>`，保存凭据。
   *   抛错会被记为 `failed`，因为「扫码成功但存不下」必须让用户看见。
   */
  constructor(options = {}) {
    this.#onConfirmed = options.onConfirmed
  }

  /** 当前状态快照（含渲染好的二维码图）。 */
  snapshot() {
    return { ...this.#state }
  }

  /**
   * 开始一次扫码绑定。已在等待中时先取消上一次。
   *
   * @param options.source - 扫码页上显示的接入方标识。
   */
  async start(options = {}) {
    this.cancel()
    this.#cancelled = false
    this.#state = { phase: 'running', step: 'requesting' }
    const source = typeof options.source === 'string' && options.source !== '' ? options.source : 'dsh-qq-plugin-group-expand'

    try {
      this.#stop = startQrConnect(
        {
          onQrDisplayed: (url) => {
            if (this.#cancelled) return
            // 先把 URL 落进状态，图片是异步渲染的——客户端早一轮就能显示链接兜底。
            this.#state = { phase: 'running', step: 'waiting', qrUrl: url }
            void toDataUrl(url).then((dataUrl) => {
              if (this.#cancelled || this.#state.qrUrl !== url) return
              this.#state = { ...this.#state, qrDataUrl: dataUrl }
            })
          },
          onQrExpired: () => {
            if (this.#cancelled) return
            bootLog('扫码绑定：二维码过期，正在自动刷新')
            this.#state = { ...this.#state, phase: 'running', step: 'refreshing' }
          },
          onSuccess: (credentials) => {
            if (this.#cancelled) return
            const first = Array.isArray(credentials) ? credentials[0] : undefined
            if (first === undefined) {
              this.#state = { phase: 'failed', error: '扫码成功但没有返回凭据' }
              return
            }
            this.#state = { phase: 'running', step: 'saving' }
            void (async () => {
              try {
                await this.#onConfirmed?.({
                  appId: String(first.appId),
                  appSecret: String(first.appSecret),
                  userOpenid: typeof first.userOpenid === 'string' ? first.userOpenid : undefined,
                })
                if (this.#cancelled) return
                this.#state = { phase: 'succeeded', accountId: String(first.appId), userOpenid: first.userOpenid }
                bootLog(`扫码绑定成功 appId=${first.appId}`)
              } catch (error) {
                if (this.#cancelled) return
                this.#state = { phase: 'failed', error: `保存凭据失败：${describeError(error)}` }
                bootLog(`扫码绑定：保存凭据失败 ${describeError(error)}`)
              }
            })()
          },
          onFailure: (error) => {
            if (this.#cancelled) return
            this.#state = { phase: 'failed', error: describeError(error) }
            bootLog(`扫码绑定失败：${describeError(error)}`)
          },
        },
        { displayQrCodeToConsole: false, source },
      )
      bootLog('扫码绑定：已申请绑定任务')
    } catch (error) {
      this.#state = { phase: 'failed', error: describeError(error) }
      bootLog(`扫码绑定：申请任务失败 ${describeError(error)}`)
    }
    // 返回当前状态，调用方（`runtime.startBind`）与测试都直接用它。
    return this.snapshot()
  }

  /** 取消当前绑定流程。 */
  cancel() {
    this.#cancelled = true
    const stop = this.#stop
    this.#stop = undefined
    if (typeof stop === 'function') {
      try {
        stop()
      } catch (error) {
        bootLog(`扫码绑定：取消失败 ${describeError(error)}`)
      }
    }
    // 已完成或已失败的状态保留下来给用户看；只有"进行中"才回到 idle。
    if (this.#state.phase !== 'succeeded' && this.#state.phase !== 'failed') {
      this.#state = { phase: 'idle' }
    }
  }
}
