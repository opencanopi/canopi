// policy/gate/plan.ts: what a change runs, from the table (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q205, 2.1-Q267). Planning
// reads git and the tree and runs no check, so a plan (and `--print`, and `areas`) is the same on every rerun.
//
// The affected lane runs each selected area's checks plus the always-run families on any change but docs or beads: the
// source-text scanners and policy tests (found by content), the tests AGENTS.md cites, the locale tests, the tests beside
// changed modules, `vitest related` over the changed files and the modules that reach them in the dependency graph, the
// policy-gate Vitest project's files for a change to the gate, a module it imports, its hooks or its workflow (lane tests
// CI runs too), the policy tooling's tests, and the commit-lane families a changed path's scope reaches (`--family`);
// the whole commit-lane check, and every lane's planted cases through the policy-tooling area (design check AR8), run
// where a policy-tooling path (policy/, a tool or its config) or a toolchain file changed, and before push. The commit
// lane (`--staged`) runs only each matched area's commit checks, with npm offline (2.1-M201, 2.1-M230), and no planted
// violations (design check A12); a path no area covers there is named in a note, its checks running at the main agent's
// affected or push gate, since build and fix agents stop at the commit hook (2.1-Q272); a change touching only .beads/
// runs only the closed-bead check, and any .beads/ change runs it unless the whole policy check does (canopi-f47t.52.228).
// The pre-push lane (`push`): the affected lane with full rows and the Commit gate's checks, CI's Linux mirror (ci-parity).
//
// git runs without the caller's GIT_* variables but an absolute GIT_INDEX_FILE (a hook's `git commit -a` or
// `git commit <path>` hands over the index it commits) and takes no optional lock; outside a hook, a held index.lock
// (a concurrent commit) is refused by name rather than read half-written.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, posix, resolve } from 'node:path'
import { commitLaneFamilies, reachedFamilies } from './families.ts'
import { GateError } from './gate-error.ts'
import { CHEAP_FAMILIES, display, POLICY_COMMIT, TABLE, WEB, type Area, type Check, type Table } from './table.ts'

export { GateError }

/** A check in a plan: a table check, or one the lane builds (vitest file lists, a Python test module). */
export interface PlannedCheck extends Check {
  readonly id: string
}

export interface E2ePlan {
  readonly image: string
  readonly specs: readonly string[]
  readonly projects: readonly string[]
  /** The id of the check that builds what e2e serves (`vite preview --mode web` serves dist-web): every plan holding
   * the e2e run holds it first, `--only e2e` included, so e2e never runs a stale or missing build. */
  readonly needs: string
  readonly argv: readonly string[]
  readonly command: string
}

export interface Plan {
  readonly areas: readonly Area[]
  readonly checks: readonly PlannedCheck[]
  readonly e2e: E2ePlan | undefined
  readonly notes: readonly string[]
}

const PER_STREAM_TARGET = 'CARGO_TARGET_DIR=<main checkout>/.rq-scratch/targets/<stream>/target'
const SCAN_TEST = 'src/__tests__/toolchain-typecheck.test.ts'
const TEST_MODULE = /\.test\.tsx?$/
/** Python's \w, which the families' word edges read Unicode-wide. */
const WORD = String.raw`\p{L}\p{N}_`

export const matches = (patterns: readonly string[], path: string) => patterns.some((p) => new RegExp(p).test(path))
const rule = (table: Table, name: keyof Table['paths']) => new RegExp(table.paths[name])
/** `text` as a regex matching itself, valid with or without the `u` flag (which refuses an escaped `-`). */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The table's check `id`, as planned. */
export function check(id: string, table: Table = TABLE): PlannedCheck {
  const found = table.checks[id]
  if (!found) throw new GateError(`no check ${id} in the table`)
  return { id, ...found }
}

const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')))
  const index = env['GIT_INDEX_FILE']
  if (index) clean['GIT_INDEX_FILE'] = isAbsolute(index) ? index : resolve(index)
  clean['GIT_OPTIONAL_LOCKS'] = '0'
  return clean
}

/** git on the checkout at `root`; a failure refuses. */
export function git(root: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv(env), maxBuffer: 256 * 1024 * 1024 })
  if (run.error) throw new GateError(`git ${args.join(' ')} failed: ${run.error.message}`)
  if (run.status !== 0) throw new GateError(`git ${args.join(' ')} failed: ${run.stderr.trim()}`)
  return run.stdout
}

const nulList = (text: string) => text.split('\0').filter((path) => path !== '')

