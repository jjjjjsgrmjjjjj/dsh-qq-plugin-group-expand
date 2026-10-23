/**
 * 路径解析。
 *
 * 两条硬约束，都来自微信插件的事故记录：
 *
 * 1. **会话工作目录必须恒定。** 宿主在"采用"一个已存在会话时会比对 `cwd`，不一致直接抛
 *    `ApiSessionCwdConflict`，那个会话就永远接不回来了。所以它是常量，不是每个对话一个目录。
 *
 * 2. **目录必须在 apply 阶段就创建。** 宿主用 `realpath` 解析 `cwd`，目录不存在时第一条消息
 *    会以 `ENOENT` 失败，用户只看到"处理这条消息时出错了"。微信插件当年因为"只在有附件时才建目录"
 *    而把这个问题藏了很久。
 *
 * @module dsh-qq/paths
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { bootLog, describeError } from './log.js'

/** 会话工作目录名。放在 `$DSH_HOME` 下，桌面上好认。 */
export const WORKSPACE_DIR_NAME = 'dsh_qq'

/** 状态文件所在目录名。 */
export const STATE_DIR_NAME = 'qq'

/**
 * 解析 DSH 主目录。
 *
 * 三级回退，按可靠性排序。实测：**宿主进程内 `DSH_HOME` 是未设置的**
 * （只有 shell 调用里才有），而 `homePaths` 服务在桌面端组合里**不存在**，
 * 所以生产上通常落到第三级——这不是异常路径，是主路径。
 *
 * @param ctx - 宿主上下文。
 */
