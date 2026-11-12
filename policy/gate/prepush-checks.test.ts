import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { git, PlantedRepo, REPO_ROOT } from './planted-repo.ts'
import { addedMarkers, MARKERS_RECORD } from './prepush-checks.ts'

const repo = new PlantedRepo()
afterAll(() => repo.cleanup())
beforeEach(() => repo.reset())

const commit = (files: Readonly<Record<string, string>>) => {
  repo.write(files)
  git(repo.repo, 'add', '-A')
  git(repo.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'change')
  return git(repo.repo, 'rev-parse', 'HEAD')
}
/** The register's stand-in: `node policy/adapters/upstream-register.mjs markers` prints `lines`, or exits `status`. */
const register = (lines: readonly string[], status = 0) => ({
  'policy/adapters/upstream-register.mjs': `for (const line of ${JSON.stringify(lines)}) console.log(line)\nprocess.exitCode = ${status}\n`,
})

describe('the pre-push lane\'s expected-fail marker check (canopi-f47t.52.228.54, 2.1-Q272)', () => {
  it('canopi-f47t.52.228.54: a marker added since the base fails, one already on the base or a Rust one kept passes', () => {
    commit({ 'desktop/web/src/app/old.test.ts': "it.fails('blocked upstream, planted', () => {})\n", ...register([]) })
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    commit({
      'desktop/web/src/app/old.test.ts': "\n  it.fails('blocked upstream, planted', () => {})\n",
      'desktop/web/src/app/new.test.ts': "test.fail('red until fixed, planted', () => {})\n",
      'desktop/src/lib.rs': '#[ignore = "expected-fail planted"]\nfn t() {}\n',
      'policy/fixtures/planted.test.ts': "it.fails('a planted case', () => {})\n",
    })
    expect(addedMarkers(repo.repo, base, new Set())).toEqual([
      "desktop/src/lib.rs:1:#[ignore = \"expected-fail planted\"]",
      "desktop/web/src/app/new.test.ts:1:test.fail('red until fixed, planted', () => {})",
    ])
  })

  it('canopi-f47t.52.228.54: a marker the upstream register exempts (an open W row, 2.1-M237) passes', () => {
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    commit({ 'desktop/web/src/app/new.test.ts': "it.fails('upstream: W3', () => {})\n" })
    expect(addedMarkers(repo.repo, base, new Set(['desktop/web/src/app/new.test.ts:1']))).toEqual([])
  })

  it('canopi-f47t.52.228.54: the push lane runs the marker check through the real entry, after the commit gate\'s range', () => {
    commit(register([]))
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    repo.stage('desktop/web/src/app/x.ts')
    const ids = repo.printed(['push', '--base', base]).checks.map((check) => check.id)
    expect(ids.slice(-2)).toEqual(['commit-gate-pr', 'prepush-checks'])
    expect(repo.printed(['affected', '--base', base]).checks.map((check) => check.id)).not.toContain('prepush-checks')

    repo.reset(base)
    commit({ 'desktop/web/src/app/new.test.ts': "it.fails('red', () => {})\n" })
    const red = repo.gate(['prepush-checks', '--base', base])
    expect(red.status).toBe(1)
    expect(red.stdout).toContain('FAIL expected-fail markers added since the base')
    expect(red.stdout).toContain("desktop/web/src/app/new.test.ts:1:it.fails('red', () => {})")

    commit(register(['desktop/web/src/app/new.test.ts:1 W3']))
    const green = repo.gate(['prepush-checks', '--base', base])
    expect(green.stdout).toContain('PASS no expected-fail markers beyond those on the base')
    expect(green.status).toBe(0)
  })

  it('2.1-Q328: a planted marker check fails on an added marker even under a push lane\'s marker record, and writes none', () => {
    commit(register([]))
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    commit({ 'desktop/web/src/app/new.test.ts': "it.fails('red', () => {})\n" })
    const record = join(repo.root, 'outer-record.json')
    process.env[MARKERS_RECORD] = record
    try {
      const run = repo.gate(['prepush-checks', '--base', base])
      expect(run.status).toBe(1)
      expect(run.stdout).toContain('FAIL expected-fail markers added since the base')
      expect(existsSync(record)).toBe(false)
    } finally {
      delete process.env[MARKERS_RECORD]
    }
  })

  it('2.1-Q328: CI refuses a PR whose head adds an expected-fail marker, so a scratch-only stamp never reaches main', () => {
    const step = readFileSync(join(REPO_ROOT, '.github/workflows/commit-gate.yml'), 'utf8').split('      - name: No expected-fail marker added by the PR\n')[1]?.split('\n      - ')[0] ?? ''
    expect(step).toContain("if: github.event_name == 'pull_request'")
    expect(step).toContain('run: node policy/gate/cli.mjs check prepush-checks')
    expect(step).not.toContain('CANOPI_GATE_MARKERS_RECORD')
    // The step's command, through the real entry, in a planted repository whose origin/main is the PR's base.
    const planted = new PlantedRepo()
    try {
      planted.write({ 'policy/adapters/upstream-register.mjs': '\n', 'desktop/web/src/app/a.test.ts': "it('one', () => {})\n" })
      git(planted.repo, 'add', '-A')
      git(planted.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base')
      git(planted.repo, 'update-ref', 'refs/remotes/origin/main', git(planted.repo, 'rev-parse', 'HEAD'))
      planted.write({ 'desktop/web/src/app/a.test.ts': "it('one', () => {})\nit('two', () => {})\n" })
      git(planted.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-am', 'clean')
      const clean = planted.gate(['check', 'prepush-checks'])
      expect(clean.status, clean.stderr).toBe(0)
      expect(clean.stdout).toContain('PASS no expected-fail markers beyond those on the base')
      planted.write({ 'desktop/web/src/app/a.test.ts': "it('one', () => {})\nit.fails('red', () => {})\n" })
      git(planted.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-am', 'marker')
      const red = planted.gate(['check', 'prepush-checks'])
      expect(red.status).toBe(1)
      expect(red.stdout).toContain("FAIL expected-fail markers added since the base:\ndesktop/web/src/app/a.test.ts:2:it.fails('red', () => {})")
    } finally {
      planted.cleanup()
    }
  })

  it('unreadable: an upstream register that cannot list its markers fails the check, never exempting nothing', () => {
    commit(register([], 1))
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    commit({ 'README.md': 'y\n' })
    const run = repo.gate(['prepush-checks', '--base', base])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('FAIL policy/adapters/upstream-register.mjs markers exited 1')
  })
})
