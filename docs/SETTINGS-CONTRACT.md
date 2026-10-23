# 设置页 ↔ 宿主 路由契约（QQ 版）

> 面向：**实现/维护宿主侧路由的人**。
> 依据：`client.js`（本目录上一级）的**实际调用点**逐条读出来的，不是设计意图。
> 「现状」一列对照的是**本次读取时刻**的宿主代码：
> `lib/routes.js`（233 行）、`lib/runtime.js`（1617 行）、`lib/login.js`（142 行）、`package.json`。
> 宿主侧当时正在并行改动，若你读到的不一样，以代码为准并回来更新本文。
>
> 客户端只认这份契约；字段名/类型/可空性只要有一处不符，对应 UI 就会静默降级或显示 `undefined`，
> 所以本文宁可啰嗦。

---

## 0. 三条读法

1. **客户端所有请求都走相对路径**（`fetch('/.dsh-qq-plugin-group-expand/...')`），前缀常量 `PREFIX = '/.dsh-qq-plugin-group-expand'`。
   页面与 web 服务同源，这是微信版既有的做法。
2. **`GET /status` 是唯一必需品。** 它失败 = 整页进入错误态（「读取设置失败」+ 重试按钮）。
   其余路由全部走 `Promise.allSettled`，任一失败只是那一个区块降级或消失。
3. **非 2xx 一律当作失败**：客户端解析响应体 JSON，若 `!response.ok` 就抛
   `new Error(body.error || "HTTP <status>")`，并把这句显示在红色错误行里。
   所以**错误响应里给 `error` 字段是有意义的**（它就是用户看到的那句话）；它是可选的。
   响应体不是 JSON 时，客户端把前 200 字符当 `error` 用。

客户端把响应**整体替换**进 state 的地方只有三处，对形状最敏感：

| 位置 | 被整体替换的 state | 后果 |
|---|---|---|
| `POST /login/start` | `login` | 返回 `{}` 会让卡片退回 idle，且**轮询不会启动** |
| `GET /login`（轮询） | `login` | 同上 |
| `POST /start` / `POST /stop` | `status` | 返回包装体会让账号、诊断全部显示成空 |

---

## 1. 总览：客户端调用的每一个路由

| # | 方法 + 路径 | 触发时机 | QQ 侧现状 |
|---|---|---|---|
| 1 | `GET /.dsh-qq-plugin-group-expand/status` | 首次加载、登录中每 1.5s 轮询、窗口重新聚焦 | ✅ 已实现，形状完全够用 |
| 2 | `POST /.dsh-qq-plugin-group-expand/start` | 通道开关打开 | ✅ 已实现（返回 status 快照） |
| 3 | `POST /.dsh-qq-plugin-group-expand/stop` | 通道开关关闭 | ✅ 已实现（返回 status 快照） |
| 4 | `POST /.dsh-qq-plugin-group-expand/disconnect` | 「断开连接」按钮 | ✅ 已实现（`runtime.forget`） |
| 5 | `GET /.dsh-qq-plugin-group-expand/login` | 首次加载 + 绑定进行中每 1.5s 轮询 | ✅ 已实现（`runtime.bindSnapshot()`） |
| 6 | `POST /.dsh-qq-plugin-group-expand/login/start` | 「开始扫码」/「重新扫码」 | ✅ 已实现（`runtime.startBind`）；初值是 `phase:'starting'`，见 §2.5 |
| 7 | `POST /.dsh-qq-plugin-group-expand/login/cancel` | 「取消」 | ✅ 已实现（`runtime.cancelBind`） |
| 8 | `POST /.dsh-qq-plugin-group-expand/login/verify` | 验证码「提交」 | ❌ **仍缺**，但今天走不到，见 §2.7 |
| 9 | `GET /.dsh-qq-plugin-group-expand/settings` | 首次加载 | ✅ 已实现（`settingsForPage()`，多带 `permissionPreset`，见 §2.8） |
| 10 | `POST /.dsh-qq-plugin-group-expand/settings` | 「保存设置」 | ✅ 已实现（`applySettings`） |
| 11 | `GET /.dsh-qq-plugin-group-expand/permission-presets` | 首次加载 | ✅ 已实现 |
| 12 | `POST /.dsh-qq-plugin-group-expand/permission-preset` | 下拉改选（**改即提交，没有保存按钮**） | ✅ 已实现 |
| 13 | `GET /.dsh-qq-plugin-group-expand/log` | 首次加载 | ✅ 已实现 |
| 14 | `GET /.dsh-qq-plugin-group-expand/accounts` | 首次加载 | ✅ 已实现；**客户端「已绑定账号」的主数据源** |
| 15 | `POST /.dsh-qq-plugin-group-expand/client-error` | 看门狗 20s 未能注册设置段 / 加载失败 / 登录失败 / 渲染抛错 | ✅ 已实现（失败被客户端吞掉） |
| — | `POST /.dsh-qq-plugin-group-expand/toggle`（`{enabled}`） | **客户端不调用** | ✅ 已实现（客户端用 `/start` `/stop` 这一对） |
| — | `GET /.dsh-qq-plugin-group-expand/`（裸前缀） | **客户端不调用** | ✅ 已实现（等同 `/status`） |
| — | `POST /.dsh-qq-plugin-group-expand/credentials` | **客户端不调用** | ✅ 已实现（保留给手工录入/脚本） |
| — | `GET /.dsh-qq-plugin-group-expand/diagnostics` | **客户端不调用** | ❌ 不存在，也不需要 |

