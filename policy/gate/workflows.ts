// policy/gate/workflows.ts: every CI workflow read as data, and each way CI is not the gate's table (plan 1.0 as amended
// by design check A5, AR2, AR3, DR12; 2.1-Q262, 2.1-Q267). Each fault function returns what is wrong as sentences, none
// for a sound CI; ci-parity.test.ts and workflow-parity.test.ts run them on the real workflows and on planted ones.
// Build & Test (build.yml) and the lanes it calls are bound: they run on a pull request, select through `gate areas`
// and run the areas' rows. Every other workflow is a lane of its own, on triggers the table's row for it names.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Yaml from 'yaml'
import { CI_SETUP, needsPackages, TABLE, type Check, type Table } from './table.ts'

/** desktop/web's YAML parser: policy/ has no packages of its own. */
const { parse } = createRequire(fileURLToPath(new URL('../../desktop/web/package.json', import.meta.url)))('yaml') as typeof Yaml

export interface Step {
  readonly id?: string, readonly name?: string, readonly if?: string, readonly run?: string, readonly uses?: string
  readonly with?: Readonly<Record<string, unknown>>, readonly 'working-directory'?: string
}
export interface Job {
  readonly if?: string, readonly needs?: string | readonly string[], readonly steps?: readonly Step[]
  readonly outputs?: Readonly<Record<string, string>>, readonly uses?: string, readonly 'timeout-minutes'?: number | string
  readonly defaults?: { readonly run?: { readonly 'working-directory'?: string } }
}
export interface Workflow {
  readonly name?: string, readonly on?: unknown, readonly concurrency?: { readonly group?: string } | string
  readonly jobs?: Readonly<Record<string, Job>>
}

/** Every workflow under `dir` by file name, parsed; one that fails to parse throws naming its file. */
export function readWorkflows(dir: string): Map<string, Workflow> {
  const parsed = new Map<string, Workflow>()
  for (const name of readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    try {
      parsed.set(name, parse(readFileSync(join(dir, name), 'utf8')) as Workflow)
    } catch (error) {
      throw new Error(`.github/workflows/${name} cannot be parsed: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  return parsed
}

/** A workflow's events, each with its filter (null when it has none). */
export const triggers = (flow: Workflow): Record<string, unknown> => {
  const on = flow.on
  if (typeof on === 'string') return { [on]: null }
  if (Array.isArray(on)) return Object.fromEntries((on as string[]).map((event) => [event, null]))
  return (on ?? {}) as Record<string, unknown>
}
export const groupOf = (flow: Workflow) => (typeof flow.concurrency === 'string' ? flow.concurrency : flow.concurrency?.group ?? '')
/** A group's literal name: what it says before its first expression, separators aside. */
const literal = (group: string) => (group.split('${{')[0] ?? '').replace(/[-_ ]+$/, '')

/**
 * Each concurrency group a workflow shares with another (A5 (6), AR3; failure states busy and cancelled): a called
 * workflow (on: workflow_call) grouping by `github.workflow` takes its caller's name and shares the caller's group (a
 * deadlock), one with no literal name has none of its own; two workflows with one literal name, or two grouping by
 * `github.workflow` under one workflow name, cancel each other's runs.
 */
export function groupFaults(all: ReadonlyMap<string, Workflow>): string[] {
  const faults: string[] = []
  const names = new Map<string, string>()
  const own = new Map<string, string>()
  for (const [file, flow] of all) {
    const group = groupOf(flow)
    if (!group) continue
    const called = 'workflow_call' in triggers(flow)
    if (group.includes('github.workflow')) {
      if (called) {
        faults.push(`${file} is called by another workflow and groups by github.workflow, its caller's: the runs share a group`)
        continue
      }
      const name = flow.name ?? `.github/workflows/${file}`
      if (own.has(name)) faults.push(`${own.get(name)} and ${file} are both named ${name} and group by it: one's run would cancel the other's`)
      own.set(name, file)
    } else if (!literal(group)) {
      if (called) faults.push(`${file} is called by another workflow and has no concurrency group named for itself`)
    } else if (names.has(literal(group))) {
      faults.push(`${names.get(literal(group))} and ${file} share the concurrency group ${literal(group)}: one lane's run would cancel the other's`)
    }
    if (literal(group)) names.set(literal(group), file)
  }
  return faults
}

