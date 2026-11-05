// policy/gate/agent-hooks.ts: the agent hooks for Claude Code sessions in Canopi (2.1-M196, 2.1-M219, 2.1-M339; ADR 0028
// Agent enforcement; ported from scripts/agent_hooks.py, 2.1-M349), a mode of the gate's entry:
//
//   node policy/gate/cli.mjs agent-hook pre-tool-use     PreToolUse JSON on stdin; prints a deny or ask decision, or nothing
//   node policy/gate/cli.mjs agent-hook session-start    SessionStart JSON on stdin; prints a warning when the hooks would
//                                                        not run in this worktree; never blocks
//   node policy/gate/cli.mjs agent-hook planted <command.json>...
//                                                        one JSON line per file, {file, decision, reason}: the planted
//                                                        runner of policy/adapters/agent-hooks.mjs
//
// A Bash command is read by agent-hooks-shell.ts, each simple command after its environment assignments and wrapper
// words (`env`, `time`, `command`, ...); one level of `sh -c`, `bash -c` or `bash -lc` is read, a deeper one asks. `cd`
// and `git -C` are followed to find the repository a git command targets: the user's checkout is the main worktree of
// the session project's repository (`git rev-parse --git-common-dir`), and another repository or a linked worktree is
// never it; agent-hooks-stamp.ts says whether a command may write a pre-push stamp. What cannot be parsed asks; nothing
// here throws. Each refusal's reason starts with its rule id in brackets (policy/rules.json, tool agent-hooks) and names
// the fix.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve as resolvePath } from 'node:path'
import { ASSIGNMENT, segments, SHELLS, Unparsed } from './agent-hooks-shell.ts'
import { redirectsToStamp, STAMP_PATH, writesStamp } from './agent-hooks-stamp.ts'

const WRAPPERS = new Set(['time', 'command', 'exec', 'nohup', 'nice', 'builtin'])
const HOOKS_PATH = 'core.hookspath'
const FIX_GATE = 'commit through the pre-commit gate; fix what it reports instead of skipping it'
// A permission prompt may never show in a bypass or headless session, so a discard is denied and the user decides.
const ASK_IN_CHAT = 'ask the user in chat; they can run it themselves with `!`'
const REASONS: Readonly<Record<string, string>> = {
  'hook-no-verify': `--no-verify skips the pre-commit gate (2.1-M196); ${FIX_GATE}`,
  'hook-plumbing-commit': `git commit-tree makes a commit no hook sees (2.1-M196); use git commit, ${FIX_GATE}`,
  'hook-husky-skip': `HUSKY=0 before a git command skips the hooks (2.1-M196); ${FIX_GATE}`,
  'hook-hooks-path-override': 'this changes core.hooksPath, which must stay the shared relative .githooks (2.1-M14, '
    + '2.1-M196); only `git config core.hooksPath .githooks` may set it; install with HUSKY=0 in a worktree that still '
    + 'has husky, and bd\'s hooks never (.githooks runs the gate)',
  'hook-bare-stash': 'the stash stack is shared by every worktree (AGENTS.md, 2.1-M196); set work aside with a WIP '
    + 'commit on your branch instead',
  'hook-user-checkout-commit': 'this commits in the user\'s checkout (the main worktree, AGENTS.md); work in a worktree '
    + 'under .rq-scratch/, and update the checkout only by fetch and --ff-only',
  'hook-old-husky-install': 'this package.json still runs husky\'s prepare, which rewrites the shared core.hooksPath '
    + '(2.1-M196); run HUSKY=0 npm ci (or HUSKY=0 npm install) instead',
  'hook-reset-hard': `git reset --hard discards work (2.1-M339); ${ASK_IN_CHAT}`,
  'hook-discard': `this discards uncommitted work (2.1-M339); ${ASK_IN_CHAT}`,
  'hook-stash-stack-asks': 'this changes the shared stash stack (2.1-M219); proceed only if the user asked for it',
  'hook-stamp-write': 'the pre-push stamps under the git directory\'s canopi-gate/ are written only by a green '
    + '`node policy/gate/cli.mjs push --base origin/main` on a clean tree (2.1-Q266, 2.1-Q270); run it instead',
  'hook-tag-push': 'a tag is pushed by name, and only once its commit is on origin/main (no --tags, --follow-tags or '
    + '--mirror); a release tag is made by scripts/promote-release.sh (2.1-Q270)',
}
const DENY = new Set(['hook-no-verify', 'hook-plumbing-commit', 'hook-husky-skip', 'hook-hooks-path-override',
  'hook-bare-stash', 'hook-user-checkout-commit', 'hook-old-husky-install', 'hook-reset-hard', 'hook-discard',
  'hook-stamp-write', 'hook-tag-push'])
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// git push's options that take a separate value.
const PUSH_VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
// git's global options that take a separate value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
  '--config-env', '--list-cmds'])
