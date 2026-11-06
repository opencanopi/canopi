// policy/gate/agent-hooks-shell.ts: how the agent hooks (agent-hooks.ts) read a Bash command (2.1-M196, 2.1-M219;
// ported from scripts/agent_hooks.py, 2.1-M349; fail closed, 2.1-Q275). The hook fully reads only a plain subset of the
// shell: simple commands joined by `&&`, `||`, `;`, `|`, `&` and newlines, words in quotes holding no expansion,
// redirections and here-documents read as text, each command after its environment assignments and the wrappers it
// knows, with their options. One pass removes comments, line continuations and here-document bodies, so a commit
// message's words are never read as commands, and names the first construct outside the subset: a substitution, a
// subshell, a parameter expansion other than `${name}`, a here-document fed to a shell or expanding a substitution; then
// a command's head adds a wrapper option it does not know, a reserved word or eval-like builtin, or a shell reading its
// input. Nothing inside a construct is read: agent-hooks.ts asks when a command mentioning git holds one. The one
// construct read, as text, is a commit message in exactly the form `git commit -m "$(cat <<'EOF'` … `EOF` `)"`: it
// becomes the word MESSAGE. What cannot be split into words (an unbalanced quote, a trailing backslash) throws Unparsed,
// and the hook asks.
import { posix } from 'node:path'

/** A command the hook cannot read with confidence: it asks. */
export class Unparsed extends Error {}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
/** The word a commit message here-document (`-m "$(cat <<'EOF'` … `EOF` `)"`) is read as. */
const MESSAGE = '\u0000commit message'
const PUNCTUATION = new Set('();<>|&\n')
const SEPARATING = new Set('();|&\n')
const BLANK = new Set(' \t\r')
const WORD_START = new Set(' \t\r\n;&|()<>')
const HEREDOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/y
const PLAIN_BRACED = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/y
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// The commit message form: an unquoted -m or --message whose value is a here-document with a quoted delimiter, the whole
// of a double-quoted substitution. Its body is checked apart: a line equal to the delimiter would end it early.
const COMMIT_MESSAGE = /(^|[ \t])(-m|--message)([ \t]+|=)"\$\(cat <<(['"])([A-Za-z_][A-Za-z0-9_]*)\4\n([\s\S]*?)\n\5\n\)"/g

const SUBSTITUTION = 'a command substitution `$(…)`'
const BACKTICK = 'a backtick substitution'
const EXPANSION = 'a parameter expansion `${…}` other than `${name}`'

/** The expansion opening at `at` in text the shell expands (unquoted, double-quoted, an unquoted here-document body). */
function expansion(text: string, at: number): string | undefined {
  if (text[at] === '`') return BACKTICK
  if (text.startsWith('$(', at)) return SUBSTITUTION
  if (!text.startsWith('${', at)) return undefined
  PLAIN_BRACED.lastIndex = at
  return PLAIN_BRACED.test(text) ? undefined : EXPANSION
}

/** The first expansion in an unquoted here-document's body, skipping escaped characters. */
function bodyExpansion(body: string): string | undefined {
  for (let i = 0; i < body.length; i += body[i] === '\\' ? 2 : 1) {
    const found = expansion(body, i)
    if (found) return `${found} in an unquoted here-document`
  }
  return undefined
}

/** The text of the double-quoted string opening at `at` and the index after it; `\` escapes `"`, `\`, `$` and `` ` ``. */
function doubleQuoted(command: string, at: number): [string, number] {
  let text = ''
  for (let j = at + 1; j < command.length; j += 1) {
    const d = command[j]
    if (d === '"') return [text, j + 1]
    if (d === '\\' && '"\\$`'.includes(command[j + 1] ?? '.')) {
      text += command[j + 1]
      j += 1
    } else {
      text += d
    }
  }
  throw new Unparsed('No closing quotation')
}