/** The workflows build.yml calls, one per area naming one, by file name. */
export const calledLanes = (table: Table = TABLE) =>
  table.areas.flatMap((area) => (area.workflow ? [area.workflow.replace(/^\.github\/workflows\//, '')] : []))
/** Build & Test and the lanes it calls: what binds a merge (2.1-Q222). */
const bound = (table: Table) => new Set(['build.yml', ...calledLanes(table)])
/** The checks an area's row runs: any of its lanes' lists names it, or a listed check runs it (cov runs cargo-test, in
 * the rust area's affected list only). Only Build & Test and the lanes it calls run one (4a, 4b). */
const areaChecks = (table: Table) => {
  const listed = table.areas.flatMap((area) => [...area.full, ...area.affected ?? [], ...area.commit ?? []])
  return new Set([...listed, ...listed.flatMap((id) => table.checks[id]?.runs ?? [])])
}

/** A step whose every line is a gate call (`set -o` options aside): the one way a CI job runs a check. */
export const gateCall = (run: string) => run.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  .every((line) => /^set -[a-z]+(?: [a-z]+)*$/.test(line) || /^node policy\/gate\/cli\.mjs /.test(line))

/** The table's ci rows for `job` of `file` (build.yml's by job name, any other's as `<file> <job>`). */
const rowsOf = (table: Table, file: string, job: string) => table.ci[file === 'build.yml' ? job : `${file} ${job}`] ?? {}

/** The actions a job sets up with, which judge nothing: what a CI step may use with no row (A5 (1)). */
const SETUP_ACTIONS = new Set(['actions/checkout', 'actions/setup-node', 'actions/setup-python',
  'actions/download-artifact', 'dtolnay/rust-toolchain', 'Swatinem/rust-cache', 'taiki-e/install-action', './.github/actions/install-linux-deps',
  './.github/actions/cargo-policy-tools'])
const action = (uses: string) => uses.split('@')[0] ?? ''

/**
 * Each piece of `flow` no gate check holds (A5 (1)), outside a job's `*` row: a `run:` step that is neither a gate call
 * nor a ci_setup or ci_only row of policy/gate/table.ts's `ci` (by job and step name), a `uses:` step that is no setup
 * action and no row, a job calling a workflow that is no lane Build & Test calls (whose jobs the table holds), and each
 * row naming a step the job no longer has.
 */
export function inlineFaults(flow: Workflow, table: Table = TABLE, file = 'build.yml'): string[] {
  const faults: string[] = []
  const of = (name: string) => (file === 'build.yml' ? name : `${file} ${name}`)
  const lanes = calledLanes(table).map((lane) => `./.github/workflows/${lane}`)
  for (const [name, job] of Object.entries(flow.jobs ?? {})) {
    const rows = rowsOf(table, file, name)
    if ('*' in rows) continue
    if (job.uses !== undefined && !lanes.includes(job.uses)) {
      faults.push(`${file} job ${name} calls ${job.uses}, which is no lane Build & Test calls and no ci_only row in policy/gate/table.ts (A5 (1))`)
    }
    const steps = job.steps ?? []
    faults.push(...steps.flatMap((step) => stepFaults(step, rows, `${file} job ${name}`)))
    for (const key of Object.keys(rows)) {
      if (!steps.some((step) => (step.name ?? step.id) === key)) faults.push(`policy/gate/table.ts ci row ${of(name)}/${key} names no step that job runs`)
    }
  }
  return faults
}

/** What `step` of a job (`where`) runs that neither a gate call, a setup action nor the job's `rows` holds. */
function stepFaults(step: Step, rows: Readonly<Record<string, string>>, where: string): string[] {
  const key = step.name ?? step.id
  if ((key !== undefined && key in rows) || (step.run !== undefined && gateCall(step.run))) return []
  const what = step.run !== undefined ? `runs \`${step.run.trim().split('\n')[0]}\`, which is no gate call`
    : step.uses !== undefined && !SETUP_ACTIONS.has(action(step.uses)) ? `uses ${step.uses}, which is no setup action` : undefined
  return what ? [`${where} step ${key ?? '(unnamed)'} ${what} and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))`] : []
}

/** Each `ci` row naming a job no workflow has, which no inline check would then read. */
export function staleRowFaults(all: ReadonlyMap<string, Workflow>, table: Table = TABLE): string[] {
  return Object.keys(table.ci).filter((key) => {
    const [file, job] = key.includes(' ') ? key.split(' ') : ['build.yml', key]
    return !(job! in (all.get(file!)?.jobs ?? {}))
  }).map((key) => `policy/gate/table.ts ci row ${key} names a job no workflow has`)
}

const sorted = (events: readonly string[]) => [...events].sort().join(', ')

/**
 * Each way a lane's trigger is not its row's (A5 (4)): a check a workflow of its own runs (a ci row of an unbound
 * workflow) declares that workflow's events (`on`), and is no area's check, which Build & Test runs on a pull request;
 * a check a bound workflow runs declares none; a check declaring events is run by some unbound workflow. And every
 * area's CI-only lane runs in a pull request's Build & Test: a bound job's ci row or its `build.yml <job>` names it.
 */
export function triggerFaults(all: ReadonlyMap<string, Workflow>, table: Table = TABLE): string[] {
  const ran = lanesRun(all, table)
  const faults = 'pull_request' in triggers(all.get('build.yml') ?? {}) ? [] : ['build.yml runs on no pull_request: no area binds a merge']
  for (const [id, files] of ran) for (const file of files) faults.push(...laneFaults(id, file, all, table))
  for (const [id, check] of Object.entries(table.checks)) {
    if (check.on && !ran.has(id)) faults.push(`policy/gate/table.ts's ${id} row names triggers, but no workflow of its own runs it`)
  }
  return [...faults, ...unboundAreaFaults(all, ran, table)]
}

/** The workflows each ci_only check's rows run in, by check id. */
function lanesRun(all: ReadonlyMap<string, Workflow>, table: Table): Map<string, Set<string>> {
  const ran = new Map<string, Set<string>>()
  for (const [file, flow] of all) {
    for (const job of Object.keys(flow.jobs ?? {})) {
      for (const id of Object.values(rowsOf(table, file, job))) if (id !== CI_SETUP) ran.set(id, new Set([...ran.get(id) ?? [], file]))
    }
  }
  return ran
}

/** What is wrong with check `id` run by `file`'s rows: its triggers against the workflow's, and an area's check outside Build & Test. */
function laneFaults(id: string, file: string, all: ReadonlyMap<string, Workflow>, table: Table): string[] {
  const check: Check | undefined = table.checks[id]
  const events = Object.keys(triggers(all.get(file) ?? {}))
  if (bound(table).has(file)) {
    return check?.on ? [`policy/gate/table.ts's ${id} row names triggers (${sorted(check.on)}), but ${file} runs it through Build & Test`] : []
  }
  const faults = areaChecks(table).has(id)
    ? [`${id} is an area's check, run in a pull request's Build & Test, but ${file} runs it on triggers of its own`] : []
  if (!check?.on) return [`${file} runs ${id} on ${sorted(events)} of its own, and policy/gate/table.ts's ${id} row names no trigger`, ...faults]
  if (sorted(check.on) !== sorted(events)) faults.unshift(`${file} runs ${id} on ${sorted(events)}, but policy/gate/table.ts's ${id} row says ${sorted(check.on)}`)
  return faults
}

/** Each area's CI-only lane no Build & Test job runs: neither its `build.yml <job>` nor a bound job's ci row. */
function unboundAreaFaults(all: ReadonlyMap<string, Workflow>, ran: ReadonlyMap<string, ReadonlySet<string>>, table: Table): string[] {
  const jobs = all.get('build.yml')?.jobs ?? {}
  const tied = bound(table)
  return [...new Set(table.areas.flatMap((area) => area.full))].filter((id) => {
    const check = table.checks[id]
    if (!check?.ciOnly || check.prose) return false
    const shown = /^build\.yml ([a-z0-9-]+)$/.exec(check.shown ?? '')?.[1]
    return !((shown !== undefined && shown in jobs) || [...ran.get(id) ?? []].some((file) => tied.has(file)))
  }).map((id) => `${id} is an area's CI-only lane that no job of a pull request's Build & Test runs`)
}

const GATE_FULL = /node policy\/gate\/cli\.mjs full --area ([a-z0-9-]+)/g
/** A gate call: its mode (whatever word follows, an expression or a variable too) and the arguments to the line's end or
 * its first `|`, `&`, `;` or `)`. */
const GATE_CALL = /node policy\/gate\/cli\.mjs[ \t]+([^\s|&;)]+)([^\n|&;)]*)/g
/** The modes that run no check of a table row: the selection, the hooks' judges, the reports. */
const ROW_FREE = new Set(['areas', 'verify-push', 'bundle-summary', 'agents-rows', 'agent-hook', 'commit-gate'])
/** One word of a shell line: an expression, a quoted word or a bare one. */
const WORD = /\$\{\{.*?\}\}|"[^"]*"|'[^']*'|\S+/g

/**
 * Each workflow outside Build & Test that runs an area's row or a check of one (connections review 4a and 4b, AR2): it
 * would run it on a selection of its own, its triggers and paths, where only `gate areas` selects. A gate call runs one
 * by `full` (every area's without `--area`), by `affected`, `push` or the commit hooks (whose rows are selected), by
 * `check` with an area's check or a word naming no check (an expression or a variable may name one), by an area check's
 * own mode, or by a mode it cannot read: it fails closed. A step runs one by its command, whatever row its job has; a
 * job by calling a lane Build & Test calls.
 */
export function rowFaults(all: ReadonlyMap<string, Workflow>, table: Table = TABLE): string[] {
  const tied = bound(table)
  return [...all].filter(([file]) => !tied.has(file)).flatMap(([file, flow]) => Object.entries(flow.jobs ?? {})
    .flatMap(([job, { uses = '', steps = [] }]) => {
      const lane = uses.replace(/^\.\/\.github\/workflows\//, '')
      const runs = steps.flatMap(({ run = '' }) => [...areaRuns(run, table), ...bareRuns(run, table)])
      return [...tied.has(lane) ? [`${lane}, a lane Build & Test calls,`] : [], ...runs]
        .map((what) => `${file} job ${job} runs ${what} on triggers of its own: only Build & Test and the lanes it calls run an area's row`)
    }))
}

/** What of an area's row the gate calls in `run` run, as rowFaults names it. */
function areaRuns(run: string, table: Table): string[] {
  const ids = areaChecks(table)
  // An area check that is a gate mode of its own (oldest-engine, actionlint), by that mode.
  const modes = new Map([...ids].flatMap((id) => {
    const mode = /^node policy\/gate\/cli\.mjs ([a-z-]+)$/.exec(table.checks[id]?.command ?? '')?.[1]
    return mode === undefined ? [] : [[mode, id] as const]
  }))
  return [...run.matchAll(GATE_CALL)].flatMap(([, mode = '', args = '']) => {
    const words = args.match(WORD) ?? []
    if (mode === 'full') {
      const areas = [...args.matchAll(/--area ([a-z0-9-]+)/g)].map((match) => `the ${match[1]} row`)
      return areas.length ? areas : ['every area\'s row']
    }
    if (mode === 'affected' || mode === 'push') return [`the rows ${mode} selects`]
    if (mode === 'commit-gate' && /^pre-(merge-)?commit$/.test(words[0] ?? '')) return ['the rows the commit lane selects']
    if (mode === 'check') return checkWords(words).flatMap((word) => checkRun(word, ids, table))
    if (modes.has(mode)) return [`${modes.get(mode)}, an area's check,`]
    return ROW_FREE.has(mode) ? [] : [`\`${mode}\`, a gate mode it cannot read,`]
  })
}

/** The area checks a lane of its own may run for what they make, never as a judgement: the builds it times or drives. */
const BUILDS = new Set(['build', 'build-web'])

/** The area checks `run` runs by their own commands (their environment words aside), each a whole command in it. */
function bareRuns(run: string, table: Table): string[] {
  return [...areaChecks(table)].filter((id) => {
    const check = table.checks[id]
    if (!check || check.ciOnly || BUILDS.has(id) || check.command.startsWith('node policy/gate/cli.mjs ')) return false
    const command = check.command.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[\\s;&|(])${command}(?=$|[\\s;&|)])`).test(run)
  }).map((id) => `${id}, an area's check,`)
}

/** The words of `check`'s arguments naming a check: neither a flag nor a flag's value. */
const checkWords = (words: readonly string[]) => words.filter((word, index) => !word.startsWith('-') && words[index - 1] !== '--log-dir')

/** What `check <word>` runs of an area's row: an area's check, or a word naming no check (which may be one). */
function checkRun(word: string, ids: ReadonlySet<string>, table: Table): string[] {
  if (ids.has(word)) return [`${word}, an area's check,`]
  return word in table.checks ? [] : [`\`${word}\`, which may be an area's check,`]
}

/** What the local gate runs on: the engines Node major, rust-toolchain.toml's channel. */
export interface Toolchain { readonly node: string, readonly rust: string }

/** The repository's toolchain at `root`. */
export function toolchain(root: string): Toolchain {
  const engines = (JSON.parse(readFileSync(join(root, 'desktop/web/package.json'), 'utf8')) as { engines?: { node?: string } }).engines?.node
  const rust = /^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'rust-toolchain.toml'), 'utf8'))?.[1]
  return { node: /(\d+)/.exec(engines ?? '')?.[1] ?? '?', rust: rust ?? '?' }
}

