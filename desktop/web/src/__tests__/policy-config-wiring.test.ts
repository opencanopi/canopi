import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'
import { parse } from 'yaml'
import packageJson from '../../package.json'
import { projectsFor } from '../../playwright.config'

interface WorkflowStep { readonly id?: string, readonly name?: string, readonly run?: string }
interface WorkflowJob { readonly needs?: string | readonly string[], readonly if?: string, readonly steps?: readonly WorkflowStep[] }
interface Workflow { readonly jobs: Readonly<Record<string, WorkflowJob>> }

const workflow = (name: string) => parse(readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow

// A step runs `npm run <script>` when it names that exact script (`build` is not `build:web`); names are [\w:-].
const runsScript = (step: WorkflowStep, script: string) => new RegExp(`\\bnpm run ${script}(?![\\w:-])`).test(step.run ?? '')

/** What keeps Build & Test from being the one required check that every job's failure reaches (2.1-Q222, 2.1-M240). */
function buildAndTestFaults({ jobs }: Workflow): string[] {
  const faults: string[] = []
  const aggregate = jobs['build-and-test']
  if (!aggregate) return ['no build-and-test job']
  const needs = new Set([aggregate.needs ?? []].flat())
  for (const job of Object.keys(jobs)) {
    if (job !== 'build-and-test' && !needs.has(job)) faults.push(`build-and-test does not need ${job}`)
  }
  for (const job of needs) if (!(job in jobs) || job === 'build-and-test') faults.push(`build-and-test needs ${job}, no other job`)
  if (aggregate.if !== 'always()') faults.push('build-and-test does not run always()')
  const steps = jobs['test-frontend']?.steps ?? []
  const last = (script: string) => Math.max(-1, ...steps.flatMap((step, index) => (runsScript(step, script) ? [index] : [])))
  const bundle = steps.findIndex((step) => runsScript(step, 'test:policies:bundle'))
  if (bundle < 0) faults.push('test-frontend runs no test:policies:bundle')
  else if (bundle < last('build') || bundle < last('build:web')) faults.push('test-frontend checks bundle sizes before both builds')
  if (last('build') < 0 || last('build:web') < 0) faults.push('test-frontend does not build both editions')
  return faults
}

/** The workflow files whose PR-only change build.yml's changes job does not route to test-frontend. */
function unrunWorkflowFaults({ jobs }: Workflow, files: readonly string[]): string[] {
  const run = jobs.changes?.steps?.find((step) => step.id === 'diff')?.run ?? ''
  const pattern = /frontend_paths='([^']*)'/.exec(run)?.[1]
  if (pattern === undefined) return ['the changes job sets no frontend_paths']
  return files.map((file) => `.github/workflows/${file}`).filter((path) => !new RegExp(pattern).test(path))
    .map((path) => `a PR changing only ${path} skips test-frontend`)
}

// Where the policy families' values reach the tools that enforce them (2.1-M217).
describe('policy wiring', () => {
  it('runs vitest coverage over the include, exclusions and floors of policy/ratchets/coverage.json (2.1-M217)', async () => {
    vi.resetModules()
    const planted = { include: ['planted/**'], exclude: ['planted/x.ts'], floors: { statements: 1, branches: 2, functions: 3, lines: 4 } }
    vi.doMock('../../../../policy/ratchets/coverage.json', () => ({ default: { floors: { vitest: planted } } }))
    try {
      const { default: config } = await import('../../vite.config')
      const resolved = (typeof config === 'function' ? await config({ command: 'serve', mode: 'test' } as ConfigEnv) : config) as UserConfig
      expect(resolved.test?.coverage).toMatchObject({ include: planted.include, exclude: planted.exclude, thresholds: planted.floors })
    } finally {
      vi.doUnmock('../../../../policy/ratchets/coverage.json')
      vi.resetModules()
    }
  }, 60_000)

  it('makes Build & Test need every other job, run always, and check bundle sizes after both builds (2.1-Q222, 2.1-M240)', () => {
    expect(buildAndTestFaults(workflow('build.yml'))).toEqual([])

    const planted: Workflow = {
      jobs: {
        lint: {},
        late: {},
        'test-frontend': { steps: [{ run: 'npm run build' }, { run: 'npm run test:policies:bundle' }, { run: 'npm run build:web' }] },
        'build-and-test': { needs: ['lint', 'test-frontend'], if: 'success()' },
      },
    }
    expect(buildAndTestFaults(planted)).toEqual([
      'build-and-test does not need late',
      'build-and-test does not run always()',
      'test-frontend checks bundle sizes before both builds',
    ])
    expect(buildAndTestFaults({ jobs: { 'test-frontend': { steps: [{ run: 'npm run build:web' }] }, 'build-and-test': { needs: 'test-frontend', if: 'always()' } } }))
      .toEqual(['test-frontend runs no test:policies:bundle', 'test-frontend does not build both editions'])
  })

  // build.yml's changes job runs test-frontend on a PR only when a path matches frontend_paths, so a PR that edits only
  // a workflow this suite reads would merge with its guards unrun.
  it('runs this suite on a PR that changes only a workflow file it reads', () => {
    const read = [...new Set([...readFileSync(new URL(import.meta.url), 'utf8').matchAll(/'([\w-]+\.yml)'/g)].map((match) => match[1]!))]
    expect(read).toEqual(expect.arrayContaining(['build.yml', 'mutation.yml', 'performance.yml']))
    expect(unrunWorkflowFaults(workflow('build.yml'), read)).toEqual([])

    const planted: Workflow = { jobs: { changes: { steps: [{ id: 'diff', run: "frontend_paths='^desktop/web/|^\\.github/workflows/build\\.yml$'\n" }] } } }
    expect(unrunWorkflowFaults(planted, ['build.yml', 'mutation.yml'])).toEqual(['a PR changing only .github/workflows/mutation.yml skips test-frontend'])
  })

  // A lane is one command: CI calls the package script a person or a phase close runs, so the two never drift.
  it('runs the perf and mutation lanes through their package scripts, the same command locally and in CI (2.1-M240, 2.1-M60)', () => {
    const scripts: Record<string, string | undefined> = packageJson.scripts
    const steps = (name: string, job: string) => workflow(name).jobs[job]?.steps ?? []

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

  it('turns cargo-mutants\' missed mutants into annotations with their file and line', () => {
    write('mutants.out/missed.txt', 'core/src/lib.rs:12:5: replace f -> bool with true\ncore/src/lib.rs:20:9: delete ! in g\n')
    const result = run(script('cargo-mutants', 'Survivors to annotations and the step summary'), '.', { LABEL: 'cargo-mutants planted-core 1/1' })

    expect(result.status).toBe(0)
    expect(result.stdout.match(/^::warning .*$/gm)).toEqual(['::warning file=core/src/lib.rs,line=12,title=Mutant survived::replace f -> bool with true'])
    expect(result.summary).toContain('2 survivors')
    expect(result.summary).toContain('`core/src/lib.rs:20` delete ! in g')
  })
})
