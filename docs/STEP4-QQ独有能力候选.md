# 第四步：QQ 独有能力候选（微信做不到、而 QQ 能做）

> **状态：调研完成，未实现。** 本文件不含任何已落地的功能，`lib/` / `index.js` / `client.js` 未被改动。

---

## 0. 这份文档的证据口径（先读这一节，否则后面每一条都会被误读）

### 0.1 权威来源与实际位置

| 来源 | 路径（相对 `dsh-qq/node_modules/@tencent-connect/`） | 说明 |
|---|---|---|
| 类型定义 | `qqbot-nodejs/dist/**/*.d.ts` | 任务指定的权威清单 |
| **完整 TypeScript 源码** | `qqbot-nodejs/src/**/*.ts` | **该包把 `src/` 一起发布了**（`package.json` 的 `files` 含 `"src"`），与 `dist/` 逐行对应 |
| 官方用法文档 | `qqbot-nodejs/USAGE.md` | 806 行，章节齐全 |
| README | `qqbot-nodejs/README.md` | 207 行 |
| 连接器 | `qqbot-connector/dist/esm/*.d.ts` | v1.2.0，只有扫码绑定 |

**引用约定**：本文一律引 `qqbot-nodejs/` 下的相对路径。因为 `src/*.ts` 可读性远好于
`dist/*.js`（编译产物），而两者内容一致，所以**优先引 `src/`**；任务点名的 `dist/**/*.d.ts`
在关键结论处一并给出。**已安装版本 `@tencent-connect/qqbot-nodejs@1.0.4`。**

### 0.2 三种"支持"，本文明确区分

| 标记 | 含义 |
|---|---|
| **可用** | 类型 + 文档 + 代码路径都齐，且不依赖无法确认的外部前提 |
| **有条件可用** | 代码路径齐，但**前提无法从离线证据确认**（权限、配额、平台侧模板） |
| **不可用** | 代码路径不存在，或明确只对频道开放 |

### 0.3 硬纪律

1. **没有真机结论。** 我没有 QQ 账号、没有装 `silk-wasm`、没有 ffmpeg。凡本文写
   "可用"的地方，都只意味着"**类型/文档/代码支持到这一步**"，**不等于**"手机上一定能看到"。
2. **类型里有 ≠ 实际能用。** 第 5 节（反应事件）就是这一类：字符串常量在类型里，
   但**没有任何配套基础设施**。
3. **凡是要真机才能确认的，一律进第 10 节探针清单。**

### 0.4 本轮已经跑过的离线核实

```
node smoke/step4-surface.mjs      # 不需要凭据、不联网，可随时重跑
```

它的产物是本文多条结论的直接依据（导出面、依赖是否装上、反应事件有多少配套）。
**联网探针已写好但未运行**：`smoke/step4-probe.mjs`（需要你的凭据 + 手机）。

---

## 1. 候选 1：Markdown 富文本回复

### 结论

**有条件可用 —— 且是本步骤用户价值最高的一项。**
但**绝不能靠翻 `markdownSupport: true` 来实现**：那个开关的副作用比预期大得多（见 1.3）。
正确做法是**逐条显式走 markdown**，而这条路的前提是**机器人拥有 markdown 权限**——
权限是唯一无法离线确认的前提，也是本候选的生死线。

### 证据

**能力存在：**

- `src/QQBot.ts:60-72` — `MsgType`：`TEXT: 0` / `MARKDOWN: 2` / `ARK: 3` / `EMBED: 4` / `MEDIA: 7`
  （`dist/QQBot.d.ts:37-49`）
- `src/QQBot.ts:716-727` — `sendMarkdown(target, content, opts?: { keyboard? })`
  （`dist/QQBot.d.ts:346-356`）
- `src/QQBot.ts:667-673` — **`send()` 是显式模式**，官方注释原话：
  *"`sendText` auto-selects msg_type based on `markdownSupport` config (markdown bots
  automatically send as msg_type=2). `send()` is explicit mode — you control msg_type directly."*
  **这句话就是"绕开全局开关"的官方许可。**
- `src/protocol/api/messages.ts:224-230` — `sendRaw` 在 `msg_type` 缺省时按字段自动推断
  （有 `markdown` → 2）

**权限是门槛（原文）：**

- `src/QQBot.ts:134-135` / `dist/QQBot.d.ts:125-126` — *"Whether the bot has markdown
  permission. Defaults to false."*
- `USAGE.md:197-198` — *"`markdownSupport` 影响 `sendText` 的请求体。**如果你的机器人没有
  markdown 权限，务必保持为 `false`，否则 QQ 服务端会以 `40034090` / 渲染失败提示告知**。"*
- `USAGE.md:717` — *"`markdown` 消息需要**审核通过的特殊权限**，未审核机器人请保持
  `markdownSupport: false`。"*

**markdownSupport = true 的真实副作用（本轮新发现，见 1.4）：**

- `src/protocol/api/messages.ts:317-338` — `buildMessageBody`：
  ```ts
  const body = this.markdownSupport
    ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }   // ← 所有 sendText
    : { content, msg_type: 0, msg_seq: msgSeq }
  if (messageReference && !this.markdownSupport) {              // ← 331-333
    body.message_reference = { message_id: messageReference }    //    markdown 时被丢掉
  }
  ```
- `src/protocol/api/messages.ts:340-342` — `buildProactiveBody` **同样**按 `markdownSupport`
  切到 `msg_type: 2`。**主动推送也一起变。**
- `src/streaming.ts:183` — `content_type: StreamContentType.MARKDOWN` 是**硬编码**的，
  即流式消息**总是** markdown（与 `markdownSupport` 无关）。

**QQ 专属的 markdown 扩展：**

- `src/protocol/utils/image-size.ts:216-231` — `formatQQBotMarkdownImage(url, size)` 产出
  `![#120px #120px](url)`；`hasQQBotImageSize` 用正则 `/!\[#\d+px\s+#\d+px\]/` 判定。
  **这是 QQ 自己的图片尺寸语法，SDK 专门为它写了工具函数。**

**参考：单条消息长度上限** `src/protocol/utils/text-chunk.ts:11` — `TEXT_CHUNK_LIMIT = 5000`
（插件已在用该常量，`lib/runtime.js:26`）。

### 1.1 复核 STEP3 那条「QQ 的 markdown 不吃下划线」

**结论：那条结论的证据方向正确，但覆盖面不足，且它不是本候选的真正风险。**

`docs/STEP3-能力调研与实现规格.md:74-86` 记录的证据是：真机截图，同一行并排三种写法
（裸下划线 / 反引号 / 反斜杠转义），三种下划线**都完好**，反斜杠被消费掉。

**这份证据的问题：**

1. 它是**一次观测**，且发生在**按钮消息**的上下文里（走 `sendMarkdown`）。不过这点
   **不构成漏洞**——`sendMarkdown` 与 `markdownSupport: true` 的 `sendText` 在协议层是
   同一种东西（都是 `msg_type: 2` + `markdown.content`），所以下划线行为**可以迁移**。
2. 它**只回答了"下划线"这一个字符**。代码块、列表、表格、星号、方括号、竖线在 C2C
   里渲染成什么，**一个字都没有**。而这才是"要不要用 markdown"的关键。
3. 它**没有验证权限**。STEP3 的按钮实验能成功，说明**当时那个机器人已被授予 markdown
   能力**（否则 `USAGE.md:198` 说会报 `40034090`）。但这不能推出"当前机器人仍然有权限"，
   更不能推出"换一个 AppID 也有"。

**所以：下划线这条可以按"已复核、结论成立"采信；但它不是选型的决定性因素。**
决定性因素是权限（1.2）与副作用（1.3）。

### 1.2 能力边界

| 项 | 边界 | 依据 |
|---|---|---|
| 前提 | 机器人需**审核通过**的 markdown 权限 | `USAGE.md:198, 717` |
| 违规后果 | `40034090` / 渲染失败 | `USAGE.md:198` |
| 单条长度 | ~5000 字符 | `src/protocol/utils/text-chunk.ts:11` |
| 键盘渲染 | **只在 msg_type=2 下渲染**（STEP3 真机定案） | STEP3 文档 15-31 |
| 代码块/列表/表格 | **查不到** —— SDK 与官方文档均未说明 C2C 支持程度 | 见第 10 节 P1 |
| 尺寸图片 | SDK 提供了 `![#Wpx #Hpx](url)` 语法工具，但**未见任何文档说明适用范围** | `image-size.ts:218` |
| 流式 | `stream_messages` 的 `content_type` 硬编码 markdown | `src/streaming.ts:183` |

### 1.3 对本插件的意义

这是**唯一一项直接改善"agent 的答案在手机上好读不好读"的能力**，而本插件的核心用途
就是"在手机上看 agent 的输出"。

具体能做出的用户可见效果：

1. **格式化的回答**：标题、列表、粗体、行内代码、代码块——agent 输出本来就是 markdown，
   现在被当成纯文本发出去，**所有结构都退化成字符**。
2. **长回复的降级可以放宽**。当前超过 `maxReplyChars` 就写 `.md` 文件发附件
   （`lib/reply-limit.js:25-35`，设置项见 `client.js:224-225`）。有了富文本渲染，
   中等长度的回答可以留在聊天里而不是变成附件。
3. **尺寸图片**（`formatQQBotMarkdownImage`）：可以让 agent 发的图按预期尺寸显示，
   而不是被 QQ 拉成满屏。