/** The table checks a gate call line runs: an area's full row, or `check <id>...`'s checks. */
function called(run: string, table: Table): Check[] {
  const ids = [...run.matchAll(GATE_FULL)].flatMap((match) => table.areas.find((area) => area.name === match[1])?.full ?? [])
  for (const match of run.matchAll(/node policy\/gate\/cli\.mjs check ((?:[a-z0-9-]+ ?)+)/g)) ids.push(...(match[1] ?? '').trim().split(' '))
  return ids.flatMap((id) => (table.checks[id] ? [table.checks[id]] : []))
}

/**
 * Each way a job's setup is not the local gate's (A5 (5)), in every workflow and composite action (`steps` by file):
 * a Node other than the engines major, a Rust other than rust-toolchain.toml's or a Python not read from .python-version;
 * a gate call before the engines Node is set up (a runner's default Node cannot strip types); a check needing
 * desktop/web's packages (each test:policies script, the policy core under check.mjs and check_docs.py) with no npm ci
 * there before it; the push-lane clippy families with no Linux dependencies before them.
 */
export function setupFaults(jobs: ReadonlyMap<string, { readonly steps: readonly Step[], readonly cwd?: string }>, tools: Toolchain,
  clippy: boolean, table: Table = TABLE): string[] {
  const faults: string[] = []
  for (const [where, { steps, cwd }] of jobs) {
    const have = { node: false, npm: false, deps: false }
    for (const step of steps) {
      faults.push(...versionFaults(where, step, tools))
      have.node ||= (step.uses ?? '').startsWith('actions/setup-node@') && String(step.with?.['node-version'] ?? '') === tools.node
      have.deps ||= step.uses === './.github/actions/install-linux-deps'
      have.npm ||= installsWeb(step, cwd)
      faults.push(...gateNeedFaults(where, step, have, tools, clippy, table))
    }
  }
  return faults
}

