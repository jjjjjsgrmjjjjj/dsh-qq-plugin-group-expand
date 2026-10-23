/**
 * 入站媒体：把用户发来的图片/文件/语音**落到本地**，再把路径交给 agent。
 *
 * 移植自 `dsh-wechat/packages/bundle/src/host.ts` 的 `describeMedia` + `#mediaDir`。
 *
 * ## 为什么必须落盘，而不是把 URL 写进提示词
 *
 * 微信那份的注释点明了取舍：附件的原生形态（把图片作为模型输入）**要求视觉模型**，
 * 没有它整条提示词会被拒；而"名称 + 链接"对每种模型、每种文件都成立。
 *
 * QQ 还多一层：附件 URL 是**会过期的 CDN 链接**，agent 拿到之后再去取多半已经失效。
 * 所以**在收到消息的那一刻就下载**，提示词里给的是本地路径。
 *
 * ## 相对微信的两处简化（都是 QQ 协议白送的）
 *
 * | 微信 | QQ |
 * |---|---|
 * | 语音要 SILK 解码转 WAV，失败时得在提示词里说明"仍是原始 SILK" | 服务端直接给 `voice_wav_url`，**不需要解码**，也不需要那句免责 |
 * | 转写要另外请求 | `asr_refer_text` 随消息一起来 |
 *
 * @module dsh-qq/media
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootLog, describeError } from './log.js'

/** 媒体落盘子目录名（与微信同名的中文目录，便于用户认）。 */
export const MEDIA_DIR_NAME = '媒体'

/** 单次下载上限：QQ 的 `MAX_UPLOAD_SIZE` 是 20 MiB，这里留一倍余量。 */
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024

/**
 * 下载重试次数与间隔。移植自微信的 `DOWNLOAD_MAX_RETRIES` / `DOWNLOAD_RETRY_DELAY_MS`。
 *
 * **为什么值得重试**：这是用户刚刚发来的那张图，而 QQ 的附件在 CDN 上，
 * 瞬时失败（连接被重置、5xx）很常见。一次失败就放弃，用户看到的是
 * "agent 说它看不到图片"——而实际上再试一次就好了。
 *
 * 4 次是微信的取值：足够跨过瞬时抖动，又不至于让一条消息的处理拖太久。
 */
const DOWNLOAD_MAX_ATTEMPTS = 4
const DOWNLOAD_RETRY_DELAY_MS = 600

/**
 * 媒体目录，不存在就建。
 *
 * **按需创建**而不是插件启动时创建：一条超长回复或一个附件可能是本插件
 * 第一次写盘，目录缺失会表现为"回复被静默截断"而不是"发了个文件"（微信的原话）。
 *
 * ⚠️ 参数是**工作区路径本身**，不是"主目录 + 目录名"。
 * 会话文件夹现在可由用户自定义（见 `settings.workspacePath`），所以媒体目录必须
 * 跟着那个路径走——早先按 `home + 常量目录名` 拼的写法在自定义之后会把媒体落到别处。
 *
 * ## ★ 这里的契约是"永不抛"，而且必须有保护
 *
 * 保护不是可选的：这个函数是 `#park` 的**第一步**，抛出去会被 `#handleInbound` 的 catch 接住，
 * 于是**用户的图连同那条说明文字一起消失**——QQ 里一个字都没有。审计实测（媒体目录被一个
 * 同名普通文件占住）：假 SDK 收到 **0 条出站**，错误环 2 条，`sessionController` 被调用 0 次。
 *
 * 这与本模块自己写下的约定矛盾，而约定就在下面 {@link downloadAttachment} 的注释里：
 * "一个下不动的附件不该让整条消息消失"。`downloadAttachment` 有保护，这里从前没有。
 *
 * 建不出来也不代表这条消息该消失：下载那一步会自己失败（它自己有保护）并退化成
 * {@link describeMissing}，用户至少还能看到"未能下载到本地"。
 *
 * @param workspacePath - 会话工作区的绝对路径。
 * @returns 媒体目录路径；建不出来时**照样返回那个路径**，由下载那一步去失败。
 */
export function mediaDir(workspacePath) {
  const dir = join(workspacePath, MEDIA_DIR_NAME)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    // 留痕（`bootLog` 自己绝不抛）：否则用户只会看到"图没反应"，而日志里什么都没有。
    bootLog(`媒体目录建不出来（${dir}）：${describeError(error)}——附件会退化成"未能下载到本地"`)
  }
  return dir
}

/**
 * 一条附件属于哪一类。
 *
 * QQ 的 `content_type` 形如 `image/png`、`video/mp4`、`voice`、`file`，
 * 但**可能是空的**，所以退化到用文件名后缀判断。
 */
export function attachmentKind(attachment) {
  const contentType = String(attachment?.content_type ?? '').toLowerCase()
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/') || contentType === 'voice') return 'voice'
  const name = String(attachment?.filename ?? '').toLowerCase()
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(name)) return 'image'
  if (/\.(mp4|mov|m4v|avi|mkv|webm)$/.test(name)) return 'video'
  if (/\.(wav|mp3|silk|amr|ogg|m4a)$/.test(name)) return 'voice'
  return 'file'
}

/**
 * 该下载哪个 URL。
 *
 * 语音优先取 `voice_wav_url`（服务端转好的 WAV）——那才是 agent 能直接打开的东西。
 */
