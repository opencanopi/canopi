import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { git, PlantedRepo } from './planted-repo.ts'
import { addedMarkers } from './prepush-checks.ts'

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

  it('unreadable: an upstream register that cannot list its markers fails the check, never exempting nothing', () => {
    commit(register([], 1))
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    commit({ 'README.md': 'y\n' })
    const run = repo.gate(['prepush-checks', '--base', base])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('FAIL policy/adapters/upstream-register.mjs markers exited 1')
  })
})
