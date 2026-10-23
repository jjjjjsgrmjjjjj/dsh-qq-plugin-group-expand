# dsh-qq-plugin-group-expand

<p align="center"><b>中文</b> ｜ <b>English</b> — 点下面的按钮切换语言 · click a button below to switch</p>

> GitHub README 不能运行 JavaScript；这里用可折叠按钮做语言切换。

<details open name="readme-lang">
<summary><b>🇨🇳 中文</b>（点击收起 / 展开）</summary>


把 QQ 变成 DeepSeek Harness（DSH）的远程入口，并在上游 `dsh-qq-plugin` 的基础上补上**群聊能力**。

本项目是基于 [`xcisxc29/dsh-qq-plugin`](https://github.com/xcisxc29/dsh-qq-plugin) 的扩展分支，不是从零重写。私聊遥控、扫码绑定、多会话、附件、审批、主动推送等能力来自上游；本仓库的增量集中在群聊、群聊礼仪、引用图片、表情包、权限默认值与 token 优化。

- 包名：`dsh-qq-plugin-group-expand`
- 当前版本：`1.2.0`
- 运行环境：DSH desktop `0.2.0-rc.2` 或更新版本
- QQ 侧：腾讯官方机器人，扫码创建；不使用个人号协议，不需要公网 IP

## 与上游的关系

| 项目 | 上游 `dsh-qq-plugin` | 本仓库 |
|---|---|---|
| 私聊遥控 | ✅ | ✅ 继承 |
| 扫码绑定 / 凭据服务 | ✅ | ✅ 继承 |
| 多会话与 `/new` `/list` `/switch` | ✅ | ✅ 继承 |
| 图片 / 文件 / 语音 | ✅ | ✅ 继承 |
| 权限审批回流 | ✅ | ✅ 继承 |
| `notify_qq` 主动推送 | ✅ | ✅ 继承 |
| 群聊收发 | ❌ | ✅ 新增 |
| 群聊人格门禁 / 5 分钟连续对话 | ❌ | ✅ 新增 |
| 群聊表情包收藏 | ❌ | ✅ 新增 |
| 引用消息中的图片 | 仅占位 | ✅ 下载后交本地路径 |
| 新会话默认只读 | 可配置 | ✅ 默认锁定只读 |
| 渠道说明 token 优化 | 每条重复 | ✅ 每个新会话只发一次 |

上游的完整用户手册、设置项和设计说明仍然适用，见 [`docs/HANDBOOK-USER.md`](docs/HANDBOOK-USER.md)。本 README 只写清“这个分支是什么、比上游多了什么、怎么装、边界在哪”。

## 功能概览

### 私聊

- 手机 QQ 扫码绑定官方机器人，之后一直有效；
- 一个 QQ 对话可对应多个 DSH 会话，支持 `/new`、`/list`、`/switch`、`/current`、`/cancel`、`/help`；
- 文字、图片、文件、语音双向；语音优先使用 QQ 服务端 ASR 转写；
- agent 的权限提示、二选一/多选提问可以回到 QQ，用「允许 / 拒绝」或数字回答；
- 任意 DSH 会话都能通过 `notify_qq` 主动推送；
- 回复过长时转成 `.md` 文件发送，不截断。

### 群聊（本分支重点）

群聊和私聊的礼貌规则不同。本分支默认只在以下情况发言：

| 条件 | 行为 |
|---|---|
| 被 @ | 立即交给 agent，正常回答 |
| 被 @ 后 5 分钟内 | 每条**文字**消息都交给 agent，由模型判断是否回应 |
| 正文提到人格名或接话关键词 | 本地短句 + 表情包接一句，不调用模型 |
| 其他 | 不发言 |

被 @ 后会开启一个 5 分钟的连续对话窗口。窗口内**不按关键词过滤**：消息会原样交给 agent，并在提示词里附上最近 8 条群消息（发送者 + 正文，单条截断 120 字），由模型判断这条是不是在跟它说话。

如果无关，agent 输出 `[[NO_REPLY]]`，插件把整条回复丢弃，群里一个字都不发。流式分片被拆成 `[[NO_` / `[[NO_RE` 时也按静默处理，避免群里冒出一行半截标记。

窗口不滑动：只有新的 @ 会续期，闲聊不会无限延长。

### 表情包

不生成表情包，只用两种来源：

- 群里像表情包的方形小图，收到时静默下载到 `~/.dsh/qq/stickers/collected/`；
- 用户自己导入到 `~/.dsh/qq/stickers/` 根目录的 `png/jpg/gif/webp`。

收藏判定：最长边 ≤ 1024、宽高比 0.45–2.2、文件 ≤ 2 MiB、SHA-256 去重、最多 300 张；索引写 `index.json`。手机照片和截图会被排除。发送失败或目录为空时退到 emoji，不影响文字回复。

### 引用图片

QQ 把被引消息的图片放在 `msg_elements[<refMsgIdx>].attachments`。本分支会把引用附件下载到会话媒体目录，把**本地绝对路径**交给 agent，而不是只写一句“（引用了 image/png）”。

### 权限

新会话默认 `read-only`：

- `permissionPreset` 默认值改为 `read-only`；
- `newSessionsReadOnly` 默认开启，新建/采纳的会话会被强制施加只读，即使状态文件里存着旧的 `danger-full-access`；
- 已有会话的权限由 DSH 锁定，插件不会偷偷改。

要让某条新会话动手，需要先关闭只读锁，再选择「工作区可写」或「完全访问」。这是有意的摩擦：群里任何人都能触发它，默认不能写文件。

### Token 优化

`presenceNote`（渠道上下文说明）只在**每个新对话的第一条提示词**里发送一次。运行时先检查宿主会话里是否已有 user/assistant/tool/developer 消息，没有才拼进去；群聊的 `[群聊]` 上下文仍然每条都带。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile desktop add dsh-qq-plugin-group-expand
# 或
dsh plugin --profile web add dsh-qq-plugin-group-expand
```

也可以在 DSH 的「添加插件」里直接输入包名：

```
dsh-qq-plugin-group-expand
```

### 从 GitHub 安装

```
https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand
```

把 Git 地址粘进「添加插件」，或：

```bash
dsh plugin --profile web add https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand
```

### 从本地目录 / tarball

```bash
npm pack
# → dsh-qq-plugin-group-expand-1.2.0.tgz
```

把 `.tgz` 的绝对路径或放着 `package.json` 的目录粘进「添加插件」。

### 从旧插件迁移

1. 先在 DSH 里**停用并移除**原来的 `dsh-qq-plugin`，否则两个插件会抢同一个 QQ 通道和 `qqChannel` 服务；
2. 安装 `dsh-qq-plugin-group-expand`；
3. 凭据作用域沿用上游的 `dsh-qq-plugin`，已绑定过的 AppSecret 可以直接复用；
4. 状态文件仍是 `~/.dsh/qq/state.json`，会话映射、待发队列和设置会继续生效；
5. 启动后检查设置页的连接状态和 `boot.log`。

## 配置

设置项与上游一致，群聊新增字段主要在 `lib/settings.js`：

| 设置 | 默认 | 说明 |
|---|---|---|
| `groupChatEnabled` | `true` | 群聊总开关 |
| `groupPersonaNames` | `鲸鱼娘` | 群里认的人格名，逗号分隔 |
| `groupAutoSpeak` | `true` | 提到人格/关键词时自动接话 |
| `groupFollowUpWindowMs` | `300000` | 被 @ 后的连续对话窗口（5 分钟） |
| `groupContextWindowMs` | `120000` | 群历史语境窗口 |
| `groupAutoSpeakKeywords` | `鲸鱼娘,鱼鱼,胖鱼,在吗,哈哈,笑死,可爱,笨蛋` | 接话关键词 |
| `groupSpeakCooldownMs` | `20000` | 自动接话冷却 |
| `groupSpeakMaxPerHour` | `20` | 自动接话每小时上限 |
| `groupCollectStickers` | `true` | 收藏群里的表情包 |
| `groupStickerChance` | `70` | 接话时附带表情包的概率 |
| `groupStickerDir` | `<home>/qq/stickers` | 表情包目录 |
| `groupFullMessageMode` | 未启用 | 平台推送全量群消息时才有的分支，见「平台边界」 |
| `permissionPreset` | `read-only` | 新会话权限预设 |
| `newSessionsReadOnly` | `true` | 新会话强制只读锁 |

完整说明见 [`docs/HANDBOOK-USER.md`](docs/HANDBOOK-USER.md) 和设置页内置帮助。

## 实现要点

| 模块 | 职责 |
|---|---|
| `index.js` | 插件入口、服务注入、设置与生命周期 |
| `lib/runtime.js` | QQ 连接、入站消息、会话提交、助手流聚合、发送 |
| `lib/router.js` | 一个 QQ 对话对应哪个 DSH 会话，以及指令解析 |
| `lib/group.js` | 群聊门禁、人格判定、连续对话、`[[NO_REPLY]]` |
| `lib/stickers.js` | 表情包收藏、去重、上限、索引 |
| `lib/prompt.js` | 提示词合成、引用解析、引用附件提取 |
| `lib/media.js` | 图片/文件/语音落盘与描述 |
| `lib/state.js` | 原子写、串行化状态、对话键 |
| `lib/credentials.js` | 凭据服务适配（作用域沿用上游） |
| `client.js` | 设置页 UI |

几个关键决定：

1. **对话键带作用域**：私聊 `accountId:peerId`，群聊 `accountId:group:groupId`。绑定、被动目标、待发队列、附件停靠全部按这个键走。
2. **群被动回复复用最近 @ 的 `msg_id`**：QQ 群的被动回复只认最近一次 @ 的 `msg_id`（5 分钟有效）；用后续普通消息的 id 会被当成主动消息，未认证官方机器人没有群主动消息权限，会直接失败。插件为每个群保留 `#groupAt`，窗口内统一复用。
3. **引用图片先落盘**：QQ 附件 URL 会过期，收到消息时立刻下载，再给 agent 本地路径。
4. **渠道说明只发一次**：用宿主会话消息判断是否新会话，再用进程内 `#noteSent` 兜底。
5. **群历史在提示词里，不额外调模型**：最近 8 条、单条 120 字、最多 30 条在内存中。

## 测试

仓库自带三套离线自检，不依赖 DSH 宿主：

```bash
node scripts/verify.mjs
node scripts/verify-client.mjs
node scripts/verify-send-path.mjs
```

当前结果：**836** 项宿主侧检查、**113** 项客户端检查、**81** 项发送路径检查（**836** host checks, **113** client checks, **81** send-path checks）。

`verify-send-path.mjs` 使用假 SDK 真跑发送路径，覆盖：

- 私聊/群聊 target、scope、被动 `msg_id`；
- 被动失败后的主动降级与限流；
- 群聊最近 @ 的 `msg_id` 复用；
- 新会话强制只读；
- 渠道说明首条发送、后续不重复；
- 群聊窗口关闭后不再提交。

## 平台边界与安全

1. **官方机器人默认只能收到群里的 @ 消息**。腾讯的 `GROUP_AND_C2C_EVENT` 订阅包含 `GROUP_AT_MESSAGE_CREATE`；普通群消息 `GROUP_MESSAGE_CREATE` 需要平台侧的群消息全量权限。代码能处理该事件，但没有收到消息就没有内容可判断。
2. **未认证机器人**只能由管理员使用，群主动消息通常没有权限；被动回复必须带有效 `msg_id`。
3. **不使用个人号协议**，不共享个人 QQ 账号，也不依赖公网回调地址。
4. **群成员可以触发 agent**。默认只读锁是安全底线；不要在群里直接放开「完全访问」。
5. 群聊收藏的图片来自群成员上传，使用前应自行确认内容与版权。

## 已知限制

- 官方通道下，非 @ 的群消息默认不可见；需要平台权限，插件无法绕过。
- `sendTyping` 仅支持单聊，群聊里会记录一条非致命错误。
- 群历史在内存中，DSH 重启后从零开始。
- 表情包只支持图片，不支持群里的动态表情协议。

## 许可与致谢

MIT License。上游项目：[`xcisxc29/dsh-qq-plugin`](https://github.com/xcisxc29/dsh-qq-plugin)。本分支的群聊、表情包、引用图片、权限默认值与 token 优化在上面继续演进；问题请提到本仓库的 Issues。

</details>

<details name="readme-lang">
<summary><b>🇬🇧 English</b>（click to expand / collapse）</summary>

## Overview

A QQ channel for DeepSeek Harness (DSH), extending the upstream `dsh-qq-plugin` with **group-chat support**.

This project is a derivative of [`xcisxc29/dsh-qq-plugin`](https://github.com/xcisxc29/dsh-qq-plugin), not a rewrite. Direct-message remote control, QR binding, multiple sessions, attachments, approvals and proactive push come from upstream. The additions here are group chat, group etiquette, quoted images, stickers, safer permission defaults and token savings.

- Package: `dsh-qq-plugin-group-expand`
- Version: `1.2.0`
- Runtime: DSH desktop `0.2.0-rc.2` or newer
- QQ side: Tencent's official bot platform, created by QR scan; no personal-account protocol and no public IP

## Relationship to upstream

| Feature | Upstream `dsh-qq-plugin` | This repository |
|---|---|---|
| Direct-message remote control | ✅ | ✅ inherited |
| QR binding / credential service | ✅ | ✅ inherited |
| Multiple sessions and `/new` `/list` `/switch` | ✅ | ✅ inherited |
| Images / files / voice | ✅ | ✅ inherited |
| Permission approvals back to QQ | ✅ | ✅ inherited |
| `notify_qq` proactive push | ✅ | ✅ inherited |
| Group chat | ❌ | ✅ added |
| Group persona gate / 5-minute follow-up | ❌ | ✅ added |
| Group sticker collection | ❌ | ✅ added |
| Images inside quoted messages | placeholder only | ✅ downloaded and exposed as a local path |
| New sessions read-only by default | configurable | ✅ locked to read-only by default |
| Channel-note token usage | repeated on every message | ✅ sent once per new conversation |

The upstream user handbook, settings and design notes still apply: [`docs/HANDBOOK-USER.md`](docs/HANDBOOK-USER.md). This README only covers what the fork is, what it adds, how to install it and where the boundaries are.

## Features

### Direct messages

- Bind the official bot once by scanning a QR code from mobile QQ;
- One QQ conversation maps to multiple DSH sessions, with `/new`, `/list`, `/switch`, `/current`, `/cancel` and `/help`;
- Text, images, files and voice in both directions; voice prefers QQ's server-side ASR transcript;
- Permission prompts and single/multiple-choice questions come back to QQ; answer with “allow / deny” or a number;
- Any DSH session can push through `notify_qq`;
- Long replies are sent as a `.md` file rather than truncated.

### Group chat (the focus of this fork)

Groups have different etiquette from direct messages. By default this fork speaks only when:

| Condition | Behaviour |
|---|---|
| Mentioned with @ | Handed to the agent and answered immediately |
| Within 5 minutes after an @ | Every **text** message is handed to the agent, which decides whether to reply |
| Persona name or a conversation keyword appears | A short local line plus a sticker; no model call |
| Otherwise | Silent |

An @ opens a 5-minute continuous-conversation window. Inside the window there is **no keyword filter**: messages go to the agent as-is, together with the last 8 group messages (sender + text, each truncated to 120 characters), and the model decides whether the message is addressed to it.

If the message is unrelated, the agent outputs `[[NO_REPLY]]`; the plugin drops the whole reply and sends nothing to the group. A stream fragment split into `[[NO_` / `[[NO_RE` is also treated as silence, so a half marker never leaks into the group.

The window does not slide: only a new @ renews it; ordinary chatter cannot extend it forever.

### Stickers

No generated stickers. Two sources only:

- Square, sticker-like images posted in the group are downloaded silently into `~/.dsh/qq/stickers/collected/`;
- User-imported `png/jpg/gif/webp` files in the root of `~/.dsh/qq/stickers/`.

Collection checks: longest edge ≤ 1024, aspect ratio 0.45–2.2, file ≤ 2 MiB, SHA-256 deduplication, at most 300 images, with an `index.json`. Phone photos and screenshots are excluded. If sending fails or the directory is empty, the plugin falls back to emoji without breaking text replies.

### Quoted images

QQ puts the attachments of a quoted message in `msg_elements[<refMsgIdx>].attachments`. This fork downloads those attachments into the session media directory and gives the agent a **local absolute path**, instead of only saying “（引用了 image/png）”.

### Permissions

New sessions default to `read-only`:

- `permissionPreset` defaults to `read-only`;
- `newSessionsReadOnly` defaults to on: newly created or adopted sessions are forced to read-only even if the state file still contains an old `danger-full-access`;
- Existing sessions remain locked by DSH; the plugin never changes them silently.

To let a new session act, disable the read-only lock and pick “workspace-write” or “danger-full-access”. This friction is intentional: anyone in the group can trigger the agent, so it must not write files by default.

### Token optimization

`presenceNote` (the channel-context note) is sent only with the **first prompt of each new conversation**. The runtime checks whether the host session already contains user/assistant/tool/developer messages; only a blank session gets the note. Group `[群聊]` context is still attached to every group message.

## Install

### From npm (recommended)

```bash
dsh plugin --profile desktop add dsh-qq-plugin-group-expand
# or
dsh plugin --profile web add dsh-qq-plugin-group-expand
```

Or type the package name into DSH's “Add plugin” field:

```
dsh-qq-plugin-group-expand
```

### From GitHub

```
https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand
```

Paste the Git URL into “Add plugin”, or:

```bash
dsh plugin --profile web add https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand
```

### From a local checkout / tarball

```bash
npm pack
# → dsh-qq-plugin-group-expand-1.2.0.tgz
```

Paste the absolute path of the `.tgz`, or the directory containing `package.json`, into “Add plugin”.

### Migrating from the old plugin

1. Disable and remove the old `dsh-qq-plugin` first; otherwise both plugins compete for the same QQ channel and the `qqChannel` service;
2. Install `dsh-qq-plugin-group-expand`;
3. The credential scope remains upstream's `dsh-qq-plugin`, so an existing AppSecret can be reused;
4. The state file is still `~/.dsh/qq/state.json`; session mappings, the pending queue and settings carry over;
5. After startup, check the connection status in settings and `boot.log`.

## Configuration

Settings match upstream; the group-specific fields live in `lib/settings.js`:

| Setting | Default | Description |
|---|---|---|
| `groupChatEnabled` | `true` | Master switch for group chat |
| `groupPersonaNames` | `鲸鱼娘` | Persona names recognised in groups, comma-separated |
| `groupAutoSpeak` | `true` | Speak locally when the persona or a keyword appears |
| `groupFollowUpWindowMs` | `300000` | Continuous-conversation window after an @ (5 minutes) |
| `groupContextWindowMs` | `120000` | Context window for group history |
| `groupAutoSpeakKeywords` | `鲸鱼娘,鱼鱼,胖鱼,在吗,哈哈,笑死,可爱,笨蛋` | Conversation keywords |
| `groupSpeakCooldownMs` | `20000` | Cooldown for local auto-speak |
| `groupSpeakMaxPerHour` | `20` | Hourly cap for local auto-speak |
| `groupCollectStickers` | `true` | Collect group stickers |
| `groupStickerChance` | `70` | Chance of attaching a sticker to a local line |
| `groupStickerDir` | `<home>/qq/stickers` | Sticker directory |
| `groupFullMessageMode` | not enabled | Branch for platforms that deliver all group messages; see “Platform boundaries” |
| `permissionPreset` | `read-only` | Permission preset for new sessions |
| `newSessionsReadOnly` | `true` | Force new sessions to read-only |

See [`docs/HANDBOOK-USER.md`](docs/HANDBOOK-USER.md) and the built-in help in the settings page for the full list.

## Implementation

| Module | Responsibility |
|---|---|
| `index.js` | Plugin entry, service wiring, settings and lifecycle |
| `lib/runtime.js` | QQ connection, inbound messages, session prompts, assistant stream aggregation, sending |
| `lib/router.js` | Which DSH session a QQ conversation maps to, plus command parsing |
| `lib/group.js` | Group gate, persona detection, follow-up window, `[[NO_REPLY]]` |
| `lib/stickers.js` | Sticker collection, deduplication, limits and index |
| `lib/prompt.js` | Prompt composition, quote parsing, quoted-attachment extraction |
| `lib/media.js` | Media download and description |
| `lib/state.js` | Atomic, serialised state and conversation keys |
| `lib/credentials.js` | Credential-service adapter (upstream scope) |
| `client.js` | Settings-page UI |

Key decisions:

1. **Scoped conversation keys**: direct messages use `accountId:peerId`; groups use `accountId:group:groupId`. Bindings, passive targets, the pending queue and attachment parking all use this key.
2. **Group passive replies reuse the latest @ `msg_id`**: QQ group passive replies only accept the `msg_id` of the most recent @ (valid for 5 minutes). Using a later ordinary message's id makes the platform treat it as a proactive message, which an unverified official bot cannot send. The plugin keeps `#groupAt` per group and reuses it inside the window.
3. **Quoted images are downloaded first**: QQ attachment URLs expire, so the image is fetched on receipt and the agent receives a local path.
4. **Channel note is sent once**: host-session messages decide whether the session is new; an in-process `#noteSent` set is a fallback.
5. **Group history stays in the prompt, with no extra model call**: last 8 messages, 120 characters each, at most 30 entries in memory.

## Tests

Three offline suites run without a DSH host:

```bash
node scripts/verify.mjs
node scripts/verify-client.mjs
node scripts/verify-send-path.mjs
```

Current results: **836** host checks, **113** client checks, **81** send-path checks.

`verify-send-path.mjs` uses a fake SDK to exercise the real send path, covering:

- direct/group targets, scope and passive `msg_id`;
- passive-to-proactive fallback and rate limiting;
- reuse of the latest group @ `msg_id`;
- read-only enforcement for new sessions;
- channel note sent once and omitted afterwards;
- no further submission after the group window closes.

## Platform boundaries and security

1. **Official bots receive only group @ messages by default.** Tencent's `GROUP_AND_C2C_EVENT` subscription includes `GROUP_AT_MESSAGE_CREATE`; ordinary group messages (`GROUP_MESSAGE_CREATE`) require platform-side full-message permission. The code can handle that event, but if no message is delivered there is nothing to judge.
2. **Unverified bots** can only be used by their administrator; proactive group messages are generally not permitted, and passive replies require a valid `msg_id`.
3. **No personal-account protocol**, no shared personal QQ account, and no public callback URL.
4. **Group members can trigger the agent.** The read-only lock is the safety baseline; do not enable “full access” in a group casually.
5. Stickers collected from groups are uploaded by members; verify content and copyright before use.

## Known limitations

- With the official channel, non-@ group messages are invisible by default; this needs platform permission and cannot be bypassed by the plugin.
- `sendTyping` is supported only for direct messages; group use records a non-fatal error.
- Group history lives in memory and starts empty after a DSH restart.
- Stickers support images only, not QQ's animated-sticker protocol.

## License and credits

MIT License. Upstream: [`xcisxc29/dsh-qq-plugin`](https://github.com/xcisxc29/dsh-qq-plugin). Group chat, stickers, quoted images, permission defaults and token savings are developed on top of it in this fork; please file issues in this repository.

</details>
