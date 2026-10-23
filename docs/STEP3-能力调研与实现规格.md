# 第三步能力调研与实现规格

> # ⏸️ 状态：暂缓，**未实现**
>
> 这份文档记录的**调研结论是真的**（全部经真机验证），但**按钮功能已于 2026-10-10 按用户要求整批回退**，
> 当前代码里**没有任何按钮**。
>
> **为什么保留这份文档**：里面每一条实测结论都是花真机验证换来的——
> `markdownSupport` 默认 `false` 导致键盘不渲染、`action.type: 2` 会把 `data` 填进输入框、
> 5×5 可用、QQ 的 markdown **不吃下划线**、超长标签 QQ 自己截断。
> 这些与"要不要做按钮"无关，将来做任何 QQ 交互功能都用得上。
>
> ⚠️ **不要**把这份文档当成"已实现的设计"来读。第四节是**当时的设计意图**，不是现状。

> ## ⚠️ 实测结论（2026-10-10，真机验证过，**优先于下面的一切推断**）
>
> ### 1. 键盘只在 `msg_type=2`（markdown）下渲染
>
> `QQBotOptions.markdownSupport` **默认 `false`**（`QQBot.d.ts`：*"Whether the bot has
> markdown permission. Defaults to false."*），于是 `sendText` 发 `msg_type=0`，
> **纯文本不渲染键盘**——`sendTextWithKeyboard` 因此无效。
>
> 真机结果：走 `sendTextWithKeyboard` 的 ①③④ **全都没有按钮**；只有显式
> `sendMarkdown(target, text, { keyboard })` 的 ② 有按钮。
>
> **结论：凡是带按钮的消息，一律用 `sendMarkdown`。**
> 不选"全局开 `markdownSupport`"，因为我方消息里**天然含下划线**
> （`qq_session_control`、`dsh_qq`、`pendingInteractions`），markdown 会把它当斜体标记
> 吃掉，渲染成 `qq<em>session</em>control`——看起来像工具名坏了。
> 只让按钮消息走 markdown，且那些消息的内容由我们控制，风险最小。
>
> ### 2. 5×5（25 个按钮）与超长标签**都可行**
>
> 真机确认 ②③④ 完全可行。行列上限与 label 长度的具体边界未逐一测，但正常用量绰绰有余。
>
> ### 3. ★ 按钮用 `action.type: 2`（指令按钮），**不触发回调**
>
> 真机行为：**点击后把 `action.data` 填进输入框**，用户再按发送。
> 它不是 `INTERACTION_CREATE` 回调。
>
> **这是本步骤最重要的设计决定，因为它把四个功能都简化了：**
>
> | | 回调按钮（`type:1`） | **指令按钮（`type:2`）← 采用** |
> |---|---|---|
> | 处理 `INTERACTION_CREATE` | 要 | **不用** |
> | 5 秒内 ACK（`acknowledgeInteraction`） | 必须 | **不用** |
> | 误点后果 | **直接执行** | **只填进输入框，用户还能改** |
> | 复用现有解析 | 要新增入口 | **完全复用**：它就是"用户打了这几个字" |
> | 重放 / nonce | 要防 | **不用防**（每次都要用户亲手发送） |
>
> **按钮退化成"输入的快捷方式"。** 审批的「允许」「拒绝」、选项的「1」、
> 切换的「/switch 2」——全部走**已有的**解析路径
> （`#settleInteraction` / `parseApprovalReply` / `parseQuestionReply` / `SessionRouter`），
> **一行新的解析逻辑都不用写**。
>
> 因此 `action.data` 必须**就是用户本该输入的那串文本**，
> 而 `render_data.label` 与它保持一致（否则用户看到的按钮和填进去的内容对不上，
> 那比没有按钮更让人困惑）。
>
> ### 4. ❌ 流式输出**不做**（用户明确取消）
>
> `openStream` 的调研结论保留在下面供日后参考，但**本步骤不实现**。
>
> ### 5. SDK 会吞掉 handler 里的异常
>
> `USAGE.md:265`：*"handler 抛错会被 SDK 捕获并打到 `logger.error`，不会传播为
> unhandled rejection。"*
>
> **探针与插件都必须传 `logger`**，否则 handler 出错时日志里**一片空白**——
> 我为此浪费了一轮：探针的 `message` handler 因为在箭头函数里用了 `arguments`
> 而第一行就 ReferenceError，但因为没有 logger，现象只是"连上了、但发消息没反应"。
> **空白应当被当成"缺少观测"，而不是"没有发生"。**
>
> ### 6. ★ markdown **不吃下划线**（推翻了我原先的担心），所以**不用转义**
>
> 真机截图确认（同一行三种写法并排）：
>
> | 写法 | 显示结果 |
> |---|---|
> | 裸下划线 `qq_session_control 与 dsh_qq` | **下划线完好**，没有被渲染成斜体 |
> | 反引号包住 `` `qq_session_control` `` | 等宽代码样式，下划线完好 |
> | 反斜杠转义 `qq\_session\_control` | **反斜杠被消费掉**，下划线完好 |
>
> 结论：**按钮消息里可以照常写下划线**（工具名、`dsh_qq`、字段名都不必处理）；
> **反斜杠转义不要用**（它只会多出一个被吃掉的字符）。
> 想强调标识符时可以用反引号（渲染成等宽，读起来更像代码），但那是可选的美化。
>
> ### 7. ★ `action.data` 会**原封不动**出现在输入框里
>
> 真机证据：探针 ⑤ 的按钮把 `data` 设成了内部记号 `escape:one`，
> 点击后**输入框里就是 `escape:one`**。
>
> **这是本步骤的设计铁律：**
>
> > `action.data` 必须**就是用户本该输入的那串文本**。
> > 放 `approve:allow`、`switch:2` 这种内部记号，用户会看到一串看不懂的东西——
> > **比没有按钮更糟**，因为他不知道该不该按发送。
>
> 所以：审批是 `允许`、选项是 `1`、切换是 `/switch 2`、停止是 `/cancel`。
> 相应地 `render_data.label` 与 `data` 保持**意思上的一致**（按钮上写的要让人预期它会填什么）。
>
> ⚠️ **"一致"不等于"逐字相等"**（实现时才发现，此处按实际实现澄清）：
>
> - **用户本来就会打那个词**的按钮（审批的「允许」、选项的「1」）→ label 与 data **逐字相等**。
> - **动作按钮**（「重新生成」→ `/retry`、「停止」→ `/cancel`）与**会话按钮**
>   （「2 修复登录」→ `/switch 2`）→ label 是给人看的，data 是那条指令。
>   把它们写成逐字相等反而更糟：按钮上写 `/switch 2` 或 `/retry`，
>   用户看到的是命令而不是他想要的东西。
>
> 断言按这个口径钉：审批/选项按钮钉"label === data"，
> 动作/会话按钮钉"data 是恰好那串指令，且**不含任何内部记号形态**"。
>
> ### 8. QQ 会自己截断过长的按钮标签
>
> 真机：24 字的标签显示成「这是一个非常长的按钮标签用来试探长度上限究竟**...**」。
> 所以**标签长度要自己控制在合理范围**（会话标题这类用户数据尤其要截断），
> 不能指望 QQ 截得好看。

