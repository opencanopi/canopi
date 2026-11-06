// The Android smoke's flake probe (canopi-f47t.52.228.47, design check A29): a dispatch of phone-smoke.yml with
// android_repeats runs the Android job that many times side by side, and its verdict job passes only when every one of
// them ran and passed. A cancelled, skipped or unfinished repeat is no pass, and a missing one is counted as missing.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repeatVerdict, type RepeatJob } from '../../e2e/phones/android/repeat-verdict'

const SCRIPT = new URL('../../e2e/phones/android/repeat-verdict.ts', import.meta.url).pathname

/** The jobs API's view of `count` repeats that ended with `conclusion`, numbered from `from`. */
function repeats(count: number, conclusion: string | null, from = 1): RepeatJob[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Android (Chrome, emulator) ${from + index}`,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
  }))
}
const plan: RepeatJob = { name: 'Android repeats', status: 'completed', conclusion: 'success' }

describe('the Android repeat verdict (canopi-f47t.52.228.47)', () => {
  it('retried: 15 dispatched repeats, zero failures, pass', () => {
    const verdict = repeatVerdict([plan, ...repeats(15, 'success')], 15)
    expect(verdict).toEqual({ ok: true, passed: 15, summary: '15 of 15 Android repeats passed' })
  })

  it('retried: one failed repeat of 15 fails the verdict, naming it', () => {
    const verdict = repeatVerdict([...repeats(14, 'success'), ...repeats(1, 'failure', 15)], 15)
    expect(verdict.ok).toBe(false)
    expect(verdict.passed).toBe(14)
    expect(verdict.summary).toBe('14 of 15 Android repeats passed; failure: Android (Chrome, emulator) 15')
  })

  it('cancelled: a cancelled dispatch is not counted as a pass', () => {
    const verdict = repeatVerdict([...repeats(14, 'success'), ...repeats(1, 'cancelled', 15)], 15)
    expect(verdict.ok).toBe(false)
    expect(verdict.summary).toBe('14 of 15 Android repeats passed; cancelled: Android (Chrome, emulator) 15')
    // Nor a skipped or unfinished one, nor one that never ran.
    expect(repeatVerdict([...repeats(13, 'success'), ...repeats(1, 'skipped', 14), ...repeats(1, null, 15)], 15).summary)
      .toBe('13 of 15 Android repeats passed; skipped: Android (Chrome, emulator) 14; in_progress: Android (Chrome, emulator) 15')
    expect(repeatVerdict(repeats(14, 'success'), 15)).toEqual({ ok: false, passed: 14, summary: '14 of 15 Android repeats passed; 1 never ran' })
  })

  it('the verdict job\'s command fails on any repeat that did not pass and prints the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'android-repeats-'))
    try {
      const run = (jobs: RepeatJob[]) => {
        const file = join(dir, 'jobs.json')
        writeFileSync(file, JSON.stringify({ total_count: jobs.length, jobs }))
        return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, file, '15'], { encoding: 'utf8' })
      }
      const passed = run([plan, ...repeats(15, 'success')])
      expect(passed.status, passed.stderr).toBe(0)
      expect(passed.stdout).toContain('15 of 15 Android repeats passed')
      const cancelled = run([plan, ...repeats(14, 'success'), ...repeats(1, 'cancelled', 15)])
      expect(cancelled.status).toBe(1)
      expect(cancelled.stdout).toContain('::error::14 of 15 Android repeats passed; cancelled: Android (Chrome, emulator) 15')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
