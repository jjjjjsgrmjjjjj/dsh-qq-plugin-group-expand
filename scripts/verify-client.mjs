/**
 * Syntax, registration-shape and state-flow check for the QQ settings-page client.
 *
 * ## What this verifies — and what it does not
 *
 * It verifies the *registration shape*: that `client.js` loads under a stubbed browser baseline,
 * that it registers exactly one module under the id `dsh-qq-plugin-group-expand`, that the factory returns
 * `{ name, inject, apply }` with `inject` exactly `['slots']`, that `apply` runs without throwing
 * against a stubbed context, and that every disposer it hands to `ctx.effect` is callable.
 *
 * It verifies the *watchdog*: that a loaded-but-unregistered bundle is still reported, that a
 * registered section with the settings page never opened is **not** reported (that was the false
 * positive: the signal used to be set in the component body, which only runs when the user opens
 * the page), and that the optional `slots.onEntryError` seam is used when the shell offers it and
 * costs nothing when it does not. `navigator.sendBeacon` is stubbed so each report is observed for
 * real rather than merely parsed.
 *
 * It verifies the *state flow* of the form (section 8): the component is run against a stand-in
 * React — state cells, collected effects — and a stand-in `fetch`, and the element tree it returns
 * is walked as plain objects. That is where the unsaved-changes note, the naming of a field the host
 * refused, and the difference between a cancelled dialog and a broken one are asserted.
 *
 * ⚠️ None of this is a visual check. Nothing is laid out, no CSS is applied, no DOM is built and no
 * browser or live host is involved: the assertions are about registration shape, state transitions,
 * copy keys, and the values the page sent against the values the host answered with. Visual
 * verification is unavailable from this harness and is not claimed.
 *
 * Run: node scripts/verify-client.mjs   (from the dsh-qq package directory)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/**
 * 去掉块注释后的源码。
 *
 * 静态命名检查必须看**代码**而不是**注释**：本文件的文件头注释里刻意写了
 * `dsh-wechat-plugin/client.js` 来解释那次跨插件顶层冲突，若对整份文本做子串检查，
 * 这段有价值的说明反而会被判成"还留着微信前缀"。
 *
 * 只剥块注释、不剥行注释：源码里有 `https://…` 这种含 `//` 的字面量，
 * 粗暴地按 `//` 切会把它们也砍掉。
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '')

const failures = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`PASS  ${label}${detail === '' ? '' : ` — ${detail}`}`)
    return
  }
  failures.push(label)
  console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, ok, ok ? JSON.stringify(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log('=== dsh-qq-plugin-group-expand client.js verification ===\n')
console.log('-- 1. Static source checks --')

check('no dsh-wechat- CSS prefix remains', !code.includes('dsh-wechat'))
check('no dsh-wechat-plugin id remains', !code.includes("id: 'dsh-wechat-plugin'"))
check("PREFIX is '/.dsh-qq-plugin-group-expand'", source.includes("const PREFIX = '/.dsh-qq-plugin-group-expand'"))
check("no Harness client package is required as a module", !/require\(\s*'@deepseek-ai/.test(source))
check('style element id is dsh-qq-style', source.includes("getElementById('dsh-qq-style')"))

// The three behaviours below are the ones that cannot be checked by registration shape alone, and
// each exists because of a concrete host behaviour. They are asserted as source facts, not as
// runtime behaviour: there is no renderer here (see the header).
check('the bound-account list is read from GET /accounts', code.includes('request(`${PREFIX}/accounts`)'))
check(
  'login polling keys off a settled-phase blacklist, not the word running',
  code.includes('if (!loginInFlight(prev.login?.phase)) return prev') &&
    !code.includes("prev.login?.phase !== 'running'"),
)
check(
  'the settings save sends only the fields this page owns',
  code.includes('for (const key of SETTINGS_FIELDS)') &&
    !code.includes('body: JSON.stringify(state.draft)'),
)

/*
 * The help link.
 *
 * It used to point at `https://bot.q.qq.com/wiki/`, which is the platform's documentation: a user
 * who follows it to find out which switch stops the agent asking before every command finds nothing
 * about this plugin. The link is the one piece of user documentation the page offers, so where it
 * goes is a fact worth pinning — and the two halves are a pair: the value names the handbook, and
 * the handbook has to be a file that exists in this repository.
 *
 * Read through `code` (comments stripped): the file header explains the change and quotes the old
 * address, and a substring check over the raw source would trip on that explanation.
 */
const handbookUrl = /const HANDBOOK_URL = '([^']*)'/.exec(code)?.[1]
equal(
  '★ the help link is the user handbook',
  handbookUrl,
  'https://github.com/jjjjjsgrmjjjjj/dsh-qq-plugin-group-expand/blob/main/docs/HANDBOOK-USER.md',
)
check(
  '★ reverse control: the help link is no longer the official QQ bot wiki',
  handbookUrl !== 'https://bot.q.qq.com/wiki/',
  String(handbookUrl),
)
{
  // The repository path in the URL has to be the path on disk, or the link 404s for every user.
  const linked = /dsh-qq-plugin-group-expand\/blob\/main\/(.+)$/.exec(handbookUrl ?? '')?.[1]
  check('the link names a path inside the repository', typeof linked === 'string', String(linked))
  let handbook
  try {
    handbook = readFileSync(join(here, '..', linked ?? ''), 'utf8')
  } catch {
    handbook = undefined
  }
  check(
    '★ the linked handbook file exists in this repository',
    typeof handbook === 'string' && handbook.length > 1000,
    handbook === undefined ? 'not found' : `${handbook.length} bytes`,
  )
}

