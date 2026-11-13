// policy/gate/agent-hooks.ts: the agent hooks for Claude Code sessions in Canopi (2.1-M196, 2.1-M339; ADR 0028 Agent
// enforcement; cut to plain refusals that never prompt by 2.1-Q331), a mode of the gate's entry:
//
//   node policy/gate/cli.mjs agent-hook pre-tool-use     PreToolUse JSON on stdin; prints a deny, or nothing
//   node policy/gate/cli.mjs agent-hook session-start    SessionStart JSON on stdin; prints a warning when the hooks would
//                                                        not run in this worktree; never blocks
//   node policy/gate/cli.mjs agent-hook planted <command.json>...
//                                                        one JSON line per file, {file, decision, reason}: the planted
//                                                        runner of policy/adapters/agent-hooks.mjs
//
// The hook never answers `ask`: a hook's ask prompts the user even in a bypass session (2.1-Q331). A Bash command is
// scanned, not parsed: split into simple commands at `;`, `&`, `|`, parentheses and newlines, outside quotes; a quoted
// word, a `$(…)` or backtick substitution and a here-document body are text the scan never reads, so what it cannot read
// passes, and a false refusal costs the agent a rewrite. A git command is one whose program word is git after only
// assignments, options, numbers and wrapper words (env, nice, timeout, …). Its refusals, each a deny whose reason starts
// with its rule id in brackets (policy/rules.json, tool agent-hooks) and names what to do instead:
//   - anywhere: a gate bypass (--no-verify or `commit -n` on a git command that runs hooks, HUSKY= as its prefix or
//     exported before it, a core.hooksPath override by `-c` or a git config write other than `git config
//     core.hooksPath .githooks`), and a change to the shared stash stack's top: a stash push without a message, a pop,
//     a drop without an entry, a clear;
//   - in the user's checkout (the main worktree of CLAUDE_PROJECT_DIR's repository, followed through `cd`, `pushd` and
//     `git -C` written as literal paths, a subshell's cd kept inside it; a linked worktree or another repository is
//     never it): a commit, `reset --hard`, a checkout given `--`, `-f` or `.`, a restore of the worktree, `clean -f`,
//     and any stash but a list or show.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve as resolvePath } from 'node:path'

const ASK_IN_CHAT = 'ask the user in chat; they run it with `!`'
const FIX_GATE = 'commit through the pre-commit gate instead and fix what it reports'
const REASONS = {
  'hook-no-verify': `--no-verify skips the pre-commit gate (2.1-M196); ${FIX_GATE}`,
  'hook-husky-skip': `HUSKY= before a git command skips the hooks (2.1-M196); rewrite without it (HUSKY=0 belongs only before `
    + `npm ci or npm install, as a command of its own); ${FIX_GATE}`,
  'hook-hooks-path-override': 'this changes core.hooksPath, which must stay the shared relative .githooks (2.1-M14, 2.1-M196); '
    + 'rewrite as `git config core.hooksPath .githooks`, or ask the user in chat',
  'hook-bare-stash': 'the stash stack is shared by every worktree (AGENTS.md, 2.1-M196); set work aside with a WIP commit on '
    + 'your branch instead, or rewrite as `git stash push -m <unique-tag>` and restore by `git stash apply <sha>`',
  'hook-checkout-stash': 'the uncommitted files in the user\'s checkout are the user\'s (AGENTS.md); work in a worktree under '
    + `.rq-scratch/ instead, or ${ASK_IN_CHAT}`,
  'hook-user-checkout-commit': 'this commits in the user\'s checkout (the main worktree, AGENTS.md); work in a worktree under '
    + `.rq-scratch/ instead, and update the checkout only by fetch and --ff-only; if it must, ${ASK_IN_CHAT}`,
  'hook-reset-hard': `git reset --hard in the user's checkout discards their work (2.1-M339); ${ASK_IN_CHAT}`,
  'hook-discard': `this discards uncommitted work in the user's checkout (2.1-M339); ${ASK_IN_CHAT}`,
} as const
type Rule = keyof typeof REASONS
// The stash refusal in the user's checkout is a hook-bare-stash site with its own reason.
const RULE_ID = (rule: Rule) => (rule === 'hook-checkout-stash' ? 'hook-bare-stash' : rule)

interface Decision {
  readonly decision: 'deny'
  readonly reason: string
}
type Verdict = Decision | undefined
const deny = (rule: Rule): Decision => ({ decision: 'deny', reason: `[${RULE_ID(rule)}] ${REASONS[rule]}` })

