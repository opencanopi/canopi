// The seed lane (.github/workflows/seed-lane.yml; ADR 0028 Model-based tests, 2.1-M60, 2.1-M67): its planted job's
// verdict, run as the workflow runs it, over the real planted fixture and over planted logs (design check C3 fix review).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './planted-repo.ts'
import { TABLE } from './table.ts'
import { filterSelects, readWorkflows, triggers, type Step } from './workflows.ts'

const SEED = readWorkflows(join(REPO_ROOT, '.github/workflows')).get('seed-lane.yml')
const PLANTED_STEP = 'The lane fails a planted order-dependent test and prints its seed'

/** The planted job's step: its script and environment, as the runner reads them. */
function plantedStep(): Step & { readonly env?: Readonly<Record<string, string>> } {
  const step = SEED?.jobs?.['planted']?.steps?.find((s) => s.name === PLANTED_STEP)
  if (!step?.run) throw new Error(`seed-lane.yml has no planted step "${PLANTED_STEP}"`)
  return step
}

describe('the seed lane\'s planted job (canopi-f47t.52.228.54)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-lane-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The step in GitHub's bash (`-eo pipefail`) from desktop/web, its npm the real one or a fake printing `log` and exiting `status`. */
  const run = (fake?: { log: string, status: number }) => {
    const step = plantedStep()
    let path = process.env['PATH'] ?? ''
    if (fake) {
      writeFileSync(join(dir, 'log.txt'), fake.log)
      writeFileSync(join(dir, 'npm'), `#!/usr/bin/env bash\ncat "${join(dir, 'log.txt')}"\nexit ${fake.status}\n`)
      chmodSync(join(dir, 'npm'), 0o755)
      path = `${dir}:${path}`
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')))
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''], {
      cwd: join(REPO_ROOT, 'desktop/web'), encoding: 'utf8', timeout: 120_000,
      // GitHub sets CI, which turns the reporter's colours on.
      env: { ...env, ...step.env, CI: 'true', PATH: path, RUNNER_TEMP: dir },
    })
  }
  const SEED_LINE = 'CANOPI_TEST_SEED=3 CANOPI_FC_SEED=42\n'

  it('passes when the lane fails the planted test at its seed, through the real lane', () => {
    const result = run()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }, 120_000)

  it('canopi-f47t.52.228.54: fails when the lane exits non-zero and prints its seed without running the planted test', () => {
    const result = run({ log: `${SEED_LINE}\nNo test files found, exiting with code 1\n`, status: 1 })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('::error::The seed lane failed, but not on the planted test')
  })

  it('fails when another test of the fixture fails instead of the planted one', () => {
    const other = ' FAIL  |web| ../../policy/fixtures/seed-lane/order-dependent.test.ts > runs the first step\n'
    expect(run({ log: `${SEED_LINE}${other}`, status: 1 }).status).not.toBe(0)
  })

  it('fails when the lane passes the planted test, or fails it without printing its seed', () => {
    const planted = ' FAIL  |web| ../../policy/fixtures/seed-lane/order-dependent.test.ts > runs the second step\n'
    expect(run({ log: `${SEED_LINE}${planted}`, status: 0 }).status).not.toBe(0)
    expect(run({ log: planted, status: 1 }).status).not.toBe(0)
    expect(run({ log: `${SEED_LINE}${planted}`, status: 1 }).status).toBe(0)
  })
})

// Random seeds find nothing a change to the lane's own files could not show on its PR; everything else is read on main.
describe('the seed lane\'s triggers (canopi-f47t.52.240)', () => {
  const on = triggers(SEED ?? {})

  it('runs on a pull request only when it changes the lane\'s own files, on every push to main, and nightly', () => {
    const own = ['.github/workflows/seed-lane.yml', 'policy/fixtures/seed-lane/order-dependent.test.ts', 'policy/fixtures/seed-lane/proptest/src/lib.rs',
      'desktop/web/vite.config.ts', 'desktop/web/package.json', 'desktop/web/src/__tests__/support/fast-check-setup.ts',
      'desktop/web/src/__tests__/support/fc-regressions.json', 'desktop/src/services/lidar/grid.rs']
    for (const file of own) expect(filterSelects(on['pull_request'], file), file).toBe(true)
    for (const file of ['desktop/web/src/app/shell/app-shell.tsx', 'desktop/src/lib.rs', 'policy/gate/plan.ts', 'docs/README.md']) {
      expect(filterSelects(on['pull_request'], file), file).toBe(false)
    }
    expect(on['push']).toEqual({ branches: ['main'] })
    expect(on['schedule']).toEqual([{ cron: expect.stringMatching(/^\S+ \S+ \* \* \*$/) as unknown }])
    expect([...TABLE.checks['seed']?.on ?? []].sort()).toEqual(['pull_request', 'push', 'schedule'])
  })
})