/** The changed paths: the staged change, or everything since merge-base(base, HEAD) with untracked files. */
export function changed(root: string, base: string | undefined, staged: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  if (staged) {
    if (!env['GIT_INDEX_FILE']) {
      const lock = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], env).trim()
      if (existsSync(lock)) {
        throw new GateError(`the index is locked (${lock} exists): another git command, a concurrent commit or `
          + 'checkout, is writing it; run the gate again when it ends')
      }
    }
    return nulList(git(root, ['diff', '--cached', '--name-only', '-z'], env))
  }
  const mergeBase = git(root, ['merge-base', base ?? 'HEAD', 'HEAD'], env).trim()
  return [...new Set([...nulList(git(root, ['diff', '--name-only', '-z', mergeBase], env)),
    ...nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z'], env))])].sort()
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const WEB_VITEST = new RegExp(TABLE.paths.webVitestTest, 'u')
/** Every file the web Vitest project runs (TABLE.paths.webVitestTest: src/, scripts/, vite.config.test.ts, never e2e/),
 * desktop/web-relative and sorted; no install or dot folder is walked. */
function webTests(root: string): string[] {
  const keep = (name: string) => WEB_VITEST.test(`${WEB}/${name}`)
  return (existsSync(join(root, WEB)) ? readdirSync(join(root, WEB), { withFileTypes: true }) : []).flatMap((entry) => (entry.isDirectory()
    ? (entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : webFiles(root, entry.name, keep))
    : entry.isFile() && keep(entry.name) ? [entry.name] : [])).sort()
}

/** The vitest files an affected run adds (`every`: the always-run families too), desktop/web-relative. A test naming a
 * changed file outside desktop/web reads it, maybe through a variable or helper no family pattern sees: any file the web
 * Vitest project runs (webTests), a nested or co-located one too (test-determinism-config.test.ts reads seed-lane.yml from src/__tests__/support). */
export function families(root: string, paths: readonly string[], every = true, table: Table = TABLE): string[] {
  const tests = join(root, WEB, 'src/__tests__')
  const found = new Set<string>()
  const agents = join(root, 'AGENTS.md')
  const cited = new Set(isFile(agents)
    ? [...readFileSync(agents, 'utf8').matchAll(new RegExp(table.families.cited, 'g'))].map((match) => match[1])
    : [])
  const names = paths.filter((path) => !path.startsWith(`${WEB}/`)).map((path) => escape(basename(path)))
  const named = names.length ? new RegExp(`(?<![${WORD}.-])(?:${names.join('|')})(?![${WORD}-])`, 'u') : undefined
  const scanner = new RegExp(table.families.scanner)
  const locale = new RegExp(table.families.locale)
  const listed = existsSync(tests) && statSync(tests).isDirectory() ? readdirSync(tests).sort() : []
  for (const name of listed.filter((entry) => entry.includes('.test.ts') && isFile(join(tests, entry)))) {
    const text = readFileSync(join(tests, name), 'utf8')
    if (every && (scanner.test(text) || locale.test(text) || cited.has(name))) found.add(`src/__tests__/${name}`)
  }
  if (named) for (const test of webTests(root)) if (named.test(readFileSync(join(root, WEB, test), 'utf8'))) found.add(test)
  const webModule = rule(table, 'webModule')
  for (const path of paths) { // the tests beside changed modules, and changed tests themselves
    const module = webModule.exec(path)?.[1]
    if (module === undefined) continue
    const stem = module.replace(/(\.test)?\.(tsx?|css)$/, '')
    for (const suffix of ['.test.ts', '.test.tsx']) if (isFile(join(root, WEB, `${stem}${suffix}`))) found.add(`${stem}${suffix}`)
  }
  return [...found].sort()
}

/** Every path is docs or beads: no code changed. */
export const docsOnly = (paths: readonly string[], table: Table = TABLE) =>
  paths.every((path) => rule(table, 'docsOnly').test(path) && !rule(table, 'notDocs').test(path))

/** The vitest files the affected lane runs beside the areas' checks: the toolchain scanner when a file it reads changed
 * and each test naming a changed file (a docs-only change included), and the always-run families on any change but docs
 * or beads, and the policy-gate project's files for a change to the gate's own files (the table's policyGate rule).
 * CI's changes job runs the same list (`areas`' tests) whenever its frontend job, whose coverage run holds
 * them all, does not run. */
export function laneTests(root: string, paths: readonly string[], table: Table = TABLE): string[] {
  if (paths.every((path) => path.startsWith('.beads/'))) return []
  const frontend = table.areas.find((area) => area.name === 'frontend')
  const scanned = frontend !== undefined && paths.some((path) => matches([...frontend.patterns, ...frontend.scans ?? []], path))
    && isFile(join(root, WEB, SCAN_TEST))
  const tests = new Set(scanned ? [SCAN_TEST] : [])
  for (const test of families(root, paths, !docsOnly(paths, table), table)) tests.add(test)
  if (paths.some((path) => rule(table, 'policyGate').test(path))) for (const test of gateTests(root)) tests.add(test)
  return [...tests].sort()
}

/** The policy-gate Vitest project's files (each .test.ts under its include roots, vite.config.ts's), desktop/web-relative. */
function gateTests(root: string): string[] {
  return ['policy/gate', 'policy/adapters'].flatMap((dir) => {
    const at = join(root, dir)
    if (!existsSync(at)) return []
    return (readdirSync(at, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((name) => name.endsWith('.test.ts') && isFile(join(at, name)))
      .map((name) => `../../${dir}/${name.split(/[\\/]/u).join('/')}`)
  })
}

/** A changed script's test module and each one split from it (test_<stem>_<part>.py). */
export function pythonTests(root: string, paths: readonly string[]): string[] {
  const modules = new Set<string>()
  const scripts = join(root, 'scripts')
  const listed = existsSync(scripts) ? readdirSync(scripts) : []
  for (const path of paths) {
    const stem = /^scripts\/(?:test_)?([a-z0-9_]+)\.py$/.exec(path)?.[1]
    if (stem === undefined) continue
    for (const name of listed) {
      if (!name.endsWith('.py') || !name.startsWith(`test_${stem}`)) continue
      const module = name.slice(0, -3)
      if (module === `test_${stem}` || module.startsWith(`test_${stem}_`)) modules.add(`scripts.${module}`)
    }
  }
  return [...modules].sort()
}

/** The modules reaching `modules` (desktop/web-relative) in the dependency graph, through dependency-cruiser's
 * `--reaches` (`--affected` reads repository-root paths, never matching the cruise's sources, and not the index). */
export function reaching(root: string, modules: readonly string[]): string[] {
  if (!modules.length) return []
  const cruiser = join(root, WEB, 'node_modules/.bin/depcruise')
  if (!isFile(cruiser)) throw new GateError(`${WEB}/node_modules/.bin/depcruise is missing: run npm ci in ${WEB}`)
  const reach = `^(?:${modules.map(escape).join('|')})$`
  const run = spawnSync(cruiser, ['--config', '.dependency-cruiser.web.cjs', '--output-type', 'json', '--reaches', reach,
    'src', 'ui-gallery'], { cwd: join(root, WEB), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  try {
    const sources = (JSON.parse(run.stdout) as { modules: { source: string }[] }).modules.map((module) => module.source)
    return [...new Set(sources)].filter((source) => !modules.includes(source)).sort()
  } catch (error) {
    throw new GateError(`depcruise --reaches gave no module list (exit ${run.status}): `
      + `${run.stderr?.trim().slice(0, 300) || (error as Error).message}`)
  }
}

function playwrightImage(root: string): string {
  const lock = join(root, WEB, 'package-lock.json')
  let version: unknown
  try {
    version = (JSON.parse(readFileSync(lock, 'utf8')) as { packages: Record<string, { version?: string }> })
      .packages['node_modules/@playwright/test']?.version
  } catch {
    version = undefined
  }
  if (typeof version !== 'string') throw new GateError(`${WEB}/package-lock.json names no @playwright/test version: the e2e image is unknown`)
  return `mcr.microsoft.com/playwright:v${version}-noble`
}

const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`)

/** The pinned image's run (plan:165): browsers come only from the image, never the host. The container keeps its own
 * network, so no port is published and two worktrees' runs never share a server on the default ports. */
function e2eRun(root: string, specs: string[], projects: string[]): E2ePlan {
  const image = playwrightImage(root)
  const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`
  const argv = ['docker', 'run', '--rm', '--ipc=host', '-v', `${root}:/work`, '-w', `/work/${WEB}`, '--user', user,
    '-e', 'HOME=/tmp', image, 'npx', 'playwright', 'test', ...specs, ...projects.map((p) => `--project=${p}`),
    '--pass-with-no-tests', '--reporter=line']
  return { image, specs, projects, needs: 'build-web', argv, command: argv.map(quote).join(' ') }
}

/** A module that renders a dialog: role dialog or alertdialog, a <dialog> element, or aria-modal; a module importing one
 * is a dialog module too. */
const DIALOG = /role="(?:alert)?dialog"|<dialog\b|aria-modal/
const DATA_ATTRIBUTE = /\bdata-([a-z][a-z0-9-]*)=/g
const LOCALE_KEY = /\bt\(\s*'([A-Za-z0-9_.-]+)'/g
const DIALOG_NAME = /getByRole\(\s*'(?:alert)?dialog'\s*,\s*\{\s*name:\s*'([^'\\]+)'/g
const RELATIVE_IMPORT = /\bfrom\s+'(\.{1,2}\/[^']+)'/g
/** The spec directories a dialog's specs come from: the engines' canvas suite and the gallery (never the real app). */
const DIALOG_SPEC_DIRS = ['e2e/canvas', 'e2e/gallery']

/** The files under `dir` (desktop/web-relative) whose names pass `keep`, desktop/web-relative and sorted. */
function webFiles(root: string, dir: string, keep: (name: string) => boolean): string[] {
  const at = join(root, WEB, dir)
  if (!existsSync(at)) return []
  return readdirSync(at, { recursive: true, encoding: 'utf8' }).map((name) => `${dir}/${name.split(/[\\/]/u).join('/')}`)
    .filter((name) => keep(name) && isFile(join(root, WEB, name))).sort()
}

/** en.json's strings by dotted key. */
function english(root: string): Map<string, string> {
  const strings = new Map<string, string>()
  const walk = (value: unknown, prefix: string) => {
    if (typeof value === 'string') strings.set(prefix, value)
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key)
  }
  try {
    walk(JSON.parse(readFileSync(join(root, WEB, 'src/i18n/en.json'), 'utf8')), '')
  } catch {
    // No English locale: dialogs select by their data attributes only.
  }
  return strings
}

/**
 * The canvas and gallery specs that drive a dialog module among `modules` (desktop/web-relative: the changed modules and
 * those reaching them; a dialog module renders a dialog or imports a module that does), design check DR13: each spec reading a data-* attribute only that module writes, itself or
 * through an e2e/support helper it imports, or opening a dialog (role dialog or alertdialog) by the English text of a
 * locale key the module uses. An attribute other modules write too (data-preserve-overlays) names no one dialog.
 */
export function dialogSpecs(root: string, modules: readonly string[]): string[] {
  const read = (path: string) => readFileSync(join(root, WEB, path), 'utf8')
  const renders = (module: string) => isFile(join(root, WEB, module)) && DIALOG.test(read(module))
  /** A module rendering a dialog itself or through a component it imports (WorkspaceDialog renders most of them). */
  const dialog = (module: string) => renders(module) || [...read(module).matchAll(RELATIVE_IMPORT)].some((match) => {
    const target = posix.join(posix.dirname(module), match[1] ?? '')
    return ['', '.tsx', '.ts', '/index.tsx', '/index.ts'].some((suffix) => renders(`${target}${suffix}`))
  })
  const dialogs = modules.filter((module) => isFile(join(root, WEB, module)) && dialog(module))
  if (!dialogs.length) return []
  const writers = new Map<string, number>()
  for (const module of webFiles(root, 'src', (name) => /\.tsx?$/.test(name) && !TEST_MODULE.test(name))) {
    for (const name of new Set([...read(module).matchAll(DATA_ATTRIBUTE)].map((match) => match[1] ?? ''))) {
      writers.set(name, (writers.get(name) ?? 0) + 1)
    }
  }
  const strings = english(root)
  const attributes = new Set<string>()
  const names = new Set<string>()
  for (const dialog of dialogs) {
    const text = read(dialog)
    for (const match of text.matchAll(DATA_ATTRIBUTE)) if (writers.get(match[1] ?? '') === 1) attributes.add(match[1] ?? '')
    for (const match of text.matchAll(LOCALE_KEY)) {
      const name = strings.get(match[1] ?? '')
      if (name) names.add(name)
    }
  }
  const reads = (text: string) => [...attributes].some((name) => new RegExp(`data-${escape(name)}(?![a-z0-9-])`).test(text))
  const helpers = new Set(webFiles(root, 'e2e/support', (name) => /\.ts$/.test(name)).filter((helper) => reads(read(helper)))
    .map((helper) => helper.replace(/\.ts$/, '')))
  const specs = DIALOG_SPEC_DIRS.flatMap((dir) => webFiles(root, dir, (name) => name.endsWith('.spec.ts')))
  return specs.filter((spec) => {
    const text = read(spec)
    if (reads(text)) return true
    const dir = posix.dirname(spec)
    if ([...text.matchAll(RELATIVE_IMPORT)].some((match) => helpers.has(posix.join(dir, (match[1] ?? '').replace(/\.ts$/, ''))))) return true
    return [...text.matchAll(DIALOG_NAME)].some((match) => names.has(match[1] ?? ''))
  })
}

/** What the pre-push lane for `paths` must have run (verify-push.ts): e2e when e2eTargets on `exists`'s tree (the pushed
 * commit's) names a run, dialog-driven specs aside (a cruise), and Rust when an area's full row it runs holds a check. */
export function pushNeeds(root: string, paths: readonly string[], exists: (path: string) => boolean): { e2e: boolean, rust: boolean } {
  const table = withRatchetPaths(root, TABLE)
  const running = table.areas.filter((area) => !area.workflow && (area.every || paths.some((path) => matches(area.patterns, path))))
  const rust = !docsOnly(paths, table) && running.some((area) => area.full.some((id) => table.checks[id]?.cargo && !table.checks[id]?.ciOnly))
  return { e2e: !docsOnly(paths, table) && e2eTargets(paths, table, exists).length > 0, rust }
}

/** The e2e run's specs and folders, sorted: each changed spec `exists` holds (a deleted one needs no run) and `dialogs`,
 * folded into the whole canvas or gallery folder where a style or component those folders follow changed. */
function e2eTargets(paths: readonly string[], table: Table, exists: (path: string) => boolean, dialogs: readonly string[] = []) {
  const spec = rule(table, 'spec')
  let specs = new Set([...paths.filter((path) => spec.test(path) && exists(path)).map((path) => spec.exec(path)?.[1] ?? ''), ...dialogs])
  for (const [name, dir] of [['e2eCanvas', 'e2e/canvas'], ['e2eGallery', 'e2e/gallery']] as const) {
    if (paths.some((path) => rule(table, name).test(path))) specs = new Set([...[...specs].filter((s) => !s.startsWith(`${dir}/`)), dir])
  }
  return [...specs].sort()
}

function e2ePlan(root: string, paths: readonly string[], table: Table, dialogs: readonly string[] = []): E2ePlan | undefined {
  const sorted = e2eTargets(paths, table, (path) => isFile(join(root, path)), dialogs)
  if (!sorted.length) return undefined
  const gallery = sorted.some((s) => s.startsWith('e2e/gallery')) ? ['gallery-chromium', 'gallery-webkit'] : []
  return e2eRun(root, sorted, ['chromium', 'webkit', ...gallery])
}

const dedupe = (checks: readonly PlannedCheck[]) => {
  const seen = new Set<string>()
  return checks.filter((planned) => !seen.has(display(planned)) && seen.add(display(planned)))
}

const lane = (id: string, command: string, extra: Partial<Check> = {}): PlannedCheck => ({ id, command, cwd: WEB, ...extra })

const escaped = (path: string) => `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`

/**
 * `table` with each area naming a `ratchet` also selected by the files that ratchet lists (its entry keys), read from
 * `root` now: a missing or unreadable ratchet refuses, so a plan never silently drops the debt files (AR12).
 */
export function withRatchetPaths(root: string, table: Table = TABLE): Table {
  if (!table.areas.some((area) => area.ratchet)) return table
  return { ...table, areas: table.areas.map((area) => {
    if (!area.ratchet) return area
    let entries: unknown
    try {
      entries = (JSON.parse(readFileSync(join(root, area.ratchet), 'utf8')) as { entries?: unknown }).entries
    } catch {
      entries = undefined
    }
    if (!entries || typeof entries !== 'object') {
      throw new GateError(`the ${area.name} area reads ${area.ratchet}, which is missing or unreadable: the gate refuses rather `
        + 'than select too little')
    }
    return { ...area, patterns: [...area.patterns, ...Object.keys(entries).map(escaped)] }
  }) }
}

/** The cheap-families check naming `families`, or none for no family. */
function familyChecks(of: (id: string) => PlannedCheck, families: readonly string[]): PlannedCheck[] {
  if (!families.length) return []
  const planned = of('cheap-families')
  return [{ ...planned, command: `${planned.command} ${families.map((family) => `--family ${family}`).join(' ')}` }]
}

/** The cheap-families check for the `ids` (CHEAP_FAMILIES by default) whose scope a path reaches, with any note. */
function cheapFamilies(root: string, paths: readonly string[], of: (id: string) => PlannedCheck,
  ids: readonly string[] = CHEAP_FAMILIES): { checks: PlannedCheck[], note?: string } {
  const reached = reachedFamilies(root, paths, ids)
  return { checks: familyChecks(of, reached.ids), ...reached.note ? { note: reached.note } : {} }
}

/** The affected (`staged` false) or commit lane's plan for `paths`. */
export function planAffected(root: string, paths: readonly string[], staged: boolean, base?: string,
  env: NodeJS.ProcessEnv = process.env, given: Table = TABLE): Plan {
  return planLane(root, paths, staged ? 'commit' : 'affected', base, env, given)
}

/**
 * The pre-push lane's plan for `paths` (design check A13, AR22): CI's Linux mirror. The affected lane, but each selected
 * and every-change area runs its full row (ci_only checks and a workflow area's aside), whose coverage runs (the web
 * project's and the policy-gate project's) hold the Vitest files and whose script tests hold each changed script's; a bead-only change runs the every-change rows too.
 * Every change also runs CI's Commit gate, its closed-bead check and its range, `--vitest` included (commit-gate.yml; the
 * PR body is CI's), then the expected-fail marker check no CI job runs (prepush-checks.ts).
 */
export function planPush(root: string, paths: readonly string[], base?: string, env: NodeJS.ProcessEnv = process.env,
  given: Table = TABLE): Plan {
  const plan = planLane(root, paths, 'push', base, env, given)
  const ids = new Set(plan.checks.map((planned) => planned.id))
  const covered = (planned: PlannedCheck) => planned.ciOnly || (ids.has('coverage') && ids.has('gate-coverage') && planned.id.startsWith('vitest-'))
    || (ids.has('script-tests') && planned.id.startsWith('unittest-'))
  const range: PlannedCheck = { id: 'commit-gate-pr', command: `node policy/gate/cli.mjs commit-gate pr ${base ?? 'origin/main'} HEAD --vitest` }
  const local: PlannedCheck = { id: 'prepush-checks', command: `node policy/gate/cli.mjs prepush-checks --base ${base ?? 'origin/main'}` }
  return { ...plan, checks: dedupe([...plan.checks.filter((planned) => !covered(planned)), check('closed-beads', given), range, local]) }
}

function planLane(root: string, paths: readonly string[], mode: 'commit' | 'affected' | 'push', base: string | undefined,
  env: NodeJS.ProcessEnv, given: Table): Plan {
  const staged = mode === 'commit'
  const table = withRatchetPaths(root, given)
  const areas = table.areas.filter((area) => paths.some((path) => matches(area.patterns, path)))
  const of = (id: string) => check(id, table)
  /** Deduplicated, with the closed-bead check for a .beads/ change the whole policy check (which reads it) misses. */
  const done = (all: PlannedCheck[]) => dedupe([...all, ...paths.some((path) => path.startsWith('.beads/'))
    && !all.some((planned) => planned.id === 'policy-check') ? [of('closed-beads')] : []])
  const drift = (at: string): PlannedCheck => ({ ...of('docs-drift'), command: `python3 scripts/check_docs.py --drift ${at}` })
  /** A non-staged lane's checks for `area`: its full row before push, else its affected one (docs-tests where the docs
   * validator changed), the drift against `base`. */
  const rowOf = (area: Area) => {
    const ids = mode === 'push' ? area.full : [...area.affected ?? area.full,
      ...area.name === 'docs' && paths.some((path) => rule(table, 'docsValidator').test(path)) ? ['docs-tests'] : [],
      ...Object.entries(area.affectedWhen ?? {}).filter(([, inputs]) => paths.some((path) => matches(inputs, path))).map(([id]) => id)]
    return ids.map((id) => (id === 'docs-drift' ? drift(base ?? 'origin/main') : of(id)))
  }
  if (paths.every((path) => path.startsWith('.beads/'))) {
    const every = mode === 'push' ? table.areas.filter((area) => area.every && !area.workflow).flatMap(rowOf) : []
    return { areas, checks: paths.length ? dedupe([of('closed-beads'), ...every]) : [], e2e: undefined, notes: [] }
  }
  const notes: string[] = []
  const checks: PlannedCheck[] = []
  const toolchain = paths.some((path) => rule(table, 'toolchain').test(path))
  if (staged) {
    for (const area of areas) {
      if (area.name === 'docs') checks.push(of('docs'), drift(git(root, ['merge-base', 'HEAD', 'origin/main'], env).trim()))
      checks.push(...(area.commit ?? []).map(of))
    }
    if (toolchain) {
      checks.push(...POLICY_COMMIT.map(of))
      notes.push("a toolchain file changed: the whole Vitest suite runs at the main agent's affected or push gate (2.1-Q272)")
    }
    if (paths.some((path) => rule(table, 'policy').test(path))) checks.push(...POLICY_COMMIT.map(of))
    if (!checks.some((planned) => planned.id === 'policy-check')) {
      const cheap = cheapFamilies(root, paths, of)
      checks.push(...cheap.checks)
      if (cheap.note) notes.push(cheap.note)
    }
    // A path is covered only by an area that runs something here: docs runs its row, the rest their commit checks.
    const uncovered = paths.filter((path) => !path.startsWith('.beads/') && !table.areas.some((area) =>
      matches(area.patterns, path) && ((area.commit ?? []).length > 0 || area.name === 'docs'))).sort()
    if (uncovered.length) notes.push(`no commit check covers ${uncovered.join(', ')}; the main agent's affected or push gate runs their checks (2.1-Q272)`)
    return { areas, checks: done(checks), e2e: undefined, notes }
  }
  // The affected and pre-push lanes also run each `every` area, whichever paths changed. A check another runs (`runs`)
  // counts as selected, so an area it covers runs nothing of its own.
  const running = table.areas.filter((area) => (areas.includes(area) || area.every) && !area.workflow)
  const selected = new Set(running.flatMap(rowOf).flatMap((planned) => [planned, ...(planned.runs ?? []).map(of)]).map(display))
  for (const area of running) {
    for (const planned of rowOf(area)) {
      const covering = (area.coveredBy ?? []).map((covered) => display(of(covered)))
      if (covering.length && covering.every((text) => text !== display(planned) && selected.has(text))) continue
      checks.push(planned)
    }
    if (area.name === 'frontend' && paths.some((path) => path.startsWith(`${WEB}/ui-gallery/`))) checks.push(of('typecheck'))
  }
  const docs = docsOnly(paths, table)
  let e2e: E2ePlan | undefined
  let dialogs: string[] = []
  if (docs) {
    const tests = laneTests(root, paths, table)
    if (tests.length) checks.push(lane('vitest-lane', `npx vitest run --maxWorkers=4 ${tests.join(' ')}`))
    const cheap = cheapFamilies(root, paths, of)
    checks.push(...cheap.checks)
    if (cheap.note) notes.push(cheap.note)
  } else {
    checks.push(...pythonTests(root, paths).map((module) => ({ id: `unittest-${module}`, command: `python3 -m unittest ${module}` })))
    checks.push(of('pdf-fonts'))
    if (toolchain) {
      checks.push(lane('vitest-all', 'npx vitest run --maxWorkers=4'))
      notes.push('a toolchain file changed: the whole Vitest suite runs')
    } else {
      const webModule = rule(table, 'webModule')
      const modules = paths.flatMap((path) => {
        const module = webModule.exec(path)?.[1]
        return module !== undefined && isFile(join(root, path)) ? [module] : []
      })
      const sources = modules.filter((module) => !TEST_MODULE.test(module))
      const reached = reaching(root, sources.filter((module) => !module.endsWith('.css')))
      const related = [...new Set([...sources, ...reached.filter((module) => !TEST_MODULE.test(module))])].sort()
      dialogs = dialogSpecs(root, related)
      if (related.length) checks.push(lane('vitest-related', `npx vitest related --run --maxWorkers=4 ${related.join(' ')}`))
      const tests = [...new Set([...laneTests(root, paths, table), ...reached.filter((module) => TEST_MODULE.test(module))])].sort()
      if (tests.length) checks.push(lane('vitest-lane', `npx vitest run --maxWorkers=4 ${tests.join(' ')}`))
    }
    // A policy-tooling path (policy/, an adapter's tool or config) changes what every family on it finds, which no
    // family's scope names: the whole check runs.
    if (toolchain || areas.some((area) => area.name === 'policy-tooling')) {
      checks.push(...POLICY_COMMIT.map(of))
    } else {
      // 2.1-Q267: the families a changed path reaches; with no glob engine, all of them.
      const scoped = cheapFamilies(root, paths, of, commitLaneFamilies(root))
      if (scoped.note) notes.push(scoped.note)
      checks.push(...POLICY_COMMIT.filter((id) => id !== 'policy-check' || scoped.note).map(of), ...scoped.checks)
    }
    e2e = e2ePlan(root, paths, table, dialogs)
    if (e2e) checks.push(of(e2e.needs))
  }
  return { areas, checks: done(checks), e2e, notes }
}

/** The table checks `ids`, by id, outside any area's row (a CI step such as the Commit gate's closed-bead check); an
 * unknown or CI-only id refuses. */
export function planChecks(ids: readonly string[], table: Table = TABLE): Plan {
  for (const id of ids) {
    if (!(id in table.checks)) throw new GateError(`check names ${id}, which is no check in the table`)
    if (table.checks[id]?.ciOnly) throw new GateError(`check names ${id}, a CI-only lane no local run makes`)
  }
  return { areas: [], checks: dedupe(ids.map((id) => check(id, table))), e2e: undefined, notes: [] }
}

/** The full rows of the named areas, or of every area. */
export function planFull(names: readonly string[], table: Table = TABLE): Plan {
  const unknown = names.filter((name) => !table.areas.some((area) => area.name === name))
  if (unknown.length) {
    throw new GateError(`unknown area ${unknown.join(', ')}; areas: ${table.areas.map((area) => area.name).join(', ')}`)
  }
  const areas = names.length ? table.areas.filter((area) => names.includes(area.name)) : table.areas.filter((area) => !area.workflow)
  return { areas, checks: dedupe(areas.flatMap((area) => area.full.map((id) => check(id, table)))), e2e: undefined, notes: [] }
}

const linkedWorktree = (root: string, env: NodeJS.ProcessEnv) =>
  resolve(git(root, ['rev-parse', '--absolute-git-dir'], env).trim())
    !== resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env).trim())

/** `plan` cut to the checks `ids` name (`e2e` for its e2e run, with the check it needs), in the plan's order; an id the
 * plan lacks refuses. */
export function onlyChecks(plan: Plan, ids: readonly string[]): Plan {
  const held = new Set([...plan.checks.map((planned) => planned.id), ...plan.e2e ? ['e2e'] : []])
  const missing = ids.filter((id) => !held.has(id))
  if (missing.length) throw new GateError(`--only names ${missing.join(', ')}, which the plan does not hold`)
  const e2e = ids.includes('e2e') ? plan.e2e : undefined
  const kept = new Set([...ids, ...e2e ? [e2e.needs] : []])
  return { ...plan, checks: plan.checks.filter((planned) => kept.has(planned.id)), e2e }
}

/** A Rust gate builds in its own target: none set in a linked worktree, or the shared one, makes worktrees share a lock (2.1-M201). */
export function refuseSharedTarget(root: string, checks: readonly PlannedCheck[], env: NodeJS.ProcessEnv = process.env): void {
  if (!checks.some((planned) => planned.cargo)) return
  const target = env['CARGO_TARGET_DIR'] ?? ''
  if (target.split(/[\\/]/).includes('shared-build')) {
    throw new GateError(`CARGO_TARGET_DIR=${target} is the shared-build target every worktree would lock (2.1-M201): `
      + `set ${PER_STREAM_TARGET} before a Rust gate`)
  }
  if (!target && linkedWorktree(root, env)) {
    throw new GateError(`a linked worktree builds Rust with its own CARGO_TARGET_DIR (2.1-M201): set ${PER_STREAM_TARGET} before a Rust gate`)
  }
}

const areaJson = (area: Area) => ({ name: area.name, label: area.label, patterns: [...area.patterns], scans: [...area.scans ?? []] })

/** `--print`'s JSON: the checks by id, the CI-only lanes (a workflow area's checks among them, unless the plan runs
 * them), the selected areas, every area with its patterns and the e2e run. */
export function planJson(plan: Plan, table: Table = TABLE) {
  const ran = new Set(plan.checks.map((planned) => planned.id))
  return {
    checks: plan.checks.filter((planned) => !planned.ciOnly).map((planned) => ({ id: planned.id, command: display(planned) })),
    ci_only: plan.areas.flatMap((area) => area.full.map((id) => check(id, table))
      .filter((planned) => planned.ciOnly || (area.workflow && !ran.has(planned.id))))
      .map((planned) => ({ id: planned.id, command: display(planned) })),
    selected: plan.areas.map((area) => area.name),
    areas: table.areas.map(areaJson),
    e2e: plan.e2e ? { image: plan.e2e.image, specs: plan.e2e.specs, projects: plan.e2e.projects, needs: display(check(plan.e2e.needs, table)), command: plan.e2e.command } : null,
    notes: plan.notes,
  }
}

/** `areas`' JSON: whether the change holds code (anything but docs and beads), the areas it selects, the vitest files its
 * lane adds and every area's patterns. CI's changes job selects through this alone (design check AR2). */
export function areasJson(root: string, paths: readonly string[], given: Table = TABLE) {
  const table = withRatchetPaths(root, given)
  return {
    code: paths.length > 0 && !docsOnly(paths, table),
    selected: table.areas.filter((area) => paths.some((path) => matches(area.patterns, path))).map((area) => area.name),
    tests: laneTests(root, paths, table),
    areas: table.areas.map(areaJson),
  }
}