export function downloadUrlFor(attachment) {
  const voice = attachment?.voice_wav_url
  if (typeof voice === 'string' && voice !== '') return voice
  const url = attachment?.url
  return typeof url === 'string' && url !== '' ? url : undefined
}

/** 扩展名 guess：优先用附件自带的文件名，其次用 content_type，最后按类别给个兜底。 */
function extensionFor(attachment, kind) {
  const name = String(attachment?.filename ?? '')
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot).toLowerCase()
  const contentType = String(attachment?.content_type ?? '').toLowerCase()
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
  }
  if (map[contentType] !== undefined) return map[contentType]
  if (contentType.startsWith('image/')) return `.${contentType.slice(6)}`
  if (contentType.startsWith('video/')) return `.${contentType.slice(6)}`
  return { image: '.png', video: '.mp4', voice: '.wav', file: '.bin' }[kind] ?? '.bin'
}

/** 文件名里不能出现的字符，换成下划线。 */
function safeStem(text) {
  return String(text ?? '').replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, '_').slice(0, 40)
}

/**
 * 下载一个附件到媒体目录。
 *
 * 失败**不抛**：一个下不动的附件不该让整条消息消失，所以返回 `undefined`，
 * 由调用方退化成"只在提示词里说明有这个附件"。
 *
 * @param options.attachment - QQ 的入站附件。
 * @param options.dir - 媒体目录。
 * @param options.index - 同一条消息里的序号（避免同名覆盖）。
 * @param options.maxBytes - 本次下载的体积上限；省略时用 {@link MAX_DOWNLOAD_BYTES}。
 *   收藏表情包用更小的上限（照片不该被当成表情包下载）。
 * @returns `{ path, bytes, kind, transcript }` 或 `undefined`。
 */
export async function downloadAttachment({ attachment, dir, index, maxBytes }) {
  const url = downloadUrlFor(attachment)
  const kind = attachmentKind(attachment)
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_DOWNLOAD_BYTES
  if (url === undefined) {
    bootLog(`附件没有可下载的 URL（kind=${kind}），跳过下载`)
    return undefined
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const stem = safeStem(attachment?.filename?.replace(/\.[^.]+$/, '') ?? `附件${String(index + 1)}`)
  const path = join(dir, `${stamp}-${String(index)}-${stem}${extensionFor(attachment, kind)}`)

  try {
    /*
     * 重试循环。
     *
     * ⚠️ **只重试"可能是瞬时"的失败**：
     * - 网络异常（fetch 抛出）→ 重试
     * - 5xx / 429 → 重试（服务端一时的问题）
     * - 4xx（403 链接过期、404 不存在）→ **不重试**：再试 4 次也是同样的结果，
     *   只会让这条消息的处理白等 2.4 秒。
     * - 声明体积超限 → 不重试
     */
    let lastReason
    for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) {
          const transient = response.status >= 500 || response.status === 429
          lastReason = `HTTP ${String(response.status)}`
          if (!transient) break
        } else {
          const declared = Number(response.headers.get('content-length') ?? '0')
          if (Number.isFinite(declared) && declared > limit) {
            bootLog(`附件超过 ${String(limit)} 字节上限，跳过下载`)
            return undefined
          }
          const data = Buffer.from(await response.arrayBuffer())
          if (data.byteLength > limit) {
            bootLog('附件实际大小超过上限，丢弃')
            return undefined
          }
          writeFileSync(path, data)
          const transcript =
            typeof attachment?.asr_refer_text === 'string' ? attachment.asr_refer_text.trim() : ''
          if (attempt > 1) bootLog(`附件下载在第 ${String(attempt)} 次尝试成功`)
          return {
            path,
            bytes: data.byteLength,
            kind,
            transcript: transcript === '' ? undefined : transcript,
          }
        }
      } catch (error) {
        lastReason = describeError(error)
      }
      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS))
      }
    }
    bootLog(`附件下载失败（已试 ${String(DOWNLOAD_MAX_ATTEMPTS)} 次，kind=${kind}）：${String(lastReason)}`)
    return undefined
  } catch (error) {
    bootLog(`附件下载异常（kind=${kind}）: ${describeError(error)}`)
    return undefined
  }
}

/**
 * 为 agent 描述一条已落盘的附件。
 *
 * 语音多给两样东西，它们决定 agent **是否需要打开这个文件**：
 * 服务端转写（有转写就能直接回答问题，根本不用碰音频）与时长。
 *
 * @param entry - {@link downloadAttachment} 的返回值。
 */
export function describeMedia(entry) {
  const size = entry.bytes
  const readable = size < 1024 ? `${String(size)} B` : `${(size / 1024).toFixed(1)} KB`
  const kind = { image: '图片', file: '文件', voice: '语音', video: '视频' }[entry.kind] ?? '文件'
  const parts = [`[${kind}] ${entry.path} (${readable})`]
  if (entry.transcript !== undefined && entry.transcript !== '') {
    parts.push(`服务端转写：${entry.transcript}`)
  }
  return parts.join('\n')
}

/**
 * 下载不到的附件，退化成一行说明。
 *
 * **必须留下痕迹**：用户在手机上看着自己刚发的图，而 agent 完全不知道它存在，
 * 这种沉默比"我看不到这张图"更糟。
 */
export function describeMissing(attachment, index) {
  const label = attachment?.filename ?? attachment?.content_type ?? `附件${String(index + 1)}`
  return `[附件 ${label}]（未能下载到本地，agent 无法读取）`
}