/** The word text read at `at` (a quoted string, an escape or one character) and the index after it. */
function wordPart(command: string, at: number): [string, number] {
  const c = command[at] ?? ''
  if (c === "'") {
    const end = command.indexOf("'", at + 1)
    if (end < 0) throw new Unparsed('No closing quotation')
    return [command.slice(at + 1, end), end + 1]
  }
  if (c === '"') return doubleQuoted(command, at)
  if (c === '\\') {
    if (at + 1 >= command.length) throw new Unparsed('No escaped character')
    return [command[at + 1] ?? '', at + 2]
  }
  return [c, at + 1]
}

/**
 * The words and punctuation runs of `command`, as Python's shlex (posix, punctuation_chars, whitespace_split), and the
 * indexes of the words that are a redirection's fd: unquoted digits written against `<` or `>` (`2>f`, not `2 > f`).
 */
function tokens(command: string): { list: string[], fds: Set<number> } {
  const out: string[] = []
  const fds = new Set<number>()
  let word: string | undefined
  let quoted = false
  let punctuation = ''
  const endWord = () => {
    if (word !== undefined) out.push(word)
    word = undefined
    quoted = false
  }
  for (let i = 0; i < command.length;) {
    const c = command[i] ?? ''
    if (PUNCTUATION.has(c)) {
      if ((c === '<' || c === '>') && !quoted && /^\d+$/.test(word ?? '')) fds.add(out.length)
      endWord()
      punctuation += c
      i += 1
      continue
    }
    if (punctuation) out.push(punctuation)
    punctuation = ''
    if (BLANK.has(c)) {
      endWord()
      i += 1
      continue
    }
    const [text, next] = wordPart(command, i)
    if (c === "'" || c === '"' || c === '\\') quoted = true
    word = (word ?? '') + text
    i = next
  }
  endWord()
  if (punctuation) out.push(punctuation)
  return { list: out, fds }
}

/** The here-document opening at `at` (`<<EOF`, `<<-'EOF'`): its text, its delimiter, tab stripping and whether its body
 * is expanded, whether a shell reads it, and the index after it; undefined when none opens there. */