/** Each toolchain `step` sets up that is not the local gate's. */
function versionFaults(where: string, step: Step, tools: Toolchain): string[] {
  const uses = step.uses ?? ''
  const faults: string[] = []
  const version = String(step.with?.['node-version'] ?? '')
  if (uses.startsWith('actions/setup-node@') && version !== tools.node) faults.push(`${where} sets up Node ${version || '(none)'}, not the engines Node ${tools.node}`)
  const rust = /^dtolnay\/rust-toolchain@(.+)$/.exec(uses)?.[1]
  if (rust !== undefined && rust !== tools.rust) faults.push(`${where} installs Rust ${rust}, not rust-toolchain.toml's ${tools.rust}`)
  const python = step.with ?? {}
  if (uses.startsWith('actions/setup-python@') && (python['python-version-file'] !== '.python-version' || 'python-version' in python)) {
    faults.push(`${where} sets up a Python not read from .python-version`)
  }
  return faults
}

/** Whether `step` installs desktop/web's packages: npm ci there, by --prefix or working directory. */
const installsWeb = (step: Step, cwd: string | undefined) => /(^|\s)npm ci\b/.test(step.run ?? '')
  && ((step.run ?? '').includes('--prefix desktop/web') || (step['working-directory'] ?? cwd) === 'desktop/web')