// git commit's options that take a value: short ones end a cluster, long ones take the next word unless `=` is used.
const COMMIT_SHORT_VALUE = new Set('mFcCt')
const COMMIT_LONG_VALUE = new Set(['--message', '--file', '--author', '--date', '--template', '--reuse-message',
  '--reedit-message', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file'])
const COMMIT_CREATING = new Set(['commit', 'cherry-pick', 'revert', 'am', 'rebase'])

interface Decision {
  readonly rule: string | undefined
  readonly decision: 'deny' | 'ask'
  readonly reason: string
}
type Verdict = Decision | undefined

const decision = (rule: string, reason?: string): Decision =>
  ({ rule, decision: DENY.has(rule) ? 'deny' : 'ask', reason: `[${rule}] ${reason ?? REASONS[rule] ?? ''}` })
const unparsed = (why: string): Decision =>
  ({ rule: undefined, decision: 'ask', reason: `[agent-hooks] cannot read this command (${why}); ask the user` })

// --- context ---------------------------------------------------------------------------------------------------------

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

/** The main worktree of the repository at `cwd` and that repository's common dir, or undefineds. */
function mainWorktree(cwd: string): [string | undefined, string | undefined] {
  const common = gitOut(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) return [undefined, undefined]
  const dir = real(common)
  return [basename(dir) === '.git' ? dirname(dir) : undefined, dir]
}

/** `raw` (a cd or -C argument) against `base`; undefined when either is unknown or a variable stays unexpanded. */
function resolve(base: string | undefined, raw: string, env: NodeJS.ProcessEnv): string | undefined {
  if (base === undefined) return undefined
  let expanded = raw.replace(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([^}]*)\})/g, (match, bare?: string, braced?: string) =>
    env[bare ?? braced ?? ''] ?? match)
  if (expanded === '~' || expanded.startsWith('~/')) expanded = homedir() + expanded.slice(1)
  if (expanded.includes('$') || expanded.includes('`')) return undefined
  return resolvePath(base, expanded)
}

class Context {
  readonly env: Record<string, string> = {}
  cwd: string | undefined
  /** Whether the command runs in the stamp directory, known from a `cd` word naming it even when cwd is unknown. */
  inside: boolean
  private previous: { cwd: string | undefined, inside: boolean } = { cwd: undefined, inside: false }
  readonly userCheckout: [string | undefined, string | undefined]
  readonly processEnv: NodeJS.ProcessEnv

  constructor(cwd: string | undefined, userCheckout: [string | undefined, string | undefined], processEnv: NodeJS.ProcessEnv) {
    this.cwd = cwd
    this.inside = STAMP_PATH.test(cwd ?? '')
    this.userCheckout = userCheckout
    this.processEnv = processEnv
  }

  resolve(raw: string) {
    return resolve(this.cwd, raw, this.processEnv)
  }

  /** `cd target`: `-` returns to the directory before; a target that cannot be resolved is inside the stamp directory
   * when its words name it (`cd "$(git rev-parse --git-common-dir)/canopi-gate"`). */
  cd(target: string) {
    const here = { cwd: this.cwd, inside: this.inside }
    if (target === '-') {
      ({ cwd: this.cwd, inside: this.inside } = this.previous)
    } else {
      this.cwd = this.resolve(target)
      this.inside = STAMP_PATH.test(this.cwd ?? posix.normalize(target))
    }
    this.previous = here
  }

