// Selection parity between CI and the gate (plan 1.0 as amended by design check A5, AR2, AR22; 2.1-Q262, 2.1-Q267):
// build.yml's changes job selects only through `gate areas`, each area job runs when its own area is selected and runs
// that area's row, every build.yml step is a gate call or a ci row of the table (A5 (1)), CI runs a check for a path
// exactly when the pre-push lane does (A5 (3)), a called workflow's concurrency group is its own, and every workflow
// parses. Each rule is a fault function, run on the real workflows and on planted ones (the connections review's
// findings 4a and 4b, an inline command, a CI-only and a local-only check among them).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { REPO_ROOT } from './planted-repo.ts'
import { areasJson, laneTests, planFull, planPush } from './plan.ts'
import { CI_SETUP, display, TABLE, type Table } from './table.ts'

/** desktop/web's YAML parser: policy/ has no packages of its own. */
const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml

interface Step { readonly id?: string, readonly name?: string, readonly if?: string, readonly run?: string }
interface Job {
  readonly if?: string, readonly needs?: string | readonly string[], readonly steps?: readonly Step[]
  readonly outputs?: Readonly<Record<string, string>>
}
interface Workflow { readonly on?: unknown, readonly concurrency?: { readonly group?: string } | string, readonly jobs?: Readonly<Record<string, Job>> }