---

**结论先说：四个功能（审批按钮 / 选项按钮 / 会话列表与切换按钮 / 重新生成与停止按钮）
靠 `action.type: 2` 的指令按钮实现，不走 `INTERACTION_CREATE`。**

**流式输出不做。**

调研对象：已安装的 `@tencent-connect/qqbot-nodejs@1.0.4` 的**类型定义与 USAGE.md**。
每条都标了 `文件:行`，改动前请自行复核。

---

## 一、按钮：发送方式与形状

### 发送（**只用这一条**）

```ts
// QQBot.d.ts:356
sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<MessageResponse>
```

⚠️ **不要用 `sendTextWithKeyboard`**（`QQBot.d.ts:343`）——它在 `markdownSupport`
默认 `false` 时发 `msg_type=0`，**键盘不渲染**。真机已确认。

### 形状（`protocol/types.d.ts:135` 与 `:152`）

```ts
interface InlineKeyboard {
  content: { rows: Array<{ buttons: KeyboardButton[] }> }
}

interface KeyboardButton {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  action: {
    type: number          // ★ 用 2（指令按钮）：点击把 data 填进输入框
    permission: { type: number }
    data: string          // ★ 必须就是"用户本该输入的那串文本"
    click_limit?: number
  }
  group_id?: string
}
```

