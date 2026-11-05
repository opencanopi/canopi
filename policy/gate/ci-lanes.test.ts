// The lanes outside Build & Test that CI runs on their own (the perf and mutation lanes; 2.1-M60, 2.1-M240, 2.1-Q15),
// read from their workflows, beside the gate whose parity suite reads every workflow: a change to a workflow alone selects
// this project's files (the table's policyGate rule; design check DR19, which moved these cases here from
// desktop/web/src/__tests__/policy-config-wiring.test.ts).
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { REPO_ROOT } from './planted-repo.ts'
import { holdsIf, interpolate } from './expression.ts'
import { filterSelects, groupOf, readWorkflows, triggers } from './workflows.ts'

/** desktop/web's YAML parser: policy/ has no packages of its own. */
const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml

interface WorkflowStep { readonly id?: string, readonly name?: string, readonly if?: string | undefined, readonly run?: string, readonly env?: Readonly<Record<string, string>> }
interface WorkflowJob {
  readonly needs?: string | readonly string[], readonly if?: string, readonly steps?: readonly WorkflowStep[] | undefined
  readonly 'timeout-minutes'?: number | string, readonly env?: Readonly<Record<string, string>>
}
interface Workflow { readonly jobs: Readonly<Record<string, WorkflowJob>>, readonly env?: Readonly<Record<string, string | number>> }
type WorkflowName = 'mutation.yml' | 'performance.yml'