**风险最高的地方不是下划线，而是"权限"这个开关只有开/关两态。**
一旦翻了全局 `markdownSupport`，而机器人没有权限，**所有**文本回复（含主动推送、
含待发队列补发）会一起失败——这是典型的"一处开关、全面静默失效"。

### 1.4 实现代价

**推荐做法：不动全局开关，新增一条显式的 markdown 发送路径。**

| 文件 | 改动 | 规模 |
|---|---|---|
| `lib/runtime.js` | 新增 `#sendMarkdown(conversationId, text)`，与 `#send`（`:1444-1476`）同构：复用 `#targetFor`（`:1488-1508`）取 target，走 `bot.sendMarkdown(target, text)`；`#flushReply` 里按设置选择走哪条 | ~60-90 行 |
| `lib/runtime.js` | 设置项 `markdownReplies`（布尔）+ 水合/应用（照 `:486-487`、`:553-554`、`:621-622` 的既有模式） | ~20 行 |
| `lib/runtime.js` | 起始构造（`:698-721`）**不需要**改 `markdownSupport`——这正是本方案的价值 | 0 行 |
| `lib/state.js` | 设置持久化与校验（照 `:102-103` 的模式，布尔项要显式校验） | ~5 行 |
| `lib/routes.js` | 设置页读写该字段 | ~10 行 |
| `client.js` | 设置面板加一个开关 + 中英文案（照 `:224-225`、`:329-330`、`:1426-1433`） | ~30 行 |
| `docs/SETTINGS-CONTRACT.md` | 新增设置项必须登记 | 文档 |

**要不要动客户端：要**（多一个设置开关）。约 130-160 行。
**不翻 `markdownSupport` 的理由**：翻了就同时改变 `sendText` 与 `sendProactiveMessage`
（`messages.ts:324-326, 340-342`），且丢掉 `message_reference`（`:331-333`）——
用一个开关换来三个副作用，没有必要。

### 1.5 什么情况下会静默失败

| 失败方式 | 表现 | 为什么静默 |
|---|---|---|
| 机器人无 markdown 权限 | 返回 `40034090`，**消息不显示** | 若不在发送路径上单独识别该错误码，只是"发了但手机上没东西" |
| 表格/代码块 C2C 不渲染 | 显示成一堆竖线或原文 | 不报错 |
| 星号被当强调标记吃掉 | `**` 或 `*` 出现在正文里时被解析 | 不报错 |
| 反斜杠转义 | 反斜杠被消费（STEP3 已证） | 不报错 |
| 长度超 5000 | 需配合 `chunkText`，否则可能被拒或截断 | 取决于服务端 |

---

## 2. 候选 2：撤回消息 `recallMessage`

### 结论

**有条件可用。** 代码路径存在且形状清晰，**但 SDK 对时限、权限、频率一个字都没写**——
`USAGE.md` 与 `README.md` 里 "recall" **一次都没出现**（离线核实过）。
另外：**它不适合做"实时状态消息"**，原因是平台自身的被动回复配额（见 2.2）。

### 证据

- `src/QQBot.ts:729-740` — `recallMessage(target, messageId)` → `messageApi.recallMessage`
  （`dist/QQBot.d.ts:360-368`），JSDoc 只给了用法示例，**没有任何限制说明**
- `src/protocol/api/messages.ts:282-294` — 实现只有 4 行实质逻辑：
  ```ts
  const path = `${messagePath(scope, targetId)}/${messageId}`
  await this.client.request(token, "DELETE", path)
  ```
- `src/protocol/api/routes.ts:9-11` — `messagePath` = `/v2/users/{openid}/messages`（c2c）
  → 实际路径 `/v2/users/{openid}/messages/{message_id}`
- `src/protocol/types.ts:70-77` — `MessageResponse { id, timestamp, ext_info.ref_idx }`，
  **`id` 是撤回所需的句柄**
- `USAGE.md` / `README.md` — **全文无 "recall"**（离线 grep 结论）

**已有的离线抓手**：`smoke/check-sdk-surface.mjs:17` 已经在核对
`QQBot.prototype.recallMessage` 是否存在；离线探针确认**存在**。

### 2.1 能力边界（能从代码确认的部分）

| 项 | 情况 | 依据 |
|---|---|---|
| 路径 | `DELETE /v2/users/{openid}/messages/{message_id}`（c2c 与 group 同构） | `messages.ts:292`, `routes.ts:9-11` |
| 需要什么句柄 | `MessageResponse.id`（发送时返回） | `types.ts:70-77` |
| 返回什么 | `Promise<void>` —— **没有任何回执信息** | `QQBot.d.ts:368` |
| 时限 | **查不到** | 第 10 节 P3 |
| 能否撤别人的 | **查不到**（探针第 3 项专门测错误码） | 第 10 节 P3 |
| 频率限制 | **查不到** | 第 10 节 P3 |
| 被动/主动区别 | SDK 侧无区别：`recallMessage` 不接收 `msgId`，只认 `messageId` | `messages.ts:285-294` |

### 2.2 ★ 关键算计：为什么它不适合做"实时状态消息"

你问的是"能不能支撑「发→撤回→重发」"。**能做，但代价被平台配额卡死。**

`src/protocol/utils/reply-limiter.ts:5` 的原文：

> *"QQ Bot restricts how many passive replies can be sent in response to a single inbound
> message (**4 per hour by default**)."*

同一文件 `:42-43` 是默认值：`DEFAULT_LIMIT = 4`、`DEFAULT_TTL_MS = 60 * 60 * 1000`。

而插件的发送路径**正是**按这条规则降级的：`lib/runtime.js:1488-1508` 的 `#targetFor`
每条回复都调 `this.#limiter.checkLimit(inbound.msgId)`，用满 4 次就转主动推送
（`:1500` 打印 `被动回复不可用…转主动推送`），而主动推送**另有配额**
（`USAGE.md:716`）。

**所以「发→撤回→重发」每刷新一次状态就消耗 1 次被动配额，一条状态消息只能刷新 4 次
就必须转主动推送。** 这不是 SDK 的限制，是平台规则。

**平台为此提供的正确机制是 `stream_messages`（同一条消息原地改写），它只对 C2C 开放**
（`USAGE.md:436-438`、`src/streaming.ts:4-7`）。而**流式功能用户已经明确取消**
（STEP3 文档第 60-62 行）。

→ **结论：撤回应当定位为"纠错"，不是"实时刷新"。** 见第 9 节排序。

### 2.3 对本插件的意义

能做出用户看得见的效果：

1. **纠错**：agent 发错了（幻觉、发错会话）→ 撤回。当前**没有任何纠错手段**，
   用户只能看着一条错消息留在那里。
2. **"干完了"状态的收尾**：可以先发一条"正在处理…"，完成后撤回它再发结果，
   **避免"正在处理"永远留在聊天里**（本插件现在只有 typing 提示，30 分钟后停止刷新，
   `lib/runtime.js:1533-1537`，提示消失但消息不消失）。
3. **长回复文件化的回退**：`lib/reply-limit.js` 的 `caption + 附件` 模式若失败，
   可以撤掉半条。

### 2.4 实现代价

| 文件 | 改动 | 规模 |
|---|---|---|
| `lib/runtime.js` | `#send` / `#deliverTo` 改为把 `MessageResponse.id` 记下来（当前**完全丢弃返回值**，`:1458`、`:2264-2266`） | ~30 行 |
| `lib/runtime.js` | 新增 `recall(conversationId, messageId)` 包装，含错误分类 | ~40 行 |
| `lib/runtime.js` | 需要一个新的工具或命令入口（例如 `/undo`，或让 agent 通过工具撤回） | ~40 行 |
| `lib/send-tools.js` | 若要给 agent 一个"撤回上一条"的工具，照 `sendToQqToolDefinition`（`:46-80`）加 | ~50 行 |
| `lib/routes.js` + `client.js` | 若要诊断页显示最近发出的 messageId | 可选 |

**要不要动客户端：只在加设置项/诊断视图时才要。** 最小可用版本（一个 `/undo` 命令）
约 110 行，**不动客户端**。

### 2.5 什么情况下会静默失败

| 失败方式 | 表现 | 备忘 |
|---|---|---|
| 超过时限 | 请求返回错误，但 `recallMessage` 返回 `void` —— **调用方拿不到"撤回成功了没有"之外的任何信息** | 必须自己 try/catch 并分类错误码 |
| 撤回别人的消息 | 预期失败，错误码未知 | 第 10 节 P3 |
| 已撤回的消息再撤 | 未知 | 第 10 节 P3 |
| **调用方丢弃 `MessageResponse.id`** | 想撤回时**没有句柄可用** | 这是当前代码的现状（`:1458`） |

---

## 3. 候选 3：语音消息（SILK / TTS）

### 结论

**本机当前不可用。** 类型与工具函数齐全，但：
1. **SDK 不提供 TTS** —— 没有任何文本转语音的代码或依赖（这一点必须说清，不能假设）。
2. **`sendVoice` 不做转码** —— 转码工具是**孤儿函数**，需要调用方自己调用。
3. **本机三个前置依赖全部缺失**（`silk-wasm` / `mpg123-decoder` / `ffmpeg`），
   离线探针实测确认。三者全缺时，非 `wav/mp3/silk` 输入会**返回 `null`（静默失败）**。

### 证据

**能力存在：**