> 微信客户端的诊断块读的是 `status.diagnostics.{logPath,statePath,workspace,logTail}`。
> QQ 版**改成读 `GET /log`**（那边已有），所以不需要 `status.diagnostics`，也不需要 `/diagnostics`。

---

## 2. 逐条契约

### 2.1 `GET /.dsh-qq-plugin-group-expand/status` ✅ 已实现

- **请求体**：无。
- **客户端调用点**：`load()`（与另外 5 个路由并发）、`refreshLogin()`（与 `/login` 并发）。
- **响应形状**（`runtime.status()` 现状，逐字段）：

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `connected` | `boolean` | 否 | 通道开关的选中态；无 `/accounts` 时兜底行的徽标 |
| `appId` | `string` | **可空**（未连接时是 `undefined`，`JSON.stringify` 会把该键整个省略） | **兜底**数据源：`/accounts` 拿不到时才有用它渲染绑定行；也是发给 `/disconnect` 的 `appId` |
| `boundUserOpenid` | `string` | 可空 | 同上，兜底行里的 ` ← <openid>` |
| `boundAt` | `string`（ISO 8601） | 可空 | 同上，兜底行里的 ` · <iso>` |
| `workspace` | `string` | 否 | 诊断事实「会话工作目录」；缺失显示 `—` |
| `conversationCount` | `number` | 否 | 诊断事实「对话数」 |
| `replyLimiter` | `{ limit: number, ttlMs: number, ttlHours: number }` | 可空 | 诊断事实「被动回复限流」，渲染成 `<limit> 次 / <ttlHours> 小时`；不是对象则 `—` |
| `permissionPreset` | `string` | 否 | **客户端不读**（当前值来自 `/permission-presets` 的 `applied`）。保留给宿主自用 |
| `pendingInteractions` | `number` | 否 | 诊断事实「待回答交互」 |
| `errors` | `string[]` | 否（建议始终给数组） | 「最近错误」列表（末 6 条）；**同时是诊断分组的显示开关之一**（另一个是 `/log` 成功） |

- **客户端读法**：`status.connected === true`、`asString(status.appId)`、`asArray(status.errors).filter(字符串)`，
  其余经 `asText()`（字符串/数字/布尔皆可，其它显示 `—`）。
- **微信契约里不需要的字段**：`enabled`、`accounts[]`、`needsLogin`、`diagnostics`。
- **建议**：无需改动。

---

### 2.2 `POST /.dsh-qq-plugin-group-expand/start` / `POST /.dsh-qq-plugin-group-expand/stop` ✅ 已实现

- **请求体**：`{}`（带 `content-type: application/json`；宿主不读它）。
- **触发**：开关关→开调 `/start`，开→关调 `/stop`；请求进行中开关 `disabled`。
- **响应形状**：**与 `GET /status` 完全同形的快照**（现在就是 `runtime.status()`）。
- **客户端拿它做什么**：`status: isRecord(snapshot) ? snapshot : prev.status` —— **整体替换**。
  所以**不能**改成 `{ ok: true }` 之类的包装体。
- **注意**：宿主另有 `POST /toggle`（`{enabled}` → `setEnabled()` → status 快照），
  客户端**不用**它（`start`/`stop` 那一对语义更直接）。两条路都能走，但**不要删掉 `/start` `/stop`**，
  否则设置页的开关会 404。
- **失败行为**：错误行 `保存失败: <message>`，开关状态不变。

---

### 2.3 `POST /.dsh-qq-plugin-group-expand/disconnect` ✅ 已实现

- **请求体**：`{ appId: string }`（取自 `/accounts` 行的 `appId`，或兜底用的 `status.appId`）。
- **响应形状**（现状）：

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `status` | 与 `GET /status` 同形 | **不建议可空** | 客户端读 `result.status` 并整体替换 state；缺失则页面保持旧状态（按钮点了看起来没反应） |
| `accounts` | `/accounts` 的数组（同 §2.13 的行形状） | 可空 | 客户端读它并替换绑定列表，于是被解绑的那一行立刻消失。缺失时客户端在本机把该 `appId` 的行删掉（成功才删），所以不会留下幽灵行 |
| `disconnected` | `boolean` | 不存在 | 客户端不读 |

- **客户端读法**：
  ```js
  const ok = await act(`${PREFIX}/disconnect`, { appId })   // act 折叠 result.status 与 result.accounts
  if (ok) setState(prev => ({ ...prev, accountRows: prev.accountRows.filter(row => row.appId !== appId) }))
  ```
- **现状评价**：可用（`{status, accounts}` 两个字段都被用到）。当前实现对不存在的 `appId`
  也返回 200（`forget()` 是幂等的空操作），客户端不会因此报错。
