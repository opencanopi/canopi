// Selection parity between CI and the gate (plan 1.0 as amended by design check A5, AR2, AR3, AR22; 2.1-Q262,
// 2.1-Q267): build.yml's changes job selects only through `gate areas`, each area job runs when its own area is selected
// and runs that area's row, the lanes it calls (real app, browsers, updater) are selected the same way and bind through
// Build & Test, every build.yml or called step is a gate call or a ci row of the table (A5 (1)), CI runs a check for a
// path exactly when the pre-push lane does (A5 (3)), a called workflow's concurrency group is its own, and every workflow
// parses. Each rule is a fault function, run on the real workflows and on planted ones (the connections review's
// findings 4a and 4b, an inline command, a CI-only and a local-only check among them).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './planted-repo.ts'
import { areasJson, laneTests, planAffected, planFull, planPush } from './plan.ts'
import { CI_SETUP, display, TABLE, type Table } from './table.ts'
import {
  calledLanes, groupFaults, groupOf, inlineFaults, readActions, readWorkflows as workflows, triggers, type Job, type Step, type Workflow,
} from './workflows.ts'

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
  const row = table.areas.find((candidate) => candidate.name === area || (job.uses !== undefined && job.uses === `./${candidate.workflow}`))
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

/**
 * Each way a lane build.yml calls is not bound and selected as its area (design check AR3, A5 (2)): an area's workflow
 * not called by exactly one build.yml job, a called workflow no area names, one still triggered by a push or pull request
 * of its own (a second copy of the area's selection) or that cannot be called.
 */
