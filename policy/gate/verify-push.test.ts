// The pre-push hook (2.1-Q266, 2.1-Q270; design check AR1, A4): real `git push`es from a planted repository and its
// linked worktree to a bare remote, through the tracked .githooks/pre-push and the real CLI. A pushed commit needs a
// green pre-push stamp that covers its range; deletions, tags on origin/main and docs or beads-only ranges pass.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

let repo: PlantedRepo
let remote: string
beforeEach(() => {
  repo = new PlantedRepo()
  remote = join(repo.root, 'remote.git')
  git(repo.root, 'init', '-q', '--bare', remote)
  copyFileSync(join(REPO_ROOT, '.githooks/pre-push'), join(repo.repo, '.git/hooks/pre-push'))
  // The lane's own node checks (the oldest engine, AGENTS.md's rows) are recorded like the other tools, in `gate push`
  // only: the hook's node is the real one.
  mkdirSync(join(repo.root, 'node-shim'))
  copyFileSync(join(repo.bin, 'npm'), join(repo.root, 'node-shim/node'))
})
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

const stampFile = (sha: string) => join(repo.repo, '.git/canopi-gate', `${sha}.json`)

function commit(...paths: string[]): string {
  repo.stage(...paths)
  git(repo.repo, 'commit', '-q', '-m', 'change')
  return git(repo.repo, 'rev-parse', 'HEAD')
}

function stamp(cwd = repo.repo): void {
  const run = repo.gate(['push', '--base', 'origin/main'], { cwd, env: { PATH: `${join(repo.root, 'node-shim')}${delimiter}${repo.env()['PATH']}` } })
  expect(run.status, run.stderr).toBe(0)
}

function push(refspec: string, cwd = repo.repo): { status: number | null, stderr: string } {
  const run = spawnSync('git', ['push', '-q', remote, refspec], { cwd, encoding: 'utf8', env: repo.env() })
  return { status: run.status, stderr: run.stderr }
}

const REFUSAL = 'run `node policy/gate/cli.mjs push --base origin/main` on the commit you push, then push again; refusing'