- `src/protocol/types.ts:82-87` — `MediaFileType.VOICE = 3`
- `src/QQBot.ts:1051-1063` — `sendVoice(target, source, opts)` → `sendMedia(fileType: VOICE)`
  （`dist/QQBot.d.ts:510`）
- `USAGE.md:363-364` — `VOICE` 上限 **20 MB**
- `USAGE.md:384` — `await bot.sendVoice(target, { localPath: "/tmp/voice.silk" })`
  —— **示例文件名就是 `.silk`**

**★ 转码没有被接进发送路径（本轮关键发现）：**

- `src/QQBot.ts:1051-1063` → `sendMedia`（`:995-1019`）→ `uploadMedia`（`:924-990`）
  → `mediaApi.uploadMedia`（`src/protocol/api/media.ts:70-161`）
- `src/protocol/api/media.ts:96-102` — 直接把文件读成 base64：
  ```ts
  let fileData = opts.fileData
  if (opts.buffer) { fileData = opts.buffer.toString("base64") }
  else if (opts.localPath) { const buf = await fs.promises.readFile(opts.localPath); fileData = buf.toString("base64") }
  ```
  **全链路没有任何一处调用 `audioFileToSilkBase64` 或 `pcmToSilk`。**

**转码工具确实存在，但只导出到 `/protocol`，且要自己调：**

- `src/protocol/utils/audio.ts:238-340` — `audioFileToSilkBase64(filePath, directUploadFormats?, logger?)`
  - `:222` — `QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"]`（这三种**直传，不转码**）
  - `:259-262` — 命中直传格式直接 `buf.toString("base64")`
  - `:289-306` — 否则尝试 ffmpeg → PCM → `pcmToSilk`
  - `:308-331` — ffmpeg 缺失时退到 WASM（`.pcm` / `.wav` / `.mp3`）
  - `:333-339` — **全都不可用时 `return null`**，只打一行 error 日志
- `src/protocol/utils/audio.ts:426-441` — `pcmToSilk`；`:431-434` 无 `silk-wasm` 时
  **`throw new Error("silk-wasm is not available; cannot encode PCM to SILK")`**
- `src/protocol/utils/ffmpeg.ts:37-92` — `detectFfmpeg()`，探测顺序：
  `FFMPEG_PATH` 环境变量 → PATH 上的 `ffmpeg` → 常见安装位置（Windows 含
  `C:\ffmpeg\bin\ffmpeg.exe`、`LOCALAPPDATA\Programs\ffmpeg\bin\...`）
- `src/protocol/utils/ffmpeg.ts:109-131` — `checkSilkWasmAvailable()`，`import("silk-wasm")` 探测

**依赖是 optional peerDependency（这是"没装上"的制度原因）：**

- `qqbot-nodejs/package.json` —
  ```json
  "peerDependencies": { "mpg123-decoder": "^1.0.3", "silk-wasm": "^3.7.1" },
  "peerDependenciesMeta": { "mpg123-decoder": {"optional": true}, "silk-wasm": {"optional": true} }
  ```
- `src/protocol/utils/audio.ts:8-11` — *"The SDK does NOT bundle `silk-wasm` / `mpg123-decoder`
  as hard dependencies — both are loaded via `import()` and degrade to `null` when missing.
  **Add them to your application's dependencies when you need voice-message support.**"*

**离线实测（`smoke/step4-surface.mjs` 输出）：**

```
silk-wasm        缺失
mpg123-decoder   缺失
ffmpeg           缺失
→ 三者全缺时 audioFileToSilkBase64() 对非 wav/mp3/silk 输入会返回 null（静默失败）
```

且 `dsh-qq/package.json` 的 `dependencies` 里**只有** `qqbot-connector` / `qqbot-nodejs` /
`qrcode`，**没有** `silk-wasm`。

**导出面实测**：`audioFileToSilkBase64` / `shouldTranscodeVoice` / `checkSilkWasmAvailable` /
`detectFfmpeg` / `pcmToSilk` **根入口=无、`/protocol`=有**。

**没有 TTS**：在 `src/` 全树与 `USAGE.md` / `README.md` 中搜索 `tts` / `speech` / `synthes`
**无任何实现**。唯一的痕迹是 `src/protocol/types.ts:103` 的 `OutboundMeta.ttsText?: string`——
一个**留给调用方填的元数据字段**，不是 TTS 实现。

### 3.1 能力边界

| 项 | 情况 | 依据 |
|---|---|---|
| 格式 | QQ 原生：`.silk` / `.slk` / `.amr` / `.wav` / `.mp3`（直传）；其余需转码 | `audio.ts:208, 222` |
| 上限 | 20 MB | `USAGE.md:364`, `file-utils.ts:25` |
| 时长上限 | **查不到**（QQ 通常另有秒数上限） | 第 10 节 P8 |
| SDK 转码 | **有工具，但不在发送路径上** | `audio.ts:238`, `media.ts:96-102` |
| TTS | **没有** | 全树搜索无结果 |
| 无依赖时行为 | **返回 `null`，只打日志** | `audio.ts:333-339` |

### 3.2 对本插件的意义

**"把回答念出来"的完整链路必须由本插件自己补齐，共 4 段，缺一段都不成立：**

```
agent 文本 → [① TTS 引擎] → 音频文件 → [② 转 SILK] → 上传 → [③ 发送] → [④ 语音气泡]
              ↑ 本插件要自带        ↑ audioFileToSilkBase64（需装依赖）
```

- ①：**必须引入外部 TTS**（Windows 有 SAPI，但那是新依赖 + 新故障面）。
- ②：装 `silk-wasm`（+ 可选 ffmpeg）后可用；若 TTS 能直接产出 `.wav`，则按
  `audio.ts:259-262` **可以完全跳过转码**——这是最省事的路径。
- ③④：`bot.sendVoice(target, { localPath })` 现成。

用户可见效果：agent 的回答变成一条**可点播放的语音气泡**。对"走路时听结果"是质变。

**但要清醒**：这是一条**四段式依赖链，且前三段都在本插件里**。任何一段缺失或失败，
用户看到的都是"什么都没发生"（因为 `audioFileToSilkBase64` 失败返回 `null`，
而 `sendVoice` 拿到 `null` 后的行为**需要另行确认**）。

### 3.3 实现代价

| 文件 | 改动 | 规模 |
|---|---|---|
| `package.json` | 加 `silk-wasm`（必需）+ 可能加 `mpg123-decoder`/ffmpeg 说明 | 1 行 + 文档 |
| 新文件 `lib/tts.js` | TTS 引擎接入（Windows SAPI / 其他），产出 `.wav` | ~80-150 行（**取决于选哪个引擎**） |
| `lib/runtime.js` | 在 `#sendFile`（`:2246-2269`）旁加 `voice` 分支：显式调 `audioFileToSilkBase64` 再 `sendVoice` | ~40 行 |
| `lib/send-tools.js` | `mediaKindFor`（`:32-38`）加语音分支 | ~10 行 |
| `lib/routes.js` + `client.js` | 语音开关（**必须**有：语音是"吵"的，不能强制） | ~40 行 |

**要不要动客户端：要。** 合计 **~180-250 行 + 一个新依赖 + 一个新故障面**。
**这是 8 个候选里代价最高的一个。**

### 3.4 什么情况下会静默失败

| 失败方式 | 表现 |
|---|---|
| 没装 `silk-wasm` | `audioFileToSilkBase64` 返回 `null` + 一行 error 日志 → **用户端什么都没有** |
| TTS 输出不支持的格式且无 ffmpeg | 同上 |
| 直接传 `.ogg`/`.m4a` 给 `sendVoice` | **SDK 不转码**，base64 原样上传 → 服务端可能接受但播放异常，或报错 |
| 音频超时长上限 | 错误码未知，第 10 节 P8 |
| 误以为"系统里有 TTS" | **本机没有可用的 TTS 链路**，这是本节最重要的否定结论 |

---

## 4. 候选 4：ARK / Embed 卡片

### 结论

**查不到 —— 无法判定，且强烈不建议优先做。**
类型里有两个字段，`USAGE.md` 与 `README.md` 里**"ark"/"embed" 一次都没出现**，
没有任何官方示例、字段说明或适用范围。ARK 还额外依赖**平台侧申请的模板 ID**
（`template_id: number`），这是一个本插件无法自助满足的外部前提。

### 证据

**类型存在（且 `embed` 完全没有类型）：**

- `src/QQBot.ts:60-71` — `MsgType.ARK: 3`、`MsgType.EMBED: 4`（`dist/QQBot.d.ts:42-45`）
- `src/QQBot.ts:84-87`（`dist/QQBot.d.ts:67-77`）：
  ```ts
  /** Ark template payload (msg_type=3). */
  ark?: { template_id: number; kv: Array<{ key: string; value?: string; obj?: unknown[] }> }
  /** Embed payload (msg_type=4). */
  embed?: Record<string, unknown>
  ```
  ⚠️ `embed` 是 `Record<string, unknown>` —— **SDK 自己也没有它的形状**。
- `src/protocol/api/messages.ts:224-230` — `sendRaw` 自动推断 `ark` → 3、`embed` → 4
- `src/QQBot.ts:652-665` — `send()` 把 `ark` / `embed` 原样塞进请求体
- `src/protocol/api/routes.ts:9-11` — c2c 走 `/v2/users/{openid}/messages`，
  **即 SDK 不会阻止你往 C2C 发 3/4 型消息**，它只是照发

**官方文档的沉默（离线 grep 结论）：**