/** What a gate call `step` lacks from the setup before it (`have`). */
function gateNeedFaults(where: string, step: Step, have: { node: boolean, npm: boolean, deps: boolean }, tools: Toolchain,
  clippy: boolean, table: Table): string[] {
  const run = step.run ?? ''
  if (!/node policy\/gate\/cli\.mjs /.test(run)) return []
  const faults = have.node ? [] : [`${where} sets up no Node ${tools.node} before the gate`]
  const checks = called(run, table)
  const what = step.name ?? step.id ?? 'its gate call'
  if (!have.npm && checks.some((check) => needsPackages(check) || /check(_docs\.py|\.mjs)/.test(check.command))) {
    faults.push(`${where} runs no npm ci in desktop/web before ${what}`)
  }
  if (clippy && !have.deps && checks.some((check) => check.cargo && check.command.includes('test:policies'))) {
    faults.push(`${where} installs no Linux dependencies before ${what}'s clippy families`)
  }
  return faults
}

/** Every job of `all` and every composite action under `actions` as setupFaults reads them, by where they are. */
export function setupJobs(all: ReadonlyMap<string, Workflow>, actions: ReadonlyMap<string, readonly Step[]> = new Map()) {
  const jobs = new Map<string, { steps: readonly Step[], cwd?: string }>()
  for (const [file, flow] of all) {
    for (const [name, job] of Object.entries(flow.jobs ?? {})) {
      const cwd = job.defaults?.run?.['working-directory']
      jobs.set(`${file} job ${name}`, { steps: job.steps ?? [], ...cwd === undefined ? {} : { cwd } })
    }
  }
  for (const [file, steps] of actions) jobs.set(file, { steps })
  return jobs
}

/** The steps of each composite action under `root`/.github/actions, by its action.yml path. */
export function readActions(root: string): Map<string, readonly Step[]> {
  const dir = join(root, '.github/actions')
  return new Map(readdirSync(dir).sort().map((name) => {
    const path = `.github/actions/${name}/action.yml`
    return [path, ((parse(readFileSync(join(root, path), 'utf8')) as { runs?: { steps?: Step[] } }).runs?.steps ?? [])] as const
  }))
}