- **可选改进（非必需）**：返回 `disconnected: false` + 404，便于 curl/日志区分
  「删了一个」与「本来就没有」。
- **失败行为**：非 2xx → 错误行；`status` 不变。

---

### 2.4 `GET /.dsh-qq-plugin-group-expand/login` ✅ 已实现

- **请求体**：无。
- **触发**：首次加载读一次；之后**只要绑定流程还在进行中**就每 1500ms 轮询一次
  （与 `/status` 并发，见 `refreshLogin()`）；窗口重新聚焦时整体重载。
- **「进行中」的判据（客户端侧）**：`phase` **不是** `idle` / `succeeded` / `already-bound` / `failed`
  之一。这是**刻意的黑名单**而不是 `phase === 'running'`——宿主的流程会经过 `starting`
  （以及 `running` + `saving`）这些中间态，白名单会让轮询在二维码出现前就停住，
  表现是「点了开始扫码，什么都没有」。

- **响应形状**（`lib/login.js` 的 `snapshot()`；`phase` 取值表见该文件头部注释）：

| 字段 | 类型 | 可空 | 含义 / 客户端用途 |
|---|---|---|---|
| `phase` | `'idle' \| 'starting' \| 'running' \| 'succeeded' \| 'failed'` | 否（缺省按 `idle`） | 决定分支；非终态即继续轮询 |
| `qrUrl` | `string` | 可空 | **客户端不读**（微信版也没有用它渲染；留着便于日志/复制链接） |
| `qrDataUrl` | `string`（`data:image/png;base64,…`） | 可空 | **仅当 `phase === 'running'` 且非空串**时渲染 `<img width=220 height=220 alt>`。`toDataUrl` 失败时该键不出现，客户端只显示文案，不报错 |
| `refreshing` | `boolean` | 可空 | **客户端不读**（宿主内部标记：二维码过期正在换新） |
| `saving` | `boolean` | 可空 | **客户端不读**（但 `phase` 仍是 `running`，所以轮询继续，这是对的） |
| `accountId` | `string` | 可空 | `phase === 'succeeded'` 时拼成「已连接 QQ：`<accountId>`」 |
| `userOpenid` | `string` | 可空 | **客户端不读** |
| `error` | `string` | 可空 | `phase === 'failed'` 时拼成「登录失败：`<error>`」 |
| `step` | `string` | 可空 | **宿主目前没有发这个字段**。客户端有完整支持：`step` 优先于默认文案。见下面「可选改进」 |
| `awaitingVerifyCode` | `boolean` | 可空 | 宿主从不发 → 验证码 UI 永不出现（见 §2.7） |
| `already-bound` | — | — | 宿主从未产生这个 phase；客户端仍支持（显示「这个机器人之前绑过，继续用原有凭据」） |

- **可选改进（非必需，但用户体验明显）**：补一个 `step` 字段，例如
  `starting` → 「正在向 q.qq.com 申请绑定任务…」、`running && refreshing` → 「二维码已过期，正在刷新…」、
  `running && saving` → 「扫码成功，正在保存凭据…」。客户端会优先显示它，
  否则这三种状态下卡片只显示默认的「用手机 QQ 扫一扫，并在手机上确认。」。
  `step` 是纯文案字段，加它**不需要**改客户端。
- **失败行为**：轮询失败是静默的（`catch {}`），可见的错误路径是显式重载。

---

### 2.5 `POST /.dsh-qq-plugin-group-expand/login/start` ✅ 已实现

- **请求体**：`{}`。宿主读 `body.source`（字符串，缺省 `'dsh-qq-plugin-group-expand'`）——客户端的 `{}` 会走默认值，
  与微信版一致。
- **响应形状**：**与 `GET /login` 完全同形的快照**，由 `runtime.startBind(source)` 返回。
- **⚠️ 已知时序（客户端已适配）**：`login.js` 的 `start()` 先把状态置为 `{phase:'starting'}`，
  `onQrDisplayed` 要等网络回调才把它改成 `running`。所以这个接口**通常返回 `{phase:'starting'}`**，
  第一次 `qrDataUrl` 往往还没有。客户端因此：
  - 把「非终态」都当作进行中并继续轮询（§2.4），二维码在随后 1–2 次轮询内出现；
  - `phase` 不是 `running` 时也把「开始/重新扫码」按钮 `disabled`，并显示「取消」。
  如果宿主把 `starting` 也去掉了（直接 `running`），客户端一样工作。**不要**在
  `starting` 之上再加一个更早的、长时间停留的阶段而不轮询——客户端认的是「非终态即轮询」，
  所以现在的写法是安全的。
- **重复点击**：宿主 `start()` 会先 `cancel()` 上一次；客户端也会禁用按钮，双保险。
- **失败行为**：错误行 + `reportFailure('login', error)`。

---

### 2.6 `POST /.dsh-qq-plugin-group-expand/login/cancel` ✅ 已实现

- **请求体**：`{}`。
- **响应形状**：客户端**完全不读**。当前实现返回 `{phase:'idle'}`（除非已终态，
  `login.js` 会保留 `succeeded`/`failed` 给用户看）。