  /** True when `directory` is in the main worktree of the session's repository; undefined when unknown. */
  isUserCheckout(directory: string | undefined): boolean | undefined {
    const [main, common] = this.userCheckout
    if (directory === undefined) return undefined
    if (main === undefined || !existsSync(directory)) return false
    const top = gitOut(directory, 'rev-parse', '--path-format=absolute', '--show-toplevel')
    const [, hereCommon] = mainWorktree(directory)
    if (!top || hereCommon === undefined) return false
    return hereCommon === common && real(top) === main
  }
}

// --- rules ------------------------------------------------------------------------------------------------------------

/** `words` without environment assignments and wrapper words, and the assignments. */
function stripPrefix(words: readonly string[]): [string[], Record<string, string>] {
  const env: Record<string, string> = {}
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (ASSIGNMENT.test(word)) {
      const at = word.indexOf('=')
      env[word.slice(0, at)] = word.slice(at + 1)
    } else if (word === 'env') {
      i += 1
      while (i < words.length && (words[i] ?? '').startsWith('-')) i += ['-u', '--unset', '-C', '--chdir', '-S'].includes(words[i] ?? '') ? 2 : 1
      continue
    } else if (WRAPPERS.has(word)) {
      // a wrapper word runs the next one
    } else if (word === 'timeout') {
      i += 1
      while (i < words.length && (words[i] ?? '').startsWith('-')) i += 1
      i += 1 // the duration
      continue
    } else {
      break
    }
    i += 1
  }
  return [words.slice(i), env]
}

/** True when `word` is `full` or an unambiguous prefix git accepts (at least `shortest`). */
const longOption = (word: string, full: string, shortest: string) => {
  const name = word.split('=', 1)[0] ?? ''
  return name.length >= shortest.length && full.startsWith(name)
}

/** git commit's flags with option values skipped: each flag word and each short flag letter. */
function commitFlags(args: readonly string[]): string[] {
  const flags: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] ?? ''
    if (word === '--') break
    if (word.startsWith('--')) {
      flags.push(word)
      if (!word.includes('=') && COMMIT_LONG_VALUE.has(word)) i += 1
    } else if (word.startsWith('-') && word.length > 1) {
      for (const [k, letter] of [...word.slice(1)].entries()) {
        if (COMMIT_SHORT_VALUE.has(letter)) {
          if (k === word.length - 2) i += 1
          break
        }
        flags.push(`-${letter}`)
      }
    }
  }
  return flags
}

const isHooksPath = (value: string) => (value.split('=', 1)[0] ?? '').toLowerCase() === HOOKS_PATH

/** git's global options: the subcommand's index and the repository `-C` names, or a hooks path override's refusal. */
function gitGlobals(words: readonly string[], ctx: Context): Decision | { at: number, target: string | undefined } {
  let i = 1
  let target = ctx.cwd
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const word = words[i] ?? ''
    if (GIT_VALUE_OPTIONS.has(word)) {
      const value = i + 1 < words.length ? words[i + 1] ?? '' : ''
      if (word === '-C') target = resolve(target, value, ctx.processEnv)
      if ((word === '-c' || word === '--config-env') && isHooksPath(value)) return decision('hook-hooks-path-override')
      i += 2
    } else {
      if (word.startsWith('-c') && isHooksPath(word.slice(2))) return decision('hook-hooks-path-override')
      i += 1
    }
  }
  return { at: i, target }
}

