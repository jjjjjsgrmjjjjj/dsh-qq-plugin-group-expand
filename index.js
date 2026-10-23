/**
 * DSH QQ 官方机器人渠道 —— Host 插件入口。
 *
 * 挂载形态与 dsh-wechat-plugin 完全一致（同版本、已生产验证），差别只在协议层：
 * 那边是自研的 iLink 长轮询，这边直接用腾讯官方 SDK 的 WebSocket 网关。
 *
 * 三件事必须在这里做完，而且顺序不能变：
 *
 * 1. **解析路径并创建会话工作目录。** 宿主用 `realpath` 解析 `cwd`，目录不存在时第一条消息
 *    会以 ENOENT 失败，用户只看到"处理这条消息时出错了"。必须在 apply 阶段建好。
 * 2. **`ctx.provide` 暴露运行时**，让设置页路由拿到同一个实例。
 * 3. **所有注册都放进 `ctx.effect`**，返回清理函数——插件卸载时事件监听、路由、工具都要摘掉。
 *
 * @module dsh-qq-plugin-group-expand
 */
import { CredentialStore } from './lib/credentials.js'
import { bootLog, configureLog, describeError } from './lib/log.js'
import { resolveHome, resolvePaths } from './lib/paths.js'
import { QqRuntime } from './lib/runtime.js'
import { registerRoutes } from './lib/routes.js'

export const name = 'dsh-qq-plugin-group-expand'

/**
 * 必需服务。
 *
 * 只声明真正必需的：缺了就拿不到会话，插件没有意义。`webServer` **不在这里**——
 * 它缺失时插件仍应能收发消息，只是没有设置页（用 `ctx.get` 可选获取）。
 * 声明了拿不到的服务会让插件 pending/failed，那是最难查的一类问题。
 */
export const inject = ['sessionController', 'sessions']

/**
 * 可选服务（经 `ctx.get` 取，**不**放进 `inject`）。
 *
 * 这些服务缺失时本插件只应**降级**，不该不加载——所以不能声明为必需：
 *
 * - `workspaceRegistry` —— 缺了会话落在「未分组」，功能照常
 * - `webServer` —— 缺了没有设置页与诊断路由
 * - `permissionPresets` —— 缺了会话沿用 profile 自己的权限策略
 * - `credentials` —— 缺了无法保存 AppSecret（会在绑定时报错，而不是静默明文落地）
 *
 * 声明了拿不到的服务会让插件 pending/failed，那是最难查的一类问题。
 */
const OPTIONAL_SERVICES = ['workspaceRegistry', 'webServer', 'permissionPresets', 'credentials']

/**
 * 挂载 QQ 渠道。
 *
 * @param ctx - 宿主上下文。
 * @param config - `cordis.patch.yml` 里的 config。
 */
export function apply(ctx, config = {}) {
  const home = resolveHome(ctx)
  configureLog(home)
  bootLog('apply: entered')

  try {
    const paths = resolvePaths(ctx, config)
    const credentials = new CredentialStore(ctx)
    bootLog(`apply: home=${paths.home}`)
    bootLog(`apply: 会话工作目录=${paths.workspace}`)
    bootLog(`apply: 状态文件=${paths.stateFile}`)
    bootLog(`apply: 凭据服务可用=${credentials.available}`)
    bootLog(`apply: 可选服务 = ${OPTIONAL_SERVICES.map((n) => `${n}:${safeGet(ctx, n) !== undefined}`).join(' ')}`)

    const runtime = new QqRuntime(ctx, {
      home: paths.home,
      stateFile: paths.stateFile,
      workspace: paths.workspace,
      credentials,
      ...(typeof config.permissionPreset === 'string' ? { permissionPreset: config.permissionPreset } : {}),
    })

    // 设置页与诊断路由通过这个服务拿到同一个运行时实例。
    ctx.provide('qqChannel', runtime)

    ctx.effect(() => {
      // 助手流是回复的唯一来源。`global: true` 是必需的：事件按 agent 作用域分发，
      // 本插件位于 host 作用域、不拥有任何 agent，不加这个标志会在运行前就被过滤掉，
      // 表现是"消息收到了、agent 也答了、QQ 里什么都没有"。
      const detachStream = ctx.on(
        'agent/assistant-stream',
        (payload) => {
          runtime.onAssistantFrame(payload)
        },
        { global: true },
      )
      const detachRoutes = registerRoutes(ctx, runtime)

      /*
       * 两个作用域 waterfall：返回值即**认领**请求，调用 `next()` 即委托下一位。
       * 未绑定的对话一律委托，所以桌面端的行为完全不变。
       *
       * **`global: true` 是必需的，不是偏好。** 分发保留一个 hook 的条件是
       * `hook.global || !filter || filter(...)`，而这两个事件都以
       * `scopeTarget(agent, agent)` 分发，于是 `filter` 恒存在。
       * 本插件位于 host 作用域、不拥有任何 agent，没有这个标志它会在运行前被过滤掉，
       * 桌面应答者认领了提示，只有手机的用户就永远卡在那里。
       *
       * **`prepend: true` 同样要紧。** waterfall 按顺序走、遇到第一个认领者就停，
       * 而桌面应答者会阻塞等待它的 UI 面板——它先跑就把提示拿走了并停在那里，
       * 绑定到 QQ 的对话永远问不到手机上。跑在前面，本频道才能认领自己的会话。
       */
      const detachApproval = ctx.on('approval/request', runtime.approvalListener(), {
        global: true,
        prepend: true,
      })
      const detachQuestions = ctx.on('user-questions/request', runtime.questionListener(), {
        global: true,
        prepend: true,
      })

      // 工具注册放在 effect 里：卸载时会注销，否则会留下指向已拆除运行时的处理器。
      const detachTools = runtime.registerTools()

      void (async () => {
        try {
          if (await runtime.enabled(config.autoStart)) {
            await runtime.start()
            bootLog('apply: 渠道已启动')
          } else {
            bootLog('apply: autoStart 未开启，等待手动启动')
          }
        } catch (error) {
          bootLog(`apply: 启动失败 ${describeError(error)}`)
        }
      })().catch((error) => {
        // 兜底：内层已经 try/catch，但这条路径上的未处理 rejection 会**致命**，
        // 不值得为了少一行而留任何缝隙。
        bootLog(`apply: 启动任务未捕获 ${describeError(error)}`)
      })

      return () => {
        try {
          if (typeof detachStream === 'function') detachStream()
          if (typeof detachApproval === 'function') detachApproval()
          if (typeof detachQuestions === 'function') detachQuestions()
          if (typeof detachTools === 'function') detachTools()
          detachRoutes()
          // `halt()` 是异步的：**必须接住它的 rejection**。
          // 卸载路径上的未处理 rejection 在 app-boot 的失败表里同样是致命错误
          // （释放应用并非零退出），与条目是不是 required 无关。
          void Promise.resolve(runtime.halt()).catch((error) => {
            bootLog(`apply: 卸载时 halt 失败 ${describeError(error)}`)
          })
        } catch (error) {
          bootLog(`apply: 卸载失败 ${describeError(error)}`)
        }
      }
    })

    bootLog('apply: mounted')
  } catch (error) {
    // 先记录再抛出：桌面壳只显示一次失败对话框，且从不写盘，不记就没有任何痕迹。
    bootLog(`apply: FAILED: ${describeError(error)}`)
    if (error instanceof Error && error.stack) bootLog(`apply: stack:\n${error.stack}`)
    throw error
  }
}

/** 读一个可选服务；探测失败一律当作"没有"。 */
function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}
