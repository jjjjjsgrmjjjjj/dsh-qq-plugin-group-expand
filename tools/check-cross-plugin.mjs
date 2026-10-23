/**
 * 跨插件"共享资源"冲突检查。
 *
 * 有两类东西在 DSH 里是**所有插件共用**的，而任何一份插件各自的测试都发现不了冲突
 * ——冲突只在**别人也在场**时才存在：
 *
 * 1. **客户端插件的顶层作用域**（见下）
 * 2. **宿主作用域的工具名**（`ctx.tools.register` 的名字全局唯一）
 *
 * 两类都已经真实踩过，代价分别是"整个应用起不来"和"功能静默不可用"。
 *
 * ## 一、客户端顶层作用域
 *
 * shell 会把**每个已启用 bundle 的 `client.js` 拼进同一个脚本**（页面一次请求
 * `plugins/??a/client.js,b/client.js,…`），所以任意一份 `client.js` 在顶层声明的
 * `const` / `function` 都是**所有其它插件文件共享的顶层声明**。
 *
 * 已经踩过一次，代价是**整个应用起不来**：
 *
 * ```
 * Uncaught SyntaxError: Identifier 'PREFIX' has already been declared
 * error: web boot: 1 entry did not activate
 *        dsh-qq-plugin-group-expand: import failed (see console for the import error)
 * ```
 *
 * `dsh-wechat-plugin/client.js` 与 `dsh-qq-plugin-group-expand/client.js` 都在顶层声明了
 * `PREFIX` / `HANDBOOK_URL` / `reportFailure`。**各自单独存在时都正常**，
 * 一起加载就是 SyntaxError——而且报错不指名任何文件、行号或插件。
 *
 * ## 二、工具重名
 *
 * `ctx.tools.register` 在宿主作用域下名字全局唯一，重名会抛
 * `tool "X" is already registered`，那次注册失败且**只留一行错误**。
 *
 * 实测：`dsh-wechat-plugin` 注册了 `session_control`，而 QQ 插件最初也叫这个名字。
 * 因为微信的 bundle 排在前面，**QQ 的自然语言会话控制从来没有生效过**。
 *
 * ## 用法
 *
 * **这是本地检查，不进 CI。** 它要读一个真实的 DSH profile 目录
 * （profile 的 `package.json` 里 `dsh.profile.bundles`，以及 `node_modules` 下已安装的
 * 那些插件），CI 的 runner 上两样都没有。
 *
 * ```
 * node tools/check-cross-plugin.mjs <profileDir> <额外 client.js…>
 * ```
 *
 * `<profileDir>` 省略时取 `~/.dsh/profiles/desktop`——由 `node:os` 的 `homedir()`
 * 拼出来，Windows 上就是 `C:\Users\<你>\.dsh\profiles\desktop`。
 *
 * ⚠️ **不要把它写死成某个盘符。** 这里曾经写死 `C:\Users\XCISXC\…`：本机跑得通，
 * 而任何别的机器（以及 Linux）会指到一个不存在的地方，于是这个检查器在读 profile 的
 * `package.json` 时抛**未捕获的 ENOENT**——一个只在开发这台机器上成立的本地检查器。
 *
 * 官方插件的客户端入口在 `app.asar` 里（`…/<pkg>/lib/client.js`），
 * 所以要覆盖它们，先用 `qq-plugin/tools/asar-extract-fixed.mjs`（**留在应用侧，
 * 没有随本检查器一起搬进 `dsh-qq/tools/`**）导出，再当作额外文件传进来：
 *
 * ```
 * node ../tools/asar-extract-fixed.mjs <app.asar> "@deepseek-ai/dsh-<name>/lib/client.js" <outDir>
 * node tools/check-cross-plugin.mjs <profileDir> (Get-ChildItem -Recurse <outDir>\client.js).FullName
 * ```
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 默认的 profile 目录：`~/.dsh/profiles/desktop`。
 *
 * 由 `homedir()` 拼出来，而不是写死盘符——见文件头那段。
 *
 * @param home - 家目录，可注入以便自检。
 */