console.log('\n-- 2. Registration under a stubbed browser baseline --')

/** The registration spec the module hands to the shell. */
let registered
/** react module ids the factory asked for. */
const requested = []
/** Watchdog timers the factory scheduled. */
const timers = []

const realGlobals = {}
const defined = ['window', 'document', 'navigator']

function defineGlobal(name, value) {
  realGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

/** Beacon payloads, so the client-error path can be observed. */
const beacons = []
/** `<style>` elements the plugin appended to head. */
const appended = []
/** Teardown events, in order, so the disposers can be observed rather than assumed. */
const disposed = []

defineGlobal('window', {
  __ModuleLoader__: { load: (spec) => { registered = spec } },
  addEventListener: () => {},
  removeEventListener: () => {},
})
defineGlobal('document', {
  documentElement: { lang: 'zh-CN' },
  getElementById: () => null,
  createElement: () => ({
    id: '',
    textContent: '',
    remove: () => disposed.push('style'),
  }),
  head: { append: (element) => appended.push(element) },
})
defineGlobal('navigator', {
  language: 'zh-CN',
  sendBeacon: (url, blob) => {
    beacons.push({ url, blob })
    return true
  },
})
// A real 20-second timer would hold the process open; capturing it also lets the test fire it.
defineGlobal('setTimeout', (callback, delay) => {
  timers.push({ callback, delay })
  return timers.length
})

try {
  await import(pathToFileURL(clientPath).href)
} catch (error) {
  check('client.js imports without throwing', false, error instanceof Error ? error.message : String(error))
}

check('module registered a spec at load time', registered !== undefined && registered !== null)
equal('registered id is dsh-qq-plugin-group-expand', registered?.id, 'dsh-qq-plugin-group-expand')
check('registered spec carries a factory', typeof registered?.factory === 'function')

// The factory is what receives `require`; React is the only baseline module this client uses.
const React = {
  createElement: () => ({}),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const exports_ = registered?.factory((id) => {
  requested.push(id)
  if (id === 'react') return React
  throw new Error(`unexpected module request: ${id}`)
})

console.log('\n-- 3. Factory exports --')

check('factory returned an object', typeof exports_ === 'object' && exports_ !== null)
const keys = Object.keys(exports_ ?? {}).sort()
equal('exports are exactly apply/inject/name', keys, ['apply', 'inject', 'name'])
equal('name is dsh-qq-plugin-group-expand', exports_?.name, 'dsh-qq-plugin-group-expand')
equal("inject is exactly ['slots']", exports_?.inject, ['slots'])
check('apply is a function', typeof exports_?.apply === 'function')
equal('factory resolved react through the injected require', requested, ['react'])

console.log('\n-- 4. Watchdog timer --')

equal('one 20-second watchdog timer was scheduled', timers.map((timer) => timer.delay), [20_000])
check('the watchdog callback was captured rather than fired yet', typeof timers[0]?.callback, 'function')

console.log('\n-- 5. apply() against a stubbed context --')

/** Slot registrations seen. */
const slotRegistrations = []
/** Slot injections seen. */
const slotInjections = []

const ctx = {
  effect: (factory) => {
    ctx.effectCalls += 1
    // `apply` returns the disposer from the effect callback, which is the plugin contract.
    ctx.effectDisposer = factory()
    return () => {}
  },
  effectCalls: 0,
  slots: {
    inject: (slot, factory) => {
      slotInjections.push(slot)
      factory()
      return () => disposed.push('slot')
    },
    register: (options, component) => {
      slotRegistrations.push({ options, component })
      return () => disposed.push('register')
    },
  },
}

let applyError
try {
  exports_.apply(ctx)
} catch (error) {
  applyError = error
}
check(
  'apply(ctx) does not throw',
  applyError === undefined,
  applyError === undefined ? '' : String(applyError),
)
equal('apply registered exactly one effect', ctx.effectCalls, 1)
equal('effect callback returned a disposer function', typeof ctx.effectDisposer, 'function')
equal('slot injected is settings.section', slotInjections, ['settings.section'])
equal('one slot registration', slotRegistrations.length, 1)
equal('registration name is settings.section', slotRegistrations[0]?.options?.name, 'settings.section')
equal("registration id is 'qq'", slotRegistrations[0]?.options?.id, 'qq')
equal('registration order stays 40', slotRegistrations[0]?.options?.order, 40)
check('registration carries a component', typeof slotRegistrations[0]?.component === 'function')
equal('registration label() is the nav entry', slotRegistrations[0]?.options?.label?.(), 'QQ')
equal('registration inject() returns an empty object', slotRegistrations[0]?.options?.inject?.(), {})

equal('one stylesheet was appended', appended.map((element) => element.id), ['dsh-qq-style'])
check(
  'the stylesheet carries the dsh-qq- class prefix',
  typeof appended[0]?.textContent === 'string' && appended[0].textContent.includes('.dsh-qq '),
)

if (typeof ctx.effectDisposer === 'function') {
  try {
    ctx.effectDisposer()
  } catch (error) {
    check('effect disposer runs without throwing', false, String(error))
  }
}
equal('disposer released the slot and removed the stylesheet', disposed, ['slot', 'style'])

console.log('\n-- 6. Watchdog health signal = the section was registered, not the page was opened --')

/**
 * Evaluate a second, independent copy of `client.js` in this same realm.
 *
 * The watchdog's flag lives per factory call, so "registered" and "not registered" can only be
 * compared between two evaluations. `new Function` re-runs the whole script (its own IIFE, its own
 * flag) without touching the module imported above.
 *
 * The stubs are installed around both the evaluation and the factory call, because the timer is
 * armed inside the factory — and again around `fireWatchdog()`, because `reportFailure` reads
 * `navigator.sendBeacon` at the moment it reports rather than capturing it.
 *
 * @param {object} react - React stand-in handed to the fresh factory.
 * @returns {{ exports: object, timers: object[], beacons: object[], fireWatchdog: () => void }}
 */
function loadFreshClient(react) {
  const state = { spec: undefined, timers: [], beacons: [] }
  const withStubs = (run) => {
    const previousLoad = window.__ModuleLoader__.load
    const previousTimeout = globalThis.setTimeout
    const previousBeacon = navigator.sendBeacon
    window.__ModuleLoader__.load = (value) => {
      state.spec = value
    }
    // Its own 20-second timer would hold the process open; capturing it also lets the test fire it.
    globalThis.setTimeout = (callback, delay) => {
      state.timers.push({ callback, delay })
      return state.timers.length
    }
    navigator.sendBeacon = (url, blob) => {
      state.beacons.push({ url, blob })
      return true
    }
    try {
      return run()
    } finally {
      window.__ModuleLoader__.load = previousLoad
      globalThis.setTimeout = previousTimeout
      navigator.sendBeacon = previousBeacon
    }
  }
  const freshExports = withStubs(() => {
    new Function(source)()
    return state.spec.factory((id) => {
      if (id === 'react') return react
      throw new Error(`unexpected module request: ${id}`)
    })
  })
  return {
    exports: freshExports,
    timers: state.timers,
    beacons: state.beacons,
    fireWatchdog: () =>
      withStubs(() => {
        for (const timer of state.timers) timer.callback?.()
      }),
  }
}

/** A slot registry that exists but whose `settings.section` slot is never declared. */
function undeclaredSlotContext() {
  return {
    effect: (factory) => factory(),
    slots: {
      // The shell never declares the slot, so the contributor is never run: nothing registers.
      inject: () => () => {},
      register: () => () => {},
    },
  }
}

/*
 * 6a. The false positive itself.
 *
 * The bundle has loaded and `apply` has registered the section, but the user has not opened
 * 设置 → QQ, so the component has never run. That state — the ordinary one on any launch that stays
 * in the conversation view — used to be reported as "设置页在 20 秒内没有渲染" once per boot.
 */
if (typeof timers[0]?.callback === 'function') {
  try {
    timers[0].callback()
  } catch (error) {
    check('watchdog callback runs without throwing', false, String(error))
  }
}
check(
  'a registered section with the page never opened is not reported (the old false positive)',
  beacons.length === 0,
  `${beacons.length} beacon(s)`,
)

// 6b. Reverse control: the failure the watchdog exists for is still reported — a bundle that loads
//     and never manages to register the section.
{
  const fresh = loadFreshClient(React)
  equal('reverse control: the fresh instance armed its own watchdog', fresh.timers.map((timer) => timer.delay), [20_000])
  fresh.fireWatchdog()
  equal('reverse control: nothing registered, so exactly one report', fresh.beacons.length, 1)
  equal('report went to PREFIX/client-error', fresh.beacons[0]?.url, '/.dsh-qq-plugin-group-expand/client-error')
  let body
  try {
    body = JSON.parse(await fresh.beacons[0]?.blob?.text?.())
  } catch {
    body = undefined
  }
  equal('report shape is { scope, message, stack }', Object.keys(body ?? {}).sort(), ['message', 'scope', 'stack'])
  // The scope names the step that failed. `mount` described a step this watchdog never watched.
  equal('report scope is register, not mount', body?.scope, 'register')
  check('the message names the step that failed (registration)', String(body?.message ?? '').includes('注册'), true)
  check('the message no longer claims the page failed to render', !String(body?.message ?? '').includes('没有渲染'), true)

  // 6c. The same failure through `apply`: the registry exists but never declares the slot — the case
  //     `slots.inject` exists for. Still reported.
  const second = loadFreshClient(React)
  let secondApplyError
  try {
    second.exports.apply(undeclaredSlotContext())
  } catch (error) {
    secondApplyError = error
  }
  check('declare-less shell: apply does not throw', secondApplyError === undefined, String(secondApplyError ?? ''))
  second.fireWatchdog()
  equal('declare-less shell: the watchdog still reports', second.beacons.length, 1)
}

/*
 * 6d. Static: the signal is set where the registration happens, and nowhere in the component body.
 *
 * The second half is what the old code got wrong, and it is asserted here rather than inferred: a
 * flag set only in the component body is a flag that says "somebody opened the page".
 */
{
  const registerAt = code.indexOf('ctx.slots.register(')
  const signalAt = code.indexOf('sectionRegistered = true')
  const componentAt = code.indexOf('function QqSettings(')
  const componentEnd = code.indexOf('function makePick(')
  check('the health signal is set in apply', signalAt > registerAt && registerAt >= 0)
  check(
    'the component body does not set it (that is the false positive: it only runs when opened)',
    componentAt >= 0 &&
      componentEnd > componentAt &&
      !code.slice(componentAt, componentEnd).includes('sectionRegistered'),
  )
}

/*
 * 6e. Render errors: an optional seam, subscribed when the shell offers it and harmless when not.
 *
 * These reports go through the stub installed below for the whole run, so they are counted on
 * `beacons` — the fresh instances' own arrays only see what is reported while their own stubs are
 * installed, which is the watchdog firing and nothing else.
 */
{
  const offered = loadFreshClient(React)
  const listeners = []
  const registeredComponents = []
  const renderCtx = {
    effect: (factory) => factory(),
    slots: {
      inject: (slot, factory) => {
        factory()
        return () => {}
      },
      register: (options, component) => {
        registeredComponents.push(component)
        return () => {}
      },
      onEntryError: (listener) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    },
  }
  let offeredError
  try {
    offered.exports.apply(renderCtx)
  } catch (error) {
    offeredError = error
  }
  check('onEntryError offered: apply does not throw', offeredError === undefined, String(offeredError ?? ''))
  equal('onEntryError offered: it was subscribed once', listeners.length, 1)
  const ourComponent = registeredComponents[0]
  if (typeof listeners[0] !== 'function') {
    check('a render crash of our own section is reported', false, 'no listener')
  } else {
    listeners[0]('settings.section', { component: ourComponent }, new Error('boom'))
    equal('a render crash of our own section is reported', beacons.length, 1)
    let renderBody
    try {
      renderBody = JSON.parse(await beacons[0]?.blob?.text?.())
    } catch {
      renderBody = undefined
    }
    equal('render crash is reported under scope render', renderBody?.scope, 'render')
    // Nothing else is attributed to us: another slot, or another plugin's component in our slot.
    listeners[0]('settings.section', { component: function Other() {} }, new Error('not ours'))
    listeners[0]('other.section', { component: ourComponent }, new Error('not our slot'))
    equal('another plugin\u2019s crash is not attributed to us', beacons.length, 1)
  }

  // A shell whose `onEntryError` itself throws: the extra coverage is lost, not the section.
  const broken = loadFreshClient(React)
  const reportsBefore = beacons.length
  let brokenError
  try {
    broken.exports.apply({
      effect: (factory) => factory(),
      slots: {
        inject: (slot, factory) => {
          factory()
          return () => {}
        },
        register: () => () => {},
        onEntryError: () => {
          throw new Error('no such channel')
        },
      },
    })
  } catch (error) {
    brokenError = error
  }
  check('a broken onEntryError does not fail activation', brokenError === undefined, String(brokenError ?? ''))
  equal('a broken onEntryError is itself reported', beacons.length - reportsBefore, 1)
  let brokenBody
  try {
    brokenBody = JSON.parse(await beacons[reportsBefore]?.blob?.text?.())
  } catch {
    brokenBody = undefined
  }
  equal('that report is scoped watchdog', brokenBody?.scope, 'watchdog')

  // A shell that has no such channel at all: the optional capability is simply absent.
  const absent = loadFreshClient(React)
  let absentError
  let absentDisposer
  try {
    absent.exports.apply({
      effect: (factory) => {
        absentDisposer = factory()
      },
      slots: {
        inject: (slot, factory) => {
          factory()
          return () => {}
        },
        register: () => () => {},
      },
    })
  } catch (error) {
    absentError = error
  }
  check('a shell without onEntryError still activates', absentError === undefined, String(absentError ?? ''))
  check('a shell without onEntryError still hands back a disposer', typeof absentDisposer, 'function')
  equal('a shell without onEntryError reports nothing extra', absent.beacons.length, 0)
}

// Restore the real globals so a failed check cannot leave the harness stubbed.
for (const name of ['setTimeout', ...defined]) {
  const real = realGlobals[name]
  if (real === undefined) delete globalThis[name]
  else Object.defineProperty(globalThis, name, real)
}

console.log('\n-- 7. Copy tables --')

/*
 * The copy table is a literal of strings only, so it can be read out of the source and compared
 * against the keys the component actually reads. This is a static consistency check, not a render:
 * a key that is read but missing, or present in one language only, would otherwise surface as the
 * literal text `undefined` on a user's screen.
 */
const copyStart = source.indexOf('const copy = ')
const copyEnd = source.indexOf('/** Follow the app')
let tables
try {
  const literal = source.slice(copyStart + 'const copy = '.length, copyEnd).trim().replace(/,\s*$/, '')
  tables = new Function(`return (${literal})`)()
} catch (error) {
  check('copy table is parseable', false, String(error))
}

const zhKeys = Object.keys(tables?.zh ?? {}).sort()
const enKeys = Object.keys(tables?.en ?? {}).sort()
check('copy tables were read out of the source', zhKeys.length > 0 && enKeys.length > 0, `${zhKeys.length}/${enKeys.length} keys`)
const sameKeys = JSON.stringify(zhKeys) === JSON.stringify(enKeys)
check(
  'zh and en declare the same keys',
  sameKeys,
  sameKeys
    ? `${zhKeys.length} keys each`
    : `only in zh: ${zhKeys.filter((key) => !enKeys.includes(key)).join(',')} | only in en: ${enKeys
        .filter((key) => !zhKeys.includes(key))
        .join(',')}`,
)

// `t.<key>` inside the component, plus `text().<key>` — the slot label reads its copy that way.
const usedKeys = [
  ...new Set([
    ...[...code.matchAll(/\bt\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]),
    ...[...code.matchAll(/text\(\)\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]),
  ]),
].sort()
const missingZh = usedKeys.filter((key) => !zhKeys.includes(key))
const missingEn = usedKeys.filter((key) => !enKeys.includes(key))
equal('every t.<key> read in the component exists in zh', missingZh, [])
equal('every t.<key> read in the component exists in en', missingEn, [])
const unused = zhKeys.filter((key) => !usedKeys.includes(key))
equal('no copy key is declared and never read', unused, [])
console.log(`      (${usedKeys.length} copy keys read by the component)`)

/*
 * The command card — the one place on the page that teaches the slash commands.
 *
 * The router's three `COMMANDS_*` lists are the only authority on which commands exist
 * (`verify.mjs` reads the same three lists to check the handbook), so the page and the router are a
 * pair and this is a two-directional check on the client side: a command the router accepts but the
 * card omits is one a user cannot discover from the page. `/model` sat exactly in that gap — it was
 * in `HELP_TEXT`, in both READMEs and in the handbook, and not on the card.
 */
const cardRows = [...code.matchAll(/className: 'dsh-qq-command' \}, h\('dt', null, '([^']+)'\)/g)]
const cardCommands = new Set(cardRows.map((match) => match[1].split(/[\s:]/)[0]))
check(
  'the command card was read out of the source',
  cardCommands.size >= 5,
  `${String(cardCommands.size)} rows: ${[...cardCommands].join(' ')}`,
)

const routerSource = readFileSync(join(here, '..', 'lib', 'router.js'), 'utf8')
const routerCommands = new Set()
for (const block of routerSource.matchAll(
  /const COMMANDS_(?:BARE|WITH_ARG|OPTIONAL_ARG) = \[([^\]]*)\]/g,
)) {
  for (const quoted of block[1].matchAll(/'(\/[a-z]+)'/g)) routerCommands.add(quoted[1])
}
check(
  'the router command lists were read out of the source',
  routerCommands.size >= 5,
  `${String(routerCommands.size)} commands: ${[...routerCommands].join(' ')}`,
)

equal(
  '★ the command card lists every command the router accepts',
  [...cardCommands].sort(),
  [...routerCommands].sort(),
)

// A row whose description is missing in one language renders as the literal text `undefined`, which
// is the same failure the copy-table block above exists for — one level down, at the row.
check(
  '★ the /model row is on the card and says what it does in both languages',
  cardRows.filter((match) => match[1].startsWith('/model')).length === 1 &&
    typeof tables?.zh?.commandModel === 'string' &&
    typeof tables?.en?.commandModel === 'string' &&
    tables.zh.commandModel.includes('切换') &&
    tables.en.commandModel.includes('switch'),
  `${String(tables?.zh?.commandModel)} | ${String(tables?.en?.commandModel)}`,
)

console.log('\n-- 8. Form state flow: unsaved note, refused field, cancel vs picker failure --')

/*
 * The component is run here with a stand-in React and a stand-in `fetch`.
 *
 * This is not a render and not a DOM: nothing is laid out, no CSS is applied and no browser is
 * involved (see the header). What it does exercise is the part a static check cannot reach — the
 * state transitions the user's complaint was about. The element tree the component returns is walked
 * as plain objects, and the assertions are about which copy appears in which state, and about what
 * the page compared before it claimed success.
 */

/** A React stand-in: state cells keyed by hook order, effects collected, elements as plain objects. */
function createHookRuntime() {
  const cells = []
  const effects = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial) => {
      const index = cursor++
      if (cells.length <= index) cells[index] = typeof initial === 'function' ? initial() : initial
      return [
        cells[index],
        (next) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next
        },
      ]
    },
    useEffect: (effect) => {
      effects.push(effect)
    },
    useCallback: (callback) => callback,
  }
  return {
    React,
    /**
     * Render the component once.
     *
     * The effects are dropped on every render and run only when asked, which is what a mount does:
     *    the component's own effects are mount-time work, and the harness has no scheduler.
     */
    render(component, props, runEffects = false) {
      cursor = 0
      const tree = component(props)
      const pending = effects.splice(0)
      if (runEffects) for (const effect of pending) effect()
      return tree
    },
  }
}

