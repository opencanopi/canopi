// policy/gate/agent-hooks-stamp.ts: whether a simple command the agent hooks read (agent-hooks.ts) may write a pre-push
// stamp (stamp.ts) under the git directory's canopi-gate/ (2.1-Q266): by a word naming that directory, a variable holding
// it, a redirection into it, or a writer run inside it.
import { posix } from 'node:path'

/** Where a command runs: inside the stamp directory or not, and a path word resolved against that directory. */
export interface Place {
  readonly inside: boolean
  resolve(raw: string): string | undefined
}

// The stamp directory (stamp.ts) as a path word, the programs that write no file their words name (readers, and cd), and
// the words of gh and bd that are text for GitHub or beads: their text options' values and, in bd's text commands, an
// operand after no other option. gh and bd also write files (`gh run download -D`, `bd export -o`), so any other word of
// theirs naming the stamp directory is refused.
export const STAMP_PATH = /(?:^|\/)canopi-gate(?:\/|$)/
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'ls', 'stat', 'jq', 'wc', 'file', 'grep', 'rg', 'diff',
  'readlink', 'realpath', 'du', 'test', '[', 'sha256sum', 'git', 'cd'])
const TEXT_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  gh: new Set(['--body', '-b', '--title', '-t', '--subject', '--notes', '-n', '--raw-field', '-f']),
  bd: new Set(['--title', '--description', '-d', '--notes', '--design', '--acceptance', '--reason', '--message', '-m']),
}
const BD_TEXT_COMMANDS = new Set(['create', 'q', 'update', 'close', 'comment', 'comments', 'note'])

/** Whether `words[k]` (k >= 1) of a gh or bd command is text for GitHub or beads rather than a path it may write. */
function isText(program: string, words: readonly string[], k: number): boolean {
  const text = TEXT_OPTIONS[program]
  if (!text) return false
  const word = words[k] ?? ''
  const before = words[k - 1] ?? ''
  if (program === 'bd' && !BD_TEXT_COMMANDS.has(words.slice(1).find((w) => !w.startsWith('-')) ?? '')) return false
  if (text.has(before) || (word.includes('=') && text.has(word.split('=', 1)[0] ?? ''))) return true
  return program === 'bd' && !word.startsWith('-') && !before.startsWith('-')
}

/**
 * Whether a simple command may write a stamp: a variable naming the stamp directory (which would carry it past the word
 * check), or a program other than READERS run inside it or naming it in a word that is not text.
 */
export function writesStamp(words: readonly string[], env: Readonly<Record<string, string>>, ctx: Place): boolean {
  if (Object.values(env).some((value) => STAMP_PATH.test(value))) return true
  const program = posix.basename(words[0] ?? '')
  return words.length > 0 && !READERS.has(program) && (ctx.inside
    || words.some((word, k) => k > 0 && STAMP_PATH.test(word) && !isText(program, words, k)))
}

/**
 * Whether a redirection writes into the stamp directory: its target names it, or resolves into it from the directory
 * the command runs in, or cannot be resolved while that directory is inside it.
 */
export function redirectsToStamp(target: string, ctx: Place): boolean {
  return STAMP_PATH.test(target) || STAMP_PATH.test(ctx.resolve(target) ?? (ctx.inside ? 'canopi-gate/' : ''))
}
