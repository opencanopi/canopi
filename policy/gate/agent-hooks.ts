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
// A Bash command is read by agent-hooks-shell.ts in its plain subset, each simple command after its environment
// assignments and wrapper words (`env`, `time`, `command`, ... with the options each knows), at every level of
// substitution. It asks, naming the construct (2.1-Q275), when a program word anywhere is one it cannot read exactly (a
// glob, a brace, a substitution, a variable it cannot expand to a plain word), or when the command holds anything outside
// the subset and either mentions git (in its text or a program word), feeds a shell (a here-document, `-c`, its input) or
// holds a program word it reads only through a variable. Rules read only the commands outside substitutions; any other
// command is read as before. One level of a `-c` string is read (sh, bash, zsh or dash, by any path or wrapper, after an
// option cluster holding c and the options before it, as a command mentioning git) in a child context, so its cd and
// variables stay inside it; a `-c` inside it asks, as does a shell reading its input. agent-hooks-context.ts
// follows `cd`, `pushd`, `popd` and `git -C` to the repository a git command targets, unknown under `--git-dir`,
// `--work-tree` or GIT_DIR; agent-hooks-stamp.ts says whether a command may write a pre-push stamp. Long options are read
// as git reads them, a unique prefix as the option (longOption). What cannot be parsed asks; nothing here throws. Each refusal's reason starts with its rule id in brackets (policy/rules.json, tool agent-hooks) and names
// the fix.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve as resolvePath } from 'node:path'
import { Context, gitOut, mainWorktree, resolve } from './agent-hooks-context.ts'
import { braceExpansion, type Command, expandProgram, GIT_VALUE_OPTIONS, gitSubcommandAt, SHELLS, shellCommands, Unparsed } from './agent-hooks-command.ts'
import { read } from './agent-hooks-shell.ts'
import { redirectsToStamp, STAMP_PATH, writesStamp } from './agent-hooks-stamp.ts'