function heredoc(command: string, at: number): { text: string, body: Body, shell: boolean, next: number } | undefined {
  if (!command.startsWith('<<', at) || command.startsWith('<<<', at)) return undefined
  HEREDOC.lastIndex = at
  const match = HEREDOC.exec(command)
  if (!match) return undefined
  const lineStart = command.lastIndexOf('\n', at - 1) + 1
  const head = (command.slice(lineStart, at).split(/[;&|(`]/).pop() ?? '').split(/\s+/).filter((w) => w !== '')
  const body = { delimiter: match[3] ?? '', tabs: match[1] === '-', expanded: !match[2] }
  // Any shell word before it counts, so a reserved word or wrapper in front (`then bash <<EOF`) hides none.
  return { text: match[0], body, shell: head.some((w) => SHELLS.has(posix.basename(w))), next: HEREDOC.lastIndex }
}

interface Body {
  readonly delimiter: string
  readonly tabs: boolean
  readonly expanded: boolean
}

/** The index after the here-document bodies `pending` that start at `at`, and the first expansion an unquoted one holds. */
function skipBodies(command: string, at: number, pending: readonly Body[]): [number, string | undefined] {
  let i = at
  let found: string | undefined
  for (const { delimiter, tabs, expanded } of pending) {
    const start = i
    let end = command.length
    while (i < command.length) {
      const newline = command.indexOf('\n', i)
      const line = newline === -1 ? command.slice(i) : command.slice(i, newline)
      const lineStart = i
      i = newline === -1 ? command.length : newline + 1
      if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        end = lineStart
        break
      }
    }
    if (expanded) found ??= bodyExpansion(command.slice(start, end))
  }
  return [i, found]
}

/** `command` read for the plain subset: its text with comments, line continuations and here-document bodies removed,
 * and the first construct outside the subset. */
interface Scan {
  out: string
  construct?: string
  quote?: string
  pending: Body[]
  feedsShell: boolean
}

/** Records `found` as the scan's construct unless one came first. */
const note = (scan: Scan, found: string | undefined) => {
  scan.construct ??= found
}

/** Reads the character at `i` into `scan`; the index after what it read. */
function scanStep(command: string, i: number, scan: Scan): number {
  const c = command[i] ?? ''
  if (scan.quote === "'") {
    if (c === "'") scan.quote = undefined
    scan.out += c
    return i + 1
  }
  if (c === '\\') {
    // A line continuation joins the words around it; another escape stays for tokens() to read.
    if (command[i + 1] !== '\n') scan.out += command.slice(i, i + 2)
    return i + 2
  }
  if (scan.quote === '"') {
    note(scan, expansion(command, i))
    if (c === '"') scan.quote = undefined
    scan.out += c
    return i + 1
  }
  return scanUnquoted(command, i, scan)
}

/** scanStep for a character outside quotes: a quote, an expansion, a parenthesis, a comment, a here-document or text. */
function scanUnquoted(command: string, i: number, scan: Scan): number {
  const c = command[i] ?? ''
  note(scan, expansion(command, i))
  if (c === '$' && command[i + 1] === "'") note(scan, 'ANSI-C quoting `$\'…\'`')
  if ((c === '<' || c === '>') && command[i + 1] === '(') note(scan, 'a process substitution `<(…)`')
  if (c === '(' || c === ')') note(scan, 'a subshell, function or case pattern `( )`')
  if (c === "'" || c === '"') {
    scan.quote = c
  } else if (c === '#' && (!scan.out.length || WORD_START.has(scan.out[scan.out.length - 1] ?? ''))) {
    // As in bash, a comment starts at a `#` that begins a word and ends before the newline, which still separates.
    const end = command.indexOf('\n', i)
    return end === -1 ? command.length : end
  } else if (c === '\n' && scan.pending.length) {
    scan.out += c
    const [next, found] = skipBodies(command, i + 1, scan.pending)
    note(scan, found)
    scan.pending = []
    return next
  } else {
    const opened = heredoc(command, i)
    if (opened) {
      if (opened.shell) {
        note(scan, 'a here-document fed to a shell')
        scan.feedsShell = true
      }
      scan.pending.push(opened.body)
      scan.out += opened.text
      return opened.next
    }
  }
  scan.out += c
  return i + 1
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
// The words at a command's head that run commands the hook does not read: reserved words, groups and the builtins that
// run a string or a file (2.1-Q275).
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'for', 'do', 'done', 'case', 'esac',
  'select', 'function', 'coproc', 'eval', 'exec', 'source', '.', '{', '}', '!'])
// git's global options that take a separate value.
export const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
  '--config-env', '--list-cmds'])
/** A simple command without its environment assignments and wrapper words, the assignments, and the construct outside
 * the plain subset its head holds. */
export interface Command {
  readonly words: string[]
  readonly env: Record<string, string>
  readonly construct?: string
  /** The words it redirects output to (`> f`, `>> f`, `&> f`, `>| f`, `2>| f`; not `2>&1`). */
  readonly targets: string[]
}