- **之后**：客户端立刻并发读一次 `/login` + `/status`。
- **失败行为**：错误行（不会破坏页面）。

---

### 2.7 `POST /.dsh-qq-plugin-group-expand/login/verify` ❌ 仍缺（条件性，今天走不到）

- **请求体**：`{ code: string }`（客户端已 `trim()`；空串时**根本不发请求**）。
- **响应形状**：客户端不读（`{ accepted: boolean }` 即可）；2xx = 接受，非 2xx = 拒绝并显示 `error`。
  之后会刷新 `/login` + `/status`。
- **为什么现在不影响使用**：客户端只在 `/login` 回 `awaitingVerifyCode: true` 时渲染这个输入框，
  而 `lib/login.js` 从不设这个字段——`@tencent-connect/qqbot-connector` 的 `startQrConnect`
  回调面只有 `onQrDisplayed / onQrExpired / onSuccess / onFailure`，**没有验证码回调**。
  客户端保留这段 UI 只是为了与微信版结构一致。
- **如果哪天要补**：最省事的实现是
  ```js
  if (req.method === 'POST' && path === '/login/verify') {
    return json(res, 409, { accepted: false, error: 'QQ 扫码流程没有验证码环节' })
  }
  ```
  **不确定**：QQ 侧是否真的永远不需要配对验证码（见 §6）。

---

### 2.8 `GET /.dsh-qq-plugin-group-expand/settings` ✅ 已实现

- **请求体**：无。
- **响应形状**（`runtime.settingsForPage()` 现状）：

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `settings` | `{ permissionPreset: string, requireConfirmation: boolean, allowCrossSessionNotify: boolean, settleMs: number, presenceNote: string, mergeWindowMs: number, autoReplyAttachments: boolean, maxReplyChars: number, workspacePath: string }` | **不建议可空** | 表单初值（draft）。**不是对象时整个「行为设置」区块不渲染** |
| `defaults` | 与 `settings` 同键 | 可空 | **驱动唯一的全局「恢复默认」按钮**（点击即 `draft = defaults`）。缺失时该按钮 `disabled` |

- **客户端读法**：`settings: settings.settings`、`defaults: settings.defaults`、
  `draft: settings.settings`；渲染时 `draft !== undefined` 才输出这一组卡片。
  因此路由缺失时该区块整体不出现——这是刻意的（宁可不显示，也不显示客户端自己编的默认值）。
- **⚠️ 只有一个全局「恢复默认」**：微信的设置页就是这样，**没有任何逐字段的
  「默认 `<值>`」提示或逐字段「恢复默认」按钮**。本项目第一版曾自己发明了这两样，
  结果每个字段旁多挂两段文字，八个字段就是十六处装饰——**那正是页面看起来杂乱的原因**，
  现已删除（连同 `.dsh-qq-default` / `.dsh-qq-row-head` / `.dsh-qq-field-head` / `.dsh-qq-link`
  这几条随之失引的 CSS；留下死 CSS 只会让下一个人以为还有那个控件）。
  **不要把它加回来。** 逐字段保留的是 **hint**（`mergeWindowHint` / `maxReplyCharsHint` /
  `presenceNoteHint` …）——那个微信本来就有。
- **⚠️ 关于多出来的 `permissionPreset`**：客户端**只渲染并回传 `SETTINGS_FIELDS` 里的键**。
  这是必须的：如果把 `/settings` 收到的整份 `settings` 原样 POST 回去，那么用户在「权限」下拉里
  刚切换的预设，会被保存动作用页面加载时的旧值覆盖。所以 `permissionPreset` **保留在响应里没问题**，
  但客户端永远不会写它——它是**只读展示**，切换走独立的 `/permission-preset` 路由、改即生效。
