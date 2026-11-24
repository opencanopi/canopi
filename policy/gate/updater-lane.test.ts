// The updater lane's jobs (.github/workflows/updater-e2e.yml) as the runner reads them: the Windows job's limits and
// the steps that keep its diagnostics (canopi-ong0), and the macOS self-update probe (2.1-Q136, M97). Ported from
// scripts/test_release_smoke_lanes.py's UpdaterLaneTests, which read only this workflow's text (2.1-Q261, Q338).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { REPO_ROOT } from './planted-repo.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml

interface Step { readonly name?: string, readonly if?: string, readonly run?: string, readonly 'timeout-minutes'?: number }
interface Job {
  readonly if?: string, readonly 'runs-on'?: string, readonly 'timeout-minutes'?: number
  readonly 'continue-on-error'?: boolean, readonly steps: readonly Step[]
}
const TEXT = readFileSync(join(REPO_ROOT, '.github/workflows/updater-e2e.yml'), 'utf8')
const { jobs } = parse(TEXT) as { jobs: Record<string, Job> }
const step = (job: Job, name: string): Step => {
  const found = job.steps.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no step "${name}" in updater-e2e.yml`)
  return found
}

describe('the updater lane (updater-e2e.yml)', () => {
  it('canopi-ong0: a hung update ends inside the job and its diagnostics survive a cancellation', () => {
    // Review #232 (5): a 25-minute Windows job ended 30 s after the update spec's own bound, and the job timeout
    // cancelled the uploads. The job's limit covers every self-ending step plus the untimed builds, and the steps that
    // keep the profiles and logs also run on a cancellation.
    const updater = jobs['updater']!
    const timed = updater.steps.reduce((sum, candidate) => sum + (candidate['timeout-minutes'] ?? 0), 0)
    // Build N-1 and N's cold Windows worst case (three app builds) is untimed: at least 20 minutes stay for it.
    expect(updater['timeout-minutes'] ?? 0).toBeGreaterThanOrEqual(timed + 20)
    const update = step(updater, 'Update N-1 to N')
    const bound = /timeout --kill-after=(\d+) (\d+) npm run test:platform/u.exec(update.run ?? '')
    expect(bound, 'the update spec bounds itself').not.toBeNull()
    expect(Number(bound![1]) + Number(bound![2])).toBeLessThan((update['timeout-minutes'] ?? 0) * 60)
    expect(step(updater, 'Upload the app profiles and logs').if)
      .toBe("${{ failure() || cancelled() || github.event_name == 'workflow_dispatch' }}")
  })

  it('2.1-Q136, M97: the macOS probe reports off pull requests, signed with a key the job generates', () => {
    // The probe runs on a dispatch and a Release Candidate, itself a dispatch (never a pull request or a push to main),
    // never blocks, signs with a key the job generates, builds N's dmg and N+1's archive with the MCP bridge (not the
    // e2e feature, which refuses it), installs N into /Applications and runs release_smoke.py macos-probe.
    const probe = jobs['macos-probe']!
    expect([probe.if, probe['runs-on'], probe['continue-on-error']]).toEqual(["github.event_name == 'workflow_dispatch'", 'macos-15', true])
    const body = TEXT.split('\n  macos-probe:\n')[1] ?? ''
    expect(body).not.toContain('secrets.')
    expect(body).not.toContain(',e2e')
    for (const text of ['signer generate --ci', 'build --debug --features updater-e2e,mcp-bridge', 'bundles=app,dmg',
      'cp -R "$mount/Canopi.app" /Applications/', 'scripts/release_smoke.py macos-probe', '--from-version 9.0.0 --version 9.0.1']) {
      expect(body).toContain(text)
    }
  })
})
