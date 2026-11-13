// The agent hooks (agent-hooks.ts; 2.1-M196 gate bypasses and SessionStart, 2.1-M339 discards, cut to plain refusals
// that never prompt by 2.1-Q331; canopi-f47t.52.228.10): PreToolUse JSON in, a deny or nothing out; SessionStart warns,
// never blocks. Each case runs in a temporary layout: a canopi-like main worktree (the user's checkout) holding
// .rq-scratch/phase-0 (a linked worktree) and .rq-scratch/tools (another repository), with CLAUDE_PROJECT_DIR naming the
// main worktree; the input and stdout cases run the real entry.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { preToolUse, programAt, scan, sessionStart } from './agent-hooks.ts'
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

  constructor() {
    makeRepo(this.main)
    git(this.main, 'worktree', 'add', '-q', '-b', 'phase-0', this.linked)
    makeRepo(this.tools)
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

// The commands the user's checkout refuses and a linked worktree lets through (2.1-Q331), with each one's rule.
const CHECKOUT_ONLY: readonly [string, string][] = [
  ['git commit -m x', 'hook-user-checkout-commit'], ['git commit -qam "fix: y"', 'hook-user-checkout-commit'],
  ['git reset --hard HEAD~1', 'hook-reset-hard'], ['git reset --har', 'hook-reset-hard'],
  ['git checkout -- f.txt', 'hook-discard'], ['git checkout HEAD -- src', 'hook-discard'], ['git restore f.txt', 'hook-discard'],
  ['git restore --staged --worktree f.txt', 'hook-discard'], ['git clean -fd', 'hook-discard'], ['git clean -xdf', 'hook-discard'],
  ['git clean --force', 'hook-discard'], ['git stash push -m tag', 'hook-bare-stash'], ['git stash apply stash@{1}', 'hook-bare-stash'],
  ['git stash drop stash@{1}', 'hook-bare-stash'],
]

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

    it('canopi-f47t.52.228.10: HUSKY=0 before git is refused', () => {
      expect(verdict('HUSKY=0 git commit -m x')).toEqual(['deny', 'hook-husky-skip'])
      expect(verdict('export HUSKY=0 && git commit -m x')).toEqual(['deny', 'hook-husky-skip'])
      expect(verdict('env HUSKY=0 git commit -m x')).toEqual(['deny', 'hook-husky-skip'])
    })

    it('a hooks path override by -c or a git config write is refused in any worktree (2.1-Q331)', () => {
      for (const cwd of [at().linked, at().main, at().tools]) {
        for (const command of ['git -c core.hooksPath=/dev/null commit -m x', 'git -c Core.HooksPath= push', 'git config core.hooksPath x',
          'git config --local core.hookspath .husky', 'git config --unset core.hooksPath', 'git config set core.hooksPath x',
          'git config unset core.hooksPath', 'git config --global core.hooksPath /tmp/h']) {
          expect(verdict(command, cwd), `${command} in ${cwd}`).toEqual(['deny', 'hook-hooks-path-override'])
        }
      }
      for (const command of ['git config --get core.hooksPath', 'git config core.hooksPath', 'git config get core.hooksPath',
        'git -c color.ui=never log']) expect(verdict(command), command).toEqual(['pass', ''])
      expect(reasonOf('git config core.hooksPath x')).toContain('git config core.hooksPath .githooks')
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

    it('a bare stash, a pop, a drop of the top entry or a clear is refused in any worktree; a tagged push, a list and an apply by name pass (2.1-Q331)', () => {
      for (const cwd of [at().linked, at().tools]) {
        for (const command of ['git stash', 'git stash -u', 'git stash push', 'git stash push -u', 'git stash save', 'git stash pop',
          'git stash pop stash@{0}', 'git stash drop', 'git stash clear', 'nice -n 5 git stash']) {
          expect(verdict(command, cwd), `${command} in ${cwd}`).toEqual(['deny', 'hook-bare-stash'])
        }
        for (const command of ['git stash push -u -m "wt-hook tag"', 'git stash push -mtag', 'git stash push --message=tag',
          'git stash -m tag', 'git stash save wip', 'git stash list', "git stash list --format='%H %gs'", 'git stash show -p',
          'git stash apply 0123abcd', 'git stash drop stash@{2}']) {
          expect(verdict(command, cwd), `${command} in ${cwd}`).toEqual(['pass', ''])
        }
      }
      expect(reasonOf('git stash')).toContain('WIP commit')
      expect(reasonOf('git stash')).toContain('git stash push -m')
    })

    it('a commit, a reset --hard, a discard or a stash in the user\'s checkout is denied, by its cwd, cd or -C (2.1-Q331)', () => {
      const { main, linked } = at()
      for (const [command, rule] of CHECKOUT_ONLY) {
        expect(verdict(command, main), command).toEqual(['deny', rule])
        expect(verdict(command.replace(/^git /, `git -C ${main} `), linked), `-C ${command}`).toEqual(['deny', rule])
        expect(verdict(`cd ${main} && ${command}`, linked), `cd ${command}`).toEqual(['deny', rule])
        expect(verdict(`cd ../.. && ${command}`, linked), `cd ../.. ${command}`).toEqual(['deny', rule])
      }
      expect(verdict(`cd ${linked} && git commit -m x`, main)).toEqual(['pass', ''])
      expect(verdict(`cd ${main} && cd ${linked} && git commit -m x`, linked)).toEqual(['pass', ''])
      expect(reasonOf('git commit -m x', main)).toContain('worktree')
      for (const command of ['git reset --hard', 'git checkout -- f.txt', 'git stash push -m tag']) {
        expect(reasonOf(command, main), command).toContain('ask the user in chat; they run it with `!`')
      }
      for (const command of ['git reset --soft HEAD~1', 'git restore --staged f.txt', 'git restore -S f.txt', 'git clean -n',
        'git checkout -b topic', 'git checkout main', 'git stash list', 'git stash show']) {
        expect(verdict(command, main), command).toEqual(['pass', ''])
      }
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

    it('a linked worktree or another repository lets the checkout-only refusals through (2.1-Q331)', () => {
      for (const cwd of [at().linked, at().tools]) {
        for (const [command] of CHECKOUT_ONLY) expect(verdict(command, cwd), `${command} in ${cwd}`).toEqual(['pass', ''])
      }
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

  describe('never a prompt: a refusal is a deny naming what to do instead, and what the hook cannot read passes (2.1-Q331)', () => {
    it('a substitution, loop, subshell, group or here-document mentioning git passes with no output', () => {
      for (const cwd of [at().linked, at().main]) {
        for (const command of ['echo "$(git rev-parse HEAD)"', 'cd "$(git rev-parse --show-toplevel)" && ls',
          'for f in a b; do git log -1 -- "$f"; done', 'while read -r l; do git show "$l"; done < list.txt', '(git status)',
          '{ git status; }', 'git log --since="$(date)" -3', "bash <<'EOF'\ngit status\nEOF", 'git -C "$R" status',
          `git push origin HEAD:v1`, 'git push --tags', "git -c alias.r='status' r", 'git commit-tree HEAD^{tree} -m x' ]) {
          expect(verdict(command, cwd), `${command} in ${cwd}`).toEqual(['pass', ''])
        }
      }
      // A commit message in a quoted here-document is text: words in it are never read as commands.
      expect(verdict(`git commit -m "$(cat <<'EOF'\nfix: says git stash and git reset --hard and --no-verify\nEOF\n)"`)).toEqual(['pass', ''])
      expect(verdict("git commit -F - <<'EOF'\nfix: x\ngit stash\ngit config core.hooksPath x\nEOF")).toEqual(['pass', ''])
      // What lies outside a substitution is still read.
      expect(verdict('echo "$(date)"; git stash')).toEqual(['deny', 'hook-bare-stash'])
      expect(verdict(`git commit -m "$(cat <<'EOF'\nfix: x\nEOF\n)"`, at().main)).toEqual(['deny', 'hook-user-checkout-commit'])
    })

    it('no answer is ever ask: each refusal is a deny whose reason says what to do instead', () => {
      const { main, linked } = at()
      const commands = ['git stash', 'git stash pop', 'git commit --no-verify -m x', 'HUSKY=0 git push', 'git config core.hooksPath x',
        'echo "$(git reset --hard)"', 'git reset `echo --hard`', 'popd && git commit -m x', 'cd ~nobody && git commit -m x',
        'git --git-dir=x commit -m x', 'GIT_DIR=x git commit -m x', 'git commit -m "unbalanced', 'eval "git reset --hard"',
        'echo {} > .git/canopi-gate/a.json', 'npm ci', 'npx husky', 'bd hooks install --shared', ...CHECKOUT_ONLY.map(([c]) => c)]
      for (const cwd of [main, linked]) {
        for (const command of commands) {
          const [answer, , reason] = decide(command, cwd)
          expect(['pass', 'deny'], `${command} in ${cwd}`).toContain(answer)
          if (answer === 'deny') expect(reason, command).toMatch(/instead|rewrite|ask the user in chat|worktree under \.rq-scratch/)
        }
      }
      for (const tool of ['Write', 'Edit']) {
        const payload = { hook_event_name: 'PreToolUse', tool_name: tool, cwd: linked, tool_input: { file_path: join(main, '.git/canopi-gate/a.json') } }
        expect(preToolUse(JSON.stringify(payload), REPO_ROOT, hookEnv(main)), tool).toBe('')
      }
    })

    it('HUSKY= counts only as the git command\'s own prefix or an export before it; in text or before another program it passes (2.1-Q331)', () => {
      for (const command of ['HUSKY=0 git commit -m x', 'env HUSKY=0 git push', 'X=1 HUSKY=0 git commit -m x', 'export HUSKY=0 && git commit -m x',
        'export A=1 HUSKY=0; git push']) expect(verdict(command), command).toEqual(['deny', 'hook-husky-skip'])
      for (const command of ['git commit -m "HUSKY=0 is gone"', 'HUSKY=0 npm ci && git commit -m x', 'echo HUSKY=0 >> notes; git push',
        'HUSKY=0 git status', 'git log --grep HUSKY=0']) expect(verdict(command), command).toEqual(['pass', ''])
    })

    it('a unique prefix of --no-verify, --hard or --force is read as that option (2.1-Q331)', () => {
      expect(verdict('git commit --no-veri -m x')).toEqual(['deny', 'hook-no-verify'])
      expect(verdict('git push --no-v')).toEqual(['deny', 'hook-no-verify'])
      expect(verdict('git reset --har', at().main)).toEqual(['deny', 'hook-reset-hard'])
      expect(verdict('git clean --forc', at().main)).toEqual(['deny', 'hook-discard'])
      expect(verdict('git checkout --forc main', at().main)).toEqual(['deny', 'hook-discard'])
      expect(verdict('git commit --no-m -m x')).toEqual(['pass', ''])
    })

    it('git config writing core.hooksPath in any scope, by a verb or by --unset, --add or --replace-all is refused (2.1-Q331)', () => {
      for (const command of ['git config --global core.hooksPath x', 'git config --system core.hooksPath x', 'git config --worktree core.hooksPath x',
        'git config --add core.hooksPath x', 'git config --replace-all core.hooksPath x', 'git config --unset-all core.hooksPath',
        'git config set --global core.hooksPath .githooks', 'git config unset core.hooksPath']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-hooks-path-override'])
      }
      for (const command of ['git config --show-origin core.hooksPath', 'git config --get-all core.hooksPath', 'git config list']) {
        expect(verdict(command), command).toEqual(['pass', ''])
      }
    })

    it('--no-verify counts only on a git command that runs hooks; a log or grep naming it passes (2.1-Q331)', () => {
      for (const command of ['git commit --no-verify -m x', 'git push --no-verify', 'git merge --no-verify topic', 'git am --no-verify x.patch',
        'git rebase --no-verify main', 'git cherry-pick --no-verify abc', 'git revert --no-verify abc', 'git pull --no-verify']) {
        expect(verdict(command), command).toEqual(['deny', 'hook-no-verify'])
      }
      for (const command of ['git log --grep "--no-verify"', 'git log --grep=--no-verify', 'git grep -- --no-verify', 'git show --no-verify']) {
        expect(verdict(command), command).toEqual(['pass', ''])
      }
    })

    it('a cd inside a substitution or a subshell never moves the directory a later git command runs in (2.1-Q331)', () => {
      const { main, linked } = at()
      for (const command of [`(cd ${linked} && npm test); git commit -m x`, `echo "$(cd ${linked})"; git commit -m x`,
        `git commit -m "$(cd ${linked})"`, `echo \`cd ${linked}\`; git commit -m x`, `(cd ${linked}) && git reset --hard`]) {
        expect(verdict(command, main)[0], command).toBe('deny')
      }
      expect(verdict(`(cd ${main} && git commit -m x)`, linked)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict(`(cd ${main} && ls); git commit -m x`, linked)).toEqual(['pass', ''])
      expect(verdict(`cd ${linked} && (git status) && git commit -m x`, main)).toEqual(['pass', ''])
    })

    it('cd and pushd to a literal path are followed; popd, cd - and a path it cannot expand leave the directory unknown, so the command passes (2.1-Q331)', () => {
      const { main, linked } = at()
      for (const command of [`cd -P ${main} && git commit -m x`, `cd -L -- ${main} && git commit -m x`, `pushd ${main} && git commit -m x`,
        'cd && cd ' + main + ' && git commit -m x', `cd $HOME && cd ${main} && git commit -m x`]) {
        expect(verdict(command, linked), command).toEqual(['deny', 'hook-user-checkout-commit'])
      }
      for (const command of ['popd && git commit -m x', 'cd - && git commit -m x', 'cd ~nobody/canopi && git commit -m x',
        'cd "$R" && git commit -m x', `git --git-dir=${main}/.git commit -m x`, `git --work-tree ${main} commit -m x`, `pushd ${linked} && git commit -m x`]) {
        expect(verdict(command, main), command).toEqual(['pass', ''])
      }
    })

    it('a git command behind wrappers, assignments and reserved words is read (2.1-Q331)', () => {
      for (const command of ['time -p git reset --hard', 'timeout -s KILL 10 git reset --hard', 'nice -n 5 git reset --hard',
        'env -i -u X git reset --hard', 'command -p git reset --hard', 'nohup -- git reset --hard', 'X=1 git reset --hard',
        'timeout 600 systemd-run --user --scope -q -p MemoryMax=3G git reset --hard', 'if true; then git reset --hard; fi',
        'for x in a; do git reset --hard; done', '{ git reset --hard; }', '! git reset --hard']) {
        expect(verdict(command, at().main), command).toEqual(['deny', 'hook-reset-hard'])
      }
      for (const command of ['echo git reset --hard', 'grep git reset --hard', 'command -v git']) {
        expect(verdict(command, at().main), command).toEqual(['pass', ''])
      }
    })

    it('a brace or glob in an argument is read as written, so the refusals still answer (2.1-Q331)', () => {
      const { main } = at()
      expect(verdict('git checkout -- src/{a,b}.ts', main)).toEqual(['deny', 'hook-discard'])
      expect(verdict('git restore src/*.ts', main)).toEqual(['deny', 'hook-discard'])
      expect(verdict('git stash && echo {a,b}')).toEqual(['deny', 'hook-bare-stash'])
      expect(verdict(`cd ${main} && git commit -m x && ls {a,b}`)).toEqual(['deny', 'hook-user-checkout-commit'])
      expect(verdict('git add x/{a,b}.rs && git commit -qm "fix: y"')).toEqual(['pass', ''])
    })

    it('an attached option value is no flag: checkout -bfoo and clean -e f are no force (2.1-Q331)', () => {
      for (const command of ['git checkout -bfix', 'git checkout -b force', 'git clean -e f -n', 'git clean -ef']) {
        expect(verdict(command, at().main), command).toEqual(['pass', ''])
      }
      expect(verdict('git checkout -f main', at().main)).toEqual(['deny', 'hook-discard'])
    })

    it('the most frequent real shapes pass: a commit staging paths by braces, a wait loop timing itself over substitutions (2.1-Q331)', () => {
      expect(verdict('git add desktop/src/services/lidar/{admission,engine}.rs && git commit -qm "refactor(desktop): the probe\'s chain" '
        + '&& git log --oneline -1 && git diff HEAD~1 --stat | tail -1')).toEqual(['pass', ''])
      expect(verdict('until [ -s /tmp/x/n.md ] && [ $(( $(date +%s) - $(stat -c %Y /tmp/x/n.md) )) -gt 90 ]; do sleep 15; done; echo ready'))
        .toEqual(['pass', ''])
      expect(verdict('s=$(head -1 start.txt); echo "elapsed min: $(( ($(date +%s)-s)/60 ))"; uptime')).toEqual(['pass', ''])
    })

    it('unparseable input passes and never crashes, through the real entry', () => {
      expect(verdict('git commit -m "unbalanced')).toEqual(['pass', ''])
      expect(preToolUse('{not json', REPO_ROOT, hookEnv(at().main))).toBe('')
      expect(preToolUse('null', REPO_ROOT, hookEnv(at().main))).toBe('')
      const run = runHook('pre-tool-use', '{not json', at().main)
      expect([run.status, run.stdout]).toEqual([0, ''])
    })
  })
})

describe('the scan: simple commands as word lists, never parsed (2.1-Q331)', () => {
  it('the scan splits chains at ;, &&, ||, | and newlines', () => {
    expect(scan('a 1; b 2 && c || d | e & f\ng')).toEqual([['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f'], ['g']])
  })

  it('the scan marks a subshell\'s parentheses as segments of their own', () => {
    expect(scan('(cd x && ls); pwd')).toEqual([['('], ['cd', 'x'], ['ls'], [')'], ['pwd']])
  })

  it('the scan skips assignments, options, numbers and wrapper words before the program word', () => {
    const programs = ['X=1 git status', 'env -i git status', 'nice -n 5 ionice -c3 git status', 'timeout 10s git status', 'do git status',
      'echo git status'].map((command) => {
      const words = scan(command)[0] ?? []
      return words[programAt(words)]
    })
    expect(programs).toEqual(['git', 'git', 'git', 'git', 'git', 'echo'])
  })

  it('a here-document body is text the scan never reads, whatever reads it', () => {
    expect(scan("git commit -F - <<'EOF'\ngit stash\nEOF\ngit status")).toEqual([['git', 'commit', '-F', '-'], ['git', 'status']])
    expect(scan('bash <<-EOF\n\tgit stash\n\tEOF\nls')).toEqual([['bash'], ['ls']])
    expect(scan(`git commit -m "$(cat <<'EOF'\nfix(x): it's (1) done\nEOF\n)"; ls`)).toEqual([
      ['git', 'commit', '-m', "$(cat <<'EOF'\nfix(x): it's (1) done\nEOF\n)"], ['ls']])
  })

  it('the scan drops a comment to the end of its line, and # inside a word is text', () => {
    expect(scan('ls # git stash\nissue#3 x#y')).toEqual([['ls'], ['issue#3', 'x#y']])
  })

  it('the scan drops a redirection\'s operator and target, never the program or subcommand', () => {
    expect(scan('>out git 2>&1 status <in --short >|log')).toEqual([['git', 'status', '--short']])
    expect(scan("git commit -F - <<<'msg'")).toEqual([['git', 'commit', '-F', '-']])
  })

  it('a number set apart from a redirection stays a word', () => {
    expect(scan('echo 2 > x')).toEqual([['echo', '2']])
    expect(scan('echo 2> x')).toEqual([['echo']])
  })

  it('the scan joins a line continuation', () => {
    expect(scan('git \\\n  stash \\\npop')).toEqual([['git', 'stash', 'pop']])
  })

  it('a quoted or escaped program word is read as the program it names', () => {
    expect(scan(`'git' "stash" g\\it`)).toEqual([['git', 'stash', 'git']])
  })

  it('a substitution stays one raw word, so no rule reads into it', () => {
    expect(scan('echo "$(git stash)" `git stash` $(a (b) c)')).toEqual([['echo', '$(git stash)', '`git stash`', '$(a (b) c)']])
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
