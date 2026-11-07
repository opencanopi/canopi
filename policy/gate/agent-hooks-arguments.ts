// policy/gate/agent-hooks-arguments.ts: git's own arguments as the agent hooks read them (agent-hooks.ts;
// canopi-f47t.52.269, within 2.1-M408): each word's `$name` variables expanded through the variables the command knows,
// with where an unknown one sits; a subcommand's flags with its option values skipped, so an attached value (`-bfoo`) is
// no flag cluster; and what a `git checkout` operand names, which only the repository tells: a ref it switches to, or a
// pathspec whose worktree copy it overwrites (a discard) even without `--`.
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PARAMETER, type Word } from './agent-hooks-command.ts'
import { gitOut } from './agent-hooks-context.ts'

// A variable's value the hook puts in a git argument: a plain word, so it cannot split into more words.
const PLAIN_VALUE = /^[A-Za-z0-9_./+:@%,=~^-]+$/

/** git's words with their known variables expanded, and for each word holding an unknown one (or a value that is not a
 * plain word) the text before that variable. */
export function expandArguments(shaped: readonly Word[], lookup: (name: string) => string | undefined):
  { words: string[], unknown: Map<number, string> } {
  const unknown = new Map<number, string>()
  const words = shaped.map(({ text, shape }, index) => {
    let out = ''
    for (let k = 0; k < shape.length;) {
      PARAMETER.lastIndex = k
      const match = shape[k] === '$' ? PARAMETER.exec(shape)?.[0] : undefined
      if (!match) {
        out += text[k] ?? ''
        k += 1
        continue
      }
      const value = lookup(match.replace(/[${}]/g, ''))
      if (value === undefined || !PLAIN_VALUE.test(value)) {
        if (!unknown.has(index)) unknown.set(index, out)
        out += match
      } else {
        out += value
      }
      k += match.length
    }
    return out
  })
  return { words, unknown }
}

/** A subcommand's arguments read as git reads them: each flag word and short flag letter (`-qf` is `-q` and `-f`), the
 * values of the options in `shortValue` (a cluster's rest or the next word) and `longValue` skipped, the operands, and
 * whether a `--` came before the last operands. */
export function optionWords(args: readonly string[], shortValue: string, longValue: ReadonlySet<string>):
  { flags: string[], operands: string[], separated: boolean } {
  const flags: string[] = []
  const operands: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] ?? ''
    if (word === '--') return { flags, operands: [...operands, ...args.slice(i + 1)], separated: true }
    if (word.startsWith('--')) {
      flags.push(word)
      if (!word.includes('=') && longValue.has(word)) i += 1
    } else if (word.startsWith('-') && word.length > 1) {
      for (const [k, letter] of [...word.slice(1)].entries()) {
        flags.push(`-${letter}`)
        if (shortValue.includes(letter)) {
          if (k === word.length - 2) i += 1
          break
        }
      }
    } else {
      operands.push(word)
    }
  }
  return { flags, operands, separated: false }
}

/** Whether `name` resolves to a tree-ish in the repository at `target`. */
const treeIsh = (target: string, name: string) => gitOut(target, 'rev-parse', '--verify', '-q', `${name}^{tree}`) !== undefined

/**
 * What `git checkout` with these operands does in the repository at `target` (none of -b, -B, --orphan given): `switch`
 * when it names one ref, the previous branch (`-`) or a branch only one remote holds (git creates it); `discard` when an
 * operand is a pathspec, after a tree-ish or alone, naming a path that exists or a pattern; `unknown` when the repository
 * is unknown or an operand is neither.
 */
export function checkoutOperands(operands: readonly string[], target: string | undefined): 'switch' | 'discard' | 'unknown' {
  if (!operands.length || (operands.length === 1 && operands[0] === '-')) return 'switch'
  if (target === undefined) return 'unknown'
  const [first = '', ...rest] = operands
  if (treeIsh(target, first)) return rest.length ? 'discard' : 'switch'
  if (!rest.length && gitOut(target, 'for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${first}`)) return 'switch'
  return operands.some((path) => /^:|[*?[]/.test(path) || existsSync(resolvePath(target, path))) ? 'discard' : 'unknown'
}
