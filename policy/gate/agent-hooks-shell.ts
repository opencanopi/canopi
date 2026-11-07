// policy/gate/agent-hooks-shell.ts: how the agent hooks (agent-hooks.ts) read a Bash command (2.1-M196, 2.1-M219;
// ported from scripts/agent_hooks.py, 2.1-M349; fail closed, 2.1-Q275, canopi-f47t.52.228.54). The hook fully reads only
// a plain subset of the shell: simple commands joined by `&&`, `||`, `;`, `|`, `&` and newlines, words in quotes holding
// no expansion, redirections and here-documents read as text, each command after its environment assignments and the
// wrappers it knows, with their options. One recursive scan removes comments, line continuations and here-document
// bodies, so a commit message's words are never read as commands, and names the first construct outside the subset: a
// substitution, a subshell, a parameter expansion other than `${name}` (read whole, so a `|` in it splits nothing), a
// here-document fed to a shell; then a command's head adds its own (agent-hooks-command.ts). A brace expansion matters only
// where it could change a word a rule reads (a program word asks; agent-hooks.ts reads git's). A `case` statement's patterns
// are no command. The scan reads inside every substitution (`$(…)`, backticks, `<(…)`, those in an arithmetic expansion,
// a parameter expansion or an unquoted here-document body), so the program word of every command at every level is
// known, with its shape: as written (quotes and escapes that change nothing are read through), through `$name`
// variables the hook expands, or not at all (a glob, a brace, a substitution, `~user`), which asks. The one construct
// read as text is a commit message in exactly the form `-m "$(cat <<'EOF'` … `EOF` `)"` (or after `--message=` or a
// cluster ending in m, `-qm`), met unquoted and uncommented: it becomes the word MESSAGE, accepted only as a `git commit`
// message value (isMessageFlag). What cannot be split into words
// (an unbalanced quote, an unclosed substitution, a `case` inside one) throws Unparsed, and the hook asks.
import { posix } from 'node:path'
import { build, type Command, MESSAGE, PARAMETER, SHELLS, SUBSTITUTED, SUBSTITUTION, Unparsed, type Word } from './agent-hooks-command.ts'

/** A word shape's quoted or escaped character: text the shell does not expand. */
const QUOTED = '\u0001'
const PUNCTUATION = new Set('();<>|&\n')
const SEPARATING = new Set('();|&\n')
const BLANK = new Set(' \t\r')
const WORD_START = new Set(' \t\r\n;&|()<>')
const HEREDOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/y
const PLAIN_BRACED = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/y
// The commit message form: at an unquoted `"` after an unquoted -m or --message word, a double-quoted substitution holding
// only a here-document with a quoted delimiter. Its body is checked apart: a line equal to the delimiter would end it early.
const MESSAGE_FLAG = /(?:^|[\s;&|(])(?:-[A-Za-z]*m|--message)(?:[ \t]+|=)$/
const MESSAGE_FORM = /"\$\(cat <<(['"])([A-Za-z_][A-Za-z0-9_]*)\1\n([\s\S]*?)\n\2\n\)"/y

const BACKTICK = 'a backtick substitution'
const EXPANSION = 'a parameter expansion `${…}` other than `${name}`'

/** The text and shape of the double-quoted string opening at `at`, and the index after it; `\` escapes `"`, `\`, `$`, `` ` ``. */
function doubleQuoted(command: string, at: number): [string, string, number] {
  let text = ''
  let shape = ''
  for (let j = at + 1; j < command.length; j += 1) {
    const d = command[j] ?? ''
    if (d === '"') return [text, shape, j + 1]
    PARAMETER.lastIndex = j
    const parameter = d === '$' ? PARAMETER.exec(command)?.[0] : undefined
    if (d === '\\' && '"\\$`'.includes(command[j + 1] ?? '.')) {
      text += command[j + 1]
      shape += QUOTED
      j += 1
    } else if (parameter) {
      text += parameter
      shape += parameter
      j += parameter.length - 1
    } else {
      text += d
      shape += d === '$' || d === SUBSTITUTED ? d : QUOTED
    }
  }
  throw new Unparsed('No closing quotation')
}