- `USAGE.md` 全文：`ark` / `Ark` / `embed` / `Embed` **零命中**
- `README.md` 全文：同上**零命中**
- `USAGE.md:710-720`（"QQ 平台硬性限制"一节）列举了流式仅 C2C、节流 300ms、主动消息额度、
  markdown 权限、群 openid、`upload_prepare` 日额度——**完全没有提 ark/embed**

**这个"沉默"本身是强信号**：SDK 作者为按钮（§9.2/§12）、typing（§9.3）、流式（§11）、
媒体（§10）都写了完整文档与示例，唯独 ark/embed 只有一行类型。**要么是 C2C/群不常用，
要么是它们主要面向频道场景。**

### 4.1 能力边界

| 项 | 情况 | 依据 |
|---|---|---|
| 形状 | `ark { template_id: number, kv[] }`；`embed: Record<string, unknown>` | `QQBot.ts:84-87` |
| C2C 能否用 | **查不到** | 第 10 节 P6/P7 |
| 需要平台侧模板 | **是**（`template_id` 是数字 id，须在开放平台申请） | `QQBot.ts:85` 字段本身 |
| 官方示例 | **没有** | grep 零命中 |
| 错误码语义 | 未知 —— "模板不存在"与"不支持该消息类型"是**完全不同**的两件事 | 第 10 节 P6 |

### 4.2 对本插件的意义

**潜在价值高，但当前无法规划。** 如果 C2C 可用，卡片能做出：结构化结果卡片、
带缩略图的链接预览、审批卡片。

**但现在的诚实结论是：不知道能不能用，也不知道长什么样。** 拿一个
`Record<string, unknown>` 去试，属于 STEP3 之前那种"未实测就实现"的做法。

### 4.3 实现代价

**无法估算** —— 依赖 4.1 中"查不到"的三项。**在探针 P6/P7 给出错误码之前，不应估算。**

### 4.4 什么情况下会静默失败

若 C2C 不接受 msg_type 3/4，SDK **不会拦截**（`sendRaw` 照发，`routes.ts` 走 c2c 路径），
失败只会在 API 层表现为一个错误码。**若调用方不看 `bizCode`，就是"消息没发出去、
日志里一行看不懂的字"。**

---

## 5. 候选 5：表情回应事件 `MESSAGE_REACTION_ADD` / `REMOVE`

### 结论

**不可用（对本插件而言），且这一点证据非常扎实。**

理由是三层叠加：

1. **没有配套 intent。** `INTENTS` 表里**没有任何 REACTION 位**。
2. **没有配套 payload 类型。** 离线探针确认：`/protocol` 里**名字含 reaction 的导出为 0**。
3. **没有分发逻辑。** 事件走 `dispatchEvent` 的兜底分支 `action: "raw"`，
   只能通过 `rawEvent` 拿到 **`unknown` 类型的裸 JSON**。

再加上 `INTENTS` 表里能覆盖反应的只有 `GUILDS`（频道）位，**证据方向明确指向"频道专属"**。

**并且本插件只做 1:1 私聊**（`lib/runtime.js:18` 的原话：
*"**只做 1:1 私聊**（`scope: 'c2c'`）。不做群聊"*）。

### 证据

**只有字符串常量，没有别的：**

- `src/protocol/gateway/constants.ts:89-91`（`dist/protocol/gateway/constants.d.ts:63-64`）：
  ```ts
  // ── Reaction events ──
  MESSAGE_REACTION_ADD: "MESSAGE_REACTION_ADD",
  MESSAGE_REACTION_REMOVE: "MESSAGE_REACTION_REMOVE",
  ```
  **这是全树唯一出现 reaction 的地方。** 离线 grep 结果：
  ```
  REACTION / reaction 全树命中：
    QQBot.d.ts:201: * Covers all platform events (guild/group/friend lifecycle, reactions, etc.)
    dist/.../constants.d.ts:63-64  ← 仅这两行常量
  ```
  连 `dist/*.js` 里都没有处理逻辑。

**intent 表里没有反应位：**

- `src/protocol/gateway/constants.ts:8-16`：
  ```ts
  const INTENTS = {
    GUILDS: 1 << 0,
    GUILD_MEMBERS: 1 << 1,
    PUBLIC_GUILD_MESSAGES: 1 << 30,
    DIRECT_MESSAGE: 1 << 12,
    GROUP_AND_C2C: 1 << 25,
    INTERACTION: 1 << 26,     // ← 只有按钮交互，没有反应
  } as const
  ```
  **没有 `REACTION` 位。** 能覆盖反应事件的只有 `GUILDS`（频道）——
  **这正是"guild-only"结论的直接技术依据。**

**而且这张表根本没有导出：**

- `src/protocol/index.ts:59-70` — 只导出 `FULL_INTENTS` 与 `GatewayEvent` 等，**不含 `INTENTS`**
- 离线实测：`根入口=无  /protocol=无  ← INTENTS`
  → **你连"只开 GUILDS 来单独测反应事件"这件事都做不到，除非硬编码魔数。**

**分发逻辑只认 6 种消息事件 + 交互：**

- `src/protocol/gateway/event-dispatcher.ts:267-274`：
  ```ts
  if (eventType === GatewayEvent.INTERACTION_CREATE) { return { action: "interaction", ... } }
  // All other gateway events are forwarded as raw events.
  // This covers guild/group/friend lifecycle, reactions, and any future
  // platform events — zero SDK changes required for new event types.
  return { action: "raw", type: eventType, data }
  ```
  **注释自己承认反应事件是"靠 raw 兜底"，不是被支持的。**

**`rawEvent` 只在 websocket 传输下接线：**

- `src/QQBot.ts:538-541` — `startWebSocket()` 里传了 `onRawEvent`
- `src/QQBot.ts:563-579` — **`startWebhook()` 的回调对象里没有 `onRawEvent`**
  → webhook 模式下反应事件（以及 interaction 的兜底）**完全收不到**。
  本插件用默认 websocket，所以这一条不构成现存缺陷，但**是将来切 webhook 的陷阱。**

**插件当前的用法（仅观测）：**

- `lib/runtime.js:727-729` — 用 `recordOnce` 记录出现过的 rawEvent 类型，
  **不处理内容**。这是一个恰当的现状：在探针给出结论前，观测就够了。

### 5.1 能力边界

| 项 | 情况 | 依据 |
|---|---|---|
| C2C 是否支持 | **查不到**；证据方向指向 guild-only | `constants.ts:8-16` 无反应 intent |
| 需要的 intent | 未知；能覆盖的只有 `GUILDS` | 同上 |
| 能否单独开 intent 测试 | **不能**，`INTENTS` 未导出 | 离线实测 |
| payload 类型 | **不存在** | 离线实测（reaction 相关导出 = 0） |
| 收到的形状 | `unknown`（裸 JSON，靠 `rawEvent`） | `event-dispatcher.ts:274` |
| 官方文档 | **零命中** | grep USAGE/README |

### 5.2 对本插件的意义

**如果建立不起来，就是"没用"——请明确接受这个结论，不要为它预留设计。**

在 1:1 私聊场景里，用户给消息加表情是一个**很自然的轻量反馈**（"收到"、"赞"）。
如果有这个事件，理论上能做：用户对某条消息加表情 → 触发某个动作。

**但：**
- 没有任何证据表明 C2C 会推这个事件。
- 即便会推，也只能拿到 `unknown`，**每一条都要靠猜字段名**——正是 POSTMORTEM 006
  那种"名字看着对、实际对不上"的失败形态。
- 想验证"要不要 intent"还得硬编码 `1 << 0`，因为 `INTENTS` 没导出。

**→ 处置建议：进探针清单（第 10 节 P9），用 `rawEvent` 观测一次。**
**在观测到之前，任何围绕它的设计都是空转。** 如果观测不到，就此关闭这个候选。

### 5.3 实现代价

| 情形 | 代价 |
|---|---|
| 探针确认私聊不推该事件 | **0**（关闭候选） |
| 探针确认私聊会推 | 需要：新设置项 + 事件→动作映射 + 白名单（防误触）+ 客户端说明，**~150 行起**，且要自己写 payload 类型 |

### 5.4 什么情况下会静默失败

**这一项的风险是最高的，因为它天然静默：** 用户加表情 → 后台什么都没发生 →
用户以为"功能就是这样"。而原因可能只是 intent 没开、或字段名猜错、或平台本就不推。
**三者从外部看完全一样。**

---

## 6. 候选 6：`is_wakeup` / `sendWakeup`

### 结论

**有条件可用，但语义存在一处必须澄清的歧义。**
它直接命中本插件当前**最大的用户痛点**（主动推送被配额排到"等你下次说话时补发"），
所以潜在收益很高；但 JSDoc 里那个 "recall" 一词几乎可以肯定是**"召回"而非"撤回"**，
而它与 `recallMessage`（撤回）只差一个字符。**这正是 POSTMORTEM 006 的形态。**

### 证据

**能力存在：**

- `src/QQBot.ts:742-759`（`dist/QQBot.d.ts:370-381`）：
  ```ts
  /**
   * Send a wakeup/recall message (C2C only, 30-day window).
   *
   * After a user initiates a conversation, the bot can send periodic
   * recall messages within 30 days using `is_wakeup: true`.
   * Platform enforces frequency limits.
   */
  async sendWakeup(target: ReplyTarget, content: string): Promise<MessageResponse> {
    if (target.scope !== "c2c") { throw new Error("sendWakeup is only supported for C2C targets") }
    return this.send({ target, content, extra: { is_wakeup: true } })
  }
  ```
