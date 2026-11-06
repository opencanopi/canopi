// policy/gate/prepush-checks.ts: the pre-push lane's last check, `node policy/gate/cli.mjs prepush-checks --base <rev>`
// (2.1-Q272: every check list lives in the gate, the agent's wrapper only delegates; canopi-f47t.52.228.54). Two rules
// quiet-gates held until then:
// - Expected-fail markers (Vitest `it.fails`/`test.fails`/`describe.fails`, Playwright `test.fail(`, Rust
//   `#[ignore = "expected-fail ..."]`) carry a known red with its owner and bead; one added since the base fails the
//   push, since a marker already on the base (an upstream-blocked test with its bead) is not this push's to clear. A
//   marker the upstream register exempts (tagged with an open W row, 2.1-M237) waits on its upstream fix. Markers are read
//   from the base and HEAD commits, the whole tree by file type (a new test root never drops one), policy/ aside (its
//   planted fixtures and comments name the markers); the register's list must be readable, never read as empty.
// - CI's containers differ from the local e2e run (user, HOME): a range touching .github/workflows/,
//   desktop/web/playwright.config.ts or desktop/web/e2e/support/ needs a green CI run on HEAD, named by CI_RUN (2.0.3: a
//   new Firefox project failed all 90 tests in CI twice).
import { spawnSync } from 'node:child_process'
import { git } from './plan.ts'

const TS_MARKER = String.raw`\b(it|test|describe)\.fails?\(`
const RUST_MARKER = '#[ignore = "expected-fail'
const CI_SETUP = /^(?:\.github\/workflows\/|desktop\/web\/playwright\.config\.ts$|desktop\/web\/e2e\/support\/)/u
const REGISTER = 'policy/adapters/upstream-register.mjs'

/** `path:line:text` for each marker in the commit `rev`. */
function markers(root: string, rev: string): string[] {
  const grep = (args: readonly string[]) => {
    const run = spawnSync('git', ['grep', '-n', ...args, rev, '--', ...args.includes('-F') ? ['*.rs'] : ['*.ts', '*.tsx'], ':!policy/**'],
      { cwd: root, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))) })
    // git grep exits 1 when nothing matches; anything else is a fault, never read as no marker.
    if (run.status !== 0 && run.status !== 1) throw new Error(`git grep in ${rev} exited ${run.status}: ${run.stderr.trim()}`)
    return run.stdout.split('\n').filter((line) => line !== '').map((line) => line.slice(rev.length + 1))
  }
  return [...grep(['-E', '-e', TS_MARKER]), ...grep(['-F', '-e', RUST_MARKER])]
}

const text = (marker: string) => marker.replace(/^[^:]*:\d+:/u, '').trim()

/** The markers at HEAD whose text is on no marker line of `base` and whose `path:line` `exempt` does not hold, sorted. */
export function addedMarkers(root: string, base: string, exempt: ReadonlySet<string>): string[] {
  const before = new Set(markers(root, base).map(text))
  return markers(root, 'HEAD').filter((marker) => !before.has(text(marker))
    && !exempt.has(marker.replace(/^([^:]*:\d+):.*$/su, '$1'))).sort()
}

/** `conclusion headSha` of CI run `id`, from GitHub. */
const ghView = (id: string) => spawnSync('gh', ['run', 'view', id, '--repo', 'opencanopi/canopi', '--json', 'conclusion,headSha',
  '--jq', '.conclusion+" "+.headSha'], { encoding: 'utf8' }).stdout.trim()

const touchesCiSetup = (root: string, base: string) =>
  git(root, ['diff', '--name-only', `${base}...HEAD`]).split('\n').some((path) => CI_SETUP.test(path))

/** Why the range from `base` cannot be pushed without a green CI run on HEAD, or undefined when it can. */
export function ciRunFault(root: string, base: string, env: NodeJS.ProcessEnv,
  view: (id: string) => string = ghView): string | undefined {
  if (!touchesCiSetup(root, base)) return undefined
  const id = env['CI_RUN'] ?? ''
  if (!id) return 'CI or Playwright setup changed: push a draft PR, wait for CI, rerun with CI_RUN=<green run id on HEAD>'
  return view(id) === `success ${git(root, ['rev-parse', 'HEAD']).trim()}` ? undefined
    : `CI run ${id} is not green on HEAD: CI or Playwright setup changed, rerun with CI_RUN=<green run id on HEAD>`
}

/** Both checks from `base`, each printing PASS or FAIL: 0 when both pass. */
export function prepushChecks(root: string, base: string, env: NodeJS.ProcessEnv = process.env): number {
  let failed = false
  const fail = (line: string) => {
    process.stdout.write(`FAIL ${line}\n`)
    failed = true
  }
  const ci = ciRunFault(root, base, env)
  if (ci) fail(ci)
  else process.stdout.write(touchesCiSetup(root, base) ? `PASS CI run ${env['CI_RUN']} green on HEAD\n` : 'PASS no CI or Playwright setup changed\n')
  const listed = spawnSync(process.execPath, [REGISTER, 'markers'], { cwd: root, encoding: 'utf8' })
  if (listed.status !== 0) {
    fail(`${REGISTER} markers exited ${listed.status}: the exempt markers are unknown (${listed.stderr.trim()})`)
    return 1
  }
  const exempt = new Set(listed.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ')[0] ?? ''))
  const added = addedMarkers(root, base, exempt)
  if (added.length) fail(`expected-fail markers added since the base:\n${added.join('\n')}`)
  else process.stdout.write('PASS no expected-fail markers beyond those on the base\n')
  return failed ? 1 : 0
}