- **默认值来源**（`runtime.js` 常量）：

  | 字段 | 类型 | 默认值 | 界面标签 |
  |---|---|---|---|
  | `requireConfirmation` | `boolean` | `true` | 「会话操作先确认」 |
  | `allowCrossSessionNotify` | `boolean` | `true` | 「允许任意会话主动推送」 |
  | `settleMs` | `number`（毫秒，≥0） | `1200` | 「回复聚合静默窗口（毫秒）」 |
  | `presenceNote` | `string` | 一段中文渠道说明（`DEFAULT_PRESENCE_NOTE`，定义在 `lib/settings.js`） | 「渠道上下文说明」（多行 `textarea`） |
  | `mergeWindowMs` | `number`（毫秒，≥0） | `10000` | 「附件合并窗口（毫秒）」 |
  | `autoReplyAttachments` | `boolean` | `true` | 「自动回应附件」 |
  | `maxReplyChars` | `number`（≥0，**`0` 表示不限制**） | `4000` | 「单条回复字数上限」 |
  | `workspacePath` | `string`（**空串 = 用默认位置**） | `''` → `$DSH_HOME/dsh_qq` | 「会话文件夹路径」 |

  ⚠️ **`workspacePath` 是唯一一个填错会让插件起不来的设置**，所以校验与回落都在宿主侧
  （`lib/paths.js` 的 `resolveWorkspaceDir`）：
  - 非绝对路径 → **拒绝**（相对路径会相对于进程 cwd 解析，和用户以为的位置不是一回事）
  - 目录建不出来或写不进去 → **回落默认位置**，只记一条理由
  - **坏路径只能"没生效"，绝不能抛到 `apply` 上去**——那会让启动审计判定插件未激活，
    于是整个应用起不来

  `settings.workspacePath` 保存的是**用户填的原文**（坏路径时用户能在页面里看到自己去改），
  而 `GET /status` 的 `workspace` 是**校验后实际生效的路径**。两者分开是有意的。
  另外：**改路径不搬动已有的对话**——它们留在旧文件夹，只有之后新建的用新路径。
  这是唯一安全的做法：宿主在采用已存在会话时比对 `cwd`，不一致会抛
  `ApiSessionCwdConflict`，那个会话就永远接不回来了。

  ⚠️ **这张表的唯一来源是 `lib/settings.js` 的 `SETTINGS_SCHEMA`**（每项一个校验器
  加一个 `default`）。`settingsForPage()` 的 `settings` / `defaults` 两层都由它派生，
  加载归一（`state.js`）与落盘（`runtime.js` `#persistSettings()`）也一样——
  所以这里列的九项若与那份 schema 不符，**以 schema 为准并回来改本文**。
  加一项设置只需在 schema 里加一行：往返测试的断言数会跟着走，
  而"运行时持有的字段集"与 schema 键集不一致会被 `verify.mjs` 当场判红
  （纯 JS 没有编译器，那条键集一致性断言就是 schema 的守护）。
  之前这里是**三份各写各的名单**，加设置时漏掉任何一份都会让那个字段在加载时被丢弃，
  而且每次写盘都重新加载并重新规范化，于是下一次写盘把丢失**持久化**——
  表现就是"重启后设置忘了"。微信插件的同一条故障见其提交 `5cbe7d2`。

  ⚠️ **`0` 在 `mergeWindowMs` 与 `maxReplyChars` 上都是合法值**，含义分别是"不等待"与"不限制"。
  客户端用 `editNumber()`（`Number.isFinite` + `Math.max(0, n)`，空串映射为 `0`）处理，
  宿主侧 `applySettings()` 同样只判"有限非负数"。**两端都不许把 `0` 当成"空/未填"拦掉**——
  那会把"不限制"悄悄变成"截断成 0 字"。

- **建议**：无需改动。
  （若想让「权限预设」也走表单的保存按钮，需要客户端与宿主一起改：那时 `permissionPreset`
  应进入 `SETTINGS_FIELDS` 并在保存后重新读 `/permission-presets`。当前设计是两个独立控件、
  预设改即生效，交付说明也以此为准。）

---

### 2.9 `POST /.dsh-qq-plugin-group-expand/settings` ✅ 已实现

- **请求体**：**只含 `SETTINGS_FIELDS` 里的键**，即
  `{ requireConfirmation?, allowCrossSessionNotify?, settleMs?, presenceNote?, mergeWindowMs?, autoReplyAttachments?, maxReplyChars? }`
  （draft 里存在的键才发；字段来源见 §2.8）。带 `content-type: application/json`。
  `permissionPreset` **不在其中**——它走独立的 `/permission-preset` 路由。
- **响应形状**（现状：`applySettings(body)` 之后 `settingsForPage()`）：

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `settings` | 与请求同键（**含 `permissionPreset`**） | 可空 | 保存后的权威值；客户端同时写回 `settings` 与 `draft`。缺失则沿用 draft（乐观） |
| `defaults` | 与 `settings` 同键 | 可空 | 若给出则替换本地 `defaults`；缺失则保留原值 |

- **客户端读法**：`const saved = isRecord(result.settings) ? result.settings : state.draft`，
  并在 2.5 秒内于按钮旁显示「已保存」。
- **现状安全性**：路由把**原始 body** 交给 `applySettings()`，而 `applySettings()` 自己逐字段
  判类型（走的正是 `lib/settings.js` 的 `SETTINGS_SCHEMA`：布尔只认布尔；
  `settleMs` 只认有限非负数且不超上限，通过则取整），所以畸形请求改不动运行时状态。
  **保持这个分工**：路由不校验，`applySettings()` 才校验。
  ⚠️ `applySettings()` 在 `requireConfirmation` 变化时会 `refreshTools()`——那是刻意的
  （该策略只存在于 `session_control` 的工具描述里），**不要**绕过它直接改私有字段。
- **持久化**：**这些设置现在会持久化**（写入状态文件的 `settings` 块），
  启动时由 `runtime.hydrateSettings()` 读回，所以重启后仍是用户选的那份。
  老状态文件（没有 `settings` 块）照常可读，缺字段回落 schema 的 `default`。
  ⚠️ 这条以前写的是"只在内存里、重启回默认"——**那是旧行为，已不成立**；
  设置静默回默认是最糟的一种"没有效果"，用户要到下次需要它时才发现。
