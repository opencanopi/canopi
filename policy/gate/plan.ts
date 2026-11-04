// policy/gate/plan.ts: what a change runs, from the table (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q205, 2.1-Q267). Planning
// reads git and the tree and runs no check, so a plan (and `--print`, and `areas`) is the same on every rerun.
//
// The affected lane runs each selected area's checks plus the always-run families on any change but docs or beads: the
// source-text scanners and policy tests (found by content), the tests AGENTS.md cites, the locale tests, the tests beside
// changed modules, `vitest related` over the changed files and the modules that reach them in the dependency graph, the
// policy-gate Vitest project's files for a change to the gate, a module it imports, its hooks or its workflow (lane tests
// CI runs too), the policy checker's commit lane and the policy tooling's tests, and for a workflow change the pinned
// actionlint. The planted cases (`--self-test`) run only through the policy-tooling area (design check AR8). The commit lane (`--staged`) runs only each matched area's commit checks, with npm offline
// (2.1-M201, 2.1-M230); a path no area covers there is named in a note, its checks running at the affected gate; a change
// touching only .beads/ runs only the closed-bead check in both lanes (canopi-f47t.52.228).
//
// git runs without the caller's GIT_* variables but an absolute GIT_INDEX_FILE (a hook's `git commit -a` or
// `git commit <path>` hands over the index it commits) and takes no optional lock; outside a hook, a held index.lock
// (a concurrent commit) is refused by name rather than read half-written.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, posix, resolve } from 'node:path'
import { CHEAP_FAMILIES, display, POLICY_COMMIT, TABLE, WEB, type Area, type Check, type Table } from './table.ts'

/** The gate cannot judge the change: it refuses, never reads it as passing. */
export class GateError extends Error {}

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

/** The vitest files an affected run adds (`every`: the always-run families too), desktop/web-relative. A test naming a
 * changed file outside desktop/web reads it, maybe through a variable or helper no family pattern sees. */
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
    if ((every && (scanner.test(text) || locale.test(text) || cited.has(name))) || named?.test(text)) {
      found.add(`src/__tests__/${name}`)
    }
  }
  const webModule = rule(table, 'webModule')
  for (const path of paths) { // the tests beside changed modules, and changed tests themselves
    const module = webModule.exec(path)?.[1]
    if (module === undefined) continue
    const stem = module.replace(/(\.test)?\.(tsx?|css)$/, '')
    for (const suffix of ['.test.ts', '.test.tsx']) if (isFile(join(root, WEB, `${stem}${suffix}`))) found.add(`${stem}${suffix}`)
  }
  return [...found].sort()
}

const docsOnly = (paths: readonly string[], table: Table) =>
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

