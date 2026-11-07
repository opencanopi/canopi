// How the agent hooks read a Bash command (agent-hooks-shell.ts; 2.1-Q275, canopi-f47t.52.228.54): the plain subset, the
// program words read at every level, the commit message form, and the git option shapes a deny rule names. These cases
// need no planted checkout: they run preToolUse from a directory outside any repository (agent-hooks.test.ts plants one
// for the cases that name the user's checkout).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { shellCommands } from './agent-hooks-command.ts'
import { read } from './agent-hooks-shell.ts'
import { preToolUse } from './agent-hooks.ts'
import { cleanEnv, REPO_ROOT } from './planted-repo.ts'

const outside = mkdtempSync(join(tmpdir(), 'canopi-agent-shell-'))
afterAll(() => rmSync(outside, { recursive: true, force: true }))
const env = { ...Object.fromEntries(Object.entries(cleanEnv()).filter(([name]) => name !== 'HUSKY')), CLAUDE_PROJECT_DIR: outside }

/** [decision, the rule its reason names, the reason]; ['pass', '', ''] when the hook says nothing. */
function hook(command: string): [string, string, string] {
  const out = preToolUse(JSON.stringify({ tool_name: 'Bash', cwd: outside, tool_input: { command } }), REPO_ROOT, env)
  if (!out.trim()) return ['pass', '', '']
  const { permissionDecision, permissionDecisionReason } = (JSON.parse(out) as { hookSpecificOutput: {
    permissionDecision: string, permissionDecisionReason: string } }).hookSpecificOutput
  return [permissionDecision, /^\[([a-z0-9-]+)\] /.exec(permissionDecisionReason)?.[1] ?? '', permissionDecisionReason]
}
const verdict = (command: string) => hook(command).slice(0, 2)

