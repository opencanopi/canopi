// The gate table (2.1-M198, 2.1-M201, 2.1-Q205, 2.1-Q267; canopi-f47t.52.228.10): its validator, each area's full run
// against its AGENTS.md row and its CI job, and the refusal of a malformed table before any plan is made.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { display, TABLE, tableFaults, type Check, type Table } from './table.ts'
import { cleanEnv, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')
const BUILD = '.github/workflows/build.yml'
const GATE_FULL = /node policy\/gate\/cli\.mjs full --area ([a-z-]+)/g
const checksOf = (ids: readonly string[] = []): Check[] => ids.map((id) => TABLE.checks[id]).filter((check) => check !== undefined)
const everyLane = (area: Table['areas'][number]) => [...area.full, ...area.affected ?? [], ...area.commit ?? []]

/** build.yml's jobs by name, each its body without comment lines (a job's comment heads the job before it). */
function jobs(workflow: string): Map<string, string> {
  const body = (workflow.split('\njobs:\n')[1] ?? '').replace(/^\s*#.*\n/gm, '')
  return new Map([...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm)]
    .map((match) => [match[1] ?? '', match[2] ?? '']))
}

describe('the table (canopi-f47t.52.228.10)', () => {
  it('canopi-f47t.52.228.10: areas are anchored regexes', () => {
    expect(tableFaults(TABLE)).toEqual([])
    const loose = { ...TABLE, areas: [{ ...TABLE.areas[0]!, patterns: ['desktop/**', '(unclosed'] }, ...TABLE.areas.slice(1)] }
    const faults = tableFaults(loose)
    expect(faults).toContain('policy/gate/table.ts: area rust pattern "desktop/**" is not anchored')
    expect(faults.join('\n')).toContain('area rust pattern "(unclosed" is no regex')
  })

  it('canopi-f47t.52.228.10: each row names exactly its checks', () => {
    const [rust] = TABLE.areas
    const twice = { ...TABLE, areas: [{ ...rust!, row: `${rust!.row}; \`{fmt}\`` }, ...TABLE.areas.slice(1)] }
    expect(tableFaults(twice)).toEqual(['policy/gate/table.ts: area rust row names {fmt} 2 times; a full check is named once'])
    const stranger = { ...TABLE, areas: [{ ...rust!, row: rust!.row.replace('{cov}', '{build}') }, ...TABLE.areas.slice(1)] }
    expect(tableFaults(stranger)).toEqual([
      'policy/gate/table.ts: area rust row names {build}, which is not one of its full checks',
      'policy/gate/table.ts: area rust row names {cov} 0 times; a full check is named once',
    ])
  })

  it('canopi-f47t.52.228.11: full emits the agents rows running the workspace tests once through cargo cov', () => {
    // cargo-llvm-cov runs every workspace test under instrumentation: `cargo test --workspace` beside it ran them twice.
    const run = spawnSync(process.execPath, ['policy/gate/cli.mjs', 'full', '--area', 'rust', '--print'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), CARGO_TARGET_DIR: 'target' },
    })
    expect(run.status, run.stderr).toBe(0)
    const plan = JSON.parse(run.stdout) as { checks: { id: string, command: string }[] }
    expect(plan.checks.map((check) => check.id)).toEqual(['fmt', 'clippy', 'cov', 'policies-push'])
    expect(plan.checks.map((check) => check.command)).not.toContain('CANOPI_SKIP_BUNDLED_DB=1 cargo test --workspace')
  })

  it('canopi-f47t.52.228.10: gates name package scripts and the one typecheck', () => {
    const commands = TABLE.areas.flatMap((area) => checksOf(everyLane(area))).map((check) => check.command)
    expect(commands.filter((command) => command.includes('check.mjs') && !command.includes('--closed-beads')),
      '2.1-M223: package scripts, never check.mjs flags').toEqual([])
    expect(commands.filter((command) => /\btsc\b/.test(command)), '2.1-Q205: npm run typecheck is the one typecheck').toEqual([])
    const rust = TABLE.areas.find((area) => area.name === 'rust')!
    expect(checksOf(rust.full).map(display)).toContain('cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push')
    expect(checksOf(rust.full).filter((check) => check.command.includes(' cargo ') && !check.cargo)).toEqual([])
  })

  it('canopi-f47t.52.228.11: the policy run builds its clippy families without the catalog db', () => {
    // The affected, Frontend and commit runs of test:policies build canopi-desktop for the clippy families; without the
    // bundled catalog DB (CI, a fresh worktree) desktop/build.rs refuses the missing resource unless
    // CANOPI_SKIP_BUNDLED_DB=1. The commit lane gets the same SKIP_DB but not the per-worktree target refusal: the hook
    // runs from any client (canopi-f47t.52.228.11).
    expect(TABLE.checks['policies']).toMatchObject({ command: 'CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies', cargo: true })
    const commit = new Set(TABLE.areas.flatMap((area) => checksOf(area.commit)).filter((check) => check.command.includes('test:policies')))
    expect([...commit].map((check) => check.command)).toEqual(['CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:commit'])
    expect([...commit].filter((check) => check.cargo), 'the commit lane never refuses a linked worktree\'s default target').toEqual([])
  })

  it('canopi-f47t.52.228: every cargo build of the desktop crate runs without the catalog db', () => {
    // A cargo build, test or coverage run of the workspace (and the policy runs, whose clippy families build
    // canopi-desktop) refuses a checkout with no bundled catalog DB unless CANOPI_SKIP_BUNDLED_DB=1. cargo fmt builds
    // nothing; bindings-gen does not depend on the desktop crate.
    const builds = Object.values(TABLE.checks).filter((check) => /^(\w+=\S+ )*cargo (?!fmt\b|run -p bindings-gen\b)/.test(check.command)
      || (check.command.includes('test:policies') && check.cargo))
    expect(builds.map((check) => check.command)).toContain('CANOPI_SKIP_BUNDLED_DB=1 cargo cov')
    expect(builds.filter((check) => !check.command.startsWith('CANOPI_SKIP_BUNDLED_DB=1 ')).map(display)).toEqual([])
  })

  it('canopi-f47t.52.228.10: the commit lane policy script skips only the check self-test', () => {
    const scripts = (JSON.parse(read('desktop/web/package.json')) as { scripts: Record<string, string> }).scripts
    const commit = scripts['test:policies:commit'] ?? ''
    expect(commit, '2.1-M201: the commit lane never runs check.mjs --self-test').not.toContain('check.mjs --self-test')
    expect(commit).toContain('node ../../policy/check.mjs')
    expect(commit).toContain('node ../../policy/generate.mjs --check')
    expect(scripts['test:policies'], 'the affected and full lanes keep the self-test').toContain('check.mjs --self-test')
    expect(commit, 'the commit lane drops only the check.mjs self-test')
      .toBe(scripts['test:policies']?.replace('node ../../policy/check.mjs --self-test && ', ''))
    const commitIds = TABLE.areas.flatMap((area) => area.commit ?? [])
    expect(TABLE.areas.find((area) => area.name === 'rust')?.commit).toContain('policies-commit')
    expect(commitIds).not.toContain('policies')
  })
})