- **落盘清单也是派生出来的**：`#persistSettings()` 遍历 `SETTINGS_SCHEMA` 的键，
  不再手抄第二份字段名单（那正是上面那条故障的成因）。
  校验语义：**类型不对或越界就丢弃该字段**（保持原值/默认值），不是回落到默认值；
  空串在 `presenceNote`（= 不要这段说明）与 `workspacePath`（= 用默认位置）上都是合法值。

---

### 2.10 `GET /.dsh-qq-plugin-group-expand/permission-presets` ✅ 已实现

- **请求体**：无。
- **响应形状**（`runtime.permissionPresetsInfo()`）：

| 字段 | 类型 | 可空 | 含义 / 客户端用途 |
|---|---|---|---|
| `applied` | `string` | 否（建议） | 当前生效值，用来选中下拉项。不在候选里时客户端退回选中 `sentinel` |
| `sentinel` | `string`（**约定 `'default'`**） | 否 | 「不施加任何预设、沿用 profile 策略」的哨兵值。客户端把它**追加在 `available` 之后**作为额外选项，标签写死为「跟随 profile 设置」 |
| `available` | `string[]` | 否（可为空） | 真实预设名列表，逐项一个 `<option>`；非字符串项被丢弃 |
| `note` | `string` | 可空 | 字段下方的提示文字（如「此组合没有权限预设服务」）；空/缺失不显示 |

- **客户端读法**：
  ```js
  const available = asArray(presets?.available).filter(name => typeof name === 'string')
  const sentinel = asString(presets?.sentinel, 'default') || 'default'
  const applied = asString(presets?.applied, sentinel) || sentinel
  const presetOptions = [...available, sentinel]
  const currentPreset = presetOptions.includes(applied) ? applied : sentinel
  ```
- **两个硬要求**：
  1. `sentinel` **不能同时出现在 `available` 里**——否则同一个 `<option value>` 出现两次
     （React 重复 key 警告 + 下拉里两个「跟随 profile 设置」）。
  2. `available` 为空数组时下拉被 `disabled`，并显示「此组合没有可选的权限预设。」（`note` 优先）。
- **客户端标签映射**（纯 UI，宿主不用配合）：`'danger-full-access'` → 「完全访问：不询问，直接执行」；
  `'auto'` → 「自动审核：电脑上判断」；`sentinel` → 「跟随 profile 设置」；
  **其它任何名字原样显示**（部署方自定义的预设名会以原名出现）。
- **建议**：无需改动。

---

### 2.11 `POST /.dsh-qq-plugin-group-expand/permission-preset` ✅ 已实现

- **请求体**：`{ preset: string }`，取值是 `available` 中的某项或 `sentinel`。
- **触发**：**下拉一改就提交**（没有保存按钮）。请求中下拉 `disabled`，下方显示「切换中…」。
- **响应形状**（现状 `{ ok: true, ...permissionPresetsInfo() }`）：

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `applied` | `string` | 可空 | 新的当前值；缺失则用刚提交的 `preset` |
| `sentinel` | `string` | 可空 | 缺失则沿用上一次的值（再缺省 `'default'`） |
| `available` | `string[]` | 可空 | 缺失则沿用上一次的列表（**不会被清空**） |
| `note` | `string` | 可空 | 覆盖提示文字；缺失则沿用原值 |
| `ok` | `boolean` | — | 客户端不读（2xx 即成功） |

- **失败行为**：非 2xx → 错误行显示 `error`；下拉值不变（视觉上自动回弹）。
  现成的 400 分支返回 `{ error, available, sentinel }`，正好符合。
- **建议**：无需改动。

---

### 2.12 `GET /.dsh-qq-plugin-group-expand/log` ✅ 已实现

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `path` | `string` | 否 | 诊断事实「日志文件」；缺失显示 `—` |
| `tail` | **`string`** | 否 | 日志末尾文本，客户端取**末 60 行**塞进 `<pre>`；空串显示「（暂无日志）」 |

- **⚠️ 与微信契约的关键差异**：微信的 `status.diagnostics.logTail` 是 **`string[]`**，
  QQ 的 `/log.tail` 是**一整段字符串**。客户端已按字符串处理
  （`rawTail.split(/\r?\n/).slice(-60).join('\n')`）。**不要**改成数组。
  现状 `{ path: logPath(), tail: tailLog(4000) }` 正确。
- **诊断分组的显示条件**：`/log` 成功（对象）**或** `status.errors` 非空。
  两者都不成立时整个诊断分组不出现。
- **建议**：无需改动。

---

### 2.13 `GET /.dsh-qq-plugin-group-expand/accounts` ✅ 已实现

- **请求体**：无。
- **响应形状**：`{ accounts: Array<{...}> }`（`runtime.accountsSnapshot()`）：

| 字段 | 类型 | 可空 | 客户端用途 |
|---|---|---|---|
| `accounts[].appId` | `string` | 否 | 绑定行的主键/`accountId`，也是发给 `/disconnect` 的 `appId`；空串的行被丢弃 |
| `accounts[].userOpenid` | `string` | 可空 | 行内显示成 ` ← <openid>` |
| `accounts[].boundAt` | `string`（ISO 8601） | 可空 | 行内显示成 ` · <iso>` |
| `accounts[].active` | `boolean` | 否 | 徽标：「已连接 / 已停止」。`active === true` 才显示「已连接」 |
| `accounts[].enabled` | `boolean` | 否 | **客户端不读** |
| `accounts[].hasCredentials` | `boolean` | 否 | **客户端不读**（可以做成「凭据已丢失」的警告，目前没有） |

