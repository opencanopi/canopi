// policy/gate/agent-hooks-shell.ts: how the agent hooks (agent-hooks.ts) read a Bash command (2.1-M196, 2.1-M219;
// ported from scripts/agent_hooks.py, 2.1-M349). Comments and here-document bodies are removed first, so a commit
// message's words are never read as commands; then the command is split into simple commands (`&&`, `||`, `;`, `|`,
// `&`, newlines, parentheses), each a list of words with its quotes removed, the way POSIX shlex reads them, without the
// reserved words before its program. A command substitution inside double quotes or backticks is read the same way, so
// every command the shell would run is judged. What cannot be read (an unbalanced quote, a trailing backslash, an
// unclosed substitution) throws Unparsed, and the hook asks.
import { posix } from 'node:path'

/** A command the hook cannot read with confidence: it asks. */
export class Unparsed extends Error {}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const PUNCTUATION = new Set('();<>|&\n')
const SEPARATING = new Set('();|&\n')
const BLANK = new Set(' \t\r')
const WORD_START = new Set(' \t\r\n;&|()<>')
const HEREDOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/y
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// The reserved words and grouping words a command may follow (`if git ...`, `then git ...`, `! git ...`, `{ git ...`):
// none is the program, so a simple command's leading ones are dropped.
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', '}'])

