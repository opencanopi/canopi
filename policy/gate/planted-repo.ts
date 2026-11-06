// policy/gate/planted-repo.ts: a temporary repository holding a copy of the real gate, for the gate's tests. Each case
// stages a change and runs the real CLI there (`node policy/gate/cli.mjs`); PATH shims for npm, npx, cargo, docker and python3
// record their calls instead of running, and a stand-in dependency-cruiser names one module reaching whatever changed.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** The gate's entry, every caller's: plain JavaScript, so any Node can load it and learn it is the wrong one. */
export const ENTRY = 'policy/gate/cli.mjs'
// The planted repository's lock; the image is built from it, so check_playwright_pins finds no stale literal here.
export const PLANTED_PLAYWRIGHT = '9.8.7'
export const PLANTED_IMAGE = `mcr.microsoft.com/playwright:v${PLANTED_PLAYWRIGHT}-noble`

const SHIM = `#!/bin/sh
echo "$(basename "$0") $* offline=\${npm_config_offline:-unset}" >> "$SHIM_LOG"
case "$(basename "$0") $1 $2" in
  "docker image inspect"|"docker pull "*) [ -n "$SHIM_NO_IMAGE" ] && { echo "dial tcp: lookup mcr.microsoft.com: no such host" >&2; exit 1; } ;;
  "npm run "*) [ -n "$SHIM_SLOW_NPM" ] && sleep 30 ;;
  "cargo llvm-cov "*) [ -n "$SHIM_SLOW_CARGO" ] && sleep 30 ;;
  "docker run "*) [ -n "$SHIM_E2E_FAIL" ] && { echo "1 failed" >&2; exit 1; } ;;
esac
exit 0
`

export function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout.trim()
}

/** The test process's environment without git's hook variables, an offline npm or a cargo target. */
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('GIT_') && name !== 'npm_config_offline' && name !== 'CARGO_TARGET_DIR'))
}

export interface GateRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export class PlantedRepo {
  readonly root = mkdtempSync(join(tmpdir(), 'canopi-gate-'))
  readonly repo = join(this.root, 'repo')
  readonly bin = join(this.root, 'bin')
  readonly log = join(this.root, 'calls.log')
  readonly base: string