/** The word text read at `at` (a quoted string, an escape or one character), its shape, and the index after it. */
function wordPart(command: string, at: number): [string, string, number] {
  const c = command[at] ?? ''
  if (c === "'") {
    const end = command.indexOf("'", at + 1)
    if (end < 0) throw new Unparsed('No closing quotation')
    return [command.slice(at + 1, end), QUOTED.repeat(end - at - 1), end + 1]
  }
  if (c === '"') return doubleQuoted(command, at)
  if (c === '\\') {
    if (at + 1 >= command.length) throw new Unparsed('No escaped character')
    return [command[at + 1] ?? '', QUOTED, at + 2]
  }
  return [c, c, at + 1]
}

/**
 * The words and punctuation runs of `command`, as Python's shlex (posix, punctuation_chars, whitespace_split), each with
 * its shape (a punctuation run's is itself), and the indexes of the words that are a redirection's fd: unquoted digits
 * written against `<` or `>` (`2>f`, not `2 > f`).
 */
function tokens(command: string): { list: Word[], fds: Set<number> } {
  const list: Word[] = []
  const fds = new Set<number>()
  let word: Word | undefined
  let quoted = false
  let punctuation = ''
  const endWord = () => {
    if (word !== undefined) list.push(word)
    word = undefined
    quoted = false
  }
  for (let i = 0; i < command.length;) {
    const c = command[i] ?? ''
    if (PUNCTUATION.has(c)) {
      if ((c === '<' || c === '>') && !quoted && /^\d+$/.test(word?.text ?? '')) fds.add(list.length)
      endWord()
      punctuation += c
      i += 1
      continue
    }
    if (punctuation) list.push({ text: punctuation, shape: punctuation })
    punctuation = ''
    if (BLANK.has(c)) {
      endWord()
      i += 1
      continue
    }
    const [text, shape, next] = wordPart(command, i)
    if (c === "'" || c === '"' || c === '\\') quoted = true
    word = { text: (word?.text ?? '') + text, shape: (word?.shape ?? '') + shape }
    i = next
  }
  endWord()
  if (punctuation) list.push({ text: punctuation, shape: punctuation })
  return { list, fds }
}

