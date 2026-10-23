# 事故记录（POSTMORTEM）

沿用 `dsh-wechat` 的惯例：**每一个真实遇到的失败都记在这里**，因为同一个坑会以不同面貌复发。

---

## 001 · `readFile` 从 `node:fs` 导入，导致状态永远读成空、回复被静默丢弃

**发现时间**：2026-10-10（第二步-1 垂直切片首次端到端测试）
**严重度**：高——功能完全不可用，且**没有任何错误信息**

### 症状

1. 在 QQ 里发消息，机器人一直显示"正在输入"，但**永远不回**。
2. 控制台每 4 秒一次 `200 OK`（那是 typing 刷新），看起来"在忙"。
3. 状态路由的 `conversationCount` 永远是 `0`，而 `state.json` 里明明有绑定。
4. `state.json` 的 `accounts` 与 `bindings` **互相覆盖**：每次写盘只留下当前改动的那一半。

### 根因

`lib/state.js` 里：

```js
import { readFile, renameSync, writeFileSync } from 'node:fs'   // ❌
```

`node:fs` 的 `readFile` 是**回调版** API。`await readFile(path, 'utf8')` 不会返回文件内容，
而是抛 `TypeError: callback must be a function`。这个异常落在 `#load()` 的 `catch` 里，
被当成"文件不存在"处理，于是：

```js
catch { return emptyState() }   // 每次都从这里返回
```

后果分两条：

- **读**：`read()` 永远返回空状态 → 助手流里"按 sessionId 找 conversationId"永远找不到 →
  `if (conversationId === undefined) return` → **回复被丢弃，且不报错**。
- **写**：`update()` 从空状态开始 mutate 再写盘 → 每次只写回自己那一半 →
  `accounts` 与 `bindings` 互相覆盖。

### 为什么没被测出来

离线自检当时只测了 `normalizeState`（纯函数），**没有测 `StateStore` 的真实磁盘往返**。
纯函数正确不代表 I/O 正确。

### 修复

1. 改成 `import { readFile } from 'node:fs/promises'`。
2. **不再把编程错误当成"文件不存在"**：只有 `error.code === 'ENOENT'` 才静默返回空状态，
   其余读失败一律经 `onError` 上报（由 runtime 记进 `boot.log` 与错误缓冲）。
3. 给 `scripts/verify.mjs` 加了 11 项**真实磁盘往返**断言，其中 5 项标 ⭐：
   - 先写 accounts 再写 bindings，第二次不能抹掉第一次
   - 换一个新实例读同一个文件，确认真的落盘
   - 并发 `update` 不丢数据
   - 损坏文件回退为空状态**且会上报**

### 教训

- **`node:fs` 与 `node:fs/promises` 混用是本项目最容易犯的错误之一。**
  前者是回调版，`await` 它得到的是 `undefined` 加一个被吞掉的异常。
- **"读失败 → 当作空"是一条危险默认值。** 它把"读不出来"变成了"什么都没有"，
  于是写盘时把真实数据覆盖掉。区分"不存在"与"读失败"是必需的。
- **静默失败优先于崩溃。** 崩溃会有人报；静默丢弃只会让用户觉得"它没理我"。
  凡是"按某个键找不到就 return"的路径，都要问一句：找不到时谁会知道？
- **纯函数测试不覆盖 I/O。** 状态层必须有真实的落盘-读回测试。

### 复现成本

装好插件并绑定后，在 QQ 里发任意消息即可 100% 复现（回复永不到达）。

---

## 002 · 凭据记录的 `kind` 写了非法值，导致用户的 DSH **完全无法启动**

**发现时间**：2026-10-10（第二步-1 导入凭据后首次重启）
**严重度**：最高——**整个桌面端起不来**，用户只能靠错误对话框的恢复按钮自救

### 症状

重启 DSH 后弹出「DeepSeek Harness is unavailable / The application could not start or stopped unexpectedly.」。
崩溃日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`）：

```
DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate

Failed plugins (1):
  credentials
    Package: @deepseek-ai/dsh-credentials-local
    Error: credentials-local: record "dsh-qq-plugin-group-expand/app-1905760478" in
           C:\Users\XCISXC\.dsh\.credentials.yaml has unknown kind "qqbot"

