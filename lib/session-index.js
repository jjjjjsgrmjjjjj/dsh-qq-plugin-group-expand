/**
 * 会话索引：读 DSH 会话存储，判断会话属于哪个工作区。
 *
 * 逐函数移植自 `dsh-wechat/packages/core/src/session-index.ts`（该仓库 HEAD `6997579c49f73f5dcd34cfecabe226c7398da857`，
 * `release: v0.43.1`）。保留原文的注释与全部防御逻辑——那些都是踩出来的：
 *
 * - `encodeWorkspaceDir` 的编码是**有损的**（`a\b` 与 `a-b` 会撞），所以它只用来**缩小搜索范围**，
 *   真正的判据是每条会话自己记录的 `cwd`。
 * - `indexNamesFor` 要试两种文件名：经工作区注册表创建的会话记在裸 uuid 下，
 *   频道自己创建的记在完整 `session-<uuid>` 下。猜错会静默产生"标题全空"的列表。
 * - 大小写只在文件系统忽略大小写的平台上归一（Windows/macOS），Linux 不能归一——
 *   否则会把 `/home/me/Projects` 和 `/home/me/projects` 当成同一个目录。
 * - 排序**必须是全序**：时间撞车在真实存储里是常态，单键排序会把平手交给目录遍历顺序，
 *   同一个库连着两次印出不同的清单（见 {@link compareSessionsNewestFirst}）。
 *
 * ⚠️ **上一版移植的是修之前的版本**，文件头那句"已在生产验证"验证的是旧实现——
 * 旧实现的时间取自**会话目录里最新文件的 mtime**，排序只有**一个键**。
 * 两者都是微信已经修掉、而 QQ 还在带着的 bug（本次修正）。
 *
 * 会话**只从磁盘读**，不依赖 `sessionController.list()`——后者在作者机器上永远返回空数组。
 *
 * @module dsh-qq/session-index
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 最新在前地排两条会话，**构成全序**。
 *
 * 第二个键不是修饰。没有它，两条时间相同的会话的先后就是文件系统把它们的目录交过来的顺序，
 * 于是同一个存储连着两次印出两份不同的清单——那正是这个比较器要终结的不稳定。
 * 平手改成按会话 id 比，那是**数据自己的属性**，所以同一份输入永远产出逐字节相同的输出。
 *
 * 用朴素的 `<` / `>` 而不是 `localeCompare`：后者依赖运行时的区域数据，
 * 一台机器上确定、换一台就不确定了。
 *
 * @param a - 一条会话。
 * @param b - 另一条。
 * @returns `a` 应排在前面时返回负数。
 */
export function compareSessionsNewestFirst(a, b) {
  const left = Number.isFinite(a?.updatedAt) ? a.updatedAt : 0
  const right = Number.isFinite(b?.updatedAt) ? b.updatedAt : 0
  if (left !== right) return right - left
  if (a?.sessionId === b?.sessionId) return 0
  return String(a?.sessionId) < String(b?.sessionId) ? -1 : 1
}

/**
 * 把工作目录编码成存储使用的文件夹名。
 *
 * 连续分隔符折叠成一个短横，因此 `C:\Users\me\.dsh\dsh_qq` 变成 `--C-Users-me-.dsh-dsh_qq--`。
 * 点与下划线保留；`C:` 与随后的 `\` 共享一个短横。先去掉首尾分隔符，
 * 这样 Unix 路径不会多出一个短横。
 *
 * @param cwd - 绝对工作目录。
 * @returns 存储会使用的文件夹名。
 */
export function encodeWorkspaceDir(cwd) {
  const trimmed = cwd.replace(/[\\/]+$/, '').replace(/^[\\/]+/, '')
  return `--${trimmed.replace(/[\\/:]+/g, '-')}--`
}

/**
 * 本平台的文件系统在路径上是否忽略大小写。
 *
 * Windows 总是忽略，macOS 默认装载的是大小写不敏感的 APFS/HFS+。
 * Linux 不忽略——而那一个才要紧：在那里做小写归一，会把两个真实不同的目录当成同一个。
 */
export const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * 某条记录的 `cwd` 是否属于给定工作区。
 *
 * 分隔符一律归一，因为同一个目录可能被写成 `C:\Users\me\x` 或 `C:/Users/me/x`。
 * 大小写只在文件系统忽略大小写的平台上归一。
 *
 * @param recorded - 会话索引里的 `cwd`。
 * @param workspace - 工作区目录。
 * @param caseInsensitive - 覆盖平台默认，便于两种行为都可测。
 */
