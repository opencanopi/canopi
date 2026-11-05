// Every workflow against the gate's table (plan 1.0 as amended by design check A5, AR2, AR3, DR12; 2.1-Q262, 2.1-Q267):
// each step is a gate call, a setup action or a ci row (A5 (1)), each lane outside Build & Test runs on the triggers its
// row names and every area on a pull request (A5 (4)), only Build & Test and the lanes it calls run an area's row (4a,
// 4b), no two workflows share a concurrency group, and each job sets up the local gate's toolchain before its gate calls
// (A5 (5)). ci-parity.test.ts holds build.yml's own selection and the push parity; both read the workflows through
// workflows.ts, whose reader fails naming an unparsable file.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './planted-repo.ts'
import { TABLE, type Table } from './table.ts'
import {
  groupFaults, inlineFaults, readActions, readWorkflows, rowFaults, setupFaults, setupJobs, staleRowFaults, toolchain, triggerFaults,
  triggers, type Job, type Step, type Workflow,
} from './workflows.ts'

const real = readWorkflows(join(REPO_ROOT, '.github/workflows'))
const flow = (file: string): Workflow => real.get(file) ?? {}
const job = (file: string, name: string): Job => flow(file).jobs?.[name] ?? {}
/** `real` with `file`'s job `name` replaced by `with`. */
const withJob = (file: string, name: string, replaced: Job) =>
  new Map([...real, [file, { ...flow(file), jobs: { ...flow(file).jobs, [name]: replaced } }]])
const withTable = (ci: Table['ci'], checks: Partial<Table['checks']> = {}): Table =>
  ({ ...TABLE, ci: { ...TABLE.ci, ...ci }, checks: { ...TABLE.checks, ...checks } as Table['checks'] })
/** Whether a push-lane policy run builds the clippy families, which need the Linux dependencies. */
const CLIPPY = readdirSync(join(REPO_ROOT, 'policy/ratchets')).filter((name) => name.endsWith('.json'))
  .some((name) => (JSON.parse(readFileSync(join(REPO_ROOT, 'policy/ratchets', name), 'utf8')) as { tool?: string }).tool === 'clippy')

