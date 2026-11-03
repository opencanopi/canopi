// policy/gate/run.ts: running a plan (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q267). Each check runs in its own process
// group with its output passed through, never under the hook's git: a linked worktree's hook exports GIT_DIR and
// GIT_INDEX_FILE, under which a check's `git init` in a temporary root re-initialises the real repository. The commit lane
// runs npm offline and stops at its first failure. A desktop/web check where its packages are not installed (a fresh
// worktree) fails naming `npm ci` and runs nothing; policy/check.mjs refuses so itself when it needs its glob engine. SIGINT stops the running check's group and every later check,
// and the summary says the run is not green; the gate writes nothing.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { E2ePlan, PlannedCheck } from './plan.ts'
import { GateError } from './plan.ts'
import { display, TABLE, WEB, type Table } from './table.ts'

const log = (line: string) => process.stderr.write(`gate: ${line}\n`)

/** A command's leading NAME=value words as its environment, and its argv; table commands hold no quoting. */
export function splitEnv(command: string): { env: Record<string, string>, argv: string[] } {
  const words = command.split(/\s+/).filter((word) => word !== '')
  const env: Record<string, string> = {}
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
    const word = words.shift() ?? ''
    const at = word.indexOf('=')
    env[word.slice(0, at)] = word.slice(at + 1)
  }
  return { env, argv: words }
}

/** One running process: its exit code, and a stop for its whole group. */
interface Running {
  readonly done: Promise<number>
  stop(): void
}

/** One process in its own group, its output passed through. */
function start(name: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Running {
  log(name)
  const [command = '', ...args] = argv
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: true })
  const done = new Promise<number>((resolve) => {
    child.once('error', (error) => {
      log(`${name} could not start: ${error.message}`)
      resolve(127)
    })
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
  const group = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal)
    } catch {
      // the group has ended
    }
  }
  return {
    done,
    stop() {
      group('SIGINT')
      setTimeout(() => group('SIGKILL'), 5000).unref()
    },
  }
}

/** A check's environment: no GIT_* variable; npm offline in the commit lane. */
export function checkEnv(env: NodeJS.ProcessEnv, staged: boolean): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')))
  if (staged) clean['npm_config_offline'] = 'true'
  return clean
}

const needsPackages = (planned: PlannedCheck) => planned.cwd === WEB

/** The pinned image or nothing: a missing image that cannot be pulled fails; host browsers are never used. */
function ensureImage(image: string): void {
  const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
  if (inspect.error) throw new GateError(`docker is not installed: e2e runs only in ${image}, never in host browsers`)
  if (inspect.status === 0) return
  const pulled = spawnSync('docker', ['pull', image], { encoding: 'utf8' })
  if (pulled.status !== 0) {
    throw new GateError(`the e2e image ${image} is missing and could not be pulled (${(pulled.stderr ?? '').trim().slice(0, 200)}); `
      + 'e2e runs only in that image, never in host browsers')
  }
}

/** Runs `checks` and the e2e run at `root`; 0 when every check passed, 1 when one failed, 130 after SIGINT. */
export async function execute(root: string, checks: readonly PlannedCheck[], e2e: E2ePlan | undefined,
  notes: readonly string[], staged: boolean, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const base = checkEnv(env, staged)
  for (const note of notes) log(note)
  const failed: string[] = []
  let passed = 0
  const packages = existsSync(join(root, WEB, 'node_modules'))
  let interrupted = false
  let running: Running | undefined
  const onInterrupt = () => {
    interrupted = true
    running?.stop()
  }
  process.on('SIGINT', onInterrupt)
  const run = async (name: string, argv: readonly string[], cwd: string, runEnv: NodeJS.ProcessEnv) => {
    running = start(name, argv, cwd, runEnv)
    const code = await running.done
    running = undefined
    return code
  }
  try {
    for (const planned of checks) {
      if (interrupted) break
      const text = display(planned)
      if (planned.ciOnly) {
        log(`CI only: ${text}`)
        continue
      }
      if (needsPackages(planned) && !packages) {
        log(`FAIL ${text}: ${WEB}/node_modules is missing: run npm ci in ${WEB}`)
        failed.push(text)
        if (staged) break
        continue
      }
      const { env: extra, argv } = splitEnv(planned.command)
      const code = await run(text, argv, join(root, planned.cwd ?? ''), { ...base, ...extra })
      if (interrupted) break
      if (code === 0) passed += 1
      else {
        failed.push(text)
        if (staged) break
      }
    }
    if (e2e && !failed.length && !interrupted) {
      ensureImage(e2e.image)
      const name = `e2e in ${e2e.image}`
      const code = await run(name, e2e.argv, root, base)
      if (!interrupted) {
        if (code === 0) passed += 1
        else failed.push(name)
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
  if (interrupted) {
    log(`NOT GREEN: interrupted; ${passed} passed, ${failed.length} failed, the rest not run; nothing was written`)
    return 130
  }
  for (const name of failed) log(`FAIL ${name}`)
  log(`${failed.length ? 'RED' : 'GREEN'} (${passed} passed, ${failed.length} failed)`)
  return failed.length ? 1 : 0
}

/** The pinned actionlint over the workflows with the repository's config, failing closed on a missing binary or another
 * version; shellcheck and pyflakes stay off, so the pinned tool alone decides, never a runner's own copy. */
export function runActionlint(root: string, env: NodeJS.ProcessEnv = process.env, table: Table = TABLE): number {
  const pin = table.actionlint
  const binary = env['CANOPI_ACTIONLINT'] || 'actionlint'
  const probe = spawnSync(binary, ['-version'], { encoding: 'utf8', env })
  const version = probe.error ? undefined : (probe.stdout ?? '').split('\n', 1)[0]?.trim()
  if (version !== pin.version) {
    throw new GateError(`actionlint ${pin.version} is needed (found ${version || 'none'}): put the binary of ${pin.url} `
      + `(sha256 ${pin.sha256}) on PATH or name it in CANOPI_ACTIONLINT`)
  }
  log(`actionlint ${pin.version}`)
  const run = spawnSync(binary, ['-config-file', '.github/actionlint.yaml', '-shellcheck=', '-pyflakes='],
    { cwd: root, stdio: 'inherit', env })
  return run.status ?? 1
}