- `src/QQBot.ts:94-95` — `extra?: Record<string, unknown>`：*"Pass-through extra fields
  (for new platform features not yet typed)"*
- `src/protocol/api/messages.ts:205` — 注释把 `is_wakeup` 列为**透传字段**之一
- `src/protocol/api/messages.ts:220-230` — 因为没有 `msg_id`，`msg_seq = 1`；
  因为没有 markdown/ark/embed/media 字段，`msg_type` 被推断为 **0（纯文本）**

**它是 SDK 里唯一被"具名包装"的透传字段** —— 别的透传字段都只能自己写 `extra`。
这至少说明作者认为它有用。

**官方文档的沉默（离线 grep）：**

- `USAGE.md` / `README.md` 中 `is_wakeup` / `sendWakeup` / `wakeup` **零命中**
- `USAGE.md:141-146` 的"被动回复 vs 主动推送"对照表**没有提它**
- `USAGE.md:317-323`（§9.4 主动 push）只说 *"主动消息有调用频次/额度限制，请阅读
  QQ 开放平台官方文档"*——**没有给数字，也没有提 `is_wakeup`**
- `USAGE.md:716` — *"主动消息有额度，不要把它当推送系统用。"*

**SDK 里唯一的平台配额数字（来自被动回复侧）：**

- `src/protocol/utils/reply-limiter.ts:5, 42-43` — 被动回复 **4 次 / 条 / 小时**
- **主动推送的配额：SDK 里没有任何数字。** 第 10 节 P10。

**插件当前的痛点（这是本候选的价值来源）：**

- `lib/runtime.js:1444-1476` — `#send`：被动优先，失败退到主动（`:1462-1471`）
- `lib/runtime.js:2126-2153` — `#deliverOrQueue`：主动推送失败 → **入队**，
  并在结果里附一句 *"等你下次说话时补发"*（`:2151`）
- `lib/runtime.js:2110-2112` 的注释把这件事说得很清楚：
  *"与微信的 `#sendOrQueue` 同构：那边的平台硬规则是'不能主动发'，QQ 这边是
  **主动推送有配额**。两条路的后果一样——**用户等的通知凭空消失，而且他永远不会知道**。"*

### 6.1 ★ 必须先澄清的歧义

`sendWakeup` 的 JSDoc 用的是 **"wakeup/recall message"**。而本 SDK 里
**"recall" 已经被 `recallMessage`（撤回/删除）占用了**（`src/QQBot.ts:729-740`，
`src/protocol/api/messages.ts:282-294`，实现是一个 `DELETE`）。

**`sendWakeup` 是一个 `POST`，它不可能是在"撤回"任何东西。**
所以这里的 "recall" 只能是 **"召回"**（重新唤起用户注意 / re-engage）。

**这个歧义必须写进探针**，因为解读错方向的后果是：
按"撤回"理解去实现"提升配额"，而它其实是另一类消息——**功能整条走偏，且不报错。**

### 6.2 能力边界

| 项 | 情况 | 依据 |
|---|---|---|
| 范围 | **仅 C2C**（group 时 `throw`） | `QQBot.ts:755-757` |
| 窗口 | JSDoc 称"用户发起对话后 30 天内" | `QQBot.ts:745-746` |
| 频率限制 | *"Platform enforces frequency limits"* —— **无数字** | 同上 |
| 消息类型 | `msg_type = 0`（纯文本）；`msg_seq = 1` | `messages.ts:220-230` |
| 是否占主动消息额度 | **查不到** | 第 10 节 P10 |
| 与"提高主动推送成功率"的关系 | **JSDoc 没这么说**。它描述的是一条**独立的**周期性发送通道 | `QQBot.ts:745-747` |
| 官方文档 | **零命中** | grep |

⚠️ 注意一个边界：`sendWakeup` 走的是 `this.send(...)`，而 `send()` **会**在
`target.msgId` 存在时带上 `msg_id`（`QQBot.ts:654`）。也就是说
**传一个带 `msgId` 的 target 时，它会同时是被动回复且带 `is_wakeup`** ——
这个组合的语义**未知**。探针里两个变体都测。

### 6.3 对本插件的意义

**这是唯一一项直接针对"通知被排队"这个既有痛点的候选。**

用户可见效果：`notify_qq`（"干完了告诉你"）在用户长时间不说话时，
**不再被排到"等你下次说话时补发"**，而是真的能送达。

如果探针证明它有效，这比 markdown 更"解决现有问题"；如果无效，
它就只是一个名字容易误导人的死字段。

### 6.4 实现代价

**极小** —— 这是本候选最吸引人的地方。

| 文件 | 改动 | 规模 |
|---|---|---|
| `lib/runtime.js` | `#send`（`:1457-1475`）在被动与主动都失败后，加第三次尝试 `bot.sendWakeup({scope:'c2c', targetId: peerId}, chunk)` | ~15-25 行 |
| `lib/runtime.js` | 或在 `#queuePending`（`:2156-2167`）之前先试一次 | ~10 行 |
| `lib/routes.js` + `client.js` | 可选开关 | 可选 |

**要不要动客户端：不要（最小版本）。** **~25 行，零新依赖，零客户端改动。**

### 6.5 什么情况下会静默失败

| 失败方式 | 表现 |
|---|---|
| 语义理解错（召回 ≠ 撤回） | 功能整条走偏，**不报错** |
| 额度也已用尽 | 与普通主动推送一样失败 → 照旧入队，用户无感 |
| 平台对 `is_wakeup` 有额外内容要求（如必须关联历史消息） | 报错码未知 |
| 把 `is_wakeup` 与 `msgId` 一起传 | 组合语义未知，可能被当成被动回复而**不计入召回额度**——"试了但没效果" |

---

## 7. 候选 7：分块上传大文件

### 结论

**已自动工作，不需要改 `#sendFile`。** 唯一缺口是**没有处理
`UploadDailyLimitExceededError`** —— 而这恰好是唯一值得补的地方。

### 证据

**阈值与上限（`src/protocol/utils/file-utils.ts`，`dist` 同名）：**

| 常量 | 值 | 行 |
|---|---|---|
| `MAX_UPLOAD_SIZE` | **20 MiB**（base64 一次性上传上限） | `:13` |
| `LARGE_FILE_THRESHOLD` | **5 MiB**（超过则走分块） | `:19` |
| `CHUNKED_UPLOAD_MAX_SIZE` | **100 MiB**（分块路径硬上限） | `:16` |
| `IMAGE` | 30 MB | `:23` |
| `VIDEO` | 100 MB | `:24` |
| `VOICE` | 20 MB | `:25` |
| `FILE` | 100 MB | `:26` |

`getMaxUploadSize(fileType)` 可程序化查询（`:33-35`）。三者关系要注意：
**20 MiB 是"单次 base64 直传"的上限，不是 FILE 类型的总上限（100 MiB）。**

**SDK 自动分流（关键：调用方无需感知）：**

- `src/QQBot.ts:947-948`：
  ```ts
  const size = await this.computeSourceSize(opts)
  const useChunked = size !== null && size >= LARGE_FILE_THRESHOLD
  ```
- `src/QQBot.ts:955-974` — 仅当 `useChunked && (opts.localPath || opts.buffer)` 才走
  `chunkedMediaApi.uploadChunked`
- `src/QQBot.ts:1099-1122` — `computeSourceSize`：`buffer` 用 `.length`，
  `localPath` 用 `statSync`，`fileData` 按 base64 折算，**`url` 返回 `null`**
- `USAGE.md:346-356` — §10.2：*"当源文件 ≥ `LARGE_FILE_THRESHOLD`（5 MB）时，SDK
  **自动**走分块上传通路 … **调用方完全不用感知这个切换**"*；
  且 *"`url` / `fileData` 来源**不会**走分块"*
- `USAGE.md:400` — *"`onProgress` 仅在分块上传路径上会被调用"*

**分块流程（`src/protocol/api/media-chunked.ts:105-219`）：**
`upload_prepare`（提交 md5/sha1/md5_10m）→ 逐块 `PUT` 到 COS 预签名 URL →
`upload_part_finish` → `complete_upload`。
`:84-86` — 默认并发 1，最大 10；`:87` — 分块 PUT 超时 300 秒；
`:86` — part_finish 持久重试上限 **10 分钟**。

**日额度错误是具名的：**

- `src/protocol/api/media-chunked.ts:43-53` — `UploadDailyLimitExceededError`
  （带 `filePath`、`fileSize`）
- `:246-248` — 当 `bizCode === UPLOAD_PREPARE_FALLBACK_CODE` 时抛出
- `src/protocol/api/retry.ts:157` — **`UPLOAD_PREPARE_FALLBACK_CODE = 40093002`**
- `USAGE.md:535-549` — §13.2 专门讲了怎么 catch 它并降级
- `src/index.ts:175` — 根入口导出 `UploadDailyLimitExceededError`（离线实测：**有**）

**插件现状（不需要改，但要补 catch）：**

- `lib/runtime.js:2246-2269` — `#sendFile` 用 `{ localPath: path }` 调
  `bot.sendImage/sendVideo/sendFile` → **`localPath` 正是会触发自动分块的来源** ✅
- `lib/runtime.js:2141-2144` — 文件发送失败被 catch 并入队：
  ```js
  } catch (error) {
    await this.#queuePending(conversationId, { path })
    queued.push(`文件已排队（${describeError(error)}）`)
  }
  ```
