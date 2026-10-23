/**
 * 文档里的测试数量检查。
 *
 * ## 为什么需要它
 *
 * 三个测试脚本各有多少项检查，这件事写在三个地方的三个句子里：`README.md`、
 * `README.zh.md`、`docs/RELEASING.md`。而这三个数是**手写的**。
 *
 * 手写的数会漂，而且已经漂过：发布前核对时文档里写的是 593 / 41 / 60，
 * 实际跑出来是 770 / 104 / 60（客户端那一项当时是 104）—— 宿主侧少了 177 项，是十二个提交里
 * 新增的检查没人同步。
 *
 * `docs/RELEASING.md` 里原来那句话自己就写着"不是从任何地方读出来的，是手写的"。
 * **它标注了这个风险，数字还是漂了。** 一句"改过测试记得同步"挡不住漂移，
 * 只有机器比对挡得住——所以这个文件存在。
 *
 * ## 实际数从哪来：运行输出，不是常量
 *
 * 三个数分别从三个测试脚本的 stdout 里**数出来**，检查器里**没有写死任何期望值**：
 *
 *   scripts/verify.mjs            → 以 `PASS` 开头的行数                （宿主侧）
 *   scripts/verify-send-path.mjs  → 以 `PASS` 开头的行数                （发送路径）
 *   scripts/verify-client.mjs     → 收尾行 `=== N/M checks passed ===` 里的 M（客户端）
 *
 * 写死一个期望值就等于把"数字该是多少"又搬回人的脑子里，那正是要根治的东西。
 * 输出里出现任何一行 `FAIL`（客户端则是 N≠M）直接判失败：
 * 拿一次没跑过的运行去对数字，比对出来的结论没有意义。
 *
 * ## 为什么读日志，而不是自己再跑一遍
 *
 * 自己再跑一遍 = **每次 CI 把整套测试跑两遍**（本机实测三个脚本合计约 6.5 秒，纯浪费），
 * 而且文档数字会对上一次**不在把关的那次**运行。所以：
 * CI 里那三个测试步骤把输出 `tee` 到 `$RUNNER_TEMP/dsh-qq-doc-counts/`，
 * 这一步只读那份输出——**跑一次，读一次**。
 *
 * 本机没有那份输出，所以 `--run` 会替你跑这三个脚本、顺手落盘，再比对（同样只跑一次）。
 * 注意 `scripts/` 不进 npm 包，所以 `--run` 只在完整 checkout 里可用；
 * 装出来的包里这个脚本只能读日志比对。工作流那一半同理：`.github/` 也不进包，
 * 它只在 checkout 里有对象——缺文件时判失败并说明，而不是悄悄跳过。
 *
 * ## 失败必须点名
 *
 * 报错写清**哪个文件、第几行、写的多少、实际多少**。而且三处的句子都必须**恰好出现一次**：
 * 句子被删掉或改写掉也判失败——否则"把这句话删了"就成了让这道闸消失的最省事办法，
 * 那它又会变回一个摆设。
 *
 * ## 反向对照
 *
 * 内建自检（每次运行都跑，在临时目录里，不碰真实文件）：先造一份**对得上**的文档和日志，
 * 然后逐个把数字改错一位、把句子删掉、给日志里塞一行 FAIL、把一个日志删掉——
 * 每一次都**必须**失败，并且必须点出对应的文件。自检不过就一律判失败：
 * 一个不能证明自己会失败的检查器，它的"通过"没有意义。
 *
 * ## 顺带核对：工作流里给用户抄的仓库名
 *
 * `.github/workflows/publish.yml` 的文件头把 npm Trusted Publisher 的四个字段写给用户抄，
 * 而它自己就写着"填错的表现**只是发布时 403**——不会有别的提示，也不会有更早的警告"。
 * 那句话当时对本仓库也成立：注释里的 `Repository` 写的是 `dsh-qq`，而 `package.json` 的
 * `repository`、`docs/RELEASING.md` 的字段表和两版 README 的 CI 徽章都说 `dsh-qq-plugin-group-expand`。
 * **照着抄的人会正好踩中那条 403，而本机没有任何检查会拦**——所以这道闸顺手把它也核对掉：
 * 注释里的三个字段必须等于 `package.json` / 本文件名，`Environment` 那一行必须仍然写着留空，
 * 文件头那句 `Actions → … → Run workflow` 必须与 `name:` 相符，两版 README 的 CI 徽章必须
 * 指向同一个仓库。四种破坏各有自检用例。
 *
 * 用法：
 *   node tools/check-doc-counts.mjs                    # 读已落盘的输出再比对（CI 用）
 *   node tools/check-doc-counts.mjs --run              # 本机：跑三个测试脚本 → 落盘 → 比对
 *   node tools/check-doc-counts.mjs --logs <目录>      # 指定输出目录（CI 传 $RUNNER_TEMP/...）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 三个测试脚本、它们落盘的日志名、以及"实际数"各自的名字。
 *
 * 顺序就是文档里那句话的顺序：宿主侧、客户端、发送路径。
 */