const MENTIONS_GIT = /\bgit\b/
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
// git commit's options that take a value: short ones end a cluster, long ones take the next word unless `=` is used.
const COMMIT_SHORT_VALUE = new Set('mFcCt')
const COMMIT_LONG_VALUE = new Set(['--message', '--file', '--author', '--date', '--template', '--reuse-message',
  '--reedit-message', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file'])
const COMMIT_CREATING = new Set(['commit', 'cherry-pick', 'revert', 'am', 'rebase'])
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']
// git config's options that take a value (long forms; `-f` is --file), and its subcommands.
const CONFIG_VALUE_OPTIONS = ['--file', '--blob', '--type', '--default', '--comment', '--value', '--url']
const CONFIG_VERBS = new Set(['set', 'unset', 'get', 'list', 'edit', 'rename-section', 'remove-section'])

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
const outside = (construct: string): Decision => ({ rule: undefined, decision: 'ask', reason: `[agent-hooks] this command `
  + `uses ${construct}, which the hook does not read here (2.1-Q275); write it as plain commands with literal program `
  + 'words (a commit message as -m "$(cat <<\'EOF\' … EOF)"), or ask the user' })

// --- rules ------------------------------------------------------------------------------------------------------------

/** True when `word` is the long option `full` or a prefix of it (at least `shortest`), which git reads as `full` when it
 * accepts it: a deny rule names an option through this, so `--har` is `--hard`. A pass condition matches exactly. */
const longOption = (word: string, full: string, shortest = full.slice(0, 3)) => {
  const name = word.split('=', 1)[0] ?? ''
  return word.startsWith('--') && name.length >= shortest.length && full.startsWith(name)
}

/** Whether `args` hold one of `names` as git reads them: a long option through longOption, a short one alone or in a
 * cluster (`-qf`), `--` exactly. */
const hasOption = (args: readonly string[], ...names: string[]) => args.some((a) => names.some((n) => (n === '--' ? a === n
  : n.startsWith('--') ? longOption(a, n) : /^-[A-Za-z]+$/.test(a) && a.includes(n.slice(1)))))

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

/** git's global options: the subcommand's index and the repository `-C` names, or a hooks path override's refusal, or
 * an ask for an alias set by `-c`, whose command the hook cannot read. */
function gitGlobals({ words, env }: Command, ctx: Context): Decision | { at: number, target: string | undefined } {
  const at = gitSubcommandAt(words)
  // The repository git uses is not the directory's under GIT_DIR, --git-dir or --work-tree: the hook cannot name it.
  const vars = { ...ctx.vars, ...env }
  let target = REPOSITORY_VARIABLES.some((name) => vars[name] !== undefined) ? undefined : ctx.cwd
  for (let i = 1; i < at; i += 1) {
    const word = words[i] ?? ''
    const takesValue = GIT_VALUE_OPTIONS.has(word)
    const value = takesValue ? words[i + 1] ?? '' : ''
    if (word === '-C') target = resolve(target, value, ctx.vars)
    if (/^--(?:git-dir|work-tree)(?:=|$)|^--bare$/.test(word)) target = undefined
    const config = word === '-c' || word === '--config-env' ? value : !takesValue && word.startsWith('-c') ? word.slice(2) : undefined
    if (config !== undefined && isHooksPath(config)) return decision('hook-hooks-path-override')
    if (config !== undefined && /^alias\./i.test(config)) return outside('a git alias set by `-c`')
    if (takesValue) i += 1
  }
  return { at, target }
}

/** A git command skipping the hooks: HUSKY set, a GIT_CONFIG_KEY naming the hooks path, --no-verify or commit -n. */
function gitBypass(sub: string, args: readonly string[], ctx: Context, env: Record<string, string>): Verdict {
  if (env['HUSKY'] !== undefined || ctx.env['HUSKY'] !== undefined) return decision('hook-husky-skip')
  for (const [key, value] of Object.entries({ ...ctx.env, ...env })) {
    if (key.startsWith('GIT_CONFIG_KEY') && value.toLowerCase() === HOOKS_PATH) return decision('hook-hooks-path-override')
  }
  if (!['commit', 'push', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am'].includes(sub)) return undefined
  const flags = sub === 'commit' ? commitFlags(args) : args.filter((a) => a.startsWith('-'))
  if (flags.some((f) => longOption(f, '--no-verify', '--no-v'))) return decision('hook-no-verify')
  return sub === 'commit' && flags.includes('-n') ? decision('hook-no-verify') : undefined
}

/** A git command that discards uncommitted work (2.1-M339). */
function gitDiscard(sub: string, args: readonly string[]): Verdict {
  const has = (...names: string[]) => hasOption(args, ...names)
  if (sub === 'reset' && has('--hard')) return decision('hook-reset-hard')
  if (sub === 'checkout' && has('--', '-f', '--force')) return decision('hook-discard')
  if (sub === 'switch' && has('-f', '--force', '--discard-changes')) return decision('hook-discard')
  const staged = args.some((a) => a === '--staged' || a === '-S')
  if (sub === 'restore' && (!staged || has('--worktree', '-W'))) return decision('hook-discard')
  if (sub === 'clean' && has('-f', '--force')) return decision('hook-discard')
  return undefined
}

/** A git command that makes a commit in the user's checkout; a fast-forward or an abort makes none. */
function gitCommitsInCheckout(sub: string, args: readonly string[], target: string | undefined, ctx: Context): Verdict {
  if (!COMMIT_CREATING.has(sub) && sub !== 'merge' && sub !== 'pull') return undefined
  if ((sub === 'merge' || sub === 'pull') && args.some((a) => ['--ff-only', '--abort', '--quit'].includes(a))) return undefined
  if (['rebase', 'cherry-pick', 'revert', 'am'].includes(sub) && args.some((a) => a === '--abort' || a === '--quit')) return undefined
  const mine = ctx.isUserCheckout(target)
  if (mine === undefined) return unparsed('the hook cannot name its repository')
  return mine ? decision('hook-user-checkout-commit') : undefined
}

// The git subcommands whose rules read operands, not only options: a brace there could make the verb, key or refspec.
const OPERAND_RULES = new Set(['stash', 'config', 'push'])

function checkGit(command: Command, ctx: Context): Verdict {
  const { words, env, patterns, shaped } = command
  const globals = gitGlobals(command, ctx)
  if ('decision' in globals) return globals
  const sub = words[globals.at] ?? ''
  // A glob or brace could expand to the option or subcommand a rule reads (a file named `--hard`, `{--hard,}`), or a brace
  // to an operand a rule reads (`git stash {push,}`); elsewhere it is only a path or an argument, read as written.
  const patterned = [...patterns].find((k) => k <= globals.at || /^[-{]/.test(words[k] ?? '')
    || (OPERAND_RULES.has(sub) && braceExpansion(shaped[k]?.shape ?? '')))
  if (patterned !== undefined) return outside(`the git word \`${words[patterned] ?? ''}\`, holding a glob or brace`)
  if (globals.at >= words.length) return undefined
  const args = words.slice(globals.at + 1)
  const bypass = gitBypass(sub, args, ctx, env)
  if (bypass) return bypass
  if (sub === 'commit-tree') return decision('hook-plumbing-commit')
  if (sub === 'config') return checkConfig(args)
  if (sub === 'stash') return checkStash(args)
  if (sub === 'push') return checkTagPush(args, globals.target)
  return gitDiscard(sub, args) ?? gitCommitsInCheckout(sub, args, globals.target, ctx)
}

/** git push's operands, its repository then its refspecs: the words that are no option nor an option's value. */
function pushOperands(args: readonly string[]): string[] {
  const operands: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '--') return [...operands, ...args.slice(i + 1)]
    if (arg.startsWith('-')) i += PUSH_VALUE_OPTIONS.has(arg) ? 1 : 0
    else operands.push(arg)
  }
  return operands
}

/**
 * What each tag a `git push` writes is made from: `refs/tags/<t>` and `tag <t>` push that tag, as does a name only a tag
 * of the target repository holds; a refspec whose destination is `refs/tags/<t>` pushes its non-empty source as tag <t>
 * (an empty source, `:refs/tags/<t>`, deletes it). Also the destinations written without refs/ (`HEAD:v1`), which git
 * may match to an existing tag on the remote.
 */
function pushedTags(args: readonly string[], target: string | undefined): { tags: string[], unqualified: string[] } {
  const tags: string[] = []
  const unqualified: string[] = []
  const refspecs = pushOperands(args).slice(1)
  for (let k = 0; k < refspecs.length; k += 1) {
    const spec = refspecs[k] ?? ''
    if (spec === 'tag' && refspecs[k + 1] !== undefined) {
      tags.push(`refs/tags/${refspecs[k + 1] ?? ''}`)
      k += 1
      continue
    }
    const [source = '', destination = ''] = spec.replace(/^\+/, '').split(':', 2)
    if (destination && !destination.startsWith('refs/')) unqualified.push(destination)
    if (source.startsWith('refs/tags/') || (source && destination.startsWith('refs/tags/'))) tags.push(source)
    else if (source && !source.startsWith('refs/') && target !== undefined && gitOut(target, 'rev-parse', '--verify', '-q', `refs/tags/${source}`)
      && !gitOut(target, 'rev-parse', '--verify', '-q', `refs/heads/${source}`)) tags.push(`refs/tags/${source}`)
  }
  return { tags, unqualified }
}

/** A tag push whose commit (its source's) is not on origin/main, or one pushing tags wholesale (2.1-Q270); a destination
 * without refs/ asks (2.1-Q275). */
function checkTagPush(args: readonly string[], target: string | undefined): Verdict {
  if (hasOption(args, '--tags', '--follow-tags', '--mirror')) return decision('hook-tag-push')
  const { tags, unqualified } = pushedTags(args, target)
  const named = unqualified.length ? { rule: undefined, decision: 'ask' as const, reason: `[agent-hooks] the push `
    + `destination ${unqualified.join(', ')} has no refs/ prefix, so git may match an existing tag on the remote `
    + '(2.1-Q275); name refs/heads/<branch> or refs/tags/<tag>' } : undefined
  if (!tags.length) return named
  if (target === undefined) return unparsed('the hook cannot name its repository')
  const onMain = (tag: string) => {
    const commit = gitOut(target, 'rev-parse', '--verify', '-q', `${tag}^{commit}`)
    return commit !== undefined && gitOut(target, 'merge-base', '--is-ancestor', commit, 'origin/main') !== undefined
  }
  return tags.every(onMain) ? named : decision('hook-tag-push')
}

/** git config's operands and flags, each value-taking option with its value dropped and named in full (`-f x` is
 * `--file`), so the key is the first operand whatever the options before it. */
function configWords(args: readonly string[]): { operands: string[], flags: string[] } {
  const operands: string[] = []
  const flags: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    const valued = arg.startsWith('-f') ? '--file' : CONFIG_VALUE_OPTIONS.find((option) => longOption(arg, option))
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    } else if (valued) {
      flags.push(valued)
      if (arg === '-f' || (arg.startsWith('--') && !arg.includes('='))) i += 1
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags.push(arg)
    } else {
      operands.push(arg)
    }
  }
  return { operands, flags }
}

const removesSection = (verb: string | undefined, flags: readonly string[]) => verb?.endsWith('-section') === true
  || hasOption(flags, '--rename-section', '--remove-section')

/** git config changing core.hooksPath: setting, unsetting or editing it, or removing or renaming the core section, in
 * any file or scope; only `git config [--local] core.hooksPath .githooks` sets it. */
function checkConfig(args: readonly string[]): Verdict {
  const { operands, flags } = configWords(args)
  const verb = CONFIG_VERBS.has(operands[0] ?? '') ? operands[0] : undefined
  const words = verb ? operands.slice(1) : operands
  const key = (words[0] ?? '').toLowerCase()
  if (verb === 'edit' || hasOption(flags, '-e', '--edit') || (removesSection(verb, flags) && key === 'core')) {
    return decision('hook-hooks-path-override')
  }
  if (key !== HOOKS_PATH || verb === 'get' || verb === 'list' || removesSection(verb, flags)) return undefined
  return writesHooksPath(verb, words, flags) ? decision('hook-hooks-path-override') : undefined
}

/** Whether git config with core.hooksPath as its key writes it: a set or unset verb, a value, or a writing option
 * without a reading one. */
function writesHooksPath(verb: string | undefined, words: readonly string[], flags: readonly string[]): boolean {
  // Restoring the required value is SessionStart's fix for drift.
  if ((verb === undefined || verb === 'set') && words.length === 2 && words[1] === '.githooks' && flags.every((f) => f === '--local')) return false
  if (verb) return true
  const reads = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope'])
  return (words.length > 1 || hasOption(flags, '--unset', '--unset-all', '--add', '--replace-all')) && !flags.some((f) => reads.has(f))
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

function checkSegment(command: Command, ctx: Context, depth: number, mentions: boolean): Verdict {
  const { words, env, patterns } = command
  if (writesStamp(words, env, ctx)) return decision('hook-stamp-write')
  if (!words.length) {
    Object.assign(ctx.env, env) // a bare assignment sets the shell variable for the rest of the chain
    return undefined
  }
  const program = posix.basename(words[0] ?? '')
  if (program === 'cd' || program === 'pushd' || program === 'popd') {
    ctx.move(program, words.slice(1), (k) => !patterns.has(k + 1))
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
    const at = shellCommands(words)
    if (at === undefined || at < 0) return undefined
    if (depth >= 1) return unparsed('a shell -c inside a shell -c')
    // The string runs in a child shell: its cd, pushd, export and assignments stay inside it.
    return checkCommand(words[at] ?? '', ctx.child(), depth + 1, mentions)
  }
  if (program === 'git') return checkGit(command, ctx)
  if (program === 'npm') return checkNpm(words.slice(1), ctx, env)
  if (program === 'npx') return checkNpx(words.slice(1), ctx, env)
  if (program === 'husky') return decision('hook-hooks-path-override')
  if (program === 'bd') return checkBd(words.slice(1))
  return undefined
}

/**
 * The first deny in `command`, else its first ask, else undefined; an ask naming the first construct outside the plain
 * subset when the command (or the one whose `-c` string it is, `outer`) mentions git or feeds a shell (2.1-Q275).
 */
function checkCommand(command: string, ctx: Context, depth = 0, outer = false): Verdict {
  const { commands, nested, construct, feedsShell } = read(command)
  const all = [...commands, ...nested]
  const unread = all.find(({ program }) => program === 'unread')
  if (unread) return outside(`the program word \`${unread.unread ?? ''}\`, which it cannot read exactly`)
  const mentions = outer || feedsShell || MENTIONS_GIT.test(command) || all.some(({ words }) => {
    const program = posix.basename(words[0] ?? '')
    return program === 'git' || (SHELLS.has(program) && shellCommands(words) !== undefined)
  })
  if (construct && (mentions || all.some(({ program }) => program !== 'literal'))) return outside(construct)
  const found: Decision[] = []
  for (const each of commands) {
    const simple = each.program === 'variable' ? expandProgram(each, (name) => ctx.vars[name]) : each
    if (!simple) return outside(`the program word \`${each.words[0] ?? ''}\`, a variable it cannot expand to a plain word`)
    if (simple !== each && simple.construct) return outside(simple.construct)
    if (simple.targets.some((target) => redirectsToStamp(target, ctx))) return decision('hook-stamp-write')
    const result = checkSegment(simple, ctx, depth, mentions)
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