Plugins waiting for services (10):
  connection (required)  credentials
  authorization          credentials
  deepseek-account       credentials, authorization
  ...
```

连续 10 次重试，每次都崩。

### 根因

我在 `CredentialStore.save()` 里写了 `kind: 'qqbot'`。

`@deepseek-ai/dsh-credentials-local` 的 `parseRecord`（其 `lib/index.js:233`）是**严格**校验：

| kind | 允许的字段 |
|---|---|
| `api-key` | `kind` / `key` / `env` |
| `grant` | `kind` / `payload`（payload 任意 JSON） |
| 其它任何值 | → `unknown kind` 抛错 |
| **未定义字段** | → `unknown field` 抛错 |

而**凭据提供方加载失败会级联成致命启动失败**：

```
credentials 失败（它本身不在全局 required 列表里）
  → connection（全局 required）拿不到 credentials → 无法激活
    → auditStartupEntries 判定 "1 required plugin did not activate"
      → 拆卸整个应用并以非零码退出
```

全局 required 列表（`@deepseek-ai/dsh-app-boot` README）：
`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`。

**讽刺的是**：官方 `@deepseek-ai/dsh-credentials` 的 README 里示例写的就是
`{ kind: 'grant', payload: { token: '…' } }`——我读过那段，却仍写成了自定义值。

### 恢复过程（了解它，下次不必慌）

用户点了错误对话框第三个按钮「Disable third-party plugins, back up profile patch, and restart」，
它走的是 `@deepseek-ai/dsh-app-boot` 的 **`sanitizeProfile`**：

> Desktop 在原生致命错误恢复中调用它……将 profile 的 `cordis.patch.yml` 重命名为带唯一
> `.bak-<timestamp>` 后缀的同目录备份，并**恢复调用方指定的 bundle 列表**，保留已安装包和其他 manifest 字段。

结果：`dsh.profile.bundles` 被恢复成官方模板的两项，**`dsh-wechat-plugin` 被连带禁用**（无辜受害者）。

恢复办法是把 bundle 名字加回 `dsh.profile.bundles`。注意：**`dsh plugin add` 只管依赖、不管启用**，
CLI 没有「启用 bundle」的子命令，只有插件管理器（GUI「立即启用」）或直接改那个数组。

### 修复

1. `CREDENTIAL_KIND` 改为 `'grant'`，并在常量上写明封闭枚举、允许字段、以及写错的后果。
2. 新增 `ALLOWED_RECORD_KINDS`，`save()` 写入前**自我校验**；不合法就抛错让绑定失败——
   **宁可绑不上，也不能写坏这个全局共享文件**。
3. `scripts/verify.mjs` 增加 3 条断言（kind 必须是 `grant`、必须落在枚举内、枚举内容固定）。
4. 顺手把所有能导致**致命**的异步路径加固（见 003）。

### 教训

- **共享的、启动时解析的、严格校验的文件，写入前必须逐字段核对官方枚举。**
  这不是"防御性编程"——失败半径是**用户整个应用**，不是本插件。
- **`kind` 这类看似自由的字符串往往是封闭枚举。** 官方 README 的示例就是权威答案，照抄。
- **依赖倒置的致命性**：插件 A（optional）挂了会让依赖它的 B（required）挂，
  最终表现为"required 插件没激活"。排查要从**最底层的 failed 插件**看起，而不是从 required 列表看起。
- **恢复按钮会牺牲所有第三方插件。** 点一次恢复 = 第三方 bundle 全被摘掉，
  包括无关的、一直正常工作的那些。知道这一点，才能解释"为什么我的微信插件也消失了"。

### 复现成本

写入非法 kind 后重启一次即 100% 复现。

---

## 003 · 未处理的 rejection / 定时器同步抛出 —— 未被触发，但同样致命

**时间**：2026-10-10（修复 002 时的主动审计）
**严重度**：潜在最高（同样会让应用整个崩掉），**尚未被触发**

### 依据

`@deepseek-ai/dsh-app-boot` README 的「启动与重载失败」表里有两条**与 optional/required 无关**的规则：

| 失败模式 | 所有条目 |
|---|---|
| 脱离 `apply()` 返回 Promise 的异步任务产生**未处理 rejection** | 致命错误：释放应用并以非零码退出 |
| 同步回调（流的 `'data'` 监听器、定时器）在**进程生命周期任一时刻**抛出未捕获异常 | 同上 |

也就是说：本插件里任何一个 `void someAsync()`、任何一个 `setTimeout`/`setInterval` 回调，
只要漏一个 catch，就足以让用户的桌面端起不来。

### 审计发现的真实隐患（均已修复）

| 位置 | 问题 |
|---|---|
| `onAssistantFrame` | 裸 `void (async () => { … })()`，内部无 catch |
| 回复静默窗口的 `setTimeout` | 回调里裸 `void this.#flushReply(...)` |
| typing 的 `setInterval` | 回调直接调 `bot.sendTyping()`，**同步抛出**也没人接 |
| `flushReplies()`（卸载时调用） | 逐条 `await`，任一条失败会让 `halt()` reject |
| `index.js` 卸载路径 | 裸 `void runtime.halt()` |
| `index.js` 启动任务 | 内层已 catch，但缺外层兜底 |