- **为什么用它而不是 `status.appId`**：`status.appId` 只在**当前连着**时才有值，
  于是「已绑定但停用了」会显示成「还没绑定」。`/accounts` 列的是状态文件里的全部账号，
  既更准确，也让「已绑定账号」块与微信版的多账号结构一致。
- **兜底**：`/accounts` 失败（或数组为空）而 `status.appId` 非空时，
  客户端用 `status.appId` + `boundUserOpenid` + `boundAt` + `connected` 补一行。
  所以**删掉这个路由不会让页面崩**，只是绑定列表退回单账号、且停用时不再显示。
- **建议**：无需改动。

---

### 2.14 `POST /.dsh-qq-plugin-group-expand/client-error` ✅ 已实现

- **请求体**：`{ scope: string, message: string, stack: string }`。
  `scope` 取值：`'register'`（20s 看门狗：设置段没能注册进槽位注册表。**旧名 `'mount'` 已废弃**——
  它描述的是组件挂载，而看门狗从没盯过那一步）、`'load'`、`'login'`、`'save'`、`'directory-picker'`、
  `'render'`（含 `slots.onEntryError` 报回来的渲染抛错）、`'watchdog'`；`stack` 无栈时为空串。
- **发送方式**：优先 `navigator.sendBeacon(url, new Blob([payload], {type:'application/json'}))`，
  否则 `fetch(..., { keepalive: true })`。都是 POST + JSON 体，现有 `readJson` 直接可用（它不看 content-type）。
- **响应形状**：**客户端完全不读**（连失败都吞掉）。现状 `{ ok: true }` 可以。
- **宿主侧现状（已实现）**：日志行带上 `scope`，形如 `client[<scope>] FAILED: <message>`，
  排查时能立刻区分「渲染抛错」与「看门狗超时」：
  ```js
  const scope = typeof body.scope === 'string' && body.scope !== '' ? body.scope : 'unknown'
  bootLog(`client[${scope}] FAILED: ${typeof body.message === 'string' ? body.message : '(no message)'}`)
  ```

---

## 3. 宿主还缺什么（照做即可）

### 3.1 路由：**只剩一条，而且是条件性的**

| 路由 | 现状 | 何时真的需要 |
|---|---|---|
| `POST /.dsh-qq-plugin-group-expand/login/verify` | 缺 | 只有宿主开始发 `awaitingVerifyCode: true` 时才需要（§2.7）。今天 `lib/login.js` 从不发它 |

### 3.2 字段：**没有必需项**

客户端的每个字段需求都在现有响应里。以下都是**可选**的体验改进，不做也能用：

| 可选项 | 位置 | 收益 |
|---|---|---|
| `step: string` | `GET /login` / `POST /login/start` | 三种中间态（申请任务中 / 换二维码中 / 保存凭据中）有话说，而不是只显示默认提示 |
| 日志行带上 `scope` | `POST /client-error` | 区分看门狗、加载、登录、渲染四类客户端失败 |
| `disconnected: boolean`（或 404） | `POST /disconnect` | curl/日志能区分「删了一个」与「本来就没有」 |
| `hasCredentials: false` 的提示 | `/accounts` → 客户端 | 需要两边一起改：客户端目前忽略该字段 |

### 3.3 非路由前置条件：**已满足** ✅

- `package.json` 里 `./client` 子路径导出与 `dsh.client = { platform: 'web', immediately: true }`
  **都已经就位**（本次读取时已确认），所以壳会解析 `client.js`。
- 插槽名 `settings.section`，注册项 `{ name:'settings.section', id:'qq', order:40 }`
  （`order: 40` 排在内置区块 10..30 之后）。
- 客户端模块 id = 包名 = Host 行 id = `dsh-qq-plugin-group-expand`（三者必须一致）。
- 客户端 `inject: ['slots']`（客户端插件规范里 `inject` 只用于激活排序；缺了它，
  `ctx.slots` 尚不存在时 `apply` 会抛错，条目被记成 failed，启动审计会拒绝整个应用）。

---

## 4. 客户端**不**需要的东西（别多写）

| 微信契约里的东西 | QQ 版为什么不需要 |
|---|---|
| `status.enabled` | 用 `status.connected`（开关直接调 `/start` `/stop`） |
| `status.accounts[]`（`accountId`/`userId`/`polling`） | 换成 `GET /accounts`（§2.13） |
| `status.needsLogin` | QQ 没有等价的「凭据失效」标记；错误走 `status.errors` 与 `/login.failed` |
| `status.diagnostics.{logPath,statePath,workspace,logTail}` | 换成 `GET /log`（`{path,tail}`）+ `status.workspace`；`statePath` 不展示 |
| `GET /.dsh-qq-plugin-group-expand/diagnostics` | 客户端从不调用 |
| `POST /.dsh-qq-plugin-group-expand/toggle` | 存在但客户端不用（用 `/start` `/stop`） |
| `quoteHistory` | **QQ 不需要**：iLink 的 `ref_msg` 只有 `type:0 + msg_id`，微信为此自建了引用缓存；QQ 的 `msg_elements` 直接给被引正文（见 `lib/prompt.js`） |
| `POST /.dsh-qq-plugin-group-expand/credentials` | 客户端不调用（扫码是唯一入口；该路由保留给手工录入/脚本） |