function defaultProfileDir(home = homedir()) {
  return join(home, '.dsh', 'profiles', 'desktop')
}

/**
 * 这条断言的样子：`dir` 是不是 `home` 这台机器上的 `~/.dsh/profiles/desktop`。
 *
 * 单独抽成一个函数只为一件事：让下面的自检能把它喂给一个**假的** home。
 * 一条永远不会失败的断言等于没有断言。
 */
function isDefaultProfileDir(dir, home) {
  return dir === join(home, '.dsh', 'profiles', 'desktop')
}

const DEFAULT_PROFILE_DIR = defaultProfileDir()
/** 显式给了就以它为准；没给才用默认值。 */
const profileDir = process.argv[2] ?? DEFAULT_PROFILE_DIR
/** 额外的 client.js 路径（通常是从 asar 里导出的官方插件）。 */
const extraFiles = process.argv.slice(3)

// ---- 自检：默认目录确实来自 homedir()（含反向对照）----
//
// 这一段的三个方向都要成立才算数：
//   1. 默认值等于 `homedir()` 拼出来的那个路径；
//   2. **换一个假的 home，同一条断言必须不成立**——否则它只是恒真的装饰；
//   3. 这次故障本身的写法（写死盘符）必须被同一条断言抓住。
const homeSelfTestOk = (() => {
  const home = homedir()
  const fakeHome = join(home, '__not-this-home__')
  const fromHomedir = isDefaultProfileDir(DEFAULT_PROFILE_DIR, home)
  const fakeHomeRejected = !isDefaultProfileDir(DEFAULT_PROFILE_DIR, fakeHome)
  const hardCodedRejected = !isDefaultProfileDir('C:\\Users\\XCISXC\\.dsh\\profiles\\desktop', fakeHome)

  console.log('=== 自检：默认 profile 目录来自 homedir() ===')
  console.log(`  默认值：${DEFAULT_PROFILE_DIR}`)
  console.log(`  homedir() = ${home}`)
  console.log(`  它等于 homedir()/.dsh/profiles/desktop：${fromHomedir ? '是 ✓' : '否 ✗'}`)
  console.log(
    `  反向对照：换一个假 home，这条断言不成立：${fakeHomeRejected ? '是 ✓' : '否 ✗（断言恒真，没有意义）'}`,
  )
  console.log(
    `  反向对照：写死盘符的老写法被这条断言判失败：${hardCodedRejected ? '是 ✓' : '否 ✗（它抓不住这次故障）'}`,
  )
  if (!fromHomedir || !fakeHomeRejected || !hardCodedRejected) {
    console.log('  ✗ 自检失败：默认目录不再由 homedir() 决定，结论不可信')
  } else {
    console.log('  自检通过 ✓')
  }
  console.log('')
  return fromHomedir && fakeHomeRejected && hardCodedRejected
})()

/**
 * 取某个包声明的客户端入口。
 *
 * 优先 `exports["./client"]`（其余插件都用这个），退回 `dsh.client.entry`。
 */
function clientEntryOf(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return { error: '没有 package.json' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { error: `package.json 解析失败：${error.message}` }
  }
  const exported = manifest.exports?.['./client']
  const relative = typeof exported === 'string' ? exported : exported?.default
  if (typeof relative !== 'string') return { error: '没有声明 ./client 导出' }
  const file = resolve(packageDir, relative)
  if (!existsSync(file)) return { error: `声明的入口不存在：${relative}` }
  return { file, name: manifest.name }
}

/**
 * 提取顶层声明。
 *
 * 只认**第 0 列**开头的 `const`/`let`/`var`/`function`/`class`——
 * 缩进的声明在某个块或闭包里，不污染共享作用域。这对本项目足够：
 * 冲突的写法正是第 0 列那种。
 */