`render_data.style`：`0` = 灰、`1` = 蓝（真机确认两种都能显示）。

### 官方示例（`USAGE.md:288`）

```ts
{
  id: "btn-confirm",
  render_data: { label: "确认", visited_label: "已确认", style: 1 },
  action: { type: 2, permission: { type: 2 }, data: "confirmed" },
}
```

---

## 二、回调按钮（**本步骤不用**，仅存档）

`USAGE.md:481` 的 §12：

```ts
bot.on("interaction", async (ctx, event) => {
  console.log("按钮点击:", event.data.resolved.button_id, event.data.resolved.button_data);
  // QQ 平台要求 5 秒内 ACK
  await bot.acknowledgeInteraction(event.id, 0);  // 0=成功
});
```

ACK code：`0` 成功、`1` 操作失败、`2` 操作频繁、`3` 重复操作、`4` 没有权限、`5` 仅管理员。

`InteractionEvent`（`types.d.ts:159`）：`id`、`type`、`data.resolved.{button_id,button_data,user_id,message_id}`。

⚠️ `InteractionType`（`constants.d.ts:67`）只导出 `CONFIG_QUERY: 2001` /
`CONFIG_UPDATE: 2002` 两个**配置类**交互，按钮点击的 `data.type` 取值未确认；
而且从根模块 `import` 时它是 `undefined`。**所以处理逻辑不该依赖它。**

---

## 三、流式输出（**不做**，存档备查）

`QQBot.d.ts:444`：

```ts
openStream(opts: { target: ReplyTarget; eventId?: string; throttleMs?: number }): StreamSession
```

官方注释（`QQBot.d.ts:441`）：*call `update(fullText)` repeatedly, then `complete()`.*

`update(fullText)` 传**全文**（协议 `input_mode: 'replace'`），节流内置（`throttleMs`）。
底层 `StreamMessageRequest`：`input_state: GENERATING(1)/DONE(10)`、`content_type: 'markdown'`、
`msg_id`、`msg_seq`、`index`、`stream_msg_id?`。

由字段可推出：流式挂在 `msg_id` 上（被动窗口内），所以**主动推送大概不能流式**；
`input_state` 必须显式以 `DONE` 收尾。

**用户已决定不做，本节仅存档。**

---

## 四、实现设计（四个功能，一个机制）

### 4.0 公共部件：`lib/buttons.js`

- `buildKeyboard(rows)` —— 把 `[[{label, data, style}]]` 组装成 `InlineKeyboard`
- `keyboardMessage(text, rows)` —— 一行封装：不要 keyboard 时退回纯文本 `sendText`，
  要 keyboard 时走 `sendMarkdown`。**这个判断只该有一个地方做。**
- **markdown 转义**：因为按钮消息走 markdown，而我们的文本含下划线。
  需要 `mdEscape(text)`（反引号包住标识符，或反斜杠转义）。
  ⚠️ 真机上"反引号 vs 裸下划线 vs 反斜杠"三种写法**尚未逐一看过**，
  实现前先看一眼，或保守地一律用反引号包住标识符。

### 4.1 审批按钮（`prompt_keyboard`）

`#ask` 发审批提示时附一行 `[允许] [拒绝]`：

```js
[{ label: '允许', data: '允许', style: 1 }, { label: '拒绝', data: '拒绝', style: 0 }]
```

- 点击 → 输入框出现「允许」→ 用户发送 → 作为**普通文字消息**到达
- 走**现有的** `#settleInteraction` → `parseApprovalReply('允许')` → `'allowed-once'`
- **一行解析逻辑都不用改**

### 4.2 选项按钮（提问）

`presentQuestions(questions)` 已经把选项编成 `1. 方案A` 这样的编号。
按钮就是这些编号：