- **离线 grep 结论：`lib/` 里没有任何地方提到 `UploadDailyLimitExceededError`。**
  命中的唯一一处是 `lib/media.js:30` 的一句**注释**（讲入站下载上限，与上传无关）。

### 7.1 能力边界

| 项 | 情况 |
|---|---|
| 自动分流 | 是（`localPath` / `buffer`，≥5 MiB） |
| `url` / `fileData` | **不分块**（`url` 服务端拉取；`fileData` 直传且受 20 MiB 检查） |
| 分块上限 | 100 MiB（但 FILE/VIDEO 类型上限也是 100 MiB） |
| 日额度 | `upload_prepare` 有日额度，命中抛 `40093002` |
| 重试 | SDK 内置（`USAGE.md:551-558`），**调用方不要再包一层 retry** |
| 入站下载上限 | 插件自己定的 40 MiB（`lib/media.js:31`），与上传上限无关 |

### 7.2 对本插件的意义

**用户可见效果：现在就能发 5 MiB – 100 MiB 的文件**（长回复的 `.md` 附件、
项目产物、截图、日志打包）。**这部分已经可用，无需改动。**

**真正能改善用户体验的是错误处理**：目前若日额度耗尽，
用户看到的是 `文件已排队（UploadDailyLimitExceededError: ...）` ——
**一个英文类名的堆栈**，而且**这条会被无限重试**（每次补发都撞同一堵墙）。

补上 catch 后可以做到：**明确告诉用户"今天的文件上传额度用完了，明天再试 / 改用链接"**。

### 7.3 实现代价

| 文件 | 改动 | 规模 |
|---|---|---|
| `lib/runtime.js` | `#sendFile`（`:2246-2269`）或 `#deliverOrQueue`（`:2141-2144`）catch 里识别 `UploadDailyLimitExceededError`，换成一句人话 + **不要入队**（入队也没用） | ~20-30 行 |
| `lib/runtime.js` | 从根入口 import 该类（`@tencent-connect/qqbot-nodejs`） | 1 行 |

**要不要动客户端：不要。** **~30 行，零新依赖。**
**这是全部候选里代价最小、确定性最高的一项。**

### 7.4 什么情况下会静默失败

| 失败方式 | 表现 |
|---|---|
| 额度耗尽 | 目前表现为"排队"，**用户永远等不到**（每次补发都失败）——**这是现存缺陷** |
| 用 `url` 发大文件 | 不分块 → 可能超 `MAX_UPLOAD_SIZE` 被拒（`media.ts:105-110` 有前置检查并抛错，不是静默） |
| 超 100 MiB | 被拒，错误码未知 |
| 上传中途 timeout | SDK 内部有重试；超时后抛错 → 走排队 |

---

## 8. 候选 8：其它发现（C2C 私聊真正可用、而微信做不到的）

### 8.1 已经在用、不必再动的（列出以免重复投入）

| 能力 | 微信 iLink | QQ | 插件现状 | 依据 |
|---|---|---|---|---|
| **输入中提示** | ✗ | ✓ C2C only | **已用** | `src/QQBot.ts:799-810`；`messages.ts:130-152`（`msg_type: 6` + `input_notify`）；`USAGE.md:309-315`。插件：`lib/runtime.js:1522-1550` |
| **入站语音免解码** | 需自行 SILK→WAV | ✓ 服务端给 `voice_wav_url` | **已用** | `types.ts:231`；插件 `lib/media.js:84-91` |
| **入站语音转写** | 需额外请求 | ✓ `asr_refer_text` 随消息来 | **已用** | `types.ts:232`；插件 `lib/media.js:173-174` |
| **引用消息解析** | ✗ | ✓ `ref_msg_idx` + `msg_elements` | **已用** | `event-dispatcher.ts:108-148`；插件 `lib/prompt.js:41-56` |
| **大文件自动分块** | ✗ | ✓ | **已用** | 见第 7 节 |
| **C2C 流式原地改写** | ✗ | ✓ 仅 C2C | **已调研、用户已取消** | `USAGE.md:436-438`；`src/streaming.ts:4-7`；STEP3 文档 60-62 |
| **指令按钮（`action.type: 2`）** | ✗ | ✓ 仅 `msg_type=2` 下渲染 | **已调研、整批回退** | STEP3 文档 15-31 |

**这些不是"新候选"，是实现时必须避开的重复劳动。**

### 8.2 新发现：值得纳入候选的补充项

#### 8.2.1 跨进程恢复 session（`sessionPersistence`）—— 推荐纳入

**微信做不到**：iLink 是自建长轮询，没有"会话恢复"这个概念。
**QQ 有**：Gateway 的 `RESUME` 协议（`src/protocol/gateway/gateway-connection.ts:300-324`）。

- `src/QQBot.ts:144-145` — `sessionPersistence?: SessionPersistencePort`
- `src/QQBot.ts:517` — 传给 `GatewayConnection`
- `src/protocol/gateway/gateway-connection.ts:21-31` — `PersistedSession { sessionId, lastSeq }`
- `:97-116` — `restoreSession()` / `saveCurrentSession()`
- `:302-312` — 有 sessionId + lastSeq 时发 `RESUME`，否则 `IDENTIFY`
- `USAGE.md:562-585` — §14.1 给了完整示例
- `USAGE.md:585` — *"进程重启后，SDK 会优先尝试 **RESUME**，避免 IDENTIFY 重新计算 intents。"*
- **SDK 甚至自带存储实现**：`src/index.ts:120-130` 导出 `MemoryKVStore`、`FileKVStore`、
  `kvSessionPersistence`
- **插件现状：完全没用**（离线 grep：`lib/` 里 `sessionPersistence` 零命中）

**用户可见效果**：DSH 重启（升级、崩溃、手动重启）后，机器人**更快**回到可用状态，
并且**少丢消息**。这是"减少一次静默失效"的改动，而非新按钮。

**实现代价**：`lib/runtime.js` 构造处（`:698-721`）加一个 `sessionPersistence`
（用 SDK 自带的 `kvSessionPersistence` + `FileKVStore`），文件路径走既有的
`resolvePaths`（`lib/paths.js`）。**~30-40 行，不动客户端。**

**风险**：session 文件损坏 → 需降级为全新 IDENTIFY（SDK 的 `load()` 抛错要自己兜住）。
**注意**：`USAGE.md:723-724` 明确推荐 *"长期运行的服务务必使用 `sessionPersistence`"* ——
本插件正是长期运行的服务。

#### 8.2.2 `bot.api` 逃生舱 —— 实现工具，不是用户功能

- `src/QQBot.ts:847-885` — `bot.api.get/post/put/patch/delete/getToken`，
  自动注入 token（`apiRequest`，`:866-885`）
- JSDoc 给的例子是频道相关（`/users/@me/guilds`、`/guilds/{id}/announces`），
  **对本插件的 C2C 私聊场景没有直接价值**
- **但它对探针有价值**：可以在不写新方法的情况下直接打任意端点。
  第 10 节的 P6/P7 就可以用它做对照实验。

#### 8.2.3 Webhook 传输 + Ed25519 验签 —— 与本插件无关

- `src/protocol/transport/webhook.ts`、`webhook-verify.ts`（导出 `verifyWebhookSignature`、
  `signValidationResponse`、`ed25519Sign`，见 `src/protocol/index.ts:225-238`）
- `USAGE.md:456-464`、`README.md:46-60`
- 价值是"Serverless 部署"，而本插件是桌面端常驻。**并且切到 webhook 会丢掉
  `rawEvent`**（见第 5 节，`QQBot.ts:563-579` 未接线 `onRawEvent`）。**不建议。**

#### 8.2.4 SDK 内置中间件 —— 大部分与插件自研功能重叠

`README.md:82-97` 列了 12 个中间件。其中与本插件**已有能力重叠**的：
`messageFilter`（回声过滤/去重）、`rateLimiter`、`concurrencyGuard`、`accessPolicy`、
`contentSanitizer`、`mentionGate`、`quoteRef`、`historyBuffer`、`envelopeFormatter`、
`typingIndicator`、`slashCommand`。
**唯一值得单独考虑的是 `concurrencyGuard`**：`README.md:89` 注明它的用途是
*"同用户/群串行处理（**防 stream 并发冲突**）"*。若将来启用流式，它是必需的前置件。
**当前不做流式 → 不纳入。**

#### 8.2.5 QQ 专属 markdown 尺寸图片语法 —— 依附于候选 1

`src/protocol/utils/image-size.ts:216-231`：`formatQQBotMarkdownImage(url, size)` 产出
`![#120px #120px](url)`。**只在 markdown 权限成立时才有意义**，所以不单列候选，
但在做候选 1 时应一并验证（探针 P1 已含）。

---

## 9. 排序表：用户价值 ÷ 实现代价

**代价口径**：代码行数 + 新依赖 + 是否动客户端 + **平台侧前提是否可自助满足**。
"确定性"单列一栏，因为本项目的两次事故（POSTMORTEM 005/006）都不是"难度"问题，
而是"**以为验过了**"的问题。

