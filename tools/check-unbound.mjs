/**
 * 未绑定标识符检查（一个有针对性的迷你 `no-undef`）。
 *
 * ## 为什么需要它
 *
 * 已经踩过一次，代价是**功能整条静默失效**：
 *
 * ```
 * ERROR 处理入站消息失败: ReferenceError: WORKSPACE_DIR_NAME is not defined
 * ```
 *
 * `WORKSPACE_DIR_NAME` 定义在 `lib/paths.js` 并导出了，但 `lib/runtime.js` 里
 * **忘了 import 就直接用**。`node --check` 只解析语法，这种自由变量它看不出来；
 * 单元测试也抓不到，因为那条路径要有一条真实入站消息才会走到。
 *
 * 症状极具迷惑性：用户的图片和语音**全部没有反应**，媒体目录从未被创建，
 * 而日志里只有一行 `处理入站消息失败`。
 *
 * ## 检查什么
 *
 * 只查 **SCREAMING_SNAKE_CASE** 标识符（`WORKSPACE_DIR_NAME`、`DEFAULT_*`、
 * `TEXT_CHUNK_LIMIT` 这类）。理由是取舍：
 *
 * - 常量/配置名正是这类"定义在别的模块、忘了导入"事故的常客
 * - 范围窄，所以**误报可以压到零**；一个满是误报的检查器会被无视
 * - 小写标识符要做完整作用域分析才能判准（函数参数、块级作用域、catch 绑定…），
 *   那种检查器写不对反而制造噪音
 *
 * 为了保证零误报，扫描前用**状态机**剥掉注释与字符串字面量
 * （模板字面量只剥字面部分、保留 `${…}` 里的表达式）——按行用正则剥会在
 * `https://…` 这种含 `//` 的字符串上出错，今天已经因此误报过一次。
 *
 * 用法：node tools/check-unbound.mjs <目录> [更多目录…]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 这些是运行时/宿主提供的全局名字，不必声明。 */
const GLOBALS = new Set([
  'Buffer', 'Date', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet',
  'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'Function', 'Proxy',
  'Reflect', 'Intl', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'Event', 'EventTarget',
  'NaN', 'Infinity', 'undefined', 'globalThis', 'process', 'console', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'fetch',
  'CUSTOM', 'AUTO', // 说明性文字里偶尔出现，保留以免噪音
])

/**
 * 走一遍源码，只留下"代码"字符：注释与字符串字面量被替换成等长空格。
 *
 * 模板字面量只剥字面部分，`${…}` 里的表达式**原样保留**——否则
 * `` `${WORKSPACE_DIR_NAME}/x` `` 里的引用就看不见了。
 *
 * @param source - 文件内容。
 * @returns 与原文等长的"仅代码"文本（等长是为了行号仍然对得上）。
 */
export function stripCommentsAndStrings(source) {
  const out = source.split('')
  let i = 0
  const n = source.length
  /** 模板字面量的花括号深度栈：进入 `${` 时压入。 */
  const templateDepths = []
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '
  }

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    // 行注释
    if (ch === '/' && next === '/') {
      let j = i
      while (j < n && source[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    // 块注释
    if (ch === '/' && next === '*') {
      let j = i + 2
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j += 1
      j = Math.min(n, j + 2)
      blank(i, j)
      i = j
      continue
    }
    // 单/双引号字符串
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 1
        j += 1
      }
      j = Math.min(n, j + 1)
      blank(i, j)
      i = j
      continue
    }
    // 模板字面量：只剥字面，保留 ${…}
    if (ch === '`') {
      let j = i + 1
      let literalStart = i
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '`') {
          blank(literalStart, j + 1)
          j += 1
          break
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          blank(literalStart, j + 2)
          templateDepths.push(1)
          j += 2
          literalStart = j
          // 在 ${…} 内部继续走，直到配对的 }
          while (j < n && templateDepths.length > 0) {
            const c = source[j]
            if (c === '{') templateDepths[templateDepths.length - 1] += 1
            else if (c === '}') {
              templateDepths[templateDepths.length - 1] -= 1
              if (templateDepths[templateDepths.length - 1] === 0) {
                templateDepths.pop()
                j += 1
                break
              }
            }
            j += 1
          }
          literalStart = j
          continue
        }
        j += 1
      }
      i = j
      continue
    }
    i += 1
  }
  return out.join('')
}