/** The text of the double-quoted string opening at `at` and the index after it; `\"` and `\\` are escapes. */
function doubleQuoted(command: string, at: number): [string, number] {
  let text = ''
  for (let j = at + 1; j < command.length; j += 1) {
    const d = command[j]
    if (d === '"') return [text, j + 1]
    if (d === '\\' && (command[j + 1] === '"' || command[j + 1] === '\\')) {
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
 * indexes of the words that are a redirection's fd: unquoted digits written against `<` or `>` (`2>f`, not `2 > f`),
 * and where each token starts in `command`.
 */
function tokens(command: string): { list: string[], fds: Set<number>, starts: number[] } {
  const out: string[] = []
  const fds = new Set<number>()
  const starts: number[] = []
  let word: string | undefined
  let quoted = false
  let punctuation = ''
  let start = 0
  const push = (token: string) => {
    out.push(token)
    starts.push(start)
  }
  const endWord = () => {
    if (word !== undefined) push(word)
    word = undefined
    quoted = false
  }
  for (let i = 0; i < command.length;) {
    const c = command[i] ?? ''
    if (PUNCTUATION.has(c)) {
      if ((c === '<' || c === '>') && !quoted && /^\d+$/.test(word ?? '')) fds.add(out.length)
      endWord()
      if (!punctuation) start = i
      punctuation += c
      i += 1
      continue
    }
    if (punctuation) push(punctuation)
    punctuation = ''
    if (BLANK.has(c)) {
      endWord()
      i += 1
      continue
    }
    const [text, next] = wordPart(command, i)
    if (word === undefined) start = i
    if (c === "'" || c === '"' || c === '\\') quoted = true
    word = (word ?? '') + text
    i = next
  }
  endWord()
  if (punctuation) push(punctuation)
  return { list: out, fds, starts }
}

/** The here-document opening at `at` (`<<EOF`, `<<-'EOF'`): its text, its delimiter and tab stripping when a command
 * reads its body as text, and the index after it; undefined when none opens there. */
function heredoc(command: string, at: number): { text: string, body?: [string, boolean], next: number } | undefined {
  if (!command.startsWith('<<', at) || command.startsWith('<<<', at)) return undefined
  HEREDOC.lastIndex = at
  const match = HEREDOC.exec(command)
  if (!match) return undefined
  const lineStart = command.lastIndexOf('\n', at - 1) + 1
  const head = (command.slice(lineStart, at).split(/[;&|(`]/).pop() ?? '').split(/\s+/).filter((w) => w !== '')
  const words = head.filter((w) => !ASSIGNMENT.test(w) && !RESERVED.has(w))
  // A body fed to a shell (`bash <<EOF`) stays, since the shell runs it.
  const shell = words.length > 0 && SHELLS.has(posix.basename(words[0] ?? ''))
  return { text: match[0], body: shell ? undefined : [match[3] ?? '', match[1] === '-'], next: HEREDOC.lastIndex }
}

/** The index after the here-document bodies `pending` that start at `at`. */
function skipBodies(command: string, at: number, pending: readonly [string, boolean][]): number {
  let i = at
  for (const [delimiter, tabs] of pending) {
    while (i < command.length) {
      const end = command.indexOf('\n', i)
      const line = end === -1 ? command.slice(i) : command.slice(i, end)
      i = end === -1 ? command.length : end + 1
      if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break
    }
  }
  return i
}

/** A command substitution the shell runs inside a word (`"$(...)"`, `` `...` ``): where it stands in the stripped text,
 * and its own stripped text and substitutions. */
interface Substitution {
  readonly at: number
  readonly text: string
  readonly inner: readonly Substitution[]
}

/**
 * `command` from `at` with its comments and here-document bodies removed, up to `close` (the `)` ending a `$(` or the
 * backtick ending a backtick substitution; the end when undefined), and the index after it. A body fed to a shell
 * (`bash <<EOF`) stays, since the shell runs it. Quotes are tracked, so a `<<` or `#` inside a quoted string is part of
 * that string. As in bash, a comment starts at a `#` that begins a word and ends before the newline, which still
 * separates commands. A substitution inside double quotes or backticks is read the same way and returned beside the
 * text, so its commands are judged; one outside quotes is split by its parentheses like any other.
 */
function strip(command: string, at = 0, close?: ')' | '`'): { text: string, next: number, inner: Substitution[] } {
  const state: Stripping = { out: '', inner: [], depth: 0, pending: [], closed: false }
  for (let i = at; i < command.length;) {
    i = stripStep(command, i, state, close)
    if (state.closed) return { text: state.out, next: i, inner: state.inner }
  }
  if (close) throw new Unparsed(`No closing ${close}`)
  return { text: state.out, next: command.length, inner: state.inner }
}

/** What strip has read so far: its text, substitutions, open quote, parenthesis depth and here-documents to skip. */
interface Stripping {
  out: string
  readonly inner: Substitution[]
  quote?: string
  depth: number
  pending: [string, boolean][]
  closed: boolean
}

/** Reads the character at `i` into `state`; the index after what it read. */
function stripStep(command: string, i: number, state: Stripping, close: ')' | '`' | undefined): number {
  const c = command[i] ?? ''
  if (c === '\\' && state.quote !== "'") {
    state.out += command.slice(i, i + 2)
    return i + 2
  }
  // Bash finds a backtick substitution's end before it reads quotes.
  if (c === '`' && close === '`') {
    state.closed = true
    return i + 1
  }
  if (state.quote !== "'" && (c === '`' || (state.quote === '"' && command.startsWith('$(', i)))) {
    const open = c === '`' ? '`' : '$('
    const body = strip(command, i + open.length, c === '`' ? '`' : ')')
    state.inner.push({ at: state.out.length, text: body.text, inner: body.inner })
    state.out += `${open}${body.text}${c === '`' ? '`' : ')'}`
    return body.next
  }
  if (!state.quote) return stripUnquoted(command, i, state, close)
  if (c === state.quote) state.quote = undefined
  state.out += c
  return i + 1
}

/** stripStep for a character outside quotes: a quote, a parenthesis, a comment, a here-document or plain text. */
function stripUnquoted(command: string, i: number, state: Stripping, close: ')' | '`' | undefined): number {
  const c = command[i] ?? ''
  if (c === "'" || c === '"') {
    state.quote = c
  } else if (close === ')' && (c === '(' || c === ')')) {
    state.depth += c === '(' ? 1 : -1
    state.closed = state.depth < 0
    if (state.closed) return i + 1
  } else if (c === '#' && (!state.out.length || WORD_START.has(state.out[state.out.length - 1] ?? ''))) {
    const end = command.indexOf('\n', i)
    return end === -1 ? command.length : end
  } else if (c === '\n' && state.pending.length) {
    state.out += c
    const next = skipBodies(command, i + 1, state.pending)
    state.pending = []
    return next
  } else {
    const opened = heredoc(command, i)
    if (opened) {
      if (opened.body) state.pending.push(opened.body)
      state.out += opened.text
      return opened.next
    }
  }
  state.out += c
  return i + 1
}

const isPunctuation = (token: string) => token !== '' && [...token].every((c) => PUNCTUATION.has(c))

/** A simple command's words, and the words it redirects output to (`> f`, `>> f`, `&> f`, `>| f`, `2>| f`; not `2>&1`). */
export interface Segment {
  readonly words: string[]
  readonly targets: string[]
}

/**
 * The simple commands of `command`, in order; a command substitution's commands come before the one whose word holds it,
 * since the shell runs them first. A redirection (`2> f`, `< f`, `<<EOF`, `2>&1`), wherever it stands, is no word: its fd
 * number and its operand are dropped, so words[0] is the program; so are the reserved and grouping words before it
 * (`then`, `!`, `{`). Each segment names the files it redirects output to, which a check resolves against the directory
 * that command runs in.
 */
export function segments(command: string): Segment[] {
  const { text, inner } = strip(command)
  return simpleCommands(text, inner)
}

/** The simple commands of stripped `text`, with those of its substitutions `inner`. */
function simpleCommands(text: string, inner: readonly Substitution[]): Segment[] {
  const out: Segment[] = []
  let current: Segment = { words: [], targets: [] }
  const { list, fds, starts } = tokens(text)
  let substitution = 0
  // The commands of the substitutions standing before `end` in the text.
  const flush = (end: number) => {
    for (; substitution < inner.length && (inner[substitution]?.at ?? end) < end; substitution += 1) {
      const { text: body, inner: nested } = inner[substitution] as Substitution
      out.push(...simpleCommands(body, nested))
    }
  }
  let operand = false
  let fd = false
  list.forEach((token, k) => {
    if (!isPunctuation(token)) {
      fd = !operand && fds.has(k)
      if (!operand && !(current.words.length === 0 && RESERVED.has(token))) current.words.push(token)
      operand = false
      return
    }
    operand = false
    // A run of punctuation (`&&`, `)&&`, `\n\n`) separates commands unless it is only a redirection.
    if ([...token.replace(/&>\|?|>\||[<>]&/g, '')].some((c) => SEPARATING.has(c))) {
      flush(starts[k] ?? text.length)
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
  flush(Infinity)
  if (current.words.length) out.push(current)
  return out
}