/** A git command skipping the hooks: HUSKY set, a GIT_CONFIG_KEY naming the hooks path, --no-verify or commit -n. */
function gitBypass(sub: string, args: readonly string[], ctx: Context, env: Record<string, string>): Verdict {
  if (env['HUSKY'] !== undefined || ctx.env['HUSKY'] !== undefined) return decision('hook-husky-skip')
  for (const [key, value] of Object.entries({ ...ctx.env, ...env })) {
    if (key.startsWith('GIT_CONFIG_KEY') && value.toLowerCase() === HOOKS_PATH) return decision('hook-hooks-path-override')
  }
  if (!['commit', 'push', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am'].includes(sub)) return undefined
  const flags = sub === 'commit' ? commitFlags(args) : args.filter((a) => a.startsWith('-'))
  if (flags.some((f) => f.startsWith('--no-v') && longOption(f, '--no-verify', '--no-v'))) return decision('hook-no-verify')
  return sub === 'commit' && flags.includes('-n') ? decision('hook-no-verify') : undefined
}

/** A git command that discards uncommitted work (2.1-M339). */
function gitDiscard(sub: string, args: readonly string[]): Verdict {
  const has = (...names: string[]) => args.some((a) => names.includes(a))
  if (sub === 'reset' && has('--hard')) return decision('hook-reset-hard')
  if (sub === 'checkout' && has('--', '-f', '--force')) return decision('hook-discard')
  if (sub === 'switch' && has('-f', '--force', '--discard-changes')) return decision('hook-discard')
  if (sub === 'restore' && (!has('--staged', '-S') || has('--worktree', '-W'))) return decision('hook-discard')
  if (sub === 'clean' && args.some((a) => a === '--force' || (/^-[a-zA-Z]+$/.test(a) && a.includes('f')))) return decision('hook-discard')
  return undefined
}

/** A git command that makes a commit in the user's checkout; a fast-forward or an abort makes none. */
function gitCommitsInCheckout(sub: string, args: readonly string[], target: string | undefined, ctx: Context): Verdict {
  if (!COMMIT_CREATING.has(sub) && sub !== 'merge' && sub !== 'pull') return undefined
  if ((sub === 'merge' || sub === 'pull') && args.some((a) => ['--ff-only', '--abort', '--quit'].includes(a))) return undefined
  if (['rebase', 'cherry-pick', 'revert', 'am'].includes(sub) && args.some((a) => a === '--abort' || a === '--quit')) return undefined
  const mine = ctx.isUserCheckout(target)
  if (mine === undefined) return unparsed('its repository depends on a variable')
  return mine ? decision('hook-user-checkout-commit') : undefined
}

function checkGit(words: readonly string[], ctx: Context, env: Record<string, string>): Verdict {
  const globals = gitGlobals(words, ctx)
  if ('decision' in globals) return globals
  if (globals.at >= words.length) return undefined
  const sub = words[globals.at] ?? ''
  const args = words.slice(globals.at + 1)
  const bypass = gitBypass(sub, args, ctx, env)
  if (bypass) return bypass
  if (sub === 'commit-tree') return decision('hook-plumbing-commit')
  if (sub === 'config') return checkConfig(args)
  if (sub === 'stash') return checkStash(args)
  if (sub === 'push') return checkTagPush(args, globals.target)
  return gitDiscard(sub, args) ?? gitCommitsInCheckout(sub, args, globals.target, ctx)
}

/** The tags a `git push` names: `refs/tags/<t>`, `tag <t>`, or a name only a tag of the target repository holds. */
function pushedTags(args: readonly string[], target: string | undefined): string[] {
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-')) i += PUSH_VALUE_OPTIONS.has(arg) ? 1 : 0
    else positional.push(arg)
  }
  const tags: string[] = []
  const refspecs = positional.slice(1)
  for (let k = 0; k < refspecs.length; k += 1) {
    const spec = refspecs[k] ?? ''
    if (spec === 'tag' && refspecs[k + 1] !== undefined) {
      tags.push(`refs/tags/${refspecs[k + 1] ?? ''}`)
      k += 1
      continue
    }
    const source = spec.replace(/^\+/, '').split(':', 1)[0] ?? ''
    if (source.startsWith('refs/tags/')) tags.push(source)
    else if (source && !source.startsWith('refs/') && target !== undefined && gitOut(target, 'rev-parse', '--verify', '-q', `refs/tags/${source}`)
      && !gitOut(target, 'rev-parse', '--verify', '-q', `refs/heads/${source}`)) tags.push(`refs/tags/${source}`)
  }
  return tags
}

/** A tag push whose commit is not on origin/main, or one pushing tags wholesale (2.1-Q270). */
function checkTagPush(args: readonly string[], target: string | undefined): Verdict {
  if (args.some((a) => a === '--tags' || a === '--follow-tags' || a === '--mirror')) return decision('hook-tag-push')
  const tags = pushedTags(args, target)
  if (!tags.length) return undefined
  if (target === undefined) return unparsed('its repository depends on a variable')
  const onMain = (tag: string) => {
    const commit = gitOut(target, 'rev-parse', '--verify', '-q', `${tag}^{commit}`)
    return commit !== undefined && gitOut(target, 'merge-base', '--is-ancestor', commit, 'origin/main') !== undefined
  }
  return tags.every(onMain) ? undefined : decision('hook-tag-push')
}

function checkConfig(args: readonly string[]): Verdict {
  let words = args.filter((a) => !a.startsWith('-'))
  const flags = args.filter((a) => a.startsWith('-'))
  let verb: string | undefined
  if (words[0] === 'set' || words[0] === 'unset') [verb, ...words] = words
  if (!words.length || (words[0] ?? '').toLowerCase() !== HOOKS_PATH) {
    return flags.includes('--edit') || flags.includes('-e') ? decision('hook-hooks-path-override') : undefined
  }
  // Restoring the required value is SessionStart's fix for drift.
  if ((verb === undefined || verb === 'set') && words.length === 2 && words[1] === '.githooks' && flags.every((f) => f === '--local')) return undefined
  const reads = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope'])
  if (verb || words.length > 1 || flags.some((f) => ['--unset', '--unset-all', '--add', '--replace-all'].includes(f))) {
    if (!flags.some((f) => reads.has(f)) || verb) return decision('hook-hooks-path-override')
  }
  return undefined
}

function checkStash(args: readonly string[]): Verdict {
  const sub = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : 'push'
  if (sub === 'push' || sub === 'save') return decision('hook-bare-stash')
  if (['pop', 'apply', 'drop', 'clear', 'store', 'branch'].includes(sub)) return decision('hook-stash-stack-asks')
  return undefined
}

function huskyScript(directory: string, name: string): boolean {
  try {
    const scripts: unknown = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts ?? {}
    return typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
      && String((scripts as Record<string, unknown>)[name] ?? '').includes('husky')
  } catch {
    return false
  }
}

/** The directory npm runs in (`--prefix`, `-C`) and the index of its verb. */
function npmTarget(args: readonly string[], ctx: Context): [string | undefined, number] {
  let directory = ctx.cwd
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    if ((args[i] === '--prefix' || args[i] === '-C') && i + 1 < args.length) {
      directory = ctx.resolve(args[i + 1] ?? '')
      i += 2
    } else {
      i += 1
    }
  }
  return [directory, i]
}

