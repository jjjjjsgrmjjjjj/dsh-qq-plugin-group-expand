/**
 * 两个"把东西发到 QQ"的工具。
 *
 * 移植自 `dsh-wechat/packages/bundle/src/host.ts`。
 *
 * ## 为什么是两个而不是一个
 *
 * `send_to_qq` 只能发给**调用它的那个 agent 所属会话所绑定的**对话。
 * 这意味着**真正干活的会话通常报不了自己的结果**：用户提了要求就走开了，
 * 而答案随回合一起死在那个会话里。
 *
 * `notify_qq` 因此改为从存储里解析**当前绑定的**对话，而不是从调用者解析——
 * 于是任何会话都能送到用户此刻手上的那台手机。它**不接受目标参数**，
 * 所以 agent 没有东西可以瞄错。
 *
 * @module dsh-qq/send-tools
 */

/** 按扩展名判定走哪条媒体通道。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'])

/**
 * 按路径扩展名选媒体通道。
 *
 * 与微信插件的取舍一致：图片走图片通道（手机上是照片而不是附件），
 * 其余一律走文件通道。视频在这里额外分出来，因为 QQ 的原生视频消息能直接播放。
 *
 * @param path - 文件绝对路径。
 * @returns `'image' | 'video' | 'file'`
 */
export function mediaKindFor(path) {
  const dot = path.lastIndexOf('.')
  const ext = dot < 0 ? '' : path.slice(dot).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

/**
 * `send_to_qq`：把本机文件发到**提问的那个 QQ 对话**。
 *
 * @param options.deliver - `(args, exec) => Promise<string>`，返回一句人话结果。
 * @param options.log - 记录一行日志。
 */
export function sendToQqToolDefinition({ deliver, log }) {
  return {
    name: 'send_to_qq',
    description:
      'Send a file from this machine to the QQ conversation that asked for it. Images arrive as ' +
      'photos, videos as playable clips, and everything else as a file attachment, chosen from the ' +
      'path extension. Use this whenever the user asked to see, receive, or be sent a file, image, ' +
      'screenshot, chart, or video. The path must be absolute and may point anywhere on this machine ' +
      '— a file on the Desktop or in a project folder is sent as it is, with no need to copy it ' +
      'anywhere first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to send.' },
        caption: { type: 'string', description: 'Optional short message to send before the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args) => [{ type: 'text', text: `sent ${String(args.path ?? '')} to QQ` }],
    },
    execute: async (args, exec) => {
      const detail = await deliver({ path: String(args.path ?? ''), caption: args.caption }, exec)
      log(`send_to_qq: path=${String(args.path ?? '')} -> ${detail}`)
      return { detail }
    },
  }
}

/**
 * `notify_qq`：从**任意**会话主动推送到用户当前所在的 QQ 对话。
 *
 * @param options.deliver - `(args, exec) => Promise<string>`。
 * @param options.log - 记录一行日志。
 */
export function notifyQqToolDefinition({ deliver, log }) {
  return {
    name: 'notify_qq',
    description:
      "Push a message, and optionally a file, to the user's QQ. Unlike send_to_qq this works from " +
      'any session, including one the QQ conversation is not currently bound to, which is what ' +
      'makes "tell me when it is done" possible. Always reaches the conversation the user is ' +
      'currently in; there is no way to choose another. Use it to report a finished task, or to ' +
      'send a file the user asked to receive. Keep text short — it is read on a phone.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send. Short, and written for a phone.' },
        path: {
          type: 'string',
          description:
            'Optional absolute path of a file to send after the text. Images arrive as photos, videos as playable clips, everything else as a file attachment.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args) => [
        { type: 'text', text: `notify QQ${args.path === undefined ? '' : ` with ${String(args.path)}`}` },
      ],
    },
    execute: async (args, exec) => {
      const detail = await deliver({ text: String(args.text ?? ''), path: args.path }, exec)
      log(`notify_qq: text=${String(args.text ?? '').slice(0, 40)} path=${String(args.path ?? '')} -> ${detail}`)
      return { detail }
    },
  }
}
