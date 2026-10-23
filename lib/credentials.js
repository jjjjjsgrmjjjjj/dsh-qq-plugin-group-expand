/**
 * 凭据层：AppSecret 存 DSH 的 `ctx.credentials`，**不落明文文件**。
 *
 * 这是相对微信插件的刻意改进。微信把 `bot_token` 明文写在 `state.json`（0600）；但 QQ 的
 * **AppSecret 是长期密钥**，官方安全须知明确要求妥善保管并建议每 3 个月轮换——它值得放在
 * 宿主的凭据服务里，而不是一个普通状态文件里。
 *
 * ## 为什么 key 要加前缀
 *
 * 官方 `credentialKey(scope, id)` 会校验两段都必须匹配 `/^[a-z][a-z0-9-]*$/`
 * ——**必须小写字母开头**。QQ 的 appId 是纯数字（实测 `1905760478`），直接当 id 段会被拒。
 * 所以 id 段统一加 `app-` 前缀。
 *
 * 官方那个 `credentialKey` 来自 `@deepseek-ai/dsh-credentials`，而可安装 bundle **不能在构建期依赖
 * 宿主内部包**（官方规范要求，微信插件也遵守同一约束），所以这里按文档构造同形字符串：
 * `credentialKey('dsh-qq-plugin-group-expand', 'app-1905760478')` === `'dsh-qq-plugin-group-expand/app-1905760478'`。
 *
 * @module dsh-qq/credentials
 */

/** 凭据记录的 scope 段，等于本插件的注册名。 */
export const CREDENTIAL_SCOPE = 'dsh-qq-plugin'

/**
 * 记录的种类标记。
 *
 * ## ⚠️ 这个值是一个**封闭枚举**，写错会让整个应用启动失败
 *
 * `@deepseek-ai/dsh-credentials-local` 在**启动时**解析 `.credentials.yaml`，用的是严格校验
 * （`parseRecord`，见其 `lib/index.js:233`）：
 *
 * - `kind: "api-key"` —— 只允许字段 `kind` / `key` / `env`
 * - `kind: "grant"`   —— 只允许字段 `kind` / `payload`（payload 接受任意 JSON）
 * - 其它任何值 → `unknown kind` 抛错
 * - 任何**未定义字段** → `unknown field` 抛错
 *
 * 而凭据提供方是**必需插件**：它加载失败 → `connection`（必需）拿不到 `credentials` →
 * 级联若干插件等待服务 → `auditStartupEntries` 判定 "1 required plugin did not activate" →
 * **桌面端直接启动不了**。
 *
 * 本插件曾经写成 `'qqbot'`，代价是用户的应用整个起不来（见 docs/POSTMORTEM.md 002）。
 * **改这个常量前请先确认上表，并跑 `scripts/verify.mjs`。**
 */
export const CREDENTIAL_KIND = 'grant'

/** 官方凭据提供方承认的全部 kind。写入前自我校验，杜绝再次写坏用户的凭据文件。 */
export const ALLOWED_RECORD_KINDS = Object.freeze(['api-key', 'grant'])

/**
 * 把 appId 规整成合法的 key 段（`^[a-z][a-z0-9-]*$`）。
 *
 * 正常情况 appId 是数字，`app-1905760478` 天然合法；这里只是防御非预期输入。
 *
 * @param appId - 机器人 AppID。
 */
export function sanitizeKeySegment(appId) {
  const cleaned = String(appId)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
  const withLetter = /^[a-z]/.test(cleaned) ? cleaned : `app-${cleaned}`
  return withLetter === '' ? 'app-unknown' : withLetter
}

/**
 * 某账号的凭据记录 key。
 *
 * @param appId - 机器人 AppID。
 */
export function accountRecordKey(appId) {
  return `${CREDENTIAL_SCOPE}/${sanitizeKeySegment(`app-${appId}`)}`
}

/**
 * `ctx.credentials` 的薄封装。
 *
 * 读失败一律返回 `undefined`（当作"未配置"），写失败向上抛——写不进去必须让人知道，
 * 否则用户会以为绑定成功了。
 */