> ⚠️ **`presenceNote` / `mergeWindowMs` / `autoReplyAttachments` / `maxReplyChars` 现在都已实现并有控件。**
> 这份文档早先写着它们"已从界面与文案里删除"——那是当时的真实状态，但**已过时**：
> 四项后来都补齐了（见 §2.8 的默认值表）。保留这条记录是因为它的教训仍然成立——
> **一份写着"已删除"的文档，会在功能补回来之后继续误导人。文档与代码不符时，以代码为准并回来改文档。**

---

## 5. 逐条渲染依赖（排查用速查表）

| 界面元素 | 依赖 |
|---|---|
| 整页能否渲染 | `GET /status` 成功（2xx + JSON） |
| 通道开关 | `status.connected`；写入靠 `/start` `/stop` 的返回值 |
| 「已绑定账号」行 / 「还没绑定」 | `GET /accounts` 的 `accounts[]`（空则用 `status.appId` 兜底） |
| 断开按钮 | `POST /disconnect` 的 `status` 字段 |
| 扫码卡片文案 | `/login` 的 `step`（宿主目前不发）→ 否则默认文案 |
| 二维码图片 | `/login` 的 `qrDataUrl`（且 `phase === 'running'`） |
| 轮询是否继续 | `/login` 的 `phase` 不在 {`idle`,`succeeded`,`already-bound`,`failed`} 中 |
| 验证码输入框 | `/login` 的 `awaitingVerifyCode === true`（宿主目前不发） |
| 「已连接 QQ / 之前绑过 / 登录失败」 | `/login` 的 `phase` ∈ {`succeeded`,`already-bound`,`failed`} |
| 权限下拉 | `/permission-presets` 的 `available` + `sentinel` + `applied`；写入靠 `/permission-preset` |
| 「行为设置」八个控件 + 一个全局「恢复默认」 | `GET /settings` 的 `settings` 与 `defaults`；写入靠 `POST /settings`（回传 `SETTINGS_FIELDS` 里的键） |
| 保存按钮 / 「已保存」 | 同上 |
| 诊断「事实」表 | `GET /log.path` + `status.workspace`/`conversationCount`/`pendingInteractions`/`replyLimiter` |
| 日志末尾 `pre` | `GET /log.tail`（字符串，取末 60 行） |
| 「最近错误」卡 + 诊断分组是否出现 | `status.errors` 非空，或 `/log` 成功 |
| 错误红字行 | 任意一次请求非 2xx 的 `error` |
| `client-error` 上报 | 20s 看门狗（设置段未注册）、`load()` 失败、`startLogin()` 失败、`saveSettings()` 失败、选择文件夹失败、渲染抛错 |

---

## 6. 不确定的地方（不要当成结论）

1. **QQ 扫码是否永远不需要配对验证码**：现有 connector 回调里没有这一环，
   所以 `/login/verify` 很可能永远用不到。**未实测**（需要真人扫一次码才能确认）。
2. **`onQrDisplayed` 的时序**：`login.js` 先落 `phase:'running'` + `qrUrl`，
   再异步补 `qrDataUrl`。客户端按「非终态即轮询」处理，所以中间这一小段没有二维码图是正常的。
   若实测发现 `starting` 会停留很久，应该优先在宿主侧补 `step`（§2.4），而不是改客户端。
3. **`settings` 是否需要持久化**：**需要，而且已经做了**——见 §2.9 结尾。
   契约只要求「读到的就是真的」；客户端**不假定**它会被持久化，宿主侧的持久化
   对页面而言是"顺带的好处"（重启后草稿初值仍是用户选的那份）。
4. **帮助链接**：`HANDBOOK_URL = 'https://bot.q.qq.com/wiki/'` 是 QQ 官方机器人文档站
   （搜索结果里具体页形如 `https://bot.q.qq.com/wiki/develop/api-v2/...`）。
   这不是本插件自己的手册——如果之后写了 `docs/HANDBOOK-USER.md` 之类，应换成自己的地址。
   没有沿用微信那种「插件仓库里的手册」链接，因为仓库里现在没有这份文档，链过去就是 404。
5. **`hasCredentials`**：`/accounts` 给了这个字段，但客户端没用。
   如果 AppSecret 被外部清掉（凭据文件受损），页面不会提醒——需要两边一起改才能做成警告。
6. **宿主并行改动**：本文的「现状」对照的是本次读取时刻的代码。若 `lib/routes.js` /
   `lib/runtime.js` 在你实现时又变了形状，请以代码为准并回来更新本文。
