// The pre-push stamp (2.1-Q266, 2.1-Q270; design check AR1, A4): the real CLI's `push` in a planted repository, its
// checks recorded by PATH shims, writes `<git common dir>/canopi-gate/<sha>.json` only when the whole lane is green on a
// tree that is exactly HEAD (no tracked change, no untracked file), and never a half-written one. A lane whose only red
// is expected-fail markers added since the base writes a stamp naming them, which serves scratch/ refs only (2.1-Q328).
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git, PlantedRepo } from './planted-repo.ts'

let repo: PlantedRepo
beforeEach(() => {
  repo = new PlantedRepo()
  // The lane's own node checks (the oldest engine, AGENTS.md's rows) are recorded like the other tools.
  copyFileSync(join(repo.bin, 'npm'), join(repo.bin, 'node'))
})
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

const stamps = () => join(repo.repo, '.git/canopi-gate')
const stampOf = (sha: string) => JSON.parse(readFileSync(join(stamps(), `${sha}.json`), 'utf8')) as Record<string, unknown>
const listed = () => (existsSync(stamps()) ? readdirSync(stamps()).sort() : [])

/** Commits a change to `paths` and returns the new HEAD. */
function commit(...paths: string[]): string {
  repo.stage(...paths)
  git(repo.repo, 'commit', '-q', '-m', 'change')
  return git(repo.repo, 'rev-parse', 'HEAD')
}

/** The lane's marker check runs on the real Node (the other node checks stay recorded), from a register exempting none;
 * commits an expected-fail marker added since the base and returns the new HEAD. */
function commitMarker(): string {
  writeFileSync(join(repo.bin, 'node'), `#!/bin/sh\necho "node $*" >> "$SHIM_LOG"\n`
    + `[ "$2" = prepush-checks ] && exec '${process.execPath}' "$@"\nexit 0\n`, { mode: 0o755 })
  repo.write({ 'policy/adapters/upstream-register.mjs': '\n', 'desktop/web/src/app/red.test.ts': "it.fails('red, planted', () => {})\n" })
  git(repo.repo, 'add', 'policy/adapters/upstream-register.mjs', 'desktop/web/src/app/red.test.ts')
  return commit('desktop/web/e2e/canvas/a.spec.ts')
}
const MARKER = "desktop/web/src/app/red.test.ts:1:it.fails('red, planted', () => {})"

describe('a lane whose only red is added markers stamps for scratch/ refs only (2.1-Q328)', () => {
  it('2.1-Q328: added markers on an otherwise green lane write a stamp naming them, the output saying it serves scratch/ only', () => {
    const head = commitMarker()
    const run = repo.gate(['push', '--base', repo.base])
    expect(run.status, run.stderr).toBe(0)
    expect(repo.calls(), 'the e2e run still ran').toContainEqual(expect.stringMatching(/^docker run /u))
    expect(run.stdout).toContain(`SCRATCH ONLY expected-fail markers added since the base:\n${MARKER}`)
    expect(run.stderr).toContain(`gate: stamp written for refs under scratch/ only: ${join(stamps(), `${head}.json`)}`)
    expect(run.stderr).toContain(`expected-fail markers added since the base: ${MARKER}`)
    expect(stampOf(head)).toMatchObject({ sha: head, lane: 'push', base: repo.base, e2e: true, markers: [MARKER] })
  })

  it('2.1-Q328: added markers with another red check write no stamp', () => {
    commitMarker()
    const run = repo.gate(['push', '--base', repo.base], { env: { SHIM_E2E_FAIL: '1' } })
    expect(run.status).toBe(1)
    expect(listed()).toEqual([])
  })

  it('2.1-Q328: the marker check run alone still fails on an added marker', () => {
    commitMarker()
    const run = repo.gate(['prepush-checks', '--base', repo.base])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`FAIL expected-fail markers added since the base:\n${MARKER}`)
  })
})