### 修复

新增私有方法 `#fire(label, factory)`：同步 try/catch + Promise `.catch`，
**所有脱离 await 链的异步工作一律经它发起**。源码注释写明了为什么这不是可选的。

### 教训

- **"致命"的定义比想象中宽。** 在 DSH 里崩溃不只是 `apply()` 抛错；
  **任何迟到的、没人接的异常**都算。写插件时要假设宿主对未处理异常零容忍。
- **定时器和流回调是最高危的地方**：它们不在任何 await 链上，抛出去就没人接。
- **审计要系统化**：`grep 'void |setTimeout(|setInterval('` 应成为这类插件的常规体检。

---

## 004 · 客户端插件的顶层作用域是**所有插件共享的**，`const PREFIX` 撞车让整个应用起不来

**发现时间**：2026-10-10（设置页首次加载）
**严重度**：致命——**整个桌面端起不来**，而且报错不指名任何文件、行号或插件

### 症状

启动时弹出「DeepSeek Harness 无法使用」：

```
web boot: 1 entry did not activate
dsh-qq-plugin-group-expand: import failed (see console for the import error)
```

崩溃日志里的渲染进程控制台给出了真正的错误：

```
dsh-app://app/plugins/??@deepseek-ai/dsh-session-log-export/client.js,…,
  dsh-wechat-plugin/client.js,…,dsh-qq-plugin-group-expand/client.js,…&rev=…:20659
Uncaught SyntaxError: Identifier 'PREFIX' has already been declared
```

### 根因

**shell 会把每个已启用 bundle 的 `client.js` 拼进同一个脚本**（看那条 URL：
一次请求里用 `??` 列出全部 11 个客户端入口）。于是任意一份 `client.js` 在**顶层**
声明的 `const` / `function`，都是**所有其它插件文件共享的顶层声明**。

| 标识符 | `dsh-wechat-plugin` | `dsh-qq-plugin-group-expand` |
|---|---|---|
| `PREFIX` | :20 | :21 |
| `HANDBOOK_URL` | :31 | :32 |
| `reportFailure` | :34 | :88 |

**微信那份单独存在时完全正常**，我这份单独存在时也正常——两者一起加载就是
`SyntaxError`。这也是它难发现的原因：每个插件各自看都没问题。

### 为什么症状指向了错误的地方

报错只说 `dsh-qq-plugin-group-expand: import failed`，而**真正被破坏的是整个 bundle 的解析**。
`PREFIX` 是在**别人的文件**里先声明的，所以"新插件"看起来像罪魁祸首，
而实际上它是第二块多米诺骨牌。**11 个入口里任何两个重名都会这样。**

### 修复

把 `client.js` 整个包进 IIFE（`;(() => { … })()`），使其**不向共享作用域声明任何东西**。

刻意**不是**改名字：重命名只是把问题推迟到下一次撞车——第三个插件随时可能用掉
你已经占住的名字。IIFE 消除的是**这一类**失败。

