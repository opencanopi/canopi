// policy/gate/rollback-refs.ts: which tree the rollback lane builds its readers from, and what they read (ADR 0026
// Checks; 2.1-M37, 2.1-M53, 2.1-M68; Step 2.0.4 R4, canopi-f47t.52.239). rollback.yml's resolve job runs it as
// `node policy/gate/cli.mjs rollback-refs`, the gate's entry holding the command line (2.1-M348).
// - Candidate mode: until the reader release is tagged (no stable tag above v2.0.3, the last 2.0.x before the readers,
//   2.1-M33), the readers build from the candidate and read the hand-made frozen fixtures only.
// - Tag mode: from then on they build from the latest stable tag and read what the candidate writes. Before 2.1.0 that
//   tag is the latest 2.0.x; from 2.1.0 on it is the previous stable minor's latest, since main then works on the next
//   minor and every stable tag below it is that minor's or older. A tag that fails to build is the lane's red: there is
//   no fallback to the candidate's tree.
// - Maintenance branch (release/<major>.<minor>, a pull request into it or a candidate from it): the readers build from
//   that candidate and read the frozen fixtures and what main, or the pending store step's branch (writer_ref), writes.
// It and the modules main.ts loads before dispatching (table, plan, run, agents-rows and their imports) need only node:
// built-ins, picomatch being required lazily at planning only, so the step runs on a bare setup-node with no npm ci.
import { appendFileSync } from 'node:fs'

/** The last 2.0.x before the readers (2.1-M33): the reader release is the first stable tag above it. */
export const LAST_BEFORE_READERS = 'v2.0.3'

export interface RollbackContext {
  /** Every tag name of the repository; only stable `vX.Y.Z` tags count. */
  readonly tags: readonly string[]
  /** The branch the run is for: a pull request's base, otherwise the pushed or dispatched branch. */
  readonly branch: string
  /** The commit under test. */
  readonly candidate: string
  /** A maintenance run's writer: main by default, or a pending store step's branch. Empty is unset. */
  readonly writerRef?: string
}

export interface RollbackRefs {
  readonly mode: 'candidate' | 'tag' | 'maintenance'
  /** The ref the readers build from. */
  readonly reader: string
  /** The ref whose output the readers read, or null for the frozen fixtures only. */
  readonly writer: string | null
  /** One sentence for the log and the job summary. */
  readonly log: string
}

type Version = readonly [number, number, number]
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAINTENANCE = /^release\/\d+\.\d+$/

const version = (tag: string): Version | undefined => {
  const match = STABLE.exec(tag)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** The refs the rollback lane builds and reads for `context`; throws naming what is missing or misplaced. */
export function resolveRollbackRefs(context: RollbackContext): RollbackRefs {
  const { branch, candidate } = context
  const writerRef = context.writerRef || undefined
  if (!candidate) throw new Error('The rollback refs have no candidate commit to build or read')
  if (!branch) throw new Error('The rollback refs have no branch: a pull request\'s base or the pushed or dispatched branch')
  if (MAINTENANCE.test(branch)) {
    const writer = writerRef ?? 'main'
    return { mode: 'maintenance', reader: candidate, writer, log: `Rollback refs: maintenance branch ${branch}. The readers build `
      + `from the candidate ${candidate} and read the frozen fixtures and what ${writer} writes.` }
  }
  if (writerRef) throw new Error(`writer_ref ${writerRef} applies to a maintenance branch run (release/<major>.<minor>), not to ${branch}`)
  const floor = version(LAST_BEFORE_READERS) as Version
  const latest = context.tags.flatMap((tag) => {
    const parsed = version(tag)
    return parsed && compare(parsed, floor) > 0 ? [{ tag, parsed }] : []
  }).sort((a, b) => compare(b.parsed, a.parsed))[0]
  if (!latest) {
    return { mode: 'candidate', reader: candidate, writer: null, log: `Rollback refs: candidate mode. No stable tag is above `
      + `${LAST_BEFORE_READERS}, the last 2.0.x before the readers, so the readers build from the candidate ${candidate} and read `
      + 'the frozen fixtures only.' }
  }
  return { mode: 'tag', reader: latest.tag, writer: candidate, log: `Rollback refs: tag mode. The readers build from ${latest.tag}, `
    + `the latest stable tag of ${latest.parsed[0]}.${latest.parsed[1]}, and read what the candidate ${candidate} writes.` }
}

/** The step's `$GITHUB_OUTPUT` lines: mode, reader and writer, an unwritten writer empty. */
export const outputLines = (refs: RollbackRefs) => `mode=${refs.mode}\nreader=${refs.reader}\nwriter=${refs.writer ?? ''}\n`

/**
 * `node policy/gate/cli.mjs rollback-refs`'s exit code: tag names in `stdin`, one per line; ROLLBACK_BRANCH,
 * ROLLBACK_CANDIDATE and ROLLBACK_WRITER_REF in `env`. Prints the log, appends it to the job summary and the refs to the
 * step outputs when Actions names them.
 */
export function runRollbackRefs(stdin: string, env: NodeJS.ProcessEnv): number {
  try {
    const refs = resolveRollbackRefs({ tags: stdin.split('\n').map((line) => line.trim()).filter(Boolean),
      branch: env['ROLLBACK_BRANCH'] ?? '', candidate: env['ROLLBACK_CANDIDATE'] ?? '', writerRef: env['ROLLBACK_WRITER_REF'] ?? '' })
    process.stdout.write(`${refs.log}\n`)
    const summary = env['GITHUB_STEP_SUMMARY']
    if (summary) appendFileSync(summary, `${refs.log}\n`)
    const output = env['GITHUB_OUTPUT']
    if (output) appendFileSync(output, outputLines(refs))
    return 0
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
