// policy/gate/prepush-checks.ts: the pre-push lane's last check, `node policy/gate/cli.mjs prepush-checks --base <rev>`
// (2.1-Q272: every check list lives in the gate, the agent's wrapper only delegates; canopi-f47t.52.228.54), the rule
// quiet-gates held until then that no CI job runs:
// - Expected-fail markers (Vitest `it.fails`/`test.fails`/`describe.fails`, Playwright `test.fail(`, Rust
//   `#[ignore = "expected-fail ..."]`) carry a known red with its owner and bead; one added since the base fails the
//   push, since a marker already on the base (an upstream-blocked test with its bead) is not this push's to clear. A
//   marker the upstream register exempts (tagged with an open W row, 2.1-M237) waits on its upstream fix. Markers are read
//   from the base and HEAD commits, the whole tree by file type (a new test root never drops one), policy/ aside (its
//   planted fixtures and comments name the markers); the register's list must be readable, never read as empty.
// - Inside `gate push` (2.1-Q328), which names a record file in MARKERS_RECORD, added markers do not stop the lane: they
//   go to that file and the check says SCRATCH ONLY, so the rest of the lane (its e2e run included) still runs, and a lane
//   otherwise green writes a stamp naming them, which verify-push.ts accepts for refs under scratch/ only (a step's
//   integration tip carries the markers its streams have not cleared yet). Run alone, the check fails as above.
// quiet-gates' other rule, a green CI run on HEAD for a change to CI or the Playwright setup (2.0.3), is not here: HEAD
// reaches CI only once pushed, and the stamp this lane writes is what lets it be pushed. The merge holds it instead: Build
// & Test, a required check, runs the lanes such a change selects on the PR's head.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

/** The environment variable naming the file `gate push` reads the added markers from (stamp.ts). */
export const MARKERS_RECORD = 'CANOPI_GATE_MARKERS_RECORD'

const TS_MARKER = String.raw`\b(it|test|describe)\.fails?\(`
const RUST_MARKER = '#[ignore = "expected-fail'
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

/** The marker check from `base`, printing PASS, SCRATCH ONLY (markers recorded for `gate push`) or FAIL: 0 unless FAIL. */
export function prepushChecks(root: string, base: string): number {
  const listed = spawnSync(process.execPath, [REGISTER, 'markers'], { cwd: root, encoding: 'utf8' })
  if (listed.status !== 0) {
    process.stdout.write(`FAIL ${REGISTER} markers exited ${listed.status}: the exempt markers are unknown (${listed.stderr.trim()})\n`)
    return 1
  }
  const exempt = new Set(listed.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ')[0] ?? ''))
  const added = addedMarkers(root, base, exempt)
  const record = process.env[MARKERS_RECORD]
  if (added.length && record) {
    writeFileSync(record, `${JSON.stringify(added)}\n`)
    process.stdout.write(`SCRATCH ONLY expected-fail markers added since the base:\n${added.join('\n')}\n`
      + 'the lane goes on; green, its stamp serves refs under scratch/ only until they are cleared\n')
    return 0
  }
  if (added.length) {
    process.stdout.write(`FAIL expected-fail markers added since the base:\n${added.join('\n')}\n`)
    return 1
  }
  process.stdout.write('PASS no expected-fail markers beyond those on the base\n')
  return 0
}
