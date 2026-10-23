/**
 * 设置页与诊断用的 HTTP 路由。
 *
 * 前缀 `/dsh-qq-plugin-group-expand`，与包名一致（微信插件为此专门写过一条测试断言两侧一致，这里沿用同一约定）。
 *
 * @module dsh-qq/routes
 */
import { readFileSync } from 'node:fs'
import { bootLog, describeError, logPath } from './log.js'

/** 路由前缀。必须与 `package.json` 的包名一致。 */
export const ROUTE_PREFIX = '/.dsh-qq-plugin-group-expand'

/**
 * 注册全部路由。
 *
 * @param ctx - 宿主上下文。
 * @param runtime - {@link import('./runtime.js').QqRuntime}
 * @returns 注销函数；`webServer` 不可用时返回空函数。
 */
export function registerRoutes(ctx, runtime) {
  const webServer = safeGet(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    bootLog('routes: 此组合没有 webServer，设置页与诊断路由不可用')
    return () => {}
  }
  try {
    return webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        void handle(req, res, runtime)
      },
    })
  } catch (error) {
    bootLog(`routes: 注册失败 ${describeError(error)}`)
    return () => {}
  }
}

async function handle(req, res, runtime) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  try {
    if (req.method === 'GET' && (path === '/status' || path === '/')) {
      return json(res, 200, await runtime.status())
    }
    if (req.method === 'GET' && path === '/log') {
      return json(res, 200, { path: logPath(), tail: tailLog(4000) })
    }
    if (req.method === 'POST' && path === '/credentials') {
      const body = await readJson(req)
      return json(res, 200, await saveCredentials(runtime, body))
    }
    if (req.method === 'POST' && path === '/start') {
      await runtime.start()
      return json(res, 200, await runtime.status())
    }
    if (req.method === 'POST' && path === '/stop') {
      await runtime.halt()
      return json(res, 200, await runtime.status())
    }
    /*
     * 权限预设：查目录，和切换。
     *
     * 默认是 `danger-full-access`（与微信插件一致：手机上收到权限提示等于任务卡死），
     * 但这也意味着**权限提示默认不会出现**，于是审批回流没法验证。
     *
     * ⚠️ **可选值由部署方配置，不能硬编码。** `names` 来自
     * `@deepseek-ai/dsh-permission-presets`，等于 `[...配置表键名, ...(有 Auto integration 时加 'auto')]`。
     * 其中 `auto` = **Full access 沙箱 + `ask` 审批策略**，也就是能弹提示的那一个；
     * `'default'` 是本插件的**哨兵值**，表示"不施加任何预设"。
     *
     * 所以先 GET 查目录，再 POST 切换。
     */
    if (req.method === 'GET' && path === '/permission-presets') {
      return json(res, 200, runtime.permissionPresetsInfo())
    }
    if (req.method === 'POST' && path === '/permission-preset') {
      const body = await readJson(req)
      const preset = typeof body.preset === 'string' ? body.preset.trim() : ''
      const info = runtime.permissionPresetsInfo()
      if (preset !== info.sentinel && !info.available.includes(preset)) {
        return json(res, 400, {
          error: `未知预设 ${JSON.stringify(preset)}`,
          available: info.available,
          sentinel: info.sentinel,
        })
      }
      runtime.setPermissionPreset(preset)
      return json(res, 200, { ok: true, ...runtime.permissionPresetsInfo() })
    }

    // ---- 设置页需要的其余接口，形状与 dsh-wechat-plugin 对齐 ----------------
    //
    // ⚠️ 形状不是随手定的：微信的设置页客户端把这些响应**直接当对象用**——
    // `/status` 与 `/login` 不包一层；`/settings` 解构成 `.settings` 与 `.defaults`；
    // 轮询判据是 `login.phase === 'running' && login.qrDataUrl`。
    // 照着它来，设置页才能逐字移植。

    if (req.method === 'GET' && path === '/settings') {
      return json(res, 200, runtime.settingsForPage())
    }
    if (req.method === 'POST' && path === '/settings') {
      const body = await readJson(req)
      runtime.applySettings(body)
      return json(res, 200, runtime.settingsForPage())
    }
    if (req.method === 'GET' && path === '/accounts') {
      return json(res, 200, { accounts: await runtime.accountsSnapshot() })
    }
    /** 开/关渠道。只停止监听，**保留凭据**——与 `disconnect` 的区别就在这里。 */
    if (req.method === 'POST' && path === '/toggle') {
      const body = await readJson(req)
      if (typeof body.enabled !== 'boolean') {
        return json(res, 400, { error: 'enabled 必须是布尔值' })
      }
      return json(res, 200, await runtime.setEnabled(body.enabled))
    }
    /** 解绑：停止并**删除凭据**，需要重新扫码才能恢复。 */
    if (req.method === 'POST' && path === '/disconnect') {
      const body = await readJson(req)
      const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
      if (appId === '') return json(res, 400, { error: 'appId 不能为空' })
      await runtime.forget(appId)
      return json(res, 200, { status: await runtime.status(), accounts: await runtime.accountsSnapshot() })
    }
    /** 扫码绑定状态轮询端点。响应就是状态对象本身。 */
    if (req.method === 'GET' && path === '/login') {
      return json(res, 200, runtime.bindSnapshot())
    }
    if (req.method === 'POST' && path === '/login/start') {
      const body = await readJson(req)
      const source = typeof body.source === 'string' ? body.source : 'dsh-qq-plugin-group-expand'
      return json(res, 200, await runtime.startBind(source))
    }
    if (req.method === 'POST' && path === '/login/cancel') {
      return json(res, 200, runtime.cancelBind())
    }
    /*
     * 浏览器侧的异常上报。
     *
     * 为什么需要它：客户端抛错宿主看不见——页面控制台是唯一现场，而用户不会去看。
     * 所以让客户端把异常 POST 回来，写进同一份 boot.log，于是设置页出问题时日志里有痕迹。
     * 也正因为这是客户端驱动的写入，日志行必须带上来源标记，不能伪装成宿主自己的记录。
     */
    if (req.method === 'POST' && path === '/client-error') {
      const body = await readJson(req)
      // 带上客户端给的 scope：它能区分「看门狗超时（register）」与「渲染抛错（render）」，
      // 而这两种在日志里长得一样、排查方向完全不同。微信版同样是 `client[<scope>] …`。
      // ⚠️ 看门狗的 scope 从 `mount` 改成了 `register`：旧名字描述的是**看门狗从没盯过**的一步
      //   （组件挂载），而它实际盯的是"设置段有没有注册进槽位注册表"。
      const scope = typeof body.scope === 'string' && body.scope !== '' ? body.scope : 'unknown'
      bootLog(`client[${scope}] FAILED: ${typeof body.message === 'string' ? body.message : '(no message)'}`)
      if (typeof body.stack === 'string') bootLog(`client-error stack:\n${body.stack}`)
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: `unknown route ${req.method} ${path}` })
  } catch (error) {
    bootLog(`routes: ${req.method} ${path} 失败 ${describeError(error)}`)
    return json(res, 500, { error: describeError(error) })
  }
}

