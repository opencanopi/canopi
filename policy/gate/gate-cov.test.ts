// The policy-gate project's coverage run (design check AR20, F9; canopi-f47t.52.240): child CLIs' V8 coverage laid over
// Vitest's map, through real V8 coverage of a real Node child, and the real CLI's `gate-cov` mode in a planted
// repository with a stand-in Vitest that writes the map it is given.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { belowFloors, childHits, gateCovPlan, inMeasure, overlay, ranIntervals, summary } from './gate-cov.mjs'
import { git, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

const FAMILY = 'policy/ratchets/coverage.json'
const family = (gate: unknown) => `${JSON.stringify({ family: 'coverage', floors: { vitest: { floors: { lines: 1 } },
  ...gate === undefined ? {} : { 'policy-gate': gate } } }, null, 2)}\n`

// A gate module: `used` is called by the child, `unused` never.
const DEMO = [
  'export function used(flag: boolean): number {',
  '  if (flag) return 1',
  '  return 2',
  '}',
  'export function unused(): number {',
  '  return 3',
  '}',
  'used(true)',
  '',
].join('\n')
const at = (line: number, column: number) => ({ line, column })
/** Vitest's map of DEMO as it reports a file no worker loaded: every count zero. */
const demoMap = (path: string) => ({
  [path]: {
    path,
    statementMap: { 0: { start: at(2, 2), end: at(2, 19) }, 1: { start: at(3, 2), end: at(3, 10) },
      2: { start: at(6, 2), end: at(6, 10) }, 3: { start: at(8, 0), end: at(8, 10) } },
    fnMap: { 0: { loc: { start: at(1, 44), end: at(4, 1) } }, 1: { loc: { start: at(5, 33), end: at(7, 1) } } },
    branchMap: { 0: { locations: [{ start: at(2, 12), end: at(2, 20) }, { start: {}, end: {} }] } },
    s: { 0: 0, 1: 0, 2: 0, 3: 0 }, f: { 0: 0, 1: 0 }, b: { 0: [0, 0] },
  },
})

describe('gate-cov: the children\'s V8 coverage over Vitest\'s map (canopi-f47t.52.240)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'canopi-gate-cov-test-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** NODE_V8_COVERAGE's process files from a real Node running `file` (type stripping on). */
  const covered = (file: string) => {
    const raw = mkdtempSync(join(root, 'raw-'))
    const run = spawnSync(process.execPath, [file], { env: { ...process.env, NODE_V8_COVERAGE: raw }, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    return readdirSync(raw).map((name) => JSON.parse(readFileSync(join(raw, name), 'utf8')) as { result: never[] })
  }

  it('canopi-f47t.52.240: a child\'s run statements, called function and taken arm count; the rest stays uncovered', () => {
    const path = join(root, 'policy/gate/demo.ts')
    mkdirSync(join(root, 'policy/gate'), { recursive: true })
    writeFileSync(path, DEMO)
    const hits = childHits(root, covered(path))
    expect([...hits.keys()]).toEqual(['policy/gate/demo.ts'])
    const map = overlay(root, demoMap(path), hits)
    const file = map[path]
    expect([file?.s, file?.f, file?.b]).toEqual([{ 0: 1, 1: 0, 2: 0, 3: 1 }, { 0: 1, 1: 0 }, { 0: [1, 0] }])
    expect(summary(map)).toEqual({ statements: 50, branches: 50, functions: 50, lines: 50 })
  })

  it('canopi-f47t.52.240: a planted copy counts for the repository\'s file; a changed copy or a Vitest process adds nothing', () => {
    mkdirSync(join(root, 'policy/gate'), { recursive: true })
    writeFileSync(join(root, 'policy/gate/demo.ts'), DEMO)
    const planted = join(root, 'planted/repo/policy/gate')
    mkdirSync(planted, { recursive: true })
    writeFileSync(join(planted, 'demo.ts'), DEMO)
    const processes = covered(join(planted, 'demo.ts'))
    expect([...childHits(root, processes).keys()]).toEqual(['policy/gate/demo.ts'])
    const asVitest = processes.map(({ result }) => ({ result: [...result, { url: 'file:///w/node_modules/vitest/dist/x.js', functions: [] }] }))
    expect(childHits(root, asVitest).size).toBe(0)
    writeFileSync(join(planted, 'demo.ts'), `${DEMO}used(false)\n`)
    expect(childHits(root, covered(join(planted, 'demo.ts'))).size).toBe(0)
  })

  it('canopi-f47t.52.240: the innermost range decides: a run function\'s unrun block is not a hit', () => {
    expect(ranIntervals([{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 10, endOffset: 20, count: 0 },
      { startOffset: 12, endOffset: 15, count: 2 }, { startOffset: 50, endOffset: 60, count: 0 }]))
      .toEqual([[0, 10], [12, 15], [20, 50], [60, 100]])
  })

  it('canopi-f47t.52.240: only the family\'s files count, and each floor above the merged value is named', () => {
    const plan = { include: ['policy/gate/**/*.{ts,mjs}'], exclude: ['policy/gate/**/*.test.ts'] }
    const entry = (path: string) => Object.entries(demoMap(path))[0] ?? [path, undefined as never]
    const map = Object.fromEntries([join(root, 'policy/gate/a.ts'), join(root, 'policy/gate/a.test.ts'),
      join(root, 'desktop/web/src/b.ts'), join(root, '../elsewhere/policy/gate/c.ts')].map(entry))
    expect(Object.keys(inMeasure(root, map, plan))).toEqual([join(root, 'policy/gate/a.ts')])
    expect(belowFloors({ statements: 90, branches: 80, functions: 95, lines: 91 }, { statements: 90, lines: 91.5 }))
      .toEqual([`policy-gate lines 91 is below its floor 91.5 (${FAMILY})`])
  })
})

// The stand-in Vitest: records its arguments, then writes `$COVERAGE_MAP` (a file whose statement ran) to the
// reportsDirectory it is given, sleeps under SHIM_SLOW_VITEST, and exits with $VITEST_EXIT.
const VITEST = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
appendFileSync(process.env.SHIM_LOG, 'vitest ' + process.argv.slice(2).join(' ') + ' v8=' + (process.env.NODE_V8_COVERAGE ? 'set' : 'unset') + '\\n')
const reports = process.argv.find((a) => a.startsWith('--coverage.reportsDirectory=')).split('=')[1]
mkdirSync(reports, { recursive: true })
writeFileSync(reports + '/coverage-final.json', process.env.COVERAGE_MAP ?? '{}')
if (process.env.SHIM_SLOW_VITEST) await new Promise((resolve) => setTimeout(resolve, 30_000))
process.exit(Number(process.env.VITEST_EXIT ?? 0))
`

describe('gate-cov: the real CLI judges the merged totals against the family (canopi-f47t.52.240)', () => {
  let repo: PlantedRepo
  beforeEach(() => {
    repo = new PlantedRepo({ packages: false })
    repo.write({ 'desktop/web/node_modules/vitest/vitest.mjs': VITEST, 'policy/gate/demo.ts': DEMO })
  })
  afterEach(() => repo.cleanup())

  const gate = { include: ['policy/gate/**/*.{ts,mjs}'], exclude: ['policy/gate/**/*.test.ts'] }
  const map = () => {
    const path = join(repo.repo, 'policy/gate/demo.ts')
    const one = demoMap(path)
    const file = one[path]
    if (file) file.s[3] = 1
    return JSON.stringify(one)
  }

  it('canopi-f47t.52.240: gate-cov runs the policy-gate project with NODE_V8_COVERAGE and passes at its floors', () => {
    repo.write({ [FAMILY]: family({ ...gate, floors: { statements: 25, lines: 25 } }) })
    const run = repo.gate(['gate-cov'], { env: { COVERAGE_MAP: map() } })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('gate: policy-gate coverage over 1 files: statements 25, branches 0, functions 0, lines 25')
    const [call] = repo.calls()
    expect(call).toMatch(/^vitest run --project policy-gate --maxWorkers=4 --coverage --coverage\.allowExternal --coverage\.reporter=json /)
    expect(call).toContain('--coverage.include=**/policy/gate/**/*.{ts,mjs} --coverage.exclude=**/policy/gate/**/*.test.ts')
    expect(call).toMatch(/--coverage\.thresholds\.statements=0 .*--coverage\.thresholds\.lines=0 v8=set$/)
  })

  it('canopi-f47t.52.240: gate-cov fails below a floor, naming it, and refuses a family without its floors', () => {
    repo.write({ [FAMILY]: family({ ...gate, floors: { statements: 25, functions: 10 } }) })
    const below = repo.gate(['gate-cov'], { env: { COVERAGE_MAP: map() } })
    expect(below.status).toBe(1)
    expect(below.stderr).toContain(`gate: policy-gate functions 0 is below its floor 10 (${FAMILY})`)
    repo.write({ [FAMILY]: family(undefined) })
    const refused = repo.gate(['gate-cov'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`${FAMILY} holds no policy-gate floor`)
    expect(repo.calls()).toHaveLength(1)
  })

  it('canopi-f47t.52.240: unreadable: a coverage map with none of the family\'s files is refused, not passed at 100', () => {
    repo.write({ [FAMILY]: family({ ...gate, floors: { statements: 25 } }) })
    const elsewhere = JSON.stringify(demoMap('/elsewhere/canopi/policy/gate/demo.ts'))
    for (const env of [{ COVERAGE_MAP: elsewhere }, {}] as Record<string, string>[]) {
      const run = repo.gate(['gate-cov'], { env })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('gate: policy-gate coverage measured none of the family\'s files')
    }
  })

  it('canopi-f47t.52.240: a failing Vitest run is the run\'s exit code, judged against no floor', () => {
    repo.write({ [FAMILY]: family({ ...gate, floors: { statements: 99 } }) })
    const run = repo.gate(['gate-cov'], { env: { COVERAGE_MAP: map(), VITEST_EXIT: '3' } })
    expect(run.status).toBe(3)
    expect(run.stderr).not.toContain('below its floor')
  })

  it('canopi-f47t.52.240: cancelled: an interrupted gate-cov exits 130 and leaves the tree unchanged', async () => {
    repo.write({ [FAMILY]: family({ ...gate, floors: { statements: 1 } }) })
    git(repo.repo, 'add', '-A')
    git(repo.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'family')
    expect(await repo.interrupted(['gate-cov'], { SHIM_SLOW_VITEST: '1' })).toBe(130)
    expect(git(repo.repo, 'status', '--porcelain')).toBe('')
  })
})

describe('gate-cov: the family is the floors\' one home (canopi-f47t.52.240)', () => {
  it('canopi-f47t.52.240: the repository\'s family holds the policy-gate floors and patterns gateCovPlan reads', () => {
    const plan = gateCovPlan(REPO_ROOT)
    expect(Object.keys(plan.floors).sort()).toEqual(['branches', 'functions', 'lines', 'statements'])
    expect(plan.include).toEqual(['policy/gate/**/*.{ts,mjs}'])
  })
})
