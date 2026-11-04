// policy/gate/agent-hooks-shell.ts: how the agent hooks (agent-hooks.ts) read a Bash command (2.1-M196, 2.1-M219;
// ported from scripts/agent_hooks.py, 2.1-M349). Comments and here-document bodies are removed first, so a commit
// message's words are never read as commands; then the command is split into simple commands (`&&`, `||`, `;`, `|`,
// `&`, newlines, parentheses), each a list of words with its quotes removed, the way POSIX shlex reads them. What cannot
// be read (an unbalanced quote, a trailing backslash) throws Unparsed, and the hook asks.
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

/** The words and punctuation runs of `command`, as Python's shlex (posix, punctuation_chars, whitespace_split). */
function tokens(command: string): string[] {
  const out: string[] = []
  let word: string | undefined
  let punctuation = ''
  const endWord = () => {
    if (word !== undefined) out.push(word)
    word = undefined
  }
  for (let i = 0; i < command.length;) {
    const c = command[i] ?? ''
    if (PUNCTUATION.has(c)) {
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
    word = (word ?? '') + text
    i = next
  }
  endWord()
  if (punctuation) out.push(punctuation)
  return out
}

/** The here-document opening at `at` (`<<EOF`, `<<-'EOF'`): its text, its delimiter and tab stripping when a command
 * reads its body as text, and the index after it; undefined when none opens there. */
function heredoc(command: string, at: number): { text: string, body?: [string, boolean], next: number } | undefined {
  if (!command.startsWith('<<', at) || command.startsWith('<<<', at)) return undefined
  HEREDOC.lastIndex = at
  const match = HEREDOC.exec(command)
  if (!match) return undefined
  const lineStart = command.lastIndexOf('\n', at - 1) + 1
  const head = (command.slice(lineStart, at).split(/[;&|(]/).pop() ?? '').split(/\s+/).filter((w) => w !== '')
  const words = head.filter((w) => !ASSIGNMENT.test(w))
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

/**
 * `command` with its comments and here-document bodies removed; a body fed to a shell (`bash <<EOF`) stays, since the
 * shell runs it. Quotes are tracked, so a `<<` or `#` inside a quoted string is part of that string. As in bash, a
 * comment starts at a `#` that begins a word and ends before the newline, which still separates commands.
 */
function stripText(command: string): string {
  const out: string[] = []
  let quote: string | undefined
  let pending: [string, boolean][] = []
  for (let i = 0; i < command.length;) {
    const c = command[i] ?? ''
    if (c === '\\' && quote !== "'") {
      out.push(command.slice(i, i + 2))
      i += 2
      continue
    }
    if (quote) {
      if (c === quote) quote = undefined
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === '#' && (!out.length || WORD_START.has(out[out.length - 1] ?? ''))) {
      const end = command.indexOf('\n', i)
      i = end === -1 ? command.length : end
      continue
    } else if (c === '\n' && pending.length) {
      out.push(c)
      i = skipBodies(command, i + 1, pending)
      pending = []
      continue
    } else {
      const opened = heredoc(command, i)
      if (opened) {
        if (opened.body) pending.push(opened.body)
        out.push(opened.text)
        i = opened.next
        continue
      }
    }
    out.push(c)
    i += 1
  }
  return out.join('')
}

/** The simple commands of `command`, each a list of words, in order; a redirection such as `>` or `2>&1` is dropped. */
export function segments(command: string): string[][] {
  const out: string[][] = []
  let current: string[] = []
  for (const token of tokens(stripText(command))) {
    // A run of punctuation (`&&`, `)&&`, `\n\n`) separates commands unless it is only a redirection.
    if (token && [...token].every((c) => PUNCTUATION.has(c))) {
      if ([...token.replaceAll('>&', '').replaceAll('<&', '')].some((c) => SEPARATING.has(c))) {
        if (current.length) out.push(current)
        current = []
      }
      continue
    }
    current.push(token)
  }
  if (current.length) out.push(current)
  return out
}