### 本次事故的连带损失

DSH 的恢复按钮「禁用第三方插件、备份 profile patch 并重启」被按下后，
`sanitizeProfile` 把 `dsh.profile.bundles` 重置为只剩两个官方项——
**微信插件也一起被禁用了**（两者本都正常）。恢复时需要把两个 bundle 都写回去。

### 新增的常设检查

`tools/check-client-scope.mjs`：枚举全部客户端入口（含从 `app.asar` 导出的官方入口），
按 shell 的方式拼接后用 `new Function` 解析一遍。

> **现名 `tools/check-cross-plugin.mjs`。** 它后来还多查了一件事——**宿主工具重名**
> （见 006），所以名字里的 "client-scope" 不再准确。
> 这条**故意不改写**：postmortem 记的是当时发生了什么，而当时它确实叫那个名字。
> 本项目的规矩是"文档与代码不符时以代码为准并回来改文档"，但**历史记录不改**——
> 改了就等于抹掉"我们当时以为它只查客户端作用域"这件事。
> 新名字见 `README.md` 与 `docs/RELEASING.md`。

**它带自检**：把自己的 IIFE 拆掉后必须报出 `Identifier 'PREFIX' has already been declared`。
一个永远通过的检查器毫无价值——自检失败即判定不可信。

### 教训

- **客户端插件的顶层不是你的私有领地。** 宿主文档说客户端入口"以模块作用域注册"，
  但**没有说这些模块共用一个作用域**。任何顶层声明都是一次全局抢占。
- **本地全绿证明不了共存。** 两个插件各自的测试都会通过，因为冲突只在**别人也在场**时才存在。
  凡是"共享一份资源"的机制（作用域、全局 CSS 类名、事件名、存储键），
  都需要一个**跨插件**的检查，而不是各自的检查。
- **静态子串检查要看代码而不是注释。** 修完这次事故后，我在 `client.js` 的文件头注释里
  写下了 `dsh-wechat-plugin/client.js` 来解释原因，结果 `verify-client.mjs` 里
  "不得残留 `dsh-wechat`" 那条立刻误报。检查器现在先剥掉块注释再判断
  （只剥块注释，因为源码里有 `https://` 这种含 `//` 的字面量）。

---

## 005 · 忘了 import 一个常量，导致**所有带附件的消息被整条丢弃**

**发现时间**：2026-10-10（入站媒体首次实测）
**严重度**：高——媒体功能**完全不可用**，且症状指向三个不同的地方

### 症状

用户报了三条，看起来像三个独立问题：

1. 语音上传**没反应**
2. 图片上传后回复**有严重错误**
3. `C:\Users\XCISXC\.dsh\dsh_qq\媒体\` **找不到**

### 根因

一条日志：

```
ERROR 处理入站消息失败: ReferenceError: WORKSPACE_DIR_NAME is not defined
```

`WORKSPACE_DIR_NAME` 定义在 `lib/paths.js` 并已导出，但 `lib/runtime.js`
**忘了 import 就直接用**。于是 `#park()` 在计算媒体目录时抛出，
`#handleInbound` 的 catch 把它记成一行错误——**而那条消息就此消失**。

三个症状其实是**同一个原因**：

- 媒体目录从没被创建（`#mediaDir()` 抛在 `mkdirSync` 之前）
- 语音与图片都走 `#park()`，所以都没反应
- 图片那条的"严重错误"是 agent 在回答一张**它根本没收到**的图——
  附件的落盘路径与说明文字一起被丢弃了

### 为什么现有的检查全都放过它

| 手段 | 为什么没抓到 |
|---|---|
| `node --check` | 只做语法解析，自由变量在解析阶段完全合法 |
| 模块加载测试 | 文件能正常加载——抛错只在**执行到那一行**时发生 |
| 单元测试 | `media.js` 单独测时不需要 `WORKSPACE_DIR_NAME`；要触发它得有一条真实入站消息 |
| 端到端测试 | 那时还没做，而用户就是端到端测试 |

### 修复与新检查

