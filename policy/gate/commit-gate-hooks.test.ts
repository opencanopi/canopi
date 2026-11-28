// The tracked commit hooks through real commits (2.1-M14, 2.1-M196, 2.1-Q205, 2.1-Q223, 2.1-Q267; canopi-f47t.52.228.10,
// canopi-f47t.52.228.54): a planted repository with the real .githooks and policy/, a linked worktree and the shared
// relative core.hooksPath=.githooks. PATH shims stand in for npm and cargo and record each call; a stub
// scripts/check_docs.py records the Docs row's calls. nvm is an empty directory, so no developer's install is read.
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTRIBUTION, GateRepo, M_ROW, OPEN_BEAD } from './commit-gate-repo.ts'
import { cleanEnv, git, REPO_ROOT } from './planted-repo.ts'

const HOOKS = ['pre-commit', 'commit-msg', 'pre-merge-commit']
const SHIM = `#!/bin/sh
echo "$(basename "$0") $* offline=\${npm_config_offline:-unset}" >> "$SHIM_LOG"
if [ "$1 $2" = "run typecheck" ] && [ -n "$SHIM_TYPECHECK_FAILS" ]; then exit 2; fi
exit 0
`
const CHECK_DOCS_STUB = `import os, sys
with open(os.environ["SHIM_LOG"], "a") as log:
    log.write("check_docs " + " ".join(sys.argv[1:]) + "\\n")
`
const CHECK_POLICY_STUB = `import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
if (process.argv.includes('--closed-beads')) {
  process.exit(spawnSync(process.execPath, ['policy/check-real.mjs', ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1)
}
if (process.env.SHIM_LOG) {
  appendFileSync(process.env.SHIM_LOG, \`check.mjs \${process.argv.slice(2).join(' ')} offline=\${process.env.npm_config_offline ?? 'unset'}\\n\`)
}
`

class HookRepo extends GateRepo {
  readonly linked = join(this.root, 'linked')
  readonly bin = join(this.root, 'bin')
  readonly log = join(this.root, 'calls.log')
  readonly nvm = mkdtempSync(join(this.root, 'nvm-'))

  constructor() {
    super({ hooks: true })
    cpSync(join(this.path, 'policy/check.mjs'), join(this.path, 'policy/check-real.mjs'))
    this.write({ 'scripts/check_docs.py': CHECK_DOCS_STUB, 'policy/check.mjs': CHECK_POLICY_STUB, 'desktop/web/src/a.ts': 'export const a = 1\n', 'docs/a.md': '# A\n' })
    this.base = this.commit('chore: hooks')
    this.git('update-ref', 'refs/remotes/origin/main', this.base)
    this.git('config', 'core.hooksPath', '.githooks')
    this.git('worktree', 'add', '-q', '-b', 'topic', this.linked)
    // The engines manifest and the install every checkout has, excluded from commits as in the main worktree.
    cpSync(join(this.path, 'desktop/web/package.json'), join(this.linked, 'desktop/web/package.json'))
    symlinkSync(join(REPO_ROOT, 'desktop/web/node_modules'), join(this.linked, 'desktop/web/node_modules'))
    mkdirSync(this.bin)
    for (const name of ['npm', 'cargo']) {
      writeFileSync(join(this.bin, name), SHIM)
      chmodSync(join(this.bin, name), 0o755)
    }
    writeFileSync(this.log, '')
  }

  hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = cleanEnv()
    // The hooks call plain node: the test's own Node comes first, nvm is empty.
    return { ...env, PATH: `${this.bin}:${dirname(process.execPath)}:${env['PATH'] ?? ''}`, SHIM_LOG: this.log, NVM_DIR: this.nvm, ...extra }
  }

  /** Writes and stages `files` in `worktree`, then `git commit` with the hooks. */
  commitIn(worktree: string, files: Record<string, string>, extra: Record<string, string> = {}, args: string[] = ['-m', 'change']) {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(worktree, name)), { recursive: true })
      writeFileSync(join(worktree, name), text)
      git(worktree, 'add', name)
    }
    return spawnSync('git', ['commit', '-q', ...args], { cwd: worktree, encoding: 'utf8', env: this.hookEnv(extra), timeout: 300_000 })
  }

  head(worktree = this.linked): string {
    return git(worktree, 'rev-parse', 'HEAD')
  }

  calls(): string[] {
    return readFileSync(this.log, 'utf8').split('\n').filter(Boolean)
  }
}

let repo: HookRepo
beforeEach(() => {
  repo = new HookRepo()
})
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