export function isSameWorkspace(recorded, workspace, caseInsensitive = CASE_INSENSITIVE_PATHS) {
  const normalise = (value) => {
    const withSlashes = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return caseInsensitive ? withSlashes.toLowerCase() : withSlashes
  }
  return normalise(recorded) === normalise(workspace)
}

/**
 * 去掉 `session-` 前缀，得到索引归档用的键。
 *
 * @param sessionId - 频道使用的会话 id。
 */
export function indexKeyFor(sessionId) {
  return sessionId.replace(/^session-/, '')
}

/**
 * 一条会话可能的索引文件名，最可能的在前。
 *
 * @param sessionId - 频道使用的会话 id。
 */
export function indexNamesFor(sessionId) {
  const bare = indexKeyFor(sessionId)
  return bare === sessionId ? [`${sessionId}.json`] : [`${sessionId}.json`, `${bare}.json`]
}

/**
 * 读一条会话的索引条目。
 *
 * 索引按行带版本（`{ver, seq, val}`），取 `val`。文件缺失或不可读时返回空字段而不是失败：
 * 一条坏记录不该把其余所有对话都藏起来。
 *
 * @param storeDir - 索引存储根目录。
 * @param sessionId - 目标会话。
 * @returns `{ title, cwd, updatedAt }`，字段都可能为空/0。
 */
async function readIndex(storeDir, sessionId) {
  for (const name of indexNamesFor(sessionId)) {
    try {
      const raw = await readFile(join(storeDir, name), 'utf-8')
      const parsed = JSON.parse(raw)
      const title = parsed.record?.rows?.title?.val
      const cwd = parsed.record?.identity?.cwd
      return {
        title: typeof title === 'string' ? title : '',
        cwd: typeof cwd === 'string' ? cwd : '',
        updatedAt: recordedSessionTime(parsed),
      }
    } catch {
      // 试下一个拼法。
    }
  }
  return { title: '', cwd: '', updatedAt: 0 }
}

/**
 * 会话记录自己说它最后是什么时候跑的。
 *
 * ## 读的是哪个字段（**照微信实现抄，不是照说法抄**）
 *
 * 依次读两个字段，顺序与存储自己的偏好一致：
 *
 * 1. `record.rows.sessionListMetadata.val.lastPromptAt` —— DSH 自己的会话清单显示的那个时间戳。
 * 2. `record.identity.createdAt` —— 给那条 row 出现之前写下的旧记录兜底。
 *
 * ⚠️ 于是它**不是"会话结束时间"**，而是"**最后一次提问的时间**"
 * （没有提问过的会话退回创建时间）。微信的工作总结第十节第 1 条自己就指出了这处不一致：
 * 用户最初的期望是"按会话**结束**时间排序"，最终实现读的是 `lastPromptAt`。
 * 观感上一致，但**不是同一个量**——以代码为准，别把它当结束时间用。
 *
 * ## 为什么不用文件 mtime
 *
 * mtime 回答的是"这个目录最后被写是什么时候"，而**任何**碰过这条会话的东西都会改它：
 * 一次后台写入、一次无关的工具调用、存储自己压实一遍。用户于是每次问「上次时间」都得到
 * 一个不同的值，顺带一份不同的行序。记录**里面**的字段只在会话自己往前走时才变，
 * 而那才是这份清单要回答的问题。
 *
 * @param parsed - 解析好的索引条目。
 * @returns 毫秒时间戳；记录里没有可用时间戳时返回 0。
 */
export function recordedSessionTime(parsed) {
  const lastPromptAt = parsed?.record?.rows?.sessionListMetadata?.val?.lastPromptAt
  if (typeof lastPromptAt === 'number' && Number.isFinite(lastPromptAt)) return lastPromptAt
  const createdAt = parsed?.record?.identity?.createdAt
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt
  return 0
}

/** 列目录，失败返回空数组（权限、不存在都不该致命）。 */
async function listDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 列出属于**某一个工作区**的会话，最新的在前。
 *
 * @param home - DSH 主目录。
 * @param workspace - 工作区目录。
 * @returns 真正能切换过去的会话。
 */