补上 import。并新增 `tools/check-unbound.mjs`——一个有针对性的迷你 `no-undef`，
只查 **SCREAMING_SNAKE_CASE** 标识符（常量/配置名正是这类事故的常客），
扫描前用状态机剥掉注释与字符串字面量（模板字面量只剥字面部分、保留 `${…}`）。

**它自己也踩了三个坑，都值得记：**

1. **假阴性（最危险）**：第一版有一条"`NAME,` / `NAME)` 即函数参数"的模式，
   于是把 `mediaDir(this.#home, WORKSPACE_DIR_NAME)` 里的**调用实参**也当成了绑定，
   **对它本该抓的那个 bug 报了"通过"**。假阳性会被看见并修掉，假阴性会被当成没问题。
2. **假阳性**：把 `process.env.DSH_HOME` 里的 `DSH_HOME` 当成了自由变量。
   现在排除"前面是 `.`"（属性访问）与"后面是 `:`"（对象键）。
3. **又一个假阴性**：单名 import 时把捕获原文（含空格）加进了绑定集合，
   于是 `import { WORKSPACE_DIR_NAME } from './paths.js'` 反被判成"未绑定"。
   多名的走切分分支所以正常——这个不对称正是它藏得住的原因。

最后做了**双向对照**：修好的代码 0 报错；把 import 去掉立刻重新抓到；恢复后又归 0。

### 教训

- **"功能没反应"和"功能报错"可能是同一个原因。** 用户看到的是三个症状，
  根因是一条 `ReferenceError`。**先读日志，不要先猜三个 bug。**
- **自由变量是语法检查的盲区。** 不做作用域分析的静态检查看不见它，
  而那条路径可能极少被走到——这次是"只有带附件的消息才会走到"。
- **检查器必须做反向对照。** 一个只会报"通过"的检查器，和没有检查器一样，
  而且更糟：它让人以为已经验过了。

---

## 006 · 工具名与微信插件撞车，QQ 的自然语言会话控制**从未生效过**

**发现时间**：2026-10-10（第三步准备做按钮时的状态巡检）
**严重度**：中高——一个功能**从头到尾没工作过**，而且只留一行错误

### 症状

`C:\Users\XCISXC\.dsh\qq\boot.log` 里反复出现：

```
ERROR 注册 session_control 失败: Error: tool "session_control" is already registered
      (for a per-agent variant, register through that agent's `ctx` instead)
```

它出现在**每一次启动**里，但没人注意到——因为插件其余部分都正常，而日志里
SDK 的 info 行很多，这一条 ERROR 被淹没了。

### 根因

宿主作用域下 `ctx.tools.register` 的**名字是全局唯一的**。`dsh-wechat-plugin`
注册了一个叫 `session_control` 的工具，而 QQ 这边**也叫这个名字**。

`dsh.profile.bundles` 里微信排在 QQ 前面，于是**先到者胜**：
微信那份注册成功，QQ 那份抛错——而我在 `registerTools()` 里用 try/catch 逐个包住，
所以失败只留一行错误，**插件照常启动，功能静默不可用**。

后果：**QQ 的自然语言会话控制（「查看对话列表」「换个对话」）从头到尾没有生效过。**
用户会以为 agent "不愿意"调工具，而真相是那个工具根本不在注册表里。

### 为什么"两边的测试都通过"证明不了什么

微信的测试只测微信，QQ 的测试只测 QQ，**两边各自都是绿的**。
冲突只在**别人也在场**时才存在——这与 004（客户端顶层作用域共享）是**同一类**问题，
只是共享的资源不同：一个是作用域，一个是名字空间。

### 修复与新检查

改名 `qq_session_control`（`send_to_qq` / `notify_qq` 之所以没事，是因为微信用的是
`send_to_wechat` / `notify_wechat`——名字里的目标本来就分开了）。

并把工具重名检查并入 `tools/check-client-scope.mjs`，它因此改名为
**`tools/check-cross-plugin.mjs`**：它现在同时检查两类"跨插件共享资源"——
客户端顶层作用域，与宿主工具名。

### 教训

- **凡是"共享一份资源"的机制都要有跨插件检查**：作用域、全局 CSS 类名、事件名、
  存储键、**工具名**。各自的测试永远发现不了这类冲突。