describe('the tracked hooks (2.1-M196)', () => {
  it('canopi-f47t.52.228.10: hooks are POSIX wrappers of the commit gate on plain node', () => {
    for (const hook of HOOKS) {
      const text = readFileSync(join(REPO_ROOT, '.githooks', hook), 'utf8')
      expect(text.startsWith('#!/bin/sh\n'), hook).toBe(true)
      expect(text).toContain(`exec node policy/gate/cli.mjs commit-gate ${hook} "$@"`)
      expect(() => accessSync(join(REPO_ROOT, '.githooks', hook), constants.X_OK), hook).not.toThrow()
    }
    expect(existsSync(join(REPO_ROOT, '.githooks/node.sh')), 'no prelude: the entry finds the engines Node').toBe(false)
  })

  it('canopi-f47t.52.228.10: a linked worktree runs its own hooks', () => {
    const marker = join(repo.root, 'linked-hook-ran')
    writeFileSync(join(repo.linked, '.githooks/pre-commit'), `#!/bin/sh\ntouch ${marker}\n`)
    const run = repo.commitIn(repo.linked, { 'notes.txt': 'x\n' })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(repo.git('config', '--get', 'core.hooksPath')).toBe('.githooks')
  })

  it('canopi-f47t.52.228.54: wrong Node: a hook on an older Node with no nvm install refuses naming nvm install, and no commit is made', () => {
    const head = repo.head()
    const manifest = join(repo.linked, 'desktop/web/package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { engines: Record<string, string> }
    pkg.engines['node'] = '>=99'
    writeFileSync(manifest, JSON.stringify(pkg))
    const run = repo.commitIn(repo.linked, { 'notes.txt': 'x\n' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Node 99 is required (engines)')
    expect(run.stderr).toContain('run nvm install 99')
    expect(repo.head()).toBe(head)
  })
})

describe('the commit lane through pre-commit (2.1-Q205)', () => {
  it('canopi-f47t.52.228.10: a docs-only commit runs the docs row and no npm', () => {
    const run = repo.commitIn(repo.linked, { 'docs/a.md': '# A\n\nMore.\n', 'NOTES.md': 'x\n' })
    expect(run.status, run.stderr).toBe(0)
    const base = git(repo.linked, 'merge-base', 'HEAD~1', 'origin/main')
    expect(repo.calls()).toEqual(['check_docs ', `check_docs --drift ${base}`])
  })

  it('canopi-f47t.52.228.10: a docs-only commit without origin/main is refused', () => {
    repo.git('update-ref', '-d', 'refs/remotes/origin/main')
    const head = repo.head()
    const run = repo.commitIn(repo.linked, { 'docs/a.md': '# A\n\nMore.\n' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('origin/main')
    expect(repo.head()).toBe(head)
  })

  it('canopi-f47t.52.228.10: a failing git diff is refused, not read as nothing staged', () => {
    writeFileSync(git(repo.linked, 'rev-parse', '--path-format=absolute', '--git-path', 'index'), 'garbage')
    const run = spawnSync(process.execPath, ['policy/gate/cli.mjs', 'commit-gate', 'pre-commit'],
      { cwd: repo.linked, encoding: 'utf8', env: repo.hookEnv(), timeout: 60_000 })
    expect(run.status, run.stderr).toBe(1)
    expect(run.stderr).toContain('git diff')
    expect(repo.calls()).toEqual([])
  })

  it('canopi-f47t.52.228: a bead-only commit runs only the closed-bead check', () => {
    // Closing a bead a ratchet entry cites is refused by its own commit; an uncited bead closes freely, and neither
    // runs npm or cargo. Each export is the checkout's own (id and status), so every cited bead is present for the
    // absent-bead refusal (canopi-f47t.52.228.54) and only the status changes.
    const beads = new Map(readFileSync(join(REPO_ROOT, '.beads/issues.jsonl'), 'utf8').split('\n').filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { id: string, status: string }).map((bead) => [bead.id, bead.status]))
    const exported = (id: string, status: string): string => [...new Map([...beads, [id, status]])]
      .map(([bead, state]) => `${JSON.stringify({ id: bead, status: state })}\n`).join('')
    const cited = [...readFileSync(join(REPO_ROOT, 'policy/ratchets/suppressions.json'), 'utf8').matchAll(/"bead": "(canopi-[a-z0-9.]+)"/gu)][0]?.[1]
      ?? [...readFileSync(join(REPO_ROOT, 'policy/ratchets/file-size.json'), 'utf8').matchAll(/"bead": "(canopi-[a-z0-9.]+)"/gu)][0]?.[1] ?? ''
    expect(cited).not.toBe('')
    const head = repo.head()
    let run = repo.commitIn(repo.linked, { '.beads/issues.jsonl': exported(cited, 'closed') })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('closed-bead: policy/ratchets/')
    expect(run.stderr).toContain(cited)
    expect(repo.head()).toBe(head)
    run = repo.commitIn(repo.linked, { '.beads/issues.jsonl': exported('canopi-uncited', 'closed') })
    expect(run.status, run.stderr).toBe(0)
    expect(repo.calls()).toEqual([])
  })

  it('canopi-f47t.52.228.10: a TS commit runs the typecheck offline', () => {
    const started = Date.now()
    const run = repo.commitIn(repo.linked, { 'desktop/web/src/a.ts': 'export const a = 2\n' })
    expect(run.status, run.stderr).toBe(0)
    // A12: the TS file runs typecheck offline and cheap-families runs policy/check.mjs --family file-size.
    expect(repo.calls()).toEqual(['npm run typecheck offline=true', 'check.mjs --family file-size offline=true'])
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  it("canopi-f47t.52.228.10: the hook runs the gate table's commit lane", () => {
    const run = repo.commitIn(repo.linked, { 'desktop/src/lib.rs': 'fn main() {}\n' })
    expect(run.status, run.stderr).toBe(0)
    expect(repo.calls()).toEqual(['cargo fmt --all -- --check offline=true', 'check.mjs  offline=true', ...['node', 'generate', 'generate:self-test',
      'ast-grep'].map((script) => `npm run test:policies:${script} offline=true`)])
  })

  it('canopi-f47t.52.228.10: a failing typecheck refuses the commit', () => {
    const head = repo.head()
    const run = repo.commitIn(repo.linked, { 'desktop/web/src/a.ts': 'export const a: string = 2\n' }, { SHIM_TYPECHECK_FAILS: '1' })
    expect(run.status).not.toBe(0)
    expect(repo.head()).toBe(head)
  })

  it('pre-commit refuses a commit in the main checkout unless CANOPI_ALLOW_MAIN_CHECKOUT_COMMIT=1 is set', () => {
    const humanEnv = {
      CLAUDECODE: '', CLAUDE_CODE: '', CORAL_SESSION_ID: '', CORAL_DIR: '',
      CORAL_URL: '', ANTIGRAVITY_AGENT: '', AGY_SESSION: '', CODEX_CI: '',
      GITHUB_ACTIONS: '', CI: '',
    }
    // Plain human shell (no agent env vars) is never blocked in the main checkout.
    const human = repo.commitIn(repo.path, { 'human.txt': 'ok\n' }, humanEnv)
    expect(human.status, human.stderr).toBe(0)
    // An agent shell is refused in the main checkout unless explicitly opted in.
    const head = repo.head(repo.path)
    const refused = repo.commitIn(repo.path, { 'notes.txt': 'main\n' }, { ...humanEnv, CLAUDECODE: '1' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('refusing agent commit in the main checkout')
    expect(repo.head(repo.path)).toBe(head)
    const allowed = repo.commitIn(repo.path, { 'notes.txt': 'main\n' }, { ...humanEnv, CLAUDECODE: '1', CANOPI_ALLOW_MAIN_CHECKOUT_COMMIT: '1' })
    expect(allowed.status, allowed.stderr).toBe(0)
  })
})

describe('commit-msg through the real hook', () => {
  const raiseEntry = (key: string) => {
    const path = join(repo.linked, 'policy/ratchets/suppressions.json')
    const family = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown> }
    family.entries[key] = { count: 1, bead: OPEN_BEAD }
    writeFileSync(path, `${JSON.stringify(family, null, 2)}\n`)
    git(repo.linked, 'add', 'policy/ratchets/suppressions.json')
  }
  const commit = (...args: string[]) => repo.commitIn(repo.linked, {}, {}, args)

  it('canopi-f47t.52.228.10: commit-msg refuses an attribution and makes no commit', () => {
    const head = repo.head()
    const run = repo.commitIn(repo.linked, { 'docs/a.md': '# A\n\nB.\n' }, {}, ['-m', `docs: b\n\n${ATTRIBUTION}`])
    expect(run.status).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('gate-no-attribution')
    expect(repo.head()).toBe(head)
  })

  it('canopi-f47t.52.228.10: commit-msg judges the staged tree and an amend against its parent', () => {
    raiseEntry('desktop/web/src/x.ts: oxlint:no-console')
    writeFileSync(join(repo.linked, 'policy/ratchets/suppressions.json'), '{}')
    let run = commit('-m', 'feat: an unauthorised raise')
    expect(run.status, 'the staged raise is judged, not the working tree').not.toBe(0)
    expect(run.stdout + run.stderr).toContain('gate-loosening-authority')
    git(repo.linked, 'checkout', 'HEAD', '--', 'policy/ratchets/suppressions.json')
    expect(commit('-m', 'chore: a staged unrelated change', '--allow-empty').status).toBe(0)
    raiseEntry('desktop/web/src/y.ts: oxlint:no-console')
    run = commit('--amend', '-m', 'chore: the amend sneaks a raise in')
    expect(run.status, run.stdout + run.stderr).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('y.ts')
  })

  it('canopi-gjpq: commit-msg judges net change so a route in an earlier branch commit passes the hook as it passes CI', () => {
    raiseEntry('desktop/web/src/x.ts: oxlint:no-console')
    let run = commit('-m', `feat: authorise suppression (${OPEN_BEAD}, ${M_ROW})`)
    expect(run.status, run.stdout + run.stderr).toBe(0)
    // A follow-up commit touching the same ratchet without repeating the route still passes via the earlier branch commit.
    raiseEntry('desktop/web/src/z.ts: oxlint:no-console')
    run = commit('-m', 'feat: follow-up in same file')
    expect(run.status, run.stdout + run.stderr).toBe(0)
  })

  it('canopi-gjpq: commit-msg counts MERGE_HEAD commits so merging an authorised branch passes the hook', () => {
    // Advance main with an authorised suppression raise, then merge origin/main into topic (--no-commit + commit).
    const mainRatchet = join(repo.path, 'policy/ratchets/suppressions.json')
    const family = JSON.parse(readFileSync(mainRatchet, 'utf8')) as { entries: Record<string, unknown> }
    family.entries['desktop/web/src/from-main.ts: oxlint:no-console'] = { count: 1, bead: OPEN_BEAD }
    writeFileSync(mainRatchet, `${JSON.stringify(family, null, 2)}\n`)
    git(repo.path, 'add', 'policy/ratchets/suppressions.json')
    const mainCommit = spawnSync('git', ['commit', '-q', '-m', `feat: main raise (${OPEN_BEAD}, ${M_ROW})`],
      { cwd: repo.path, encoding: 'utf8', env: repo.hookEnv({ CANOPI_ALLOW_MAIN_CHECKOUT_COMMIT: '1' }) })
    expect(mainCommit.status, mainCommit.stdout + mainCommit.stderr).toBe(0)
    repo.git('update-ref', 'refs/remotes/origin/main', repo.head(repo.path))
    // Make an unrelated commit on topic so the merge is a true two-parent merge.
    const topicCommit = repo.commitIn(repo.linked, { 'docs/a.md': '# A\n\nTopic.\n' })
    expect(topicCommit.status, topicCommit.stderr).toBe(0)
    git(repo.linked, 'merge', '--no-commit', '--no-ff', 'origin/main')
    const merged = commit('-m', 'merge: sync origin/main')
    expect(merged.status, merged.stdout + merged.stderr).toBe(0)
  })

  it('canopi-2ldj: commit-msg warns when a quote opened in a commit message is not closed on the same line', () => {
    const wrapped = repo.commitIn(repo.linked, { 'docs/a.md': '# A\n\nWrapped.\n' }, {},
      ['-m', "test: replaces 'wrapped title\ncontinued on next line'"])
    expect(wrapped.status, wrapped.stderr).toBe(0)
    expect(wrapped.stderr).toContain('canopi-2ldj')
    const plain = repo.commitIn(repo.linked, { 'docs/a.md': '# A\n\nPlain.\n' }, {},
      ['-m', "docs: it's fine when 'closed on one line'"])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stderr).not.toContain('canopi-2ldj')
  })

  it('canopi-f47t.52.228.54: unmounted: git commit -a in a fresh worktree with no install commits a docs change', () => {
    // A fresh worktree before npm ci: the gate reads TypeScript only for a changed test, so a docs commit goes through.
    const fresh = join(repo.root, 'fresh')
    repo.git('worktree', 'add', '-q', '-b', 'fresh', fresh)
    cpSync(join(repo.path, 'desktop/web/package.json'), join(fresh, 'desktop/web/package.json'))
    writeFileSync(join(fresh, 'docs/a.md'), '# A\n\nFresh.\n')
    const run = spawnSync('git', ['commit', '-q', '-a', '-m', 'docs: fresh'], { cwd: fresh, encoding: 'utf8', env: repo.hookEnv() })
    expect(run.status, run.stderr).toBe(0)
  })
})