/** Visit every element and text node of the returned tree, parents before children. */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ type: '#text', text: String(node) })
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walkTree(node.props?.children, visit)
}

/** Every string the tree renders, in order. */
function textsOf(tree) {
  const texts = []
  walkTree(tree, (node) => {
    if (node.text !== undefined) texts.push(node.text)
  })
  return texts
}

/** The first element matching `predicate`. */
function findInTree(tree, predicate) {
  let found
  walkTree(tree, (node) => {
    if (found === undefined && predicate(node)) found = node
  })
  return found
}

// The section restores `window`/`document`/`navigator` on its way out (see section 6), and the
// component needs all three.
defineGlobal('window', {
  __ModuleLoader__: { load: (spec) => { registered = spec } },
  addEventListener: () => {},
  removeEventListener: () => {},
})
defineGlobal('document', {
  documentElement: { lang: 'zh-CN' },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove: () => {} }),
  head: { append: () => {} },
})
defineGlobal('navigator', { language: 'zh-CN', sendBeacon: () => true })

/** The real timer, for waiting; the component's own timers are captured and never fire. */
const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
defineGlobal('setInterval', () => 0)
defineGlobal('clearInterval', () => {})
defineGlobal('setTimeout', (callback, delay) => ({ callback, delay }))

/** Poll for a state the async work reaches, rather than sleeping a fixed time. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => realSetTimeout(resolve, 2))
  }
}

/** The settings the stand-in host holds; `mergeWindowMs` is the field the tests change. */
const hostSettings = {
  permissionPreset: 'danger-full-access',
  requireConfirmation: true,
  allowCrossSessionNotify: true,
  settleMs: 1200,
  presenceNote: 'note',
  mergeWindowMs: 10_000,
  autoReplyAttachments: true,
  maxReplyChars: 4000,
  workspacePath: '',
  // Group card. Without these the follow-up field is rendered from an undefined draft value and
  // "editing it saves" cannot be tested at all.
  groupChatEnabled: true,
  groupCollectStickers: true,
  groupAutoSpeak: true,
  groupFollowUpWindowMs: 300_000,
  groupPersonaNames: '鲸鱼娘',
  groupAutoSpeakKeywords: '鲸鱼娘,在吗',
  groupSpeakCooldownMs: 20_000,
  groupStickerDir: '',
  groupStickerChance: 70,
}

