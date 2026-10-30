import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import coverageFamily from '../../../../policy/ratchets/coverage.json'
import packageJson from '../../package.json'
import { projectsFor } from '../../playwright.config'

interface WorkflowStep { readonly id?: string, readonly name?: string, readonly if?: string | undefined, readonly run?: string, readonly env?: Readonly<Record<string, string>> }
interface WorkflowJob {
  readonly needs?: string | readonly string[], readonly if?: string, readonly steps?: readonly WorkflowStep[] | undefined
  readonly 'timeout-minutes'?: number | string, readonly env?: Readonly<Record<string, string>>
}
interface Workflow { readonly jobs: Readonly<Record<string, WorkflowJob>>, readonly env?: Readonly<Record<string, string | number>> }

/** Every workflow this suite reads: workflow() takes no other, so the PR-routing test below covers each one. */
const WORKFLOWS_READ = ['build.yml', 'mutation.yml', 'performance.yml'] as const
type WorkflowName = typeof WORKFLOWS_READ[number]

const workflow = (name: WorkflowName) => parse(readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow

// A step runs `npm run <script>` when it names that exact script (`build` is not `build:web`); names are [\w:-].
const runsScript = (step: WorkflowStep, script: string) => new RegExp(`\\bnpm run ${script}(?![\\w:-])`).test(step.run ?? '')

/** What keeps Build & Test from being the one required check that every job's failure reaches (2.1-Q222, 2.1-M240);
 * `frontendRow` is the commands `gate.py full --area frontend` runs, in order, which the frontend job runs. */
function buildAndTestFaults({ jobs }: Workflow, frontendRow: readonly string[]): string[] {
  const faults: string[] = []
  const aggregate = jobs['build-and-test']
  if (!aggregate) return ['no build-and-test job']
  const needs = new Set([aggregate.needs ?? []].flat())
  for (const job of Object.keys(jobs)) {
    if (job !== 'build-and-test' && !needs.has(job)) faults.push(`build-and-test does not need ${job}`)
  }
  for (const job of needs) if (!(job in jobs) || job === 'build-and-test') faults.push(`build-and-test needs ${job}, no other job`)
  if (aggregate.if !== 'always()') faults.push('build-and-test does not run always()')
  const failsOn = (step: WorkflowStep, result: string) => (step.if ?? '').includes(`contains(needs.*.result, '${result}')`)
  if (!(aggregate.steps ?? []).some((step) => failsOn(step, 'failure') && failsOn(step, 'cancelled') && /^\s*exit [1-9]\d*\s*$/.test(step.run ?? ''))) {
    faults.push('build-and-test passes when a job it needs failed or was cancelled')
  }
  if (!(jobs.frontend?.steps ?? []).some((step) => /^\s*python3 scripts\/gate\.py full --area frontend\b/m.test(step.run ?? ''))) {
    faults.push('the frontend job does not run gate.py full --area frontend')
  }
  const steps = frontendRow.map((run) => ({ run }))
  const last = (script: string) => Math.max(-1, ...steps.flatMap((step, index) => (runsScript(step, script) ? [index] : [])))
  const bundle = steps.findIndex((step) => runsScript(step, 'test:policies:bundle'))
  if (bundle < 0) faults.push('the frontend row runs no test:policies:bundle')
  else if (bundle < last('build') || bundle < last('build:web')) faults.push('the frontend row checks bundle sizes before both builds')
  if (last('build') < 0 || last('build:web') < 0) faults.push('the frontend row does not build both editions')
  return faults
}

interface GateArea { readonly name: string, readonly patterns: readonly string[], readonly scans: readonly string[] }
interface GatePlan { readonly checks: readonly string[], readonly areas: readonly GateArea[] }

/** `gate.py full --area <area> --print`: the area's checks and every area, as CI's jobs and changes job read them. */
function gatePlan(area: string): GatePlan {
  // The frontend row's policy run builds through cargo, so a linked worktree's print names a target as its run would.
  const result = spawnSync('python3', ['scripts/gate.py', 'full', '--area', area, '--print'], {
    cwd: new URL('../../../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, CARGO_TARGET_DIR: process.env['CARGO_TARGET_DIR'] ?? 'target' },
  })
  if (result.status !== 0) throw new Error(`gate.py --print failed: ${result.stderr}`)
  return JSON.parse(result.stdout) as GatePlan
}

/** This file as gate.py names a vitest file, relative to desktop/web. */
const SUITE = new URL(import.meta.url).pathname.split('/desktop/web/')[1] ?? ''

/** `gate.lane_tests(paths)`: the vitest files gate.py's affected lane adds beside a change's area checks, which
 * build.yml's changes job names (`areas`' tests) for its lane-tests step when the frontend job does not run. */
function laneTests(path: string): string[] {
  const read = 'import json, sys; sys.path.insert(0, "scripts"); import gate; print(json.dumps(gate.lane_tests(sys.argv[1:])))'
  const result = spawnSync('python3', ['-c', read, path], { cwd: new URL('../../../../', import.meta.url), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`gate.lane_tests failed: ${result.stderr}`)
  return JSON.parse(result.stdout) as string[]
}

/** The changes outputs a condition joins with `separator`, each term matching `term`'s one group, sorted; undefined when
 * the condition is missing or holds any other term. */
function outputsJoined(condition: string | undefined, separator: string, term: RegExp): string[] | undefined {
  const names = (condition ?? '').split(separator).map((part) => term.exec(part)?.[1])
  return names.every((name): name is string => name !== undefined) ? [...new Set(names)].sort() : undefined
}

/** The workflow files whose PR-only change runs this suite nowhere: build.yml's frontend job runs it when gate.py's
 * frontend area matches a changed path; otherwise the changes job names gate.py's lane tests and a step runs them. */
function unrunWorkflowFaults({ jobs }: Workflow, areas: readonly GateArea[], files: readonly string[], lane: (path: string) => string[]): string[] {
  const run = jobs.changes?.steps?.find((step) => step.id === 'diff')?.run ?? ''
  const faults: string[] = []
  if (!/\bhas frontend\b[^\n]*\bfrontend=true\b/.test(run)) faults.push('the changes job does not route gate.py\'s frontend area to the frontend job')
  // The frontend job's coverage run holds the lane tests, so the changes job names them exactly when that job's `if`
  // is false: never unrun, never run twice.
  const frontendOn = outputsJoined(jobs.frontend?.if, '||', /^\s*needs\.changes\.outputs\.(\w+) == 'true'\s*$/)
  const laneOn = outputsJoined(/^\s*if (.+?); then tests="\$\(jq -r '\.tests \| join\(" "\)'/m.exec(run)?.[1], '&&', /^\s*\[ "\$(\w+)" = false \]\s*$/)
  if (!frontendOn || frontendOn.join() !== laneOn?.join() || !run.includes('echo "tests=$tests"')) {
    faults.push('the changes job does not name gate.py\'s lane tests exactly when the frontend job is off')
  }
  const runsLane = Object.values(jobs).some((job) => (job.steps ?? []).some((step) => step.if === "needs.changes.outputs.tests != ''"
    && step.env?.['TESTS'] === '${{ needs.changes.outputs.tests }}' && /^\s*npx vitest run\b[^\n]*\$TESTS\b/m.test(step.run ?? '')))
  if (!runsLane) faults.push('no step runs the lane tests the changes job names')
  if (faults.length) return faults
  const frontend = areas.find((area) => area.name === 'frontend')
  if (!frontend) return ['gate.py has no frontend area']
  return files.map((file) => `.github/workflows/${file}`)
    .filter((path) => !frontend.patterns.some((pattern) => new RegExp(pattern).test(path)) && !lane(path).includes(SUITE))
    .map((path) => `a PR changing only ${path} runs neither the frontend job nor this suite`)
}

// Where the policy families' values reach the tools that enforce them (2.1-M217).
describe('policy wiring', () => {
  it('runs vitest coverage over the include, exclusions and floors of policy/ratchets/coverage.json (2.1-M217)', async () => {
    vi.resetModules()
    const planted = { include: ['planted/**'], exclude: ['planted/x.ts'], floors: { statements: 1, branches: 2, functions: 3, lines: 4 } }
    vi.doMock('../../../../policy/ratchets/coverage.json', () => ({ default: { floors: { vitest: planted } } }))
    try {
      const { default: config } = await import('../../vite.config')
      const resolved = typeof config === 'function' ? await config({ command: 'serve', mode: 'test' }) : config
      expect(resolved.test?.coverage).toMatchObject({ include: planted.include, exclude: planted.exclude, thresholds: planted.floors })
    } finally {
      vi.doUnmock('../../../../policy/ratchets/coverage.json')
      vi.resetModules()
    }
  }, 60_000)

  it('holds the checked-in vitest coverage to the family as it stands, not to a copy (2.1-M217)', async () => {
    const { default: config } = await import('../../vite.config')
    const resolved = typeof config === 'function' ? await config({ command: 'serve', mode: 'test' }) : config
    const { include, exclude, floors } = coverageFamily.floors.vitest
    expect(resolved.test?.coverage).toMatchObject({ include, exclude, thresholds: floors })
  }, 60_000)

  it('makes Build & Test need every other job, run always, fail when one failed or was cancelled, and check bundle sizes after both builds (2.1-Q222, 2.1-M240)', () => {
    expect(buildAndTestFaults(workflow('build.yml'), gatePlan('frontend').checks)).toEqual([])
    const failing: WorkflowStep[] = [{ if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')", run: 'exit 1' }]
    const frontend = { steps: [{ run: 'set -o pipefail\npython3 scripts/gate.py full --area frontend 2>&1 | tee row.log' }] }
    const row = ['npm run build', 'npm run build:web', 'npm run test:policies:bundle']

    const planted: Workflow = {
      jobs: {
        lint: {},
        late: {},
        frontend,
        'build-and-test': { needs: ['lint', 'frontend'], if: 'success()', steps: failing },
      },
    }
    expect(buildAndTestFaults(planted, ['npm run build', 'npm run test:policies:bundle', 'npm run build:web'])).toEqual([
      'build-and-test does not need late',
      'build-and-test does not run always()',
      'the frontend row checks bundle sizes before both builds',
    ])
    expect(buildAndTestFaults({ jobs: { frontend: { steps: [{ run: 'npm run build:web' }] }, 'build-and-test': { needs: 'frontend', if: 'always()', steps: failing } } }, ['npm run build:web']))
      .toEqual(['the frontend job does not run gate.py full --area frontend', 'the frontend row runs no test:policies:bundle', 'the frontend row does not build both editions'])

    // Run always(), the aggregate is green unless a step fails on a failed or cancelled job.
    const aggregate = (steps?: WorkflowStep[]): Workflow => ({ jobs: { frontend, 'build-and-test': { needs: 'frontend', if: 'always()', steps } } })
    const noFail = ['build-and-test passes when a job it needs failed or was cancelled']
    expect(buildAndTestFaults(aggregate(failing), row)).toEqual([])
    expect(buildAndTestFaults(aggregate(), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: "contains(needs.*.result, 'failed') || contains(needs.*.result, 'cancelled')", run: 'exit 1' }]), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: "contains(needs.*.result, 'failure')", run: 'exit 1' }]), row)).toEqual(noFail)
    expect(buildAndTestFaults(aggregate([{ if: failing[0]!.if, run: 'exit 0' }]), row)).toEqual(noFail)
  })

  // build.yml's changes job runs the frontend job on a PR only when its `if` holds (gate.py's frontend or rust area
  // matches a changed path), and otherwise gate.py's lane tests, so a PR that edits only a workflow this suite reads
  // must name it among them, or it would merge with its guards unrun (seam 10).
  it('runs this suite on a PR that changes only a workflow file it reads, the lane tests named exactly when the frontend job is off (canopi-f47t.52.228.10)', () => {
    const read = [...WORKFLOWS_READ]
    expect(read).toEqual(expect.arrayContaining(['build.yml', 'mutation.yml', 'performance.yml']))
    expect(unrunWorkflowFaults(workflow('build.yml'), gatePlan('docs').areas, read, laneTests)).toEqual([])

    const laneLine = (condition: string) => `if ${condition}; then tests="$(jq -r '.tests | join(" ")' <<<"$sel")"; fi\n`
    const routedBy = (frontendIf: string, laneCondition: string) => ({ jobs: {
      changes: { steps: [{ id: 'diff', run: `if has frontend; then frontend=true; fi\n${laneLine(laneCondition)}echo "tests=$tests"\n` }] },
      frontend: { if: frontendIf },
      scripts: { steps: [{ if: "needs.changes.outputs.tests != ''", env: { TESTS: '${{ needs.changes.outputs.tests }}' }, run: 'npx vitest run --maxWorkers=4 $TESTS' }] },
    } })
    const bothOn = "needs.changes.outputs.rust == 'true' || needs.changes.outputs.frontend == 'true'"
    const bothOff = '[ "$rust" = false ] && [ "$frontend" = false ]'
    const narrow: GateArea[] = [{ name: 'frontend', patterns: ['^\\.github/workflows/build\\.yml$'], scans: [] }]
    const lane = (path: string) => (path.endsWith('performance.yml') ? [SUITE] : [])
    expect(unrunWorkflowFaults(routedBy(bothOn, bothOff), narrow, read, lane)).toEqual(['a PR changing only .github/workflows/mutation.yml runs neither the frontend job nor this suite'])
    expect(unrunWorkflowFaults(routedBy("needs.changes.outputs.frontend == 'true'", '[ "$frontend" = false ]'), narrow, read, lane))
      .toEqual(['a PR changing only .github/workflows/mutation.yml runs neither the frontend job nor this suite'])
    const notInverse = ['the changes job does not name gate.py\'s lane tests exactly when the frontend job is off']
    // A rust-only change runs no frontend job, and lane tests waiting on rust=false go unrun.
    expect(unrunWorkflowFaults(routedBy("needs.changes.outputs.frontend == 'true'", bothOff), narrow, read, lane)).toEqual(notInverse)
    // A rust-only change runs the frontend job's coverage, and lane tests named on frontend=false alone run twice.
    expect(unrunWorkflowFaults(routedBy(bothOn, '[ "$frontend" = false ]'), narrow, read, lane)).toEqual(notInverse)
    expect(unrunWorkflowFaults(routedBy(`${bothOn} || always()`, bothOff), narrow, read, lane)).toEqual(notInverse)
    expect(unrunWorkflowFaults({ jobs: { changes: { steps: [{ id: 'diff', run: 'frontend=false\n' }] } } }, narrow, read, lane)).toEqual([
      'the changes job does not route gate.py\'s frontend area to the frontend job',
      ...notInverse,
      'no step runs the lane tests the changes job names',
    ])
  })

  // A lane is one command: CI calls the package script a person or a phase close runs, so the two never drift.
  it('runs the perf and mutation lanes through their package scripts, the same command locally and in CI (2.1-M240, 2.1-M60)', () => {
    const scripts: Record<string, string | undefined> = packageJson.scripts
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
    const config = new URL('../../stryker.config.mjs', import.meta.url).href
    const { default: stryker } = await import(/* @vite-ignore */ config) as { default: { vitest?: { pool?: string } } }
    expect(stryker.vitest?.pool).toBe('forks')
    const steps = workflow('mutation.yml').jobs['stryker']?.steps ?? []
    const fonts = steps.findIndex((step) => runsScript(step, 'prepare:pdf-fonts'))
    const mutate = steps.findIndex((step) => runsScript(step, 'test:mutation'))
    const install = steps.findIndex((step) => /^\s*npm ci\b/m.test(step.run ?? ''))
    expect(fonts).toBeGreaterThan(install)
    expect(fonts).toBeLessThan(mutate)
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
    const config = new URL('../../stryker.config.mjs', import.meta.url).href
    const { default: stryker } = await import(/* @vite-ignore */ config) as { default: { dryRunTimeoutMinutes?: number } }
    expect(stryker.dryRunTimeoutMinutes).toBeGreaterThanOrEqual(15)
  })
})