/** Every workflow under `dir` by file name, parsed; one that fails to parse throws naming its file. */
function workflows(dir: string): Map<string, Workflow> {
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

const GATE_FULL = /node policy\/gate\/cli\.mjs full --area ([a-z0-9-]+)/
/** A shell line that selects by path regex: a grep -E over paths or a regex variable. */
const PATH_REGEX = /\bgrep\b[^\n]*-[a-zA-Z]*E|^\s*[a-z_]*(?:paths|inputs)=/m
/** `if has a || has b; then flag=true`: the areas that turn a changes output on. */
const FLAG = /if ((?:has [a-z0-9-]+(?: \|\| )?)+); then ([a-z_]+)=true/g

/**
 * Each way build.yml's selection is not the gate's (AR2): a changes-job step selecting by path regex; an area job whose
 * `if` reads a changes output that another area turns on (CI then runs that area's row for paths whose local lane
 * selects none of it, connections review 4a), or that no area turns on, or no output at all unless the affected lane
 * runs that area on every change too (`every`).
 */
function selectionFaults(build: Workflow, table: Table = TABLE): string[] {
  const steps = build.jobs?.['changes']?.steps ?? []
  const faults = steps.filter((step) => PATH_REGEX.test(step.run ?? ''))
    .map((step) => `build.yml changes step ${step.id ?? step.name ?? '?'} selects by path regex: only gate areas select (AR2)`)
  const on = turnedOn(steps.map((step) => step.run ?? '').join('\n'))
  for (const [name, job] of Object.entries(build.jobs ?? {})) faults.push(...jobFaults(name, job, on, table))
  return faults
}

/** The areas that turn each changes output on (`if has a || has b; then flag=true`). */
function turnedOn(script: string): Map<string, Set<string>> {
  const on = new Map<string, Set<string>>()
  for (const match of script.matchAll(FLAG)) {
    const areas = (match[1] ?? '').split(' || ').map((term) => term.replace('has ', ''))
    on.set(match[2] ?? '', new Set([...on.get(match[2] ?? '') ?? [], ...areas]))
  }
  return on
}

/** An area job's faults: its `if` reads no area's output (unless the area runs on `every` change), one no area turns on,
 * or one another area turns on. */
function jobFaults(name: string, job: Job, on: ReadonlyMap<string, ReadonlySet<string>>, table: Table): string[] {
  const area = (job.steps ?? []).map((step) => GATE_FULL.exec(step.run ?? '')?.[1]).find((found) => found !== undefined)
  const row = table.areas.find((candidate) => candidate.name === area)
  if (!row) return []
  const flags = [...(job.if ?? '').matchAll(/needs\.changes\.outputs\.([a-z_]+) == 'true'/g)].map((match) => match[1] ?? '')
  if (!flags.length) return row.every ? [] : [`build.yml job ${name} runs the ${row.name} row on every change: its if reads no area's changes output`]
  return flags.flatMap((flag) => {
    const areas = on.get(flag)
    if (!areas) return [`build.yml job ${name} reads changes output ${flag}, which no area turns on`]
    return [...areas].filter((other) => other !== row.name)
      .map((other) => `build.yml job ${name} runs the ${row.name} row when ${other} is selected, whose local lane runs no ${row.name} row`)
  })
}

/** Each called workflow (on: workflow_call) whose concurrency group is `github.workflow`, its caller's name (A5 (6)). */
function sharedGroupFaults(all: ReadonlyMap<string, Workflow>): string[] {
  return [...all].filter(([, flow]) => {
    const on = flow.on
    const called = typeof on === 'object' && on !== null && 'workflow_call' in on
    const group = typeof flow.concurrency === 'string' ? flow.concurrency : flow.concurrency?.group ?? ''
    return called && group.includes('github.workflow')
  }).map(([name]) => `${name} is called by another workflow and groups by github.workflow, its caller's: the runs share a group`)
}

/** A step whose every line is a gate call (`set -o` options aside): the one way a build.yml job runs a check. */
const gateCall = (run: string) => run.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  .every((line) => /^set -[a-z]+(?: [a-z]+)*$/.test(line) || /^node policy\/gate\/cli\.mjs /.test(line))

/**
 * Each build.yml step that runs a command no gate check holds (A5 (1)): a `run:` that is neither a gate call nor a
 * ci_setup or ci_only row of policy/gate/table.ts's `ci` (by job and step name; `*` the whole job), and each row naming
 * a step the job no longer has.
 */
function inlineFaults(build: Workflow, table: Table = TABLE): string[] {
  const faults: string[] = []
  for (const [name, job] of Object.entries(build.jobs ?? {})) {
    const rows = table.ci[name] ?? {}
    if ('*' in rows) continue
    const steps = job.steps ?? []
    for (const step of steps.filter((candidate) => candidate.run !== undefined)) {
      const key = step.name ?? step.id
      if (gateCall(step.run ?? '') || (key !== undefined && key in rows)) continue
      faults.push(`build.yml job ${name} step ${key ?? '(unnamed)'} runs \`${(step.run ?? '').trim().split('\n')[0]}\`, `
        + 'which is no gate call and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))')
    }
    for (const key of Object.keys(rows)) {
      if (!steps.some((step) => (step.name ?? step.id) === key && step.run !== undefined)) {
        faults.push(`policy/gate/table.ts ci row ${name}/${key} names no step that job runs`)
      }
    }
  }
  return faults
}

/** `condition` (an `if:` over the changes outputs: ==, != against a quoted value, always(), &&, ||, parentheses) for `outputs`;
 * undefined when it reads anything else, which no selection can judge. */
function holds(condition: string | undefined, outputs: ReadonlyMap<string, string>): boolean | undefined {
  if (condition === undefined) return true
  const text = condition.replace(/needs\.changes\.outputs\.(\w+)\s*(==|!=)\s*'([^']*)'/g,
    (_, name: string, op: string, value: string) => String(((outputs.get(name) ?? '') === value) === (op === '==')))
    .replace(/\balways\(\)/g, 'true')
  const tokens = text.match(/true|false|&&|\|\||[()]|\S+/g) ?? []
  let at = 0
  const fail = Symbol('unreadable')
  const term = (): boolean | typeof fail => {
    const token = tokens[at++]
    if (token === 'true' || token === 'false') return token === 'true'
    if (token !== '(') return fail
    const inner = or()
    return tokens[at++] === ')' ? inner : fail
  }
  const and = (): boolean | typeof fail => {
    let value = term()
    while (tokens[at] === '&&') {
      at += 1
      const next = term()
      value = value === fail || next === fail ? fail : value && next
    }
    return value
  }
  const or = (): boolean | typeof fail => {
    let value = and()
    while (tokens[at] === '||') {
      at += 1
      const next = and()
      value = value === fail || next === fail ? fail : value || next
    }
    return value
  }
  const value = or()
  return value === fail || at !== tokens.length ? undefined : value
}

/** The changes outputs whose all being false names the lane tests (`if [ "$a" = false ] && ...; then tests=...`). */
const TESTS_WHEN = /^\s*if (.+?); then tests="\$\(jq -r '\.tests \| join\(" "\)'/m