/** What `POST /settings` answers with. `'echo'` stores what was sent — the honest host. */
let postAnswer = { ...hostSettings }
/** The last request body the page posted, so the assertions can name what it actually sent. */
let postedPatch
/**
 * What `GET /permission-presets` answers with, and the last body posted to `/permission-preset`.
 *
 * A variable rather than a constant because the catalogue is the deployment's, not the page's: the
 * assertions in section 8e drive three different hosts through it — the ordinary one (both labelled
 * presets), one with no preset service at all (`available: []`, which is what a composition without
 * `@deepseek-ai/dsh-permission-presets` reports), and one with a house preset name this page has no
 * sentence for.
 *
 * `postedPreset` exists for the assertion that the page sends the **value** of the option the user
 * picked and not its label: with a `<select>` those two are different strings, and a page that
 * posted the label would look right on screen and fail at the host.
 */
let presetAnswer = { applied: 'default', sentinel: 'default', available: [], note: '' }
let postedPreset
const fetched = []
const cannedFetch = async (path, options) => {
  const url = String(path)
  fetched.push(url)
  let body = {}
  if (url.endsWith('/status')) {
    body = { connected: false, errors: [], workspace: 'C:\\ws', replyLimiter: { limit: 4, ttlHours: 1 } }
  } else if (url.endsWith('/login')) {
    body = { phase: 'idle' }
  } else if (url.endsWith('/settings')) {
    if (options?.method === 'POST') {
      postedPatch = JSON.parse(options.body)
      const stored = postAnswer === 'echo' ? { ...hostSettings, ...postedPatch } : postAnswer
      body = { settings: stored, defaults: hostSettings }
    } else {
      body = { settings: { ...hostSettings }, defaults: hostSettings }
    }
  } else if (url.endsWith('/permission-presets')) {
    body = { ...presetAnswer }
  } else if (url.endsWith('/permission-preset')) {
    // The host the real route imitates: it echoes back the state the switch produced (`lib/routes.js`).
    postedPreset = JSON.parse(options.body)
    body = { ok: true, ...presetAnswer, applied: postedPreset.preset }
  } else if (url.endsWith('/log')) {
    body = { path: 'boot.log', tail: '' }
  } else if (url.endsWith('/accounts')) {
    body = { accounts: [] }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}
defineGlobal('fetch', cannedFetch)

/**
 * Mount the settings section of a fresh client instance and drive it to the loaded state.
 *
 * @param {object} [options] - `pick` stands in for the folder chooser the slot would inject.
 * @returns {{ texts: () => string[], find: Function, draw: Function }} The mounted form.
 */
async function mountForm({ pick } = {}) {
  const hook = createHookRuntime()
  const instance = loadFreshClient(hook.React)
  const components = []
  instance.exports.apply({
    effect: (factory) => factory(),
    slots: {
      inject: (slot, factory) => {
        factory()
        return () => {}
      },
      register: (options, component) => {
        components.push(component)
        return () => {}
      },
    },
  })
  const component = components[0]
  const props = pick === undefined ? {} : { pick }
  /**
   * Re-render from the current state.
   *
   * Every read goes through here: the tree is a snapshot, so `texts()`/`find()` have to draw again
   * after the async work has moved the state on.
   */
  const draw = () => {
    const tree = hook.render(component, props)
    return tree
  }
  hook.render(component, props, true)
  return {
    draw,
    texts: () => textsOf(draw()),
    find: (predicate) => findInTree(draw(), predicate),
  }
}

const isButtonLabelled = (label) => (node) => node.type === 'button' && node.props?.children === label

// ---- 8a. The unsaved-changes note (A1) ----
{
  const form = await mountForm()
  const loaded = await waitFor(() => form.texts().includes('行为设置'))
  check('前置：设置页跑到了已加载状态（否则这一节什么都没测）', loaded, true)
  equal(
    'A1 反向对照：没有改动时不出现「有改动还没保存。」',
    form.texts().includes('有改动还没保存。'),
    false,
  )

  /*
   * A5: the page already answers the two different questions apart — what is *in effect* and what
   * is *stored* — and this pins it so it cannot quietly collapse back into one value.
   *
   * The stand-in host reports the workspace in effect as `C:\ws` while the stored value is the empty
   * string, so the two are distinguishable in one render.
   */
  const workspaceBox = form.find((node) => node.type === 'input' && node.props?.type === 'text')
  check('A5 前置：找到「会话文件夹路径」输入框', workspaceBox !== undefined)
  equal('A5 输入框里是设置里存的值（空串 = 用默认位置）', workspaceBox?.props?.value, '')
  equal('A5 同屏另有「当前生效」那一项', form.texts().includes('当前生效：'), true)
  equal('A5 生效值来自 /status，与输入框里的值与来源都不同', form.texts().includes('C:\\ws'), true)

  const numberInput = form.find((node) => node.type === 'input' && node.props?.type === 'number')
  check('前置：找到数值输入框', numberInput !== undefined)
  if (numberInput !== undefined) {
    numberInput.props.onChange({ target: { value: '4321' } })
    form.draw()
    equal('A1 有未保存改动时提示出现', form.texts().includes('有改动还没保存。'), true)
    equal('A1 有未保存改动时不说「已保存」', form.texts().includes('已保存'), false)
  }

  // The host refuses `mergeWindowMs` (the reply is the value it holds, not the value sent), so the
  // reply differs from the patch in exactly one field.
  postAnswer = { ...hostSettings }
  const save = form.find(isButtonLabelled('保存设置'))
  check('前置：找到保存按钮', save !== undefined)
  save?.props.onClick()
  const saved = await waitFor(() => form.texts().includes('已保存'))
  check('前置：保存返回了（否则下面几条只是没跑到）', saved, true)
  equal('A3 前置：页面发出的确实是改过的那个值', postedPatch?.mergeWindowMs, 4321)

  const afterSave = form.texts()
  const ignoredLine = afterSave.find((text) => text.includes('这些值没有被主机接受'))
  check(
    '★ A3 主机丢弃的字段被点名',
    ignoredLine !== undefined && ignoredLine.includes('附件合并窗口（毫秒）'),
    String(ignoredLine),
  )
  equal('★ A3 点名时不会只说"保存成功"了事（同一次状态里两者并存）', afterSave.includes('已保存'), true)
  equal('A1 保存后「有改动还没保存。」消失', afterSave.includes('有改动还没保存。'), false)
}

// ---- 8b. Reverse control for A3: a host that keeps every value names nothing ----
{
  const form = await mountForm()
  await waitFor(() => form.texts().includes('行为设置'))
  const numberInput = form.find((node) => node.type === 'input' && node.props?.type === 'number')
  numberInput?.props.onChange({ target: { value: '4321' } })
  form.draw()
  postAnswer = 'echo'
  form.find(isButtonLabelled('保存设置'))?.props.onClick()
  const saved = await waitFor(() => form.texts().includes('已保存'))
  equal(
    'A3 反向对照：主机照收时不该点名任何字段',
    form.texts().some((text) => text.includes('这些值没有被主机接受')),
    false,
  )
  equal('A3 反向对照：这一次保存确实发生过', saved, true)
  equal('A3 反向对照：发出的是改过的值', postedPatch?.mergeWindowMs, 4321)
}

// ---- 8c. Save failure keeps its own place and never says 已保存 (A2) ----
{
  const form = await mountForm()
  await waitFor(() => form.texts().includes('行为设置'))
  defineGlobal('fetch', async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:19387')
  })
  form.find(isButtonLabelled('保存设置'))?.props.onClick()
  const failed = await waitFor(() => form.texts().some((text) => text.includes('保存失败')))
  check('A2 保存失败时页面报出主机的原话', failed, true)
  const failureLine = form.texts().find((text) => text.includes('保存失败'))
  check(
    'A2 失败文案带上了主机原话',
    String(failureLine ?? '').includes('ECONNREFUSED'),
    String(failureLine ?? ''),
  )
  equal('A2 保存失败时不再出现「已保存」', form.texts().includes('已保存'), false)
  defineGlobal('fetch', cannedFetch)
}

