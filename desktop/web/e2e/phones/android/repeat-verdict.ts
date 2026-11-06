// The Android smoke's flake probe verdict (canopi-f47t.52.228.47, design check A29): a dispatch of phone-smoke.yml with
// android_repeats runs the Android job that many times side by side, and its verdict job reads the run's jobs (the
// jobs API's JSON) and passes only when every repeat ran to a pass. A cancelled, skipped or unfinished repeat is no
// pass, and a repeat that never ran is counted as missing, so a probe cannot pass on fewer runs than it asked for.
// `node --experimental-strip-types repeat-verdict.ts <jobs.json> <wanted>`; unit tested in
// src/__tests__/android-repeat-verdict.test.ts.
import { readFileSync } from 'node:fs'

/** One job as GitHub's jobs API lists it. */
export interface RepeatJob {
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
}

export interface RepeatVerdict {
  readonly ok: boolean
  readonly passed: number
  readonly summary: string
}

/** The Android job's name; each repeat appends its number. */
const REPEAT = /^Android \(Chrome, emulator\) \d+$/

/** Whether `wanted` repeats among `jobs` all ran and passed, and the count that did, with every other one named. */
export function repeatVerdict(jobs: readonly RepeatJob[], wanted: number): RepeatVerdict {
  const legs = jobs.filter((job) => REPEAT.test(job.name))
  const passed = legs.filter((job) => job.status === 'completed' && job.conclusion === 'success').length
  const others = new Map<string, string[]>()
  for (const job of legs) {
    if (job.status === 'completed' && job.conclusion === 'success') continue
    const kind = job.status === 'completed' ? job.conclusion ?? 'no conclusion' : job.status
    others.set(kind, [...others.get(kind) ?? [], job.name])
  }
  const parts = [`${passed} of ${wanted} Android repeats passed`, ...[...others].map(([kind, names]) => `${kind}: ${names.join(', ')}`)]
  const missing = wanted - legs.length
  if (missing > 0) parts.push(`${missing} never ran`)
  return { ok: passed === wanted && legs.length === wanted, passed, summary: parts.join('; ') }
}

if (import.meta.main) {
  const [file, wanted] = process.argv.slice(2)
  if (!file || !wanted) throw new Error('usage: repeat-verdict.ts <jobs.json> <wanted>')
  const { jobs } = JSON.parse(readFileSync(file, 'utf8')) as { jobs: RepeatJob[] }
  const verdict = repeatVerdict(jobs, Number(wanted))
  console.log(verdict.ok ? verdict.summary : `::error::${verdict.summary}`)
  process.exitCode = verdict.ok ? 0 : 1
}