describe('CI runs the table (canopi-f47t.52.228.11)', () => {
  const workflow = read(BUILD)
  const byJob = jobs(workflow)

  it('canopi-f47t.52.228.10: ci installs the actionlint the gate pins by version and checksum', () => {
    const job = byJob.get('actionlint') ?? ''
    expect(job).toContain(`ACTIONLINT_VERSION: "${TABLE.actionlint.version}"`)
    expect(job).toContain(`ACTIONLINT_SHA256: ${TABLE.actionlint.sha256}`)
    expect(job).toContain(TABLE.actionlint.url.replaceAll(TABLE.actionlint.version, '${ACTIONLINT_VERSION}'))
    expect(job).toContain('sha256sum --check --strict')
    expect(job).toContain('node policy/gate/cli.mjs actionlint')
    expect(read('.github/actionlint.yaml'), 'the runner-label config lists the Intel macOS runner build.yml uses')
      .toContain('- macos-15-intel')
  })

  it('canopi-f47t.52.228.11: each ci area job runs the gate table\'s full area command', () => {
    // OPEN item 16 of the Phase 0 hand-off (2.1-M198): CI's per-area jobs call the one gate table, so a local
    // `full --area <a>` is the command CI runs. An area all of whose checks another area's run already makes (coveredBy)
    // needs no job; a CI-only area names its lane, which must exist.
    const runs = new Map([...byJob].map(([job, body]) => [job, [...body.matchAll(GATE_FULL)].map((match) => match[1] ?? '')]))
    const ran = new Set([...runs.values()].flat())
    const ranChecks = new Set(TABLE.areas.filter((area) => ran.has(area.name))
      .flatMap((area) => area.full.flatMap((id) => [id, ...TABLE.checks[id]?.runs ?? []])))
    for (const area of TABLE.areas) {
      if (checksOf(area.full).every((check) => check.ciOnly)) {
        const lanes = checksOf(area.full).filter((check) => !check.prose).map((check) => check.shown ?? '')
        expect(lanes.some((lane) => byJob.has(lane) || existsSync(join(REPO_ROOT, '.github/workflows', lane))),
          `${area.name}: no CI lane named ${lanes.join(', ')}`).toBe(true)
        continue
      }
      if (area.coveredBy?.every((id) => ranChecks.has(id) && !area.full.includes(id))) {
        expect(ran.has(area.name), `${area.name}: covered by another area job, so no job of its own`).toBe(false)
        continue
      }
      const holders = [...runs].filter(([, areas]) => areas.includes(area.name)).map(([job]) => job)
      expect(holders, `${area.name}: one CI job runs \`full --area ${area.name}\``).toEqual([area.name])
      expect(runs.get(area.name), `${area.name}: one area per job`).toEqual([area.name])
    }
  })

  /** What a job lacks before its gate step for the row's checks to run on a bare runner: Node 24 for the gate itself
   * (a runner's default Node cannot strip types); desktop/web's packages for the policy core (the docs checker's rule
   * registry, every test:policies script); the Linux dependencies for the clippy families a policy run builds. */
  function setupFaults(byName: ReadonlyMap<string, string>, rows: ReadonlyMap<string, readonly string[]>): string[] {
    const clippy = readdirSync(join(REPO_ROOT, 'policy/ratchets')).filter((name) => name.endsWith('.json'))
      .some((name) => (JSON.parse(read(`policy/ratchets/${name}`)) as { tool?: string }).tool === 'clippy')
    const faults: string[] = []
    for (const [job, body] of byName) {
      const first = body.search(/node policy\/gate\/cli\.mjs /)
      if (first >= 0 && !/uses: actions\/setup-node@\S+\n\s+with:\n\s+node-version: 24\n/.test(body.slice(0, first))) {
        faults.push(`${job}: sets up no Node 24 before the gate`)
      }
      for (const match of body.matchAll(GATE_FULL)) {
        const area = match[1] ?? ''
        const before = body.slice(0, match.index)
        const checks = rows.get(area) ?? []
        if (checks.some((check) => check.includes('check_docs.py') || check.includes('test:policies'))
          && !before.includes('npm ci --prefix desktop/web')) faults.push(`${job}: runs no npm ci in desktop/web before the ${area} row`)
        if (clippy && checks.some((check) => check.includes('test:policies'))
          && !before.includes('uses: ./.github/actions/install-linux-deps')) {
          faults.push(`${job}: installs no Linux dependencies before the ${area} row's clippy families`)
        }
      }
    }
    return faults
  }

  it('canopi-f47t.52.228.11: each ci area job installs what its row needs before the row', () => {
    const rows = new Map(TABLE.areas.map((area) => [area.name, checksOf(area.full).map(display)]))
    expect(setupFaults(byJob, rows)).toEqual([])
    const node = '      - uses: actions/setup-node@v7\n        with:\n          node-version: 24\n'
    const row = (area: string) => `      - run: node policy/gate/cli.mjs full --area ${area}\n`
    const deps = '      - uses: ./.github/actions/install-linux-deps\n'
    const npm = '      - run: npm ci --prefix desktop/web --no-audit --no-fund\n'
    const planted = new Map([['docs', node + row('docs') + npm], ['frontend', node + npm + row('frontend') + deps],
      ['rust', deps + node + npm + row('rust')], ['changes', '      - run: node policy/gate/cli.mjs areas --base x\n']])
    const plantedRows = new Map([['docs', ['python3 scripts/check_docs.py']], ['frontend', ['cd desktop/web && npm run test:policies']],
      ['rust', ['CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push']]])
    expect(setupFaults(planted, plantedRows)).toEqual([
      'docs: runs no npm ci in desktop/web before the docs row',
      'frontend: installs no Linux dependencies before the frontend row\'s clippy families',
      'changes: sets up no Node 24 before the gate',
    ])
  })
})