interface Body {
  readonly delimiter: string
  readonly tabs: boolean
  readonly expanded: boolean
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

/** `command` read for the plain subset: its text with comments, line continuations, here-document bodies and
 * substitutions removed, the first construct outside the subset, and the commands read inside its substitutions. */
interface Scan {
  out: string
  construct?: string
  quote?: string
  pending: Body[]
  feedsShell: boolean
  nested: Command[]
  /** Unquoted parentheses opened and not closed: a `)` at 0 closes the substitution being read. */
  depth: number
}

/** Records `found` as the scan's construct unless one came first. */
const note = (scan: Scan, found: string | undefined) => {
  scan.construct ??= found
}

const opensSubstitution = (text: string, at: number) => text[at] === '`' || text.startsWith('$(', at)
const braced = (text: string, at: number) => {
  PLAIN_BRACED.lastIndex = at
  return PLAIN_BRACED.test(text) ? undefined : EXPANSION
}

/** Reads `command` from `at`; with `closing`, up to the unquoted `)` that closes a `$(` or `<(`, returning the index after it. */
function scanFrom(command: string, at: number, closing: boolean): { scan: Scan, next: number } {
  const scan: Scan = { out: '', pending: [], feedsShell: false, nested: [], depth: 0 }
  for (let i = at; i < command.length;) {
    if (closing && scan.quote === undefined && command[i] === ')' && scan.depth === 0) {
      if (scan.pending.length) throw new Unparsed('a here-document left open in a substitution')
      return { scan, next: i + 1 }
    }
    i = scanStep(command, i, scan)
  }
  if (closing) throw new Unparsed('No closing parenthesis')
  return { scan, next: command.length }
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
  if (opensSubstitution(command, i)) {
    const next = substitution(command, i, scan)
    scan.out += SUBSTITUTED
    return next
  }
  if (command.startsWith('${', i) && braced(command, i)) {
    note(scan, EXPANSION)
    scan.out += SUBSTITUTED
    return parameterEnd(command, i, scan, scan.quote === '"')
  }
  if (scan.quote === '"') {
    if (c === '"') scan.quote = undefined
    scan.out += c
    return i + 1
  }
  return scanUnquoted(command, i, scan)
}

/** scanStep for a character outside quotes: a quote, a parenthesis, a comment, a here-document or text. */
function scanUnquoted(command: string, i: number, scan: Scan): number {
  const c = command[i] ?? ''
  if (c === '$' && command[i + 1] === "'") note(scan, 'ANSI-C quoting `$\'…\'`')
  if ((c === '<' || c === '>') && command[i + 1] === '(') {
    scan.out += c + SUBSTITUTED
    return enclosed(command, i + 2, scan, 'a process substitution `<(…)`')
  }
  if (c === '(' || c === ')') {
    note(scan, 'a subshell, function or case pattern `( )`')
    scan.depth += c === '(' ? 1 : -1
  }
  if (c === '"' || c === "'") return openQuote(command, i, scan)
  // As in bash, a comment starts at a `#` that begins a word and ends before the newline, which still separates.
  if (c === '#' && WORD_START.has(scan.out.at(-1) ?? ' ')) {
    const end = command.indexOf('\n', i)
    return end === -1 ? command.length : end
  }
  if (c === '\n' && scan.pending.length) {
    scan.out += c
    return skipBodies(command, i + 1, scan)
  }
  const opened = heredoc(command, i)
  if (!opened) {
    scan.out += c
    return i + 1
  }
  if (opened.shell) {
    note(scan, 'a here-document fed to a shell')
    scan.feedsShell = true
  }
  scan.pending.push(opened.body)
  scan.out += opened.text
  return opened.next
}

/** Opens the quote at `i`, or reads the commit message form starting there as the word MESSAGE; the index after it. */
function openQuote(command: string, i: number, scan: Scan): number {
  const message = command[i] === '"' ? commitMessage(command, i, scan.out) : undefined
  if (message !== undefined) {
    scan.out += `'${MESSAGE}'`
    return message
  }
  scan.quote = command[i]
  scan.out += command[i]
  return i + 1
}

/** The index after the commit message form opening at the unquoted `"` at `at`, when the scanned text before it ends
 * with an unquoted -m or --message word; undefined otherwise. */
function commitMessage(command: string, at: number, before: string): number | undefined {
  if (!MESSAGE_FLAG.test(before)) return undefined
  MESSAGE_FORM.lastIndex = at
  const match = MESSAGE_FORM.exec(command)
  return match && !(match[3] ?? '').split('\n').includes(match[2] ?? '') ? MESSAGE_FORM.lastIndex : undefined
}

/** The index after the here-document bodies pending in `scan` that start at `at`; an unquoted body's expansions are read. */
function skipBodies(command: string, at: number, scan: Scan): number {
  let i = at
  for (const { delimiter, tabs, expanded } of scan.pending) {
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
    if (expanded) bodyExpansions(command.slice(start, end), scan)
  }
  scan.pending = []
  return i
}

/** Notes an unquoted here-document body's expansions and reads the commands of its substitutions. */
function bodyExpansions(body: string, scan: Scan): void {
  for (let i = 0; i < body.length;) {
    if (body[i] === '\\') {
      i += 2
    } else if (opensSubstitution(body, i)) {
      note(scan, `${body[i] === '`' ? BACKTICK : SUBSTITUTION} in an unquoted here-document`)
      i = substitution(body, i, scan)
    } else {
      const found = body.startsWith('${', i) ? braced(body, i) : undefined
      if (found) note(scan, `${found} in an unquoted here-document`)
      i += 1
    }
  }
}

/**
 * The index after the parameter expansion `${…}` opening at `at`, read whole so a `|`, `)` or blank in it (`${f%%|*}`)
 * splits no words; the substitutions in it, quoted or not, are read into `scan`, as are nested `${…}`. Where shells
 * disagree on its end it throws Unparsed: a bare `{` in it, or a single quote in one met inside double quotes (`quoted`).
 */
function parameterEnd(command: string, at: number, scan: Scan, quoted: boolean): number {
  let depth = 0
  let inQuotes = false
  for (let j = at; j < command.length;) {
    const d = command[j] ?? ''
    if (d === '\\') {
      j += 2
    } else if (opensSubstitution(command, j)) {
      j = substitution(command, j, scan)
    } else if (d === '"') {
      inQuotes = !inQuotes
      j += 1
    } else if (inQuotes) {
      j += command.startsWith('${', j) ? parameterEnd(command, j, scan, true) - j : 1
    } else if (d === "'") {
      // In a double-quoted expansion shells differ on whether a single quote quotes; both read the same end unless the
      // quoted text holds a brace, a quote, a backslash, a dollar or a backtick (canopi-f47t.52.269).
      const end = command.indexOf(d, j + 1)
      if (end < 0 || (quoted && /[{}"\\$`]/.test(command.slice(j + 1, end)))) {
        throw new Unparsed('a single quote in a parameter expansion, whose end shells read differently')
      }
      j = end + 1
    } else if (command.startsWith('${', j)) {
      depth += 1
      j += 2
    } else if (d === '{') {
      throw new Unparsed('a brace inside a parameter expansion, whose end shells read differently')
    } else {
      if (d === '}' && --depth === 0) return j + 1
      j += 1
    }
  }
  throw new Unparsed('No closing brace')
}

/** Reads the substitution opening at `at` (`$(`, `$((`, a backtick) into `scan`; the index after it. */
function substitution(command: string, at: number, scan: Scan): number {
  if (command[at] === '`') {
    let body = ''
    for (let j = at + 1; j < command.length; j += 1) {
      const d = command[j] ?? ''
      if (d === '`') {
        collect(scan, scanFrom(body, 0, false).scan, BACKTICK)
        return j + 1
      }
      // Inside backticks `\` escapes only `` ` ``, `\` and `$`.
      if (d === '\\' && '`\\$'.includes(command[j + 1] ?? '.')) {
        body += command[j + 1]
        j += 1
      } else {
        body += d
      }
    }
    throw new Unparsed('No closing backtick')
  }
  const inner: Scan = { out: '', pending: [], feedsShell: false, nested: [], depth: 0 }
  const arithmetic = command.startsWith('$((', at) ? arithmeticEnd(command, at, inner) : undefined
  if (arithmetic !== undefined) {
    note(scan, 'an arithmetic expansion `$((…))`')
    note(scan, inner.construct)
    scan.nested.push(...inner.nested)
    scan.feedsShell ||= inner.feedsShell
    return arithmetic
  }
  return enclosed(command, at + 2, scan, SUBSTITUTION)
}

/** The index after the arithmetic expansion `$((…))` at `at`, the substitutions in it (`$(( $(date +%s) - s ))`) read
 * into `inner` by the same scan; undefined when its parentheses close apart (`$((cmd) )`), so it is a substitution holding
 * a subshell. Arithmetic holding a quote or an escape outside its substitutions is not read. */
function arithmeticEnd(command: string, at: number, inner: Scan): number | undefined {
  let depth = 0
  for (let j = at + 1; j < command.length; j += 1) {
    const d = command[j] ?? ''
    if ('\'"\\'.includes(d)) throw new Unparsed('a quote or escape inside an arithmetic expansion')
    if (d === '`' || (command.startsWith('$(', j) && !command.startsWith('$((', j))) {
      j = substitution(command, j, inner) - 1
      continue
    }
    if (d === '(') depth += 1
    if (d === ')' && --depth === 1) return command[j + 1] === ')' ? j + 2 : undefined
  }
  throw new Unparsed('No closing parenthesis')
}

/** Reads the commands of the substitution whose text starts at `start` and ends at its closing `)`; the index after it. */
function enclosed(command: string, start: number, scan: Scan, kind: string): number {
  const { scan: inner, next } = scanFrom(command, start, true)
  collect(scan, inner, kind)
  return next
}

/** Adds a substitution's commands, at every depth, to the scan that holds it. */
function collect(scan: Scan, inner: Scan, kind: string): void {
  note(scan, kind)
  const reading = finish(inner)
  // A case pattern's `)` would have ended the substitution early, leaving its commands outside.
  if (reading.commands.some(({ words }) => words[0] === 'case')) throw new Unparsed('a case statement inside a command substitution, whose patterns end it early')
  scan.nested.push(...reading.commands, ...reading.nested)
  scan.feedsShell ||= reading.feedsShell
}

const isPunctuation = (shape: string) => shape !== '' && [...shape].every((c) => PUNCTUATION.has(c))

/** A simple command's words and the words it redirects output to, before its prefix is read. */
interface Segment {
  readonly words: Word[]
  readonly targets: string[]
}

/** A command read for the plain subset: its simple commands, those read inside its substitutions, the first construct
 * outside the subset (in its text or at a simple command's head), and whether a here-document feeds a shell. */
interface Reading {
  readonly commands: Command[]
  readonly nested: Command[]
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
  if (/[\u0000-\u0002]/.test(command)) throw new Unparsed('a control character')
  return finish(scanFrom(command, 0, false).scan)
}

/** The reading of a finished scan. */
function finish(scan: Scan): Reading {
  const segments = simpleCommands(scan.out)
  const commands = segments.map(({ words, targets }) => build(words, targets))
  // The message word joined to other text (`x'…'`) is no longer the form; headConstruct checks where the rest stand.
  const joined = commands.some((c) => c.words.some((w) => w.includes(MESSAGE) && w !== MESSAGE && w !== `--message=${MESSAGE}`))
  const construct = scan.construct ?? (joined ? SUBSTITUTION : undefined)
    ?? commands.map((c) => c.construct).find((found) => found !== undefined)
  return { commands, nested: scan.nested, construct, feedsShell: scan.feedsShell }
}

// The reserved words a `case` may follow in its simple command's words (`do case x in`, `then case x in`).
const BEFORE_CASE = new Set(['do', 'then', 'else', '{', '!'])
/** Whether `words`, ending in `in`, are `case WORD in` after only reserved words. */
const opensCase = (words: readonly Word[]) => words.length >= 3 && words.at(-3)?.text === 'case' && words.at(-3)?.shape === 'case'
  && words.slice(0, -3).every(({ text, shape }) => text === shape && BEFORE_CASE.has(text))

const isWord = (token: Word, word: string) => token.text === word && token.shape === word

/**
 * A `case` statement's patterns (`case x in a|b) …;; esac`), which are no command: after `case WORD in` and after each
 * `;;`, `;&` or `;;&`, the tokens up to the `)` are dropped, `|` and `(` among them. read() names a token's role before
 * the simple command reading takes it: dropped, a split (a new simple command starts after it), `esac` closing the
 * statement from a pattern's place (a split, then the word), or undefined for an ordinary token.
 */
class CasePatterns {
  private open = 0
  private inPattern = false

  read(token: Word, punctuation: boolean, words: readonly Word[]): 'drop' | 'split' | 'esac' | undefined {
    if (this.inPattern) {
      const esac = !punctuation && isWord(token, 'esac')
      if (esac || (punctuation && token.text.includes(')'))) this.inPattern = false
      if (esac) this.open -= 1
      return esac ? 'esac' : this.inPattern ? 'drop' : 'split'
    }
    if (this.open > 0 && punctuation && /;;|;&/.test(token.text)) {
      this.inPattern = true
      return 'split'
    }
    if (punctuation) return undefined
    if (this.open > 0 && !words.length && isWord(token, 'esac')) this.open -= 1
    if (isWord(token, 'in') && opensCase([...words, token])) {
      this.open += 1
      this.inPattern = true
    }
    return undefined
  }
}

/** The simple commands of scanned `text` (CasePatterns drops a case statement's patterns). */
function simpleCommands(text: string): Segment[] {
  const out: Segment[] = []
  let current: Segment = { words: [], targets: [] }
  const { list, fds } = tokens(text)
  let operand = false
  let fd = false
  const cases = new CasePatterns()
  list.forEach((token, k) => {
    const punctuation = isPunctuation(token.shape)
    const role = operand ? undefined : cases.read(token, punctuation, current.words)
    if (role === 'drop') return
    if (role !== undefined) {
      if (current.words.length) out.push(current)
      current = { words: role === 'esac' ? [token] : [], targets: [] }
      operand = false
      fd = false
      return
    }
    if (!punctuation) {
      fd = !operand && fds.has(k)
      if (!operand) current.words.push(token)
      operand = false
      return
    }
    operand = false
    // A run of punctuation (`&&`, `)&&`, `\n\n`) separates commands unless it is only a redirection.
    if ([...token.text.replace(/&>\|?|>\||[<>]&/g, '')].some((c) => SEPARATING.has(c))) {
      if (current.words.length) out.push(current)
      current = { words: [], targets: [] }
    } else if (fd) {
      current.words.pop() // the fd number of `2>f`
    }
    fd = false
    const next = list[k + 1]
    if (!/[<>][&|]?$/.test(token.text) || next === undefined || isPunctuation(next.shape)) return
    operand = true
    if (token.text.includes('>') && !(token.text.endsWith('&') && /^(?:\d+-?|-)$/.test(next.text))) current.targets.push(next.text)
  })
  if (current.words.length) out.push(current)
  return out
}