const SCRIPTS = [
  { key: 'host', script: join('scripts', 'verify.mjs'), log: 'verify.mjs.out' },
  { key: 'client', script: join('scripts', 'verify-client.mjs'), log: 'verify-client.mjs.out' },
  { key: 'send', script: join('scripts', 'verify-send-path.mjs'), log: 'verify-send-path.mjs.out' },
]

const LABELS = { host: '宿主侧检查', client: '客户端检查', send: '发送路径检查' }

/**
 * 三处文档里的句子。`groups` 说的是捕获组和哪个数对应。
 *
 * 句子必须**恰好出现一次**：多了说明有人在别处又抄了一份，少了说明这句话没了，
 * 两种都会让检查器悄悄失去对象，所以两种都判失败。
 */
const DOCS = [
  {
    file: 'README.md',
    what: '**N** host checks, **N** client checks, **N** send-path checks.',
    pattern:
      /\*\*(\d+)\*\*\s+host checks,\s*\*\*(\d+)\*\*\s+client checks,\s*\*\*(\d+)\*\*\s+send-path checks/g,
    groups: ['host', 'client', 'send'],
  },
  {
    file: 'README.zh.md',
    what: '**N** 项宿主侧检查、**N** 项客户端检查、**N** 项发送路径检查。',
    pattern: /\*\*(\d+)\*\*\s*项宿主侧检查、\s*\*\*(\d+)\*\*\s*项客户端检查、\s*\*\*(\d+)\*\*\s*项发送路径检查/g,
    groups: ['host', 'client', 'send'],
  },
  {
    file: join('docs', 'RELEASING.md'),
    what: '（宿主侧 N / 客户端 N / 发送路径 N）',
    pattern: /（宿主侧\s*(\d+)\s*\/\s*客户端\s*(\d+)\s*\/\s*发送路径\s*(\d+)\s*）/g,
    groups: ['host', 'client', 'send'],
  },
]

/**
 * 被核对的那份工作流：它的文件头把 npm Trusted Publisher 的四个字段写给用户抄。
 * 为什么要核对它，见 {@link workflowIdentity}。
 */
const WORKFLOW_FILE = join('.github', 'workflows', 'publish.yml')

/**
 * `publish.yml` 里给用户抄的那四个字段、工作流自己的名字，以及两版 README 的 CI 徽章，
 * 必须与仓库实际一致。
 *
 * 这是"填错只表现为 403"的根治：那道 403 在发布时才出现，而这里在**每一条 CI 与发布之前**
 * 就能拦住。四种破坏都判失败，并且都点名文件与行号；每一句也要求**恰好出现一处**——
 * 把句子删掉或改写掉不能让这道闸失去对象（与上面三条测试数量的句子同一个道理）。
 *
 * `package.json` 的 `repository` 是仓库名的权威来源：README 的徽章、`docs/RELEASING.md`
 * 的字段表和这份工作流的注释都只是它的副本。
 *
 * @returns `{ failures, lines }`；`lines` 是给人看的对照行。
 */
