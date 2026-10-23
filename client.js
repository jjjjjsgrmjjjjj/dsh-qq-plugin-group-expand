/**
 * Browser half of the settings page (QQ channel).
 *
 * This is a client plugin bundle. The shell registers it through
 * `window.__ModuleLoader__.load({ id, factory })`, and the factory receives a
 * `require` that resolves the platform baseline (React among it). The factory
 * returns the module exports directly, which is the documented shape.
 *
 * The page talks to the host half over the `/.dsh-qq-plugin-group-expand` routes, which is why the
 * binding handshake lives on the host: QQ binding is a QR scan at
 * `q.qq.com/qqbot/openclaw/connect.html`, so the page can be closed and reopened
 * mid-scan without losing the QR code.
 *
 * The registration call is deliberately bare and runs at module scope. Wrapping it
 * in a guard would swallow a failure at precisely the moment nothing else can report
 * it: a client entry that never registers simply fails activation, with no trace
 * anywhere. Diagnostics therefore live inside the factory and `apply`, after
 * registration has already happened.
 *
 * ## Why the whole file is wrapped in an IIFE
 *
 * ⚠️ **Client plugin files share one top-level scope.** The shell concatenates every
 * `client.js` of every enabled bundle into a single script (the page asks for
 * `plugins/??a/client.js,b/client.js,…` in one request), so a top-level `const`
 * declared here is a top-level `const` in *every other plugin's* file too.
 *
 * That is exactly how this plugin first broke `web boot`:
 *
 * ```
 * Uncaught SyntaxError: Identifier 'PREFIX' has already been declared
 * web boot: 1 entry did not activate
 * dsh-qq-plugin-group-expand: import failed
 * ```
 *
 * `dsh-wechat-plugin/client.js` also declares `PREFIX`, `HANDBOOK_URL` and
 * `reportFailure` at its top level. Each was fine alone; together they are a
 * `SyntaxError` that takes the **entire application** down, not just this plugin —
 * and the failure names no file, no line and no plugin.
 *
 * So this file declares nothing at the shared scope. Renaming the identifiers would
 * only postpone the problem to the next collision; the IIFE removes the class of
 * failure. **Any new client plugin must do the same**, because a third plugin can
 * always reuse a name you already took.
 */

