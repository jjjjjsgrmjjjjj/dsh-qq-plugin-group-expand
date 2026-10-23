# dsh-qq-plugin-group-expand

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