// --- the scan ---------------------------------------------------------------------------------------------------------

/** The index just past the `)` closing the `$(` at `from` (at its `(`), counting nested parentheses outside quotes. */
function closeParen(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]
    if (c === '\\') i += 1
    else if (c === "'") i = text.indexOf("'", i + 1) < 0 ? text.length : text.indexOf("'", i + 1)
    else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const delimiter = heredocDelimiter(text, i + 2)
      const line = delimiter ? text.indexOf('\n', delimiter.end) : -1
      if (delimiter && line >= 0) i = skipHeredocs(text, line + 1, [delimiter.word]) - 1
    } else if (c === '(') depth += 1
    else if (c === ')' && --depth === 0) return i + 1
  }
  return text.length
}

/** The here-document delimiter after a `<<` ending before `from` (its `-` and quotes dropped), and where it ends. */
function heredocDelimiter(text: string, from: number): { word: string, end: number } | undefined {
  const match = /^-?[ \t]*(['"]?)([^\s'";&|<>()]+)\1/.exec(text.slice(from))
  return match ? { word: match[2] ?? '', end: from + match[0].length } : undefined
}

/** The end of the double-quoted word whose opening quote is at `from`, and its text; a substitution inside is kept raw. */
function doubleQuoted(text: string, from: number): [number, string] {
  let out = ''
  for (let i = from + 1; i < text.length; i += 1) {
    const c = text[i] ?? ''
    if (c === '"') return [i + 1, out]
    if (c === '\\' && i + 1 < text.length) {
      out += text[i + 1]
      i += 1
    } else if (c === '$' && text[i + 1] === '(') {
      const end = closeParen(text, i + 1)
      out += text.slice(i, end)
      i = end - 1
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1)
      out += text.slice(i, end < 0 ? text.length : end + 1)
      i = end < 0 ? text.length : end
    } else {
      out += c
    }
  }
  return [text.length, out]
}

/** The index just past a quoted or substituted word part starting at `i` (a quote, `$(` or a backtick), and its text:
 * a single- or double-quoted part's text unquoted, a substitution raw; undefined when `i` starts none. */
function part(text: string, i: number): [number, string] | undefined {
  const c = text[i]
  const upTo = (close: number, keep: boolean) => {
    const end = close < 0 ? text.length : close + 1
    return [end, keep ? text.slice(i, end) : text.slice(i + 1, close < 0 ? text.length : close)] as [number, string]
  }
  if (c === "'") return upTo(text.indexOf("'", i + 1), false)
  if (c === '"') return doubleQuoted(text, i)
  if (c === '`') return upTo(text.indexOf('`', i + 1), true)
  if (c === '$' && text[i + 1] === '(') return upTo(closeParen(text, i + 1) - 1, true)
  if (c === '\\') return [i + 2, text[i + 1] === '\n' ? '' : text[i + 1] ?? '']
  return undefined
}

/** The words of a Bash command as scan reads them, one simple command at a time. */
class Scanner {
  readonly segments: string[][] = []
  private words: string[] = []
  private word: string | undefined
  private redirect = false
  private readonly heredocs: string[] = []
  private readonly text: string
  constructor(text: string) {
    this.text = text
  }

  flush() {
    if (this.word !== undefined && !this.redirect) this.words.push(this.word)
    if (this.word !== undefined) this.redirect = false
    this.word = undefined
  }

  end() {
    this.flush()
    this.redirect = false
    if (this.words.length) this.segments.push(this.words)
    this.words = []
  }

  /** Reads the character at `i`; the index of the next one to read. */
  step(i: number): number {
    const c = this.text[i] ?? ''
    const quoted = part(this.text, i)
    if (quoted) {
      // A line continuation joins words and makes none of its own.
      if (c !== '\\' || quoted[1] !== '' || this.word !== undefined) this.word = (this.word ?? '') + quoted[1]
      return quoted[0]
    }
    if (c === '#' && this.word === undefined) {
      const line = this.text.indexOf('\n', i)
      return line < 0 ? this.text.length : line
    }
    if (c === '\n') {
      this.end()
      return skipHeredocs(this.text, i + 1, this.heredocs.splice(0))
    }
    if (c === ' ' || c === '\t') this.flush()
    else if (';&|'.includes(c)) this.end()
    else if (c === '(' || c === ')') {
      this.end()
      this.segments.push([c])
    }
    else if (c === '<' || c === '>') return this.redirection(i)
    else this.word = (this.word ?? '') + c
    return i + 1
  }

  /** A redirection at `i`: its operator and target are no words; a here-document's delimiter is kept for its body. */
  private redirection(i: number): number {
    if (this.word !== undefined && /^\d+$/.test(this.word)) this.word = undefined
    this.flush()
    let at = i + 1
    while (/[<>&|]/.test(this.text[at] ?? '')) at += 1
    const op = this.text.slice(i, at)
    const delimiter = op === '<<' ? heredocDelimiter(this.text, at) : undefined
    if (delimiter) {
      this.heredocs.push(delimiter.word)
      return delimiter.end
    }
    if (!op.endsWith('&')) this.redirect = true
    while (op.endsWith('&') && /[\d-]/.test(this.text[at] ?? '')) at += 1
    return at
  }
}

/**
 * `command`'s simple commands as word lists, quotes removed. A word holding a substitution keeps it raw (`$(…)`,
 * backticks), so no rule reads into it; a here-document's body and a comment are dropped; a redirection's operator and
 * target are no words; a subshell's `(` and `)` are segments of their own. Nothing here throws: an unclosed quote runs
 * to the end.
 */
export function scan(command: string): string[][] {
  const scanner = new Scanner(command)
  for (let i = 0; i < command.length;) i = scanner.step(i)
  scanner.end()
  return scanner.segments
}

/** The index past the here-document bodies starting at `from`, one per delimiter, each ending at a line holding it alone. */
function skipHeredocs(command: string, from: number, delimiters: readonly string[]): number {
  let at = from
  for (const delimiter of delimiters) {
    while (at < command.length) {
      const stop = command.indexOf('\n', at)
      const line = command.slice(at, stop < 0 ? command.length : stop)
      at = stop < 0 ? command.length : stop + 1
      if (line.trim() === delimiter) break
    }
  }
  return at
}

// The words that may stand before a program word: wrappers, reserved words, and a group's brace.
const WRAPPERS = new Set(['env', 'nice', 'ionice', 'timeout', 'nohup', 'command', 'time', 'exec', 'sudo', 'systemd-run',
  'stdbuf', 'chrt', 'taskset', 'builtin', 'noglob', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{'])
// A prefix word: an option, an assignment, a number or duration, or a capitalised option value (`-s KILL`, `-u X`).
const PREFIX = /^(?:-.*|[A-Za-z_][A-Za-z0-9_]*=.*|[0-9.]+[smhd]?|[A-Z][A-Z0-9_]*)$/

/** Where a segment's program word sits once its prefix (PREFIX words and WRAPPERS) is passed; its length when none. */
export function programAt(words: readonly string[]): number {
  let k = 0
  while (k < words.length && (PREFIX.test(words[k] ?? '') || WRAPPERS.has(words[k] ?? ''))) k += 1
  return k
}

// --- where it runs ----------------------------------------------------------------------------------------------------

/** git's trimmed output at `cwd`, or undefined when it fails; never under the caller's GIT_* variables. */
function gitOut(cwd: string, ...args: string[]): string | undefined {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, env })
  return run.status === 0 ? run.stdout.trim() : undefined
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

/** The top and common dir of the repository at `cwd`, or undefined. */
function repository(cwd: string): { top: string, common: string } | undefined {
  if (!existsSync(cwd)) return undefined
  const [top, common] = gitOut(cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir')?.split('\n') ?? []
  return top && common ? { top: real(top), common: real(common) } : undefined
}

/** The main worktree of the repository at `cwd`, or undefined. */
function mainWorktree(cwd: string): string | undefined {
  const common = repository(cwd)?.common
  return common && basename(common) === '.git' ? dirname(common) : undefined
}

/** `raw` (a cd or -C operand, written as a literal path or under `~/` or $HOME) against `base`; undefined otherwise. */
function resolve(base: string | undefined, raw: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = env['HOME'] ?? homedir()
  const expanded = raw.replace(/^(?:~(?=\/|$)|\$HOME(?![A-Za-z0-9_])|\$\{HOME\})/, home)
  if (base === undefined || /[$`*?[{~]/.test(expanded)) return undefined
  return resolvePath(base, expanded)
}

class Place {
  cwd: string | undefined
  private readonly checkouts = new Map<string, boolean>()
  private readonly main: string | undefined
  readonly env: NodeJS.ProcessEnv
  constructor(cwd: string, main: string | undefined, env: NodeJS.ProcessEnv) {
    this.cwd = cwd
    this.main = main
    this.env = env
  }

  /** `cd`, `pushd` or `popd` with `args`: followed to one literal operand, else the directory is unknown. */
  move(program: string, args: readonly string[]) {
    const operands = args.filter((a) => !/^-[LPeqs@]+$/.test(a) && a !== '--')
    if (program === 'popd' || operands.length > 1 || operands[0] === '-' || /^[-+]\d/.test(operands[0] ?? '')) this.cwd = undefined
    else this.cwd = resolve(this.cwd, operands[0] ?? (program === 'cd' ? '~' : '.'), this.env)
  }

  /** Whether `directory` is the user's checkout; an unknown directory is not. */
  isUserCheckout(directory: string | undefined): boolean {
    if (directory === undefined || this.main === undefined) return false
    const known = this.checkouts.get(directory)
    if (known !== undefined) return known
    const here = repository(directory)
    const mine = here !== undefined && here.top === this.main && here.common === join(this.main, '.git')
    this.checkouts.set(directory, mine)
    return mine
  }
}

// --- the rules --------------------------------------------------------------------------------------------------------

/** Whether `word` is the long option `full` or a prefix of it of at least `shortest`, as git reads it. */
const longOption = (word: string, full: string, shortest: string) => {
  const name = word.split('=', 1)[0] ?? ''
  return word.startsWith('--') && name.length >= shortest.length && full.startsWith(name)
}
/** Whether a short option cluster in `args` holds `letter` before any of `valued`, the letters that take a value. */
const shortFlag = (args: readonly string[], letter: string, valued = '') => args.some((a) => {
  if (!/^-[A-Za-z]+$/.test(a)) return false
  const stop = [...valued].map((v) => a.indexOf(v, 1)).filter((k) => k > 0)
  const at = a.indexOf(letter, 1)
  return at > 0 && (stop.length === 0 || at <= Math.min(...stop))
})
const isHooksPath = (value: string) => (value.split('=', 1)[0] ?? '').toLowerCase() === 'core.hookspath'
const HOOK_RUNNING = new Set(['commit', 'push', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am'])
// git's global options that take the next word as their value.
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path'])

/** git config writing core.hooksPath: a set, unset or edit, other than the one value SessionStart's fix writes. */
function configWritesHooksPath(args: readonly string[]): boolean {
  const flags = args.filter((a) => a.startsWith('-'))
  const operands = args.filter((a) => !a.startsWith('-'))
  const verb = ['set', 'unset', 'get', 'list', 'edit'].includes(operands[0] ?? '') ? operands.shift() : undefined
  if (!isHooksPath(operands[0] ?? '') || verb === 'get' || verb === 'list') return false
  if (flags.some((f) => /^--(?:get|list|show)/.test(f) || f === '-l')) return false
  const restores = (verb === undefined || verb === 'set') && operands.length === 2 && operands[1] === '.githooks'
    && flags.every((f) => f === '--local')
  return !restores && (verb !== undefined || operands.length > 1 || flags.some((f) => /^--(?:unset|add|replace)/.test(f)))
}

/** The stash's verb and whether it changes the shared stack's top: a push without a message, a pop, a bare drop, a clear. */
function stashTop(args: readonly string[]): { verb: string, top: boolean } {
  const verb = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : 'push'
  const rest = verb === args[0] ? args.slice(1) : args
  const operands = rest.filter((a) => !a.startsWith('-'))
  const message = rest.some((a) => a === '-m' || /^-m./.test(a) || longOption(a, '--message', '--m'))
  const top = (verb === 'push' && !message) || (verb === 'save' && operands.length === 0) || verb === 'pop' || verb === 'clear'
    || (verb === 'drop' && operands.length === 0)
  return { verb, top }
}

/** The refusal in the user's checkout for git's `sub` with `args`, if any. */
function inCheckout(sub: string, args: readonly string[]): Verdict {
  if (sub === 'commit') return deny('hook-user-checkout-commit')
  if (sub === 'reset' && args.some((a) => longOption(a, '--hard', '--ha'))) return deny('hook-reset-hard')
  if (sub === 'checkout' && args.some((a) => a === '--' || a === '.' || a === '-f' || longOption(a, '--force', '--fo'))) {
    return deny('hook-discard')
  }
  const staged = args.some((a) => a === '--staged' || a === '-S')
  if (sub === 'restore' && (!staged || args.some((a) => a === '--worktree' || a === '-W'))) return deny('hook-discard')
  if (sub === 'clean' && (shortFlag(args, 'f', 'e') || args.some((a) => longOption(a, '--force', '--fo')))) return deny('hook-discard')
  if (sub === 'stash' && !['list', 'show', 'create'].includes(stashTop(args).verb)) return deny('hook-checkout-stash')
  return undefined
}

/** git's global options: the subcommand's index and the directory it runs in (unknown under --git-dir or --work-tree),
 * or a hooks path override's refusal. */
function gitGlobals(words: readonly string[], place: Place): Decision | { at: number, target: string | undefined } {
  let target = place.cwd
  let k = 1
  for (; k < words.length && (words[k] ?? '').startsWith('-'); k += 1) {
    const word = words[k] ?? ''
    const value = GIT_VALUED.has(word) ? words[k + 1] ?? '' : ''
    const config = word === '-c' || word === '--config-env' ? value : /^-c./.test(word) ? word.slice(2) : undefined
    if (config !== undefined && isHooksPath(config)) return deny('hook-hooks-path-override')
    if (word === '-C') target = resolve(target, value, place.env)
    if (/^--(?:git-dir|work-tree)|^--bare$/.test(word)) target = undefined
    if (GIT_VALUED.has(word)) k += 1
  }
  return { at: k, target }
}

/** The refusal for one git command: its words from the program word on, `husky` when HUSKY= came before it. */
function checkGit(words: readonly string[], husky: boolean, place: Place): Verdict {
  const globals = gitGlobals(words, place)
  if ('decision' in globals) return globals
  const sub = words[globals.at] ?? ''
  const args = words.slice(globals.at + 1)
  const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const noVerify = options.some((a) => longOption(a, '--no-verify', '--no-v')) || (sub === 'commit' && shortFlag(options, 'n', 'mFcCt'))
  if (HOOK_RUNNING.has(sub) && noVerify) {
    return deny('hook-no-verify')
  }
  if (husky && HOOK_RUNNING.has(sub)) return deny('hook-husky-skip')
  if (sub === 'config' && configWritesHooksPath(args)) return deny('hook-hooks-path-override')
  if (sub === 'stash' && stashTop(args).top) return deny('hook-bare-stash')
  return place.isUserCheckout(globals.target) ? inCheckout(sub, args) : undefined
}

/**
 * The first refusal in a Bash command, else undefined. HUSKY= counts as the git command's own prefix assignment or an
 * `export HUSKY=` before it in the chain; a subshell's cd stays inside its parentheses.
 */
function checkCommand(command: string, place: Place): Verdict {
  let exported = false
  const outer: (string | undefined)[] = []
  for (const words of scan(command)) {
    if (words.length === 1 && (words[0] === '(' || words[0] === ')')) {
      if (words[0] === '(') outer.push(place.cwd)
      else if (outer.length) place.cwd = outer.pop()
      continue
    }
    const at = programAt(words)
    const program = posix.basename(words[at] ?? '')
    const husky = (k: number) => words.slice(0, k).some((w) => w.startsWith('HUSKY='))
    if (program === 'export') exported ||= husky(words.length)
    else if (program === 'cd' || program === 'pushd' || program === 'popd') place.move(program, words.slice(at + 1))
    else if (program === 'git') {
      const verdict = checkGit(words.slice(at), exported || husky(at), place)
      if (verdict) return verdict
    }
  }
  return undefined
}

const projectDir = (root: string, env: NodeJS.ProcessEnv) => env['CLAUDE_PROJECT_DIR'] || root

/** The decision for one PreToolUse payload, or undefined to say nothing: only a Bash command is read. */
function decide(payload: unknown, root: string, env: NodeJS.ProcessEnv): Verdict {
  const input = (typeof payload === 'object' && payload !== null ? payload : {}) as { tool_name?: unknown,
    tool_input?: { command?: unknown } | null, cwd?: unknown }
  const command = input.tool_input?.command
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return undefined
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  return checkCommand(command, new Place(cwd, mainWorktree(projectDir(root, env)), env))
}

/** PreToolUse's output for `stdin`: a deny as Claude Code's JSON, or '' to say nothing, as for input it cannot read. */
export function preToolUse(stdin: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  let result: Verdict
  try {
    result = decide(JSON.parse(stdin), root, env)
  } catch {
    result = undefined
  }
  return result ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision,
    permissionDecisionReason: result.reason } })}\n` : ''
}

// --- SessionStart ----------------------------------------------------------------------------------------------------

function huskyScript(directory: string, name: string): boolean {
  try {
    const scripts: unknown = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts ?? {}
    return typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
      && String((scripts as Record<string, unknown>)[name] ?? '').includes('husky')
  } catch {
    return false
  }
}

function sessionWarnings(worktree: string, env: NodeJS.ProcessEnv): string[] {
  const top = gitOut(worktree, 'rev-parse', '--path-format=absolute', '--show-toplevel')
  if (!top) return []
  const warnings: string[] = []
  const hooksPath = gitOut(top, 'config', '--get', 'core.hooksPath')
  if (hooksPath !== '.githooks') {
    warnings.push(`core.hooksPath is ${hooksPath || 'unset'}, not .githooks: the pre-commit and pre-push hooks do not run. `
      + 'Set it once for every worktree: git config core.hooksPath .githooks')
  }
  if (!existsSync(join(top, '.githooks'))) {
    warnings.push(`${top} has no .githooks directory: commits here run no gate. Work in a worktree of the integration `
      + 'branch or main')
  } else if (!existsSync(join(top, '.githooks/pre-push'))) {
    warnings.push(`${top} has no .githooks/pre-push: a push from here verifies no pre-push stamp (2.1-Q266). Work on a `
      + 'branch of the integration branch or main')
  }
  if (env['HUSKY'] !== '0' && huskyScript(join(top, 'desktop/web'), 'prepare')) {
    warnings.push('desktop/web/package.json still runs husky\'s prepare: install with HUSKY=0 npm ci, or npm ci rewrites '
      + 'core.hooksPath')
  }
  return warnings
}

/** SessionStart's output for `stdin`: one line per warning; it never blocks. */
export function sessionStart(stdin: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  let warnings: string[]
  try {
    const payload = JSON.parse(stdin) as { cwd?: unknown } | null
    const cwd = typeof payload === 'object' && payload !== null && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : projectDir(root, env)
    warnings = sessionWarnings(cwd, env)
  } catch (error) {
    warnings = [`agent-hook session-start could not check the hooks: ${(error as Error).name}: ${(error as Error).message}`]
  }
  return warnings.map((warning) => `Canopi hooks warning: ${warning}\n`).join('')
}

// --- planted ---------------------------------------------------------------------------------------------------------

/**
 * Each planted PreToolUse input's decision as a JSON line. In its command and cwd, `{main_worktree}` names the session
 * repository's checkout and `{dir}` the planted file's directory, so a case needs no machine's absolute path.
 */
function planted(files: readonly string[], root: string, env: NodeJS.ProcessEnv): string {
  const main = mainWorktree(projectDir(root, env))
  return files.map((name) => {
    let result: { decision: string, reason: string }
    try {
      const payload = JSON.parse(readFileSync(name, 'utf8')) as { cwd?: unknown, tool_input?: { command?: unknown } }
      const places: [string, string][] = [['{main_worktree}', main ?? projectDir(root, env)], ['{dir}', dirname(resolvePath(name))]]
      const fill = (text: unknown) => (typeof text === 'string' ? places.reduce((out, [key, value]) => out.replaceAll(key, value), text) : text)
      payload.cwd = fill(payload.cwd)
      payload.tool_input = { ...payload.tool_input, command: fill(payload.tool_input?.command) }
      result = decide(payload, root, env) ?? { decision: 'pass', reason: '' }
    } catch (error) {
      result = { decision: 'error', reason: (error as Error).message }
    }
    return `${JSON.stringify({ file: name, decision: result.decision, reason: result.reason })}\n`
  }).join('')
}

/** The agent-hook mode's exit code for `args`, its output written to stdout. */
export function agentHook(root: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const [mode, ...rest] = args
  const stdin = () => readFileSync(0, 'utf8')
  if (mode === 'pre-tool-use' && !rest.length) process.stdout.write(preToolUse(stdin(), root, env))
  else if (mode === 'session-start' && !rest.length) process.stdout.write(sessionStart(stdin(), root, env))
  else if (mode === 'planted') process.stdout.write(planted(rest, root, env))
  else {
    process.stderr.write('usage: node policy/gate/cli.mjs agent-hook pre-tool-use|session-start|planted <command.json>...\n')
    return 2
  }
  return 0
}