  constructor(options: { readonly packages?: boolean } = {}) {
    mkdirSync(this.repo)
    git(this.repo, 'init', '-q', '-b', 'main')
    git(this.repo, 'config', 'user.email', 'test@example.invalid')
    git(this.repo, 'config', 'user.name', 'test')
    const gate = join(REPO_ROOT, 'policy/gate')
    for (const name of readdirSync(gate).filter((file) => !file.includes('.test.'))) {
      cpSync(join(gate, name), join(this.repo, 'policy/gate', name))
    }
    this.write({
      'README.md': 'x\n',
      'AGENTS.md': 'Enforced by `cited.test.ts`.\n',
      'desktop/web/package.json': readFileSync(join(REPO_ROOT, 'desktop/web/package.json'), 'utf8'),
      ...Object.fromEntries(['invoke-only-in-ipc', 'file-size', 'test-location', 'python-lines'].map((id) =>
        [`policy/ratchets/${id}.json`, readFileSync(join(REPO_ROOT, `policy/ratchets/${id}.json`), 'utf8')])),
      'desktop/web/package-lock.json': JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: PLANTED_PLAYWRIGHT } } }),
      'desktop/web/src/__tests__/scan.test.ts': "import { readdirSync } from 'node:fs'\n",
      'desktop/web/src/__tests__/harness.test.ts': "import { rule } from './support/policy-harness'\n",
      'desktop/web/src/__tests__/i18n-copy.test.ts': "import en from '../i18n/en.json'\n",
      'desktop/web/src/__tests__/cited.test.ts': "it('x', () => {})\n",
      'desktop/web/src/__tests__/plain.test.ts': "it('x', () => {})\n",
      'desktop/web/src/__tests__/ios.test.ts': "new URL('phone-smoke.yml')\n",
      'desktop/web/src/__tests__/wiring.test.ts': "workflow('build.yml')\n",
      'desktop/web/src/app/x.ts': 'export const x = 1\n',
      'desktop/web/src/app/x.test.ts': "it('x', () => {})\n",
      'scripts/foo.py': 'x = 1\n',
      'scripts/test_foo.py': 'x = 1\n',
      'scripts/test_foo_table.py': 'x = 1\n',
      'desktop/web/e2e/canvas/a.spec.ts': 'x\n',
      '.gitignore': 'node_modules/\n',
    })
    if (options.packages !== false) {
      // The cruiser stands in for dependency-cruiser: it names one module reaching whatever changed.
      const cruiser = 'desktop/web/node_modules/.bin/depcruise'
      this.write({ [cruiser]: '#!/bin/sh\necho "$*" >> "$SHIM_LOG"\n'
        + 'echo \'{"modules": [{"source": "src/app/user.ts"}, {"source": "src/app/user.test.ts"}]}\'\n' })
      chmodSync(join(this.repo, cruiser), 0o755)
    }
    git(this.repo, 'add', '-A')
    git(this.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base')
    this.base = git(this.repo, 'rev-parse', 'HEAD')
    git(this.repo, 'update-ref', 'refs/remotes/origin/main', this.base)
    mkdirSync(this.bin)
    for (const name of ['npm', 'npx', 'cargo', 'docker', 'python3']) {
      writeFileSync(join(this.bin, name), SHIM)
      chmodSync(join(this.bin, name), 0o755)
    }
    writeFileSync(this.log, '')
  }

  /** Links the real repository's glob engine (picomatch) into the planted desktop/web/node_modules. */
  linkGlobEngine(): void {
    mkdirSync(join(this.repo, 'desktop/web/node_modules'), { recursive: true })
    symlinkSync(join(REPO_ROOT, 'desktop/web/node_modules/picomatch'), join(this.repo, 'desktop/web/node_modules/picomatch'))
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  write(files: Readonly<Record<string, string>>, at: string = this.repo): void {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(at, name)), { recursive: true })
      writeFileSync(join(at, name), text)
    }
  }

  /** Stages `paths`, creating each missing one and appending a line to each present one. */
  stage(...paths: string[]): void {
    for (const path of paths) {
      const file = join(this.repo, path)
      this.write({ [path]: existsSync(file) ? `${readFileSync(file, 'utf8')}\n` : 'x\n' })
    }
    git(this.repo, 'add', ...paths)
  }

  /** Back to the base commit with nothing staged or untracked. */
  reset(to: string = this.base): void {
    git(this.repo, 'reset', '-q', '--hard', to)
    git(this.repo, 'clean', '-qfd', '-e', 'node_modules')
  }

  env(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
    const env = cleanEnv()
    return { ...env, PATH: `${this.bin}${delimiter}${env['PATH'] ?? ''}`, SHIM_LOG: this.log, ...extra }
  }

  /** The real entry run with `args`; `node` holds Node's own options, such as one turning type stripping off. */
  gate(args: readonly string[], options: { readonly cwd?: string, readonly env?: Readonly<Record<string, string>>,
    readonly node?: readonly string[] } = {}): GateRun {
    const run = spawnSync(process.execPath, [...options.node ?? [], ENTRY, ...args], {
      cwd: options.cwd ?? this.repo, encoding: 'utf8', timeout: 120_000, env: this.env(options.env),
    })
    return { status: run.status, stdout: run.stdout, stderr: run.stderr }
  }

  /** The real entry run with `args`, sent SIGINT once a shim recorded a call: its exit code. */
  async interrupted(args: readonly string[], env: Readonly<Record<string, string>>): Promise<number | null> {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: this.repo, env: this.env(env), stdio: 'ignore' })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    const deadline = Date.now() + 20_000
    while (!this.calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    child.kill('SIGINT')
    return exited
  }

  /** `--print`'s JSON, failing on a refusal. */
  printed(args: readonly string[], cwd?: string): PrintedPlan {
    const run = this.gate([...args, '--print'], { cwd })
    if (run.status !== 0) throw new Error(`gate ${args.join(' ')} --print exited ${run.status}: ${run.stderr}`)
    return JSON.parse(run.stdout) as PrintedPlan
  }

  /** The commands the affected (or, `staged`, the commit) lane runs after staging `paths`. */
  checks(paths: readonly string[], staged = false): string[] {
    this.stage(...paths)
    return this.printed(['affected', ...(staged ? ['--staged'] : ['--base', this.base])]).checks.map((check) => check.command)
  }

  calls(): string[] {
    return readFileSync(this.log, 'utf8').split('\n').filter((line) => line !== '')
  }
}

export interface PrintedPlan {
  readonly checks: readonly { readonly id: string, readonly command: string }[]
  readonly ci_only: readonly { readonly id: string, readonly command: string }[]
  readonly selected: readonly string[]
  readonly areas: readonly { readonly name: string, readonly patterns: readonly string[], readonly scans: readonly string[] }[]
  readonly e2e: { readonly image: string, readonly specs: string[], readonly projects: string[], readonly command: string } | null
  readonly notes: readonly string[]
}