```js
rows = 每行最多 5 个（真机确认 5×5 可行），label = '1'、'2'…
data = '1'、'2'…
```

- 单选：点一个即可
- 多选：现有的 `parseQuestionReply` 已支持 `1,3` / `1 2` / 全角逗号；
  多选时按钮只能填一个数字，所以**多选场景仍以打字为主**，
  按钮作为"至少要选第一个"的便利（或**多选时干脆不放按钮**——
  实现时按"不制造误导"的原则决定）

### 4.3 会话列表与切换按钮（新增）

`/list` 的回复已经是编号列表。给每一行对话一个按钮：

```js
label = '2 修复登录'（编号 + 标题，截断到合适长度）
data  = '/switch 2'
```

- 点击 → 输入框出现 `/switch 2` → 用户发送 → **`SessionRouter` 现成的** `/switch` 处理
- `/switch` 成功后的确认消息**不附按钮**（微信的教训：确认必须由频道自己说清楚，
  再挂一排按钮会让它看起来像个待办菜单）
- 对话数超过一行容量（5）时**分行**；超过两行（10）就只放前 10 个并提示用 `/list all`

### 4.4 重新生成 / 停止按钮（`action_button`）

在每条回复后附一行：

```js
[{ label: '重新生成', data: '/retry' }, { label: '停止', data: '/cancel', style: 0 }]
```

- `停止` → 复用**现成的** `/cancel` ✓
- `重新生成` → **需要在 `SessionRouter` 里新增 `/retry`**：
  重新提交该会话最近一次的用户输入。
  这要求运行日记住 `lastPrompt per session`（`#lastPrompts` Map）。
  `/retry` 作为聊天指令本身也有用，不只是给按钮用。
- ⚠️ **每条回复都挂按钮可能造成刷屏感**。实现时应当：
  只在"回答完成"的那一条挂（而不是流式的每一条），
  并且**如果回复本来就带了别的键盘（如审批），就不要叠加**。

---

## 五、动手前必须补测的项

第一轮探针已经定案了大部分，剩下这些**实现前要亲眼看一下**：

| # | 待确认 | 为什么重要 |
|---|---|---|
| 1 | markdown 里下划线的三种写法（裸 / 反引号 / 反斜杠）各渲染成什么 | 决定按钮消息里工具名怎么写。**上一轮没看到结果** |
| 2 | `click_limit` 的默认行为（不设时能点几次） | 按钮该不该设它 |
| 3 | 点了按钮但**不发送**，直接改内容再发，会怎样 | 确认"指令按钮只是填输入框"这一结论的边界 |
| 4 | 超长 label 是被截断还是按钮不显示 | 会话标题很长时的表现 |
| 5 | 主动推送的消息能否带 keyboard | 「干完了告诉你」能不能也带按钮 |

---

## 六、给实现的硬约束（与既有事故记录一脉相承）

1. **客户端改动必须整份包在 IIFE 里**（`POSTMORTEM.md` 004：顶层作用域是所有插件共享的，
   泄漏一个 `const` 会让**整个应用起不来**）。
2. **不得给客户端模块的 `inject` 新增必需服务**（客户端条目激活失败会走启动审计，
   同样让整个应用起不来）。用 `ctx.get` 可选获取 + 降级。
3. **所有脱离 await 链的异步工作必须经 `#fire`**（`POSTMORTEM.md` 003：定时器与流回调里
   同步抛出 = 宿主眼中的致命错误）。
4. **必须给 `QQBot` 传 `logger`**（本文件顶部第 5 条）：否则 handler 抛错在日志里是空白。
5. **任何新设置项都要过上下限校验**，并且**每个设置项都必须真的有强制点**
   （曾经查出 `allowCrossSessionNotify` 是个只存在于设置面板的死设置）。
6. **改完必须跑**：`verify.mjs`、`verify-client.mjs`、`check-cross-plugin.mjs`、`check-unbound.mjs`。
7. 新增的每个检查器/断言都要有**反向对照**（能抓住已知故障），否则它只是让人以为验过了。


---