/** 收集一个模块里所有被绑定的 SCREAMING_SNAKE 名字。 */
export function boundNames(code) {
  const bound = new Set()
  const patterns = [
    /(?:^|[^\w$.])(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})/g,
    /(?:^|[^\w$.])(?:const|let|var)\s*\{([^}]*)\}/g, // 解构
    /import\s*\{([^}]*)\}\s*from/g,
    /import\s+([A-Z][A-Z0-9_]{2,})\s+from/g,
    /export\s+(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})/g,
    /catch\s*\(\s*([A-Z][A-Z0-9_]{2,})\s*\)/g,
  ]
  /*
   * ⚠️ 刻意**没有**"`NAME,` / `NAME)` 即参数"这条模式。
   *
   * 第一版加了它，结果把 `mediaDir(this.#home, WORKSPACE_DIR_NAME)` 里的**调用实参**
   * 也当成了绑定——于是这个检查器对**它本该抓的那个 bug 报了"通过"**。
   * 假阴性比假阳性危险得多：假阳性会被看见并修掉，假阴性会被当成"没问题"。
   *
   * 常量名做函数参数的情况极少，真出现了就当假阳性、加白名单即可。
   */
  for (const re of patterns) {
    for (const match of code.matchAll(re)) {
      if (match[1] === undefined) continue
      /*
       * 一律按逗号切分再 trim。
       *
       * 第一版只在"含逗号"时才走切分分支，于是**单名 import** 被原样（含首尾空格）
       * 加进了绑定集合，永远匹配不上使用处的名字——检查器把
       * `import { WORKSPACE_DIR_NAME } from './paths.js'` 判成了"未绑定"。
       * 多名的走切分分支所以正常，这个不对称正是它藏得住的原因。
       */
      for (const part of match[1].split(',')) {
        // 处理 `X as Y`、`X: Y`、`X = default` 这几种别名写法，取真正绑定的那个名字。
        const name = part
          .trim()
          .split(/\s+as\s+|\s*[:=]\s*/)
          .pop()
          ?.trim()
        if (name !== undefined && /^[A-Z][A-Z0-9_]{2,}$/.test(name)) bound.add(name)
      }
    }
  }
  return bound
}

/**
 * 收集一个模块里出现的所有 SCREAMING_SNAKE 名字。
 *
 * 两处排除，都是为了消掉假阳性：
 * - **前面是 `.`** —— `process.env.DSH_HOME` 里的 `DSH_HOME` 是属性名，不是变量
 * - **后面是 `:`** —— `{ TOOL_NAME: 'x' }`、`case X:` 里的是对象键/标签，不是变量
 */
export function usedNames(code, lineOf) {
  const used = new Map()
  for (const match of code.matchAll(/(^|[^\w$.])([A-Z][A-Z0-9_]{2,})\b(:?)/g)) {
    const [, before, name, after] = match
    if (after === ':') continue
    if (before === '.') continue
    if (!used.has(name)) used.set(name, lineOf(match.index + before.length))
  }
  return used
}

function jsFilesUnder(dir, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) jsFilesUnder(full, out, depth + 1)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('用法：node tools/check-unbound.mjs <目录> [更多目录…]')
  process.exit(1)
}

let reported = 0
let scanned = 0
for (const root of roots) {
  const target = resolve(root)
  const files = statSync(target).isDirectory() ? jsFilesUnder(target) : [target]
  for (const file of files) {
    scanned += 1
    const source = readFileSync(file, 'utf8')
    const code = stripCommentsAndStrings(source)
    const lineStarts = [0]
    for (let k = 0; k < code.length; k += 1) if (code[k] === '\n') lineStarts.push(k + 1)
    const lineOf = (index) => {
      let lo = 0
      let hi = lineStarts.length - 1
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (lineStarts[mid] <= index) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    }
    const bound = boundNames(code)
    for (const [name, line] of usedNames(code, lineOf)) {
      if (GLOBALS.has(name) || bound.has(name)) continue
      console.log(`  ✗ ${file.replace(resolve('.'), '.')}:${String(line)}  ${name} 未绑定`)
      reported += 1
    }
  }
}

console.log(`\n扫描 ${String(scanned)} 个文件，未绑定标识符 ${String(reported)} 个`)
process.exit(reported === 0 ? 0 : 1)
