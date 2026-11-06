// The bundle budgets' step summary (2.1-Q203, 2.1-M240): build.yml's frontend step, run by bash as the runner runs it,
// through the real gate entry on a planted row log.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { REPO_ROOT } from './planted-repo.ts'

/** desktop/web's YAML parser: policy/ has no packages of its own. */
const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
type Steps = { name?: string, if?: string, run?: string }[]
const frontend = (parse(readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8')) as { jobs: Record<string, { steps: Steps }> })
  .jobs['frontend']?.steps ?? []
const step = frontend.find((candidate) => candidate.name === 'Bundle size budgets summary')
const ENV = { GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://x', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' }

/** The frontend job's bundle summary step run by bash on a planted row log (`undefined`: none written); what it writes
 * to the step summary, or the run when it fails. */
function summary(log: string | undefined, env: Readonly<Record<string, string>> = {}): string {
  expect(step?.run, 'the frontend job has its bundle summary step').toBeTruthy()
  const dir = mkdtempSync(join(tmpdir(), 'canopi-bundle-summary-'))
  try {
    if (log !== undefined) writeFileSync(join(dir, 'frontend-row.log'), log)
    writeFileSync(join(dir, 'summary.md'), '')
    const run = spawnSync('bash', ['-e', '-c', step?.run ?? ''], { cwd: REPO_ROOT, encoding: 'utf8', env: {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env['PATH'] ?? ''}`, RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), ...ENV, ...env } })
    if (run.status !== 0) return `exit ${run.status}: ${run.stderr}`
    return readFileSync(join(dir, 'summary.md'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the bundle budgets summary (2.1-Q203)', () => {
  it('canopi-f47t.52.228.54: a failed bundle self-test is never reported as a bundle over budget', () => {
    const selfTest = 'gate: cd desktop/web && npm run test:policies:bundle:self-test'
    const bundle = 'gate: cd desktop/web && npm run test:policies:bundle'
    expect(summary([selfTest, 'FAIL planted case', bundle, 'gate: GREEN', `gate: FAIL ${selfTest.slice(6)}`, ''].join('\n'))).toBe('')
    const over = summary([bundle, 'bundle-size: assets/index.js 900 kB over its 800 kB budget', 'gate: RED',
      `gate: FAIL ${bundle.slice(6)}`, ''].join('\n'))
    expect(over).toContain('### Bundle size budgets failed')
    expect(over).toContain('bundle-size: assets/index.js 900 kB over its 800 kB budget')
  })

  it('canopi-f47t.52.228.54: the step is a gate call after a red Frontend row, over the log the row writes', () => {
    // design check A5 (1): no inline grep; the row tees its output where the summary reads it.
    const row = frontend.find((candidate) => candidate.name === 'The Frontend row')?.run ?? ''
    expect(row).toContain('node policy/gate/cli.mjs full --area frontend 2>&1 | tee "$RUNNER_TEMP/frontend-row.log"')
    expect([step?.if, step?.run?.trim()]).toEqual(['failure()', 'node policy/gate/cli.mjs bundle-summary "$RUNNER_TEMP/frontend-row.log"'])
    const bundle = 'gate: cd desktop/web && npm run test:policies:bundle'
    const over = summary([bundle, 'FAIL assets/x.js over budget', 'gate: cd desktop/web && npm run check:notices', 'notices: stale',
      `gate: FAIL ${bundle.slice(6)}`, ''].join('\n'))
    expect(over.split('```')[1]).toBe('\nFAIL assets/x.js over budget\n')
    expect(over).toContain('bd create --type=bug --priority=1 --title="Bundle size over budget at aaaaaaaaaaaa" '
      + '--description="npm run test:policies:bundle failed in https://x/o/r/actions/runs/1; the refusals are in its step summary."')
    // A row that failed before it wrote its log ran no bundle check; a runner with no step summary is refused.
    expect(summary(undefined)).toBe('')
    expect(summary('', { GITHUB_STEP_SUMMARY: '' })).toContain('exit 1: gate: bundle-summary writes to $GITHUB_STEP_SUMMARY, which is not set')
  })
})