/** The changes job's outputs on a PR changing `paths`, from `gate areas` as its diff step reads it. */
function prOutputs(build: Workflow, paths: readonly string[]): Map<string, string> {
  const changes = build.jobs?.['changes']
  const selection = areasJson(REPO_ROOT, paths)
  const script = (changes?.steps ?? []).map((step) => step.run ?? '').join('\n')
  const on = turnedOn(script)
  const flags = new Map<string, string>([['code', String(selection.code)]])
  for (const [flag, areas] of on) flags.set(flag, String([...areas].some((area) => selection.selected.includes(area))))
  const off = (TESTS_WHEN.exec(script)?.[1] ?? '').split('&&').map((term) => /^\s*\[ "\$(\w+)" = false \]\s*$/.exec(term)?.[1])
  const named = off.length > 0 && off.every((flag) => flag !== undefined && flags.get(flag) === 'false')
  flags.set('tests', named ? selection.tests.join(' ') : '')
  flags.set('sha', 'base')
  return new Map(Object.entries(changes?.outputs ?? {})
    .map(([name, value]) => [name, flags.get(/steps\.\w+\.outputs\.(\w+)/.exec(value)?.[1] ?? '') ?? '']))
}

/** The checks a build.yml PR run makes for `paths`, ci_only rows aside, and what of it no selection can judge. */
function ciChecks(build: Workflow, paths: readonly string[], table: Table = TABLE): { checks: Set<string>, faults: string[] } {
  const outputs = prOutputs(build, paths)
  const checks = new Set<string>()
  const faults: string[] = []
  for (const [name, job] of Object.entries(build.jobs ?? {})) {
    const rows = table.ci[name] ?? {}
    if (name === 'changes' || '*' in rows) continue
    const runs = holds(job.if, outputs)
    if (runs === undefined) faults.push(`build.yml job ${name}'s if reads more than the changes outputs: ${job.if}`)
    if (!runs) continue
    for (const step of job.steps ?? []) {
      const key = step.name ?? step.id ?? ''
      if (step.run === undefined || key in rows || holds(step.if, outputs) === false) continue
      for (const id of step.run.split('\n').flatMap((line) => lineChecks(line.trim(), table))) checks.add(id)
    }
  }
  return { checks, faults }
}

/** The checks a gate call line runs, ci_only ones aside: an area's full row, an affected lane's `--only` check, or the
 * table check whose command the line is. */
function lineChecks(line: string, table: Table): string[] {
  const area = GATE_FULL.exec(line)?.[1]
  const only = /node policy\/gate\/cli\.mjs affected .*--only ([a-z0-9-]+)/.exec(line)?.[1]
  const own = Object.entries(table.checks).find(([, check]) => check.command === line)?.[0]
  const ids = area ? table.areas.find((row) => row.name === area)?.full ?? [] : [only ?? own].filter((id) => id !== undefined)
  return ids.filter((id) => !table.checks[id]?.ciOnly)
}

/** Each check CI runs for a path the pre-push lane does not, and each area check the pre-push lane runs that no CI job
 * runs or covers (A5 (3), AR22: parity both ways), over single-path PRs, one per selection the table makes. */
function pushFaults(build: Workflow, probes: readonly string[], table: Table = TABLE): string[] {
  const faults: string[] = []
  for (const path of probes) {
    const ci = ciChecks(build, [path], table)
    faults.push(...ci.faults)
    const plan = planPush(REPO_ROOT, [path], 'origin/main', process.env, table)
    const local = new Set(plan.checks.map((check) => check.id))
    for (const id of ci.checks) if (!local.has(id)) faults.push(`CI runs ${id} for ${path}, which the pre-push lane does not`)
    if (local.has('vitest-lane') && !ci.checks.has('vitest-lane')) faults.push(`the pre-push lane runs vitest-lane for ${path}, which no CI job runs`)
    const covered = new Set([...ci.checks].flatMap((id) => [id, ...table.checks[id]?.runs ?? []]))
    for (const area of table.areas.filter((row) => !row.workflow && (row.every || plan.areas.includes(row)))) {
      if ((area.coveredBy ?? []).length && (area.coveredBy ?? []).every((id) => covered.has(id))) continue
      for (const id of area.full.filter((check) => !table.checks[check]?.ciOnly && !covered.has(check))) {
        faults.push(`the pre-push lane runs ${id} for ${path}, which no CI job runs`)
      }
    }
  }
  return faults
}