/**
 * 保存一份手工录入的凭据。
 *
 * 走正规凭据通道（`ctx.credentials`），与将来扫码绑定成功后调用的是同一条路径。
 * 这样"手填"和"扫码"只有入口不同，落地逻辑完全一致。
 */
async function saveCredentials(runtime, body) {
  const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : ''
  const userOpenid = typeof body.userOpenid === 'string' ? body.userOpenid.trim() : ''
  if (appId === '' || appSecret === '') {
    return { ok: false, error: 'appId 与 appSecret 都不能为空' }
  }
  const saved = await runtime.rememberCredentials({
    appId,
    appSecret,
    userOpenid: userOpenid === '' ? undefined : userOpenid,
  })
  return { ok: true, appId: saved.appId, userOpenid: saved.userOpenid }
}

function json(res, status, payload) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(`${JSON.stringify(payload, null, 2)}\n`)
  } catch (error) {
    bootLog(`routes: 写响应失败 ${describeError(error)}`)
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      // 与微信插件的 1 MiB 上限一致，防止本地请求把内存吃满。
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON: ${describeError(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function tailLog(limit) {
  try {
    const text = readFileSync(logPath(), 'utf8')
    return text.length <= limit ? text : text.slice(-limit)
  } catch {
    return '(还没有日志)'
  }
}

function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}