- **"注册失败只记一行"是危险的默认行为。** 它让"功能不存在"看起来和"功能存在但没被调用"一样。
  更该做的是：把这类失败**在启动日志里显眼地报出来**，而不是藏在 info 行中间。
- **长时间不被注意的 ERROR 会变成背景噪音。** 这一条从第一次启动就在，
  而我直到为了做别的事去巡检状态时才看见它。

---

## 007 · 一个参数从头到尾没人接：`/new <标题>` 的标题**从未到达宿主的会话标题**

**发现时间**：2026-10-13（修"首条消息被拆成两条"时顺带查出）
**严重度**：中——一个看起来在工作的功能，实际只写了半程

### 症状

用户报的是另一个问题：

> 新建会话或切换会话的第一条消息，渠道消息和用户发的会分开——我发「你好」，
> 会发「你好」再发「[渠道：QQ] 你在和 QQ 上的用户对话…」

即 agent 收到**两条**先后独立的用户消息。根因是为了保住会话标题而在首条消息上做的拆分
（合并会让标题被渠道说明污染，见下），代价没算清：**那第二条 prompt 会自己引发一轮回复**。

### 修标题时掉出来的第二个洞

修法是"合并成一条 + 创建会话时显式给标题"。**但第二步如果照原样写，是个空操作。**

链路上有**三段**，每段都看着像把标题传下去了：

| 段 | 形态 | 真相 |
|---|---|---|
| 运行时 | `ensureSession(sessionId, title)` | **只收 sessionId，title 从未被使用** |
| 路由 | `#bind(params, requestedTitle)` | 收了，写进**绑定标签**就算完 |
| 宿主 | `sessionController.create(request)` | **请求里根本没有 title 字段**（`requested identity, location, and Agent preset`） |

**唯一吃显式标题的入口是 `rename`。** 所以 `/new 写周报` 这个功能，
从实现的第一天起就是"把「写周报」写进插件自己的绑定标签，而宿主的会话标题照旧由首条消息猜"。

**它看起来完全正常**：`/new 写周报` 会回「已新建对话「写周报」」，之后 `/current` 也印「写周报」——
因为那两处读的都是**绑定标签**。只有 DSH 桌面端的会话列表里，
标题是首条消息的前几个词，而不是「写周报」。

### 为什么没人发现

**两个地方都自洽，只有把它们对起来才看得出。**
插件侧每一条断言都过（标签确实是「写周报」），宿主也正常工作（它按约定从首条消息取标题）。
**缺的是"我传出去的东西，对面真的收下了吗"这一问。**

这与 006（工具名撞车）是同一族：**接口存在、参数存在、调用发生，而作用没有发生。**
区别是 006 还留了一行 ERROR，这一条**连一行都没有**——`ensureSession` 的第二个参数
安静地躺在签名里，多余实参在 JS 里是合法语法。

### 修法与防线

- 网关新增 `createSession(sessionId, title)`：adopt 之后调 `rename` 把标题钉住
  （`rename` 的语义是"以此取代自动命名，之后消息不再触发"），best-effort，失败只记一行
- `ensureSession(sessionId)` 回归"只确保会话活着，**永不动标题**"——
  一个名字里带 title 的参数却不用它，是下一次误会的种子
- 两处多余实参删除

- **`fallbackSessionTitle` 的实际参数是 5 词 / 40 字节**，出处是
  `@deepseek-ai/dsh-base/cordis.patch.yml:58-59`——**而 README 里写的 8/96 只是文档示例。**
  照 README 抄会让插件生成的标题与 DSH 自己生成的长度不一致，
  这种差异几乎不可能在界面上看出来。

### 教训

- **"参数传下去了"不等于"作用发生了"。** 每一层都要问最后一句：
  **有什么可观测的东西证明对面收下了？** 没有的话，那就是没接上。
- **文件是唯一会说真话的地方。** 这一条的关键证据全部来自解包后的宿主源码
  （`create` 的 JSDoc、`rename` 的语义、`cordis.patch.yml` 的部署值），
  而不是任何一份 README。
- **一个收下却不使用的参数，比没有这个参数更危险**——它让调用方以为自己做到了。