function topLevelNames(source) {
  const names = []
  source.split('\n').forEach((line, index) => {
    const match = /^(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (match) names.push({ name: match[1], line: index + 1 })
    // `const a = 1, b = 2` 这种少见但要认。
    // 只在**方括号深度为 0** 处切逗号——否则 `const X = ['a','b']` 会被切成两个名字。
    const multi = /^(?:const|let|var)\s+(.+)$/.exec(line)
    if (multi && multi[1].includes(',')) {
      const declaration = multi[1]
      let depth = 0
      let segment = ''
      const parts = []
      for (const character of declaration) {
        if ('([{'.includes(character)) depth += 1
        else if (')]}'.includes(character)) depth -= 1
        if (character === ',' && depth === 0) {
          parts.push(segment)
          segment = ''
          continue
        }
        segment += character
      }
      parts.push(segment)
      // 只有一个第 0 层逗号段时说明逗号全在括号里，不属于多变量声明。
      if (parts.length > 1) {
        for (const part of parts) {
          const one = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(part)
          if (one) names.push({ name: one[1], line: index + 1 })
        }
      }
    }
  })
  return names
}

const profileManifestPath = join(profileDir, 'package.json')
if (!existsSync(profileManifestPath)) {
  // 说的是"读不到哪一个"，而不是把未捕获的 ENOENT 栈丢出来：
  // 这个检查器是给人手动跑的，人需要知道的是换哪个目录。
  console.log(`✗ 读不到 ${profileManifestPath}`)
  console.log('  它应当是一个 DSH profile 目录，默认取 ~/.dsh/profiles/desktop。')
  console.log('  换一个：node tools/check-cross-plugin.mjs <profileDir>')
  process.exit(1)
}
const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []
console.log(`profile: ${profileDir}`)
console.log(`已启用 bundle ${bundles.length} 个\n`)

const plugins = []
for (const bundle of bundles) {
  const packageDir = join(profileDir, 'node_modules', ...bundle.split('/'))
  const entry = clientEntryOf(packageDir)
  if (entry.error !== undefined) {
    console.log(`  [跳过] ${bundle} —— ${entry.error}`)
    continue
  }
  plugins.push({ bundle, file: entry.file, source: readFileSync(entry.file, 'utf8') })
}
console.log(`其中带客户端入口的 ${plugins.length} 个：`)
for (const plugin of plugins) console.log(`  ${plugin.bundle}  →  ${plugin.file}`)

for (const extra of extraFiles) {
  const file = resolve(extra)
  if (!existsSync(file)) {
    console.log(`  [额外] 找不到 ${file}`)
    continue
  }
  // 用所在包名当标签，便于读产出。
  const parts = file.split(/[\\/]/)
  const label = parts[parts.length - 3] ?? file
  plugins.push({ bundle: `${label} (asar)`, file, source: readFileSync(file, 'utf8') })
}
if (extraFiles.length > 0) console.log(`另加 ${extraFiles.length} 份官方客户端入口，共检查 ${plugins.length} 份`)

// ---- 1. 跨插件重复的顶层标识符（**仅供参考的线索**）----
//
// ⚠️ 这一节是启发式的，会**误报**：它按"第 0 列"判断顶层声明，而一份整体包在
// IIFE 里、但 body 没有缩进的文件，其内部名字仍然在第 0 列。所以它只用来提示
// "哪里可能有重复"，**不作为判定依据**。
//
// 判定依据是下面第 2 节的解析结果：那才是 shell 实际会遇到的错误。
console.log('\n=== 跨插件重复的第 0 列标识符（线索，非判定）===')
const owner = new Map()
const collisions = []
for (const plugin of plugins) {
  for (const { name, line } of topLevelNames(plugin.source)) {
    if (owner.has(name)) collisions.push({ name, first: owner.get(name), second: { bundle: plugin.bundle, line } })
    else owner.set(name, { bundle: plugin.bundle, line })
  }
}
if (collisions.length === 0) {
  console.log('  无重名 ✓')
} else {
  for (const hit of collisions) {
    console.log(`  · ${hit.name}  ${hit.first.bundle}:${hit.first.line}  /  ${hit.second.bundle}:${hit.second.line}`)
  }
  console.log('  （重复不一定是错误——两边都包在 IIFE 里就相安无事。看下面的解析判定。）')
}

// ---- 2. 按 shell 的方式拼起来真的解析一遍 ★ 这是判定依据 ----
console.log('\n=== 拼接后能否解析（复现 shell 的行为）===')
const combined = plugins.map((plugin) => `// ---- ${plugin.bundle} ----\n${plugin.source}`).join('\n')
let parseError
try {
  // 不执行，只让 V8 解析：语法错误在这一步就会抛出，
  // 与浏览器里那句 `Identifier 'X' has already been declared` 同源。
  // eslint-disable-next-line no-new-func
  new Function(combined)
} catch (error) {
  parseError = error
}
if (parseError === undefined) {
  console.log(`  ${plugins.length} 份 client.js 拼接后解析通过 ✓`)
} else {
  console.log(`  ✗ 拼接后无法解析 —— 这正是让 shell 报 "N entry did not activate" 的原因：`)
  console.log(`     ${parseError.name}: ${parseError.message}`)
}

// ---- 3. 我的插件是否单独泄漏到共享作用域（同样只是线索）----
const mine = plugins.find((plugin) => plugin.bundle === 'dsh-qq-plugin-group-expand')
if (mine !== undefined) {
  const leaked = topLevelNames(mine.source)
  const wrapped = /(?:^|\n)\s*;?\(\(\)\s*=>\s*\{/.test(mine.source)
  console.log('\n=== dsh-qq-plugin-group-expand/client.js 的自我保护 ===')
  console.log(`  整体包在 IIFE 里：${wrapped ? '是 ✓' : '否 —— 顶层声明会与其它插件共享作用域'}`)
  console.log(`  第 0 列名字 ${leaked.length} 个（若上面是"是"，这些都在 IIFE 内，不泄漏）`)
}

// ---- 4. 自检：这个检查器抓得住已知的那次故障吗 ----
//
// 一个永远通过的检查器毫无价值，所以必须证明它能抓住那一类故障。
//
// ⚠️ 这里曾经用**真实文件**做样本：把 dsh-qq-plugin-group-expand 的 IIFE 拆掉，指望它与
// dsh-wechat-plugin 泄漏的 `PREFIX` 撞车。**这个前提失效了**——微信 0.43.1 的
// `fix: make the client bundle safe to evaluate again after a rebuild` 把它自己也包了起来，
// 于是两边都不泄漏，没有东西可撞，自检从此**恒红**。
//
// 一个恒红的检查器和一个恒绿的检查器同样有害：它会训练人忽略它。
// 所以自检改成用**自造样本**，不再依赖任何一个真实插件的内部结构：
// 别人怎么演进都不会让这段失效，而它检验的东西（顶层 const 撞车会不会解析失败）
// 恰恰是这个检查器赖以成立的前提。
console.log('\n=== 自检：能否抓住已知故障（顶层 const 撞车）===')
let selfTestOk = false
{
  const bare = 'const PREFIX = "a";\nfunction reportFailure() {}\n'
  const wrapped =
    ';(() => {\n' + 'const PREFIX = "b";\nfunction reportFailure() {}\n' + '})()\n'
  const parseFails = (source) => {
    try {
      // eslint-disable-next-line no-new-func
      new Function(source)
      return false
    } catch {
      return true
    }
  }

  // 方向一：两个都裸露 → **必须**解析失败（这就是 POSTMORTEM 004 的形态）
  const collide = parseFails(bare + bare)
  // 方向二：其中一个包了 IIFE → 必须相安无事（否则检查器会把正常情况误报成故障）
  const protectedOk = !parseFails('// ---- p1 ----\n' + bare + '// ---- p2 ----\n' + wrapped)

  if (collide && protectedOk) {
    console.log('  裸露的顶层 const 撞车 → 解析失败 ✓')
    console.log('  其中一方包进 IIFE → 相安无事 ✓')
    selfTestOk = true
  } else {
    console.log(`  ✗ 自检失败：撞车被检出=${String(collide)}（应为 true），IIFE 能防护=${String(protectedOk)}（应为 true）`)
    console.log('    说明本检查器的判定前提不成立，结论不可信')
  }
}

// ---- 5. 工具重名（另一类共享资源）----
//
// `ctx.tools.register` 在宿主作用域下名字全局唯一。重名会让**后注册的那一份**
// 整个失败，而且只留一行错误——功能静默不可用。
//
// 要扫的是**宿主侧**的 JS，不是 client.js：工具名定义在 `exports["."]` 指向的那一侧，
// 而且可能散在多个 `lib/*.js` 里（本插件就是），所以按包目录遍历。
console.log('\n=== 工具重名（宿主作用域全局唯一）===')

/** 递归收集一个目录下的 .js 文件，跳过 node_modules。 */
function jsFilesUnder(dir, out = [], depth = 0) {
  if (depth > 5 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) jsFilesUnder(full, out, depth + 1)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const toolOwners = new Map()
const toolClashes = []
const resolved = new Map()
let toolCount = 0
let unresolved = 0

for (const bundle of bundles) {
  const packageDir = join(profileDir, 'node_modules', ...bundle.split('/'))
  const files = jsFilesUnder(packageDir)
  if (files.length === 0) continue

  // 第一遍：收集 `export const NAME = 'value'`，好在第二遍解析标识符形式的工具名。
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) {
      resolved.set(`${bundle}:${match[1]}`, match[2])
    }
  }

  // 第二遍：找工具定义里的 name。要求文件确实提到 tools.register 或 *ToolDefinition，
  // 否则插槽名、投影名之类的字符串会被误当成工具名。
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!/tools\s*\.\s*register|ToolDefinition\s*\(/.test(text)) continue
    for (const match of text.matchAll(/^[ \t]*name:\s*(?:'([a-z][a-z0-9_]*)'|([A-Z_][A-Z0-9_]*)),[ \t]*$/gm)) {
      const literal = match[1]
      const identifier = match[2]
      let name = literal
      if (name === undefined) {
        name = resolved.get(`${bundle}:${identifier}`)
        if (name === undefined) {
          unresolved += 1
          console.log(`  ? 无法解析 ${bundle} 里的 ${identifier}（文件 ${file.split(/[\\/]/).pop()}）`)
          continue
        }
      }
      toolCount += 1
      if (toolOwners.has(name)) toolClashes.push({ name, first: toolOwners.get(name), second: bundle })
      else toolOwners.set(name, bundle)
    }
  }
}

console.log(`  扫描到工具名 ${toolCount} 个（未能解析的标识符 ${unresolved} 个）`)
if (toolCount === 0) {
  console.log('  ⚠ 一个都没扫到 —— 检查器失效（假阴性），不能据此判定"无冲突"')
} else if (toolClashes.length === 0) {
  for (const [name, owner] of [...toolOwners].sort()) console.log(`    ${name}  ← ${owner}`)
} else {
  for (const hit of toolClashes) console.log(`  ✗ ${hit.name}  ${hit.first}  /  ${hit.second}`)
}

const failed =
  !homeSelfTestOk ||
  parseError !== undefined ||
  // 自检用自造样本，与"有没有装 QQ 插件"无关，所以不再加 `mine !== undefined` 前提——
  // 少了它，一个没有 QQ 插件的 profile 会让检查器跳过唯一证明自己可信的那一步。
  !selfTestOk ||
  toolClashes.length > 0 ||
  toolCount === 0
console.log(
  `\n${
    failed
      ? '有问题 ✗'
      : `拼接解析通过 ✓，检查器自检通过 ✓，工具名无冲突 ✓（${toolCount} 个）`
  }`,
)
process.exit(failed ? 1 : 0)
