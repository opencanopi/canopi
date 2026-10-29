import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import coverageFamily from '../../../../policy/ratchets/coverage.json'
import packageJson from '../../package.json'
import { projectsFor } from '../../playwright.config'

interface WorkflowStep { readonly id?: string, readonly name?: string, readonly if?: string | undefined, readonly run?: string, readonly env?: Readonly<Record<string, string>> }
interface WorkflowJob { readonly needs?: string | readonly string[], readonly if?: string, readonly steps?: readonly WorkflowStep[] | undefined }
interface Workflow { readonly jobs: Readonly<Record<string, WorkflowJob>> }

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
  const result = spawnSync('python3', ['scripts/gate.py', 'full', '--area', area, '--print'], {
    cwd: new URL('../../../../', import.meta.url), encoding: 'utf8',
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

/** The workflow files whose PR-only change runs this suite nowhere: build.yml's frontend job runs it when gate.py's
 * frontend area matches a changed path; otherwise the changes job names gate.py's lane tests and a step runs them. */
function unrunWorkflowFaults({ jobs }: Workflow, areas: readonly GateArea[], files: readonly string[], lane: (path: string) => string[]): string[] {
  const run = jobs.changes?.steps?.find((step) => step.id === 'diff')?.run ?? ''
  const faults: string[] = []
  if (!/\bhas frontend\b[^\n]*\bfrontend=true\b/.test(run)) faults.push('the changes job does not route gate.py\'s frontend area to the frontend job')
  if (!/\btests="\$\(jq -r '\.tests \| join\(" "\)'/.test(run) || !run.includes('echo "tests=$tests"')) faults.push('the changes job does not name gate.py\'s lane tests')
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

  // build.yml's changes job runs the frontend job on a PR only when gate.py's frontend area matches a changed path, and
  // otherwise only gate.py's lane tests, so a PR that edits only a workflow this suite reads must name it among them, or
  // it would merge with its guards unrun (canopi-f47t.52.228.10, seam 10).
  it('runs this suite on a PR that changes only a workflow file it reads', () => {
    const read = [...WORKFLOWS_READ]
    expect(read).toEqual(expect.arrayContaining(['build.yml', 'mutation.yml', 'performance.yml']))
    expect(unrunWorkflowFaults(workflow('build.yml'), gatePlan('docs').areas, read, laneTests)).toEqual([])

    const routed = { jobs: {
      changes: { steps: [{ id: 'diff', run: 'if has frontend; then frontend=true; fi\ntests="$(jq -r \'.tests | join(" ")\' <<<"$sel")"\necho "tests=$tests"\n' }] },
      scripts: { steps: [{ if: "needs.changes.outputs.tests != ''", env: { TESTS: '${{ needs.changes.outputs.tests }}' }, run: 'npx vitest run --maxWorkers=4 $TESTS' }] },
    } }
    const narrow: GateArea[] = [{ name: 'frontend', patterns: ['^\\.github/workflows/build\\.yml$'], scans: [] }]
    const lane = (path: string) => (path.endsWith('performance.yml') ? [SUITE] : [])
    expect(unrunWorkflowFaults(routed, narrow, read, lane)).toEqual(['a PR changing only .github/workflows/mutation.yml runs neither the frontend job nor this suite'])
    expect(unrunWorkflowFaults({ jobs: { changes: { steps: [{ id: 'diff', run: 'frontend=false\n' }] } } }, narrow, read, lane)).toEqual([
      'the changes job does not route gate.py\'s frontend area to the frontend job',
      'the changes job does not name gate.py\'s lane tests',
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
  const env = { STRYKER_SHARDS: '4', AREA_RUST_SHARDS: '4', ANNOTATION_CAP: '1', SUMMARY_CAP: '500' }
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
      env: { ...process.env, ...env, ...extra, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary },
    })
    const output = Object.fromEntries(readFileSync(outputs, 'utf8').split('\n').filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, 'utf8'), output }
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
      expect(JSON.parse(crate.output.mutants ?? '')).toEqual(['1/4', '2/4', '3/4', '4/4'].map((shard) => ({ crate: 'planted-core', shard })))
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
})
