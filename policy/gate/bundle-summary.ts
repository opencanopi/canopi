// policy/gate/bundle-summary.ts: the bundle budgets' step summary (2.1-Q203, 2.1-M240; ADR 0029), a gate mode so
// build.yml's frontend job runs no inline grep (design check A5 (1), 2.1-Q267). Rolldown builds are byte-stable, so a
// chunk over its tolerance is no flake to retry: after a red Frontend row, the summary holds the bundle check's refusals
// from the row's log and the bead to file. Only the bundle check's own FAIL line counts, never its self-test's.
import { appendFileSync, readFileSync } from 'node:fs'
import { display, TABLE } from './table.ts'

/** The summary for the Frontend row log `log`, or '' when the bundle check did not fail there. */
export function bundleSummary(log: string, env: NodeJS.ProcessEnv): string {
  const check = TABLE.checks['policy-bundle']
  if (!check) return ''
  const command = display(check)
  const lines = log.split('\n')
  if (!lines.includes(`gate: FAIL ${command}`)) return ''
  const start = lines.indexOf(`gate: ${command}`)
  const after = start < 0 ? [] : lines.slice(start + 1)
  const end = after.findIndex((line) => line.startsWith('gate: '))
  const refusals = (end < 0 ? after : after.slice(0, end)).filter((line) => /^([a-z-]+: |FAIL )/.test(line))
  const run = `${env['GITHUB_SERVER_URL'] ?? ''}/${env['GITHUB_REPOSITORY'] ?? ''}/actions/runs/${env['GITHUB_RUN_ID'] ?? ''}`
  const bead = `bd create --type=bug --priority=1 --title="Bundle size over budget at ${(env['GITHUB_SHA'] ?? '').slice(0, 12)}" `
    + `--description="npm run test:policies:bundle failed in ${run}; the refusals are in its step summary."`
  return ['### Bundle size budgets failed', '```', ...refusals, '```', 'File the bead:', '```', bead, '```', ''].join('\n')
}

/** `bundle-summary <log>`: appends the summary to $GITHUB_STEP_SUMMARY; 0 written or nothing to write, 1 refused. */
export function runBundleSummary(logFile: string, env: NodeJS.ProcessEnv = process.env): number {
  const target = env['GITHUB_STEP_SUMMARY']
  if (!target) {
    process.stderr.write('gate: bundle-summary writes to $GITHUB_STEP_SUMMARY, which is not set; refusing\n')
    return 1
  }
  let log = ''
  try {
    log = readFileSync(logFile, 'utf8')
  } catch {
    // No row log: the row failed before it wrote one, so no bundle check ran.
    return 0
  }
  appendFileSync(target, bundleSummary(log, env))
  return 0
}
