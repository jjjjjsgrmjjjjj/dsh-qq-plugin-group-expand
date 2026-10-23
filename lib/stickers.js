/**
 * 表情包：**收藏群里的**，和**用户自己导进来的**。
 *
 * ## 为什么不自己生成
 *
 * 生成出来的图不是这个群的语言。一个群里流通的表情包带着这个群的梗、画风和熟人感，
 * 而程序画出来的鱼再可爱也只是插画。所以这个模块只做两件事：
 *
 * 1. **收藏**：群消息里像表情包的图片，下载下来、去重、编号，收进 `collected/`；
 * 2. **导入**：用户往表情包文件夹根目录里丢的图片，原样参与发送。
 *
 * 运行时从这两处一起随机挑图。目录结构：
 *
 * ```
 * ~/.dsh/qq/stickers/
 *   ├── 我自己导入的.png        ← 用户在设置页指定的文件夹（根目录）
 *   ├── collected/
 *   │   ├── sticker-<hash>.png  ← 群里收藏的
 *   │   └── index.json          ← 每张的来源（群、发送者、时间）
 *   └── ...
 * ```
 *
 * ## "像表情包"怎么判断
 *
 * QQ 的附件里没有"这是表情包"这个字段，只有 `image/png` 之类的 content type。
 * 所以只有靠图片本身的可观测量。判定刻意保守——**宁可少收一张，也不要把群友的自拍存下来**：
 *
 * | 条件 | 理由 |
 * |---|---|
 * | 图片格式 | 只收 png/jpg/gif/webp |
 * | 最长边 ≤ {@link MAX_STICKER_EDGE} | 表情包是小图；手机照片动辄 3000+ |
 * | 宽高比在 0.45–2.2 之间 | 表情包接近方形；风景照、截图、长图被排除 |
 * | 文件 ≤ {@link MAX_STICKER_BYTES} | 动图/贴纸通常很小；大图不是表情包 |
 * | 内容哈希去重 | 同一个表情包被转十次也只存一份 |
 *
 * 这套判据会漏掉一些表情包（比如长条形的），但**漏收**只是少一个素材，
 * **错收**是把群友的照片留在机器上，两者的代价不对称。
 *
 * ## 上限
 *
 * `collected/` 最多保留 {@link MAX_COLLECTED} 张，超出时按 `index.json` 的顺序删最旧的。
 * 表情包是消耗品，不是档案；没有上限的话这个目录会无限长下去。
 *
 * @module dsh-qq/stickers
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import { bootLog, describeError } from './log.js'
import { downloadAttachment } from './media.js'

/** 收藏目录名（在用户指定的表情包目录下面）。 */
export const COLLECTED_DIR_NAME = 'collected'

/** 收藏索引文件名。 */
export const COLLECTED_INDEX_NAME = 'index.json'

/** 认作图片的扩展名。 */
export const STICKER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** 单张表情包的体积上限（2 MiB）。 */
export const MAX_STICKER_BYTES = 2 * 1024 * 1024

/** 表情包最长边上限。再大就是照片/截图。 */
export const MAX_STICKER_EDGE = 1024

/** 表情包最短边下限（排除 1×1 的追踪像素之类）。 */
export const MIN_STICKER_EDGE = 32

/** 宽高比允许范围（宽/高）。 */
const MIN_RATIO = 0.45
const MAX_RATIO = 2.2

/** 收藏目录最多保留多少张。 */
export const MAX_COLLECTED = 300

/**
 * 从图片文件头读出宽高。
 *
 * 不引入图片库：插件只为了"判断这张图是不是方形小图"去装一个解码器不值得。
 * 四种格式的头部都是固定的，下面按格式读。
 *
 * @param buffer - 文件内容（至少前几十字节）。
 * @returns `{ width, height }`；认不出来时 `undefined`。
 */
export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return undefined

  // PNG：8 字节签名，IHDR 的宽高在偏移 16/20（大端）。
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  // GIF：前 6 字节 "GIF87a"/"GIF89a"，逻辑屏幕宽高在 6/8（小端）。
  const gifHeader = buffer.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }

  // WebP：RIFF....WEBP，然后看 VP8 / VP8L / VP8X。
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const kind = buffer.subarray(12, 16).toString('ascii')
    if (kind === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
      return { width, height }
    }
    if (kind === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (kind === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }

  // JPEG：扫描段，找 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15。
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }

  return undefined
}

/**
 * 这张图是不是"像表情包"。
 *
 * 判定表见文件头。宽高读不出来时**拒绝**：不知道尺寸就不该把一张来路不明的图
 * 收进会再次发出去的目录。
 *
 * @param params.buffer - 文件内容。
 * @param params.bytes - 文件大小。
 * @param params.extension - 扩展名（小写，含点）。
 * @returns 是否收藏。
 */