const workflow = (name: WorkflowName) => parse(readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8')) as Workflow
const WEB_DIR = join(REPO_ROOT, 'desktop/web')
/** desktop/web's configs, loaded at run time by URL so the policy type check never compiles the web project's own. */
const webModule = async <T>(name: string) => await import(/* @vite-ignore */ pathToFileURL(join(WEB_DIR, name)).href) as T

// A step runs `npm run <script>` when it names that exact script (`build` is not `build:web`); names are [\w:-].
const runsScript = (step: WorkflowStep, script: string) => new RegExp(`\\bnpm run ${script}(?![\\w:-])`).test(step.run ?? '')

describe('the lanes\' commands', () => {
  // A lane is one command: CI calls the package script a person or a phase close runs, so the two never drift.
  it('runs the perf and mutation lanes through their package scripts, the same command locally and in CI (2.1-M240, 2.1-M60)', async () => {
    const { scripts } = JSON.parse(readFileSync(join(WEB_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string | undefined> }
    const { projectsFor } = await webModule<{ projectsFor: (argv: string[]) => { name: string }[] }>('playwright.config.ts')
    const steps = (name: WorkflowName, job: string) => workflow(name).jobs[job]?.steps ?? []

    expect(steps('performance.yml', 'perf').some((step) => runsScript(step, 'test:perf'))).toBe(true)
    const perf = (scripts['test:perf'] ?? '').split(/\s+/)
    expect(perf.slice(0, 2)).toEqual(['playwright', 'test'])
    expect(perf).toContain('e2e/perf')
    expect(projectsFor(['node', ...perf]).map((project) => project.name)).toContain('perf')

    expect(steps('mutation.yml', 'stryker').some((step) => runsScript(step, 'test:mutation'))).toBe(true)
    const mutation = (scripts['test:mutation'] ?? '').split(/\s+/)
    expect(mutation.slice(0, 2)).toEqual(['stryker', 'run'])
    expect(mutation).toContain('--incremental')
  })

  // Stryker's vitest runner overrides vite.config.ts's pool with its own default, threads, where the web-worker
  // polyfill reads itself as a worker; its dry run transforms the module graph before vitest's globalSetup writes the
  // PDF fonts, so their glob comes out empty. The lane writes the fonts first and runs vitest's forks (canopi-f47t.52.228).
  it('runs the Stryker lane in vitest forks with the PDF fonts written before it mutates (canopi-f47t.52.228)', async () => {
    const { default: stryker } = await webModule<{ default: { vitest?: { pool?: string } } }>('stryker.config.mjs')
    expect(stryker.vitest?.pool).toBe('forks')
    const steps = workflow('mutation.yml').jobs['stryker']?.steps ?? []
    const fonts = steps.findIndex((step) => runsScript(step, 'prepare:pdf-fonts'))
    const mutate = steps.findIndex((step) => runsScript(step, 'test:mutation'))
    const install = steps.findIndex((step) => /^\s*npm ci\b/m.test(step.run ?? ''))
    expect(fonts).toBeGreaterThan(install)
    expect(fonts).toBeLessThan(mutate)
  })
})

// The perf lane times the built Web Edition: main records every change's timings, and a pull request runs the lane only
// when it changes the lane itself, its scenarios, the fixture they open or how Playwright runs them (2.1-M344).
describe('perf lane triggers (canopi-f47t.52.240)', () => {
  const on = triggers(workflow('performance.yml'))

  it('runs on a pull request only for the lane\'s own files, and on every push to main that changes the Web Edition', () => {
    const own = ['.github/workflows/performance.yml', 'desktop/web/e2e/perf/timings.spec.ts', 'desktop/web/scripts/generate-large-fixture.mjs',
      'desktop/web/playwright.config.ts', 'desktop/web/package.json']
    for (const file of own) expect(filterSelects(on['pull_request'], file), file).toBe(true)
    for (const file of ['desktop/web/src/canvas/runtime/scene.ts', 'desktop/web/vite.config.ts', 'desktop/web/README.md']) {
      expect(filterSelects(on['pull_request'], file), file).toBe(false)
    }
    for (const file of [...own, 'desktop/web/src/canvas/runtime/scene.ts']) expect(filterSelects(on['push'], file), file).toBe(true)
    expect(filterSelects(on['push'], 'desktop/web/README.md')).toBe(false)
  })
})

// A diff run is read at review: when a pull request is opened or reopened ready for review or marked ready, and on every
// push while it carries the label `mutation`; main mutates every push (2.1-M344, the bead's "the last push before review
// or behind a label"). The workflow's own `if` and group are evaluated as the runner evaluates them.
describe('mutation lane triggers (canopi-f47t.52.240)', () => {
  const flow = readWorkflows(join(REPO_ROOT, '.github/workflows')).get('mutation.yml') ?? {}
  const on = triggers(flow) as { pull_request?: { types?: string[] } }
  const context = (eventName: string, event: Record<string, unknown> = {}) => ({
    github: { event_name: eventName, event, run_id: 900, workflow: 'Mutation', ref: 'refs/heads/main' }, inputs: { area: 'policy' } })
  const pr = (action: string, { labels = [] as string[], draft = false, label = undefined as string | undefined } = {}) =>
    context('pull_request', { action, ...(label ? { label: { name: label } } : {}),
      pull_request: { number: 12, draft, labels: labels.map((name) => ({ name })) } })
  /** Whether GitHub starts the workflow for `c` and its plan job runs, so the lane mutates. */
  const mutates = (c: ReturnType<typeof context>) => {
    const action = (c.github.event as { action?: string }).action
    if (c.github.event_name === 'pull_request' && !on.pull_request?.types?.includes(action ?? '')) return false
    return holdsIf(flow.jobs?.['plan']?.if, c)
  }
  const group = (c: ReturnType<typeof context>) => interpolate(groupOf(flow), c)
  const cancels = (c: ReturnType<typeof context>) => holdsIf(String((flow.concurrency as { 'cancel-in-progress'?: unknown })?.['cancel-in-progress']), c)

  it('mutates a pull request when it goes to review, and every push to main or dispatch', () => {
    expect([...on.pull_request?.types ?? []].sort()).toEqual(['labeled', 'opened', 'ready_for_review', 'reopened', 'synchronize'])
    for (const action of ['opened', 'reopened', 'ready_for_review']) expect(mutates(pr(action)), action).toBe(true)
    expect(mutates(pr('opened', { draft: true }))).toBe(false)
    expect(mutates(context('push', { before: 'abc' }))).toBe(true)
    expect(mutates(context('workflow_dispatch'))).toBe(true)
  })

  it('mutates a later push only while the pull request carries the label mutation', () => {
    expect(mutates(pr('synchronize'))).toBe(false)
    expect(mutates(pr('synchronize', { labels: ['bug'] }))).toBe(false)
    expect(mutates(pr('synchronize', { labels: ['bug', 'mutation'] }))).toBe(true)
    expect(mutates(pr('labeled', { labels: ['mutation'], label: 'mutation' }))).toBe(true)
    expect(mutates(pr('labeled', { labels: ['mutation', 'bug'], label: 'bug' }))).toBe(false)
  })

  it('retried: removing and re-adding the label mutation reruns the lane once', () => {
    const events = [pr('unlabeled', { label: 'mutation' }), pr('labeled', { labels: ['mutation'], label: 'mutation' })]
    expect(events.filter(mutates)).toHaveLength(1)
  })

  it('cancelled: a newer run of a pull request cancels its older one through the workflow\'s own group, and an event that mutates nothing cancels none', () => {
    const running = [pr('opened'), pr('synchronize', { labels: ['mutation'] }), pr('labeled', { labels: ['mutation'], label: 'mutation' })]
    expect(new Set(running.map(group))).toEqual(new Set(['Mutation-12']))
    for (const c of running) expect(cancels(c)).toBe(true)
    // A push without the label, another label or a draft opened start a run that mutates nothing: a group of its own.
    for (const idle of [pr('synchronize'), pr('labeled', { labels: ['mutation', 'bug'], label: 'bug' }), pr('opened', { draft: true })]) {
      expect(group(idle)).toBe('Mutation-900')
    }
    expect(group(context('workflow_dispatch'))).toBe('Mutation-900')
    expect(cancels(context('workflow_dispatch'))).toBe(false)
    expect(group(context('push'))).toBe('Mutation-refs/heads/main')
  })
})

// The mutation lane's own logic, run as the workflow runs it: each step's script from mutation.yml in bash, over a
// planted repository and planted reports (2.1-M60, 2.1-Q15). Bash, git, jq and python3 are on every runner this
// suite runs on (ubuntu) and on the workflow's own.
describe('mutation lane', () => {
  const mutation = workflow('mutation.yml')
  const script = (job: string, name: string) => {
    const run = mutation.jobs[job]?.steps?.find((step) => step.id === name || step.name === name)?.run
    if (!run) throw new Error(`mutation.yml has no ${job} step ${name}`)
    return run
  }
  const env = { STRYKER_SHARDS: '4', AREA_RUST_SHARDS: '4', MUTANTS_PER_SHARD: '40', MAX_RUST_SHARDS: '8', ANNOTATION_CAP: '1', SUMMARY_CAP: '500' }
  let dir = ''
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const run = (body: string, cwd: string, extra: Record<string, string>) => {
    const outputs = join(dir, 'github-output')
    const summary = join(dir, 'step-summary')
    writeFileSync(outputs, '')
    writeFileSync(summary, '')
    const result = spawnSync('bash', ['-e', '-c', body], {
      cwd: join(dir, cwd),
      encoding: 'utf8',
      env: { ...process.env, ...env, ...extra, PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, RUNNER_TEMP: dir,
        GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary },
    })
    const output = Object.fromEntries(readFileSync(outputs, 'utf8').split('\n').filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, 'utf8'), output }
  }
  /** A planted command on the steps' PATH: a bash body run with the step's arguments. */
  const fake = (name: string, body: string) => {
    write(`bin/${name}`, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(dir, 'bin', name), 0o755)
  }
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mutation-lane-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('plan', () => {
    beforeEach(() => {
      write('Cargo.toml', '[workspace]\nmembers = ["core"]\n')
      write('core/Cargo.toml', '[package]\nname = "planted-core"\n')
      write('core/src/lib.rs', 'pub fn f() {}\n')
      write('desktop/web/src/canvas/a.ts', 'export const a = 1\n')
      write('desktop/web/src/canvas/a.test.ts', '')
      write('desktop/web/src/canvas/__tests__/b.ts', '')
      write('desktop/web/e2e/c.spec.ts', '')
      write('docs/x.md', '')
      git('init', '-q')
      git('add', '.')
      git('commit', '-q', '-m', 'planted')
    })
    const plan = (area: string) => run(script('plan', 'plan'), '.', { EVENT: 'workflow_dispatch', AREA: area })

    it('mutates an area\'s application files with Stryker and its crate in every shard with cargo-mutants', () => {
      expect(plan('desktop/web/src/canvas/').output.stryker).toMatch(/^\[\{"shard":"[1-4]","mutate":"src\/canvas\/a\.ts"\}\]$/)
      const crate = plan('core')
      expect(crate.status).toBe(0)
      // cargo-mutants shards are 0-based: k/n with 0 <= k < n (canopi-f47t.52.228).
      expect(JSON.parse(crate.output.mutants ?? '')).toEqual(['0/4', '1/4', '2/4', '3/4'].map((shard) => ({ crate: 'planted-core', shard })))
      expect(crate.output.stryker).toBe('[]')
    })

    it('fails a manual run over an area with nothing to mutate, or no such path, instead of a green run that measured nothing', () => {
      for (const area of ['docs', 'desktop/web/e2e', 'desktop/web/src/canvas/__tests__', 'nowhere']) {
        const result = plan(area)
        expect(result.status, area).not.toBe(0)
        expect(result.stdout, area).toMatch(/^::error::/m)
      }
    })

    it('lets a diff with nothing to mutate pass, since the diff run is information', () => {
      const base = git('rev-parse', 'HEAD').stdout.trim()
      write('docs/x.md', 'changed\n')
      git('commit', '-q', '-am', 'docs only')
      const result = run(script('plan', 'plan'), '.', { EVENT: 'pull_request', PR_BASE: base, AREA: '', BEFORE: '' })
      expect(result.status).toBe(0)
      expect([result.output.stryker, result.output.mutants]).toEqual(['[]', '[]'])
    })

    // A PR run is information on a budget: a crate's diff shards come from its mutant count, so a large diff
    // (an integration PR's 400 canopi-desktop mutants) spreads over shards that each fit the job (canopi-f47t.52.228).
    describe('a diff run sizes each crate\'s shards from its mutant count', () => {
      const diffPlan = (listed: string) => {
        fake('cargo', `[ "$1 $2" = "mutants --list" ] || exit 64\n${listed}`)
        const base = git('rev-parse', 'HEAD').stdout.trim()
        write('core/src/lib.rs', 'pub fn f() -> bool { true }\n')
        git('commit', '-q', '-am', 'rust change')
        return run(script('plan', 'plan'), '.', { EVENT: 'pull_request', PR_BASE: base, AREA: '', BEFORE: '' })
      }
      const shards = (result: { output: Record<string, string> }) => (JSON.parse(result.output.mutants ?? '') as { shard: string }[]).map((m) => m.shard)

      it('gives a crate one shard per MUTANTS_PER_SHARD mutants its diff holds', () => {
        const result = diffPlan('for i in $(seq 90); do echo "core/src/lib.rs:1:1: replace f -> bool with false"; done')
        expect(result.status).toBe(0)
        expect(shards(result)).toEqual(['0/3', '1/3', '2/3'])
      })

      it('caps a crate at MAX_RUST_SHARDS, the job timeout keeping what the last shards reach', () => {
        expect(shards(diffPlan('seq 1000'))).toEqual(Array.from({ length: 8 }, (_, k) => `${k}/8`))
      })

      it('mutates no crate whose diff holds no mutant', () => {
        expect(diffPlan('true').output.mutants).toBe('[]')
      })

      it('gives a crate whose mutants cannot be listed every shard, with a warning, rather than failing the plan', () => {
        const result = diffPlan('exit 1')
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/^::warning::.*planted-core/m)
        expect(shards(result)).toHaveLength(8)
      })
    })
  })

  it('turns Stryker\'s survived and uncovered mutants into annotations up to the cap and lists all in the summary', () => {
    const mutant = (line: number, status: string) => ({ mutatorName: 'BooleanLiteral', replacement: 'false', status, location: { start: { line } } })
    write('desktop/web/node_modules/.cache/stryker/mutation.json', JSON.stringify({
      files: { 'src/canvas/a.ts': { mutants: [mutant(3, 'Survived'), mutant(4, 'Killed'), mutant(5, 'NoCoverage')] } },
    }))
    const result = run(script('stryker', 'Survivors to annotations and the step summary'), 'desktop/web', { LABEL: 'Stryker shard 1' })

    expect(result.status).toBe(0)
    expect(result.stdout.match(/^::warning .*$/gm)).toEqual(['::warning file=desktop/web/src/canvas/a.ts,line=3,title=Mutant survived::Survived BooleanLiteral: false'])
    expect(result.summary).toContain('2 survivors')
    expect(result.summary).toContain('`desktop/web/src/canvas/a.ts:5` NoCoverage BooleanLiteral: false')
    expect(result.summary).not.toContain(':4`')
  })

  it('says a Stryker shard left no report rather than reporting no survivors', () => {
    mkdirSync(join(dir, 'desktop/web'), { recursive: true })
    const result = run(script('stryker', 'Survivors to annotations and the step summary'), 'desktop/web', { LABEL: 'Stryker shard 1' })
    expect(result.summary).toMatch(/no report/)
    expect(result.summary).not.toMatch(/survivors/)
  })

  // A shard may hold no mutant (its files hash there, or a crate has fewer mutants than shards), so the whole run counts.
  describe('mutants measured', () => {
    const measured = () => run(script('measured', 'Count the mutants measured'), '.', { AREA: 'desktop/web/src/planted' })
    const stryker = (shard: number, mutants: number) => write(`reports/stryker-shard-${shard}/mutation.json`, JSON.stringify({
      files: { 'src/a.ts': { mutants: Array.from({ length: mutants }, () => ({ status: 'Killed' })) }, 'src/types.ts': { mutants: [] } },
    }))
    const cargo = (name: string, total: number) => write(`reports/${name}/outcomes.json`, JSON.stringify({ outcomes: [], total_mutants: total }))

    it('fails a manual area run whose reports hold no mutant, or that left no report, instead of reading as no survivors', () => {
      stryker(1, 0)
      stryker(2, 0)
      cargo('cargo-mutants-planted-core-0', 0)
      const empty = measured()
      expect(empty.status).not.toBe(0)
      expect(empty.stdout).toMatch(/^::error::/m)

      rmSync(join(dir, 'reports'), { recursive: true })
      mkdirSync(join(dir, 'reports'))
      expect(measured().status).not.toBe(0)
    })

    it('passes when any Stryker shard or cargo-mutants shard measured a mutant', () => {
      stryker(1, 0)
      stryker(2, 3)
      const web = measured()
      expect(web.status).toBe(0)
      expect(web.summary).toContain('3')

      rmSync(join(dir, 'reports'), { recursive: true })
      cargo('cargo-mutants-planted-core-1', 2)
      expect(measured().status).toBe(0)
    })
  })

  it('turns cargo-mutants\' missed mutants into annotations with their file and line', () => {
    write('mutants.out/missed.txt', 'core/src/lib.rs:12:5: replace f -> bool with true\ncore/src/lib.rs:20:9: delete ! in g\n')
    const result = run(script('cargo-mutants', 'Survivors to annotations and the step summary'), '.', { LABEL: 'cargo-mutants planted-core 1/1' })

    expect(result.status).toBe(0)
    expect(result.stdout.match(/^::warning .*$/gm)).toEqual(['::warning file=core/src/lib.rs,line=12,title=Mutant survived::replace f -> bool with true'])
    expect(result.summary).toContain('2 survivors')
    expect(result.summary).toContain('`core/src/lib.rs:20` delete ! in g')
  })

  it('plants the shard sizes the workflow sets', () => {
    for (const name of ['STRYKER_SHARDS', 'AREA_RUST_SHARDS', 'MUTANTS_PER_SHARD', 'MAX_RUST_SHARDS'] as const) {
      expect(String(mutation.env?.[name]), name).toBe(env[name])
    }
  })

  /** A planted tool that runs until SIGINT, then does `onInt` and exits as an interrupted process does (a background
   * job of a script ignores SIGINT, so the trap stops its sleep). */
  const interruptible = (onInt: string) => `sleep 30 </dev/null >/dev/null 2>&1 &\ntrap '${onInt}; kill $!; exit 130' INT\nwait`

  // cargo-mutants exits 2 when a mutant is missed and 3 when one timed out: information. GitHub runs a bash step with
  // -e, so the exit is captured with `|| rc=$?` before it can end the script (canopi-f47t.52.228).
  describe('cargo-mutants on a budget', () => {
    const mutate = (body: string, budget = '1m') => {
      fake('cargo', body)
      return run(script('cargo-mutants', 'Mutate'), '.', { EVENT: 'workflow_dispatch', AREA: 'core', BASE: '', CRATE: 'planted-core', SHARD: '0/1', BUDGET: budget })
    }

    it('reads missed and timed-out mutants as information, and a failing baseline as a failure', () => {
      expect(mutate('exit 2').status).toBe(0)
      expect(mutate('exit 3').status).toBe(0)
      expect(mutate('exit 0').status).toBe(0)
      expect(mutate('exit 4').status).toBe(4)
    })

    it('interrupts a run that outlives its budget and reports what it reached as information', () => {
      const result = mutate(interruptible(`touch ${join(dir, 'interrupted')}`), '1s')
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/^::notice::.*budget/m)
      expect(existsSync(join(dir, 'interrupted')), 'cargo-mutants got SIGINT, so it writes mutants.out as it stops').toBe(true)
    })
  })

  // A PR run of Stryker skips static mutants (24% of a diff's mutants, 95% of its time) and stops at its budget;
  // Stryker writes the partial incremental report on SIGINT, which then stands as the run's report.
  describe('Stryker on a budget', () => {
    const report = 'desktop/web/node_modules/.cache/stryker'
    const mutate = (event: string, body: string, budget = '1m') => {
      mkdirSync(join(dir, report), { recursive: true })
      fake('npm', `echo "$*" > "${join(dir, 'npm-args')}"\n${body}`)
      return run(script('stryker', 'Mutate'), 'desktop/web', { EVENT: event, MUTATE: 'src/a.ts', BUDGET: budget })
    }
    const partial = JSON.stringify({ files: { 'src/a.ts': { mutants: [{ status: 'Survived' }] } } })

    it('skips static mutants on a diff run and keeps them on a manual area run', () => {
      expect(mutate('pull_request', 'exit 0').status).toBe(0)
      expect(readFileSync(join(dir, 'npm-args'), 'utf8').trim()).toBe('run test:mutation -- --mutate src/a.ts --ignoreStatic')
      expect(mutate('workflow_dispatch', 'exit 0').status).toBe(0)
      expect(readFileSync(join(dir, 'npm-args'), 'utf8').trim()).toBe('run test:mutation -- --mutate src/a.ts')
      expect(mutate('pull_request', 'exit 1').status).toBe(1)
    })

    it('takes the partial incremental report as the report when the budget interrupts the run', () => {
      write(`${report}/incremental.json`, '{"files":{}}')
      write('partial.json', partial)
      const result = mutate('pull_request', interruptible(`cp ${join(dir, 'partial.json')} node_modules/.cache/stryker/incremental.json`), '1s')
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/^::notice::.*budget/m)
      expect(readFileSync(join(dir, report, 'mutation.json'), 'utf8').trim()).toBe(partial)
    })

    it('leaves no report when the interrupted run wrote no new incremental report, rather than the cached one', () => {
      write(`${report}/incremental.json`, '{"files":{}}')
      const result = mutate('pull_request', interruptible('true'), '1s')
      expect(result.status).toBe(0)
      expect(existsSync(join(dir, report, 'mutation.json'))).toBe(false)
    })
  })

  // Every mutation step stops inside its job, so the survivors and artifacts of a run cut short still report.
  it('runs each mutation step under a budget shorter than its job and reports survivors and artifacts always', () => {
    const minutes = (value: number | string | undefined, event: 'dispatch' | 'pr') => {
      const match = /'workflow_dispatch' && '?(\d+)m?'? \|\| '?(\d+)m?'?/.exec(String(value))
      if (!match) throw new Error(`no per-event value in ${String(value)}`)
      return Number(event === 'dispatch' ? match[1] : match[2])
    }
    for (const name of ['stryker', 'cargo-mutants']) {
      const job = mutation.jobs[name]
      const steps = job?.steps ?? []
      const step = steps.find((s) => s.name === 'Mutate')
      const killAfter = /timeout --signal=INT --kill-after=(\d+)m "\$BUDGET"/.exec(step?.run ?? '')
      expect(killAfter, `${name}: the Mutate step runs under timeout with SIGINT`).not.toBeNull()
      for (const event of ['dispatch', 'pr'] as const) {
        expect(minutes(job?.env?.['BUDGET'], event) + Number(killAfter?.[1]) + 5, `${name} ${event}`).toBeLessThanOrEqual(minutes(job?.['timeout-minutes'], event))
      }
      for (const s of steps.filter((s) => /^(Survivors|Upload)/.test(s.name ?? ''))) expect(s.if, `${name}: ${s.name}`).toBe('${{ always() }}')
    }
  })

  it('waits for the whole-suite dry run longer than Stryker\'s 5-minute default', async () => {
    const { default: stryker } = await webModule<{ default: { dryRunTimeoutMinutes?: number } }>('stryker.config.mjs')
    expect(stryker.dryRunTimeoutMinutes).toBeGreaterThanOrEqual(15)
  })
})