describe('the pre-push hook verifies a stamp (canopi-f47t.52.228.54, canopi-f47t.52.240)', () => {
  it('refused with no stamp, naming the command; accepted with a match', () => {
    const head = commit('desktop/web/src/app/x.ts')
    const refused = push('HEAD:refs/heads/work')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`gate: pre-push: refs/heads/work at ${head.slice(0, 12)}: it has no green pre-push stamp`)
    expect(refused.stderr).toContain(REFUSAL)
    stamp()
    expect(push('HEAD:refs/heads/work')).toEqual({ status: 0, stderr: '' })
    expect(git(remote, 'rev-parse', 'refs/heads/work')).toBe(head)
  })

  it('retried: re-pushing with a valid stamp is accepted again, and the stamp stays', () => {
    const head = commit('desktop/web/src/app/x.ts')
    stamp()
    expect(push('HEAD:refs/heads/one').status).toBe(0)
    expect(push('HEAD:refs/heads/two').status).toBe(0)
    expect(JSON.parse(readFileSync(stampFile(head), 'utf8'))).toMatchObject({ sha: head })
  })

  it('refused with a stamp naming another sha, another table, another lane or a later base', () => {
    const head = commit('desktop/web/src/app/x.ts')
    stamp()
    const good = JSON.parse(readFileSync(stampFile(head), 'utf8')) as Record<string, unknown>
    for (const [change, why] of [
      [{ sha: repo.base }, `its stamp names another commit (${repo.base.slice(0, 12)})`],
      [{ table: git(repo.repo, 'rev-parse', `${repo.base}:README.md`) }, 'its stamp was made with another gate table'],
      [{ lane: 'affected' }, 'its stamp is from the affected lane, not the pre-push lane'],
      [{ base: head }, `its stamp's lane ran from ${head.slice(0, 12)}, which neither origin/main nor the pushed range's start ${repo.base.slice(0, 12)} holds`],
    ] as const) {
      writeFileSync(stampFile(head), JSON.stringify({ ...good, ...change }))
      const run = push('HEAD:refs/heads/work')
      expect([run.status, run.stderr.includes(why)], why).toEqual([1, true])
    }
  })

  it('canopi-f47t.52.228.54: a pushed branch that takes a newer origin/main, by merge or rebase, pushes again once stamped', () => {
    commit('desktop/web/src/app/x.ts')
    stamp()
    expect(push('HEAD:refs/heads/work').status).toBe(0)
    // origin/main moves past the branch's base.
    git(repo.repo, 'checkout', '-q', '-b', 'mainline', repo.base)
    const moved = commit('desktop/web/src/app/z.ts')
    git(repo.repo, 'update-ref', 'refs/remotes/origin/main', moved)
    git(repo.repo, 'checkout', '-q', 'main')
    const tip = git(repo.repo, 'rev-parse', 'HEAD')
    git(repo.repo, 'merge', '-q', '--no-edit', 'origin/main')
    stamp()
    expect(push('HEAD:refs/heads/work')).toEqual({ status: 0, stderr: '' })
    // The same branch rebased onto origin/main instead, force-pushed over the merge.
    git(repo.repo, 'reset', '-q', '--hard', tip)
    git(repo.repo, 'rebase', '-q', 'origin/main')
    stamp()
    expect(push('+HEAD:refs/heads/work')).toEqual({ status: 0, stderr: '' })
    // A stamp from a base neither origin/main nor the pushed range's start holds still covers too little.
    git(repo.repo, 'checkout', '-q', '-b', 'side', moved)
    commit('desktop/web/src/app/y.ts')
    const off = git(repo.repo, 'rev-parse', 'HEAD')
    commit('desktop/web/src/app/x.ts')
    stamp()
    const head = git(repo.repo, 'rev-parse', 'HEAD')
    const good = JSON.parse(readFileSync(stampFile(head), 'utf8')) as Record<string, unknown>
    writeFileSync(stampFile(head), JSON.stringify({ ...good, base: off }))
    expect(push('HEAD:refs/heads/side').stderr).toContain(`its stamp's lane ran from ${off.slice(0, 12)}`)
  })

  it('canopi-f47t.52.228.54: a branch that merges a main which brought Rust and e2e changes pushes again once stamped', () => {
    commit('desktop/web/src/app/x.ts')
    stamp()
    expect(push('HEAD:refs/heads/work').status).toBe(0)
    git(repo.repo, 'checkout', '-q', '-b', 'mainline', repo.base)
    const moved = commit('desktop/src/x.rs', 'desktop/web/e2e/canvas/a.spec.ts')
    git(repo.repo, 'update-ref', 'refs/remotes/origin/main', moved)
    git(repo.repo, 'checkout', '-q', 'main')
    git(repo.repo, 'merge', '-q', '--no-edit', 'origin/main')
    stamp()
    expect(JSON.parse(readFileSync(stampFile(git(repo.repo, 'rev-parse', 'HEAD')), 'utf8'))).toMatchObject({ e2e: false, rust: false })
    expect(push('HEAD:refs/heads/work')).toEqual({ status: 0, stderr: '' })
  })

  it('unreadable: a corrupt stamp is no stamp, and refused', () => {
    const head = commit('desktop/web/src/app/x.ts')
    stamp()
    writeFileSync(stampFile(head), '{"sha": "')
    const run = push('HEAD:refs/heads/work')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('it has no green pre-push stamp')
  })

  it('refused with a lane missing e2e or Rust the pushed changes need', () => {
    const head = commit('desktop/web/e2e/canvas/a.spec.ts', 'desktop/src/x.rs')
    stamp()
    const good = JSON.parse(readFileSync(stampFile(head), 'utf8')) as Record<string, unknown>
    expect(good).toMatchObject({ e2e: true, rust: true })
    writeFileSync(stampFile(head), JSON.stringify({ ...good, e2e: false }))
    expect(push('HEAD:refs/heads/work').stderr).toContain("its stamp's lane ran no e2e, which the pushed changes need")
    writeFileSync(stampFile(head), JSON.stringify({ ...good, rust: false }))
    expect(push('HEAD:refs/heads/work').stderr).toContain("its stamp's lane ran no Rust check, which the pushed changes need")
  })

  it('canopi-f47t.52.228.54: a range whose only e2e change deletes a spec needs no e2e, judged at the pushed commit', () => {
    git(repo.repo, 'rm', '-q', 'desktop/web/e2e/canvas/a.spec.ts')
    git(repo.repo, 'commit', '-q', '-m', 'change')
    const head = git(repo.repo, 'rev-parse', 'HEAD')
    stamp()
    expect(JSON.parse(readFileSync(stampFile(head), 'utf8'))).toMatchObject({ e2e: false })
    expect(push('HEAD:refs/heads/work')).toEqual({ status: 0, stderr: '' })
    // Pushed from a checkout whose tree still holds the spec: the pushed commit, not the working tree, decides.
    git(repo.repo, 'checkout', '-q', '--detach', repo.base)
    expect(push(`${head}:refs/heads/again`)).toEqual({ status: 0, stderr: '' })
  })

  it('canopi-f47t.52.228.54: a docs-only range is refused while an untracked file sits in the tree its lane reads', () => {
    commit('docs/guide.md')
    writeFileSync(join(repo.repo, 'docs/stray.md'), 'x\n')
    const run = push('HEAD:refs/heads/docs')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('commit or remove the untracked files')
  })

  it('canopi-f47t.52.228.54: a docs-only range\'s cheap lane runs the closed-bead check the Commit gate runs on every PR', () => {
    // origin/main's policy entries cite a bead closed since: the checker refuses, as CI's Commit gate would.
    repo.write({ 'policy/check.mjs': 'process.exit(1)\n' })
    git(repo.repo, 'add', 'policy/check.mjs')
    git(repo.repo, 'commit', '-q', '-m', 'change')
    git(repo.repo, 'update-ref', 'refs/remotes/origin/main', git(repo.repo, 'rev-parse', 'HEAD'))
    commit('docs/guide.md')
    const run = push('HEAD:refs/heads/docs')
    expect(run.stderr).toContain('gate: node policy/check.mjs --closed-beads')
    expect(run.stderr).toContain('its docs or beads lane is red')
    expect(run.status).toBe(1)
  })

  it('refused when the tree was dirty at stamp time, since no stamp was written', () => {
    commit('desktop/web/src/app/x.ts')
    writeFileSync(join(repo.repo, 'README.md'), 'edited\n')
    expect(repo.gate(['push', '--base', 'origin/main']).status).toBe(1)
    git(repo.repo, 'checkout', '-q', 'README.md')
    expect(push('HEAD:refs/heads/work').stderr).toContain('it has no green pre-push stamp')
  })

  it('shared across two worktrees: a stamp made in one serves a push of that commit from the other', () => {
    const head = commit('desktop/web/src/app/x.ts')
    const other = join(repo.root, 'wt-y')
    git(repo.repo, 'worktree', 'add', '-q', '--detach', other, head)
    expect(push('HEAD:refs/heads/work', other).status).toBe(1)
    stamp()
    expect(push('HEAD:refs/heads/work', other)).toEqual({ status: 0, stderr: '' })
  })

  it('a deletion and a tag on origin/main pass; a tag on another commit is refused', () => {
    commit('desktop/web/src/app/x.ts')
    stamp()
    expect(push('HEAD:refs/heads/work').status).toBe(0)
    expect(push(':refs/heads/work').status).toBe(0)
    git(repo.repo, 'tag', 'on-main', repo.base)
    expect(push('refs/tags/on-main').status).toBe(0)
    git(repo.repo, 'tag', '-a', '-m', 'x', 'off-main', 'HEAD')
    const refused = push('refs/tags/off-main')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('a tag is pushed only once its commit is on origin/main')
  })

  it('canopi-f47t.52.228.54: a range touching CI or the Playwright setup stamps and pushes with no CI run on HEAD yet', () => {
    // The lane's own prepush-checks runs on the real Node; the merge's required checks hold CI green on HEAD.
    writeFileSync(join(repo.root, 'node-shim/node'), `#!/bin/sh\necho "node $*" >> "$SHIM_LOG"\n`
      + `[ "$2" = prepush-checks ] && exec '${process.execPath}' "$@"\nexit 0\n`, { mode: 0o755 })
    repo.write({ 'policy/adapters/upstream-register.mjs': '\n' })
    git(repo.repo, 'add', 'policy/adapters/upstream-register.mjs')
    const head = commit('.github/workflows/build.yml', 'desktop/web/playwright.config.ts', 'desktop/web/e2e/support/server.ts')
    stamp()
    expect(repo.calls()).toContain('node policy/gate/cli.mjs prepush-checks --base origin/main')
    expect(push('HEAD:refs/heads/draft')).toEqual({ status: 0, stderr: '' })
    expect(git(remote, 'rev-parse', 'refs/heads/draft')).toBe(head)
  })

  it('a docs or beads-only range runs its cheap lane here instead, on a clean checkout of it', () => {
    // The lane's closed-bead check runs on the real Node: origin/main holds a checker that passes.
    repo.write({ 'policy/check.mjs': '\n' })
    git(repo.repo, 'update-ref', 'refs/remotes/origin/main', commit('policy/check.mjs'))
    commit('docs/guide.md', '.beads/issues.jsonl')
    expect(push('HEAD:refs/heads/docs')).toEqual({ status: 0, stderr: expect.stringContaining('changes only docs or beads') })
    expect(repo.calls().some((call) => call.startsWith('python3 scripts/check_docs.py'))).toBe(true)
    writeFileSync(join(repo.repo, 'README.md'), 'edited\n')
    const dirty = push('HEAD:refs/heads/docs-2')
    expect(dirty.status).toBe(1)
    expect(dirty.stderr).toContain('a docs or beads-only push runs its lane on the commit checked out with a clean tracked tree')
  })
})
