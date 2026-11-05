// The gate table (2.1-M198, 2.1-M201, 2.1-Q205, 2.1-Q267; canopi-f47t.52.228.10): its validator, each area's full run
// against its AGENTS.md row and its CI job, and the refusal of a malformed table before any plan is made.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type * as TS from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { display, POLICY_COMMIT, TABLE, tableFaults, type Check, type Table } from './table.ts'
import { cleanEnv, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')
const BUILD = '.github/workflows/build.yml'
const GATE_FULL = /node policy\/gate\/cli\.mjs full --area ([a-z0-9-]+)/g
const checksOf = (ids: readonly string[] = []): Check[] => ids.map((id) => TABLE.checks[id]).filter((check) => check !== undefined)
const everyLane = (area: Table['areas'][number]) => [...area.full, ...area.affected ?? [], ...area.commit ?? []]

/** The tsc projects a desktop/web command type-checks, each its tsconfig path from desktop/web, npm scripts expanded. */
function tscProjects(command: string): string[] {
  const { scripts } = JSON.parse(read('desktop/web/package.json')) as { scripts: Record<string, string> }
  const expand = (text: string): string => text.replace(/npm run ([\w:-]+)/g, (_run, name: string) => expand(scripts[name] ?? ''))
  return expand(command).split(/&&|;/).filter((part) => /\btsc\b/.test(part)).map((part) => {
    const project = [...part.matchAll(/(?:^|\s)(?:-p|--project)\s+(\S+)/g)].at(-1)?.[1] ?? '.'
    return project.endsWith('.json') ? project : join(project, 'tsconfig.json')
  })
}

/** build.yml's jobs by name, each its body without comment lines (a job's comment heads the job before it). */
function jobs(workflow: string): Map<string, string> {
  const body = (workflow.split('\njobs:\n')[1] ?? '').replace(/^\s*#.*\n/gm, '')
  return new Map([...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm)]
    .map((match) => [match[1] ?? '', match[2] ?? '']))
}

describe('the table (canopi-f47t.52.228.10)', () => {
  it('canopi-f47t.52.240: an area\'s affectedWhen names checks of its full row, each by anchored regexes', () => {
    // C9a review: affectedWhen adds a check to the affected lane, so a check outside the area's row or a loose pattern
    // would run where nothing names it, or for any path holding the text.
    const frontend = TABLE.areas.findIndex((area) => area.name === 'frontend')
    const planted = { ...TABLE, areas: TABLE.areas.map((area, index) => (index === frontend
      ? { ...area, affectedWhen: { notices: ['Cargo\\.lock', '(unclosed'], fmt: ['^x$'], nothing: ['^y$'] } } : area)) }
    const faults = tableFaults(planted)
    expect(faults).toContain('policy/gate/table.ts: area frontend affectedWhen notices pattern "Cargo\\\\.lock" is not anchored')
    expect(faults.join('\n')).toContain('area frontend affectedWhen notices pattern "(unclosed" is no regex')
    expect(faults).toContain('policy/gate/table.ts: area frontend affectedWhen names fmt, which is not one of its full checks')
    expect(faults).toContain('policy/gate/table.ts: area frontend affectedWhen names nothing, which is not one of its full checks')
  })

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

  it('canopi-f47t.52.228.54: a check\'s command pastes into a shell as the gate runs it, with no glob or quoting', () => {
    expect(TABLE.checks['script-tests']?.command).toBe('python3 -m unittest discover -s scripts')
    const globbed = { ...TABLE, checks: { ...TABLE.checks, 'docs': { command: "python3 -m unittest discover -p 'test_*.py'" } } }
    expect(tableFaults(globbed)).toEqual([
      'policy/gate/table.ts: check docs command holds shell syntax the gate never reads ("\'", "*"); a pasted row would differ',
    ])
    const lane = { ...TABLE, checks: { ...TABLE.checks, 'docs': { command: 'the comparison lane (docs/guides/data-library.md)', ciOnly: true } } }
    expect(tableFaults(lane), 'a CI-only check is prose, never run').toEqual([])
  })

  it('canopi-f47t.52.228.11: full emits the agents rows running the workspace tests once through cargo cov', () => {
    // cargo-llvm-cov runs every workspace test under instrumentation: `cargo test --workspace` beside it ran them twice.
    const run = spawnSync(process.execPath, ['policy/gate/cli.mjs', 'full', '--area', 'rust', '--print'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), CARGO_TARGET_DIR: 'target' },
    })
    expect(run.status, run.stderr).toBe(0)
    const plan = JSON.parse(run.stdout) as { checks: { id: string, command: string }[] }
    expect(plan.checks.map((check) => check.id)).toEqual(['cargo-locked', 'fmt', 'clippy', 'cov', 'policy-check-push'])
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

  it('canopi-f47t.52.240: the frontend row builds each edition\'s bundle after its typecheck, never type-checking again', () => {
    // DR17: `npm run build` and `npm run build:web` each ran the typecheck the row had just run.
    const { scripts } = JSON.parse(read('desktop/web/package.json')) as { scripts: Record<string, string> }
    const expand = (command: string): string => command.replace(/npm run ([\w:-]+)/g, (_run, name: string) => expand(scripts[name] ?? ''))
    const frontend = TABLE.areas.find((area) => area.name === 'frontend')!
    expect(checksOf(['build', 'build-web']).map((check) => check.command)).toEqual(['npm run build:desktop:bundle', 'npm run build:web:bundle'])
    expect(checksOf(['build', 'build-web']).filter((check) => /\btsc\b/.test(expand(check.command)))).toEqual([])
    expect(frontend.full.indexOf('typecheck')).toBeLessThan(frontend.full.indexOf('build'))
  })

  it('canopi-f47t.52.240: the frontend typecheck covers every TypeScript test the web Vitest project runs', () => {
    // Vitest strips types unchecked: a test outside every typecheck project passes any type drift.
    const ts = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('typescript') as typeof TS
    const web = join(REPO_ROOT, 'desktop/web')
    const checked = new Set(tscProjects(TABLE.checks['typecheck']!.command).flatMap((project) => {
      const config = ts.getParsedCommandLineOfConfigFile(resolve(web, project), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
      return (config?.fileNames ?? []).map((file) => resolve(file))
    }))
    expect(checked.size).toBeGreaterThan(0)
    const listed = spawnSync('git', ['ls-files', 'desktop/web'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.split('\n')
    const tests = listed.filter((file) => /\.(test|spec)\.tsx?$/.test(file) && !/^desktop\/web\/(e2e|e2e-release)\//.test(file))
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.filter((file) => !checked.has(resolve(REPO_ROOT, file)))).toEqual([])
  })

  it('canopi-f47t.52.228.11: the push-lane policy run builds its clippy families without the catalog db, the commit lane builds nothing', () => {
    // The push lane's clippy and cargo families build canopi-desktop; without the bundled catalog DB (CI, a fresh worktree)
    // desktop/build.rs refuses the missing resource unless CANOPI_SKIP_BUNDLED_DB=1. The commit lane's clippy families
    // read source only (canopi-f47t.52.228.54), so its policy checks need no cargo target and no SKIP_DB.
    for (const id of ['policy-check-push', 'policy-self-test-push']) {
      expect(TABLE.checks[id]?.command, id).toMatch(/^CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push/)
      expect(TABLE.checks[id]?.cargo, id).toBe(true)
    }
    const commit = new Set(TABLE.areas.flatMap((area) => checksOf(area.commit)).filter((check) => check.command.includes('test:policies')))
    expect([...commit].map((check) => check.command)).toEqual(POLICY_COMMIT.map((id) => TABLE.checks[id]?.command))
    expect([...commit].filter((check) => check.cargo || check.command.includes('SKIP_BUNDLED_DB')),
      'the commit lane never builds, so never refuses a linked worktree\'s default target').toEqual([])
  })

  it('canopi-f47t.52.240: the notices inputs hold desktop\'s manifest and each workspace member it depends on', () => {
    const inputs = (TABLE.areas.find((area) => area.name === 'frontend')?.affectedWhen?.['notices'] ?? []).map((p) => new RegExp(p))
    const members = [...readFileSync(join(REPO_ROOT, 'desktop/Cargo.toml'), 'utf8').matchAll(/path\s*=\s*"\.\.\/([^"]+)"/g)].map((m) => m[1])
    expect(members.length).toBeGreaterThan(0)
    for (const manifest of ['desktop/Cargo.toml', ...members.map((dir) => `${dir}/Cargo.toml`)]) {
      expect(inputs.some((input) => input.test(manifest)), manifest).toBe(true)
    }
  })

  it('canopi-f47t.52.228: every cargo build of the desktop crate runs without the catalog db', () => {
    // A cargo build, test or coverage run of the workspace (and the policy runs, whose clippy families build
    // canopi-desktop) refuses a checkout with no bundled catalog DB unless CANOPI_SKIP_BUNDLED_DB=1. cargo fmt and fetch
    // build nothing; bindings-gen does not depend on the desktop crate.
    const builds = Object.values(TABLE.checks).filter((check) => /^(\w+=\S+ )*cargo (?!fmt\b|fetch\b|run -p bindings-gen\b)/.test(check.command)
      || (check.command.includes('test:policies') && check.cargo) || check === TABLE.checks['cov'])
    expect(builds.map((check) => check.command)).toContain('CANOPI_SKIP_BUNDLED_DB=1 node policy/gate/cli.mjs cov')
    expect(builds.filter((check) => !check.command.startsWith('CANOPI_SKIP_BUNDLED_DB=1 ')).map(display)).toEqual([])
  })

  it('canopi-f47t.52.228.10: the commit lane runs the policy tooling without the check self-test, each script one command', () => {
    // Design check AR8 (amends 2.1-M223): each policy script is one checker or tool command, so the table names the
    // self-test apart from the check and lane-unrun credits the script it reads.
    const scripts = (JSON.parse(read('desktop/web/package.json')) as { scripts: Record<string, string> }).scripts
    const policy = Object.entries(scripts).filter(([name]) => name.startsWith('test:policies'))
    expect(policy.filter(([name, script]) => name !== 'test:policies:ast-grep' && /&&|\|\||[|;]/.test(script)), 'one command each').toEqual([])
    const commit = TABLE.areas.flatMap((area) => checksOf(area.commit)).map((check) => check.command)
    expect(commit.filter((command) => command.includes('self-test') && !command.includes('generate')),
      '2.1-M201: the commit lane never runs check.mjs --self-test').toEqual([])
    expect(scripts['test:policies:check']).toBe('node ../../policy/check.mjs')
    expect(TABLE.areas.find((area) => area.name === 'rust')?.commit).toEqual(['fmt', ...POLICY_COMMIT])
  })
})

describe('CI runs the table (canopi-f47t.52.228.11)', () => {
  const workflow = read(BUILD)
  const byJob = jobs(workflow)

  it('canopi-f47t.52.228.10: ci installs the actionlint the gate pins by version and checksum', () => {
    const job = byJob.get('workflows') ?? ''
    expect(job).toContain(`ACTIONLINT_VERSION: "${TABLE.actionlint.version}"`)
    expect(job).toContain(`ACTIONLINT_SHA256: ${TABLE.actionlint.sha256}`)
    expect(job).toContain(TABLE.actionlint.url.replaceAll(TABLE.actionlint.version, '${ACTIONLINT_VERSION}'))
    expect(job).toContain('sha256sum --check --strict')
    expect(job).toContain('node policy/gate/cli.mjs full --area workflows')
    expect(TABLE.areas.find((area) => area.name === 'workflows')?.full).toEqual(['actionlint'])
    expect(read('.github/actionlint.yaml'), 'the runner-label config lists the Intel macOS runner build.yml uses')
      .toContain('- macos-15-intel')
  })

  it('canopi-f47t.52.228.11: each ci area job runs the gate table\'s full area command', () => {
    // OPEN item 16 of the Phase 0 hand-off (2.1-M198): CI's per-area jobs call the one gate table, so a local
    // `full --area <a>` is the command CI runs; a CI-only area names its lane, which must exist. An area another area's
    // checks cover (coveredBy) still has its job, which the changes job turns on only by its own area (design check AR2).
    const runs = new Map([...byJob].map(([job, body]) => [job, [...body.matchAll(GATE_FULL)].map((match) => match[1] ?? '')]))
    const ran = new Set([...runs.values()].flat())
    for (const area of TABLE.areas) {
      if (area.workflow) {
        // A called lane runs its runnable checks through the gate; one of CI-only checks only is the workflow itself.
        const runnable = checksOf(area.full).some((check) => !check.ciOnly)
        expect([...read(area.workflow).matchAll(GATE_FULL)].map((match) => match[1]), `${area.name}: ${area.workflow} runs its row`)
          .toEqual(runnable ? [area.name] : [])
        expect(workflow, `${area.name}: build.yml calls ${area.workflow}`).toContain(`uses: ./${area.workflow}`)
        expect(ran.has(area.name), `${area.name}: its workflow runs it, no build.yml job`).toBe(false)
        continue
      }
      if (checksOf(area.full).every((check) => check.ciOnly)) {
        // A lane is a workflow file or a build.yml job, shown as `build.yml <job>` (a bare id reads as a rule id to the docs checker).
        const lanes = checksOf(area.full).filter((check) => !check.prose).map((check) => (check.shown ?? '').replace(/^build\.yml /, ''))
        expect(lanes.some((lane) => byJob.has(lane) || existsSync(join(REPO_ROOT, '.github/workflows', lane))),
          `${area.name}: no CI lane named ${lanes.join(', ')}`).toBe(true)
        continue
      }
      const holders = [...runs].filter(([, areas]) => areas.includes(area.name)).map(([job]) => job)
      expect(holders, `${area.name}: one CI job runs \`full --area ${area.name}\``).toEqual([area.name])
      expect(runs.get(area.name), `${area.name}: one area per job`).toEqual([area.name])
    }
  })
})

describe('a malformed table (2.1-Q267)', () => {
  let repo: PlantedRepo
  beforeEach(() => { repo = new PlantedRepo() })
  // A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
  afterEach(() => {
    repo?.cleanup()
    repo = undefined as never
  })

  it('unreadable: a malformed table makes the CLI refuse naming the file, with no partial plan', () => {
    const file = join(repo.repo, 'policy/gate/table.ts')
    const sound = readFileSync(file, 'utf8')
    repo.stage('desktop/web/src/app/x.ts')
    writeFileSync(file, sound.replace("full: ['cargo-locked', 'fmt', 'clippy', 'cov', ", "full: ['cargo-locked', 'fmt', 'clippy', 'cov', 'nope', "))
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

// The updater lane runs when its area is selected (build.yml's updater job, design check AR3): the area holds what decides
// whether an update installs (2.1-M64, M82), ported from scripts/test_release_smoke_lanes.py's trigger tests (2.1-Q267).
describe('the updater area (canopi-f47t.52.228)', () => {
  const updater = TABLE.areas.find((area) => area.name === 'updater')
  const selects = (path: string) => (updater?.patterns ?? []).some((pattern) => new RegExp(pattern).test(path))

  it('canopi-f47t.52.228: a change to a script the updater lane runs or to the Tauri versions selects the updater area', () => {
    // Every script the lane runs, and the lockfiles and manifest that pin the Tauri CLI (the .sig format, 2.1-M210) and
    // tauri-plugin-updater.
    const scripts = new Set([...read('.github/workflows/updater-e2e.yml').matchAll(/python3? (?:-I )?(scripts\/\w+\.py)/g)].map((match) => match[1]))
    expect([...scripts].sort()).toEqual(['scripts/release_smoke.py', 'scripts/update_channel.py'])
    for (const path of [...scripts, 'desktop/web/package-lock.json', 'Cargo.lock', 'desktop/Cargo.toml']) expect(selects(path ?? ''), path).toBe(true)
  })

  it('canopi-f47t.52.228: a change to a file the update flow goes through selects the updater area, on a pull request and on main', () => {
    // The files the update flow goes through outside the updater's own folders (Connections finding 1, Phase 0 close):
    // the shared update contract, the host's exit, operation, single-instance and launch paths, the app's close guard
    // and root, the About and Settings dialogs that own the selectors updater.spec.ts drives, and the release overlay.
    const flow = ['canopi-types/src/update.rs', 'desktop/src/host/exit.rs', 'desktop/src/native_operation.rs',
      'desktop/src/host/single_instance.rs', 'desktop/src/host/launch.rs', 'desktop/src/lib.rs',
      'desktop/web/src/app/shell/close-guard.ts', 'desktop/web/src/app.tsx', 'desktop/web/src/components/shared/AboutCanopiDialog.tsx',
      'desktop/web/src/components/shared/SettingsDialog.tsx', '.github/tauri-release-updater.json']
    expect(flow.filter((path) => !selects(path))).toEqual([])
    // Every selector updater.spec.ts drives is owned by a file the area selects.
    const spec = read('desktop/web/e2e/platform/updater.spec.ts')
    const sources = spawnSync('git', ['ls-files', 'desktop/web/src/*.tsx'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.split('\n')
      .filter((path) => path && !path.includes('/__tests__/'))
    for (const selector of ['data-about-updates', 'data-launch-check', 'data-update-failed-notice']) {
      expect(spec, selector).toContain(selector)
      const owners = sources.filter((path) => read(path).includes(selector))
      expect(owners.length, selector).toBeGreaterThan(0)
      expect(owners.filter((path) => !selects(path)), selector).toEqual([])
    }
    // A push to main selects the lane by its area too, so a merge that skipped it is still caught: the changes job turns
    // the updater output on by area outside its pull-request-only block.
    const diff = read(BUILD)
    const turnedOn = diff.indexOf('if has updater; then updater=true; fi')
    expect(turnedOn).toBeGreaterThan(0)
    expect(turnedOn).toBeLessThan(diff.indexOf('if [ "$PR_RUN" = true ]; then\n              rust=false'))
  })
})

// What only the Release Candidate's build reads (its workflow, the updater overlay, release_smoke.py repack-deb, the
// package-desktop action's release paths) selects the release-build area, whose full run is the Release Candidate's
// dry run (build.yml's release-build job, canopi-f47t.52.228.61), with the checks that read it: actionlint, the updater
// lane and the tests (test_release_smoke.py's repack-deb, package-desktop.test.ts's overlay and repack wiring). Never
// build.yml's every-platform packaging matrix, which reads none of the first three.
describe('the release build inputs (canopi-f47t.52.228.54)', () => {
  it('canopi-f47t.52.228.61: a release-only input selects the Release Candidate\'s dry run and the checks that read it, never every platform\'s packaging', () => {
    const selected = (path: string) => TABLE.areas.filter((area) => area.patterns.some((pattern) => new RegExp(pattern).test(path)))
      .map((area) => area.name)
    expect(selected('scripts/release_smoke.py')).toEqual(['release-build', 'updater', 'scripts'])
    expect(selected('.github/tauri-release-updater.json')).toEqual(['release-build', 'updater'])
    expect(selected('.github/workflows/release-candidate.yml')).toEqual(['rust', 'release-build', 'workflows'])
    const release = TABLE.areas.find((area) => area.name === 'release-build')
    expect([release?.workflow, release?.full]).toEqual(['.github/workflows/release-candidate.yml', ['release-build']])
    const scripts = read('scripts/test_release_smoke.py') + read('policy/gate/package-desktop.test.ts')
    for (const wired of ['repack_deb', 'tauri-release-updater.json', 'repack-deb']) expect(scripts, wired).toContain(wired)
    // The packaging matrix widens to every platform for a packaging input only; the dry run runs every platform itself.
    const changes = jobs(read(BUILD)).get('changes') ?? ''
    expect(changes).toContain('EVERY_PLATFORM: ${{ steps.diff.outputs.packaging }}')
    expect(changes).toContain('if has release-build; then release_build=true; fi')
  })

  it('canopi-f47t.52.228.61: a version bump, a channel or an updater key change runs the dry run on its own PR', () => {
    const selected = (path: string) => TABLE.areas.filter((area) => area.patterns.some((pattern) => new RegExp(pattern).test(path)))
      .map((area) => area.name)
    // tauri.conf.json is the version authority the dry run builds and holds the updater key a beta needs.
    expect(selected('desktop/tauri.conf.json')).toContain('release-build')
    // The policy checker's release-version refusal holds every manifest's version to it, and each manifest selects an
    // area whose CI run is that checker, so a bump that misses any of them (tauri.conf.json too) fails on the PR, not
    // the dispatch.
    const checker = /^policy-check(-push)?$/
    for (const manifest of ['desktop/tauri.conf.json', 'Cargo.toml', 'desktop/web/package.json', 'desktop/web/package-lock.json']) {
      const runs = TABLE.areas.filter((area) => selected(manifest).includes(area.name)).flatMap((area) => area.full)
      expect(runs.filter((id) => checker.test(id)), manifest).not.toEqual([])
    }
    // Dependency bumps never pay the four-platform release build.
    for (const dependencies of ['desktop/web/package-lock.json', 'Cargo.lock']) expect(selected(dependencies)).not.toContain('release-build')
  })

  it('canopi-f47t.52.228.61: a fork PR never runs the release dry run, as it packages nothing', () => {
    const job = jobs(read(BUILD)).get('release-build') ?? ''
    expect(job).toContain("needs.changes.outputs.release_build == 'true'")
    expect(job).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  })
})