function workflowIdentity(root) {
  const failures = []
  const lines = []

  const workflowPath = join(root, WORKFLOW_FILE)
  let workflow
  let manifest
  try {
    workflow = readFileSync(workflowPath, 'utf8')
  } catch {
    failures.push(`读不到 ${WORKFLOW_FILE}——Trusted Publisher 的四个字段写在那里，读不到就没法核对`)
    return { failures, lines }
  }
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    failures.push(`读不到 package.json（仓库名的权威来源）：${String(error?.message ?? error)}`)
    return { failures, lines }
  }

  const repoUrl = String(manifest.repository?.url ?? '')
  const parsed = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repoUrl)
  if (parsed === null) {
    failures.push(`package.json 的 repository.url 不是一个 GitHub 地址：${repoUrl}`)
    return { failures, lines }
  }
  const [, owner, repo] = parsed
  lines.push(`  package.json 的 repository：${owner}/${repo}`)

  const fields = [
    { label: 'Organization or user', actual: owner, what: 'package.json 里的仓库属主' },
    { label: 'Repository', actual: repo, what: 'package.json 里的仓库名' },
    { label: 'Workflow filename', actual: basename(workflowPath), what: '本工作流的文件名' },
  ]

  for (const field of fields) {
    const found = [
      ...workflow.matchAll(new RegExp(`^#\\s+${field.label}\\s*:\\s*(.+?)\\s*$`, 'gm')),
    ]
    if (found.length !== 1) {
      failures.push(
        `${WORKFLOW_FILE}：注释里的「${field.label}」那一行期望恰好一处，实际找到 ${String(found.length)} 处` +
          '——删掉或改写它不能让这道闸失去对象，所以这里判失败',
      )
      continue
    }
    const written = found[0][1].trim()
    const line = workflow.slice(0, found[0].index).split('\n').length
    const ok = written === field.actual
    lines.push(
      `  ${`${WORKFLOW_FILE}:${String(line)}`.padEnd(36)} ${field.label.padEnd(19)} ${written}` +
        (ok ? '  ✓' : `  ✗（${field.what}是 ${field.actual}）`),
    )
    if (!ok) {
      failures.push(
        `${WORKFLOW_FILE}:${String(line)}  ${field.label}：注释里写 ${written}，${field.what}是 ${field.actual}`,
      )
    }
  }

  /*
   * `Environment` 不是"拿一个值来比"：它要求**留空**，也就是工作流不声明 `environment:`。
   * 所以两半都要对——注释还说留空，而工作流确实没有 environment。
   */
  const envFound = [...workflow.matchAll(/^#\s+Environment\s*:\s*(.+?)\s*$/gm)]
  if (envFound.length !== 1) {
    failures.push(
      `${WORKFLOW_FILE}：注释里的「Environment」那一行期望恰好一处，实际找到 ${String(envFound.length)} 处`,
    )
  } else {
    const written = envFound[0][1].trim()
    const line = workflow.slice(0, envFound[0].index).split('\n').length
    const declares = /^\s*environment\s*:/m.test(workflow)
    const saysEmpty = /leave empty/i.test(written)
    lines.push(
      `  ${`${WORKFLOW_FILE}:${String(line)}`.padEnd(36)} ${'Environment'.padEnd(19)} ${written}` +
        (declares ? '  ✗（工作流声明了 environment）' : saysEmpty ? '  ✓' : '  ✗（不再说留空）'),
    )
    if (declares) {
      failures.push(
        `${WORKFLOW_FILE}:${String(line)}  Environment：注释说留空，但这个工作流声明了 environment——npm 那一栏要跟着改，否则发布 403`,
      )
    } else if (!saysEmpty) {
      failures.push(
        `${WORKFLOW_FILE}:${String(line)}  Environment：注释里不再说"留空"，而工作流并没有 environment`,
      )
    }
  }

  // 文件头那句「Actions → <名字> → Run workflow」是用户找这个工作流的地方，它得对上 `name:`。
  const declaredName = /^name:\s*(.+?)\s*$/m.exec(workflow)?.[1].trim()
  if (declaredName === undefined) {
    failures.push(`${WORKFLOW_FILE}：没有 \`name:\`，文件头那句「Actions → …」无从核对`)
  } else {
    const points = workflow
      .split('\n')
      .some((line) => line.startsWith('#') && line.includes(`Actions → ${declaredName} →`))
    lines.push(
      `  ${WORKFLOW_FILE.padEnd(36)} ${'workflow name'.padEnd(19)} ${declaredName}` +
        (points ? '  ✓' : '  ✗（文件头没有指到它的「Actions → …」那句）'),
    )
    if (!points) {
      failures.push(
        `${WORKFLOW_FILE}：工作流名是 ${declaredName}，文件头却没有「Actions → ${declaredName} → Run workflow」那句——照它去点的人会找不到`,
      )
    }
  }

  // 两版 README 的 CI 徽章是同一份仓库名的另两个副本。
  for (const file of ['README.md', 'README.zh.md']) {
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      failures.push(`读不到 ${file}（它的 CI 徽章写着仓库地址）`)
      continue
    }
    const badges = [
      ...text.matchAll(
        /\[!\[CI\]\(https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/workflows\/ci\.yml\/badge\.svg\)/g,
      ),
    ]
    if (badges.length !== 1) {
      failures.push(`${file}：CI 徽章期望恰好一处，实际找到 ${String(badges.length)} 处`)
      continue
    }
    const [, badgeOwner, badgeRepo] = badges[0]
    const ok = badgeOwner === owner && badgeRepo === repo
    lines.push(
      `  ${file.padEnd(36)} ${'CI badge'.padEnd(19)} ${badgeOwner}/${badgeRepo}` + (ok ? '  ✓' : `  ✗（应为 ${owner}/${repo}）`),
    )
    if (!ok) {
      failures.push(
        `${file}：CI 徽章指的是 ${badgeOwner}/${badgeRepo}，package.json 的 repository 是 ${owner}/${repo}`,
      )
    }
  }

  return { failures, lines }
}

/** 从日志里数出实际数；数不出来（或那次运行本身没过）时把原因写进 failures。 */
function actualCounts(logsDir) {
  const actual = {}
  const notes = {}
  const failures = []

  for (const spec of SCRIPTS) {
    const logPath = join(logsDir, spec.log)
    actual[spec.key] = null
    if (!existsSync(logPath)) {
      failures.push(
        `缺少运行输出 ${logPath}——CI 里那三个测试步骤会把输出 tee 到这里；本机跑 --run 也会写到这里`,
      )
      continue
    }

    const log = readFileSync(logPath, 'utf8')
    const failed = (log.match(/^FAIL\b/gm) ?? []).length
    if (failed > 0) {
      failures.push(`${logPath} 里有 ${String(failed)} 行 FAIL：那次运行本身没过，数出来的数字不能用`)
    }

    if (spec.key === 'client') {
      // 客户端脚本的收尾行是唯一自带总数的输出：`=== 108/108 checks passed ===`。
      const match = /^=== (\d+)\/(\d+) checks passed ===$/m.exec(log)
      if (match === null) {
        failures.push(
          `${logPath} 里没找到收尾行 "=== N/M checks passed ==="——客户端脚本的输出格式变了，先修这个检查器`,
        )
        continue
      }
      if (match[1] !== match[2]) {
        failures.push(
          `${logPath} 说 ${match[1]}/${match[2]}：客户端脚本没有全过，总数不可信`,
        )
      }
      actual[spec.key] = Number(match[2])
      notes[spec.key] = `读收尾行 "=== ${match[1]}/${match[2]} checks passed ==="`
    } else {
      const pass = (log.match(/^PASS\b/gm) ?? []).length
      actual[spec.key] = pass
      notes[spec.key] = `数 ${String(pass)} 行 PASS`
    }
  }

  return { actual, notes, failures }
}

/** 从三处文档里读出写的数；句子缺失或被改写也记成失败。 */
function documentedCounts(root) {
  const docs = []
  const failures = []

  for (const spec of DOCS) {
    const path = join(root, spec.file)
    if (!existsSync(path)) {
      failures.push(`文档不存在：${path}`)
      docs.push({ file: spec.file, line: null, values: null })
      continue
    }

    const text = readFileSync(path, 'utf8')
    const matches = [...text.matchAll(spec.pattern)]
    if (matches.length !== 1) {
      failures.push(
        `${spec.file}：期望恰好一句"测试数量"的话（${spec.what}），实际找到 ${String(matches.length)} 句` +
          '——这句话被删掉或改写都会让检查器失去对象，所以这里判失败',
      )
      docs.push({ file: spec.file, line: null, values: null })
      continue
    }

    const match = matches[0]
    const line = text.slice(0, match.index).split('\n').length
    const values = {}
    spec.groups.forEach((key, index) => {
      values[key] = Number(match[index + 1])
    })
    docs.push({ file: spec.file, line, values })
  }

  return { docs, failures }
}

/**
 * 完整检查：读实际数、读文档里的数、逐个比。
 *
 * 返回 `{ ok, failures, report }`——`report` 是给人看的全过程，`failures` 是判失败的原因。
 */
function inspect({ root, logsDir }) {
  const report = []
  const failures = []

  const { actual, notes, failures: countFailures } = actualCounts(logsDir)
  failures.push(...countFailures)

  report.push('实际数（从运行输出里数出来的，不是常量）：')
  for (const spec of SCRIPTS) {
    const value = actual[spec.key]
    report.push(
      `  ${LABELS[spec.key].padEnd(6, '　')} ${value === null ? '??' : String(value).padStart(4)}` +
        `   ${join(logsDir, spec.log)}${notes[spec.key] === undefined ? '' : `  ← ${notes[spec.key]}`}`,
    )
  }

  const { docs, failures: docFailures } = documentedCounts(root)
  failures.push(...docFailures)

  report.push('')
  report.push('文档里写的数：')
  for (const doc of docs) {
    const written = doc.values === null ? '(句子缺失或改写)' : `${String(doc.values.host)} / ${String(doc.values.client)} / ${String(doc.values.send)}`
    report.push(`  ${`${doc.file}:${doc.line ?? '-'}`.padEnd(26)} ${written}   （宿主侧 / 客户端 / 发送路径）`)
  }

  report.push('')
  report.push('逐个比对：')
  let compared = 0
  for (const doc of docs) {
    if (doc.values === null) continue
    for (const spec of SCRIPTS) {
      if (actual[spec.key] === null) continue
      compared += 1
      if (doc.values[spec.key] !== actual[spec.key]) {
        failures.push(
          `${doc.file}:${String(doc.line)}  ${LABELS[spec.key]}：文档写 ${String(doc.values[spec.key])}，实际 ${String(actual[spec.key])}`,
        )
      }
    }
  }
  report.push(
    compared === 0
      ? '  （一处都没比成——上面已经列出原因）'
      : `  ${String(compared)} 处比对完毕` + (failures.length === 0 ? '，全对' : '，下面是判失败的原因'),
  )

  /*
   * 第二件事：工作流注释里给用户抄的仓库名。它和文档里的数字是同一类东西——**手抄的副本**，
   * 抄错了没有任何编译器会拦，而这份副本抄错的代价是发布时的 403。
   */
  const identity = workflowIdentity(root)
  failures.push(...identity.failures)
  report.push('')
  report.push('工作流注释里的仓库名与实际（Trusted Publisher 的字段要照着这里抄）：')
  report.push(...identity.lines)

  return { ok: failures.length === 0 && compared > 0, failures, report, actual, docs }
}

/**
 * 反向对照：临时目录里造一份对得上的文档与日志，再逐个把数字改错/把句子删掉/把日志删掉。
 *
 * **每次都从 baseline 重来**，所以一个用例的破坏不会顺延到下一个用例——
 * 用真实文件改来改去时踩过这个坑（改没改成功都看不出来，于是"加了错却仍然通过"）。
 *
 * @returns 自检是否通过。
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-doc-counts-'))
  const root = join(dir, 'root')
  const logs = join(dir, 'logs')

  /*
   * 那份工作流。`over` 只用来造自检用例里的四种破坏（仓库名、属主、整块删掉、工作流改名）。
   * `fields: false` 就是"整块注释没了"。
   */
  const workflow = (over = {}) => {
    const values = {
      name: 'Publish',
      // 文件头那句里的名字，默认跟着 `name:`；自检里故意让两者不一致。
      headerName: undefined,
      org: 'jjjjjsgrmjjjjj',
      repo: 'dsh-qq-plugin-group-expand',
      file: 'publish.yml',
      env: '(leave empty — this workflow declares none)',
      fields: true,
      ...over,
    }
    const header = values.headerName ?? values.name
    const block = values.fields
      ? [
          `#   Organization or user : ${values.org}`,
          `#   Repository           : ${values.repo}`,
          `#   Workflow filename    : ${values.file}`,
          `#   Environment          : ${values.env}`,
          '#',
        ]
      : []
    return [
      '# Publish to npm when a version tag is pushed.',
      '#',
      `# Actions → ${header} → Run workflow.`,
      '#',
      ...block,
      `name: ${values.name}`,
      '',
      'on:',
      '  push:',
      "    tags: ['v*']",
      '',
      'jobs:',
      '  publish:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
    ].join('\n')
  }

  /*
   * 徽章在第 2 行、数量那句仍在第 3 行：下面几个"数字改错"的用例写的是 `# t\n\n**N** …`，
   * 数量那句同样落在第 3 行，于是 `README.md:3` 这类点名照旧成立。
   */
  const badge = (repo) =>
    `[![CI](https://github.com/jjjjjsgrmjjjjj/${repo}/actions/workflows/ci.yml/badge.svg)](https://github.com/jjjjjsgrmjjjjj/${repo}/actions/workflows/ci.yml)`

  const baseline = () => {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      join(root, 'README.md'),
      `# t\n${badge('dsh-qq-plugin-group-expand')}\n**3** host checks, **5** client checks, **2** send-path checks.\n`,
      'utf8',
    )
    writeFileSync(
      join(root, 'README.zh.md'),
      `# t\n${badge('dsh-qq-plugin-group-expand')}\n**3** 项宿主侧检查、**5** 项客户端检查、**2** 项发送路径检查。\n`,
      'utf8',
    )
    writeFileSync(
      join(root, 'docs', 'RELEASING.md'),
      '# t\n\n（宿主侧 3 / 客户端 5 / 发送路径 2）。\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-qq-plugin-group-expand',
          repository: { type: 'git', url: 'git+https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand.git' },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    writeFileSync(join(root, WORKFLOW_FILE), workflow(), 'utf8')
    writeFileSync(join(logs, 'verify.mjs.out'), 'PASS  一\nPASS  二\nPASS  三\n', 'utf8')
    writeFileSync(join(logs, 'verify-client.mjs.out'), '\n=== 5/5 checks passed ===\n', 'utf8')
    writeFileSync(join(logs, 'verify-send-path.mjs.out'), 'PASS  甲\nPASS  乙\n', 'utf8')
  }

  /** name 说明破坏方式，mentions 是失败信息里必须出现的字串。 */
  const cases = [
    { name: '原样（3/5/2 对 3/5/2）', mutate: () => {}, expectOk: true, mentions: [] },
    {
      name: '把 README.md 的宿主侧改成 4（错一位）',
      mutate: () =>
        writeFileSync(
          join(root, 'README.md'),
          '# t\n\n**4** host checks, **5** client checks, **2** send-path checks.\n',
          'utf8',
        ),
      expectOk: false,
      showFailure: true,
      mentions: ['README.md:3', '宿主侧检查', '文档写 4', '实际 3'],
    },
    {
      name: '把 README.zh.md 的客户端改成 6',
      mutate: () =>
        writeFileSync(
          join(root, 'README.zh.md'),
          '# t\n\n**3** 项宿主侧检查、**6** 项客户端检查、**2** 项发送路径检查。\n',
          'utf8',
        ),
      expectOk: false,
      mentions: ['README.zh.md:3', '客户端检查', '文档写 6', '实际 5'],
    },
    {
      name: '把 RELEASING.md 的发送路径改成 3',
      mutate: () =>
        writeFileSync(
          join(root, 'docs', 'RELEASING.md'),
          '# t\n\n（宿主侧 3 / 客户端 5 / 发送路径 3）。\n',
          'utf8',
        ),
      expectOk: false,
      mentions: [join('docs', 'RELEASING.md') + ':3', '发送路径检查', '文档写 3', '实际 2'],
    },
    {
      name: '把 README.md 那句话删掉（改写句子不能变成免检）',
      mutate: () => writeFileSync(join(root, 'README.md'), '# t\n\n检查项数见 CI。\n', 'utf8'),
      expectOk: false,
      mentions: ['README.md', '实际找到 0 句'],
    },
    {
      name: '把 README.zh.md 那句话抄成两份',
      mutate: () =>
        writeFileSync(
          join(root, 'README.zh.md'),
          '# t\n\n**3** 项宿主侧检查、**5** 项客户端检查、**2** 项发送路径检查。\n' +
            '**3** 项宿主侧检查、**5** 项客户端检查、**2** 项发送路径检查。\n',
          'utf8',
        ),
      expectOk: false,
      mentions: ['README.zh.md', '实际找到 2 句'],
    },
    {
      name: '给宿主侧日志塞一行 FAIL',
      mutate: () =>
        writeFileSync(
          join(logs, 'verify.mjs.out'),
          'PASS  一\nFAIL  二  期望 x，实际 y\nPASS  三\n',
          'utf8',
        ),
      expectOk: false,
      mentions: ['1 行 FAIL', '那次运行本身没过'],
    },
    {
      name: '把发送路径的日志删掉',
      mutate: () => rmSync(join(logs, 'verify-send-path.mjs.out'), { force: true }),
      expectOk: false,
      mentions: ['缺少运行输出', 'verify-send-path.mjs.out'],
    },
    {
      name: '把 publish.yml 的 Repository 写回 dsh-qq（那次发布 403 的根源）',
      mutate: () => writeFileSync(join(root, WORKFLOW_FILE), workflow({ repo: 'dsh-qq' }), 'utf8'),
      expectOk: false,
      mentions: ['publish.yml', 'Repository', 'package.json'],
    },
    {
      name: '把 publish.yml 的 Organization 改一个字母',
      mutate: () => writeFileSync(join(root, WORKFLOW_FILE), workflow({ org: 'xcisxc' }), 'utf8'),
      expectOk: false,
      mentions: ['Organization or user', 'package.json'],
    },
    {
      name: '把 publish.yml 的四个字段整块删掉（删掉不能变成免检）',
      mutate: () => writeFileSync(join(root, WORKFLOW_FILE), workflow({ fields: false }), 'utf8'),
      expectOk: false,
      mentions: ['Organization or user', '实际找到 0 处'],
    },
    {
      name: '把工作流改名（文件头那句 Actions → … 就对不上了）',
      // 只改 `name:`，文件头那句仍写着旧名字——正是"改了名没人改注释"的那一步。
      mutate: () =>
        writeFileSync(join(root, WORKFLOW_FILE), workflow({ name: 'Release', headerName: 'Publish' }), 'utf8'),
      expectOk: false,
      mentions: ['Actions → Release →', '工作流名是 Release'],
    },
    {
      name: '把 README.md 的 CI 徽章指到另一个仓库',
      mutate: () =>
        writeFileSync(
          join(root, 'README.md'),
          `# t\n${badge('dsh-qq')}\n**3** host checks, **5** client checks, **2** send-path checks.\n`,
          'utf8',
        ),
      expectOk: false,
      mentions: ['README.md', 'CI 徽章'],
    },
  ]

  let passed = 0
  const failures = []
  for (const testCase of cases) {
    baseline()
    testCase.mutate()
    const result = inspect({ root, logsDir: logs })
    const mentionsOk = testCase.mentions.every((needle) => result.failures.join('\n').includes(needle))
    const ok = result.ok === testCase.expectOk && mentionsOk
    if (ok) passed += 1
    else {
      failures.push(
        `  ✗ ${testCase.name}：期望 ${testCase.expectOk ? '通过' : '失败'}，实际 ${result.ok ? '通过' : '失败'}` +
          (mentionsOk ? '' : `，但失败信息里缺少 ${JSON.stringify(testCase.mentions.filter((n) => !result.failures.join('\n').includes(n)))}`) +
          `\n      实际原因：${result.failures.join(' | ') || '(无)'}`,
      )
    }
    if (testCase.expectOk) continue
    // 反向对照要看得见"点名"长什么样，所以把错一位那条的报错原文打出来。
    if (testCase.showFailure === true) {
      console.log(`      反向对照的报错原文：${result.failures[0]}`)
    }
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`  自检：${String(passed)}/${String(cases.length)} 个反向对照用例符合预期`)
  for (const failure of failures) console.log(failure)
  return passed === cases.length
}