// ---- 8c2. The group card has its own Save, and the follow-up value is posted ----
{
  const form = await mountForm()
  const loaded = await waitFor(() => form.texts().includes('群聊'))
  check('前置：群聊卡片渲染出来了', loaded, true)

  const saveButtons = []
  walkTree(form.draw(), (node) => {
    if (isButtonLabelled('保存设置')(node)) saveButtons.push(node)
  })
  equal('★ 群聊卡片也有「保存设置」（不再只有上面的行为卡片有）', saveButtons.length, 2)

  const followUp = form.find(
    (node) => node.type === 'input' && node.props?.type === 'number' && node.props?.value === 300_000,
  )
  check('前置：找到「被 @ 后连续对话窗口」输入框', followUp !== undefined)
  followUp?.props.onChange({ target: { value: '600000' } })
  form.draw()

  // Use the **second** Save: that is the one inside the group card the user was looking at.
  const buttonsAfter = []
  walkTree(form.draw(), (node) => {
    if (isButtonLabelled('保存设置')(node)) buttonsAfter.push(node)
  })
  postAnswer = 'echo'
  buttonsAfter[1]?.props.onClick()
  const saved = await waitFor(() => form.texts().includes('已保存'))
  equal('★ 点群聊卡片里的保存，连续对话窗口的新值被发出', postedPatch?.groupFollowUpWindowMs, 600_000)
  equal('★ 并且页面报告保存成功', saved, true)
}