describe('every workflow is the table\'s (A5)', () => {
  it('canopi-f47t.52.228.54: every step of every workflow is a gate call or a ci_setup or ci_only row (A5 (1))', () => {
    expect([...real].flatMap(([file, workflow]) => inlineFaults(workflow, TABLE, file))).toEqual([])
    expect(staleRowFaults(real)).toEqual([])
    // The closed-bead check as the Commit gate ran it before it was a gate call.
    const gate = job('commit-gate.yml', 'gate')
    const inline = { ...gate, steps: [...gate.steps ?? [], { name: 'Closed beads', run: 'node policy/check.mjs --closed-beads' }] }
    expect(inlineFaults({ jobs: { gate: inline } }, TABLE, 'commit-gate.yml')).toEqual(['commit-gate.yml job gate step Closed beads runs '
      + '`node policy/check.mjs --closed-beads`, which is no gate call and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))'])
    // A lane of its own with no row: its every step is inline.
    const { 'performance.yml perf': _, ...rows } = TABLE.ci
    expect(inlineFaults(flow('performance.yml'), { ...TABLE, ci: rows }, 'performance.yml')).toContain('performance.yml job perf step '
      + 'Time the perf scenarios (five runs each) runs `npm run test:perf`, which is no gate call and no ci_setup or ci_only row in '
      + 'policy/gate/table.ts (A5 (1))')
    // A lane of its own whose steps are actions: each one no setup action is the table's or no gate's.
    const codeql: Workflow = { on: { pull_request: {}, schedule: [{ cron: '0 4 * * 1' }] }, jobs: {
      analyze: { steps: [{ uses: 'actions/checkout@v7' }, { name: 'Init', uses: 'github/codeql-action/init@v4' }, { uses: 'github/codeql-action/analyze@v4' }] },
      remote: { uses: 'octo/scans/.github/workflows/scan.yml@v1' } } }
    expect(inlineFaults(codeql, TABLE, 'codeql.yml')).toEqual([
      'codeql.yml job analyze step Init uses github/codeql-action/init@v4, which is no setup action and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))',
      'codeql.yml job analyze step (unnamed) uses github/codeql-action/analyze@v4, which is no setup action and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))',
      'codeql.yml job remote calls octo/scans/.github/workflows/scan.yml@v1, which is no lane Build & Test calls and no ci_only row in policy/gate/table.ts (A5 (1))'])
    // A row may name an action step: a lane's analysis held by its check.
    expect(inlineFaults(codeql, withTable({ 'codeql.yml analyze': { Init: 'advisories' }, 'codeql.yml remote': { '*': 'advisories' } }), 'codeql.yml'))
      .toEqual(['codeql.yml job analyze step (unnamed) uses github/codeql-action/analyze@v4, which is no setup action and no ci_setup or ci_only row in policy/gate/table.ts (A5 (1))'])
    expect(staleRowFaults(real, withTable({ 'gone.yml lane': { '*': 'perf' }, 'renamed': { '*': 'packaging' } })))
      .toEqual(['policy/gate/table.ts ci row gone.yml lane names a job no workflow has', 'policy/gate/table.ts ci row renamed names a job no workflow has'])
  })

  it('canopi-f47t.52.228.54: each lane outside Build & Test runs on the triggers its row names, and every area on a pull request (A5 (4))', () => {
    expect(triggerFaults(real)).toEqual([])
    // A trigger added to the workflow alone: the table no longer says when the lane runs.
    const seed = flow('seed-lane.yml')
    const pushed = new Map([...real, ['seed-lane.yml', { ...seed, on: { ...triggers(seed), push: { branches: ['main'] } } }]])
    expect(triggerFaults(pushed)).toEqual(['seed-lane.yml runs seed on pull_request, push, schedule, but policy/gate/table.ts\'s seed row says pull_request, schedule'])
    // An area's check moved to a workflow of its own runs on that workflow's triggers, not on every pull request's.
    const lidar = TABLE.areas.map((area) => (area.name === 'lidar' ? { ...area, full: [...area.full, 'perf'] } : area))
    expect(triggerFaults(real, { ...TABLE, areas: lidar })).toEqual(['perf is an area\'s check, run in a pull request\'s Build & Test, '
      + 'but performance.yml runs it on triggers of its own', 'perf is an area\'s CI-only lane that no job of a pull request\'s Build & Test runs'])
    // An area's CI-only lane no Build & Test job runs (the binding row missing from Build & Test).
    const build = flow('build.yml')
    const { 'lidar-native': __, ...jobs } = build.jobs ?? {}
    expect(triggerFaults(new Map([...real, ['build.yml', { ...build, jobs }]])))
      .toEqual(['lidar-native is an area\'s CI-only lane that no job of a pull request\'s Build & Test runs'])
    // Triggers on a lane Build & Test runs, a lane with none, and a row no workflow of its own runs.
    const planted = withTable({ 'seed-lane.yml frontend': { '*': 'mutation' } }, {
      'release-build': { ...TABLE.checks['release-build']!, on: ['pull_request'] }, 'perf': { ...TABLE.checks['perf']!, on: undefined },
      'stale': { command: 'CI workflow gone.yml', ciOnly: true, on: ['push'] } })
    expect(triggerFaults(real, planted).sort()).toEqual([
      'performance.yml runs perf on pull_request, push, workflow_dispatch of its own, and policy/gate/table.ts\'s perf row names no trigger',
      'policy/gate/table.ts\'s release-build row names triggers (pull_request), but release-candidate.yml runs it through Build & Test',
      'policy/gate/table.ts\'s stale row names triggers, but no workflow of its own runs it',
      'seed-lane.yml runs mutation on pull_request, schedule, but policy/gate/table.ts\'s mutation row says pull_request, push, workflow_dispatch',
    ])
  })

  it('canopi-f47t.52.228.54: only Build & Test and the lanes it calls run an area\'s row, in any workflow (4a, 4b)', () => {
    expect(rowFaults(real)).toEqual([])
    // A lane of its own running an area's row selects it by its own triggers and paths, a second copy of `gate areas`.
    const perf = job('performance.yml', 'perf')
    const copied = withJob('performance.yml', 'perf', { ...perf, steps: [...perf.steps ?? [], { run: 'node policy/gate/cli.mjs full --area frontend' }] })
    expect(rowFaults(copied)).toEqual(['performance.yml job perf runs the frontend row on triggers of its own: only Build & Test and the lanes it calls run an area\'s row'])
    // The same row by another way in: an area's check by id (one only its affected list or a check's runs name, as
    // cov runs cargo-test) or by its own command, the lanes that select rows, and a job calling a lane Build & Test
    // calls, which has no steps of its own.
    const ways = ['full --area docs --area scripts', 'full --print', 'check typecheck closed-beads', 'check cargo-test', 'oldest-engine', 'affected --base origin/main', 'push --base origin/main', 'areas --base x']
      .map((args): Step => ({ run: `node policy/gate/cli.mjs ${args}` }))
    const nightly: Workflow = { on: { schedule: [{ cron: '0 3 * * *' }] }, jobs: { browsers: { uses: './.github/workflows/web-edition-browsers.yml' } } }
    expect(rowFaults(new Map([...withJob('performance.yml', 'perf', { ...perf, steps: [...perf.steps ?? [], ...ways] }), ['nightly.yml', nightly]])))
      .toEqual(['performance.yml job perf runs the docs row on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs the scripts row on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs every area\'s row on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs typecheck, an area\'s check, on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs cargo-test, an area\'s check, on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs oldest-engine, an area\'s check, on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs the rows affected selects on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'performance.yml job perf runs the rows push selects on triggers of its own: only Build & Test and the lanes it calls run an area\'s row',
        'nightly.yml job browsers runs web-edition-browsers.yml, a lane Build & Test calls, on triggers of its own: only Build & Test and the lanes it calls run an area\'s row'])
    // A lane build.yml calls runs its area's row (the axe ratchet after the browsers).
    expect(JSON.stringify(job('web-edition-browsers.yml', 'a11y-policy').steps)).toContain('node policy/gate/cli.mjs full --area web-browsers')
  })

  it('canopi-f47t.52.228.54: no two workflows share a concurrency group, so none cancels another\'s run (shared group)', () => {
    expect(groupFaults(real)).toEqual([])
    const top = (name: string, group: string): Workflow => ({ name, on: { push: {} }, concurrency: { group } })
    const planted = new Map([['a.yml', top('Lane', '${{ github.workflow }}-${{ github.ref }}')], ['b.yml', top('Lane', '${{ github.workflow }}')],
      ['c.yml', top('C', 'cache-prune')], ['d.yml', top('D', 'cache-prune')], ['e.yml', top('E', '${{ github.workflow }}')]])
    expect(groupFaults(planted)).toEqual(['a.yml and b.yml are both named Lane and group by it: one\'s run would cancel the other\'s',
      'c.yml and d.yml share the concurrency group cache-prune: one lane\'s run would cancel the other\'s'])
  })

  it('canopi-f47t.52.228.11: each job of every workflow sets up the local gate\'s toolchain and what its gate calls need before them (A5 (5))', () => {
    const tools = toolchain(REPO_ROOT)
    expect(tools.node).toBe('24')
    expect(setupFaults(setupJobs(real, readActions(REPO_ROOT)), tools, CLIPPY)).toEqual([])
    const node = (version: number): Step => ({ uses: 'actions/setup-node@v7', with: { 'node-version': version } })
    const deps: Step = { uses: './.github/actions/install-linux-deps' }
    const npm: Step = { run: 'npm ci --prefix desktop/web --no-audit --no-fund' }
    const row = (area: string): Step => ({ name: `The ${area} row`, run: `node policy/gate/cli.mjs full --area ${area}` })
    const planted = new Map<string, { steps: Step[], cwd?: string }>([
      ['docs', { steps: [node(24), row('docs'), npm] }], ['late-deps', { steps: [node(24), npm, row('rust'), deps] }],
      ['rust', { steps: [deps, node(24), npm, row('rust')] }], ['shared-contracts', { steps: [node(24), row('shared-contracts')] }],
      ['changes', { steps: [{ run: 'node policy/gate/cli.mjs areas --base x' }] }],
      // The Commit gate's closed-bead check reads the policy core, whose glob engine is a desktop/web package.
      ['beads', { steps: [node(24), { name: 'Closed beads', run: 'node policy/gate/cli.mjs check closed-beads' }] }],
      // A job whose default working directory is desktop/web installs there with a bare npm ci.
      ['a11y', { steps: [node(24), { run: 'npm ci' }, row('web-browsers')], cwd: 'desktop/web' }],
      ['versions', { steps: [node(22), { uses: 'dtolnay/rust-toolchain@1.96.0' }, { uses: 'actions/setup-python@v7', with: { 'python-version': '3.12' } }] }],
    ])
    expect(setupFaults(planted, tools, true)).toEqual([
      'docs runs no npm ci in desktop/web before The docs row',
      'late-deps installs no Linux dependencies before The rust row\'s clippy families',
      'shared-contracts runs no npm ci in desktop/web before The shared-contracts row',
      'changes sets up no Node 24 before the gate',
      'beads runs no npm ci in desktop/web before Closed beads',
      'versions sets up Node 22, not the engines Node 24',
      `versions installs Rust 1.96.0, not rust-toolchain.toml's ${tools.rust}`,
      'versions sets up a Python not read from .python-version',
    ])
  })
})
