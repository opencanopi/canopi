// The agent hooks (agent-hooks.ts; 2.1-M196 refusals and SessionStart, 2.1-M219 stash asks, 2.1-M339 discards;
// canopi-f47t.52.228.10): PreToolUse JSON in, decision out; SessionStart warns, never blocks. Each case runs in a
// temporary layout: a canopi-like main worktree (the user's checkout) holding .rq-scratch/phase-0 (a linked worktree)
// and .rq-scratch/tools (another repository), with CLAUDE_PROJECT_DIR naming the main worktree. Ported from
// scripts/test_agent_hooks.py (2.1-M349); the input and stdout cases run the real entry.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { preToolUse, sessionStart } from './agent-hooks.ts'
import { cleanEnv, ENTRY, git, REPO_ROOT } from './planted-repo.ts'

const HUSKY_PACKAGE = { name: 'web', scripts: { prepare: 'cd ../.. && husky desktop/web/.husky' } }
const PLAIN_PACKAGE = { name: 'web', scripts: { test: 'vitest' } }

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.invalid')
  git(path, 'config', 'user.name', 'test')
  writeFileSync(join(path, 'README.md'), 'x\n')
  git(path, 'add', 'README.md')
  git(path, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init')
}

function writePackage(worktree: string, manifest: object): void {
  mkdirSync(join(worktree, 'desktop/web'), { recursive: true })
  writeFileSync(join(worktree, 'desktop/web/package.json'), JSON.stringify(manifest))
}

/** The user's checkout with a linked worktree and a separate tools repository inside .rq-scratch. */
class Layout {
  readonly root = mkdtempSync(join(tmpdir(), 'canopi-agent-hooks-'))
  readonly main = join(this.root, 'canopi')
  readonly linked = join(this.main, '.rq-scratch/phase-0')
  readonly tools = join(this.main, '.rq-scratch/tools')
  readonly old = join(this.main, '.rq-scratch/wt-old')

  constructor() {
    makeRepo(this.main)
    git(this.main, 'worktree', 'add', '-q', '-b', 'phase-0', this.linked)
    makeRepo(this.tools)
    git(this.main, 'worktree', 'add', '-q', '-b', 'old', this.old)
    writePackage(this.old, HUSKY_PACKAGE)
    writePackage(this.linked, PLAIN_PACKAGE)
    // origin/main is the checkout's first commit; a tag on it, and one on a commit only the linked worktree holds.
    git(this.main, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(this.main, 'tag', 'on-main')
    git(this.linked, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'unmerged')
    git(this.linked, 'tag', '-a', '-m', 'x', 'off-main')
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

const hookEnv = (project: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(Object.entries(cleanEnv()).filter(([name]) => name !== 'HUSKY' && name !== 'CLAUDE_PROJECT_DIR'))
  return { ...env, CLAUDE_PROJECT_DIR: project, ...extra }
}

/** The real entry in `mode`, with `stdin`. */
const runHook = (mode: string, stdin: string, project: string) => spawnSync(process.execPath, [ENTRY, 'agent-hook', mode],
  { cwd: REPO_ROOT, input: stdin, encoding: 'utf8', env: hookEnv(project), timeout: 60_000 })

let layout: Layout | undefined
const at = () => layout as Layout

/** The decision and the rule its reason names for a Bash call; ['pass', ''] when the hook says nothing. */
function decide(command: string, cwd?: string, env: Readonly<Record<string, string>> = {}): [string, string, string] {
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: cwd ?? at().linked, tool_input: { command } }
  const out = preToolUse(JSON.stringify(payload), REPO_ROOT, hookEnv(at().main, env))
  if (!out.trim()) return ['pass', '', '']
  const decided = (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string, permissionDecision: string,
    permissionDecisionReason: string } }).hookSpecificOutput
  if (decided.hookEventName !== 'PreToolUse') throw new Error(`hookEventName ${decided.hookEventName}`)
  const reason = decided.permissionDecisionReason
  return [decided.permissionDecision, /^\[([a-z0-9-]+)\] /.exec(reason)?.[1] ?? '', reason]
}
/** [decision, rule]. */
const verdict = (command: string, cwd?: string, env?: Readonly<Record<string, string>>) => decide(command, cwd, env).slice(0, 2)
const reasonOf = (command: string, cwd?: string) => decide(command, cwd)[2]