/** The policy-gate Vitest project's files (each .test.ts under policy/gate), desktop/web-relative. */
function gateTests(root: string): string[] {
  const gate = join(root, 'policy/gate')
  if (!existsSync(gate)) return []
  return (readdirSync(gate, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((name) => name.endsWith('.test.ts') && isFile(join(gate, name)))
    .map((name) => `../../policy/gate/${name.split(/[\\/]/u).join('/')}`)
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

/** A module that renders a dialog: role dialog or alertdialog, a <dialog> element, or aria-modal. */
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
 * those reaching them), design check DR13: each spec reading a data-* attribute only that module writes, itself or
 * through an e2e/support helper it imports, or opening a dialog (role dialog or alertdialog) by the English text of a
 * locale key the module uses. An attribute other modules write too (data-preserve-overlays) names no one dialog.
 */
export function dialogSpecs(root: string, modules: readonly string[]): string[] {
  const read = (path: string) => readFileSync(join(root, WEB, path), 'utf8')
  const dialogs = modules.filter((module) => isFile(join(root, WEB, module)) && DIALOG.test(read(module)))
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

function e2ePlan(root: string, paths: readonly string[], table: Table, dialogs: readonly string[] = []): E2ePlan | undefined {
  const spec = rule(table, 'spec')
  let specs = new Set([...paths.flatMap((path) => {
    const found = spec.exec(path)?.[1]
    return found !== undefined && isFile(join(root, path)) ? [found] : []
  }), ...dialogs])
  for (const [name, dir] of [['e2eCanvas', 'e2e/canvas'], ['e2eGallery', 'e2e/gallery']] as const) {
    if (paths.some((path) => rule(table, name).test(path))) {
      specs = new Set([...[...specs].filter((s) => !s.startsWith(`${dir}/`)), dir])
    }
  }
  if (!specs.size) return undefined
  const sorted = [...specs].sort()
  const projects = ['chromium', 'webkit']
  if (sorted.some((s) => s.startsWith('e2e/gallery'))) projects.push('gallery-chromium', 'gallery-webkit')
  return e2eRun(root, sorted, projects)
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

type Matcher = (path: string) => boolean
type GlobEngine = (glob: string, options: { dot: boolean, posix: boolean }) => Matcher

/**
 * The cheap families check for `paths` (CHEAP_FAMILIES whose ratchet scope a path matches), read with the repository's
 * one glob engine (picomatch from desktop/web, 2.1-M348) and its options; with no engine installed, a note naming them.
 */
function cheapFamilies(root: string, paths: readonly string[], of: (id: string) => PlannedCheck): { check?: PlannedCheck, note?: string } {
  let engine: GlobEngine
  try {
    engine = createRequire(join(root, WEB, 'package.json'))('picomatch') as GlobEngine
  } catch {
    return { note: `${WEB}/node_modules/picomatch is missing (run npm ci in ${WEB}): ${CHEAP_FAMILIES.join(', ')} run at the affected gate` }
  }
  const reached = CHEAP_FAMILIES.filter((id) => {
    const file = `policy/ratchets/${id}.json`
    let scope: unknown
    try {
      scope = (JSON.parse(readFileSync(join(root, file), 'utf8')) as { scope?: unknown }).scope
    } catch {
      scope = undefined
    }
    if (!Array.isArray(scope)) throw new GateError(`${file} is missing or names no scope: the gate refuses rather than select too little`)
    const scoped = (scope as string[]).map((glob) => engine(glob, { dot: true, posix: true }))
    return paths.some((path) => scoped.some((match) => match(path)))
  })
  if (!reached.length) return {}
  const planned = of('cheap-families')
  return { check: { ...planned, command: `${planned.command} ${reached.map((id) => `--family ${id}`).join(' ')}` } }
}

/** The affected (`staged` false) or commit lane's plan for `paths`. */
export function planAffected(root: string, paths: readonly string[], staged: boolean, base?: string,
  env: NodeJS.ProcessEnv = process.env, given: Table = TABLE): Plan {
  const table = withRatchetPaths(root, given)
  const areas = table.areas.filter((area) => paths.some((path) => matches(area.patterns, path)))
  const of = (id: string) => check(id, table)
  if (paths.every((path) => path.startsWith('.beads/'))) {
    return { areas, checks: paths.length ? [of('closed-beads')] : [], e2e: undefined, notes: [] }
  }
  const notes: string[] = []
  const checks: PlannedCheck[] = []
  const toolchain = paths.some((path) => rule(table, 'toolchain').test(path))
  const drift = (at: string): PlannedCheck => ({ ...of('docs-drift'), command: `python3 scripts/check_docs.py --drift ${at}` })
  if (staged) {
    for (const area of areas) {
      if (area.name === 'docs') checks.push(of('docs'), drift(git(root, ['merge-base', 'HEAD', 'origin/main'], env).trim()))
      checks.push(...(area.commit ?? []).map(of))
    }
    if (toolchain) {
      checks.push(...POLICY_COMMIT.map(of))
      notes.push('a toolchain file changed: the whole Vitest suite runs at the affected gate')
    }
    if (paths.some((path) => rule(table, 'policy').test(path))) checks.push(...POLICY_COMMIT.map(of))
    if (!checks.some((planned) => planned.id === 'policy-check')) {
      const cheap = cheapFamilies(root, paths, of)
      if (cheap.check) checks.push(cheap.check)
      if (cheap.note) notes.push(cheap.note)
    }
    // A path is covered only by an area that runs something here: docs runs its row, the rest their commit checks.
    const uncovered = paths.filter((path) => !path.startsWith('.beads/') && !table.areas.some((area) =>
      matches(area.patterns, path) && ((area.commit ?? []).length > 0 || area.name === 'docs'))).sort()
    if (uncovered.length) notes.push(`no commit check covers ${uncovered.join(', ')}; the affected gate runs their checks`)
    return { areas, checks: dedupe(checks), e2e: undefined, notes }
  }
  const selected = new Set(areas.flatMap((area) => (area.affected ?? area.full).map((id) => display(of(id)))))
  for (const area of areas) {
    if (area.workflow) continue
    if (area.name === 'docs') {
      checks.push(of('docs'), drift(base ?? 'origin/main'))
      if (paths.some((path) => rule(table, 'docsValidator').test(path))) checks.push(of('docs-tests'))
      continue
    }
    for (const id of area.affected ?? area.full) {
      const planned = of(id)
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
    if (cheap.check) checks.push(cheap.check)
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
    if (paths.some((path) => rule(table, 'workflow').test(path))) checks.push(of('actionlint'))
    checks.push(...POLICY_COMMIT.map(of))
    e2e = e2ePlan(root, paths, table, dialogs)
    if (e2e) checks.push(of(e2e.needs))
  }
  return { areas, checks: dedupe(checks), e2e, notes }
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

/** A Rust gate builds in its own target: none set in a linked worktree, or the retired shared one anywhere, makes two
 * worktrees wait on one cargo build lock (2.1-M201). */
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

/** `areas`' JSON: the areas a change selects, the vitest files its lane adds and every area's patterns. */
export function areasJson(root: string, paths: readonly string[], given: Table = TABLE) {
  const table = withRatchetPaths(root, given)
  return {
    selected: table.areas.filter((area) => paths.some((path) => matches(area.patterns, path))).map((area) => area.name),
    tests: laneTests(root, paths, table),
    areas: table.areas.map(areaJson),
  }
}