| 排名 | 候选 | 用户价值 | 实现代价 | 前提确定性 | 比值 | 结论 |
|:---:|---|---|---|---|---|---|
| **1** | **候选 1 · Markdown**（逐条显式，不翻全局开关） | **极高**——直接决定"答案在手机上好不好读"，是本插件存在的意义 | 中（~130-160 行，动客户端，零新依赖） | 中（**取决于 markdown 权限**，一次探针可判定） | **最高** | **✅ 推荐先做（先过 P1）** |
| **2** | **候选 7 · 分块上传的错误处理** | 中（修掉"配额耗尽被无限排队"的现存缺陷） | **极低**（~30 行，不动客户端，零新依赖） | **极高**（纯本地错误分类，错误码 `40093002` 已确证） | **极高** | **✅ 可与候选 1 并行，先落地** |
| **3** | **候选 6 · `is_wakeup`** | 高（唯一直接命中"通知被排队"这个最大痛点） | **极低**（~25 行，不动客户端，零新依赖） | **低**（语义有"召回 vs 撤回"歧义 + 无配额数字） | 高（但被不确定性拖累） | ✅ 先探针 P10，再决定 |
| **4** | **候选 8.2.1 · sessionPersistence** | 中低（更快恢复、少丢消息，用户不一定察觉） | 低（~30-40 行，不动客户端；SDK 自带存储实现） | 高（官方文档明确推荐） | 中高 | ✅ 顺手做 |
| **5** | **候选 2 · 撤回** | 中（纠错；**但做不了实时状态**——被 4 次/小时配额卡死） | 中（~110 行，最小版本不动客户端） | 低（时限/权限/频率全未知） | 中 | ⚠️ 探针 P3/P4 后再定；**先降低预期** |
| **6** | **候选 4 · ARK / Embed** | 潜在高，**当前无法规划** | **无法估算**（依赖三个"查不到"） | **极低**（`embed` 连类型都没有；ARK 需平台侧模板） | 低 | ⛔ 只做探针 P6/P7，不立项 |
| **7** | **候选 3 · 语音** | 高（"念出来"是质变） | **最高**（~180-250 行 + `silk-wasm` 依赖 + **必须自带 TTS** + 动客户端） | 中（代码路径清楚，但 TTS 是全新故障面） | 低 | ⛔ 暂缓（除非你已确定 TTS 方案） |
| **8** | **候选 5 · 表情回应** | **对本插件为零**（只做私聊） | 0 或 ~150 行起 | **极低**（无 intent、无类型、无分发、无文档） | **最低** | ❌ **建议关闭** |

### ★ 推荐先做哪一个：候选 1（Markdown），但用"逐条显式"而不是翻全局开关

**理由（三条，按重要性）：**

1. **它是唯一直接改善"核心用途"的能力。** 本插件的存在理由是"在手机上看 agent 的输出"，
   而 agent 的输出**天生是 markdown**。现在这些结构全部退化成字符，
   长一点的回答还要变成 `.md` 附件（`lib/reply-limit.js:25-35`）。
   其余候选都是"加一个功能"，只有它是"**让已有功能终于能用对**"。

2. **它有一条零全局风险的实现路径，这一点已经被 SDK 自己确认。**
   `src/QQBot.ts:667-673` 的官方注释明确说明 `send()` 是显式模式、
   你自己控制 `msg_type`。所以**不必翻 `markdownSupport`**，从而避开它的三个副作用
   （所有 `sendText` 变异 / 主动推送一起变异 / 丢掉 `message_reference`，
   `messages.ts:324-326, 331-333, 340-342`）。

3. **它的唯一不确定性可以用一次探针消掉，且失败代价可控。**
   前提只有"机器人有没有 markdown 权限"。假设用逐条显式路径：
   - 有权限 → 富文本生效。
   - 无权限 → **只有开了开关的那条路径失败**，纯文本路径完全不受影响，
     可以立即回退（这也是"不翻全局开关"的第二个理由）。

**并且建议同时落地排名第 2 的候选 7 错误处理**：它只有 30 行、零平台前提、
零回归风险，且修掉一个确证的现存缺陷（额度耗尽被无限排队）。
**这两项加起来约 190 行，风险几乎全在候选 1 的权限探针上。**

**明确不建议现在做**：候选 5（建议关闭）、候选 3（TTS 是全新故障面）、
候选 4（连类型都没有）。

---

## 10. 探针清单：我没能确认的东西

### 10.0 先说清楚"没能确认"的边界

**我能从离线证据确认的**：类型、导出面、代码路径、常量、文档原文、依赖是否装上。
**我不能确认的**：任何需要 QQ 服务端参与的行为。

**为什么必须走这一步**：本项目已经有过两次"未实测就实现 → 静默失效"
（`docs/POSTMORTEM.md` 005 *忘了 import 一个常量，导致所有带附件的消息被整条丢弃*；
006 *工具名与微信插件撞车，QQ 的自然语言会话控制从未生效过*）。
**这两次的共同点：代码在类型层面完全成立，失败在任何日志里都不出现。**

已就绪的探针脚本：

| 脚本 | 需要凭据 | 状态 |
|---|:---:|---|
| `smoke/step4-surface.mjs` | 否 | **已跑过**，产物是本文多条结论的依据 |
| `smoke/step4-probe.mjs` | **是** | **已写好，未运行**（我没有凭据，也不应替你联网） |

**运行方式**：

```
node smoke/step4-surface.mjs                  # 随时可跑，离线
node smoke/step4-probe.mjs                    # 需要凭据 + 手机，跑完请交回 smoke/step4-probe.log
```

### 10.1 探针项与会话参与方式