/** One single-path change per selection the table makes (each area, the lane tests, a docs-only and a beads-only one). */
const PROBES = ['desktop/src/lib.rs', 'desktop/src/db/x.rs', 'desktop/src/services/lidar/x.rs', 'desktop/web/src/app/x.ts',
  'desktop/web/src/ipc/x.ts', 'desktop/web/src/i18n/en.json', 'desktop/web/src/generated/x.ts', 'desktop/web/package.json',
  'desktop/tauri.conf.json', 'canopi-types/src/lib.rs', 'bindings-gen/src/lib.rs', 'policy/check.mjs', 'policy/gate/plan.ts',
  'scripts/species_catalog_contract.py', 'scripts/x.py', 'docs/a.md', 'README.md', '.github/workflows/build.yml',
  '.github/actions/x/action.yml', 'sgconfig.yml', 'Cargo.lock', '.python-version', '.beads/issues.jsonl']

// A step runs `npm run <script>` when it names that exact script (`build` is not `build:web`); names are [\w:-].
const runsScript = (run: string, script: string) => new RegExp(`\\bnpm run ${script}(?![\\w:-])`).test(run)

/** What keeps Build & Test from being the one required check that every job's failure reaches (A5 (5), 2.1-Q222,
 * 2.1-M240): it needs every other job and only them, runs always() and fails on a failed or cancelled one; and the
 * frontend row (`frontendRow`, the commands of its checks in order) checks bundle sizes after both builds. */
function buildAndTestFaults({ jobs = {} }: Workflow, frontendRow: readonly string[]): string[] {
  const faults: string[] = []
  const aggregate = jobs['build-and-test']
  if (!aggregate) return ['no build-and-test job']
  const needs = new Set([aggregate.needs ?? []].flat())
  for (const job of Object.keys(jobs)) {
    if (job !== 'build-and-test' && !needs.has(job)) faults.push(`build-and-test does not need ${job}`)
  }
  for (const job of needs) if (!(job in jobs) || job === 'build-and-test') faults.push(`build-and-test needs ${job}, no other job`)
  if (aggregate.if !== 'always()') faults.push('build-and-test does not run always()')
  const failsOn = (step: Step, result: string) => (step.if ?? '').includes(`contains(needs.*.result, '${result}')`)
  if (!(aggregate.steps ?? []).some((step) => failsOn(step, 'failure') && failsOn(step, 'cancelled') && /^\s*exit [1-9]\d*\s*$/.test(step.run ?? ''))) {
    faults.push('build-and-test passes when a job it needs failed or was cancelled')
  }
  const last = (script: string) => Math.max(-1, ...frontendRow.flatMap((run, index) => (runsScript(run, script) ? [index] : [])))
  const bundle = frontendRow.findIndex((run) => runsScript(run, 'test:policies:bundle'))
  if (bundle < 0) faults.push('the frontend row runs no test:policies:bundle')
  else if (bundle < last('build') || bundle < last('build:web')) faults.push('the frontend row checks bundle sizes before both builds')
  if (last('build') < 0 || last('build:web') < 0) faults.push('the frontend row does not build both editions')
  return faults
}

type Matcher = (path: string) => boolean
/** desktop/web's glob engine, the repository's one (2.1-M348), reading a workflow's path filters. */
const picomatch = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('picomatch') as (glob: string, options: { dot: boolean }) => Matcher

/** Whether GitHub's `paths` filter `globs` runs a workflow for `path`: the last glob matching it decides, `!` excludes. */
function filtered(globs: readonly string[], path: string): boolean {
  let runs = false
  for (const glob of globs) {
    const negated = glob.startsWith('!')
    if (picomatch(negated ? glob.slice(1) : glob, { dot: true })(path)) runs = !negated
  }
  return runs
}