// ---- 8d. The folder chooser: a cancelled dialog is not a failure, a broken one is (A2) ----
{
  const cancelled = await mountForm({ pick: async () => null })
  await waitFor(() => cancelled.texts().includes('行为设置'))
  const realError = console.error
  const errorCalls = []
  console.error = (...args) => {
    errorCalls.push(args.map((value) => String(value)).join(' '))
  }
  try {
    cancelled.find(isButtonLabelled('选择…'))?.props.onClick()
    await waitFor(() => cancelled.texts().some((text) => text.includes('选择文件夹失败')), 300)
    equal(
      'A2 用户取消：不报错（取消是正常路径，弹报错同样是误导）',
      cancelled.texts().some((text) => text.includes('选择文件夹失败')),
      false,
    )
    equal('A2 用户取消：连控制台也不该有', errorCalls.length, 0)

    const broken = await mountForm({
      pick: async () => {
        throw new Error('no directory picker is available in this client')
      },
    })
    await waitFor(() => broken.texts().includes('行为设置'))
    broken.find(isButtonLabelled('选择…'))?.props.onClick()
    const reported = await waitFor(() => broken.texts().some((text) => text.includes('选择文件夹失败')))
    check('A2 选择器失败：页面报出来', reported, true)
    const pickLine = broken.texts().find((text) => text.includes('选择文件夹失败'))
    check(
      'A2 选择器失败：附上主机的原话，而不是一句无信息量的"失败"',
      String(pickLine ?? '').includes('no directory picker is available in this client'),
      String(pickLine ?? ''),
    )
    check('A2 选择器失败：也进了控制台（用户不看控制台，开发者看）', errorCalls.some((line) => line.includes('选择文件夹失败')), true)
  } finally {
    console.error = realError
  }
}