export function resolveHome(ctx) {
  const fromService = safeServiceHome(ctx)
  if (fromService !== undefined) return fromService
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function safeServiceHome(ctx) {
  try {
    const homePaths = typeof ctx.get === 'function' ? ctx.get('homePaths') : undefined
    const home = homePaths?.home
    if (typeof home === 'string' && home.trim() !== '') return home.trim()
  } catch {
    // 服务探测失败不能影响插件加载。
  }
  return undefined
}

/**
 * 解析状态文件与会话工作目录，并**确保工作目录存在**。
 *
 * @param ctx - 宿主上下文。
 * @param config - patch 里的 config。
 * @returns `{ home, stateFile, workspace }`
 */
export function resolvePaths(ctx, config = {}) {
  const home = resolveHome(ctx)
  const workspace =
    typeof config.workspace === 'string' && config.workspace.trim() !== ''
      ? config.workspace.trim()
      : join(home, WORKSPACE_DIR_NAME)
  const stateFile =
    typeof config.stateFile === 'string' && config.stateFile.trim() !== ''
      ? config.stateFile.trim()
      : join(home, STATE_DIR_NAME, 'state.json')

  // 见文件头第 2 条：必须在这里建，且必须 recursive。
  mkdirSync(workspace, { recursive: true })
  /*
   * ★ 默认位置也要建，不能只建 `workspace` 那一个。
   *
   * `settings.workspacePath` 的默认值是**空串**，而 `hydrateSettings` 每次 start 都会把
   * 它原样交给 `#switchWorkspace` → `resolveWorkspaceDir(home, '')` →
   * `join(home, WORKSPACE_DIR_NAME)`。`config.workspace` 生效时上面那一行建的是**另一个**
   * 目录，于是"回落到默认位置"会落在一个从来没被建过的地方——第一条消息的 `cwd`
   * 就指向一个不存在的目录，正是文件头第 2 条警告的那个 `ENOENT`。
   *
   * ⚠️ 可达性（如实说明，不夸大）：**默认配置下这一条不可达**——shipped 的
   * `cordis.patch.yml` 只设了 `autoStart`，`config.workspace` 是空的，上面一行与本行
   * 建的是同一个目录。它只在"patch 里设了 `workspace`"或"用户填过自定义路径之后又清空"
   * 时才起作用；而清空那种情况 `resolveWorkspaceDir` 自己也会补建（见那个函数）。
   */
  mkdirSync(join(home, WORKSPACE_DIR_NAME), { recursive: true })

  /*
   * 默认表情包目录也在 apply 阶段建出来。
   *
   * 两个理由：
   * - 用户要往里**导入**自己的图，一个不存在的目录没法"放进去"；
   * - 群聊收藏也要落在这里，第一次收藏时目录缺失虽然能补建，但用户会更晚才发现位置。
   *
   * 它**不是硬依赖**：建不出来只记一行，群聊会退到 emoji，插件照常启动。
   * 这与工作目录的硬约束不同——会话 cwd 缺失是 ENOENT，表情包缺失只是少个素材。
   */
  try {
    mkdirSync(join(home, STATE_DIR_NAME, 'stickers'), { recursive: true })
  } catch (error) {
    bootLog(`表情包目录建不出来（${join(home, STATE_DIR_NAME, 'stickers')}）：${describeError(error)}`)
  }

  return { home, stateFile, workspace }
}

/**
 * 校验用户自定义的会话文件夹路径。
 *
 * ## 为什么这个函数必须存在
 *
 * 设置页里一个路径输入框，就是一个可以让插件**起不来**的地方：
 * 用户填了 `D:\QQ会话` 而那台机器上没有 D 盘，`mkdirSync` 就会抛，
 * 插件在 `apply` 阶段失败 → 启动审计判定它没激活 → **整个应用起不来**。
 *
 * 所以这里的铁律是：**坏路径永远只是"没生效"，绝不是"起不来"**。
 * 校验不过就回落到默认位置，并留下一条能被看见的理由。
 *
 * 校验顺序也是有意的：**先判绝对路径再碰磁盘**。
 * 相对路径会相对于进程 cwd 解析，那和用户以为的位置完全不是一回事。
 * （唯一被碰的磁盘是**回落目标自己**的 mkdir + 写探针，见 {@link ensureUsable}——
 * 用户填的那个相对路径仍然从头到尾没有被拼进任何路径。）
 *
 * ## ★ 回落目标也必须"建出来 + 真写一次"
 *
 * 这个函数从前只对**用户填的**路径做 mkdir + 写探针，对回落路径两样都没做。而它的契约是
 * "永不抛"，于是它可以返回一个**不存在**（或不可写）的路径，调用方
 * （`#switchWorkspace` → 会话 cwd、媒体目录）拿到之后才发现。审计实测：
 *
 *     resolveWorkspaceDir(home, 'my-qq-folder')   ← 相对路径，必然被拒并回落
 *     返回 {"path":"…\\dsh_qq","fellBack":true,"reason":"不是绝对路径：my-qq-folder"}
 *     回落目标存在吗？ false        ← ★ 返回了一个不存在的路径
 *
 * 所以每个"要回落到 fallback"的分支都先过一遍 {@link ensureUsable}；建不出来**照样不抛**，
 * 只是把理由一并带回去（调用方会把它记进错误环）。到这里"回落目标一定可用"才是真不变量。
 *
 * @param home - DSH 主目录。
 * @param candidate - 用户填的路径（空串表示用默认）。
 * @returns `{ path, fellBack, reason? }`——`reason` 只在出问题时出现。
 */
export function resolveWorkspaceDir(home, candidate) {
  const fallback = join(home, WORKSPACE_DIR_NAME)
  const wanted = typeof candidate === 'string' ? candidate.trim() : ''

  /**
   * 造一个"回落到 `fallback`"的结果，并**保证那个回落目标真的可用**。
   *
   * @param why - 用户填的路径为什么没生效；没有自定义路径时是 `undefined`。
   */
  const fallBackTo = (why) => {
    const problem = ensureUsable(fallback)
    if (problem === undefined) {
      return why === undefined
        ? { path: fallback, fellBack: false }
        : { path: fallback, fellBack: true, reason: why }
    }
    const detail = `回落目标 ${fallback} 也不可用：${problem}`
    return why === undefined
      ? { path: fallback, fellBack: false, reason: detail }
      : { path: fallback, fellBack: true, reason: `${why}；${detail}` }
  }

  if (wanted === '') return fallBackTo(undefined)

  if (!isAbsolute(wanted)) {
    return fallBackTo(`不是绝对路径：${wanted}`)
  }
  const problem = ensureUsable(wanted)
  if (problem !== undefined) {
    return fallBackTo(`无法使用 ${wanted}：${problem}`)
  }
  return { path: wanted, fellBack: false }
}

/**
 * 建出目录并**真写一次**，可用返回 `undefined`，不可用返回一行理由。
 *
 * 建得出来不代表写得进去（只读盘、权限不足的目录），所以写探针不是多余的。
 * **本函数不抛**：它的每个调用点都在"永不抛"的契约里。
 *
 * @param dir - 要验的目录。
 */
function ensureUsable(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.dsh-qq-write-probe-${String(Date.now())}`)
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
  } catch (error) {
    return describeError(error)
  }
  return undefined
}
