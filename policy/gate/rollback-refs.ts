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
// - The fixture checks (`node policy/gate/cli.mjs rollback-fixtures`), main's own judgement of the reader jobs around the
//   reader tree's harness (contracts §11 Rollback harness, 2.1-M484): `check` refuses a fixture directory missing its
//   manifest or a listed file (a missing artifact), `snapshot` and `compare` hash the file set and contents before and
//   after the readers, a created `-shm` or empty `-wal` being SQLite's engine metadata (contracts §11 Degraded stores),
//   and `plant` makes one frozen fixture of an edition unreadable for the planted-change self-test.
// It and the modules main.ts loads before dispatching (table, plan, run, agents-rows and their imports) need only node:
// built-ins, picomatch being required lazily at planning only, so the step runs on a bare setup-node with no npm ci.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

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

/**
 * A fixture directory's files, each relative path (forward slashes) to its SHA-256, and its folders, each `path/` to
 * `directory`, so a folder a reader lays down is a write too; engine metadata left out.
 */
export type FixtureSnapshot = Readonly<Record<string, string>>

/** A manifest row, as far as main's lane reads it: the reader's own tests read the rest. */
interface ManifestForm { readonly store: string, readonly edition: string, readonly path: string }

/** SQLite's engine metadata a read-only open may create: a `-shm` file, or a `-wal` holding no page. */
const engineMetadata = (name: string, bytes: number) => name.endsWith('-shm') || (name.endsWith('-wal') && bytes === 0)

/** Every file under `root` but engine metadata, by relative path, with its SHA-256, and every folder under it. */
export function snapshotFixtures(root: string): FixtureSnapshot {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        out[`${relative(root, path).split(sep).join('/')}/`] = 'directory'
        walk(path)
        continue
      }
      if (engineMetadata(entry.name, statSync(path).size)) continue
      out[relative(root, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(root)
  return out
}

/** Each way `after` differs from `before`: a file changed, pruned or created; none when the readers wrote no byte. */
export function fixtureChanges(before: FixtureSnapshot, after: FixtureSnapshot): string[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return paths.flatMap((path) => {
    if (!(path in after)) return [`${path} was pruned`]
    if (!(path in before)) return [`${path} was created`]
    return before[path] === after[path] ? [] : [`${path} changed`]
  })
}

/** The manifest's rows at `root`, or the reason they cannot be read. */
function manifestForms(root: string): ManifestForm[] | string {
  const file = join(root, 'manifest.json')
  if (!existsSync(file)) return `${file} is missing: the fixture directory holds the writer's manifest.json`
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { forms?: unknown }
    if (!Array.isArray(manifest.forms) || manifest.forms.length === 0) return `${file} lists no forms`
    return manifest.forms as ManifestForm[]
  } catch (error) {
    return `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Why the fixture directory at `root` cannot be read: its manifest missing or empty, or a listed file absent. */
export function fixtureFaults(root: string): string[] {
  if (!existsSync(root)) return [`the fixture directory ${root} is missing: the writer job's artifact was not downloaded`]
  const forms = manifestForms(root)
  if (typeof forms === 'string') return [forms]
  return forms.filter((form) => typeof form.path !== 'string' || !existsSync(join(root, form.path)))
    .map((form) => `the ${form.edition} ${form.store} form ${String(form.path)} is missing from ${root}`)
}

const PLANTED = 'planted: a change the readers cannot read, so their run must fail'

/**
 * The store each edition's change is planted in: one the reader release reads (its harnesses' frozen DESKTOP_STORES in
 * desktop/tests/rollback_reader.rs and WEB_STORES in desktop/web/e2e-rollback/reader.spec.ts) and whose unreadable form
 * it refuses without writing. A damaged user DB or Web species list is set aside, a real write, so the plant never goes
 * there: on Desktop the Design file, which fails to open; on Web the settings record, left untouched while unavailable.
 */
const PLANTED_STORE: Readonly<Record<string, string>> = { desktop: 'canopi_file', web: 'settings' }

/**
 * Makes the first `edition` form at `root` of its planted store unreadable to the readers yet still seedable, so the
 * readers, not the harness, fail on it: a Web record dump (`{key, record}`) keeps its key and gets a record that is no
 * settings object; any other form's bytes are replaced. Returns its path.
 */
export function plantUnreadable(root: string, edition: string): string {
  const forms = manifestForms(root)
  if (typeof forms === 'string') throw new Error(forms)
  const store = PLANTED_STORE[edition]
  if (!store) throw new Error(`the manifest at ${root} lists no ${edition} form the reader release reads to plant a change in`)
  const form = forms.find((row) => row.edition === edition && row.store === store)
  if (!form) throw new Error(`the manifest at ${root} lists no ${edition} ${store} form to plant a change in`)
  const file = join(root, form.path)
  let dump: unknown
  try {
    dump = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    dump = undefined // a database or other binary form: its bytes are replaced below
  }
  const record = typeof dump === 'object' && dump !== null && 'record' in dump ? (dump as Record<string, unknown>) : null
  writeFileSync(file, record ? `${JSON.stringify({ ...record, record: PLANTED })}\n` : `${PLANTED}\n`)
  return form.path
}

/**
 * `node policy/gate/cli.mjs rollback-fixtures <mode> ...`'s exit code: `check <dir>`, `snapshot <dir> <out.json>`,
 * `compare <dir> <before.json>` or `plant <dir> <desktop|web>`. Each verdict goes to the log and the job summary.
 */
export function runRollbackFixtures(args: readonly string[], env: NodeJS.ProcessEnv): number {
  const say = (line: string, to: NodeJS.WriteStream = process.stdout) => {
    to.write(`${line}\n`)
    const summary = env['GITHUB_STEP_SUMMARY']
    if (summary) appendFileSync(summary, `${line}\n`)
  }
  const fail = (lines: readonly string[]) => {
    for (const line of lines) say(`ERROR: ${line}`, process.stderr)
    return 1
  }
  const [mode, dir = '', other = ''] = args
  try {
    if (mode === 'check' && args.length === 2) {
      const faults = fixtureFaults(dir)
      if (faults.length) return fail(faults)
      say(`Rollback fixtures: every form the manifest at ${dir} lists is there.`)
      return 0
    }
    if (mode === 'snapshot' && args.length === 3) {
      const snapshot = snapshotFixtures(dir)
      writeFileSync(other, `${JSON.stringify(snapshot, null, 2)}\n`)
      say(`Rollback fixtures: ${Object.values(snapshot).filter((hash) => hash !== 'directory').length} files hashed under ${dir}.`)
      return 0
    }
    if (mode === 'compare' && args.length === 3) {
      const changes = fixtureChanges(JSON.parse(readFileSync(other, 'utf8')) as FixtureSnapshot, snapshotFixtures(dir))
      if (changes.length) return fail(changes.map((change) => `the readers wrote: ${change}`))
      say(`Rollback fixtures: the readers wrote no byte under ${dir}.`)
      return 0
    }
    if (mode === 'plant' && args.length === 3) {
      say(`Rollback fixtures: planted an unreadable change in ${plantUnreadable(dir, other)}; the readers' run must fail.`)
      return 0
    }
  } catch (error) {
    return fail([error instanceof Error ? error.message : String(error)])
  }
  return fail(['usage: rollback-fixtures check <dir> | snapshot <dir> <out.json> | compare <dir> <before.json> | plant <dir> <desktop|web>'])
}