function foldFaults(all: ReadonlyMap<string, Workflow>, table: Table = TABLE): string[] {
  const faults: string[] = []
  const calls = Object.entries(all.get('build.yml')?.jobs ?? {}).filter(([, job]) => job.uses !== undefined)
  for (const area of table.areas.filter((row) => row.workflow)) {
    const callers = calls.filter(([, job]) => job.uses === `./${area.workflow}`).map(([name]) => name)
    if (callers.length !== 1) faults.push(`build.yml calls ${area.workflow} from ${callers.length} jobs, not one, for the ${area.name} area`)
    const on = triggers(all.get((area.workflow ?? '').replace(/^\.github\/workflows\//, '')) ?? {})
    if (!('workflow_call' in on)) faults.push(`${area.workflow} cannot be called (no workflow_call) for the ${area.name} area`)
    for (const event of ['push', 'pull_request']) {
      if (event in on) faults.push(`${area.workflow} still runs on ${event} of its own: build.yml calls it for the ${area.name} area`)
    }
  }
  for (const [name, job] of calls) {
    if (!table.areas.some((area) => job.uses === `./${area.workflow}`)) faults.push(`build.yml job ${name} calls ${job.uses}, which no area's workflow names`)
  }
  return faults
}

/**
 * Each job of workflow `file` with no deadline (canopi-f47t.52.228.58: main's frontend job hung 6 h in apt): every job
 * it runs itself sets timeout-minutes; a job calling a workflow takes the called workflow's jobs' own.
 */
function timeoutFaults({ jobs = {} }: Workflow, file = 'build.yml'): string[] {
  return Object.entries(jobs).filter(([, job]) => job.uses === undefined && job['timeout-minutes'] === undefined)
    .map(([name]) => `${file} job ${name} sets no timeout-minutes: a hung step holds the runner for 6 h`)
}

/** One bounded apt-get call per line, retrying a mirror that drops: by the shared install's options array or inline. */
const APT = /^\s*timeout \d+m (?:\$?sudo )?apt-get (?:"\$\{apt\[@\]\}"|-o Acquire::Retries=[1-9]\d* -o Acquire::http::Timeout=\d+) (?:update|install)\b(?!.*\bapt(?:-get)?\b)/

/** Each line of `step` (of job or action `where`) calling apt that is not one APT call (canopi-f47t.52.228.58). */
function aptFaults(step: Step, where: string): string[] {
  return (step.run ?? '').split('\n').filter((line) => /\bapt(?:-get)? .*\b(?:update|install)\b/.test(line) && !APT.test(line))
    .map((line) => `${where} step ${step.name ?? step.id ?? '(unnamed)'} runs \`${line.trim()}\`, no one bounded apt-get call retrying a dropped mirror`)
}

/**
 * Each job of a lane build.yml calls that calls, in turn, another lane build.yml calls (the Release Candidate's updater
 * end-to-end lane) and still runs when its own workflow is called (failure state cancelled): both calls group under that
 * lane's literal name for one pull request, so one cancels the other, or a push run's waits behind it. A nested call
 * stays off in a call, by the caller's dry-run output.
 */
function nestedFaults(all: ReadonlyMap<string, Workflow>, table: Table = TABLE): string[] {
  const lanes = calledLanes(table)
  return lanes.flatMap((file) => Object.entries(all.get(file)?.jobs ?? {})
    .filter(([, job]) => job.uses !== undefined && lanes.includes(job.uses.replace(/^\.\/\.github\/workflows\//, '')))
    .filter(([, job]) => !/needs\.preflight\.outputs\.dry_run != 'true'/.test(job.if ?? ''))
    .map(([name, job]) => `${file} job ${name} calls ${job.uses} when Build & Test calls ${file}, which calls it too: the two share its group`))
}

/**
 * Each called lane a rerun would not rerun alone (failure state retried): GitHub's "Re-run failed jobs" reruns a failed
 * job and every job needing it, so a called lane needs only the changes job (whose outputs a rerun keeps) and only Build
 * & Test needs it, which then judges the rerun's result.
 */
function rerunFaults({ jobs = {} }: Workflow): string[] {
  const faults: string[] = []
  for (const [name, job] of Object.entries(jobs).filter(([, candidate]) => candidate.uses !== undefined)) {
    const needs = [job.needs ?? []].flat()
    if (needs.join() !== 'changes') faults.push(`build.yml job ${name} needs ${needs.join(', ') || 'nothing'}, not the changes job alone`)
    const dependents = Object.entries(jobs).filter(([, other]) => [other.needs ?? []].flat().includes(name)).map(([other]) => other)
    if (dependents.join() !== 'build-and-test') faults.push(`build.yml jobs ${dependents.join(', ')} need ${name}: a rerun of it would rerun them too`)
  }
  return faults
}

/** `condition` (an `if:` over the changes outputs: ==, != against a quoted value, always(), &&, ||, parentheses) for `outputs`
 * on a pull request from this repository (the fork guard's two terms); undefined when it reads anything else, which no
 * selection can judge. */
function holds(condition: string | undefined, outputs: ReadonlyMap<string, string>): boolean | undefined {
  if (condition === undefined) return true
  const text = condition.replace(/needs\.changes\.outputs\.(\w+)\s*(==|!=)\s*'([^']*)'/g,
    (_, name: string, op: string, value: string) => String(((outputs.get(name) ?? '') === value) === (op === '==')))
    .replace(/\balways\(\)/g, 'true').replace(/\bgithub\.event_name != 'pull_request'/g, 'false')
    .replace(/\bgithub\.event\.pull_request\.head\.repo\.full_name == github\.repository\b/g, 'true')
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
function ciChecks(build: Workflow, paths: readonly string[], table: Table = TABLE): { checks: Set<string>, called: Set<string>, faults: string[] } {
  const outputs = prOutputs(build, paths)
  const checks = new Set<string>()
  const called = new Set<string>()
  const faults: string[] = []
  for (const [name, job] of Object.entries(build.jobs ?? {})) {
    const rows = table.ci[name] ?? {}
    if (name === 'changes' || '*' in rows) continue
    const runs = holds(job.if, outputs)
    if (runs === undefined) faults.push(`build.yml job ${name}'s if reads more than the changes outputs: ${job.if}`)
    if (!runs) continue
    if (job.uses !== undefined) called.add(job.uses.slice(2))
    for (const step of job.steps ?? []) {
      const key = step.name ?? step.id ?? ''
      if (step.run === undefined || key in rows || holds(step.if, outputs) === false) continue
      for (const id of step.run.split('\n').flatMap((line) => lineChecks(line.trim(), table))) checks.add(id)
    }
  }
  return { checks, called, faults }
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
    // A called lane runs exactly when its area is selected, as the pre-push lane names its checks CI only.
    const lanes = new Set(plan.areas.flatMap((area) => (area.workflow ? [area.workflow] : [])))
    for (const flow of ci.called) if (!lanes.has(flow)) faults.push(`CI calls ${flow} for ${path}, whose area the change does not select`)
    for (const flow of lanes) if (!ci.called.has(flow)) faults.push(`the change selects the area of ${flow} for ${path}, which no CI job calls`)
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

/** The checks commit-gate.yml runs on a pull request (2.1-Q262): `check <id>...` gate calls, its `commit-gate pr` range
 * (the pre-push lane's commit-gate-pr) and table checks by command; a step whose `if` reads more than the event is a fault. */
function commitGateChecks({ jobs = {} }: Workflow, table: Table = TABLE): { checks: Set<string>, faults: string[] } {
  const checks = new Set<string>()
  const faults: string[] = []
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of (job.steps ?? []).filter((candidate) => candidate.run !== undefined)) {
      const on = { undefined: true, "github.event_name == 'pull_request'": true, "github.event_name == 'push'": false }[String(step.if)]
      if (on === undefined) faults.push(`commit-gate.yml job ${name} step ${step.name ?? '?'}'s if reads more than the event: ${step.if}`)
      if (!on) continue
      for (const line of (step.run ?? '').split('\n').map((text) => text.trim())) {
        const named = /^node policy\/gate\/cli\.mjs check ([a-z0-9 -]+)$/.exec(line)?.[1]
        const range = /^node policy\/gate\/cli\.mjs commit-gate pr /.test(line) ? ['commit-gate-pr'] : []
        for (const id of [...named?.split(' ') ?? [], ...range, ...lineChecks(line, table)]) checks.add(id)
      }
    }
  }
  return { checks, faults }
}

/** Each check commit-gate.yml runs that the pre-push lane for one of `changes` does not (2.1-Q262: the push lane is CI's
 * Linux mirror, the required Commit gate included). */
function commitGateFaults(flow: Workflow, changes: readonly (readonly string[])[], table: Table = TABLE): string[] {
  const ci = commitGateChecks(flow, table)
  return [...ci.faults, ...changes.flatMap((paths) => {
    const local = new Set(planPush(REPO_ROOT, paths, 'origin/main', process.env, table).checks.map((check) => check.id))
    return [...ci.checks].filter((id) => !local.has(id)).map((id) => `commit-gate.yml runs ${id} for ${paths.join(', ')}, which the pre-push lane does not`)
  })]
}

/** One single-path change per selection the table makes (each area, the lane tests, a docs-only and a beads-only one). */
const PROBES = ['desktop/src/lib.rs', 'desktop/src/db/x.rs', 'desktop/src/host/updater/x.rs', 'desktop/web/e2e/platform/updater.spec.ts',
  '.github/workflows/release-candidate.yml', 'scripts/release_smoke.py', 'desktop/src/services/lidar/x.rs', 'desktop/web/src/app/x.ts',
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
  else if (bundle < last('build:desktop:bundle') || bundle < last('build:web:bundle')) faults.push('the frontend row checks bundle sizes before both builds')
  if (last('build:desktop:bundle') < 0 || last('build:web:bundle') < 0) faults.push('the frontend row does not build both editions')
  return faults
}

const real = workflows(join(REPO_ROOT, '.github/workflows'))
const build = real.get('build.yml') ?? {}

/** The changes job's lines turning on the lanes build.yml calls, each by its own area. */
const FOLDED = 'if has real-app; then real_app=true; fi\nif has web-browsers; then web_browsers=true; fi\nif has updater; then updater=true; fi\n'
  + 'if has release-build; then release_build=true; fi\n'

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
      + 'if has workflows; then workflows=true; fi\n' + FOLDED
    expect(selectionFaults(withChanges(script))).toEqual(['build.yml changes step diff selects by path regex: only gate areas select (AR2)'])
  })

  it('canopi-f47t.52.228.54: an area job turned on by another area fails (connections review 4a)', () => {
    // 4a: web_rust_paths sent bootstrap.ts to the Rust job, whose row the tauri-command area (ipc/ only) never selects.
    const script = 'if has rust || has tauri-command; then rust=true; fi\nif has frontend; then frontend=true; fi\n'
      + 'if has policy-tooling; then policy=true; fi\nif has tauri-command; then tauri=true; fi\n'
      + 'if has shared-contracts; then contracts=true; fi\nif has species-catalog; then species=true; fi\nif has workflows; then workflows=true; fi\n' + FOLDED
    expect(selectionFaults(withChanges(script)))
      .toEqual(['build.yml job rust runs the rust row when tauri-command is selected, whose local lane runs no rust row'])
    const always = { ...build, jobs: { ...build.jobs, frontend: { ...build.jobs?.['frontend'], if: "needs.changes.outputs.code == 'true'" } } }
    expect(selectionFaults(always)).toContain('build.yml job frontend reads changes output code, which no area turns on')
  })

  it('canopi-f47t.52.228.54: a called workflow never shares its caller\'s concurrency group', () => {
    expect(groupFaults(real)).toEqual([])
    const planted = new Map<string, Workflow>([['called.yml', { on: { workflow_call: {} }, concurrency: { group: '${{ github.workflow }}-x' } }],
      ['own.yml', { on: { workflow_call: {} }, concurrency: { group: 'own-${{ github.run_id }}' } }], ['top.yml', { on: 'push', concurrency: '${{ github.workflow }}' }]])
    expect(groupFaults(planted)).toEqual(['called.yml is called by another workflow and groups by github.workflow, its caller\'s: the runs share a group'])
  })

  it('canopi-f47t.52.228.54: busy: each called lane groups under a literal name of its own, so no lane cancels another\'s run', () => {
    // A superseded PR run is cancelled by build.yml's group, its called lanes with it; a lane's own group, a literal
    // name, never waits on the caller's (cancelled) nor cancels another lane's run (busy).
    for (const area of TABLE.areas.filter((row) => row.workflow)) {
      const flow = real.get((area.workflow ?? '').replace(/^\.github\/workflows\//, '')) ?? {}
      expect(groupOf(flow), area.name).toMatch(/^[a-z][a-z0-9-]*-\$\{\{ /)
    }
    const called = (group: string): Workflow => ({ on: { workflow_call: {} }, concurrency: { group } })
    const planted = new Map<string, Workflow>([['a.yml', called('lane-${{ github.run_id }}')], ['b.yml', called('lane-${{ github.sha }}')],
      ['c.yml', called('${{ github.run_id }}')]])
    expect(groupFaults(planted)).toEqual(['a.yml and b.yml share the concurrency group lane: one lane\'s run would cancel the other\'s',
      'c.yml is called by another workflow and has no concurrency group named for itself'])
  })

  it('canopi-f47t.52.228.54: the real-app, browsers and updater lanes are called by build.yml for their own areas and bind through Build & Test (AR3)', () => {
    expect(foldFaults(real)).toEqual([])
    // The fold deleted each lane's own push and pull_request triggers: a lane triggered both ways runs twice, once
    // unbound by the ruleset (connections finding 3).
    const browsers = real.get('web-edition-browsers.yml') ?? {}
    const triggered = new Map([...real, ['web-edition-browsers.yml', { ...browsers, on: { ...triggers(browsers), pull_request: { paths: ['desktop/web/**'] } } }]])
    expect(foldFaults(triggered)).toEqual(['.github/workflows/web-edition-browsers.yml still runs on pull_request of its own: build.yml calls it for the web-browsers area'])
    const { ['real-app']: _, ...rest } = build.jobs ?? {}
    const unbound = new Map([...real, ['build.yml', { ...build, jobs: { ...rest, stray: { needs: 'changes', uses: './.github/workflows/phone-smoke.yml' } } }]])
    expect(foldFaults(unbound)).toEqual(['build.yml calls .github/workflows/desktop-real-app.yml from 0 jobs, not one, for the real-app area',
      'build.yml job stray calls ./.github/workflows/phone-smoke.yml, which no area\'s workflow names'])
    // The phone smokes stay out of the aggregate: no area names their workflow (AR3).
    expect(build.jobs?.['build-and-test']?.needs).not.toContain('phone-smoke')
    expect(TABLE.areas.map((area) => area.workflow)).not.toContain('.github/workflows/phone-smoke.yml')
  })

  it('canopi-f47t.52.228.54: a called lane runs exactly when its area is selected, as the area jobs do', () => {
    const updater = build.jobs?.['updater'] ?? {}
    // Selected by another area's output: CI would call the lane for paths whose area does not select it.
    const wide = { ...build, jobs: { ...build.jobs, updater: { ...updater, if: "needs.changes.outputs.rust == 'true'" } } }
    expect(selectionFaults(wide)).toEqual(['build.yml job updater runs the updater row when rust is selected, whose local lane runs no updater row'])
    expect(pushFaults(wide, ['desktop/src/services/lidar/x.rs'])).toEqual([
      'CI calls .github/workflows/updater-e2e.yml for desktop/src/services/lidar/x.rs, whose area the change does not select'])
    const always = { ...build, jobs: { ...build.jobs, updater: { ...updater, if: undefined } } }
    expect(selectionFaults(always)).toEqual(['build.yml job updater runs the updater row on every change: its if reads no area\'s changes output'])
    const { updater: _, ...rest } = build.jobs ?? {}
    expect(pushFaults({ ...build, jobs: rest }, ['desktop/src/host/updater/x.rs'])).toEqual([
      'the change selects the area of .github/workflows/updater-e2e.yml for desktop/src/host/updater/x.rs, which no CI job calls'])
  })

  it('canopi-f47t.52.228.58: every job of every workflow sets a deadline, and apt retries a dropped mirror within one', () => {
    // Build & Test's jobs, the lanes it calls (the release dry run's preflight among them) and every lane of its own: the
    // Commit gate's job is a required check, so a hung step there blocks every merge.
    expect([...real].flatMap(([file, flow]) => timeoutFaults(flow, file))).toEqual([])
    const commit = real.get('commit-gate.yml') ?? {}
    const endless = { ...commit, jobs: { ...commit.jobs, gate: { ...commit.jobs?.['gate'], 'timeout-minutes': undefined } } }
    expect(timeoutFaults(endless, 'commit-gate.yml')).toEqual(['commit-gate.yml job gate sets no timeout-minutes: a hung step holds the runner for 6 h'])
    const release = real.get('release-candidate.yml') ?? {}
    const { preflight } = release.jobs ?? {}
    const unbounded = { ...release, jobs: { ...release.jobs, preflight: { ...preflight, 'timeout-minutes': undefined } } }
    expect(timeoutFaults(unbounded, 'release-candidate.yml')).toEqual(['release-candidate.yml job preflight sets no timeout-minutes: a hung step holds the runner for 6 h'])
    const { changes } = build.jobs ?? {}
    const hung = { ...build, jobs: { ...build.jobs, changes: { ...changes, 'timeout-minutes': undefined } } }
    expect(timeoutFaults(hung)).toEqual(['build.yml job changes sets no timeout-minutes: a hung step holds the runner for 6 h'])
    // Every apt call of every workflow and composite action retries a mirror that drops and is bounded, so a stalled
    // mirror fails the step by name before the job's deadline: the shared install by its options array, each other inline.
    const steps = [...[...real].flatMap(([file, { jobs = {} }]) => Object.entries(jobs).flatMap(([name, { steps = [] }]) =>
      steps.map((step) => [`${file} job ${name}`, step] as const))), ...[...readActions(REPO_ROOT)].flatMap(([file, steps]) => steps.map((step) => [file, step] as const))]
    expect(steps.flatMap(([where, step]) => aptFaults(step, where))).toEqual([])
    expect(steps.filter(([, step]) => /\bapt-get\b/.test(step.run ?? '')).length).toBeGreaterThan(1)
    expect(readFileSync(join(REPO_ROOT, '.github/actions/install-linux-deps/action.yml'), 'utf8'))
      .toMatch(/^\s*apt=\(-o Acquire::Retries=[1-9]\d* -o Acquire::http::Timeout=\d+\)$/m)
    expect(aptFaults({ run: 'set -e\nsudo apt-get update && timeout 9m sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y xvfb\n'
      + 'timeout 9m sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y file\nsudo apt install -y dbus' }, 'probe.yml job verify')).toEqual([
      'probe.yml job verify step (unnamed) runs `sudo apt-get update && timeout 9m sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y xvfb`, '
        + 'no one bounded apt-get call retrying a dropped mirror',
      'probe.yml job verify step (unnamed) runs `sudo apt install -y dbus`, no one bounded apt-get call retrying a dropped mirror'])
  })

  it('cancelled: a superseded PR run cancels the release dry run, which shares no lane\'s group (canopi-f47t.52.228.61)', () => {
    // The dry run groups under its own literal name per pull request, cancelled by a newer run of the same PR, as the
    // other lanes are; a dispatch's group is its run's own, so a release candidate never waits on or cancels another.
    const release = real.get('release-candidate.yml') ?? {}
    expect(release.concurrency).toEqual({ group: 'release-candidate-${{ github.event.pull_request.number || github.run_id }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" })
    expect(groupFaults(real)).toEqual([])
    // Its own updater lane stays off in a call: Build & Test calls updater-e2e.yml for the updater area, and a second
    // call from the dry run would share updater-e2e's group for the PR, one run cancelling the other.
    expect(nestedFaults(real)).toEqual([])
    const nested = release.jobs?.['updater-end-to-end'] ?? {}
    const always = new Map([...real, ['release-candidate.yml', { ...release, jobs: { ...release.jobs,
      'updater-end-to-end': { ...nested, if: "needs.preflight.outputs.updater == 'true'" } } }]])
    expect(nestedFaults(always)).toEqual(['release-candidate.yml job updater-end-to-end calls ./.github/workflows/updater-e2e.yml when '
      + 'Build & Test calls release-candidate.yml, which calls it too: the two share its group'])
  })

  it('canopi-f47t.52.228.54: retried: rerunning a failed called lane reruns it and Build & Test only', () => {
    expect(rerunFaults(build)).toEqual([])
    const late = { ...build, jobs: { ...build.jobs, 'real-app': { ...build.jobs?.['real-app'], needs: ['changes', 'frontend'] },
      report: { needs: 'real-app', steps: [] } } }
    expect(rerunFaults(late)).toEqual(['build.yml job real-app needs changes, frontend, not the changes job alone',
      'build.yml jobs build-and-test, report need real-app: a rerun of it would rerun them too'])
  })

  it('canopi-f47t.52.228.54: every build.yml step is a gate call or a ci_setup or ci_only row (A5 (1))', () => {
    expect(inlineFaults(build)).toEqual([])
    // The lanes build.yml calls are held the same way, their rows keyed `<file> <job>`.
    expect(calledLanes().sort()).toEqual(['desktop-real-app.yml', 'release-candidate.yml', 'updater-e2e.yml', 'web-edition-browsers.yml'])
    for (const file of calledLanes()) expect(inlineFaults(real.get(file) ?? {}, TABLE, file), file).toEqual([])
    const policy = real.get('web-edition-browsers.yml') ?? {}
    const unnamed = { ...policy, jobs: { 'a11y-policy': { steps: [{ run: 'npm ci' }] } } }
    expect(inlineFaults(unnamed, TABLE, 'web-edition-browsers.yml')).toEqual([
      'web-edition-browsers.yml job a11y-policy step (unnamed) runs `npm ci`, which is no gate call and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))',
      'policy/gate/table.ts ci row web-edition-browsers.yml a11y-policy/Install frontend deps names no step that job runs',
      'policy/gate/table.ts ci row web-edition-browsers.yml a11y-policy/Trust the workspace for the planted cases names no step that job runs'])
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

  it('canopi-f47t.52.228.54: the pre-push lane runs every check the Commit gate runs; the other lanes check closed beads for any .beads/ change', () => {
    const commit = real.get('commit-gate.yml') ?? {}
    expect(commitGateChecks(commit)).toEqual({ checks: new Set(['closed-beads', 'commit-gate-pr']), faults: [] })
    const mixed = [['.beads/issues.jsonl', 'docs/a.md'], ['.beads/issues.jsonl', 'scripts/release_smoke.py']]
    expect(commitGateFaults(commit, [...PROBES.map((path) => [path]), ...mixed])).toEqual([])
    const gate = commit.jobs?.['gate'] ?? {}
    const extra = { ...commit, jobs: { gate: { ...gate, steps: [...gate.steps ?? [], { name: 'x', run: 'node policy/gate/cli.mjs check actionlint' }] } } }
    expect(commitGateFaults(extra, [['docs/a.md']])).toEqual(['commit-gate.yml runs actionlint for docs/a.md, which the pre-push lane does not'])
    // The commit and affected lanes run it for any .beads/ change, unless the whole policy check, which reads it too, runs.
    for (const paths of mixed) {
      for (const staged of [true, false]) {
        const ids = planAffected(REPO_ROOT, paths, staged, 'origin/main').checks.map((check) => check.id)
        expect(ids.includes('closed-beads') !== ids.includes('policy-check'), `${paths.join(', ')} staged ${staged}`).toBe(true)
      }
    }
  })

  // A PR changing only a workflow must run this suite, which reads every workflow, or it would merge with its guards
  // unrun (seam 10): the gate's lane tests hold the policy-gate project for a workflow change, and CI runs them when its
  // frontend job, whose coverage run holds them, is off (the A5 (3) case above holds that routing).
  it('canopi-f47t.52.228.10: a PR changing only a workflow runs this suite, and the lane tests run exactly when the frontend job is off', () => {
    const suite = '../../policy/gate/ci-parity.test.ts'
    for (const name of real.keys()) expect(laneTests(REPO_ROOT, [`.github/workflows/${name}`]), name).toContain(suite)
    // So must a change to a composite action or the release overlay, which the gate's suites read too (package-desktop).
    for (const path of ['.github/actions/package-desktop/action.yml', '.github/actions/package-desktop/fetch-db.sh', '.github/tauri-release-updater.json']) {
      expect(laneTests(REPO_ROOT, [path]), path).toContain('../../policy/gate/package-desktop.test.ts')
    }
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
    const row = ['npm run build:desktop:bundle', 'npm run build:web:bundle', 'npm run test:policies:bundle']
    const planted: Workflow = { jobs: { lint: {}, late: {}, frontend: {}, 'build-and-test': { needs: ['lint', 'frontend', 'gone'], if: 'success()', steps: failing } } }
    expect(buildAndTestFaults(planted, ['npm run build:desktop:bundle', 'npm run test:policies:bundle', 'npm run build:web:bundle'])).toEqual([
      'build-and-test does not need late',
      'build-and-test needs gone, no other job',
      'build-and-test does not run always()',
      'the frontend row checks bundle sizes before both builds',
    ])
    const aggregate = (steps?: Step[]): Workflow => ({ jobs: { frontend: {}, 'build-and-test': { needs: 'frontend', if: 'always()', steps } } })
    expect(buildAndTestFaults(aggregate(failing), ['npm run build:web:bundle']))
      .toEqual(['the frontend row runs no test:policies:bundle', 'the frontend row does not build both editions'])
    // Run always(), the aggregate is green unless a step fails on a failed or cancelled job.
    const noFail = ['build-and-test passes when a job it needs failed or was cancelled']
    expect(buildAndTestFaults(aggregate(failing), row)).toEqual([])
    expect(buildAndTestFaults(aggregate(), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: "contains(needs.*.result, 'failed') || contains(needs.*.result, 'cancelled')", run: 'exit 1' }]), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: "contains(needs.*.result, 'failure')", run: 'exit 1' }]), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: failing[0]!.if, run: 'exit 0' }]), row)).toEqual(noFail)
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
