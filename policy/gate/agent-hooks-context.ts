// policy/gate/agent-hooks-context.ts: where a Bash command the agent hooks read (agent-hooks.ts) runs, as its simple
// commands go (2.1-M196, 2.1-M349; canopi-f47t.52.228.54): the directory, followed through `cd`, `pushd` and `popd` or
// unknown when the hook cannot follow them, the variables set so far, and whether a directory is the user's checkout,
// the main worktree of the session project's repository (`git rev-parse --git-common-dir`); another repository or a
// linked worktree is never it.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, posix, resolve as resolvePath } from 'node:path'
import { STAMP_PATH } from './agent-hooks-stamp.ts'

/** git's trimmed output at `cwd`, or undefined when it fails; never under the caller's GIT_* variables. */
export function gitOut(cwd: string, ...args: string[]): string | undefined {
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
export function mainWorktree(cwd: string): [string | undefined, string | undefined] {
  const common = gitOut(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) return [undefined, undefined]
  const dir = real(common)
  return [basename(dir) === '.git' ? dirname(dir) : undefined, dir]
}

/** `raw` with the variables `env` holds and a leading `~` or `~/` expanded; another variable or `~name` stays as written. */
function expand(raw: string, env: NodeJS.ProcessEnv): string {
  const expanded = raw.replace(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([^}]*)\})/g, (match, bare?: string, braced?: string) =>
    env[bare ?? braced ?? ''] ?? match)
  return expanded === '~' || expanded.startsWith('~/') ? homedir() + expanded.slice(1) : expanded
}

/**
 * `raw` (a cd or -C argument) against `base`; undefined when either is unknown or the hook cannot expand it exactly: a
 * variable or substitution left as written, or a `~` it does not expand (`~name`, `~+`), which names no directory here.
 */
export function resolve(base: string | undefined, raw: string, env: NodeJS.ProcessEnv): string | undefined {
  if (base === undefined) return undefined
  const expanded = expand(raw, env)
  if (/[$`\u0002]/.test(expanded) || expanded.startsWith('~')) return undefined
  return resolvePath(base, expanded)
}

// The options `cd` and `pushd` take that leave the target as written: bash's -L, -P, -e, -@, zsh's -q and -s.
const CD_OPTIONS = /^-[LPeqs@]+$/

/**
 * The directory `cd` or `pushd` moves to, as written (`-` returns to the one before), and whether the hook can follow
 * it: not after an option it does not know, zsh's two-operand `cd old new`, a stack entry (`+1`, `-1`, a bare pushd), a
 * pattern (`exact(k)` false for args[k]), or `-P` through `..`. popd leaves a stack this command did not fill unknown.
 */
function cdOperand(program: string, args: readonly string[], exact: (k: number) => boolean): { target: string, known: boolean } {
  const operands: string[] = []
  let physical = false
  let options = true
  let known = true
  for (const [k, arg] of args.entries()) {
    if (options && arg === '--') {
      options = false
    } else if (options && CD_OPTIONS.test(arg)) {
      physical ||= arg.includes('P')
    } else {
      known &&= exact(k) && !(options && /^[-+]./.test(arg))
      options = false
      operands.push(arg)
    }
  }
  const target = operands.length === 0 && program === 'cd' ? '~' : operands[0] ?? '.'
  known &&= (operands.length === 1 || target === '~') && !(physical && target.split('/').includes('..'))
    && !(program === 'pushd' && target === '-')
  return { target, known }
}

interface Place {
  readonly cwd: string | undefined
  readonly inside: boolean
}

export class Context {
  readonly env: Record<string, string> = {}
  cwd: string | undefined
  /** Whether the command runs in the stamp directory, known from a `cd` word naming it even when cwd is unknown. */
  inside: boolean
  private previous: Place = { cwd: undefined, inside: false }
  private readonly stack: Place[] = []
  readonly userCheckout: [string | undefined, string | undefined]
  readonly processEnv: NodeJS.ProcessEnv

  constructor(cwd: string | undefined, userCheckout: [string | undefined, string | undefined], processEnv: NodeJS.ProcessEnv) {
    this.cwd = cwd
    this.inside = STAMP_PATH.test(cwd ?? '')
    this.userCheckout = userCheckout
    this.processEnv = processEnv
  }

  /** A copy for a child shell (`bash -c`): what the child changes leaves this context as it was. */
  child(): Context {
    const copy = new Context(this.cwd, this.userCheckout, this.processEnv)
    Object.assign(copy.env, this.env)
    copy.inside = this.inside
    copy.previous = this.previous
    copy.stack.push(...this.stack)
    return copy
  }

  /** The process's variables and those the command set before this point. */
  get vars(): NodeJS.ProcessEnv {
    return { ...this.processEnv, ...this.env }
  }

  expand(raw: string) {
    return expand(raw, this.vars)
  }

  resolve(raw: string) {
    return resolve(this.cwd, raw, this.vars)
  }

  /** `cd`, `pushd` or `popd` with `args` (cdOperand); an unknown target is inside the stamp directory when its words name it. */
  move(program: string, args: readonly string[], exact: (k: number) => boolean) {
    const here = { cwd: this.cwd, inside: this.inside }
    if (program === 'popd') {
      this.go((args.length ? undefined : this.stack.pop()) ?? { cwd: undefined, inside: false }, here)
      return
    }
    if (program === 'pushd') this.stack.push(here)
    const { target, known } = cdOperand(program, args, exact)
    const viaCdpath = !/^[./~$]/.test(target) && Boolean(this.vars['CDPATH'])
    if (!known || viaCdpath) {
      this.go({ cwd: undefined, inside: STAMP_PATH.test(posix.normalize(target)) }, here)
    } else if (target === '-') {
      this.go(this.previous, here)
    } else {
      const cwd = this.resolve(target)
      this.go({ cwd, inside: STAMP_PATH.test(cwd ?? posix.normalize(target)) }, here)
    }
  }

  private go(to: Place, from: Place) {
    ({ cwd: this.cwd, inside: this.inside } = to)
    this.previous = from
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