;(() => {

const PREFIX = '/.dsh-qq-plugin-group-expand'

/**
 * Where the user documentation lives, for the link in the settings page.
 *
 * The handbook for this plugin, written for someone who is not going to read the source: what it is
 * for, how to bind, what it accepts, and what every setting does. A rendered page rather than the
 * raw file in the repository, because it is long and full of tables and that is the reading-friendly
 * form. Opened as an ordinary `target="_blank"` anchor, which the desktop shell intercepts and hands
 * to the system browser — the same way its own links work. A `window.open` or a scripted navigation
 * would be denied by that same handler, so the anchor is not a style choice, it is the mechanism.
 *
 * The official QQ bot documentation (`https://bot.q.qq.com/wiki/`) used to be this link. It is the
 * wrong destination: it explains the platform, not this plugin, and someone sent there to find out
 * which switch stops the agent asking before every command finds nothing about it.
 */
const HANDBOOK_URL = 'https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand/blob/main/docs/HANDBOOK-USER.md'

/**
 * The settings fields this page owns.
 *
 * `/settings` may carry more than these — the host's payload also carries `permissionPreset`, which
 * has a control of its own. Only the keys listed here are ever sent back on Save, so saving cannot
 * overwrite a setting this page does not manage. That is not hypothetical: with `permissionPreset`
 * riding along in the draft, pressing Save would post the value the page loaded with and silently
 * undo the switch the user had just made in the permission selector.
 *
 * `presenceNote` belongs here like any other tunable: it is stored state the user may edit, and the
 * per-field reset puts the host's own default back rather than a copy kept in this file.
 *
 * `workspacePath` is the one string field where an empty value carries meaning: it asks for the
 * default location. So it is saved like any other string and never dropped as "not filled in" — `''`
 * has to reach the host as `''`, which is why neither this list nor the input treats it as unset.
 */
const SETTINGS_FIELDS = [
  'newSessionsReadOnly',
  'requireConfirmation',
  'allowCrossSessionNotify',
  'settleMs',
  'presenceNote',
  'mergeWindowMs',
  'autoReplyAttachments',
  'maxReplyChars',
  'workspacePath',
  /*
   * Group chat.
   *
   * The host owns several more group settings than the page shows (speak lines, hourly cap,
   * context window, emoji fallback). Only the ones with a control here are posted back: the rest
   * keep their stored value, which is the same rule `permissionPreset` follows.
   */
  'groupChatEnabled',
  'groupCollectStickers',
  'groupAutoSpeak',
  'groupFollowUpWindowMs',
  'groupPersonaNames',
  'groupAutoSpeakKeywords',
  'groupSpeakCooldownMs',
  'groupStickerDir',
  'groupStickerChance',
]

/**
 * Whether a binding attempt is still in flight.
 *
 * A blacklist of settled phases rather than `phase === 'running'`, deliberately. The host goes
 * through intermediate phases on the way to a QR code (`starting`, plus `saving` while it stores the
 * credentials), so polling that stopped on anything but the exact word `running` would leave the card
 * with no QR code and no further reads — the failure looks like "nothing happened". An unrecognised
 * phase counts as in flight, which is the safe direction: the worst case is a few wasted polls.
 */
function loginInFlight(phase) {
  return (
    typeof phase === 'string' && !['idle', 'succeeded', 'already-bound', 'failed'].includes(phase)
  )
}

/**
 * Shallow shape guards.
 *
 * A throw inside a slot entry blanks the whole entry, and all that is left anywhere is one line
 * reading `slot entry crashed in 'settings.section'`. Every value that crosses the HTTP boundary
 * is therefore read through one of these rather than assumed.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Render a scalar for display; anything unexpected becomes the fallback. */
function asText(value, fallback = '—') {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return fallback
}

/** Report a client-side failure to the host, which writes it to the boot log. */
function reportFailure(scope, error) {
  try {
    const payload = JSON.stringify({
      scope,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : '',
    })
    // `sendBeacon` survives a page that is being torn down; fetch is the fallback.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(`${PREFIX}/client-error`, new Blob([payload], { type: 'application/json' }))
      return
    }
    void fetch(`${PREFIX}/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Reporting must never be the reason the page fails.
  }
}

/**
 * Whether a value that was sent is the value that was stored.
 *
 * Loose on purpose: the host rounds the numbers and trims the workspace path, so an exact
 * comparison would call every ordinary save partly ignored. Strings are compared trimmed because
 * trimming is exactly what the host does to them; a trailing space disappearing is not the user
 * being lied to.
 *
 * @param sent - Value the page sent.
 * @param stored - Value the host answered with.
 * @returns True when the host kept the value.
 */
function sameSetting(sent, stored) {
  if (typeof sent === 'number' && typeof stored === 'number') return Math.round(sent) === Math.round(stored)
  if (typeof sent === 'string' && typeof stored === 'string') return sent.trim() === stored.trim()
  return sent === stored
}

/**
 * The keys of `sent` whose value is not the value `stored` holds.
 *
 * @param sent - The patch that was posted.
 * @param stored - The settings the host holds.
 * @returns Keys that differ.
 */
function changedKeys(sent, stored) {
  if (!isRecord(sent) || !isRecord(stored)) return []
  return Object.keys(sent).filter((key) => !sameSetting(sent[key], stored[key]))
}

/**
 * The names of the settings the host did not keep.
 *
 * `lib/settings.js` drops a field it cannot accept — out of range, wrong type — and keeps the old
 * value, while the reply carries what is stored. Comparing the two turns that silent drop into
 * something the user can see, and it covers every field at once rather than the ones somebody
 * remembered to check. Without it the page prints 已保存 over a value that quietly went back to
 * what it was, which is how a user comes to believe a setting is in effect when it never was.
 *
 * @param sent - The patch that was posted.
 * @param stored - The settings the host answered with.
 * @param t - Copy table, for the names shown to the user.
 * @returns Labels of the fields that did not stick.
 */
function ignoredSettings(sent, stored, t) {
  return changedKeys(sent, stored).map((key) => (typeof t[key] === 'string' ? t[key] : key))
}

/**
 * Whether the form holds changes that are not stored yet.
 *
 * Every control on the page writes to the draft and none of them saves, and a filled box looks
 * exactly like a stored value. Saying so is the difference between "it did not work" and "I did not
 * save it". Only the fields this form owns are compared: `permissionPreset` has a control of its
 * own that applies on the spot, so it is not part of this form's unsaved state.
 *
 * @param state - Page state.
 * @returns True while the form differs from what is stored.
 */
function draftIsDirty(state) {
  if (!isRecord(state.draft) || !isRecord(state.settings)) return false
  const draft = {}
  for (const key of SETTINGS_FIELDS) {
    if (key in state.draft) draft[key] = state.draft[key]
  }
  return changedKeys(draft, state.settings).length > 0
}

window.__ModuleLoader__.load({
  id: 'dsh-qq-plugin-group-expand',
  factory: (require) => {
    /**
     * Whether the settings section has been registered with the shell's slot registry.
     *
     * This is the watchdog's health signal, and it is deliberately *not* "the page rendered".
     * The bundle loads at application start (`dsh.client.immediately`), while the component only
     * mounts when the user opens 设置 → QQ — so on every launch that stays in the conversation
     * view, "nothing rendered within 20 seconds" was the *normal* state, and the old signal
     * reported it as a failure once per boot. The old flag lived in the component body, which is
     * precisely the place that does not run on such a launch; it now moves to the step whose
     * failure it is supposed to name.
     *
     * Registration is a fact worth watching, and it is one this side can prove: it says the
     * factory ran, `apply` ran, `ctx.slots` existed, and the shell accepted the section — so the
     * shell renders it whenever that section is opened. It says nothing about *how* that render
     * goes; `watchSectionRenderErrors` names what is covered and what is not.
     */
    let sectionRegistered = false

    // Armed here rather than at module scope so the timer cannot interfere with
    // registration, which happens before any factory runs.
    try {
      setTimeout(() => {
        if (!sectionRegistered) {
          // Scoped `register`, not `mount`: this line reports the step that failed, and the old
          // name described a step this watchdog never watched. A stale label misleads exactly the
          // way a stale success condition does.
          reportFailure(
            'register',
            new Error('插件已加载，但没能把「QQ」设置页注册到 DSH（20 秒看门狗触发）'),
          )
        }
      }, 20_000)
    } catch {
      // A missing timer must not prevent loading.
    }

    const React = require('react')
    const h = React.createElement

    const copy = {
      zh: {
        nav: 'QQ',
        title: 'QQ 遥控',
        intro: '用手机 QQ 遥控这台电脑。扫码绑定一次，之后一直有效。',
        statusTitle: '通道状态',
        enabled: '启用通道',
        enabledHint: '关掉后不再接收 QQ 消息，凭据保留。',
        accounts: '已绑定账号',
        noAccounts: '还没绑定。点下面的按钮扫码。',
        polling: '已连接',
        idle: '已停止',
        needsLogin: '凭据已失效，需要重新扫码。',
        loginTitle: '扫码绑定',
        loginStart: '开始扫码',
        loginAgain: '重新扫码',
        loginCancel: '取消',
        qrAlt: 'QQ 绑定二维码',
        qrHint: '用手机 QQ 扫一扫，并在手机上确认。',
        verifyTitle: '需要配对验证码',
        verifyHint: '在手机上查看验证码后填入。',
        verifySubmit: '提交',
        verifyPlaceholder: '验证码',
        phaseSucceeded: '已连接 QQ',
        phaseAlreadyBound: '这个机器人之前绑过，继续用原有凭据',
        phaseFailed: '登录失败',
        errorsTitle: '最近错误',
        loading: '读取中…',
        loadFailed: '读取设置失败',
        retry: '重试',
        saveFailed: '保存失败',
        /*
         * The names of the settings the host refused, appended to `saveIgnored` when a save leaves
         * one of them at its old value.
         */
        saveIgnored: '这些值没有被主机接受，已改回实际生效的值：',
        settingsTitle: '行为设置',
        /*
         * Two facts, and both were missing before.
         *
         * The save needs an explicit click and nothing on the page said so, while the old line here
         * ("改完生效，不用重启") read as "already applied" — which is how a user comes to believe a
         * value is stored when it was never sent. Every field below *is* live in this plugin
         * (`runtime.js` reads them per message and `#switchWorkspace` runs on the spot), so the
         * second half stays; what was missing is the click.
         */
        settingsHint: '改完点「保存设置」。这里所有设置都立即生效，不用重启。',
        settingsDirty: '有改动还没保存。',
        requireConfirmation: '会话操作先确认',
        requireConfirmationHint: '你说「换个对话」这类要求时，DSH 会先说它要做什么，等你同意再执行。',
        allowCrossSessionNotify: '允许其他会话推送到 QQ',
        allowCrossSessionNotifyHint:
          '开启后，任何会话都能主动发消息或文件到 QQ——包括你正在电脑上干活、它做完后通知你的情况。关掉则只有 QQ 对话自己那个会话能发。',
        settleMs: '回复聚合静默窗口（毫秒）',
        settleMsHint: '间隔小于这个值就合并成一条。调大更完整但更慢，调小更快但可能拆成多条。',
        mergeWindowMs: '附件合并窗口（毫秒）',
        mergeWindowHint: '用户先发图再打字时，等这么久把它们合成一次提交。填 0 表示不等待。',
        autoReplyAttachments: '等不到文字就自动处理附件',
        autoReplyAttachmentsHint: '关掉不是忽略附件，而是等用户说了话再一起回答。',
        maxReplyChars: '单条回复字数上限',
        maxReplyCharsHint: '超过就作为 .md 文件发送，不截断。填 0 表示不限制。',
        presenceNote: '渠道上下文说明',
        presenceNoteHint: '这段话只在每个新对话的第一条消息里交给 agent，告诉它你在手机上、看不到这台电脑的屏幕和文件系统。之后不再重复，省 token。',
        workspacePathLabel: '会话文件夹路径',
        workspacePathHint:
          '留空表示用默认位置。必须是绝对路径，例如 D:\\QQ会话。已有的对话留在原来的文件夹，只有之后新建的对话才用新路径。',
        workspacePathPick: '选择…',
        workspacePathPickFailed: '选择文件夹失败',
        workspacePathCurrent: '当前生效：',
        /*
         * Group chat. The headings and hints carry the two facts a user cannot guess:
         * the bot only speaks when the persona is invoked, and QQ only delivers @ messages
         * to ordinary bots.
         */
        groupChat: '群聊',
        groupChatHint: '群里只在被 @ 或提到人格时说话；没提到就不发言。',
        groupChatEnabled: '启用群聊',
        groupChatEnabledHint:
          '关掉后群消息一律不回应，私聊照常。普通机器人默认只收得到群里 @ 它的消息——看不到全部群聊时，关键词触发只能从 @ 消息里发生。',
        groupCollectStickers: '收藏群里的表情包',
        groupCollectStickersHint:
          '群里像表情包的方形小图会自动收进表情包文件夹的 collected/ 子目录，不发言也不打扰群聊；最多存 300 张，重复的只留一份。',
        groupAutoSpeak: '关键词 / 语境自动接话',
        groupAutoSpeakHint:
          '提到人格时用下面的短句和表情包接一句，不调用模型；@ 消息不受这个开关影响，照常回答。',
        groupFollowUpWindowMs: '被 @ 后连续对话窗口（毫秒）',
        groupFollowUpWindowMsHint:
          '被 @ 一次后，这段时间内群里继续说话不用再 @，也不再按关键词/人格筛——每条文字消息都交给 agent 判断要不要回，无关就保持沉默。只有新的 @ 会续期，聊天本身不续期；填 0 回到每条都要 @。默认 300000（5 分钟）。',
        groupPersonaNames: '人格名（逗号分隔）',
        groupPersonaNamesHint:
          '人格是「鲸鱼娘」。大肥鱼是旧绰号，默认忽略——群里如果还这么叫，把它加进这里就会重新认。第一个名字是主称呼。',
        groupAutoSpeakKeywords: '接话关键词（逗号分隔）',
        groupAutoSpeakKeywordsHint:
          '当前消息含这些词、且前文刚提过人格时才会接话；单独出现不算，避免把群友的闲聊当成叫它。',
        groupSpeakCooldownMs: '接话最短间隔（毫秒）',
        groupSpeakCooldownMsHint: '同一个群两次自动接话之间至少等这么久，防止刷屏。',
        groupStickerDir: '表情包文件夹',
        groupStickerDirHint:
          '留空用默认位置（DSH 主目录下的 qq/stickers）。你导入的 png/jpg/gif/webp 放根目录；群里收藏的自动进 collected/。接话时两处一起随机挑，没有图就用 emoji。',
        groupStickerChance: '带表情包的概率（0–100）',
        groupStickerChanceHint: '没抽中或文件夹为空时，用 emoji 代替表情包。',
        settingsSave: '保存设置',
        settingsSaved: '已保存',
        settingsReset: '恢复默认',
        disconnect: '断开连接',
        disconnectHint: '断开后要重新扫码才能连上。DSH 里的会话都保留。',
        disconnectConfirm: '确认断开？',
        groupConnection: '连接',
        groupConnectionHint: '开关通道、绑定 QQ 机器人。',
        groupPermissions: '权限',
        groupPermissionsHint: '本频道之后新建的会话用哪套权限。',
        permissionPreset: 'QQ 对话的权限预设',
        permissionPresetHint:
          '只影响之后新建或采纳的会话；DSH 在会话第一个回合开始后就锁定预设。默认「仅可查看」：新开的窗口只能看，不会直接执行命令。要让某条新会话动手，先关掉下面的「新会话强制仅可查看」，再把这里切成「完全访问」或「工作区可写」。',
        permissionReadOnly: '仅可查看：不写文件，也不执行命令',
        permissionWorkspaceWrite: '工作区可写：只改当前文件夹',
        newSessionsReadOnly: '新会话强制仅可查看',
        newSessionsReadOnlyHint:
          '默认开。开启时，之后新建或采纳的每条 QQ 会话都只读，不看上面的预设；关掉后才按预设走。已有会话不受影响。',
        permissionFull: '完全访问：不询问，直接执行',
        permissionAuto: '自动审核：电脑上判断',
        permissionProfile: '跟随 DSH 设置：和桌面端一样',
        permissionUnavailable: '此组合没有可选的权限预设。',
        permissionSwitching: '切换中…',
        groupBehaviour: '行为',
        groupBehaviourHint: '通道收到消息后怎么处理。',
        groupDiagnostics: '诊断',
        groupHelp: '帮助',
        helpTitle: '使用手册',
        helpHint: '出门在外怎么用、能发什么、每一项设置是什么意思——都在这里。',
        helpOpen: '打开使用手册',
        groupCommands: '指令',
        commandsSlash: '斜杠指令',
        commandsSlashHint: '在 QQ 里直接发送。不经过 agent，也不问确认，最快。',
        commandHelp: '显示指令列表',
        commandNew: '新建对话，可带标题',
        commandList: '列出所有对话',
        commandSwitch: '切换到第 N 个对话',
        commandModel: '查看有哪些模型和推理等级；带上名字或编号就切换。只换等级：/model 等级 high',
        commandCurrent: '显示当前对话',
        commandCancel: '中断当前任务',
        commandsSeparator: '分隔符可用「：」或直接省略，例如 /switch1。',
        commandsPlain: '说大白话也可以',
        commandsPlainHint:
          '直接说「换个对话」「看下有哪些对话」「停一下」等，任意说法都行。DSH 会先说明它要做什么，你同意后再执行——想跳过这一步，把下面的「会话操作先确认」关掉。',
        diagnosticsTitle: '诊断',
        diagnosticsHint: '日志记录了通道的每一次收发与失败。',
        logPath: '日志文件',
        workspacePath: '会话工作目录',
        conversationCount: '对话数',
        pendingInteractions: '待回答交互',
        replyLimiter: '被动回复限流',
        logTail: '日志末尾',
        noLog: '（暂无日志）',
      },
      en: {
        nav: 'QQ',
        title: 'QQ remote',
        intro: 'Control this machine from QQ on your phone. Scan once to bind.',
        statusTitle: 'Channel',
        enabled: 'Enable channel',
        enabledHint: 'Off stops receiving QQ messages; credentials are kept.',
        accounts: 'Bound bot',
        noAccounts: 'Nothing bound yet. Scan with the button below.',
        polling: 'connected',
        idle: 'stopped',
        needsLogin: 'Credentials expired. Scan again.',
        loginTitle: 'Scan to bind',
        loginStart: 'Start scanning',
        loginAgain: 'Scan again',
        loginCancel: 'Cancel',
        qrAlt: 'QQ binding QR code',
        qrHint: 'Scan with QQ on your phone, then confirm there.',
        verifyTitle: 'Pairing code required',
        verifyHint: 'Check the code on your phone and enter it.',
        verifySubmit: 'Submit',
        verifyPlaceholder: 'Code',
        phaseSucceeded: 'Connected to QQ',
        phaseAlreadyBound: 'Already bound; existing credentials kept',
        phaseFailed: 'Login failed',
        errorsTitle: 'Recent errors',
        loading: 'Loading…',
        loadFailed: 'Could not read the settings',
        retry: 'Retry',
        saveFailed: 'Could not save',
        saveIgnored: 'The host did not accept these values, so they were put back to what is in effect:',
        settingsTitle: 'Behaviour',
        settingsHint: 'Press « Save » after a change. Everything here takes effect at once; no restart.',
        settingsDirty: 'Changes are not saved yet.',
        requireConfirmation: 'Confirm before acting on a request',
        requireConfirmationHint:
          'When you ask for something like «switch conversation», DSH first says what it will do and waits for you to agree.',
        allowCrossSessionNotify: 'Let other sessions push to QQ',
        allowCrossSessionNotifyHint:
          'On, any session may send you a message or a file — which is how a task that finishes while you are away can still reach you. Off, only the session the QQ conversation is bound to may send.',
        settleMs: 'Reply merge window (ms)',
        settleMsHint:
          'Gaps smaller than this merge into one message. Larger is more complete but slower; smaller is faster but may split.',
        mergeWindowMs: 'Attachment merge window (ms)',
        mergeWindowHint:
          'When you send a picture and then type, this is how long the two wait before being combined into one submission. 0 does not wait.',
        autoReplyAttachments: 'Handle attachments if no text arrives',
        autoReplyAttachmentsHint:
          'Off does not ignore attachments: the batch is kept and answered once you say something.',
        maxReplyChars: 'Reply length limit (characters)',
        maxReplyCharsHint: 'A longer reply is sent as a .md file rather than cut short. 0 means no limit.',
        presenceNote: 'Channel context note',
        presenceNoteHint:
          'This note is handed to the agent only with the first message of each new conversation, so it knows you are on a phone and cannot see this computer’s screen or filesystem. It is not repeated afterwards, saving tokens.',
        workspacePathLabel: 'Session folder path',
        workspacePathHint:
          'Leave empty to use the default location. Must be an absolute path, for example D:\\QQ会话. Conversations that already exist stay in their old folder; only conversations created afterwards use the new path.',
        workspacePathPick: 'Choose…',
        workspacePathPickFailed: 'Could not choose a folder',
        workspacePathCurrent: 'In effect: ',
        groupChat: 'Group chat',
        groupChatHint: 'In a group it speaks only when @-mentioned or the persona is named.',
        groupChatEnabled: 'Enable group chat',
        groupChatEnabledHint:
          'When off, group messages are ignored and private chat is unchanged. Ordinary bots only receive group messages that @ them; without full group-message permission, keyword triggers can only come from those @ messages.',
        groupCollectStickers: 'Collect group stickers',
        groupCollectStickersHint:
          'Square-ish small images that look like stickers are saved into the collected/ folder inside the sticker folder, silently and without speaking in the group. At most 300 are kept, duplicates only once.',
        groupAutoSpeak: 'Chime in on keywords / context',
        groupAutoSpeakHint:
          'When the persona is named, reply with one of the short lines below plus a sticker, without calling the model. @ messages are answered regardless of this switch.',
        groupFollowUpWindowMs: 'Follow-up window after an @ (ms)',
        groupFollowUpWindowMsHint:
          'After one @ mention, the group can keep talking without @-ing again for this long, and messages are no longer filtered by keyword/persona: every text message goes to the agent to decide whether a reply is needed, and it stays silent when unrelated. Only a new @ renews it; chatting does not. 0 means every message needs an @. Default 300000 (5 minutes).',
        groupPersonaNames: 'Persona names (comma separated)',
        groupPersonaNamesHint:
          'The persona is 「鲸鱼娘」. 大肥鱼 is an old nickname and is ignored by default — add it here if the group still calls her that. The first name is the main one.',
        groupAutoSpeakKeywords: 'Chime-in keywords (comma separated)',
        groupAutoSpeakKeywordsHint:
          'A keyword only counts when the persona was mentioned moments before. On its own it is not enough, so ordinary chatter does not look like a summons.',
        groupSpeakCooldownMs: 'Minimum gap between chime-ins (ms)',
        groupSpeakCooldownMsHint: 'At least this long between two automatic replies in the same group.',
        groupStickerDir: 'Sticker folder',
        groupStickerDirHint:
          'Leave empty for the default location (qq/stickers under the DSH home). Put the files you import in the root; stickers collected from groups go into collected/. Both are picked at random, with emoji as the fallback.',
        groupStickerChance: 'Sticker chance (0–100)',
        groupStickerChanceHint: 'When no sticker is picked, or the folder is empty, an emoji is used instead.',
        settingsSave: 'Save',
        settingsSaved: 'Saved',
        settingsReset: 'Reset to defaults',
        disconnect: 'Disconnect',
        disconnectHint: 'Reconnecting needs a new scan. Sessions and their contents stay.',
        disconnectConfirm: 'Disconnect?',
        groupConnection: 'Connection',
        groupConnectionHint: 'Switch the channel and bind a QQ bot.',
        groupPermissions: 'Permissions',
        groupPermissionsHint: 'Which preset conversations from this channel get.',
        permissionPreset: 'Permission preset for QQ conversations',
        permissionPresetHint:
          'Applies only to conversations created or adopted afterwards — DSH locks a preset once a conversation has run its first turn. The default is read-only: a new window can look but not run commands. To let a new conversation act, first turn off 「Force new sessions to read-only」 below, then pick full access or workspace write.',
        permissionReadOnly: 'Read only: no writes, no commands',
        permissionWorkspaceWrite: 'Workspace write: change files in the workspace only',
        newSessionsReadOnly: 'Force new sessions to read-only',
        newSessionsReadOnlyHint:
          'On by default. While on, every newly created or adopted QQ session is read-only, regardless of the preset above. Turn it off to let new sessions follow the preset. Existing sessions are unaffected.',
        permissionFull: 'Full access: run without asking',
        permissionAuto: 'Automatic review: decided on this computer',
        permissionProfile: 'Follow the DSH setting, same as the desktop',
        permissionUnavailable: 'This composition offers no permission presets.',
        permissionSwitching: 'Switching…',
        groupBehaviour: 'Behaviour',
        groupBehaviourHint: 'How incoming messages are handled.',
        groupDiagnostics: 'Diagnostics',
        groupHelp: 'Help',
        helpTitle: 'User handbook',
        helpHint: 'How to use it away from the desk, what it accepts, and what every setting does.',
        helpOpen: 'Open the handbook',
        groupCommands: 'Commands',
        commandsSlash: 'Slash commands',
        commandsSlashHint:
          'Sent straight from QQ. They skip the agent and need no confirmation, so they are the fastest route.',
        commandHelp: 'Show the command list',
        commandNew: 'Start a new conversation, optionally titled',
        commandList: 'List every conversation',
        commandSwitch: 'Move to conversation number N',
        commandModel: 'List the models and their reasoning levels; add a name or number to switch. Level only: /model level high',
        commandCurrent: 'Show the conversation in use',
        commandCancel: 'Interrupt the running task',
        commandsSeparator: 'The separator may be «：» or omitted entirely, as in /switch1.',
        commandsPlain: 'Plain words work too',
        commandsPlainHint:
          'Just say «switch conversation», «show me my conversations», «stop», or whatever comes naturally. DSH says what it intends to do first and waits for you to agree — turn off «Confirm before acting on a request» below to skip that step.',
        diagnosticsTitle: 'Diagnostics',
        diagnosticsHint: 'The log records every send, receive, and failure.',
        logPath: 'Log file',
        workspacePath: 'Session workspace',
        conversationCount: 'Conversations',
        pendingInteractions: 'Pending prompts',
        replyLimiter: 'Passive-reply limiter',
        logTail: 'End of the log',
        noLog: '(no log yet)',
      },
    }

    /** Follow the app's resolved locale, falling back to the browser's. */
    function text() {
      const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? copy.zh : copy.en
    }

    /** One JSON request against the channel's own routes. */
    async function request(path, options) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: {
          accept: 'application/json',
          ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options?.headers ?? {}),
        },
      })
      const raw = await response.text()
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = { error: raw.slice(0, 200) }
      }
      if (!response.ok) {
        const error = new Error(body?.error || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return body
    }

    /*
     * Every value below comes from the DSH design tokens the rest of the app uses, so this page
     * sits in the same visual system rather than beside it. The reference is the shipped
     * primitives: Button, Switch, Pill, Tag and the settings-form fields. Mixing in `currentColor`
     * opacities looked close but never matched, because the app's greys are tokens, not tints.
     */
    const styles = `
.dsh-qq { display: flex; flex-direction: column; gap: 26px; max-width: 680px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-qq h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
.dsh-qq h3 { margin: 0; font-size: 13px; font-weight: 500; line-height: 1.5; }
.dsh-qq p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

/* Header: title above a single line of context, the way a settings page opens. */
.dsh-qq-header { display: flex; flex-direction: column; gap: 4px; }
.dsh-qq-lead { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }

/* Groups are plain bands with a small heading. The app has no boxed sections, so neither does
   this page: separation comes from spacing and a heading, not from a container. */
.dsh-qq-group { display: flex; flex-direction: column; gap: 4px; }
.dsh-qq-group-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-qq-group-title { font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-qq-group-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-qq-group-body { display: flex; flex-direction: column; gap: 16px; }

/* A card is a subtle surface, not a bordered panel: 0.5px is the app's hairline everywhere. */
.dsh-qq-card { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); padding: 4px 14px; background: var(--dsw-alias-bg-layer-2); }
.dsh-qq-card > h3 { padding: 12px 0 2px; font-size: 13px; font-weight: 600; }
/* A second heading inside one card separates two sub-sections, so it needs the room a first
   heading gets from the card's own edge. */
.dsh-qq-card > h3 ~ h3 { padding-top: 20px; }
.dsh-qq-card > p { padding-bottom: 6px; }

/* Rows and fields are the settings-form pattern: padded, with a hairline between them. */
.dsh-qq-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 12px 0; }
.dsh-qq-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-qq-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dsh-qq-field > label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-qq-row + .dsh-qq-row,
.dsh-qq-field + .dsh-qq-field,
.dsh-qq-field + .dsh-qq-row,
.dsh-qq-row + .dsh-qq-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-qq-card > :first-child { padding-top: 12px; }
.dsh-qq-card > :last-child { padding-bottom: 12px; }

/* Switch: the shipped geometry, keyed off aria-checked so it cannot disagree with the state. */
.dsh-qq-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background 120ms ease; }
.dsh-qq-switch::after { content: ''; display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease; }
.dsh-qq-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dsh-qq-switch[aria-checked='true']::after { background: var(--dsw-alias-label-primary-foreground); transform: translateX(16px); }
.dsh-qq-switch:disabled { cursor: default; opacity: .5; }
.dsh-qq-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.dsh-qq-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: 0; border-radius: var(--dsw-radius-sm); font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: transparent; cursor: pointer; }
.dsh-qq-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-qq-button:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dsh-qq-button:disabled { cursor: not-allowed; opacity: .4; }
.dsh-qq-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsh-qq-outline { border: 0.5px solid var(--dsw-alias-border-l3); }
/* The same button, rendered as an anchor so the shell's link handler picks it up. */
a.dsh-qq-button { text-decoration: none; }
.dsh-qq-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-qq-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-qq-danger { color: var(--dsw-alias-state-error-primary); border: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-qq-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }

.dsh-qq-input { box-sizing: border-box; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-qq-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-qq-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dsh-qq-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-qq-field input[type='number'], .dsh-qq-field input[type='text'] { max-width: 240px; }
.dsh-qq-field input[type='number'] { max-width: 104px; }
/* The field and the path in effect share one line, so the two can be read against each other. */
.dsh-qq-path-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-qq-field select.dsh-qq-input { max-width: 320px; }
.dsh-qq-field textarea { box-sizing: border-box; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); min-height: 84px; resize: vertical; }
.dsh-qq-field textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }

.dsh-qq-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 0; }
.dsh-qq-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-qq-ok { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-success-primary); }
/* The unsaved-changes note: a state of the form, not a failure, so it is not the error colour. */
.dsh-qq-warn { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); }
.dsh-qq-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dsh-qq-errors { margin: 0; padding: 0 0 0 18px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

/* Pills and badges follow Tag/Pill: capsule, token background, one size everywhere. */
.dsh-qq-pill { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dsh-qq-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.dsh-qq-pill.is-warn::before { background: var(--dsw-alias-state-warn-primary); }
.dsh-qq-pill.is-ok::before { background: var(--dsw-alias-state-success-primary); }
.dsh-qq-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-tertiary); border: 0.5px solid var(--dsw-alias-border-l4); }
.dsh-qq-badge.is-on { color: var(--dsw-alias-state-success-primary); border-color: transparent; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }

.dsh-qq-qr { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; }
.dsh-qq-qr img { width: 200px; height: 200px; image-rendering: pixelated; background: #fff; border-radius: var(--dsw-radius-lg); padding: 8px; }
.dsh-qq-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dsh-qq-list li { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 10px 0; font-size: 13px; }
.dsh-qq-list li + li { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-qq-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

.dsh-qq-log { max-height: 240px; overflow: auto; margin: 0; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; }
/* Facts: a fixed label column so values line up instead of ragging right. */
.dsh-qq-facts { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; }
.dsh-qq-fact { display: grid; grid-template-columns: 92px 1fr; gap: 12px; align-items: baseline; font-size: 12px; }
.dsh-qq-fact > dt { color: var(--dsw-alias-label-tertiary); }
.dsh-qq-fact > dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dsh-qq-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; text-align: right; }

/* The command reference: a definition list so a command and its meaning line up. */
.dsh-qq-commands { display: flex; flex-direction: column; margin: 0; padding: 0; }
.dsh-qq-command { display: grid; grid-template-columns: 132px 1fr; gap: 12px; align-items: baseline; padding: 8px 0; font-size: 12px; line-height: 1.6; }
.dsh-qq-command + .dsh-qq-command { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-qq-command > dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsh-qq-command > dd { margin: 0; color: var(--dsw-alias-label-secondary); }
`

    /**
     * Install the stylesheet for the life of the plugin.
     *
     * Returns its own cleanup. The client-plugin rules require `apply` to own every
     * resource it adds and to hand back disposers, so a disabled or reloaded plugin
     * leaves no orphaned `<style>` behind.
     */
    function installStyles() {
      const existing = document.getElementById('dsh-qq-style')
      if (existing !== null) return () => {}
      const style = document.createElement('style')
      style.id = 'dsh-qq-style'
      style.textContent = styles
      document.head.append(style)
      return () => {
        style.remove?.()
      }
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        // The visual state keys off `aria-checked`, matching the app's own switch, so the two can
        // never disagree.
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        className: 'dsh-qq-switch',
        onClick: () => {
          if (props.disabled !== true) props.onChange(!props.checked)
        },
      })
    }

    function Card(props) {
      return h('section', { className: 'dsh-qq-card' }, props.children)
    }

    /**
     * One titled group of cards.
     *
     * The page had grown into an unlabelled stack where unrelated settings sat side by side with
     * nothing to say they were different kinds of decision. Grouping is what makes the page
     * readable at a glance.
     */
    function Group(props) {
      return h(
        'section',
        { className: 'dsh-qq-group' },
        h(
          'header',
          { className: 'dsh-qq-group-head' },
          h('h3', { className: 'dsh-qq-group-title' }, props.title),
          props.hint ? h('p', { className: 'dsh-qq-group-hint' }, props.hint) : null,
        ),
        h('div', { className: 'dsh-qq-group-body' }, props.children),
      )
    }

    /**
     * The settings section.
     *
     * `props` is whatever this entry's `inject()` returns — that is the slot contract, and it is
     * how the folder chooser reaches the component. Nothing else is read off it.
     */
    function QqSettings(props) {
      const [state, setState] = React.useState({
        phase: 'loading',
        error: '',
        status: undefined,
        login: { phase: 'idle' },
        /** Effective settings, plus the defaults the reset buttons restore. */
        settings: undefined,
        defaults: undefined,
        /**
         * Editable copy of the settings.
         *
         * Held separately from `settings` so a change is only sent when Save is pressed — typing
         * into a field that saved on every keystroke would rewrite the state file per character.
         */
        draft: undefined,
        /** Permission-preset catalogue: `{ applied, sentinel, available, note }`. */
        presets: undefined,
        /** Whether a preset switch is in flight; kept apart from `busy` so the rest stays usable. */
        presetBusy: false,
        /** Diagnostics: `{ path, tail }` from the host's log route. */
        log: undefined,
        /** Bound accounts from `/accounts`, so a bound-but-stopped bot is still listed. */
        accountRows: undefined,
        saved: false,
        busy: false,
        /**
         * Whether the folder chooser is open right now.
         *
         * Its own flag rather than reusing `busy`: `busy` disables the channel switch, Save and
         * every binding button, and a dialog the user may leave open for a while must not freeze
         * the rest of the page. It does disable the chooser itself, so a double click cannot open
         * two dialogs.
         */
        pickBusy: false,
        /** Copy for a chooser that threw; cleared whenever a new attempt starts. */
        pickError: '',
        /**
         * Fields the last save sent but the host did not keep.
         *
         * The host drops a value it cannot accept and answers with what is stored, so the page would
         * otherwise say 已保存 while the field quietly went back to its old value. See
         * `ignoredSettings`.
         */
        ignored: [],
        /**
         * The host's own words for a failed save, shown beside the button that started it.
         *
         * Kept apart from `error`, which the load and the login paths also write: a save that failed
         * has to be reported where the user pressed, or the page looks like it worked.
         */
        saveError: '',
        verifyCode: '',
      })

      /*
       * The watchdog is deliberately **not** signalled here.
       *
       * This body runs only when the user opens 设置 → QQ, so a flag set here says "somebody looked
       * at the page", not "the page is registered". The watchdog's signal is set where the
       * registration actually happens — see `sectionRegistered` in `apply`.
       */

      // Re-render when the shell changes the page language.
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(() => bump((count) => count + 1))
        observer.observe(document.documentElement, { attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])

      const load = React.useCallback(async () => {
        try {
          // Settled, not all: one unavailable route must not blank the whole page. The permission
          // catalogue, the tunables and the log are the newest and most optional, and a load that
          // fails entirely because of them would take the channel switch down with it.
          const [status, login, settings, presets, log, accounts] = await Promise.allSettled([
            request(`${PREFIX}/status`),
            request(`${PREFIX}/login`),
            request(`${PREFIX}/settings`),
            request(`${PREFIX}/permission-presets`),
            request(`${PREFIX}/log`),
            request(`${PREFIX}/accounts`),
          ]).then((results) =>
            results.map((result) => (result.status === 'fulfilled' ? result.value : undefined)),
          )

          // Status is the one the page cannot do without, so its failure is still fatal.
          if (status === undefined) throw new Error('status unavailable')

          setState((prev) => ({
            ...prev,
            phase: 'ready',
            error: '',
            status,
            login: login ?? prev.login,
            settings: isRecord(settings) ? settings.settings : undefined,
            defaults: isRecord(settings) ? settings.defaults : undefined,
            // A reload discards an in-progress edit, which is the honest behaviour: what is shown
            // is what is stored.
            draft: isRecord(settings) && isRecord(settings.settings) ? settings.settings : prev.draft,
            // The notes about an earlier save describe values this reload has just replaced, so they
            // go with the draft they were about.
            ignored: [],
            saveError: '',
            presets: isRecord(presets) ? presets : prev.presets,
            log: isRecord(log) ? log : prev.log,
            accountRows:
              isRecord(accounts) && Array.isArray(accounts.accounts) ? accounts.accounts : prev.accountRows,
          }))
        } catch (error) {
          reportFailure('load', error)
          setState((prev) => ({
            ...prev,
            phase: 'error',
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }, [])

      React.useEffect(() => {
        void load()
        // Poll while a QR code is on screen, and refresh when the tab regains focus.
        const timer = setInterval(() => {
          setState((prev) => {
            if (prev.phase !== 'ready') return prev
            if (!loginInFlight(prev.login?.phase)) return prev
            void refreshLogin()
            return prev
          })
        }, 1500)
        const onFocus = () => {
          void load()
        }
        window.addEventListener?.('focus', onFocus)
        return () => {
          clearInterval(timer)
          window.removeEventListener?.('focus', onFocus)
        }
      }, [load])

      /** Cheap refresh used by the poll: only the login task and status change often. */
      const refreshLogin = React.useCallback(async () => {
        try {
          const [login, status] = await Promise.all([
            request(`${PREFIX}/login`),
            request(`${PREFIX}/status`),
          ])
          setState((prev) => ({ ...prev, login, status }))
        } catch {
          // Polling failures are noise; the visible error path is the explicit load.
        }
      }, [])

      const t = text()

      async function startLogin() {
        setState((prev) => ({ ...prev, busy: true, verifyCode: '' }))
        try {
          const login = await request(`${PREFIX}/login/start`, { method: 'POST', body: '{}' })
          setState((prev) => ({ ...prev, login, busy: false }))
        } catch (error) {
          reportFailure('login', error)
          setState((prev) => ({
            ...prev,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      async function cancelLogin() {
        // Caught rather than left to the caller: the button fires this with `void`, and an
        // unhandled rejection is invisible in the console but is a real failure.
        try {
          await request(`${PREFIX}/login/cancel`, { method: 'POST', body: '{}' })
          await refreshLogin()
        } catch (error) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      async function submitVerify() {
        const code = state.verifyCode.trim()
        if (code === '') return
        setState((prev) => ({ ...prev, busy: true }))
        try {
          await request(`${PREFIX}/login/verify`, {
            method: 'POST',
            body: JSON.stringify({ code }),
          })
          setState((prev) => ({ ...prev, busy: false, verifyCode: '' }))
          await refreshLogin()
        } catch (error) {
          setState((prev) => ({
            ...prev,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      /**
       * Post one action and fold the returned status back in.
       *
       * Returns whether the request succeeded. `/disconnect` also answers with the fresh account
       * list, which is folded in as well: without it the row the user just removed would stay on
       * screen until the next reload, making the button look like it did nothing.
       */
      async function act(path, body) {
        setState((prev) => ({ ...prev, busy: true }))
        try {
          const result = await request(path, { method: 'POST', body: JSON.stringify(body) })
          setState((prev) => ({
            ...prev,
            busy: false,
            ...(result?.status === undefined ? {} : { status: result.status }),
            ...(Array.isArray(result?.accounts) ? { accountRows: result.accounts } : {}),
          }))
          return true
        } catch (error) {
          setState((prev) => ({
            ...prev,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
          return false
        }
      }

      /**
       * Turn the channel on or off.
       *
       * QQ has no single toggle route: `/start` and `/stop` are the pair, and both answer with the
       * same status snapshot `GET /status` returns, so the switch needs no follow-up read.
       */
      async function toggle(connected) {
        setState((prev) => ({ ...prev, busy: true, error: '' }))
        try {
          const snapshot = await request(connected ? `${PREFIX}/start` : `${PREFIX}/stop`, {
            method: 'POST',
            body: '{}',
          })
          setState((prev) => ({
            ...prev,
            busy: false,
            status: isRecord(snapshot) ? snapshot : prev.status,
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      /**
       * Wait for a saved settings answer, then fold it back in.
       *
       * The reply is compared against what was sent, field by field, before the page claims success.
       * `lib/settings.js` drops a value it cannot accept — out of range, wrong type — and keeps the
       * old one, so the reply is the only place that drop is visible; without the comparison the page
       * prints 已保存 over a field that never moved.
       *
       * A host that omits `settings` in the reply leaves the draft as the truth, which is what the
       * page already showed — the alternative would be to blank the form on a successful save.
       */
      async function saveSettings() {
        if (state.draft === undefined) return
        // The patch built below is what the host is asked for; it is kept for the comparison.
        const patch = {}
        for (const key of SETTINGS_FIELDS) {
          // Only the fields this page owns go back: see SETTINGS_FIELDS.
          if (key in state.draft) patch[key] = state.draft[key]
        }
        setState((prev) => ({ ...prev, busy: true, saved: false, saveError: '', ignored: [] }))
        try {
          const result = await request(`${PREFIX}/settings`, {
            method: 'POST',
            body: JSON.stringify(patch),
          })
          const saved = isRecord(result) && isRecord(result.settings) ? result.settings : state.draft
          setState((prev) => ({
            ...prev,
            busy: false,
            saved: true,
            // A save is only reported as a success if every value sent is the value stored. The
            // host silently drops a field it cannot accept, and 已保存 over a dropped field is how a
            // user comes to believe a setting is in effect when it never was.
            ignored: ignoredSettings(patch, saved, t),
            settings: saved,
            draft: saved,
            defaults: isRecord(result) && isRecord(result.defaults) ? result.defaults : prev.defaults,
          }))
          // The confirmation is transient: it describes one save, not a state of the form. Whatever
          // was ignored is a state and stays on screen.
          setTimeout(() => setState((prev) => ({ ...prev, saved: false })), 2500)
        } catch (error) {
          // Reported to the host as well as shown: a failing save is exactly the case where a static
          // page and a stale state file look the same from the outside.
          reportFailure('save', error)
          setState((prev) => ({
            ...prev,
            busy: false,
            saveError: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      /**
       * Switch the permission preset for this channel's conversations.
       *
       * Applied at once rather than behind Save: the whole reason the control exists is to make a
       * preset the user needs to test reachable in one click, and a preset is the host's own
       * runtime state rather than a field of the settings form.
       */
      async function choosePreset(preset) {
        setState((prev) => ({ ...prev, presetBusy: true, error: '' }))
        try {
          const result = await request(`${PREFIX}/permission-preset`, {
            method: 'POST',
            body: JSON.stringify({ preset }),
          })
          setState((prev) => ({
            ...prev,
            presetBusy: false,
            presets: isRecord(result)
              ? {
                  applied: typeof result.applied === 'string' ? result.applied : preset,
                  sentinel:
                    typeof result.sentinel === 'string'
                      ? result.sentinel
                      : (prev.presets?.sentinel ?? 'default'),
                  available: Array.isArray(result.available)
                    ? result.available
                    : asArray(prev.presets?.available),
                  note: typeof result.note === 'string' ? result.note : prev.presets?.note,
                }
              : prev.presets,
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            presetBusy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      /**
       * End the link between the bound QQ bot and DSH.
       *
       * Different from switching the channel off: that only stops listening and can be turned back
       * on, while this forgets the credentials and needs a new scan.
       */
      async function disconnect(appId) {
        const ok = await act(`${PREFIX}/disconnect`, { appId })
        // The host answers with the fresh list, so this is normally a no-op. It is here so that a
        // host which stops sending `accounts` still cannot leave a removed bot on screen — and it
        // only runs on success, since a failed unbind must keep showing the account.
        if (!ok) return
        setState((prev) => ({
          ...prev,
          accountRows: Array.isArray(prev.accountRows)
            ? prev.accountRows.filter((row) => asString(row?.appId) !== appId)
            : prev.accountRows,
        }))
      }

      /**
       * One editable field, with its label and explanation.
       *
       * Label, control, hint — nothing else. The page used to also print each field's default value
       * beside its label and offer a per-field reset link, which is what made the form read as a
       * wall of chrome: two extra pieces of text on every row, neither of which the equivalent page
       * has. The defaults are still what the single global reset button restores.
       */
      function field(label, hint, control) {
        return h(
          'div',
          { className: 'dsh-qq-field' },
          h('label', null, label),
          control,
          hint ? h('span', { className: 'dsh-qq-hint' }, hint) : null,
        )
      }

      /** Patch one draft field, leaving the rest of the form alone. */
      function edit(key, value) {
        setState((prev) => ({ ...prev, draft: { ...(prev.draft ?? {}), [key]: value } }))
      }

      /**
       * Patch one numeric draft field from the input's raw string.
       *
       * `0` is a legal setting for both numeric fields this page owns — no waiting, no limit — so it
       * is never folded away as "empty", and neither is an empty input, which keeps the same meaning
       * the hint gives it. Negative input is clamped to 0 rather than sent: the host drops a
       * negative value silently, so posting one would look like the edit was ignored.
       */
      function editNumber(key, raw) {
        const value = Number(raw)
        edit(key, Number.isFinite(value) ? Math.max(0, value) : 0)
      }

      /**
       * The Save / Reset row, plus everything the page has to say about the last save.
       *
       * It is a function rather than one JSX block because the form is split into two cards
       * (behaviour and group chat), and a Save at the bottom of only the first one is a trap:
       * the group fields sit below it, so someone editing a group value sees no button at all.
       * Both cards render the **same** row, so there is exactly one save path and one set of
       * notes — not a second, subtly different button.
       */
      function settingsActions() {
        return h(
          'div',
          { className: 'dsh-qq-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-qq-button dsh-qq-primary',
              disabled: state.busy,
              onClick: () => void saveSettings(),
            },
            t.settingsSave,
          ),
          /*
           * The only reset on the page.
           *
           * It puts every field back to the host's own defaults at once, by replacing the
           * draft with `defaults` — the values the host reports, not a copy kept here. The
           * per-field reset links that used to sit beside each label are gone: they were an
           * invention of this page, they doubled the amount of text on every row, and one
           * button that undoes everything is what the equivalent page offers.
           */
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-qq-button dsh-qq-outline',
              disabled: state.busy || state.defaults === undefined,
              // Resetting fills the form from the defaults and saves nothing, so the notes
              // an earlier save left are about a draft that no longer exists.
              onClick: () => setState((prev) => ({ ...prev, draft: prev.defaults, ignored: [] })),
            },
            t.settingsReset,
          ),
          state.saved ? h('span', { className: 'dsh-qq-ok' }, t.settingsSaved) : null,
          /*
           * The page is edited without being saved, and a filled box looks exactly like a
           * stored value. This is the one thing that tells the two apart — its absence used
           * to be read, reasonably, as "already saved".
           */
          draftIsDirty(state) ? h('span', { className: 'dsh-qq-warn' }, t.settingsDirty) : null,

          /*
           * What happened to the save, said next to the button that started it.
           *
           * A failure and a field the host refused are the two outcomes that used to leave
           * the page looking successful: the button showed 已保存 either way. Neither note
           * is transient — a save that did not take is a state, not a moment.
           */
          state.saveError === ''
            ? null
            : h(
                'p',
                { className: 'dsh-qq-error', role: 'alert' },
                `${t.saveFailed}：${state.saveError}`,
              ),
          state.ignored.length === 0
            ? null
            : h(
                'p',
                { className: 'dsh-qq-error', role: 'alert' },
                `${t.saveIgnored}${state.ignored.join('、')}`,
              ),
        )
      }

      /**
       * Ask the system for a folder and put the answer in the path field.
       *
       * Three outcomes, and they are discriminated deliberately:
       *
       * - a **string** is written through `edit('workspacePath', …)`, exactly as typing would,
       *   so the chooser and the keyboard end at the same state. The string is written **as it
       *   arrived**: not trimmed, no separator added or removed, no escaping. What counts as a
       *   path is the host's decision (`lib/paths.js` `resolveWorkspaceDir`), and repairing it
       *   here would make the chosen value differ from the typed one for no reason.
       * - **`null`** — and any other non-string, since `undefined` is not a choice either — means
       *   the user closed the dialog. Nothing happens at all: the field keeps its old value, no
       *   error appears, no state is written. Cancelling must not be destructive.
       * - a **throw** is caught. It must be: an error that escapes a slot component replaces the
       *   whole entry with one `slot entry crashed in 'settings.section'` line and the page is
       *   gone. The failure is reported to the host log, printed to the console, and also shown
       *   next to the field — with the host's own words, because "选择文件夹失败" alone cannot tell a
       *   permission problem from a missing service.
       */
      async function chooseWorkspacePath() {
        const pick = props?.pick
        if (typeof pick !== 'function') return
        setState((prev) => ({ ...prev, pickBusy: true, pickError: '' }))
        try {
          const chosen = await pick()
          if (typeof chosen === 'string') edit('workspacePath', chosen)
          setState((prev) => ({ ...prev, pickBusy: false }))
        } catch (error) {
          console.error('dsh-qq: 选择文件夹失败', error)
          reportFailure('directory-picker', error)
          setState((prev) => ({
            ...prev,
            pickBusy: false,
            pickError: `${t.workspacePathPickFailed}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }))
        }
      }

      /**
       * The page itself.
       *
       * Built inside a function so the component can catch a throw: a slot entry that throws is
       * replaced by a single log line and nothing else, so a malformed reply from one route must
       * not be able to take the whole settings section down.
       */
      function renderPage() {
        const status = isRecord(state.status) ? state.status : { connected: false, errors: [] }
        const login = isRecord(state.login) ? state.login : { phase: 'idle' }
        const errors = asArray(status.errors).filter((line) => typeof line === 'string')
        const log = isRecord(state.log) ? state.log : undefined
        const presets = isRecord(state.presets) ? state.presets : undefined
        const available = asArray(presets?.available).filter((name) => typeof name === 'string')
        const sentinel = asString(presets?.sentinel, 'default') || 'default'
        const applied = asString(presets?.applied, sentinel) || sentinel
        /*
         * The dropdown is built from the names this page can label in Chinese, **filtered by what
         * this deployment actually offers**, and never from the raw catalogue.
         *
         * Why not render `available` as-is: those are the host's own identifiers
         * (`danger-full-access`, `auto`, …), and a settings page whose options read as identifiers
         * is a page the user has to translate before they can use it. The four names below are the
         * ones with a sentence written for them, and they lead, in this order.
         *
         * Why not hardcode all four the way `dsh-wechat-plugin` does: its page pushes the value it
         * shows, and `POST /permission-preset` answers 400 for any value outside `available`
         * (`lib/routes.js`). A hardcoded `auto` on a deployment with no Auto integration would then
         * be an option that can only fail — the user picks it and reads "未知预设". So a name is
         * offered only when the host listed it.
         *
         * `sentinel` is the exception, and it is not a preset name: `'default'` means "apply nothing,
         * keep the profile's own policy", and the route accepts it unconditionally. It is always
         * offered after the four labelled presets — that is the position it has on the WeChat page, where it is
         * labelled the same way.
         *
         * Anything else the deployment offers (a house preset name) is appended **after** those
         * four, under its own name. Dropping them would take a choice away from a deployment that
         * has one, and this page has no Chinese sentence to offer for a name it has never seen —
         * showing the name itself is the honest option there.
         */
        const labelledPresets = ['read-only', 'workspace-write', 'danger-full-access', 'auto'].filter(
          (name) => available.includes(name),
        )
        const extraPresets = available.filter(
          (name) => name !== sentinel && !labelledPresets.includes(name),
        )
        const presetOptions = [...labelledPresets, sentinel, ...extraPresets]
        const currentPreset = presetOptions.includes(applied) ? applied : sentinel
        const draft = isRecord(state.draft) ? state.draft : undefined

        /*
         * Whether this composition can offer a folder chooser at all.
         *
         * False is a normal, expected outcome — a composition with neither the desktop bridge nor
         * the `uiWorkspace` client service has no picker — and it is handled by **rendering
         * nothing**, not by rendering a disabled button with an apology on it. The text input
         * below is still a complete way to set the path, so there is nothing for the user to do
         * about the absence and nothing to explain.
         */
        const canPick = typeof props?.pick === 'function'

        // Bound bots come from `/accounts`, which lists every stored account — so one that is bound
        // but currently stopped still shows up with its 断开连接 button. `status.appId` is only set
        // while a bot is connected, so it is the fallback rather than the source.
        const appId = asString(status.appId)
        const accountRows = asArray(state.accountRows)
          .filter(isRecord)
          .map((row) => ({
            accountId: asString(row.appId),
            userId: asString(row.userOpenid) || undefined,
            boundAt: asString(row.boundAt) || undefined,
            connected: row.active === true,
          }))
          .filter((row) => row.accountId !== '')
        if (accountRows.length === 0 && appId !== '') {
          accountRows.push({
            accountId: appId,
            userId: asString(status.boundUserOpenid) || undefined,
            boundAt: asString(status.boundAt) || undefined,
            connected: status.connected === true,
          })
        }

        const limiter = isRecord(status.replyLimiter) ? status.replyLimiter : undefined
        const limiterText =
          limiter === undefined
            ? '—'
            : `${asText(limiter.limit, '?')} 次 / ${asText(limiter.ttlHours, '?')} 小时`

        const rawTail = asString(log?.tail)
        const logText = rawTail === '' ? '' : rawTail.split(/\r?\n/).slice(-60).join('\n')

        function fact(label, value) {
          return h(
            'div',
            { className: 'dsh-qq-fact' },
            h('dt', null, label),
            h('dd', null, value),
          )
        }

        /**
         * A label for a preset name.
         *
         * The three this page has a sentence for read as sentences — the same three sentences the
         * WeChat settings page uses, word for word. Any other name a deployment offers is shown
         * as-is: inventing a Chinese gloss for a preset this file knows nothing about would be a
         * label that does not describe the thing it names.
         */
        function presetLabel(name) {
          if (name === sentinel) return t.permissionProfile
          if (name === 'read-only') return t.permissionReadOnly
          if (name === 'workspace-write') return t.permissionWorkspaceWrite
          if (name === 'danger-full-access') return t.permissionFull
          if (name === 'auto') return t.permissionAuto
          return name
        }

        return h(
          'div',
          { className: 'dsh-qq' },
          h(
            'div',
            { className: 'dsh-qq-header' },
            h('h2', null, t.title),
            h('p', { className: 'dsh-qq-lead' }, t.intro),
          ),

          state.error
            ? h('p', { className: 'dsh-qq-error', role: 'alert' }, `${t.saveFailed}: ${state.error}`)
            : null,

          /*
           * The guide, first.
           *
           * It answers the questions the settings themselves raise — how to bind, what each switch
           * does, why a message did not arrive — so it belongs above them rather than after the
           * diagnostics, which is where a docs link usually ends up and where nobody looks until they
           * have already given up.
           *
           * An ordinary `target="_blank"` anchor, and that is the mechanism rather than a style
           * choice: it is what the desktop shell intercepts and hands to the system browser, while
           * `window.open` and scripted navigation are denied by the same handler.
           */
          h(
            Group,
            { title: t.groupHelp },
            h(
              Card,
              null,
              h('h3', null, t.helpTitle),
              h('span', { className: 'dsh-qq-hint' }, t.helpHint),
              h(
                'p',
                { className: 'dsh-qq-actions' },
                h(
                  'a',
                  {
                    className: 'dsh-qq-button dsh-qq-outline',
                    href: HANDBOOK_URL,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  },
                  t.helpOpen,
                ),
              ),
            ),
          ),

          // Connection: what is bound, and how to bind.
          h(
            Group,
            { title: t.groupConnection, hint: t.groupConnectionHint },
            // Channel switch and the bound bot.
            h(
              Card,
              null,
              h(
                'div',
                { className: 'dsh-qq-row' },
                h(
                  'div',
                  { className: 'dsh-qq-row-text' },
                  h('h3', null, t.statusTitle),
                  h('span', { className: 'dsh-qq-hint' }, t.enabledHint),
                ),
                h(Toggle, {
                  checked: status.connected === true,
                  label: t.enabled,
                  disabled: state.busy,
                  onChange: (next) => void toggle(next),
                }),
              ),
              h('h3', null, t.accounts),
              accountRows.length === 0
                ? h('p', null, t.noAccounts)
                : h(
                    'ul',
                    { className: 'dsh-qq-list' },
                    ...accountRows.map((account) =>
                      h(
                        'li',
                        { key: account.accountId },
                        h(
                          'span',
                          null,
                          h('span', { className: 'dsh-qq-mono' }, account.accountId),
                          account.userId
                            ? h('span', { className: 'dsh-qq-mono' }, ` ← ${account.userId}`)
                            : null,
                          account.boundAt
                            ? h('span', { className: 'dsh-qq-mono' }, ` · ${account.boundAt}`)
                            : null,
                        ),
                        h(
                          'span',
                          { className: `dsh-qq-badge${account.connected ? ' is-on' : ''}` },
                          account.connected ? t.polling : t.idle,
                        ),
                        // Ends the link itself, which the channel switch does not: switching off only
                        // stops listening, while this forgets the account and needs a new scan.
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-qq-button dsh-qq-danger',
                            title: t.disconnectConfirm,
                            disabled: state.busy,
                            onClick: () => disconnect(account.accountId),
                          },
                          t.disconnect,
                        ),
                      ),
                    ),
                  ),
              accountRows.length > 0
                ? h('p', { className: 'dsh-qq-hint' }, t.disconnectHint)
                : null,
              status.needsLogin === true ? h('p', { className: 'dsh-qq-error' }, t.needsLogin) : null,
            ),

            // Login: QR code, verification code, terminal states.
            h(
              Card,
              null,
              h('h3', null, t.loginTitle),
              login.phase === 'running' && typeof login.qrDataUrl === 'string' && login.qrDataUrl !== ''
                ? h(
                    'div',
                    { className: 'dsh-qq-qr' },
                    h('img', { src: login.qrDataUrl, alt: t.qrAlt, width: 220, height: 220 }),
                    h('p', null, asString(login.step) || t.qrHint),
                  )
                : h('p', null, asString(login.step) || t.qrHint),

              login.awaitingVerifyCode === true
                ? h(
                    'div',
                    null,
                    h('h3', null, t.verifyTitle),
                    field(
                      t.verifyPlaceholder,
                      t.verifyHint,
                      h(
                        'div',
                        { className: 'dsh-qq-actions' },
                        h('input', {
                          className: 'dsh-qq-input',
                          value: state.verifyCode,
                          placeholder: t.verifyPlaceholder,
                          onChange: (event) =>
                            setState((prev) => ({ ...prev, verifyCode: event.target.value })),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') void submitVerify()
                          },
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-qq-button dsh-qq-primary',
                            disabled: state.busy,
                            onClick: () => void submitVerify(),
                          },
                          t.verifySubmit,
                        ),
                      ),
                    ),
                  )
                : null,

              login.phase === 'succeeded'
                ? h(
                    'p',
                    null,
                    `${t.phaseSucceeded}${typeof login.accountId === 'string' && login.accountId !== '' ? `：${login.accountId}` : ''}`,
                  )
                : null,
              login.phase === 'already-bound' ? h('p', null, t.phaseAlreadyBound) : null,
              login.phase === 'failed'
                ? h('p', { className: 'dsh-qq-error' }, `${t.phaseFailed}: ${asString(login.error)}`)
                : null,

              h(
                'div',
                { className: 'dsh-qq-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-qq-button dsh-qq-primary',
                    disabled: state.busy || loginInFlight(login.phase),
                    onClick: () => void startLogin(),
                  },
                  accountRows.length > 0 ? t.loginAgain : t.loginStart,
                ),
                loginInFlight(login.phase)
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-qq-button dsh-qq-outline',
                        onClick: () => void cancelLogin(),
                      },
                      t.loginCancel,
                    )
                  : null,
              ),
            ),
          ),

          /*
           * Permissions, as its own group.
           *
           * It sits first among the tunables because it is the setting people come here to change:
           * a conversation that asks before every tool call sends the prompt to QQ and then waits,
           * which on a phone means the task stalls until the user answers. The channel's
           * conversations therefore default to full access, and this is where that is turned off —
           * and, just as importantly, where the asking preset is turned back on to check that a
           * prompt really does reach the phone.
           *
           * The catalogue is still asked for rather than assumed — the option list above is built
           * from `available` and only *labelled* here — because the preset names come from the
           * deployment's configuration and a value this deployment does not list would be refused
           * by the route that applies it. `sentinel` is not a preset name: it means "apply nothing
           * and keep the profile's own policy", which is why it is rendered as its own option.
           */
          h(
            Group,
            { title: t.groupPermissions, hint: t.groupPermissionsHint },
            h(
              Card,
              null,
              h('h3', null, t.permissionPreset),
              h('span', { className: 'dsh-qq-hint' }, t.permissionPresetHint),
              field(
                t.permissionPreset,
                /*
                 * The host's own note when it has one, this page's sentence otherwise.
                 *
                 * Every note the host produces belongs to the *empty* case — "此组合没有权限预设服务",
                 * "服务报出的可选预设为空", or the error from reading `names` — so an either/or that
                 * preferred this page's generic sentence down here would hide the only specific
                 * reason that exists. That is what it did: with `available` empty the branch always
                 * took `permissionUnavailable`, and the host's note was unreachable in practice.
                 *
                 * `permissionUnavailable` stays as the fallback, for a host that reports no note.
                 */
                asString(presets?.note) ||
                  (presetOptions.length <= 1 ? t.permissionUnavailable : ''),
                h(
                  'select',
                  {
                    className: 'dsh-qq-input',
                    value: currentPreset,
                    disabled: state.presetBusy || presetOptions.length <= 1,
                    onChange: (event) => void choosePreset(event.target.value),
                  },
                  ...presetOptions.map((name) =>
                    h('option', { key: name, value: name }, presetLabel(name)),
                  ),
                ),
              ),
              state.presetBusy ? h('span', { className: 'dsh-qq-hint' }, t.permissionSwitching) : null,

              /*
               * The lock that actually implements "every new window is read-only".
               *
               * The preset above is only a default; a stored `danger-full-access` would still let
               * new sessions act. This toggle is checked by the host when it applies a preset, so
               * leaving it on is what makes the guarantee hold. Unchecked (`false`) restores the
               * old behaviour of following the preset.
               */
              h(
                'div',
                { className: 'dsh-qq-row' },
                h(
                  'div',
                  { className: 'dsh-qq-row-text' },
                  h('label', null, t.newSessionsReadOnly),
                  h('span', { className: 'dsh-qq-hint' }, t.newSessionsReadOnlyHint),
                ),
                h(Toggle, {
                  checked: (draft?.newSessionsReadOnly ?? true) === true,
                  label: t.newSessionsReadOnly,
                  disabled: state.busy,
                  onChange: (next) => edit('newSessionsReadOnly', next),
                }),
              ),
            ),
          ),

          // Tuned behaviour. Everything here applies without a restart.
          draft !== undefined
            ? h(
                Group,
                { title: t.groupBehaviour, hint: t.groupBehaviourHint },
                h(
                  Card,
                  null,
                  h('h3', null, t.settingsTitle),
                  h('p', null, t.settingsHint),

                  /*
                   * On by default, unlike every other toggle here that widens access, because the
                   * feature is useless otherwise: the whole point is to hear about work that
                   * finished after the user left the desk, and the session doing that work is
                   * usually not the bound one.
                   */
                  h(
                    'div',
                    { className: 'dsh-qq-row' },
                    h(
                      'div',
                      { className: 'dsh-qq-row-text' },
                      h('label', null, t.allowCrossSessionNotify),
                      h('span', { className: 'dsh-qq-hint' }, t.allowCrossSessionNotifyHint),
                    ),
                    h(Toggle, {
                      checked: draft.allowCrossSessionNotify === true,
                      label: t.allowCrossSessionNotify,
                      disabled: state.busy,
                      onChange: (next) => edit('allowCrossSessionNotify', next),
                    }),
                  ),

                  h(
                    'div',
                    { className: 'dsh-qq-row' },
                    h(
                      'div',
                      { className: 'dsh-qq-row-text' },
                      h('label', null, t.requireConfirmation),
                      h('span', { className: 'dsh-qq-hint' }, t.requireConfirmationHint),
                    ),
                    h(Toggle, {
                      checked: draft.requireConfirmation === true,
                      label: t.requireConfirmation,
                      disabled: state.busy,
                      onChange: (next) => edit('requireConfirmation', next),
                    }),
                  ),

                  field(
                    t.mergeWindowMs,
                    t.mergeWindowHint,
                    h('input', {
                      type: 'number',
                      min: 0,
                      className: 'dsh-qq-input',
                      value: Number.isFinite(draft.mergeWindowMs) ? draft.mergeWindowMs : 0,
                      onChange: (event) => editNumber('mergeWindowMs', event.target.value),
                    }),
                  ),

                  h(
                    'div',
                    { className: 'dsh-qq-row' },
                    h(
                      'div',
                      { className: 'dsh-qq-row-text' },
                      h('label', null, t.autoReplyAttachments),
                      h('span', { className: 'dsh-qq-hint' }, t.autoReplyAttachmentsHint),
                    ),
                    // `!== false`, not `=== true`: the host's default is on, and a payload that
                    // omitted the key must not render as "off" — that would misreport the host.
                    h(Toggle, {
                      checked: draft.autoReplyAttachments !== false,
                      label: t.autoReplyAttachments,
                      disabled: state.busy,
                      onChange: (next) => edit('autoReplyAttachments', next),
                    }),
                  ),

                  // Past this many characters a reply travels as a `.md` file instead of a message.
                  // 0 means no limit, so it is a setting like any other here rather than a blank.
                  field(
                    t.maxReplyChars,
                    t.maxReplyCharsHint,
                    h('input', {
                      type: 'number',
                      min: 0,
                      className: 'dsh-qq-input',
                      value: Number.isFinite(draft.maxReplyChars) ? draft.maxReplyChars : 0,
                      onChange: (event) => editNumber('maxReplyChars', event.target.value),
                    }),
                  ),

                  field(
                    t.settleMs,
                    t.settleMsHint,
                    h('input', {
                      type: 'number',
                      min: 0,
                      className: 'dsh-qq-input',
                      value: Number.isFinite(draft.settleMs) ? draft.settleMs : 0,
                      onChange: (event) => edit('settleMs', Number(event.target.value)),
                    }),
                  ),

                  /*
                   * Free text, and long by default, so it gets a textarea rather than an input and no
                   * length check of any kind: the host stores whatever string it is given. Its default
                   * is restored by the one reset button below, which reinstates `defaults` whole — the
                   * paragraph is deliberately not copied into this file, where it would drift.
                   */
                  field(
                    t.presenceNote,
                    t.presenceNoteHint,
                    h('textarea', {
                      rows: 5,
                      value: typeof draft.presenceNote === 'string' ? draft.presenceNote : '',
                      onChange: (event) => edit('presenceNote', event.target.value),
                    }),
                  ),

                  /*
                   * Where the folder for new conversations lives.
                   *
                   * An input plus, when the environment has one, a real folder chooser — the
                   * ordinary arrangement, and the one people expect: a path is a thing you point
                   * at, and typing one from memory is how typos get into it.
                   *
                   * Both routes are kept. The chooser is optional by construction (see `canPick`),
                   * and the input is also what someone with a path already on the clipboard wants,
                   * so neither replaces the other.
                   *
                   * A path chosen from the dialog is written through the same `edit` as a typed
                   * one and is deliberately repaired nowhere: what counts as a path is the host's
                   * decision, so this page neither trims it, nor normalises it, nor adds a
                   * separator, nor refuses an empty one. Empty is a real choice — "use the default
                   * location" — and is submitted as `''`, which is why the value falls back to `''`
                   * and never to `undefined`, and why the field carries no required-state check.
                   *
                   * Beside it stands the path actually in effect, because the two legitimately
                   * differ: an empty field means the host's default, and changing this setting does
                   * not move conversations that already exist — which is what the hint says out loud
                   * rather than leaving the user to discover that their old ones "disappeared".
                   */
                  field(
                    t.workspacePathLabel,
                    t.workspacePathHint,
                    h(
                      'div',
                      { className: 'dsh-qq-path-row' },
                      h('input', {
                        type: 'text',
                        className: 'dsh-qq-input',
                        value: typeof draft.workspacePath === 'string' ? draft.workspacePath : '',
                        onChange: (event) => edit('workspacePath', event.target.value),
                      }),
                      canPick
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-qq-button dsh-qq-outline',
                              disabled: state.pickBusy || state.busy,
                              onClick: () => void chooseWorkspacePath(),
                            },
                            t.workspacePathPick,
                          )
                        : null,
                      h('span', { className: 'dsh-qq-hint' }, t.workspacePathCurrent),
                      h('span', { className: 'dsh-qq-mono' }, asString(status.workspace, '—')),
                      state.pickError === ''
                        ? null
                        : h('span', { className: 'dsh-qq-error', role: 'alert' }, state.pickError),
                    ),
                  ),

                  settingsActions(),
                ),
              )
            : null,

          /*
           * Group chat.
           *
           * Only the gates a user actually tunes live here. The speak lines, hourly cap, context
           * window and emoji fallback are stored settings too, but they are not part of this form:
           * leaving them out of `SETTINGS_FIELDS` means Save cannot overwrite them, exactly like
           * `permissionPreset` above.
           */
          h(
            Group,
            { title: t.groupChat, hint: t.groupChatHint },
            h(
              Card,
              null,
              h('h3', null, t.groupChat),

              h(
                'div',
                { className: 'dsh-qq-row' },
                h(
                  'div',
                  { className: 'dsh-qq-row-text' },
                  h('label', null, t.groupChatEnabled),
                  h('span', { className: 'dsh-qq-hint' }, t.groupChatEnabledHint),
                ),
                h(Toggle, {
                  checked: draft.groupChatEnabled !== false,
                  label: t.groupChatEnabled,
                  disabled: state.busy,
                  onChange: (next) => edit('groupChatEnabled', next),
                }),
              ),

              h(
                'div',
                { className: 'dsh-qq-row' },
                h(
                  'div',
                  { className: 'dsh-qq-row-text' },
                  h('label', null, t.groupCollectStickers),
                  h('span', { className: 'dsh-qq-hint' }, t.groupCollectStickersHint),
                ),
                h(Toggle, {
                  checked: draft.groupCollectStickers !== false,
                  label: t.groupCollectStickers,
                  disabled: state.busy,
                  onChange: (next) => edit('groupCollectStickers', next),
                }),
              ),

              h(
                'div',
                { className: 'dsh-qq-row' },
                h(
                  'div',
                  { className: 'dsh-qq-row-text' },
                  h('label', null, t.groupAutoSpeak),
                  h('span', { className: 'dsh-qq-hint' }, t.groupAutoSpeakHint),
                ),
                h(Toggle, {
                  checked: draft.groupAutoSpeak !== false,
                  label: t.groupAutoSpeak,
                  disabled: state.busy,
                  onChange: (next) => edit('groupAutoSpeak', next),
                }),
              ),

              field(
                t.groupFollowUpWindowMs,
                t.groupFollowUpWindowMsHint,
                h('input', {
                  type: 'number',
                  min: 0,
                  className: 'dsh-qq-input',
                  value: Number.isFinite(draft.groupFollowUpWindowMs) ? draft.groupFollowUpWindowMs : 0,
                  onChange: (event) => editNumber('groupFollowUpWindowMs', event.target.value),
                }),
              ),

              field(
                t.groupPersonaNames,
                t.groupPersonaNamesHint,
                h('input', {
                  type: 'text',
                  className: 'dsh-qq-input',
                  value: typeof draft.groupPersonaNames === 'string' ? draft.groupPersonaNames : '',
                  onChange: (event) => edit('groupPersonaNames', event.target.value),
                }),
              ),

              field(
                t.groupAutoSpeakKeywords,
                t.groupAutoSpeakKeywordsHint,
                h('textarea', {
                  rows: 2,
                  value: typeof draft.groupAutoSpeakKeywords === 'string' ? draft.groupAutoSpeakKeywords : '',
                  onChange: (event) => edit('groupAutoSpeakKeywords', event.target.value),
                }),
              ),

              field(
                t.groupStickerDir,
                t.groupStickerDirHint,
                h('input', {
                  type: 'text',
                  className: 'dsh-qq-input',
                  value: typeof draft.groupStickerDir === 'string' ? draft.groupStickerDir : '',
                  onChange: (event) => edit('groupStickerDir', event.target.value),
                }),
              ),

              field(
                t.groupStickerChance,
                t.groupStickerChanceHint,
                h('input', {
                  type: 'number',
                  min: 0,
                  max: 100,
                  className: 'dsh-qq-input',
                  value: Number.isFinite(draft.groupStickerChance) ? draft.groupStickerChance : 0,
                  onChange: (event) => editNumber('groupStickerChance', event.target.value),
                }),
              ),

              field(
                t.groupSpeakCooldownMs,
                t.groupSpeakCooldownMsHint,
                h('input', {
                  type: 'number',
                  min: 0,
                  className: 'dsh-qq-input',
                  value: Number.isFinite(draft.groupSpeakCooldownMs) ? draft.groupSpeakCooldownMs : 0,
                  onChange: (event) => editNumber('groupSpeakCooldownMs', event.target.value),
                }),
              ),

              // Save is repeated here on purpose: this card sits *below* the behaviour card's
              // buttons, so without it a group setting looks like it has no way to be stored.
              settingsActions(),
            ),
          ),

          // The command reference. Slash commands are the fast path and the escape hatch when the
          // agent misreads a request, but they only help someone who knows they exist — so the page
          // that configures the channel is where they belong.
          h(
            Group,
            { title: t.groupCommands },
            h(
              Card,
              null,
              h('h3', null, t.commandsSlash),
              h('span', { className: 'dsh-qq-hint' }, t.commandsSlashHint),
              h(
                'dl',
                { className: 'dsh-qq-commands' },
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/help'), h('dd', null, t.commandHelp)),
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/new [标题]'), h('dd', null, t.commandNew)),
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/list'), h('dd', null, t.commandList)),
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/switch <编号>'), h('dd', null, t.commandSwitch)),
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/model [名字]'), h('dd', null, t.commandModel)),
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/current'), h('dd', null, t.commandCurrent)),
                h('div', { className: 'dsh-qq-command' }, h('dt', null, '/cancel'), h('dd', null, t.commandCancel)),
              ),
              h('span', { className: 'dsh-qq-hint' }, t.commandsSeparator),
              h('h3', null, t.commandsPlain),
              h('span', { className: 'dsh-qq-hint' }, t.commandsPlainHint),
            ),
          ),

          // Diagnostics: where the files are, and what the log last said.
          //
          // A title-only group, like the equivalent group on the WeChat page: the card inside already
          // carries the one line of explanation, and repeating it beside the heading would be a second
          // copy of the same sentence.
          log !== undefined || errors.length > 0
            ? h(
                Group,
                { title: t.groupDiagnostics },
                h(
                  Card,
                  null,
                  h('h3', null, t.diagnosticsTitle),
                  h('span', { className: 'dsh-qq-hint' }, t.diagnosticsHint),
                  // A definition list rather than rows: the labels get a fixed column, so the
                  // paths line up instead of ragging against the right edge.
                  h(
                    'dl',
                    { className: 'dsh-qq-facts' },
                    fact(t.logPath, asString(log?.path, '—')),
                    fact(t.workspacePath, asString(status.workspace, '—')),
                    fact(t.conversationCount, asText(status.conversationCount)),
                    fact(t.pendingInteractions, asText(status.pendingInteractions)),
                    fact(t.replyLimiter, limiterText),
                  ),
                  h('h3', null, t.logTail),
                  h('pre', { className: 'dsh-qq-log' }, logText === '' ? t.noLog : logText),
                ),

                errors.length > 0
                  ? h(
                      Card,
                      null,
                      h('h3', null, t.errorsTitle),
                      h(
                        'ul',
                        { className: 'dsh-qq-errors' },
                        ...errors.slice(-6).map((line, index) => h('li', { key: index }, line)),
                      ),
                    )
                  : null,
              )
            : null,
        )
      }

      if (state.phase === 'loading') {
        return h('div', { className: 'dsh-qq' }, h('p', null, t.loading))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'dsh-qq' },
          h('p', { className: 'dsh-qq-error', role: 'alert' }, `${t.loadFailed}: ${state.error}`),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-qq-button dsh-qq-outline',
              onClick: () => void load(),
            },
            t.retry,
          ),
        )
      }

      try {
        return renderPage()
      } catch (error) {
        // The alternative is a blank slot entry and one log line that names nothing.
        reportFailure('render', error)
        return h(
          'div',
          { className: 'dsh-qq' },
          h(
            'p',
            { className: 'dsh-qq-error', role: 'alert' },
            `${t.loadFailed}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }

    /**
     * The folder chooser this composition can offer, or `undefined` when it has none.
     *
     * Two routes, in this order, mirroring what DSH's own native directory picker does:
     *
     * 1. `globalThis.__DSH_DIRECTORY_PICKER__.pick()` — the desktop bridge, and the only one that
     *    is genuinely the operating system's own folder dialog. Preferred whenever it is there.
     * 2. `uiWorkspace.pickDirectory()` — the client service, reached through `ctx.get`.
     *
     * ⚠️ `uiWorkspace` is read **optionally on purpose** and must never be added to this module's
     * `inject` list. Cordis will not activate a plugin until every injected service is available,
     * so declaring a service that some composition lacks makes the entry fail to activate — and a
     * client entry that fails activation goes through the boot audit and stops the **entire
     * application** from starting. A convenience button is not worth that. `ctx.get` does not
     * block activation, so a missing service simply means "no chooser here".
     *
     * Both probes are guarded. This runs inside the slot's `inject`, where a throw would blank the
     * entry rather than produce a usable page, and `__DSH_DIRECTORY_PICKER__` is a foreign global
     * whose shape this file does not control (`null` is not a bridge, and reading a property off
     * it would throw).
     *
     * `undefined` is a real answer: the caller then renders no button at all.
     */
    function makePick(ctx) {
      try {
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__
        if (desktop !== undefined && desktop !== null && typeof desktop.pick === 'function') {
          // Called through the bridge rather than detached from it, so `this` stays the bridge.
          return async () => await desktop.pick()
        }
      } catch {
        // A broken global is not a reason to give up on the service below.
      }

      let service
      try {
        service = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx.uiWorkspace
      } catch {
        service = undefined
      }
      if (service !== undefined && service !== null && typeof service.pickDirectory === 'function') {
        return async () => await service.pickDirectory()
      }

      return undefined
    }

    /** Cordis plugin name. The loader patch id must match this. */
    const name = 'dsh-qq-plugin-group-expand'

    /**
     * Client services this plugin needs before it may activate.
     *
     * Declaring `slots` is load-bearing, not tidiness. Cordis will not activate a
     * plugin until every injected service is available; without this entry the plugin
     * activates before the slot registry exists, `ctx.slots` is undefined, and
     * `ctx.slots.inject(...)` throws. The runtime then records the entry as `failed`,
     * the shell's boot audit refuses to start the whole application, and the failure
     * text never names the missing service — it only reports the entry as failed.
     *
     * The official client-plugin template declares the same list, for the same reason.
     *
     * ⚠️ Nothing else may be added here. `uiWorkspace` in particular is **not** needed: see
     * `makePick`, which reads it through `ctx.get` so that a composition without it still
     * activates this entry instead of blocking the boot audit.
     */
    const inject = ['slots']

    // The client-plugin rules call for factories free of side effects and for
    // `apply` to register every resource through `ctx.effect`, returning cleanup.
    function apply(ctx) {
      ctx.effect(() => {
        const removeStyles = installStyles()
        const disposeSection = ctx.slots.inject('settings.section', () => {
          const dispose = ctx.slots.register(
            {
              name: 'settings.section',
              id: 'qq',
              // After the built-in sections, which sit in the 10..30 range.
              order: 40,
              label: () => text().nav,
              /*
               * What the component receives as props; `inject` is the slot contract's one channel
               * into it. Probed on each call rather than captured once in `apply`: `uiWorkspace`
               * may be provided by an entry that activates after this one, and a later read then
               * finds it without needing the plugin to be reapplied.
               *
               * With no chooser anywhere the key is left out entirely, so the object is literally
               * empty and the component sees `props.pick` undefined — the same "no chooser" answer
               * as before the button existed.
               */
              inject: () => {
                const pick = makePick(ctx)
                return pick === undefined ? {} : { pick }
              },
            },
            QqSettings,
          )
          /*
           * The health signal, set where it can actually be proved: `slots.inject` runs this
           * contributor as soon as the shell declares the slot (synchronously, when the declaration
           * already exists), so reaching this line means the registry took the section and the shell
           * will render it whenever it is opened.
           *
           * A shell that never declares the slot never runs this, and the watchdog reports that —
           * which is the failure the watchdog exists for. What it must never do again is fire
           * because the user simply had not opened the settings page yet.
           */
          sectionRegistered = true
          return dispose
        })
        const disposeRenderWatch = watchSectionRenderErrors(ctx)
        return () => {
          if (typeof disposeRenderWatch === 'function') disposeRenderWatch()
          if (typeof disposeSection === 'function') disposeSection()
          removeStyles()
        }
      })
    }

    /**
     * Report a crash of this plugin's own settings section, because the watchdog cannot see
     * rendering.
     *
     * Registering a section proves only that the shell accepted it. Rendering is the other half, and
     * this is the one seam the shell exposes for it: every entry it renders sits inside an error
     * boundary that reports the crash through `ctx.slots.onEntryError`, filtered here by component
     * identity so another plugin's section in the same slot is not attributed to us.
     *
     * What is covered: a component that *throws* while rendering, at the moment the user opens the
     * section. What is not, and no signal here claims otherwise: a component that renders without
     * throwing and still shows nothing usable — a blank or wrong page. That failure has no
     * observable form from inside this plugin at all.
     *
     * Optional on purpose. A shell without the method leaves the watchdog exactly as strong as it
     * was, and nothing on this path may fail activation: an entry the runtime records as `failed`
     * makes the shell refuse to start the whole application.
     *
     * @param ctx - The client context `apply` received.
     * @returns The unsubscribe, when the shell offers the channel.
     */
    function watchSectionRenderErrors(ctx) {
      const slots = ctx.slots
      if (typeof slots?.onEntryError !== 'function') return undefined
      try {
        return slots.onEntryError((slotKey, entry, error) => {
          if (slotKey !== 'settings.section' || entry?.component !== QqSettings) return
          reportFailure('render', error instanceof Error ? error : new Error(String(error)))
        })
      } catch (error) {
        // Losing the extra coverage must not cost the section, but it is worth a line in the log.
        reportFailure('watchdog', error instanceof Error ? error : new Error(String(error)))
        return undefined
      }
    }

    // Returning the exports object directly is the documented factory shape.
    return { name, inject, apply }
  },
})

// Closes the IIFE that keeps this file out of the shared client-plugin scope.
})()