/**
 * Each area whose lane still selects by its workflow's own `on.paths` (A5 (2), until that workflow selects through `gate
 * areas`) where those paths and the area's patterns disagree on a probe path (`onPaths`): `gate areas` and AGENTS.md
 * would otherwise claim a lane runs for paths that never trigger it, or miss ones that do.
 */
function triggerFaults(all: ReadonlyMap<string, Workflow>, probes: readonly string[], table: Table = TABLE): string[] {
  const faults: string[] = []
  for (const area of table.areas.filter((row) => row.onPaths)) {
    const name = (area.onPaths ?? '').replace(/^\.github\/workflows\//, '')
    const on = (all.get(name)?.on ?? {}) as Record<string, { paths?: readonly string[] } | null>
    for (const event of ['push', 'pull_request']) {
      const globs = on[event]?.paths
      if (!globs) {
        faults.push(`${area.onPaths} ${event} has no paths for the ${area.name} area`)
        continue
      }
      const differ = probes.filter((path) => filtered(globs, path) !== area.patterns.some((pattern) => new RegExp(pattern).test(path)))
      if (differ.length) faults.push(`${area.onPaths} ${event} paths and the ${area.name} area's patterns disagree on ${differ.slice(0, 3).join(', ')}`)
    }
  }
  return faults
}

/** Every tracked path, and paths that sit on each filter's edges. */
const TRIGGER_PROBES = [...spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean),
  'desktop/web/a.md', 'desktop/web/src/a/b.md', 'desktop/x', 'canopi-types/x', 'policy/x/y', 'docs/x.md', 'x/Cargo.lock']

const real = workflows(join(REPO_ROOT, '.github/workflows'))
const build = real.get('build.yml') ?? {}

/** build.yml with the changes job's `diff` step's script replaced by `script`. */
const withChanges = (script: string): Workflow => ({ ...build, jobs: { ...build.jobs, changes: { steps: [{ id: 'diff', run: script }] } } })