/** `words` without environment assignments and wrapper words; `command -v` runs nothing. */
function stripPrefix(words: readonly string[]): Omit<Command, 'targets'> {
  const env: Record<string, string> = {}
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (ASSIGNMENT.test(word)) {
      const at = word.indexOf('=')
      env[word.slice(0, at)] = word.slice(at + 1)
      i += 1
      continue
    }
    const wrapper = WRAPPERS[word]
    if (!wrapper) break
    for (i += 1; i < words.length && (words[i] ?? '').startsWith('-'); i += 1) {
      const option = words[i] ?? ''
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

/** The construct outside the plain subset at a simple command's head: a wrapper option, a reserved word, a shell reading
 * its input, or the commit message word anywhere but a `git commit` -m or --message value. */
function headConstruct({ words, construct }: Omit<Command, 'targets'>): string | undefined {
  if (construct) return construct
  const program = words[0] ?? ''
  if (KEYWORDS.has(program)) return `\`${program}\``
  if (SHELLS.has(posix.basename(program)) && shellCommands(words) === -1) return 'a shell reading its commands from its input'
  const messages = words.flatMap((w, k) => (w === MESSAGE || w === `--message=${MESSAGE}` ? [k] : []))
  if (!messages.length) return undefined
  const commit = posix.basename(program) === 'git' && words[gitSubcommandAt(words)] === 'commit'
  return commit && messages.every((k) => words[k] !== MESSAGE || ['-m', '--message'].includes(words[k - 1] ?? ''))
    ? undefined : SUBSTITUTION
}

const isPunctuation = (token: string) => token !== '' && [...token].every((c) => PUNCTUATION.has(c))

/** A simple command's words and the words it redirects output to, before its prefix is read. */
interface Segment {
  readonly words: string[]
  readonly targets: string[]
}

/** A command read for the plain subset: its simple commands, the first construct outside the subset (in its text or at
 * a simple command's head), and whether a here-document feeds a shell. */
interface Reading {
  readonly commands: Command[]
  readonly construct: string | undefined
  readonly feedsShell: boolean
}

/**
 * `command` read for the plain subset. Its simple commands come in order, each without its environment assignments and
 * wrapper words (stripPrefix), the assignments beside it; a redirection (`2> f`, `< f`, `<<EOF`, `2>&1`),
 * wherever it stands, is no word: its fd number and its operand are dropped, so words[0] is the program, and each command
 * names the files it redirects output to, which a check resolves against the directory that command runs in.
 */
export function read(command: string): Reading {
  const replaced = command.replace(COMMIT_MESSAGE, (whole, lead: string, flag: string, gap: string, _quote: string,
    delimiter: string, body: string) => (body.split('\n').includes(delimiter) ? whole : `${lead}${flag}${gap}'${MESSAGE}'`))
  const scan: Scan = { out: '', pending: [], feedsShell: false }
  for (let i = 0; i < replaced.length;) i = scanStep(replaced, i, scan)
  const commands = simpleCommands(scan.out).map(({ words, targets }) => ({ ...stripPrefix(words), targets }))
  // The message word joined to other text (`x'…'`) is no longer the form; headConstruct checks where the rest stand.
  const joined = commands.some((c) => c.words.some((w) => w.includes(MESSAGE) && w !== MESSAGE && w !== `--message=${MESSAGE}`))
  const construct = scan.construct ?? (joined ? SUBSTITUTION : commands.map(headConstruct).find((found) => found !== undefined))
  return { commands, construct, feedsShell: scan.feedsShell }
}

/** The simple commands of scanned `text`. */
function simpleCommands(text: string): Segment[] {
  const out: Segment[] = []
  let current: Segment = { words: [], targets: [] }
  const { list, fds } = tokens(text)
  let operand = false
  let fd = false
  list.forEach((token, k) => {
    if (!isPunctuation(token)) {
      fd = !operand && fds.has(k)
      if (!operand) current.words.push(token)
      operand = false
      return
    }
    operand = false
    // A run of punctuation (`&&`, `)&&`, `\n\n`) separates commands unless it is only a redirection.
    if ([...token.replace(/&>\|?|>\||[<>]&/g, '')].some((c) => SEPARATING.has(c))) {
      if (current.words.length) out.push(current)
      current = { words: [], targets: [] }
    } else if (fd) {
      current.words.pop() // the fd number of `2>f`
    }
    fd = false
    const next = list[k + 1]
    if (!/[<>][&|]?$/.test(token) || next === undefined || isPunctuation(next)) return
    operand = true
    if (token.includes('>') && !(token.endsWith('&') && /^(?:\d+-?|-)$/.test(next))) current.targets.push(next)
  })
  if (current.words.length) out.push(current)
  return out
}
