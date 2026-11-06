// policy/gate/agent-hooks-command.ts: a simple command as the agent hooks read it (agent-hooks-shell.ts reads the words;
// 2.1-Q275, canopi-f47t.52.228.54): its environment assignments and the wrappers it knows stripped, its program word's
// kind (read as written, through `$name` variables the hook expands, or not at all), the words holding a glob or brace,
// and the construct outside the plain subset its head holds: a wrapper option the hook does not know, a reserved word,
// zsh precommand modifier or builtin that runs or defines commands, a shell reading its input, or the commit message
// word anywhere but a `git commit` -m or --message value.
import { posix } from 'node:path'

/** A command the hook cannot read with confidence: it asks. */
export class Unparsed extends Error {}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
/** The word a commit message here-document (`-m "$(cat <<'EOF'` … `EOF` `)"`) is read as. */
export const MESSAGE = '\u0000commit message'
/** What a substitution leaves in the scanned text: a character no command holds, read as an expansion. */
export const SUBSTITUTED = '\u0002'
export const PARAMETER = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/y
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// A variable's value the hook puts in a program word: a plain word, no blank, quote, glob or `=`.
const PLAIN_VALUE = /^[A-Za-z0-9_./+:@%,-]+$/
export const SUBSTITUTION = 'a command substitution `$(…)`'

/** A word's text and its shape: each character as written where the shell may expand it, a placeholder where it may not. */
export interface Word {
  readonly text: string
  readonly shape: string
}

// The wrappers that run the words after their options: the options each takes alone, those taking the next word, the
// attached forms, and the operands before the command (timeout's duration). Any other option is outside the plain
// subset (2.1-Q275): `env -C` changes the directory, `env -S` splits a string into words.
interface Wrapper {
  readonly flags: readonly string[]
  readonly values: readonly string[]
  readonly attached?: RegExp
  readonly operands?: number
}
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  time: { flags: ['-p'], values: [] },
  command: { flags: ['-p'], values: [] },
  builtin: { flags: [], values: [] },
  nohup: { flags: [], values: [] },
  nice: { flags: [], values: ['-n', '--adjustment'], attached: /^(?:-n.+|--adjustment=.*|-\d+)$/ },
  env: { flags: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug'], values: ['-u', '--unset'],
    attached: /^(?:-u.+|--unset=.*)$/ },
  timeout: { flags: ['--preserve-status', '--foreground', '-v', '--verbose'], values: ['-s', '--signal', '-k', '--kill-after'],
    attached: /^(?:-[sk].+|--signal=.*|--kill-after=.*)$/, operands: 1 },
}
// The words at a command's head that run or define commands the hook does not read (2.1-Q275): bash and zsh reserved
// words and groups, zsh's precommand modifiers, and the builtins that run a string or a file, or define what a later
// word runs (an alias, a hashed path, a trap, a scheduled command, a shell option changing how words are read).
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'for', 'do', 'done', 'case', 'esac',
  'select', 'function', 'coproc', 'eval', 'exec', 'source', '.', '{', '}', '!', '[[', ']]', 'repeat', 'foreach', 'end',
  'always', 'noglob', 'nocorrect', '-', 'alias', 'unalias', 'hash', 'trap', 'sched', 'fc', 'enable', 'disable', 'autoload',
  'functions', 'zmodload', 'setopt', 'unsetopt', 'shopt', 'emulate'])
// git's global options that take a separate value.
export const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
  '--config-env', '--list-cmds'])

/** How the hook reads a program word: as written, after expanding its `$name` variables (expandProgram), or not at all. */
type ProgramKind = 'literal' | 'variable' | 'unread'

/** A simple command without its environment assignments and wrapper words, the assignments, and the construct outside
 * the plain subset its head holds. */
export interface Command {
  readonly words: string[]
  readonly env: Record<string, string>
  readonly construct?: string
  /** The words it redirects output to (`> f`, `>> f`, `&> f`, `>| f`, `2>| f`; not `2>&1`). */
  readonly targets: string[]
  readonly program: ProgramKind
  /** The indexes of the words holding an unquoted glob or brace character, which the hook does not expand. */
  readonly patterns: ReadonlySet<number>
  /** The words with their shapes. */
  readonly shaped: readonly Word[]
}

/** `words` without environment assignments and wrapper words; `command -v` runs nothing. */
function stripPrefix(words: readonly Word[]): { words: readonly Word[], env: Record<string, string>, construct?: string } {
  const env: Record<string, string> = {}
  let i = 0
  while (i < words.length) {
    const { text: word, shape } = words[i] ?? { text: '', shape: '' }
    // A quoted name (`'A'=x`) makes no assignment: the shell runs that word.
    if (ASSIGNMENT.test(shape)) {
      const at = word.indexOf('=')
      env[word.slice(0, at)] = word.slice(at + 1)
      i += 1
      continue
    }
    const wrapper = WRAPPERS[word]
    if (!wrapper) break
    for (i += 1; i < words.length && (words[i]?.text ?? '').startsWith('-'); i += 1) {
      const option = words[i]?.text ?? ''
      if (option === '--') {
        i += 1
        break
      }
      if (word === 'command' && (option === '-v' || option === '-V')) return { words: [], env }
      if (wrapper.values.includes(option)) i += 1
      else if (!wrapper.flags.includes(option) && !wrapper.attached?.test(option)) {
        return { words: words.slice(i), env, construct: `\`${word} ${option}\`, a wrapper option the hook does not know` }
      }
    }
    i += wrapper.operands ?? 0
  }
  return { words: words.slice(i), env }
}