describe('selection parity (A5, AR2)', () => {
  it('canopi-f47t.52.228.54: build.yml selects only through the gate\'s areas', () => {
    expect(selectionFaults(build)).toEqual([])
  })

  it('canopi-f47t.52.228.54: a path regex in the changes job fails (connections review 4b)', () => {
    // 4b: rust_paths ended in ^policy/, so CI ran the push-lane families for a policy/ change that the local lane's
    // areas never sent there.
    const script = "rust_paths='\\.rs$|^policy/'\nif grep -qE \"$rust_paths\" <<<\"$changed\"; then rust=true; fi\n"
      + 'if has rust; then rust=true; fi\nif has frontend; then frontend=true; fi\nif has policy-tooling; then policy=true; fi\n'
      + 'if has tauri-command; then tauri=true; fi\nif has shared-contracts; then contracts=true; fi\nif has species-catalog; then species=true; fi\n'
      + 'if has workflows; then workflows=true; fi\n'
    expect(selectionFaults(withChanges(script))).toEqual(['build.yml changes step diff selects by path regex: only gate areas select (AR2)'])
  })

  it('canopi-f47t.52.228.54: an area job turned on by another area fails (connections review 4a)', () => {
    // 4a: web_rust_paths sent bootstrap.ts to the Rust job, whose row the tauri-command area (ipc/ only) never selects.
    const script = 'if has rust || has tauri-command; then rust=true; fi\nif has frontend; then frontend=true; fi\n'
      + 'if has policy-tooling; then policy=true; fi\nif has tauri-command; then tauri=true; fi\n'
      + 'if has shared-contracts; then contracts=true; fi\nif has species-catalog; then species=true; fi\nif has workflows; then workflows=true; fi\n'
    expect(selectionFaults(withChanges(script)))
      .toEqual(['build.yml job rust runs the rust row when tauri-command is selected, whose local lane runs no rust row'])
    const always = { ...build, jobs: { ...build.jobs, frontend: { ...build.jobs?.['frontend'], if: "needs.changes.outputs.code == 'true'" } } }
    expect(selectionFaults(always)).toContain('build.yml job frontend reads changes output code, which no area turns on')
  })

  it('canopi-f47t.52.228.54: a called workflow never shares its caller\'s concurrency group', () => {
    expect(sharedGroupFaults(real)).toEqual([])
    const planted = new Map<string, Workflow>([['called.yml', { on: { workflow_call: {} }, concurrency: { group: '${{ github.workflow }}-x' } }],
      ['own.yml', { on: { workflow_call: {} }, concurrency: { group: 'own-${{ github.run_id }}' } }], ['top.yml', { on: 'push', concurrency: '${{ github.workflow }}' }]])
    expect(sharedGroupFaults(planted)).toEqual(['called.yml is called by another workflow and groups by github.workflow, its caller\'s: the runs share a group'])
  })

  it('canopi-f47t.52.228.54: every build.yml step is a gate call or a ci_setup or ci_only row (A5 (1))', () => {
    expect(inlineFaults(build)).toEqual([])
    // DR12: the lint job ran the Unicode facts and the spec type checks inline, which no local lane ran.
    const inline = { ...build, jobs: { ...build.jobs, lint: { steps: [{ name: 'Check facts', run: 'python3 scripts/x.py check' }] } } }
    expect(inlineFaults(inline)).toEqual(['build.yml job lint step Check facts runs `python3 scripts/x.py check`, which is no '
      + 'gate call and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))'])
    const stale = { ...TABLE, ci: { ...TABLE.ci, docs: { ...TABLE.ci['docs'], Gone: CI_SETUP } } }
    expect(inlineFaults(build, stale)).toEqual(['policy/gate/table.ts ci row docs/Gone names no step that job runs'])
  })

  it('canopi-f47t.52.228.54: CI runs no check for a path that the pre-push lane does not, nor the other way (A5 (3), AR22)', () => {
    expect(pushFaults(build, PROBES)).toEqual([])
    // A CI-only job: actionlint on every code change, where the local lanes run it for a workflow change only.
    const everyCode = { ...build, jobs: { ...build.jobs, lint: { if: "needs.changes.outputs.code == 'true'",
      steps: [{ name: 'actionlint', run: 'node policy/gate/cli.mjs actionlint' }] } } }
    expect(pushFaults(everyCode, ['desktop/web/src/app/x.ts'])).toEqual(['CI runs actionlint for desktop/web/src/app/x.ts, which the pre-push lane does not'])
    // A local-only check: an area row no CI job runs.
    const { ['species-catalog']: _, ...rest } = build.jobs ?? {}
    expect(pushFaults({ ...build, jobs: rest }, ['scripts/species_catalog_contract.py'])).toEqual([
      'the pre-push lane runs species-contract for scripts/species_catalog_contract.py, which no CI job runs',
      'the pre-push lane runs species-tests for scripts/species_catalog_contract.py, which no CI job runs'])
    const unreadable = { ...build, jobs: { ...build.jobs, docs: { ...build.jobs?.['docs'], if: "github.actor == 'x'" } } }
    expect(pushFaults(unreadable, ['docs/a.md'])).toContain('build.yml job docs\'s if reads more than the changes outputs: github.actor == \'x\'')
  })

  // A PR changing only a workflow must run this suite, which reads every workflow, or it would merge with its guards
  // unrun (seam 10): the gate's lane tests hold the policy-gate project for a workflow change, and CI runs them when its
  // frontend job, whose coverage run holds them, is off (the A5 (3) case above holds that routing).
  it('canopi-f47t.52.228.10: a PR changing only a workflow runs this suite, and the lane tests run exactly when the frontend job is off', () => {
    const suite = '../../policy/gate/ci-parity.test.ts'
    for (const name of real.keys()) expect(laneTests(REPO_ROOT, [`.github/workflows/${name}`]), name).toContain(suite)
    const narrow = { ...TABLE, paths: { ...TABLE.paths, policyGate: String.raw`^policy/` } }
    expect(laneTests(REPO_ROOT, ['.github/workflows/build.yml'], narrow)).not.toContain(suite)
    // Lane tests named on rust=false too go unrun for a rust-only change, whose frontend job is off.
    const diff = build.jobs?.['changes']?.steps?.find((step) => step.id === 'diff')?.run ?? ''
    const late = { ...build, jobs: { ...build.jobs, changes: { ...build.jobs?.['changes'], steps: [{ id: 'diff',
      run: diff.replace('if [ "$frontend" = false ]; then', 'if [ "$rust" = false ] && [ "$frontend" = false ]; then') }] } } }
    expect(late.jobs.changes.steps[0]?.run).not.toBe(diff)
    expect(pushFaults(late, ['desktop/src/x.rs'])).toEqual(['the pre-push lane runs vitest-lane for desktop/src/x.rs, which no CI job runs'])
    // Lane tests named while the frontend job runs run twice, where the pre-push lane leaves them to its coverage run.
    const twice = { ...build, jobs: { ...build.jobs, changes: { ...build.jobs?.['changes'], steps: [{ id: 'diff',
      run: diff.replace('if [ "$frontend" = false ]; then', 'if [ "$species" = false ]; then') }] } } }
    expect(pushFaults(twice, ['desktop/web/src/app/x.ts'])).toEqual(['CI runs vitest-lane for desktop/web/src/app/x.ts, which the pre-push lane does not'])
  })

  it('makes Build & Test need every other job, run always, fail when one failed or was cancelled, and check bundle sizes after both builds (2.1-Q222, 2.1-M240)', () => {
    expect(buildAndTestFaults(build, planFull(['frontend']).checks.map(display))).toEqual([])
    const failing: Step[] = [{ if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')", run: 'exit 1' }]
    const row = ['npm run build', 'npm run build:web', 'npm run test:policies:bundle']
    const planted: Workflow = { jobs: { lint: {}, late: {}, frontend: {}, 'build-and-test': { needs: ['lint', 'frontend', 'gone'], if: 'success()', steps: failing } } }
    expect(buildAndTestFaults(planted, ['npm run build', 'npm run test:policies:bundle', 'npm run build:web'])).toEqual([
      'build-and-test does not need late',
      'build-and-test needs gone, no other job',
      'build-and-test does not run always()',
      'the frontend row checks bundle sizes before both builds',
    ])
    const aggregate = (steps?: Step[]): Workflow => ({ jobs: { frontend: {}, 'build-and-test': { needs: 'frontend', if: 'always()', steps } } })
    expect(buildAndTestFaults(aggregate(failing), ['npm run build:web']))
      .toEqual(['the frontend row runs no test:policies:bundle', 'the frontend row does not build both editions'])
    // Run always(), the aggregate is green unless a step fails on a failed or cancelled job.
    const noFail = ['build-and-test passes when a job it needs failed or was cancelled']
    expect(buildAndTestFaults(aggregate(failing), row)).toEqual([])
    expect(buildAndTestFaults(aggregate(), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: "contains(needs.*.result, 'failed') || contains(needs.*.result, 'cancelled')", run: 'exit 1' }]), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: "contains(needs.*.result, 'failure')", run: 'exit 1' }]), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: failing[0]!.if, run: 'exit 0' }]), row)).toEqual(noFail)
  })

  it('canopi-f47t.52.228.54: a lane still selecting by its own on.paths selects what its area\'s patterns do (A5 (2))', () => {
    expect(TABLE.areas.filter((area) => area.onPaths).map((area) => area.name)).toEqual(['real-app', 'a11y'])
    expect(triggerFaults(real, TRIGGER_PROBES)).toEqual([])
    const browsers = real.get('web-edition-browsers.yml') ?? {}
    const on = browsers.on as Record<string, { paths: string[] }>
    const narrowed = { ...on, pull_request: { ...on['pull_request'], paths: (on['pull_request']?.paths ?? []).filter((glob) => glob !== 'policy/**') } }
    const planted = new Map([...real, ['web-edition-browsers.yml', { ...browsers, on: narrowed }]])
    expect(triggerFaults(planted, ['policy/x/y', 'desktop/web/a.ts'])).toEqual([
      '.github/workflows/web-edition-browsers.yml pull_request paths and the a11y area\'s patterns disagree on policy/x/y'])
  })

  it('unreadable: a workflow YAML that fails to parse makes the parity test fail naming the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-workflows-'))
    try {
      writeFileSync(join(dir, 'good.yml'), 'on: push\njobs: {}\n')
      writeFileSync(join(dir, 'broken.yml'), 'on: push\njobs:\n  a: [\n')
      expect(() => workflows(dir)).toThrow(/^\.github\/workflows\/broken\.yml cannot be parsed: /)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