describe('gate push stamps the commit it ran on (canopi-f47t.52.228.54)', () => {
  it('a green lane on a clean tree writes the stamp: sha, table blob, lane, base, e2e and Rust ran', () => {
    const head = commit('desktop/web/e2e/canvas/a.spec.ts', 'desktop/src/x.rs')
    const run = repo.gate(['push', '--base', repo.base])
    expect(run.status, run.stderr).toBe(0)
    expect(run.stderr).toContain(`gate: stamp written: ${join(stamps(), `${head}.json`)}`)
    expect(stampOf(head)).toEqual({
      sha: head, table: git(repo.repo, 'rev-parse', `${head}:policy/gate/table.ts`), lane: 'push', base: repo.base,
      e2e: true, rust: true,
    })
    expect(listed()).toEqual([`${head}.json`])
  })

  it('dirty tree at stamp time: a tracked change refuses before any check runs, and no stamp is written', () => {
    commit('desktop/web/src/app/x.ts')
    writeFileSync(join(repo.repo, 'README.md'), 'edited\n')
    const run = repo.gate(['push', '--base', repo.base])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('gate push stamps the commit it runs on, and the tracked tree has changes (README.md)')
    expect(repo.calls().filter((call) => !call.startsWith('--config')), 'only the planning cruise ran').toEqual([])
    expect(listed()).toEqual([])
  })

  it('dirty tree at stamp time: a tracked file changed during the run leaves the lane red with no stamp', () => {
    commit('desktop/web/e2e/canvas/a.spec.ts')
    const runner = join(repo.root, 'runner')
    writeFileSync(runner, `#!/bin/sh\necho touched >> '${join(repo.repo, 'README.md')}'\n`, { mode: 0o755 })
    const run = repo.gate(['push', '--base', repo.base], { env: { CANOPI_E2E_RUNNER: runner } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('GREEN, but no stamp was written: the tracked tree changed (README.md) during the run')
    expect(listed()).toEqual([])
  })

  it('canopi-f47t.52.228.54: an untracked file refuses the stamp before and after the run; an ignored one does not', () => {
    const head = commit('desktop/web/e2e/canvas/a.spec.ts')
    writeFileSync(join(repo.repo, 'stray.ts'), 'x\n')
    const before = repo.gate(['push', '--base', repo.base])
    expect(before.status).toBe(1)
    expect(before.stderr).toContain('untracked files (stray.ts): commit or remove them')
    expect(repo.calls().filter((call) => !call.startsWith('--config')), 'only the planning cruise ran').toEqual([])
    expect(listed()).toEqual([])
    rmSync(join(repo.repo, 'stray.ts'))
    const runner = join(repo.root, 'runner')
    writeFileSync(runner, `#!/bin/sh\necho x > '${join(repo.repo, 'late.ts')}'\n`, { mode: 0o755 })
    const after = repo.gate(['push', '--base', repo.base], { env: { CANOPI_E2E_RUNNER: runner } })
    expect(after.status).toBe(1)
    expect(after.stderr).toContain('GREEN, but no stamp was written: untracked files (late.ts) appeared during the run')
    expect(listed()).toEqual([])
    rmSync(join(repo.repo, 'late.ts'))
    repo.write({ 'node_modules/ignored.js': 'x\n' })
    expect(repo.gate(['push', '--base', repo.base]).status).toBe(0)
    expect(listed()).toEqual([`${head}.json`])
  })

  it('canopi-f47t.52.228.54: a rename in the index or the worktree names its path once, its source never cut short', () => {
    commit('desktop/web/src/app/x.ts')
    git(repo.repo, 'mv', 'README.md', 'README-staged.md')
    const staged = repo.gate(['push', '--base', repo.base])
    expect(staged.stderr).toContain('the tracked tree has changes (README-staged.md): commit or remove them')
    git(repo.repo, 'mv', 'README-staged.md', 'README.md')
    renameSync(join(repo.repo, 'README.md'), join(repo.repo, 'README-moved.md'))
    git(repo.repo, 'add', '-N', 'README-moved.md')
    const worktree = repo.gate(['push', '--base', repo.base])
    expect(worktree.stderr).toContain('the tracked tree has changes (README-moved.md): commit or remove them')
    expect(listed()).toEqual([])
  })

  it('canopi-f47t.52.228.54: HEAD moved to a clean commit while the lane was planned refuses, naming both, and stamps neither', () => {
    const planned = commit('desktop/web/src/app/x.ts')
    // The planning cruise checks out the base commit once: the tree stays clean, HEAD is another commit.
    const cruiser = join(repo.repo, 'desktop/web/node_modules/.bin/depcruise')
    writeFileSync(cruiser, `#!/bin/sh\necho "$*" >> "$SHIM_LOG"\n[ -e '${join(repo.root, 'moved')}' ] || { `
      + `touch '${join(repo.root, 'moved')}'; git -C '${repo.repo}' checkout -q --detach ${repo.base}; }\n`
      + 'echo \'{"modules": [{"source": "src/app/user.ts"}, {"source": "src/app/user.test.ts"}]}\'\n')
    const run = repo.gate(['push', '--base', repo.base])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`gate push planned its lane from ${planned}, but HEAD is now ${repo.base}`)
    expect(repo.calls().filter((call) => !call.startsWith('--config')), 'no check ran').toEqual([])
    expect(listed()).toEqual([])
  })

  it('a red lane, --only and --print write no stamp', () => {
    commit('desktop/web/e2e/canvas/a.spec.ts')
    expect(repo.gate(['push', '--base', repo.base], { env: { SHIM_E2E_FAIL: '1' } }).status).toBe(1)
    expect(repo.gate(['push', '--base', repo.base, '--only', 'typecheck']).status).toBe(0)
    repo.printed(['push', '--base', repo.base])
    expect(listed()).toEqual([])
  })

  it('unwritable: a stamp directory that cannot be written turns a green lane red, naming it', () => {
    const head = commit('desktop/web/src/app/x.ts')
    writeFileSync(stamps(), 'not a directory\n')
    const run = repo.gate(['push', '--base', repo.base])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`GREEN, but no stamp was written: ${stamps()} cannot be written (EEXIST); a push of ${head} is refused`)
  })

  it('cancelled: an interrupted gate push writes no stamp', async () => {
    commit('desktop/web/src/app/x.ts')
    const child = spawn(process.execPath, ['policy/gate/cli.mjs', 'push', '--base', repo.base], {
      cwd: repo.repo, env: repo.env({ SHIM_SLOW_NPM: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    const deadline = Date.now() + 20_000
    while (!repo.calls().some((call) => call.startsWith('npm run')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill('SIGINT')
    expect(await exited).toBe(130)
    expect(listed()).toEqual([])
  })

  it('busy: two runs on one commit leave one whole stamp and no temporary file', async () => {
    const head = commit('desktop/web/src/app/x.ts')
    const once = () => new Promise<number | null>((resolve) => {
      spawn(process.execPath, ['policy/gate/cli.mjs', 'push', '--base', repo.base], {
        cwd: repo.repo, env: repo.env(), stdio: 'ignore',
      }).once('close', resolve)
    })
    expect(await Promise.all([once(), once()])).toEqual([0, 0])
    expect(listed()).toEqual([`${head}.json`])
    expect(stampOf(head)).toMatchObject({ sha: head, lane: 'push', base: repo.base, e2e: false })
  })
})