describe('the agent hooks over a planted checkout (canopi-f47t.52.228.10)', () => {
  beforeAll(() => { layout = new Layout() })
  // A suite that plants no layout leaves none to clean up (canopi-f47t.52.228.54).
  afterAll(() => {
    layout?.cleanup()
    layout = undefined
  })

  describe('deny: the commands that skip or remove the commit gate, create a stash, or commit in the user\'s checkout', () => {
    it('canopi-f47t.52.228.10: --no-verify is refused', () => {
      for (const command of ['git commit --no-verify -m x', 'git commit -n -m x', 'git commit -anm x', 'git push --no-verify',
        'git merge --no-verify topic', 'git commit --no-veri -m x']) expect(verdict(command), command).toEqual(['deny', 'hook-no-verify'])
      expect(reasonOf('git commit --no-verify -m x')).toContain('pre-commit gate')
    })

    it('canopi-f47t.52.228.10: a plumbing commit is refused', () => {
      expect(verdict('git commit-tree HEAD^{tree} -m x')).toEqual(['deny', 'hook-plumbing-commit'])
    })

    it('canopi-f47t.52.228.10: HUSKY=0 before git is refused', () => {
      expect(verdict('HUSKY=0 git commit -m x')).toEqual(['deny', 'hook-husky-skip'])
      expect(verdict('export HUSKY=0 && git commit -m x')).toEqual(['deny', 'hook-husky-skip'])
      expect(verdict('env HUSKY=0 git commit -m x')).toEqual(['deny', 'hook-husky-skip'])
    })

    it('canopi-f47t.52.228.10: a hooks path override is refused', () => {
      for (const command of ['git -c core.hooksPath=/dev/null commit -m x', 'git config core.hooksPath x',
        'git config --local core.hookspath .husky', 'git config --unset core.hooksPath', 'git config set core.hooksPath x',
        'npx husky', 'npx -y husky@9 desktop/web/.husky']) expect(verdict(command), command).toEqual(['deny', 'hook-hooks-path-override'])
      expect(verdict('git config --get core.hooksPath')).toEqual(['pass', ''])
      expect(verdict('git config core.hooksPath')).toEqual(['pass', ''])
    })

    it('canopi-f47t.52.228.10: bd hooks install into a beads hooks path is refused', () => {
      // `bd hooks install --beads` or `--shared` points core.hooksPath at .beads/hooks or .beads-hooks.
      for (const command of ['bd hooks install --beads', 'bd hooks install --shared', 'cd x && bd --no-daemon hooks install --shared']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-hooks-path-override'])
      }
      for (const command of ['bd hooks list', 'bd ready', 'bd show canopi-1 --json']) expect(verdict(command), command).toEqual(['pass', ''])
    })

    it('canopi-f47t.52.228.10: restoring the .githooks path passes', () => {
      // SessionStart's fix for a drifted core.hooksPath is a command the agent may run.
      for (const command of ['git config core.hooksPath .githooks', 'git config --local core.hooksPath .githooks',
        'git config set core.hooksPath .githooks']) expect(verdict(command), command).toEqual(['pass', ''])
      for (const command of ['git config --global core.hooksPath .githooks', 'git config --add core.hooksPath .githooks',
        'git config --replace-all core.hooksPath .githooks', 'git config core.hooksPath ./.githooks']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-hooks-path-override'])
      }
    })

    it('canopi-f47t.52.228.10: creating a stash is refused', () => {
      for (const command of ['git stash', 'git stash push -m wip', 'git stash save wip', 'git stash -u']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-bare-stash'])
      }
      expect(reasonOf('git stash')).toContain('WIP commit')
    })

    it('canopi-f47t.52.228.10: a commit in the user\'s checkout is refused', () => {
      const main = at().main
      expect(verdict('git commit -m x', main)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict(`git -C ${main} commit -m x`)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict(`cd ${main} && git commit -m x`)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict('cd ../.. && git commit -m x')).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict('git merge topic', main)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict('git merge --no-ff topic', main)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(reasonOf('git commit -m x', main)).toContain('worktree')
    })

    it('canopi-f47t.52.228.10: an install running husky\'s prepare is refused', () => {
      const web = join(at().old, 'desktop/web')
      expect(verdict('npm ci', web)).toEqual(['deny', 'hook-old-husky-install'])
      expect(verdict('npm install', web)).toEqual(['deny', 'hook-old-husky-install'])
      expect(verdict(`cd ${web} && npm i`)).toEqual(['deny', 'hook-old-husky-install'])
      expect(reasonOf('npm ci', web)).toContain('HUSKY=0 npm ci')
      expect(verdict('HUSKY=0 npm ci', web)).toEqual(['pass', ''])
      expect(verdict('npm ci', join(at().linked, 'desktop/web'))).toEqual(['pass', ''])
    })
  })

  describe('deny with a chat ask: commands that discard user work (2.1-M339)', () => {
    // An ask may not prompt in a bypass or headless session, and the user can run the command themselves with `!`.
    it('canopi-f47t.52.228.10: reset --hard is denied with a chat ask', () => {
      expect(verdict('git reset --hard HEAD~1')).toEqual(['deny', 'hook-reset-hard'])
      expect(reasonOf('git reset --hard HEAD~1')).toContain('ask the user in chat')
      expect(reasonOf('git reset --hard HEAD~1')).toContain('`!`')
      expect(verdict('git reset --soft HEAD~1')).toEqual(['pass', ''])
    })

    it('canopi-f47t.52.228.10: discards are denied with a chat ask', () => {
      for (const command of ['git checkout -- f.txt', 'git checkout -f main', 'git restore f.txt', 'git restore --worktree f.txt',
        'git clean -fd', 'git clean -xdf', 'git clean --force']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-discard'])
        expect(reasonOf(command), command).toContain('ask the user in chat')
      }
      expect(verdict('git restore --staged f.txt')).toEqual(['pass', ''])
      expect(verdict('git clean -n')).toEqual(['pass', ''])
      expect(verdict('git checkout -b topic')).toEqual(['pass', ''])
    })
  })

  it('canopi-f47t.52.228.10: changes to the shared stash stack ask (2.1-M219)', () => {
    for (const command of ['git stash pop', 'git stash apply stash@{1}', 'git stash drop', 'git stash clear']) {
      expect(verdict(command), command).toEqual(['ask', 'hook-stash-stack-asks'])
    }
  })

  describe('the pre-push stamp and tags (2.1-Q266, 2.1-Q270)', () => {
    it('canopi-f47t.52.228.54: a write to the stamp directory is refused, from Bash or a file tool; a read passes', () => {
      for (const command of ['echo {} > .git/canopi-gate/abc.json', "printf x >> '../.git/canopi-gate/abc.json'",
        'cp stamp.json "$(git rev-parse --git-common-dir)"/canopi-gate/abc.json', 'touch /repo/.git/canopi-gate/abc.json',
        'rm -rf .git/canopi-gate', 'mkdir -p .git/canopi-gate', "node -e 'x' .git/canopi-gate/a.json"]) {
        expect(verdict(command), command).toEqual(['deny', 'hook-stamp-write'])
      }
      for (const command of ['cat .git/canopi-gate/abc.json', 'ls .git/canopi-gate', 'git rev-parse --git-path canopi-gate',
        'jq .sha .git/canopi-gate/abc.json', 'node policy/gate/cli.mjs push --base origin/main']) {
        expect(verdict(command), command).toEqual(['pass', ''])
      }
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        const payload = { hook_event_name: 'PreToolUse', tool_name: tool, cwd: at().linked,
          tool_input: { file_path: join(at().main, '.git/canopi-gate/abc.json') } }
        expect(preToolUse(JSON.stringify(payload), REPO_ROOT, hookEnv(at().main)), tool).toContain('[hook-stamp-write] ')
      }
      expect(reasonOf('echo {} > .git/canopi-gate/a.json')).toContain('node policy/gate/cli.mjs push')
    })

    it('canopi-f47t.52.228.54: a stamp path held in a variable or the directory is refused; cd, gh and bd mentioning it pass', () => {
      for (const command of ['d=.git/canopi-gate; cp /tmp/fake.json $d/abc.json', 'd=canopi-gate; echo {} > .git/$d/a.json',
        'd=.git/canopi-gate cp /tmp/fake.json "$d"/abc.json', 'cd .git/canopi-gate && cp /tmp/fake.json abc.json',
        'cd .git/canopi-gate; echo {} > abc.json']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-stamp-write'])
      }
      for (const command of ['cd .git/canopi-gate && ls', 'gh pr create --title x --body "see .git/canopi-gate/ stamps"',
        'bd create --description "path .git/canopi-gate/x"', 'bd comment x "the stamp .git/canopi-gate/abc.json"']) {
        expect(verdict(command), command).toEqual(['pass', ''])
      }
    })

    it('canopi-f47t.52.228.54: a tag push is refused unless the tag\'s commit is on origin/main', () => {
      for (const command of ['git push origin off-main', 'git push origin refs/tags/off-main', 'git push origin tag off-main',
        'git push --tags', 'git push --follow-tags origin', 'git push origin +off-main:refs/tags/off-main']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-tag-push'])
      }
      for (const command of ['git push origin on-main', 'git push origin refs/tags/on-main', 'git push origin :refs/tags/off-main',
        'git push origin HEAD', 'git push -u origin phase-0', 'scripts/promote-release.sh --run-id 1 --tag off-main --title x']) {
        expect(verdict(command), command).toEqual(['pass', ''])
      }
      expect(reasonOf('git push origin off-main')).toContain('origin/main')
    })
  })

  describe('pass: reads, mentions in text, other repositories, linked worktrees and fast-forward updates', () => {
    it('canopi-f47t.52.228.10: reads and mentions pass', () => {
      for (const command of ['git log --oneline', 'git stash list', 'git stash show -p', 'grep -- --no-verify AGENTS.md',
        'git commit -m "text naming --no-verify"', "git commit -m 'no -n here'", 'git commit -F msg.txt --author "A <a@b>"']) {
        expect(verdict(command), command).toEqual(['pass', ''])
      }
    })

    it('canopi-f47t.52.228.10: other repositories and linked worktrees pass', () => {
      const main = at().main
      expect(verdict('git commit -m x', at().linked)).toEqual(['pass', ''])
      expect(verdict('git -C .rq-scratch/tools commit -m x', main)).toEqual(['pass', ''])
      expect(verdict('cd .rq-scratch/phase-0 && git commit -m x', main)).toEqual(['pass', ''])
      expect(verdict('git -C .rq-scratch/phase-0 merge topic', main)).toEqual(['pass', ''])
    })

    it('canopi-f47t.52.228.10: fast-forward updates of the checkout pass', () => {
      for (const command of ['git fetch', 'git pull --ff-only', 'git merge --ff-only origin/main',
        'git worktree add .rq-scratch/wt-x -b wt/x', 'git worktree remove .rq-scratch/wt-x', 'git status']) {
        expect(verdict(command, at().main), command).toEqual(['pass', ''])
      }
    })

    it('canopi-f47t.52.228.10: other tools pass, through the real entry', () => {
      expect(verdict('ls -la')).toEqual(['pass', ''])
      const payload = { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: at().main, tool_input: { file_path: 'x' } }
      const run = runHook('pre-tool-use', JSON.stringify(payload), at().main)
      expect([run.status, run.stdout.trim(), run.stderr]).toEqual([0, '', ''])
    })
  })

  describe('parsing: chains, prefixes, one level of shell -c, and fail-closed answers for what it cannot parse', () => {
    it('canopi-f47t.52.228.10: chains are split', () => {
      for (const command of ['git status && git commit --no-verify -m x', 'false || git commit -n -m x',
        'git add . ; git commit --no-verify -m x', 'echo x | git commit --no-verify -F -', 'git add .\ngit commit --no-verify -m x',
        '(cd sub && git commit --no-verify -m x)']) expect(verdict(command), command).toEqual(['deny', 'hook-no-verify'])
    })

    it('canopi-f47t.52.228.10: prefixes are skipped', () => {
      expect(verdict('GIT_AUTHOR_NAME=x git commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
      expect(verdict('env FOO=1 git commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
      expect(verdict('time git reset --hard')).toEqual(['deny', 'hook-reset-hard'])
    })

    it('canopi-f47t.52.228.10: one level of shell -c is read', () => {
      for (const shell of ['sh -c', 'bash -c', 'bash -lc']) {
        expect(verdict(`${shell} 'git commit --no-verify -m x'`), shell).toEqual(['deny', 'hook-no-verify'])
      }
      expect(verdict("bash -c 'git log'")).toEqual(['pass', ''])
      expect(verdict(`bash -c "sh -c 'git log'" `)[0]).toBe('ask')
    })

    it('canopi-f47t.52.228.10: heredoc bodies are text unless a shell reads them', () => {
      const body = "fix: the hook's message\n\nIt names --no-verify; git stash and HUSKY=0 git commit are text.\n"
      expect(verdict(`git commit -F - <<'EOF'\n${body}EOF\ngit log -1`)).toEqual(['pass', ''])
      expect(verdict(`git commit -m "$(cat <<'EOF'\n${body}EOF\n)"`)).toEqual(['pass', ''])
      expect(verdict(`git commit --no-verify -F - <<'EOF'\n${body}EOF`)).toEqual(['deny', 'hook-no-verify'])
      expect(verdict(`git commit -F - <<EOF\n${body}EOF\ngit stash`)).toEqual(['deny', 'hook-bare-stash'])
      expect(verdict("bash <<'EOF'\ngit commit --no-verify -m x\nEOF")).toEqual(['deny', 'hook-no-verify'])
    })

    it('canopi-f47t.52.228.10: comments end at the newline and start only a word', () => {
      expect(verdict('git add -A # stage\ngit commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
      expect(verdict('git add -A  # stage all\ngit reset --hard HEAD')).toEqual(['deny', 'hook-reset-hard'])
      expect(verdict('# a note <<EOF\ngit commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
      for (const command of ['echo a#b; git commit --no-verify -m x', 'git log --format=%h#x && git commit --no-verify -m x',
        'curl https://x/#a; git commit --no-verify']) expect(verdict(command), command).toEqual(['deny', 'hook-no-verify'])
      expect(verdict('git log -1 # git commit --no-verify -m x')).toEqual(['pass', ''])
      expect(verdict("git commit -m 'issue #12' # --no-verify")).toEqual(['pass', ''])
    })

    it('canopi-f47t.52.228.10: unparseable input asks and never crashes, through the real entry', () => {
      expect(verdict('git commit -m "unbalanced')[0]).toBe('ask')
      const run = runHook('pre-tool-use', '{not json', at().main)
      expect(run.status, run.stderr).toBe(0)
      expect((JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('ask')
    })
  })
})

describe('SessionStart prints a warning when the hooks would not run; nothing when all is well; it never blocks', () => {
  let repo: string | undefined
  const start = (env: Readonly<Record<string, string>> = {}) => sessionStart(JSON.stringify({ hook_event_name: 'SessionStart',
    cwd: repo, source: 'startup' }), REPO_ROOT, hookEnv(repo ?? '', env))
  beforeEach(() => {
    repo = join(mkdtempSync(join(tmpdir(), 'canopi-session-')), 'canopi')
    makeRepo(repo)
    mkdirSync(join(repo, '.githooks'))
    writeFileSync(join(repo, '.githooks/pre-commit'), '#!/bin/sh\n')
    writeFileSync(join(repo, '.githooks/pre-push'), '#!/bin/sh\n')
    git(repo, 'config', 'core.hooksPath', '.githooks')
    writePackage(repo, PLAIN_PACKAGE)
  })
  // A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
  afterEach(() => {
    if (repo) rmSync(join(repo, '..'), { recursive: true, force: true })
    repo = undefined
  })

  it('canopi-f47t.52.228.10: session start is silent when the hooks run', () => {
    expect(start().trim()).toBe('')
  })

  it('canopi-f47t.52.228.10: session start warns on another hooks path', () => {
    const at = repo ?? ''
    git(at, 'config', 'core.hooksPath', 'desktop/web/.husky/_')
    expect(start()).toContain('git config core.hooksPath .githooks')
    const fix = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: at, tool_input: { command: 'git config core.hooksPath .githooks' } }
    expect(preToolUse(JSON.stringify(fix), REPO_ROOT, hookEnv(at)).trim(), 'the warning\'s fix is allowed').toBe('')
    git(at, 'config', '--unset', 'core.hooksPath')
    expect(start()).toContain('core.hooksPath')
  })

  it('canopi-f47t.52.228.54: session start names the pre-push hook, and warns on a worktree without it', () => {
    git(repo ?? '', 'config', 'core.hooksPath', 'desktop/web/.husky/_')
    expect(start()).toContain('the pre-commit and pre-push hooks do not run')
    git(repo ?? '', 'config', 'core.hooksPath', '.githooks')
    rmSync(join(repo ?? '', '.githooks/pre-push'))
    expect(start()).toContain('has no .githooks/pre-push: a push from here verifies no pre-push stamp')
    writeFileSync(join(repo ?? '', '.githooks/pre-push'), '#!/bin/sh\n')
    expect(start().trim()).toBe('')
  })

  it('canopi-f47t.52.228.10: session start warns on a worktree without .githooks', () => {
    rmSync(join(repo ?? '', '.githooks'), { recursive: true })
    expect(start()).toContain('.githooks')
  })

  it('canopi-f47t.52.228.10: session start warns on husky\'s prepare without HUSKY=0', () => {
    writePackage(repo ?? '', HUSKY_PACKAGE)
    expect(start()).toContain('HUSKY=0')
    expect(start({ HUSKY: '0' }).trim()).toBe('')
  })

  it('canopi-f47t.52.228.10: session start never blocks on garbage, through the real entry', () => {
    const run = runHook('session-start', 'garbage', repo ?? '')
    expect(run.status, run.stderr).toBe(0)
  })
})
