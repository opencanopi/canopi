// The agent hooks' reading of git's own arguments (agent-hooks.ts; canopi-f47t.52.269, scope reconciled with 2.1-M408):
// a `git checkout` pathspec discards without `--`, which only the repository tells from a branch; a variable in git's
// subcommand or options is expanded when known and asks when not; an attached option value is no flag cluster. Each case
// runs against a planted repository holding a branch, a remote-only branch and a tracked file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { preToolUse } from './agent-hooks.ts'
import { cleanEnv, git, REPO_ROOT } from './planted-repo.ts'

let root = ''
const repo = () => join(root, 'repo')

/** [decision, rule] for `command` run in the planted repository; ['pass', ''] when the hook says nothing. */
function verdict(command: string): [string, string] {
  const env = Object.fromEntries(Object.entries(cleanEnv()).filter(([name]) => name !== 'HUSKY'))
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo(), tool_input: { command } }
  const out = preToolUse(JSON.stringify(payload), REPO_ROOT, { ...env, CLAUDE_PROJECT_DIR: join(root, 'elsewhere') })
  if (!out.trim()) return ['pass', '']
  const { permissionDecision, permissionDecisionReason } = (JSON.parse(out) as { hookSpecificOutput: {
    permissionDecision: string, permissionDecisionReason: string } }).hookSpecificOutput
  return [permissionDecision, /^\[([a-z0-9-]+)\] /.exec(permissionDecisionReason)?.[1] ?? '']
}

describe('the agent hooks read git checkout operands and variables in git arguments (canopi-f47t.52.269)', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'canopi-agent-hooks-arguments-'))
    mkdirSync(join(root, 'elsewhere'))
    mkdirSync(join(repo(), 'src'), { recursive: true })
    mkdirSync(join(repo(), 'docs'), { recursive: true })
    git(repo(), 'init', '-q', '-b', 'main')
    git(repo(), 'config', 'user.email', 'test@example.invalid')
    git(repo(), 'config', 'user.name', 'test')
    writeFileSync(join(repo(), 'f.txt'), 'x\n')
    writeFileSync(join(repo(), 'src/a.ts'), 'x\n')
    writeFileSync(join(repo(), 'src/x.md'), 'x\n')
    writeFileSync(join(repo(), 'docs/x.md'), 'x\n')
    git(repo(), 'add', '.')
    git(repo(), '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init')
    git(repo(), 'branch', 'topic')
    git(repo(), 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('canopi-f47t.52.269: git checkout of a path without -- discards and is denied; a branch switch passes', () => {
    for (const command of ['git checkout .', 'git checkout f.txt', 'git checkout src', 'git checkout main f.txt',
      'git checkout topic -- src', 'git checkout --pathspec-from-file=list.txt', 'git checkout HEAD~0 .']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-discard'])
    }
    for (const command of ['git checkout topic', 'git checkout main', 'git checkout HEAD~0', 'git checkout -b new main',
      'git checkout remote-only', 'git checkout --detach topic', 'git checkout -']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
  })

  it('canopi-f47t.52.269: a checkout operand that is neither a ref nor a path asks', () => {
    expect(verdict('git checkout no-such-thing')[0]).toBe('ask')
  })

  it('canopi-f47t.52.269: an attached option value is no flag cluster, so -bfoo is no force', () => {
    for (const command of ['git checkout -bfoo', 'git checkout -Bfix', 'git switch -cfeature', 'git switch -Cfix main']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
    for (const command of ['git checkout -qf topic', 'git switch -qf topic']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-discard'])
    }
  })

  it('canopi-f47t.52.269: a known variable in git\'s subcommand or options is expanded before the rules read it', () => {
    for (const command of ['M=--hard; git reset $M HEAD', 'S=reset; git $S --hard', 'F=-f; git checkout "$F" topic',
      'export P=.; git checkout $P', 'S=stash; git ${S}']) {
      expect(verdict(command)[0], command).toBe('deny')
    }
    expect(verdict('B=topic; git checkout $B')).toEqual(['pass', ''])
  })

  it('canopi-f47t.52.269: an unknown variable where git reads its subcommand or an option asks; as an option value it passes', () => {
    for (const command of ['git reset $HOW HEAD', 'git $VERB --hard', 'git checkout "$WHERE"', 'git clean $FLAGS']) {
      expect(verdict(command)[0], command).toBe('ask')
    }
    for (const command of ['git commit -m "$MSG"', 'git log --since="$D" -3', 'git checkout -b "$NEW"']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
  })

  // The small review of 6bb46dcea (2026-11-06), filed here per M408.
  it('canopi-f47t.52.269: a brace word asks only where an alternative could be an option; a path alternative passes', () => {
    for (const command of ['git add {src,docs}/x.md', 'git diff -- {src,docs}/x.md', 'git log --oneline {main,topic}']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
    for (const command of ['git reset {--hard,}', 'git reset {,--hard}', 'git clean {-fd,-n}', 'git checkout {-f,} topic']) {
      expect(verdict(command)[0], command).toBe('ask')
    }
  })

  it('canopi-f47t.52.269: -S and -u take an optional attached value, so the m after them is no message flag', () => {
    const form = (flag: string) => `git commit ${flag} "$(cat <<'EOF'\nfix: x\nEOF\n)"`
    for (const flag of ['-Sm', '-um', '-aSm']) expect(verdict(form(flag))[0], flag).toBe('ask')
    for (const flag of ['-qm', '-am']) expect(verdict(form(flag)), flag).toEqual(['pass', ''])
  })
})