function checkNpm(args: readonly string[], ctx: Context, env: Record<string, string>): Verdict {
  const [directory, at] = npmTarget(args, ctx)
  if (at >= args.length || directory === undefined) return undefined
  const verb = args[at] ?? ''
  const rest = args.slice(at + 1)
  const skipped = (env['HUSKY'] || ctx.env['HUSKY'] || ctx.processEnv['HUSKY']) === '0'
  const installs = ['ci', 'install', 'i', 'clean-install', 'install-clean', 'isntall', 'add'].includes(verb)
  if (installs && !skipped && huskyScript(directory, 'prepare')) return decision('hook-old-husky-install')
  if ((verb === 'run' || verb === 'run-script') && rest.length && !skipped && huskyScript(directory, rest[0] ?? '')) {
    return decision('hook-hooks-path-override')
  }
  return verb === 'exec' && rest.some((a) => /^husky(@|$)/.test(a)) ? decision('hook-hooks-path-override') : undefined
}

function checkNpx(args: readonly string[], ctx: Context, env: Record<string, string>): Verdict {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) i += args[i] === '-p' || args[i] === '--package' ? 2 : 1
  if (i >= args.length) return undefined
  const program = args[i] ?? ''
  if (/^husky(@|$)/.test(program)) return decision('hook-hooks-path-override')
  if (/^npm(@|$)/.test(program)) return checkNpm(args.slice(i + 1), ctx, env)
  return undefined
}