export class CredentialStore {
  /** @type {object} */
  #ctx

  /** @param ctx - 宿主上下文。 */
  constructor(ctx) {
    this.#ctx = ctx
  }

  /** 本组合是否提供凭据服务。 */
  get available() {
    const service = this.#service()
    return (
      service !== undefined &&
      typeof service.modifyRecord === 'function' &&
      typeof service.readRecord === 'function'
    )
  }

  #service() {
    try {
      return typeof this.#ctx.get === 'function' ? this.#ctx.get('credentials') : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 保存一份账号凭据。`modifyRecord` 是官方文档说明的**唯一写路径**。
   *
   * @param params.appId - 机器人 AppID。
   * @param params.appSecret - 机器人 AppSecret（长期密钥）。
   * @param params.userOpenid - 扫码绑定的用户 openid。
   * @returns 写入后的 payload。
   */
  async save({ appId, appSecret, userOpenid }) {
    const service = this.#service()
    if (service === undefined || typeof service.modifyRecord !== 'function') {
      throw new Error('此组合没有凭据服务（ctx.credentials），无法安全保存 AppSecret')
    }
    // 写入前的最后一道闸：kind 与字段都必须落在官方承认的枚举里。
    // 这个文件是**全局共享**的，一次非法写入会让用户整个应用起不来——
    // 宁可在这里抛错让绑定失败，也不能写坏它。
    if (!ALLOWED_RECORD_KINDS.includes(CREDENTIAL_KIND)) {
      throw new Error(
        `拒绝写入：kind "${CREDENTIAL_KIND}" 不在官方承认的集合 ${JSON.stringify(ALLOWED_RECORD_KINDS)} 内。` +
          '写入非法 kind 会导致 DSH 下次启动失败。',
      )
    }
    const payload = {
      appId: String(appId),
      appSecret: String(appSecret),
      userOpenid: typeof userOpenid === 'string' ? userOpenid : undefined,
      boundAt: new Date().toISOString(),
    }
    await service.modifyRecord(accountRecordKey(appId), async () => ({
      kind: CREDENTIAL_KIND,
      payload,
    }))
    return payload
  }

  /**
   * 读取一份账号凭据。
   *
   * @param appId - 机器人 AppID。
   * @returns `{ appId, appSecret, userOpenid?, boundAt? }`，未配置时 `undefined`。
   */
  async load(appId) {
    const service = this.#service()
    if (service === undefined || typeof service.readRecord !== 'function') return undefined
    let record
    try {
      record = await service.readRecord(accountRecordKey(appId))
    } catch {
      return undefined
    }
    const payload = record?.payload
    if (typeof payload !== 'object' || payload === null) return undefined
    const { appSecret } = payload
    if (typeof appSecret !== 'string' || appSecret === '') return undefined
    return {
      appId: typeof payload.appId === 'string' ? payload.appId : String(appId),
      appSecret,
      userOpenid: typeof payload.userOpenid === 'string' ? payload.userOpenid : undefined,
      boundAt: typeof payload.boundAt === 'string' ? payload.boundAt : undefined,
    }
  }

  /**
   * 删除一份账号凭据（解绑时用）。
   *
   * @param appId - 机器人 AppID。
   */
  async remove(appId) {
    const service = this.#service()
    if (service === undefined || typeof service.deleteRecord !== 'function') return
    await service.deleteRecord(accountRecordKey(appId))
  }

  /**
   * 描述凭据状态——**绝不返回值**，可安全用于设置页与日志。
   *
   * @param appId - 机器人 AppID。
   */
  async describe(appId) {
    const service = this.#service()
    if (service === undefined || typeof service.describeRecord !== 'function') {
      return { configured: false, writable: false, reason: 'no-credentials-service' }
    }
    try {
      return await service.describeRecord(accountRecordKey(appId))
    } catch {
      return { configured: false, writable: false, reason: 'describe-failed' }
    }
  }
}
