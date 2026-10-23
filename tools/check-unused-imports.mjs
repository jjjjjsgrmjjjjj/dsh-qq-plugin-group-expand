/**
 * 未使用导入检查。
 *
 * ## 为什么需要它
 *
 * `check-unbound.mjs` 查"用了但没导入"，这个查**反过来**：导入了却没用。
 * 回退功能时很容易留下后者——删掉了使用点，却忘了删导入。
 *
 * 本项目的实例：回退"按钮"时 `#mediaDir` 改回用工作区路径，
 * `WORKSPACE_DIR_NAME` 就成了 `runtime.js` 里的死导入。
 *
 * ## 设计取舍：**绝不误报，宁可漏报**
 *
 * 前两版都在"用正则模拟 JS 词法"上翻车，两次都是**误报**：
 *
 * 1. 第一版在**剥掉字符串之后**提取导入名——可模块名本身就是字符串，
 *    `from 'node:os'` 变成 `from ''` 后匹配不上，于是**无论加多少未使用导入都报 0**。
 *    是反向对照揪出来的。
 * 2. 第二版剥字符串用的正则遇到不成对的引号会**跨行吞掉真实代码**，
 *    于是 `routes.js` 里真在用的 `logPath()` / `readFileSync()` 被判成未使用。
 *
 * 所以现在**不剥任何东西**，直接在原始源码里判使用，只把 import 语句本身排除
 * （按行找：以 `import` 开头的那一行，到含 `from '…'` 的那一行为止）。
 *
 * 代价是：一个名字**只出现在注释或字符串里**会被算成"已使用"，也就是漏报。
 * 这个方向的错是可以接受的——它只会漏掉一个死导入；
 * 而误报会让使用者不再相信这个检查器，那它就连漏报的价值都没有了。
 *
 * 用法：node tools/check-unused-imports.mjs <目录或文件> […]
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function jsFilesUnder(dir, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) jsFilesUnder(full, out, depth + 1)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/**
 * 收集导入名（含 `as` 别名、默认导入、命名空间导入）。
 *
 * 只看**原始源码**——导入语句不会藏在注释或字符串里。
 */
function importedNames(source) {
  const names = []
  for (const match of source.matchAll(/^[ \t]*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm)) {
    const clause = match[1].trim()
    const braced = /\{([\s\S]*?)\}/.exec(clause)
    if (braced !== null) {
      for (const part of braced[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim()
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
      }
    }
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (namespace !== null) names.push(namespace[1])
    const bare = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)
    if (bare !== null && !clause.startsWith('{') && !clause.startsWith('*')) names.push(bare[1])
  }
  return names
}

/**
 * 去掉 import 语句（**按行**，不碰其它任何东西）。
 *
 * 行式判定的好处是它不可能跨行吞掉真实代码——而那正是第二版的失败方式。
 */
function withoutImportStatements(source) {
  const lines = source.split('\n')
  const kept = []
  let insideImport = false
  for (const line of lines) {
    if (!insideImport && /^[ \t]*import\b/.test(line)) {
      // 一行写完的导入（含 `from '…'`）直接整行丢掉。
      if (/from\s*['"][^'"]+['"]/.test(line)) continue
      insideImport = true
      continue
    }
    if (insideImport) {
      // 多行导入：找到含 `from '…'` 的那一行，连它一起丢掉。
      if (/from\s*['"][^'"]+['"]/.test(line)) insideImport = false
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * 自检：**用临时文件**验证"能抓到未使用的、不误报在用的"。
 *
 * ## 为什么必须做，而且必须用临时文件
 *
 * 这个检查器的前两版都是**坏的，而且都报 0**——一个永远报 0 的检查器看起来
 * 和"代码很干净"完全一样。前两版的失败分别来自：
 * 剥字符串后才提取导入名（模块名被剥没了）、以及剥字符串的正则跨行吞掉真实代码。
 * 两次都是**反向对照**发现的，而不是靠读代码。
 *
 * 而做反向对照时我用 PowerShell 去改真实文件，**连续两次没改成功**
 * （heredoc 被转义吃掉），于是"加了未使用导入却仍然报 0"——
 * 那是脚手架在骗人，不是检查器在工作。
 *
 * 所以自检内建在这里：**建临时文件、当场验证、当场删掉**，不碰任何真实代码。
 *
 * @returns 自检是否通过。
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-unused-'))
  const file = join(dir, 'sample.mjs')
  // `usedName` 真被用；`unusedName` 只出现在导入行里。
  writeFileSync(
    file,
    [
      "import { usedName, unusedName } from './somewhere.js'",
      "import defaultThing from './default.js'",
      '',
      'export function run() {',
      '  return usedName() + defaultThing()',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  try {
    const source = readFileSync(file, 'utf8')
    const body = withoutImportStatements(source)
    const names = importedNames(source)
    const flagged = names.filter(
      (name) => !new RegExp(`(^|[^\\w$.])${name.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(body),
    )
    const ok =
      names.includes('usedName') &&
      names.includes('unusedName') &&
      names.includes('defaultThing') &&
      flagged.includes('unusedName') &&
      !flagged.includes('usedName') &&
      !flagged.includes('defaultThing')
    if (!ok) {
      console.log(`  自检失败：提取到 ${JSON.stringify(names)}，判为未使用 ${JSON.stringify(flagged)}`)
      console.log('  期望：提取到三个名字，只把 unusedName 判为未使用')
    } else {
      console.log('  自检通过：抓到未使用的、没误报在用的（含默认导入）')
    }
    return ok
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('用法：node tools/check-unused-imports.mjs <目录或文件> […]')
  process.exit(1)
}

console.log('=== 自检 ===')
const selfOk = selfTest()
console.log('')

let reported = 0
let scanned = 0
for (const root of roots) {
  const target = resolve(root)
  const files = statSync(target).isDirectory() ? jsFilesUnder(target) : [target]
  for (const file of files) {
    scanned += 1
    const source = readFileSync(file, 'utf8')
    const body = withoutImportStatements(source)
    for (const name of new Set(importedNames(source))) {
      const used = new RegExp(`(^|[^\\w$.])${name.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(body)
      if (!used) {
        console.log(`  ✗ ${file.replace(resolve('.'), '.')}  ${name} 已导入但未使用`)
        reported += 1
      }
    }
  }
}

console.log(`\n扫描 ${String(scanned)} 个文件，未使用导入 ${String(reported)} 个`)
// 自检不过就一律判定失败：一个不能证明自己的检查器，它的"0"没有意义。
process.exit(selfOk && reported === 0 ? 0 : 1)
