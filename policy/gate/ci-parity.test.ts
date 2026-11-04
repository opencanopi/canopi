// Selection parity between CI and the gate (plan 1.0 as amended by design check A5, AR2; 2.1-Q262, 2.1-Q267): build.yml's
// changes job selects only through `gate areas`, each area job runs when its own area is selected and runs that area's
// row, a called workflow's concurrency group is its own, and every workflow parses. Each rule is a fault function, run
// on the real workflows and on planted ones (the connections review's findings 4a and 4b among them).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { REPO_ROOT } from './planted-repo.ts'
import { TABLE, type Table } from './table.ts'

/** desktop/web's YAML parser: policy/ has no packages of its own. */
const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml

interface Step { readonly id?: string, readonly name?: string, readonly run?: string }
interface Job { readonly if?: string, readonly needs?: string | readonly string[], readonly steps?: readonly Step[] }
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
    expect(selectionFaults(withChanges(script))).toEqual(['build.yml changes step diff selects by path regex: only gate areas select (AR2)'])
  })

  it('canopi-f47t.52.228.54: an area job turned on by another area fails (connections review 4a)', () => {
    // 4a: web_rust_paths sent bootstrap.ts to the Rust job, whose row the tauri-command area (ipc/ only) never selects.
    const script = 'if has rust || has tauri-command; then rust=true; fi\nif has frontend; then frontend=true; fi\n'
      + 'if has policy-tooling; then policy=true; fi\nif has tauri-command; then tauri=true; fi\n'
      + 'if has shared-contracts; then contracts=true; fi\nif has species-catalog; then species=true; fi\n'
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