| # | 待确认 | 怎么验 | **需要你做什么** | 阻塞了哪个候选 |
|:---:|---|---|---|---|
| **P1** | **机器人有没有 markdown 权限** | 跑 step4-probe 的 P1：发 6 条显式 `sendMarkdown`，看是否报 `40034090` | 手机上确认这 6 条是否显示；若有错误码请回报 | **候选 1 的生死线** |
| **P2** | markdown 在 **C2C** 的渲染范围：标题/粗体/斜体/下划线/无序列表/有序列表/引用/分隔线/链接/行内代码/代码块/**表格** | 同 P1（一步到位，6 条消息覆盖全部语法） | **逐条描述手机上看到什么**；特别关注：表格是否变成一行竖线、代码块有没有背景框、下划线是否被吃（复核 STEP3） | 候选 1 |
| **P3** | 全局 `markdownSupport: true` 的副作用 | **必须另起一个 QQBot 实例**（构造期选项，不能在本进程里改）。见 step4-probe 的 P2 说明 | 用 `QQBOT_MARKDOWN=1` 或另写一个脚本；回报三点：普通文本里的 `_ * [ ]` 是否照原样显示 / 有无 `40034090` / **主动推送是否也变成 markdown** | 候选 1（决定"要不要有一天翻全局开关"） |
| **P4** | **撤回的时限与权限**：立即撤 / 60 秒后撤 / 撤别人的 / 撤假 id | step4-probe 的 P3（脚本自动做，含 60 秒等待） | --（脚本自动）；**手机上回报哪几条真的消失了** | 候选 2 |
| **P5** | **撤回是否受频率限制**，以及"被动回复 4 次/小时"是否真是平台规则 | step4-probe 的 P4：对**同一个 msgId** 连发 6 条被动回复 | --（脚本自动，看日志里第几条开始报错） | **候选 2 的核心**（决定"撤回+重发"能否做实时状态） |
| **P6** | **ARK 在 C2C 能否用** | step4-probe 的 P6：`send({msgType: ARK, ark:{template_id:0, kv:[]}})` | 回报错误码。**"模板不存在"与"不支持该消息类型"含义完全不同**——前者说明要申请模板，后者说明 C2C 根本不接受 | 候选 4 |
| **P7** | **Embed 在 C2C 能否用**（`embed` 甚至没有类型） | step4-probe 的 P6/P7（含不显式传 `msgType` 的自动推断变体） | 同上 | 候选 4 |
| **P8** | **语音的时长上限与渲染** | step4-probe 的 P8（需先装 `silk-wasm`；设 `PROBE_VOICE_PATH=<.wav 绝对路径>`） | ① 先跑 `step4-surface.mjs` 确认依赖；② 装 `silk-wasm`；③ 准备一个 `.wav`；④ 回报是否显示为语音气泡、多长会被拒 | 候选 3 |
| **P9** | ★ **私聊里会不会推 `MESSAGE_REACTION_ADD`** | step4-probe 已在监听 `rawEvent` 并记录首次出现的每个类型 | **对我方任意一条消息加一个表情回应**，然后看日志有没有 `rawEvent: MESSAGE_REACTION_ADD`。**如果私聊里永远不来 → 该候选对本插件即为不可用，就此关闭** | **候选 5 的唯一判据** |
| **P10** | **`is_wakeup` 的语义**：它到底是"召回"还是别的？配额多少？是否与主动消息共享额度？ | step4-probe 的 P10：`sendWakeup(...)`；另测**传带 `msgId` 的 target** 的变体 | **在手机上判断这条消息看起来像什么**（普通消息？特殊样式？）；以及它是否成功送达 | 候选 6 |
| **P11** | **主动推送的真实配额** | 无法在单轮探针里测（要连续多小时）。step4-probe 只能记录失败时刻的错误码 | 若你在日常使用中遇到"排队"，把当时的日志交回 | 候选 6、以及 `#queuePending` 的整体策略 |
| **P12** | 大文件分块 + `UploadDailyLimitExceededError` 的真实错误码 | step4-probe 的 P9（设 `PROBE_BIG_FILE=<≥6MiB 绝对路径>`） | 准备一个 ≥6 MiB 的文件；回报是否抛出 `UploadDailyLimitExceededError` 且 `bizCode === 40093002` | 候选 7（**优先级低：即使不验，错误分类的改动也是安全的**） |
| **P13** | `stream_messages` 在 `markdownSupport: false` 时是否仍可用（`streaming.ts:183` 硬编码 markdown） | 未写入探针（用户已取消流式） | 仅当你将来重新考虑流式时再验 | 无（存档） |

### 10.2 我**完全没能确认**、也无法用探针解决的

| 项 | 为什么解决不了 |
|---|---|
| ARK / Embed 的**字段语义**（`kv` 各项含义、`obj` 是什么、`embed` 的完整形状） | 只能从 QQ 开放平台官方文档（站外）或平台控制台获得。**本包内没有任何资料。** |
| `bot.api` 能在 C2C 上打的**其它有用端点** | 平台端点清单不在本包内 |
| 主动消息的**配额数字** | 本包内只有被动侧的数字（4/小时）。`USAGE.md:323` 把读者指向站外文档 |
| 语音的**时长上限** | 本包只给了 20 MB 的体积上限 |
| 表情回应事件在 C2C 的**存在性** | 若平台根本不推，探针也只能证明"没看到"，无法区分"平台不推"与"intent 不对"——因为 `INTENTS` 没导出，**无法单独开 intent 做对照** |

### 10.3 建议的执行顺序

1. **先跑 `node smoke/step4-surface.mjs`**（离线，1 秒）——确认环境没变。
2. **跑 `node smoke/step4-probe.mjs`，把 `smoke/step4-probe.log` 交回。**
   重点是 **P1/P2（markdown）** 与 **P9（反应）** 这两项：
   前者决定**推荐项能不能做**，后者决定**一个候选能不能关闭**。
3. 拿到日志后，才估算候选 1 的具体实现，并按第 9 节顺序落地。

**在 P1 给出"有权限"之前，不要开始写候选 1 的代码**——
这正是 005/006 两次事故的教训。

---

## 附录 A：本文引用的关键行号索引

包根：`dsh-qq/node_modules/@tencent-connect/qqbot-nodejs/`

| 主题 | 位置 |
|---|---|
| `MsgType` 定义 | `src/QQBot.ts:60-72`；`dist/QQBot.d.ts:37-49` |
| `markdownSupport` 选项 | `src/QQBot.ts:134-135`；`dist/QQBot.d.ts:125-126` |
| `ark` / `embed` 字段形状 | `src/QQBot.ts:84-87`；`dist/QQBot.d.ts:67-77` |
| `extra` 透传字段 | `src/QQBot.ts:94-95` |
| `send()` 显式模式（官方注释） | `src/QQBot.ts:619-673` |
| `sendMarkdown` | `src/QQBot.ts:716-727`；`dist/QQBot.d.ts:346-356` |
| `recallMessage` | `src/QQBot.ts:729-740`；`dist/QQBot.d.ts:360-368` |
| `sendWakeup` | `src/QQBot.ts:742-759`；`dist/QQBot.d.ts:370-381` |
| `sendTyping`（C2C only） | `src/QQBot.ts:799-810` |
| `bot.api` 逃生舱 | `src/QQBot.ts:847-885` |
| `openStream`（C2C only，需 msgId） | `src/QQBot.ts:889-915` |
| `uploadMedia` 自动分块分流 | `src/QQBot.ts:924-990`（分流在 `:947-948`，判据在 `:955`） |
| `computeSourceSize`（`url` → null） | `src/QQBot.ts:1099-1122` |
| `rawEvent` 只在 websocket 接线 | `src/QQBot.ts:538-541`（有）vs `:563-579`（webhook **无**） |
| **`buildMessageBody`（markdownSupport 副作用 + 丢 message_reference）** | `src/protocol/api/messages.ts:317-338`（丢在 `:331-333`） |
| `buildProactiveBody`（主动推送同样变异） | `src/protocol/api/messages.ts:340-342` |
| `sendRaw` 的 msg_seq/msg_type 推断 | `src/protocol/api/messages.ts:210-245` |
| `recallMessage` 实现（DELETE） | `src/protocol/api/messages.ts:282-294` |
| `sendInputNotify`（msg_type 6） | `src/protocol/api/messages.ts:130-152` |
| 路径模板（c2c/group/channel/dm/stream） | `src/protocol/api/routes.ts:9-51` |
| `MessageResponse` 形状 | `src/protocol/types.ts:70-77` |
| `MediaFileType` | `src/protocol/types.ts:82-87` |
| `OutboundMeta.ttsText`（TTS 的唯一痕迹） | `src/protocol/types.ts:98-104` |
| 入站附件 `voice_wav_url` / `asr_refer_text` | `src/protocol/types.ts:227-233` |
| 被动回复配额与缺省值（**含 4 次/小时**） | `src/protocol/utils/reply-limiter.ts:5, 42-43` |
| `TEXT_CHUNK_LIMIT = 5000` | `src/protocol/utils/text-chunk.ts:11` |
| 上传常量与类型上限 | `src/protocol/utils/file-utils.ts:13, 16, 19, 22-27` |
| `UPLOAD_PREPARE_FALLBACK_CODE = 40093002` | `src/protocol/api/retry.ts:157` |
| `UploadDailyLimitExceededError` | `src/protocol/api/media-chunked.ts:43-53`（抛出在 `:246-248`） |
| 分块上传流程与并发/超时 | `src/protocol/api/media-chunked.ts:84-87, 105-219` |
| 小文件上传（base64 直传，**无转码**） | `src/protocol/api/media.ts:70-161`（`:96-102`，`:105-110`） |
| 语音转码工具（**孤儿函数**） | `src/protocol/utils/audio.ts:238-340`（直传表 `:222`，返回 null `:333-339`，`pcmToSilk` 抛错 `:431-434`） |
| ffmpeg / silk-wasm 探测 | `src/protocol/utils/ffmpeg.ts:37-92, 109-131` |
| QQ markdown 尺寸图片语法 | `src/protocol/utils/image-size.ts:216-231` |
| `INTENTS` 表（**未导出**，无反应位） | `src/protocol/gateway/constants.ts:8-16` |
| `FULL_INTENTS` 组成 | `src/protocol/gateway/constants.ts:18-24` |
| `GatewayEvent`（含两个反应常量） | `src/protocol/gateway/constants.ts:59-92`（反应在 `:89-91`） |
| 分发兜底 → `raw` | `src/protocol/gateway/event-dispatcher.ts:267-274` |
| `RESUME` vs `IDENTIFY` | `src/protocol/gateway/gateway-connection.ts:97-116, 300-324` |
| `stream_messages` 硬编码 markdown | `src/streaming.ts:183`（节流常量 `:23-24`） |
| 根入口导出面 | `src/index.ts:1-175` |
| `/protocol` 导出面（语音工具在此） | `src/protocol/index.ts:166-181` |
| optional peerDeps | `qqbot-nodejs/package.json`（`peerDependenciesMeta`） |
| markdown 权限告警 | `USAGE.md:197-198, 717` |
| 主动 push 额度 | `USAGE.md:141-146, 317-323, 716` |
| 媒体上限表 | `USAGE.md:358-367` |
| 分块上传说明 | `USAGE.md:346-356, 400` |
| 流式（仅 C2C、5 分钟窗口、300ms 下限） | `USAGE.md:436-475` |
| 交互事件与 ACK | `USAGE.md:481-504` |
| `UploadDailyLimitExceededError` 用法 | `USAGE.md:535-549` |
| sessionPersistence | `USAGE.md:562-585`（推荐在 `:723-724`） |
| 协议层导出清单（含 `MAX_UPLOAD_SIZE` 等） | `USAGE.md:630-665` |
| 平台硬性限制汇总 | `USAGE.md:710-720` |
| `handleInboundMessage` / 独立 Bot 实例 | `src/QQBot.ts:587-615`；`USAGE.md:587-597` |
| 插件：QQBot 构造（**未设 markdownSupport**） | `lib/runtime.js:698-721` |
| 插件：`#send` 被动→主动降级 | `lib/runtime.js:1444-1476` |
| 插件：`#targetFor`（用 `ReplyLimiter`） | `lib/runtime.js:1488-1508` |
| 插件：typing（已用 `sendTyping`） | `lib/runtime.js:1522-1550` |
| 插件：`#deliverOrQueue`（失败入队） | `lib/runtime.js:2126-2167` |
| 插件：`#sendFile`（走 localPath，自动分块） | `lib/runtime.js:2246-2269` |
| 插件：`rawEvent` 仅观测 | `lib/runtime.js:727-729` |
| 插件：入站媒体（用 `voice_wav_url`/`asr_refer_text`） | `lib/media.js:84-91, 173-174` |
| 插件：长回复降级 | `lib/reply-limit.js:25-35` |
| 插件：设置项模式 | `lib/runtime.js:486-487, 553-554, 621-622`；`lib/state.js:102-103`；`client.js:224-225, 329-330, 1426-1433` |

## 附录 B：本步骤新增/未改动的文件

| 文件 | 动作 |
|---|---|
| `docs/STEP4-QQ独有能力候选.md` | **新增**（本文件） |
| `smoke/step4-surface.mjs` | **新增**（离线表面核对，**已运行**） |
| `smoke/step4-probe.mjs` | **新增**（联网行为探针，**未运行**） |
| `lib/**`、`index.js`、`client.js` | **未改动**（符合任务约束） |