describe('a malformed table (2.1-Q267)', () => {
  let repo: PlantedRepo
  beforeEach(() => { repo = new PlantedRepo() })
  afterEach(() => repo.cleanup())

  it('unreadable: a malformed table makes the CLI refuse naming the file, with no partial plan', () => {
    const file = join(repo.repo, 'policy/gate/table.ts')
    const sound = readFileSync(file, 'utf8')
    repo.stage('desktop/web/src/app/x.ts')
    writeFileSync(file, sound.replace("full: ['fmt', 'clippy', 'cov', 'policies-push']", "full: ['fmt', 'clippy', 'cov', 'policies-push', 'nope']"))
    for (const args of [['affected', '--base', repo.base, '--print'], ['full'], ['areas', '--base', repo.base]]) {
      const run = repo.gate(args)
      expect(run.status, args.join(' ')).toBe(1)
      expect(run.stdout, 'no partial plan').toBe('')
      expect(run.stderr).toContain('gate: policy/gate/table.ts: area rust full names nope, which is no check')
      expect(run.stderr).toContain('gate: the gate table is malformed: no plan was made; refusing')
    }
    writeFileSync(file, `${sound}\nexport const broken = {\n`)
    const run = repo.gate(['full', '--print'])
    expect([run.status, run.stdout]).toEqual([1, ''])
    expect(run.stderr).toContain('gate: policy/gate/table.ts or a module beside it cannot be loaded')
    expect(repo.calls()).toEqual([])
  })
})