/** How the hook reads the program word: `[`, `[[`, `{` and `}` as written; a glob, brace, substitution or `~user` not at all. */
function programKind({ text, shape }: Word): ProgramKind {
  if (shape === text && ['[', '[[', '{', '}'].includes(text)) return 'literal'
  if (shape.startsWith('~') && !shape.startsWith('~/')) return 'unread'
  const rest = shape.replaceAll(new RegExp(PARAMETER.source, 'g'), '')
  if (/[$`*?[{}\u0002]/.test(rest)) return 'unread'
  return rest === shape ? 'literal' : 'variable'
}

/** Whether a word's shape holds a brace expansion: an unquoted `{…}` (not `${…}`) holding `,` or `..`. */
export function braceExpansion(shape: string): boolean {
  for (let i = 0; i < shape.length; i += 1) {
    if (shape[i] !== '{' || shape[i - 1] === '$') continue
    for (let j = i, depth = 0; j < shape.length; j += 1) {
      if (shape[j] === '{') depth += 1
      if (shape[j] === '}' && --depth === 0) {
        if (/,|\.\./.test(shape.slice(i + 1, j))) return true
        break
      }
    }
  }
  return false
}

/** The index of a git command's subcommand, after its global options. */
export function gitSubcommandAt(words: readonly string[]): number {
  let i = 1
  while (i < words.length && (words[i] ?? '').startsWith('-')) i += GIT_VALUE_OPTIONS.has(words[i] ?? '') ? 2 : 1
  return i
}

/** Where a shell reads its commands: the index of its -c string, -1 for its input, undefined for a script file. */
export function shellCommands(words: readonly string[]): number | undefined {
  for (let k = 1; k < words.length; k += 1) {
    const word = words[k] ?? ''
    if (/^-[a-z]*c[a-z]*$/.test(word) && k + 1 < words.length) return k + 1
    if (word === '-s') return -1
    if (['-o', '+o', '-O', '+O'].includes(word)) k += 1
    else if (!word.startsWith('-') && !word.startsWith('+')) return undefined
  }
  return -1
}

/** The construct outside the plain subset at a simple command's head: a keyword, a shell reading its input, or the
 * commit message word anywhere but a -m or --message value of a `git commit` whose program word is literal. */
function headConstruct(words: readonly string[], program: ProgramKind): string | undefined {
  const first = words[0] ?? ''
  if (KEYWORDS.has(first)) return `\`${first}\``
  if (SHELLS.has(posix.basename(first)) && shellCommands(words) === -1) return 'a shell reading its commands from its input'
  const messages = words.flatMap((w, k) => (w === MESSAGE || w === `--message=${MESSAGE}` ? [k] : []))
  if (!messages.length) return undefined
  const commit = program === 'literal' && posix.basename(first) === 'git' && words[gitSubcommandAt(words)] === 'commit'
  return commit && messages.every((k) => words[k] !== MESSAGE || ['-m', '--message'].includes(words[k - 1] ?? ''))
    ? undefined : SUBSTITUTION
}

/** A simple command read from its words: prefix stripped, zsh's `=name` program read as `name`, its head construct. */
export function build(words: readonly Word[], targets: string[]): Command {
  const stripped = stripPrefix(words)
  const [first, ...rest] = stripped.words
  const program = first?.shape.startsWith('=') && first.text.length > 1 ? { text: first.text.slice(1), shape: first.shape.slice(1) } : first
  const shaped = program ? [program, ...rest] : []
  const texts = shaped.map(({ text }) => text)
  const kind = program ? programKind(program) : 'literal'
  const patterns = new Set(shaped.flatMap(({ shape }, k) => (/[*?[{}]/.test(shape) ? [k] : [])))
  return { words: texts, env: stripped.env, targets, program: kind, patterns, shaped,
    construct: stripped.construct ?? headConstruct(texts, kind) }
}

/** `command` with its program word's variables expanded by `lookup` and read again (a wrapper, a keyword, a shell);
 * undefined when a variable is unset or its value is not a plain word. */
export function expandProgram(command: Command, lookup: (name: string) => string | undefined): Command | undefined {
  let current = command
  for (let round = 0; current.program === 'variable'; round += 1) {
    const [program, ...rest] = current.shaped
    let text: string | undefined = ''
    for (let k = 0; program && text !== undefined && k < program.shape.length;) {
      PARAMETER.lastIndex = k
      const match = program.shape[k] === '$' ? PARAMETER.exec(program.shape)?.[0] : undefined
      const value = match ? lookup(match.replace(/[${}]/g, '')) : program.text[k]
      text = value !== undefined && (!match || PLAIN_VALUE.test(value)) ? text + value : undefined
      k += match?.length ?? 1
    }
    if (text === undefined || round >= 8) return undefined
    const next = build([{ text, shape: text }, ...rest], current.targets)
    current = { ...next, env: { ...current.env, ...next.env } }
  }
  return current
}