export async function listStoredSessions(home, workspace) {
  const sessionsRoot = join(home, 'sessions')
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')

  const exact = encodeWorkspaceDir(workspace)
  const wanted = (await listDirs(sessionsRoot)).filter((name) => name === exact)

  const sessions = []
  for (const folder of wanted) {
    const ids = (await listDirs(join(sessionsRoot, folder))).filter((name) => name.startsWith('session-'))
    for (const sessionId of ids) {
      const index = await readIndex(indexDir, sessionId)
      // 文件夹名是有损编码，所以只有当会话自己的记录说它属于这里时才提供它。
      if (index.cwd !== '' && !isSameWorkspace(index.cwd, workspace)) continue
      sessions.push({ sessionId, title: index.title, updatedAt: index.updatedAt, cwd: index.cwd })
    }
  }
  return sessions.sort(compareSessionsNewestFirst)
}

/**
 * 列出本机**全部**会话，按所属工作区路径分组。
 *
 * 用户要求看本频道之外的对话时用它：存储里有全部会话，且每条记录都写明自己的工作目录，
 * 所以分组是**读出来的**，不是推断的。
 *
 * @param home - DSH 主目录。
 * @returns `Map<工作区路径, StoredSession[]>`，每个列表最新在前。
 */
export async function listAllStoredSessions(home) {
  const sessionsRoot = join(home, 'sessions')
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')

  const byWorkspace = new Map()
  for (const folder of await listDirs(sessionsRoot)) {
    const ids = (await listDirs(join(sessionsRoot, folder))).filter((name) => name.startsWith('session-'))
    for (const sessionId of ids) {
      const index = await readIndex(indexDir, sessionId)
      // 按记录分组，而不是按文件夹：文件夹名有损，会把无关目录并到一起。
      const key = index.cwd
      const entry = { sessionId, title: index.title, updatedAt: index.updatedAt, cwd: index.cwd }
      const list = byWorkspace.get(key)
      if (list === undefined) byWorkspace.set(key, [entry])
      else list.push(entry)
    }
  }
  for (const list of byWorkspace.values()) list.sort(compareSessionsNewestFirst)
  return byWorkspace
}

/**
 * 一条会话属于哪个工作目录。
 *
 * 采纳**别的**工作区的会话时必需：宿主钉死会话的 `cwd`，
 * 所以恢复一条会话意味着要指名**它自己**的工作区，而不是本插件的。
 *
 * @param home - DSH 主目录。
 * @param sessionId - 目标会话。
 * @returns 记录下来的目录；存储不认识该会话时 `undefined`。
 */
export async function storedSessionWorkspace(home, sessionId) {
  const index = await readIndex(join(home, 'storages', 'session_projcache', 'sessions'), sessionId)
  return index.cwd === '' ? undefined : index.cwd
}

/**
 * 存储里到底有没有这条会话的记录，读得懂读不懂都算。
 *
 * ## 为什么它必须和 `storedSessionWorkspace` 分开
 *
 * 那个函数对"没有这条会话"和"有记录但我读不出来"都回答 `undefined`，
 * 而这两种情况要的应对正好相反：前者是用户删掉的会话，后者是坏掉的存储。
 * 把后者当成前者，就会把对话搬到一个新会话上——而**损坏不会自愈**，
 * 于是每当绑定的年龄越过宽限期就再搬一次，每次都丢掉历史，且一个字都不说。
 *
 * 判据是**文件在不在**，不是**解析得出来吗**：存在但解析不了的记录仍然算存在。
 * 会话**自己的目录**也算，因为旁边的索引只是一份**投影缓存**，
 * 一行可以被驱逐而对话本身还活着——目录才是清单真正遍历的东西。
 *
 * ⚠️ **不确定性（照抄微信时留下的，微信自己也标着"推测"）**：
 * 微信工作总结第八节第 9 条写明——"索引是投影缓存、行可能被驱逐而目录还在"这条依据
 * **没有观察到真实的驱逐**，是按目录名与 listing 走目录推断出来的。
 * 它只是把这个判定推向**更保守**（更不容易误换绑），所以留着；
 * 但别把它当成已验证的事实。
 *
 * @param home - DSH 主目录。
 * @param sessionId - 要找的会话。
 * @returns 磁盘上存在这条会话的任何索引行或会话目录时 `true`。
 */
export async function hasStoredSession(home, sessionId) {
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')
  for (const name of indexNamesFor(sessionId)) {
    try {
      await stat(join(indexDir, name))
      return true
    } catch {
      // 试下一个拼法。
    }
  }

  const folders = await listDirs(join(home, 'sessions'))
  for (const folder of folders) {
    try {
      const entries = await readdir(join(home, 'sessions', folder), { withFileTypes: true })
      if (entries.some((entry) => entry.isDirectory() && entry.name === sessionId)) return true
    } catch {
      // 读不了的文件夹对这条会话无话可说。
    }
  }
  return false
}