export function isStickerLike({ buffer, bytes, extension }) {
  if (!STICKER_EXTENSIONS.has(extension)) return false
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_STICKER_BYTES) return false
  const size = imageDimensions(buffer)
  if (size === undefined) return false
  const { width, height } = size
  if (width < MIN_STICKER_EDGE || height < MIN_STICKER_EDGE) return false
  if (Math.max(width, height) > MAX_STICKER_EDGE) return false
  const ratio = width / height
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO
}

/**
 * 表情包目录里所有可发送的图片：根目录（用户导入）+ `collected/`（群里收藏）。
 *
 * 只扫一层子目录，不递归：用户把文件夹整理成多层时，我们不应该去猜哪一层算表情包。
 *
 * @param dir - 表情包根目录。
 * @returns 图片绝对路径（已排序，便于测试）。
 */
export function stickerFiles(dir) {
  const files = []
  const pushFrom = (folder) => {
    try {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!STICKER_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        files.push(join(folder, entry.name))
      }
    } catch {
      // 目录不存在/不可读：这一处就是空，不必上报（发送时会退到 emoji）。
    }
  }
  pushFrom(dir)
  pushFrom(join(dir, COLLECTED_DIR_NAME))
  return files.sort()
}

/** 读收藏索引；坏文件当作空索引，**不影响收藏**。 */
function readIndex(collectedDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(collectedDir, COLLECTED_INDEX_NAME), 'utf8'))
    return Array.isArray(parsed?.files) ? parsed.files : []
  } catch {
    return []
  }
}

/** 写收藏索引；写不进去只记日志——索引是元数据，丢了不该让收藏失败。 */
function writeIndex(collectedDir, files) {
  try {
    writeFileSync(
      join(collectedDir, COLLECTED_INDEX_NAME),
      `${JSON.stringify({ version: 1, files }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    bootLog(`表情包索引写不进去: ${describeError(error)}`)
  }
}

/**
 * 收藏一张群里的图片。
 *
 * 流程：体积预判 → 下载到 `collected/` → 尺寸/比例判定 → 内容哈希去重 → 改名归档 → 更新索引。
 *
 * @param params.dir - 表情包根目录。
 * @param params.attachment - QQ 的入站附件。
 * @param params.index - 同一条消息里的序号。
 * @param params.source - 来源信息（群、发送者、消息 id），写进索引。
 * @returns `{ path, duplicate }`；不收时 `undefined`。
 */
export async function collectSticker({ dir, attachment, index, source }) {
  const collectedDir = join(dir, COLLECTED_DIR_NAME)
  try {
    mkdirSync(collectedDir, { recursive: true })
  } catch (error) {
    bootLog(`表情包收藏目录建不出来（${collectedDir}）：${describeError(error)}`)
    return undefined
  }

  // 下载前先看声明的体积：大图连下载都不必。
  const declared = Number(attachment?.size ?? 0)
  if (Number.isFinite(declared) && declared > MAX_STICKER_BYTES) return undefined

  const downloaded = await downloadAttachment({
    attachment,
    dir: collectedDir,
    index,
    maxBytes: MAX_STICKER_BYTES,
  })
  if (downloaded === undefined) return undefined

  let buffer
  try {
    buffer = readFileSync(downloaded.path)
  } catch (error) {
    bootLog(`表情包读取失败: ${describeError(error)}`)
    return undefined
  }
  const extension = extname(downloaded.path).toLowerCase()
  if (!isStickerLike({ buffer, bytes: buffer.byteLength, extension })) {
    // 不是表情包：删掉刚落下的临时文件。**不留在收藏目录里**——那会让下次扫描把它当素材。
    try {
      unlinkSync(downloaded.path)
    } catch {
      // 删不掉也不影响判定。
    }
    return undefined
  }

  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  const target = join(collectedDir, `sticker-${hash}${extension === '.jpeg' ? '.jpg' : extension}`)
  if (existsSync(target)) {
    try {
      unlinkSync(downloaded.path)
    } catch {
      // 同一个表情包再收一次：删掉重复下载的那份即可。
    }
    return { path: target, duplicate: true }
  }

  try {
    renameSync(downloaded.path, target)
  } catch (error) {
    bootLog(`表情包归档失败: ${describeError(error)}`)
    return undefined
  }

  const files = readIndex(collectedDir)
  files.push({
    file: target.slice(collectedDir.length + 1),
    at: new Date().toISOString(),
    ...source,
  })
  // 超出上限：删最旧的。**先删文件再写索引**，索引里就不会留下不存在的条目。
  while (files.length > MAX_COLLECTED) {
    const oldest = files.shift()
    if (typeof oldest?.file === 'string') {
      try {
        unlinkSync(join(collectedDir, oldest.file))
      } catch {
        // 文件已经不在：索引照样往前推。
      }
    }
  }
  writeIndex(collectedDir, files)

  let bytes = 0
  try {
    bytes = statSync(target).size
  } catch {
    bytes = buffer.byteLength
  }
  bootLog(
    `表情包已收藏 ${target.slice(target.indexOf(COLLECTED_DIR_NAME))}（${String(bytes)} 字节）` +
      ` source=${String(source?.groupId ?? '').slice(0, 8)}`,
  )
  return { path: target, duplicate: false }
}
