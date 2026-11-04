// Running a plan (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q267; canopi-f47t.52.228.10): the real CLI in a planted repository,
// its npm, npx, cargo and docker calls recorded by PATH shims; real `git commit` runs for the hook's index.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execute } from './run.ts'
import { TABLE } from './table.ts'
import { cleanEnv, git, PLANTED_IMAGE, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

let repo: PlantedRepo
beforeEach(() => { repo = new PlantedRepo() })
afterEach(() => repo.cleanup())

const TYPECHECK = 'cd desktop/web && npm run typecheck'

describe('commit modes: git hands the hook the index it commits (canopi-f47t.52.228.10)', () => {
  const committedChecks = (...commitArgs: string[]) => {
    const hook = join(repo.repo, '.git/hooks/pre-commit')
    writeFileSync(hook, `#!/bin/sh\n'${process.execPath}' policy/gate/cli.mjs affected --staged --print > ../printed.json\n`)
    chmodSync(hook, 0o755)
    const run = spawnSync('git', ['commit', '-q', '-m', 'x', ...commitArgs], { cwd: repo.repo, encoding: 'utf8', env: repo.env() })
    expect(run.status, run.stderr).toBe(0)
    return (JSON.parse(readFileSync(join(repo.root, 'printed.json'), 'utf8')) as { checks: { command: string }[] }).checks
      .map((check) => check.command)
  }

  it('canopi-f47t.52.228.10: commit -a judges the index git commits', () => {
    writeFileSync(join(repo.repo, 'desktop/web/src/app/x.ts'), 'export const x = 2\n')
    expect(committedChecks('-a')).toContain(TYPECHECK)
  })

  it('canopi-f47t.52.228.10: a pathspec commit judges the index git commits', () => {
    writeFileSync(join(repo.repo, 'desktop/web/src/app/x.ts'), 'export const x = 2\n')
    expect(committedChecks('desktop/web/src/app/x.ts')).toContain(TYPECHECK)
  })
})

describe('running (canopi-f47t.52.228.10)', () => {
  it('canopi-f47t.52.228.10: the commit lane runs npm offline', () => {
    repo.stage('desktop/web/src/app/x.ts')
    const run = repo.gate(['affected', '--staged'])
    expect(run.status, run.stderr).toBe(0)
    expect(repo.calls()).toEqual(['npm run typecheck offline=true'])
  })

  it('cancelled: SIGINT during full stops the remaining checks and the summary marks the run not green', async () => {
    const child = spawn(process.execPath, ['policy/gate/cli.mjs', 'full', '--area', 'frontend'], {
      cwd: repo.repo, env: repo.env({ SHIM_SLOW_NPM: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    const deadline = Date.now() + 20_000
    while (!repo.calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    const before = git(repo.repo, 'status', '--porcelain', '--ignored')
    child.kill('SIGINT')
    expect(await exited, stderr).toBe(130)
    expect(stderr).toContain('NOT GREEN: interrupted; 0 passed, 0 failed, the rest not run; nothing was written')
    expect(repo.calls(), 'the check SIGINT stopped was the last to start').toEqual(['npm run typecheck offline=unset'])
    expect(git(repo.repo, 'status', '--porcelain', '--ignored')).toBe(before)
  })

  it('canopi-f47t.52.228.54: cancelled: an interrupted run with --log-dir writes durations marking the cancelled check not run', async () => {
    // A14: quiet-gates reads each check's duration and outcome from the gate, never from its own copy of the list.
    const logs = join(repo.root, 'logs')
    const child = spawn(process.execPath, ['policy/gate/cli.mjs', 'full', '--area', 'frontend', '--log-dir', logs], {
      cwd: repo.repo, env: repo.env({ SHIM_SLOW_NPM: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    const deadline = Date.now() + 20_000
    while (!repo.calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    child.kill('SIGINT')
    expect(await exited).toBe(130)
    const durations = JSON.parse(readFileSync(join(logs, 'durations.json'), 'utf8')) as { id: string, outcome: string, seconds: number | null }[]
    expect(durations[0]).toMatchObject({ id: 'typecheck', outcome: 'not run' })
    expect(durations.every((entry) => entry.outcome === 'not run')).toBe(true)
    expect(durations.map((entry) => entry.id)).toEqual(repo.printed(['full', '--area', 'frontend']).checks.map((check) => check.id))
  })

  it('canopi-f47t.52.228.54: --only runs the named checks of the plan, --log-dir records each, an unknown id refuses', () => {
    const logs = join(repo.root, 'logs')
    const run = repo.gate(['full', '--area', 'frontend', '--only', 'check-ui', '--only', 'typecheck', '--log-dir', logs])
    expect(run.status, run.stderr).toBe(0)
    expect(repo.calls()).toEqual(['npm run typecheck offline=unset', 'npm run check:ui offline=unset'])
    const durations = JSON.parse(readFileSync(join(logs, 'durations.json'), 'utf8')) as { id: string, outcome: string, seconds: number }[]
    expect(durations.map((entry) => [entry.id, entry.outcome])).toEqual([['typecheck', 'passed'], ['check-ui', 'passed']])
    expect(durations.every((entry) => typeof entry.seconds === 'number')).toBe(true)
    const unknown = repo.gate(['full', '--area', 'docs', '--only', 'typecheck'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('--only names typecheck, which the plan does not hold')
  })

  it('canopi-f47t.52.228.54: CANOPI_E2E_RUNNER runs the e2e command, and a runner that cannot start fails naming it', () => {
    // quiet-gates hands its Docker wrapper as the runner; unset, the gate runs e2e itself in the pinned image.
    repo.stage('desktop/web/src/styles/global.css')
    const runner = join(repo.root, 'runner')
    writeFileSync(runner, '#!/bin/sh\necho "runner $*" >> "$SHIM_LOG"\n')
    chmodSync(runner, 0o755)
    const run = repo.gate(['affected', '--base', repo.base, '--only', 'e2e'], { env: { CANOPI_E2E_RUNNER: runner } })
    expect(run.status, run.stderr).toBe(0)
    // e2e serves dist-web through `vite preview --mode web`: --only e2e builds it first, never a stale or missing one.
    expect(repo.calls()).toEqual(['npm run build:web offline=unset', expect.stringMatching(new RegExp(`^runner docker run .*${PLANTED_IMAGE.replace(/[.]/g, '\\.')} npx playwright test e2e/canvas`))])
    const missing = repo.gate(['affected', '--base', repo.base, '--only', 'e2e'], { env: { CANOPI_E2E_RUNNER: join(repo.root, 'nope') } })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain(`the e2e runner CANOPI_E2E_RUNNER=${join(repo.root, 'nope')} could not start`)
  })

  it('unmounted: with no node_modules the checks that need them refuse naming npm ci, and areas still works', () => {
    const fresh = new PlantedRepo({ packages: false })
    try {
      fresh.stage('desktop/web/src/app/x.ts', 'docs/a.md')
      const areas = fresh.gate(['areas', '--base', fresh.base])
      expect(areas.status, areas.stderr).toBe(0)
      expect((JSON.parse(areas.stdout) as { selected: string[] }).selected).toEqual(['frontend', 'real-app', 'a11y', 'docs'])
      const affected = fresh.gate(['affected', '--base', fresh.base])
      expect(affected.status).toBe(1)
      expect(affected.stderr).toContain('desktop/web/node_modules/.bin/depcruise is missing: run npm ci in desktop/web')
      const full = fresh.gate(['full', '--area', 'frontend', '--area', 'docs'])
      expect(full.status).toBe(1)
      expect(full.stderr).toContain(`FAIL ${TYPECHECK}: desktop/web/node_modules is missing: run npm ci in desktop/web`)
      expect(fresh.calls(), 'no check that needs the packages ran').toEqual([])
    } finally {
      fresh.cleanup()
    }
  })

  it('canopi-f47t.52.228.10: e2e with the image missing and no network fails naming it', () => {
    repo.stage('desktop/web/src/styles/global.css')
    const run = repo.gate(['affected', '--base', repo.base], { env: { SHIM_NO_IMAGE: '1' } })
    expect(run.status, run.stderr).toBe(1)
    expect(run.stderr).toContain(`${PLANTED_IMAGE} is missing and could not be pulled`)
    expect(repo.calls().join(' ')).toContain(`docker pull ${PLANTED_IMAGE}`)
    expect(repo.calls().filter((call) => call.includes('playwright test')), 'never host browsers').toEqual([])
    expect(repo.calls().filter((call) => call.startsWith('docker run'))).toEqual([])
  })

  it('canopi-f47t.52.228.10: a failing e2e run names its image', () => {
    repo.stage('desktop/web/src/styles/global.css')
    const run = repo.gate(['affected', '--base', repo.base], { env: { SHIM_E2E_FAIL: '1' } })
    expect(run.status, run.stderr).toBe(1)
    expect(run.stderr).toContain(`gate: FAIL e2e in ${PLANTED_IMAGE}`)
  })

  it("canopi-f47t.52.228.10: a check never sees the hook's git dir", async () => {
    // A linked worktree's hook exports GIT_DIR and GIT_INDEX_FILE naming the real repository; a check's `git init` of a
    // temporary root under GIT_DIR re-initialises that repository instead (core.bare = true).
    const decoy = join(repo.root, 'decoy')
    git(repo.root, 'init', '-q', decoy)
    const config = readFileSync(join(decoy, '.git/config'), 'utf8')
    const env = { ...cleanEnv(), GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git/index') }
    const status = await execute(repo.repo, [{ id: 'probe', command: `git init -q ${join(repo.root, 'fresh')}` }], undefined, [], true, env)
    expect(status).toBe(0)
    expect(readFileSync(join(decoy, '.git/config'), 'utf8'), "a check wrote into the hook's GIT_DIR").toBe(config)
    expect(git(decoy, 'status', '--porcelain')).toBe('')
  })
})

describe('the pinned actionlint (canopi-f47t.52.228.15.1)', () => {
  let scratch: string
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'canopi-actionlint-')) })
  afterEach(() => rmSync(scratch, { recursive: true, force: true }))

  const fake = (version: string) => {
    const binary = join(scratch, 'actionlint')
    const log = join(scratch, 'argv')
    writeFileSync(binary, `#!/bin/sh\n[ "$1" = -version ] && { echo ${version}; exit 0; }\necho "$*" > '${log}'\n`)
    chmodSync(binary, 0o755)
    return { binary, log }
  }
  const actionlint = (binary: string) => spawnSync(process.execPath, ['policy/gate/cli.mjs', 'actionlint'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), CANOPI_ACTIONLINT: binary },
  })

  it('canopi-f47t.52.228.10: a missing or other actionlint fails closed naming the pinned release', () => {
    const { binary, log } = fake('1.6.0')
    for (const candidate of [binary, join(scratch, 'absent')]) {
      const run = actionlint(candidate)
      expect(run.status, run.stderr).toBe(1)
      expect(run.stderr).toContain(`actionlint ${TABLE.actionlint.version} is needed`)
      expect(run.stderr).toContain(TABLE.actionlint.sha256)
    }
    expect(() => readFileSync(log), 'another version never runs').toThrow()
  })

  it('canopi-f47t.52.228.10: the pinned actionlint runs over the workflows with the config', () => {
    const { binary, log } = fake(TABLE.actionlint.version)
    const run = actionlint(binary)
    expect(run.status, run.stderr).toBe(0)
    const argv = readFileSync(log, 'utf8').trim().split(' ')
    expect(argv.slice(0, 2)).toEqual(['-config-file', '.github/actionlint.yaml'])
    expect(argv, 'the pinned tool alone decides: no runner-installed shellcheck').toContain('-shellcheck=')
  })
})