// ---- 8e. The permission dropdown: Chinese sentences, and never a value the host would refuse ----
//
// The page used to render the host's own catalogue verbatim, so its options read as
// `danger-full-access` / `auto` / … . The three names below now lead with a sentence written for
// them — the same three sentences the WeChat settings page uses, word for word — while the
// catalogue still decides **which** of them can be offered: `POST /permission-preset` answers 400
// for any value that is not in `available` (except the sentinel), so an option the deployment does
// not list is an option that can only fail.
//
// Every claim here has its reverse control: the ordinary deployment gets all three in order, a
// deployment with a house preset keeps it, and a deployment with no preset service gets no option
// that would 400.
{
  /** Every `<option>` in the tree, in render order. */
  const optionsOf = (form) => {
    const options = []
    walkTree(form.draw(), (node) => {
      if (node.type === 'option') options.push(node)
    })
    return options
  }
  /** The preset `<select>` itself. */
  const selectOf = (form) => form.find((node) => node.type === 'select')
  /** Mount and wait for the loaded page. */
  const loadedForm = async () => {
    const form = await mountForm()
    await waitFor(() => form.texts().includes('行为设置'))
    return form
  }

  // The ordinary deployment: the two presets this page has sentences for.
  presetAnswer = {
    applied: 'default',
    sentinel: 'default',
    available: ['danger-full-access', 'auto'],
    note: '',
  }
  const form = await loadedForm()
  const options = optionsOf(form)
  equal(
    '★ 三个预设选项的 value 与顺序（与微信设置页同一个）',
    options.map((option) => option.props.value),
    ['danger-full-access', 'auto', 'default'],
  )
  equal(
    '★ 三条中文文案逐字一致',
    options.map((option) => option.props.children),
    ['完全访问：不询问，直接执行', '自动审核：电脑上判断', '跟随 DSH 设置：和桌面端一样'],
  )
  check(
    '★ 每个可选项都在 available 或 sentinel 里（否则选中就是一个 400）',
    options.every(
      (option) =>
        presetAnswer.available.includes(option.props.value) || option.props.value === 'default',
    ),
    options.map((option) => option.props.value).join(','),
  )

  /*
   * The assertion the whole Chinese-label change could silently break: the label is what the user
   * reads, and the `value` is what the page posts. A `<select>` carries both, so a page that sent
   * the label would look perfect and be wrong.
   */
  selectOf(form)?.props.onChange({ target: { value: 'auto' } })
  const posted = await waitFor(() => postedPreset !== undefined)
  check('前置：切换预设的请求发出去了', posted, true)
  equal('★ 选中「自动审核：电脑上判断」时，发给主机的是它的 value', postedPreset?.preset, 'auto')

  // Reverse control: a composition with no preset service at all — `available` is empty.
  presetAnswer = {
    applied: 'default',
    sentinel: 'default',
    available: [],
    note: '此组合没有权限预设服务',
  }
  const bare = await loadedForm()
  equal(
    '★ available 为空时不给任何会被 400 的选项（只剩哨兵）',
    optionsOf(bare).map((option) => option.props.value),
    ['default'],
  )
  equal('★ 那种情况下下拉是禁用的', selectOf(bare)?.props.disabled, true)
  equal(
    '★ 并保住主机报的那句说明（它是"这台机器没有可选项"的唯一来源）',
    bare.texts().includes('此组合没有权限预设服务'),
    true,
  )
  /*
   * Reverse control for that: the host's notes all belong to the empty case, so if the page did not
   * fall back there, a host that reports no note would leave the user looking at a disabled box
   * with nothing said about it.
   */
  presetAnswer = { applied: 'default', sentinel: 'default', available: [], note: '' }
  const bareNoNote = await loadedForm()
  equal(
    '★ 主机没给说明时，页面自己那句还在（否则只剩一个灰框）',
    bareNoNote.texts().includes('此组合没有可选的权限预设。'),
    true,
  )

  // Reverse control: a deployment with a house preset keeps it, under its own name.
  presetAnswer = { applied: 'house-strict', sentinel: 'default', available: ['house-strict'], note: '' }
  const house = await loadedForm()
  equal(
    '★ 部署方自定义的预设不会被删掉（原名出现，排在哨兵之后）',
    optionsOf(house).map((option) => option.props.value),
    ['default', 'house-strict'],
  )
  equal('★ 且页面仍然选中当前生效的那个', selectOf(house)?.props.value, 'house-strict')

  // And when both are on offer, the three the page can label keep the leading positions.
  presetAnswer = {
    applied: 'danger-full-access',
    sentinel: 'default',
    available: ['danger-full-access', 'auto', 'house-strict'],
    note: '',
  }
  const mixed = await loadedForm()
  equal(
    '★ 认得的三个在前，认不得的排在其后',
    optionsOf(mixed).map((option) => option.props.value),
    ['danger-full-access', 'auto', 'default', 'house-strict'],
  )
  equal('★ 认不得的那个仍然显示原名', optionsOf(mixed)[3]?.props.children, 'house-strict')
}

// Restore everything this section stubbed, so a failure cannot leave the harness stubbed.
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
for (const name of ['setTimeout', 'fetch', ...defined]) {
  const real = realGlobals[name]
  if (real === undefined) delete globalThis[name]
  else Object.defineProperty(globalThis, name, real)
}

console.log(`\n=== ${checks - failures.length}/${checks} checks passed ===`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('visual verification: NOT PERFORMED (no renderer, no browser, no live host)')
  console.log('state-flow verification: PERFORMED against a stub React and a stub fetch (no DOM, no CSS)')
}