/** `bd hooks install --beads` or `--shared` points core.hooksPath at .beads/hooks or .beads-hooks. */
function checkBd(args: readonly string[]): Verdict {
  const words = args.filter((a) => !a.startsWith('-'))
  return words[0] === 'hooks' && words[1] === 'install' && args.some((a) => a === '--beads' || a === '--shared')
    ? decision('hook-hooks-path-override') : undefined
}

function checkSegment(segment: readonly string[], ctx: Context, depth: number): Verdict {
  const [words, env] = stripPrefix(segment)
  if (writesStamp(words, env, ctx)) return decision('hook-stamp-write')
  if (!words.length) {
    Object.assign(ctx.env, env) // a bare assignment sets the shell variable for the rest of the chain
    return undefined
  }
  const program = posix.basename(words[0] ?? '')
  if (program === 'cd') {
    ctx.cd(words[1] ?? '~')
    return undefined
  }
  if (program === 'export') {
    for (const word of words.slice(1)) {
      const at = word.indexOf('=')
      if (at >= 0) ctx.env[word.slice(0, at)] = word.slice(at + 1)
    }
    return undefined
  }
  if (SHELLS.has(program)) {
    const at = words.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w) && k + 1 < words.length)
    if (at < 0) return undefined
    if (depth >= 1) return unparsed('a shell -c inside a shell -c')
    return checkCommand(words[at + 1] ?? '', ctx, depth + 1)
  }
  if (program === 'git') return checkGit(words, ctx, env)
  if (program === 'npm') return checkNpm(words.slice(1), ctx, env)
  if (program === 'npx') return checkNpx(words.slice(1), ctx, env)
  if (program === 'husky') return decision('hook-hooks-path-override')
  if (program === 'bd') return checkBd(words.slice(1))
  return undefined
}

/** The first deny in `command`, else its first ask, else undefined. */
function checkCommand(command: string, ctx: Context, depth = 0): Verdict {
  const found: Decision[] = []
  for (const { words, targets } of segments(command)) {
    if (targets.some((target) => redirectsToStamp(target, ctx))) return decision('hook-stamp-write')
    const result = checkSegment(words, ctx, depth)
    if (result) {
      if (result.decision === 'deny') return result
      found.push(result)
    }
  }
  return found[0]
}

const projectDir = (root: string, env: NodeJS.ProcessEnv) => env['CLAUDE_PROJECT_DIR'] || root

/** The decision for one PreToolUse payload, or undefined to say nothing. */
function decide(payload: unknown, root: string, env: NodeJS.ProcessEnv): Verdict {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return unparsed('the hook input is not an object')
  const input = payload as { tool_name?: unknown, tool_input?: { command?: unknown, file_path?: unknown, notebook_path?: unknown } | null,
    cwd?: unknown }
  if (FILE_TOOLS.has(String(input.tool_name))) {
    const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    return typeof path === 'string' && STAMP_PATH.test(path) ? decision('hook-stamp-write') : undefined
  }
  if (input.tool_name !== 'Bash') return undefined
  const command = input.tool_input?.command
  if (typeof command !== 'string') return unparsed('no command')
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const ctx = new Context(cwd, mainWorktree(projectDir(root, env)), env)
  try {
    return checkCommand(command, ctx)
  } catch (error) {
    if (error instanceof Unparsed) return unparsed(error.message)
    throw error
  }
}

/** PreToolUse's output for `stdin`: the decision as Claude Code's JSON, or '' to say nothing. */
export function preToolUse(stdin: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  let result: Verdict
  try {
    result = decide(JSON.parse(stdin), root, env)
  } catch (error) {
    // Unreadable input or a hook bug asks rather than letting the command through or crashing.
    result = unparsed(error instanceof SyntaxError ? 'the hook input is not JSON' : `${(error as Error).name}: ${(error as Error).message}`)
  }
  return result ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision,
    permissionDecisionReason: result.reason } })}\n` : ''
}

// --- SessionStart ----------------------------------------------------------------------------------------------------

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
  const [main] = mainWorktree(projectDir(root, env))
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