describe('program words: read exactly at every level, or the hook asks (2.1-Q275, canopi-f47t.52.228.54)', () => {
  it('canopi-f47t.52.228.54: a program word the hook cannot read exactly asks, at the top level or inside a substitution', () => {
    for (const command of ['/x/gi[t] reset --hard', '/x/g?t reset --hard', '/x/g*t reset --hard', '{git,reset} --hard',
      "$(echo gi''t) reset --hard", "`echo g''it` reset --hard", '$UNSET_PROGRAM reset --hard', '~x/bin/tool reset --hard',
      'echo "$(/x/g?t reset --hard)"', 'echo `/x/g?t reset --hard`', 'cat <<EOF\n$(/x/g?t reset --hard)\nEOF',
      'echo "$($UNSET_PROGRAM reset --hard)"', 'echo $((1)) "$(/x/g?t stash)"']) {
      expect(verdict(command), command).toEqual(['ask', 'agent-hooks'])
    }
    expect(hook('/x/gi[t] reset --hard')[2]).toContain('program word')
  })

  it('canopi-f47t.52.228.54: a quoted, escaped, equals-expanded or known-variable program word is judged as the program it names', () => {
    for (const command of ['\\git reset --hard', "'git' reset --hard", 'g""it reset --hard', '=git reset --hard',
      'P=git; $P reset --hard', 'export P=git && "$P" reset --hard', 'P=gi; ${P}t reset --hard', 'W=env; $W git reset --hard',
      'command git reset --hard', 'builtin git reset --hard', 'command -- git reset --hard']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-reset-hard'])
    }
    // Normalised to git, it mentions git: a construct beside it asks.
    for (const command of ['g""it reset "$(echo --hard)"', 'echo "$(g""it reset --hard)"', 'echo `\\git stash`',
      'P=git; $P reset "$(echo --hard)"', 'S=bash; echo x | $S', 'K=eval; $K x']) {
      expect(verdict(command), command).toEqual(['ask', 'agent-hooks'])
    }
  })

  it('canopi-f47t.52.228.54: a brace expansion, or a glob in a git option or subcommand, asks', () => {
    for (const command of ['git reset --{hard,}', 'git st{ash,}', 'git reset --ha*', 'git sta?h', 'git -C /x* commit -m x']) {
      expect(verdict(command), command).toEqual(['ask', 'agent-hooks'])
    }
  })

  it('canopi-f47t.52.228.54: plain agent commands with literal program words do not newly ask', () => {
    for (const command of ['cd x && git status', "git log --format='%H %s'", 'git diff "a..b"', 'PATH=/x:$PATH git log',
      'echo $(date)', 'echo "$(date)" && ls', '[ -f x ] && git status', 'git show stash@{1}', 'git log @{u}..HEAD',
      'git add policy/*.ts', 'for f in *.ts; do wc -l "$f"; done', 'echo $((1 + 2))', '$HOME/bin/tool x', 'ls {a,b}',
      `git commit -m "$(cat <<'EOF'\nfix: x\nEOF\n)"`, 'x=$(date) && echo "$x"']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
  })

  it('canopi-f47t.52.228.54: a case statement inside a substitution, whose patterns end the substitution early, asks', () => {
    expect(verdict('echo "$(case x in x) echo y;; esac)"')[0]).toBe('ask')
  })
})

describe('the commit message form (2.1-Q275, canopi-f47t.52.228.54)', () => {
  it('canopi-f47t.52.228.54: the commit message form is read only unquoted and uncommented, as a git commit -m value', () => {
    const form = (line: string) => `${line} -m "$(cat <<'EOF'\n`
    // In a comment or a here-document body the form is text, so the lines after it are commands.
    expect(verdict(`${form('echo hi #')}git reset --hard <<'Z'\nEOF\n)"\nZ`)).toEqual(['deny', 'hook-reset-hard'])
    expect(verdict(`${form('#')}git stash <<'Z'\nEOF\n)"\nZ`)).toEqual(['deny', 'hook-bare-stash'])
    // In a here-document body the form is text too: what follows the body is read, so the line asks, as it passed before.
    expect(verdict(`cat <<'Z'\n${form('')}Z\ngit reset --hard\nEOF\n)"`)[0]).toBe('ask')
    expect(verdict(`git log -m "$(cat <<'EOF'\nx\nEOF\n)"`)).toEqual(['ask', 'agent-hooks'])
  })
})

describe('zsh precommand modifiers and reserved words (2.1-Q275, canopi-f47t.52.228.54)', () => {
  it('canopi-f47t.52.228.54: zsh precommand modifiers, reserved words and the builtins that define commands ask', () => {
    for (const command of ['noglob git reset --hard', 'nocorrect git reset --hard', '- git reset --hard',
      'repeat 1 git reset --hard', 'foreach x (a) git reset --hard; end', '[[ -n x ]] && git reset --hard',
      "trap 'git reset --hard' EXIT", 'alias g=git', 'hash g=/usr/bin/git', 'sched +0 git stash']) {
      expect(verdict(command), command).toEqual(['ask', 'agent-hooks'])
    }
  })
})

describe('git options as git reads them (canopi-f47t.52.228.54)', () => {
  it('canopi-f47t.52.228.54: git config writing core.hooksPath through a file, a scope or a valued option is refused like the plain form', () => {
    for (const command of ['git config --file .git/config core.hooksPath x', 'git config -f .git/config core.hooksPath x',
      'git config --file=.git/config core.hooksPath x', 'git config -f.git/config core.hooksPath x',
      'git config --fil .git/config core.hooksPath x', 'git config --system core.hooksPath x',
      'git config --worktree core.hooksPath x', 'git config --type path core.hooksPath x',
      'git config --file .git/config core.hooksPath .githooks', 'git config --remove-section core', 'git config --unse core.hooksPath']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-hooks-path-override'])
    }
    for (const command of ['git config --file .git/config --get core.hooksPath', 'git config -f x core.hooksPath',
      'git config --remove-section remote.x']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
  })

  it('canopi-f47t.52.228.54: a unique prefix of a long option a deny rule names is read as that option', () => {
    for (const [command, rule] of [['git reset --har', 'hook-reset-hard'], ['git reset --ha', 'hook-reset-hard'],
      ['git checkout --forc main', 'hook-discard'], ['git switch --disc x', 'hook-discard'], ['git clean --forc', 'hook-discard'],
      ['git restore --staged --work f', 'hook-discard'], ['git checkout -qf main', 'hook-discard'], ['git push --ta', 'hook-tag-push'],
      ['git push --follow origin', 'hook-tag-push'], ['git push --mirr', 'hook-tag-push']] as const) {
      expect(verdict(command), command).toEqual(['deny', rule])
    }
  })
})

describe('parsing: chains, prefixes, one level of shell -c, here-documents and comments', () => {
  it('canopi-f47t.52.228.10: chains are split', () => {
    for (const command of ['git status && git commit --no-verify -m x', 'false || git commit -n -m x',
      'git add . ; git commit --no-verify -m x', 'echo x | git commit --no-verify -F -', 'git add .\ngit commit --no-verify -m x']) expect(verdict(command), command).toEqual(['deny', 'hook-no-verify'])
  })

  it('canopi-f47t.52.228.10: prefixes are skipped', () => {
    expect(verdict('GIT_AUTHOR_NAME=x git commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
    expect(verdict('env FOO=1 git commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
    expect(verdict('time git reset --hard')).toEqual(['deny', 'hook-reset-hard'])
  })

  it('canopi-f47t.52.228.54: a redirection before or inside a command never hides its program or subcommand', () => {
    for (const command of ['2>/dev/null git reset --hard', '>/dev/null git reset --hard', 'git 2>/dev/null reset --hard',
      '</dev/null git reset --hard', 'git reset 2>&1 --hard', 'git reset --hard &>/dev/null',
      '2>|/dev/null git reset --hard', '>|/dev/null git reset --hard']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-reset-hard'])
    }
    expect(verdict('2>/dev/null git commit --no-verify -m x')).toEqual(['deny', 'hook-no-verify'])
    expect(verdict('cat <<<x git commit --no-verify')).toEqual(['pass', ''])
  })

  it('canopi-f47t.52.228.54: a number set apart from a redirection is an argument, not its fd', () => {
    const segments = (command: string) => read(command).commands.map(({ words, targets }) => ({ words, targets }))
    expect(segments('echo 2 > f')).toEqual([{ words: ['echo', '2'], targets: ['f'] }])
    expect(segments('echo 2>f')).toEqual([{ words: ['echo'], targets: ['f'] }])
    expect(segments('echo "2">f')).toEqual([{ words: ['echo', '2'], targets: ['f'] }])
    expect(segments('git reset --hard 1 >| f')[0]?.words).toEqual(['git', 'reset', '--hard', '1'])
  })

  it('canopi-f47t.52.228.54: a line continuation joins the words it splits', () => {
    expect(verdict('git reset \\\n--hard')).toEqual(['deny', 'hook-reset-hard'])
    expect(verdict('git \\\n  stash')).toEqual(['deny', 'hook-bare-stash'])
  })

  it('canopi-f47t.52.228.10: one level of shell -c is read', () => {
    for (const shell of ['sh -c', 'bash -c', 'bash -lc']) {
      expect(verdict(`${shell} 'git commit --no-verify -m x'`), shell).toEqual(['deny', 'hook-no-verify'])
    }
    expect(verdict("bash -c 'git log'")).toEqual(['pass', ''])
    expect(verdict(`bash -c "sh -c 'git log'" `)[0]).toBe('ask')
  })

  it('canopi-f47t.52.228.54: a shell -c string is read after option clusters with capitals and bash options taking a value', () => {
    for (const command of ['bash -Ec "git reset --hard"', 'bash -xEc "git reset --hard"', 'bash --rcfile x -c "git reset --hard"',
      'bash --init-file x -c "git reset --hard"', 'zsh -o errexit -c "git reset --hard"']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-reset-hard'])
    }
    expect(verdict('bash -E scripts/x.sh')).toEqual(['pass', ''])
  })

  it('canopi-f47t.52.228.54: arithmetic holding a substitution is read through it, and passes without git', () => {
    for (const command of ['s=$(date +%s); npm test; echo $(( $(date +%s) - s ))', 'echo "$(( ($(date +%s)-s)/60 ))"',
      'echo $(( `date +%s` + 1 ))', 'echo $(( $((1 + 2)) * 3 ))']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
    for (const command of ['echo $(( $(/x/g?t) + 1 ))', 'echo $(( $(git stash) + 1 ))', 'echo $(( $(echo "$(/x/g?t)") ))']) {
      expect(verdict(command), command).toEqual(['ask', 'agent-hooks'])
    }
  })

  it('canopi-f47t.52.228.54: a | inside ${…} or between case patterns makes no program word', () => {
    for (const command of ['echo ${f%%|*}', 'x="${f#*|}"; echo "$x"', 'case "$c" in /a|/a/*) echo y;; esac',
      'case "$c" in\n  (a|b) echo 1 ;;\n  c|d) echo 2 ;&\n  *) echo 3\nesac; ls', 'for d in /p/*; do case "$d" in /p/a|/p/b/*) echo "${d#/p/}";; esac; done']) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
    // What runs inside them is still read: an unread program word in a parameter expansion's substitution or a case body asks.
    // Where shells disagree on where a ${…} ends (a single quote in a double-quoted one, a bare brace), it asks.
    for (const command of ['echo ${x:-$(/x/g?t)}', 'echo ${x:-"$(/x/g?t)"}', 'echo "${x:-${y:-$(/x/g?t)}}"', 'case x in a|b) /x/g?t;; esac',
      'case x in a|b) echo;; c) git stash;; esac', `echo "\${x#'}"; /x/g?t; echo "'"`, 'echo ${x:-{a}; /x/g?t; }']) {
      expect(verdict(command)[0], command).toBe('ask')
    }
  })

  it('canopi-f47t.52.228.10: heredoc bodies are text unless a shell reads them', () => {
    const body = "fix: the hook's message\n\nIt names --no-verify; git stash and HUSKY=0 git commit are text.\n"
    expect(verdict(`git commit -F - <<'EOF'\n${body}EOF\ngit log -1`)).toEqual(['pass', ''])
    expect(verdict(`git commit -m "$(cat <<'EOF'\n${body}EOF\n)"`)).toEqual(['pass', ''])
    expect(verdict(`git commit --no-verify -F - <<'EOF'\n${body}EOF`)).toEqual(['deny', 'hook-no-verify'])
    expect(verdict(`git commit -F - <<EOF\n${body}EOF\ngit stash`)).toEqual(['deny', 'hook-bare-stash'])
    expect(verdict("bash <<'EOF'\ngit commit --no-verify -m x\nEOF")).toEqual(['ask', 'agent-hooks'])
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
})

// The small review of 6bb46dcea (2026-11-06), filed on canopi-f47t.52.269 per M408.
describe('a shell -c string, its prefix assignments and quotes in a parameter expansion (canopi-f47t.52.269)', () => {
  it('canopi-f47t.52.269: bash reads its -c string as the first word after its options, past -- or more options', () => {
    for (const command of ['bash -c -x "git reset --hard"', 'bash -c -- "git reset --hard"', 'sh -c -e -- "git reset --hard"',
      'bash -c -o errexit "git reset --hard"', 'bash -xc +e "git reset --hard"']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-reset-hard'])
    }
    expect(verdict('bash -c -x "git log"')).toEqual(['pass', ''])
  })

  it('canopi-f47t.52.269: each o or O in an option cluster takes a value word wherever it sits, as bash and sh read it', () => {
    for (const command of ['bash -oc errexit "git reset --hard"', 'bash -Oc extglob "git reset --hard"',
      'sh -oc errexit "git reset --hard"', 'bash -oOc errexit extglob "git reset --hard"']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-reset-hard'])
    }
    expect(verdict('bash -oc errexit "git log"')).toEqual(['pass', ''])
  })

  it('canopi-f47t.52.269: zsh reads the rest of a cluster after o as the option name, only a trailing o takes a word, O none', () => {
    for (const command of ['zsh -oerrexit -c "git reset --hard"', 'zsh -onoglob -c "git reset --hard"',
      'zsh -conoglob "git reset --hard"', 'zsh -xo errexit -c "git reset --hard"', 'zsh -Oc "git reset --hard"']) {
      expect(verdict(command), command).toEqual(['deny', 'hook-reset-hard'])
    }
    expect(shellCommands(['zsh', '-onoclobber', 'script.zsh'])).toBeUndefined()
    expect(shellCommands(['zsh', '-onoglob', '-c', 'x'])).toBe(3)
  })

  it('canopi-f47t.52.269: a prefix assignment before a shell -c reaches the child shell, as it does a plain command', () => {
    const plain = verdict(`GIT_DIR=${outside}/.git git commit -m x`)
    expect(plain[0]).toBe('ask')
    expect(verdict(`GIT_DIR=${outside}/.git bash -c "git commit -m x"`)).toEqual(plain)
    expect(verdict(`GIT_DIR=${outside}/.git bash -c 'git log'`)).toEqual(['pass', ''])
  })

  it('canopi-f47t.52.269: a single quote in a double-quoted parameter expansion is read unless it could hide the closing brace', () => {
    // Without git: beside git, any expansion other than `${name}` asks (2.1-Q275).
    for (const command of [`echo "\${f%'.ts'}"`, `echo "\${f#'./'}" && npm test`, `x="\${f%'.ts'}.js"; echo "$x"`]) {
      expect(verdict(command), command).toEqual(['pass', ''])
    }
    for (const command of [`echo "\${f%'}'}"`, `echo "\${f%'"'}"`, `echo "\${f%'.ts}"`]) {
      expect(verdict(command)[0], command).toBe('ask')
    }
  })
})