/** 跑三个测试脚本、把输出写到日志目录。退出码非零时不再往下比。 */
function capture(root, logsDir) {
  mkdirSync(logsDir, { recursive: true })
  let ok = true
  for (const spec of SCRIPTS) {
    const script = join(root, spec.script)
    if (!existsSync(script)) {
      console.log(`  ✗ 找不到 ${script}（--run 需要完整 checkout：scripts/ 不进 npm 包）`)
      ok = false
      continue
    }
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
    writeFileSync(join(logsDir, spec.log), text, 'utf8')
    const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
    console.log(`  ${spec.script} → 退出码 ${String(run.status)}，${String(lines)} 行输出 → ${join(logsDir, spec.log)}`)
    if (run.status !== 0) {
      ok = false
      for (const line of text.split('\n').filter((line) => /^FAIL\b/.test(line))) console.log(`      ${line}`)
    }
  }
  return ok
}

// ---- 入口 -------------------------------------------------------------------

const argv = process.argv.slice(2)
let root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let logsDir = join(tmpdir(), 'dsh-qq-doc-counts')
let run = false
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i]
  if (flag === '--run') run = true
  else if (flag === '--root' || flag === '--logs') {
    i += 1
    if (argv[i] === undefined) {
      console.error(`${flag} 后面要跟一个目录`)
      process.exit(1)
    }
    if (flag === '--root') root = resolve(argv[i])
    else logsDir = resolve(argv[i])
  } else {
    console.error(`未知参数 ${flag}`)
    console.error('用法：node tools/check-doc-counts.mjs [--run] [--root <目录>] [--logs <目录>]')
    process.exit(1)
  }
}

console.log('=== 自检（反向对照）===')
const selfOk = selfTest()
console.log('')

if (run) {
  console.log(`=== 跑三个测试脚本，输出落到 ${logsDir} ===`)
  const captured = capture(root, logsDir)
  console.log('')
  if (!captured) {
    console.log('测试本身没过，先修测试；文档数字这一步没有意义')
    process.exit(1)
  }
}

console.log(`=== 比对（根目录 ${root}）===`)
const result = inspect({ root, logsDir })
for (const line of result.report) console.log(line)

if (!selfOk) {
  console.log('')
  console.log('自检没过：这个检查器不能证明自己会失败，它的"通过"不算数')
}
if (result.failures.length > 0) {
  console.log('')
  for (const failure of result.failures) console.log(`✗ ${failure}`)
}
console.log('')
if (selfOk && result.ok) {
  console.log('文档里的测试数量与实际运行一致，工作流注释里给用户抄的仓库名与仓库实际一致')
  process.exit(0)
}
console.log('检查没过：文档里的测试数量、或工作流注释里的仓库名（原因见上）')
process.exit(1)
