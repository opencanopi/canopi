// policy/gate/families.ts: which policy families a change selects (2.1-Q267; design check A12), read from
// policy/ratchets/ with the repository's one glob engine (picomatch from desktop/web, 2.1-M348) and its options. The
// affected lane observes the commit-lane families whose scope a changed path matches; the commit lane runs the planted
// violations of each commit-lane family whose ratchet file, planted directory (policy/fixtures/rules/<id>/) or adapter
// (policy/adapters/<tool>.mjs) changed. A family file the gate cannot read is refused, never read as selecting nothing.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { GateError } from './gate-error.ts'
import { WEB } from './table.ts'

type Matcher = (path: string) => boolean
type GlobEngine = (glob: string, options: { dot: boolean, posix: boolean }) => Matcher

/** The `ids` whose ratchet scope a path matches; with no glob engine installed, none and a note naming them. */
export function reachedFamilies(root: string, paths: readonly string[], ids: readonly string[]): { ids: string[], note?: string } {
  let engine: GlobEngine
  try {
    engine = createRequire(join(root, WEB, 'package.json'))('picomatch') as GlobEngine
  } catch {
    return { ids: [], note: `${WEB}/node_modules/picomatch is missing (run npm ci in ${WEB}): ${ids.join(', ')} run at the affected gate` }
  }
  return { ids: ids.filter((id) => {
    const file = `policy/ratchets/${id}.json`
    let scope: unknown
    try {
      scope = (JSON.parse(readFileSync(join(root, file), 'utf8')) as { scope?: unknown }).scope
    } catch {
      scope = undefined
    }
    if (!Array.isArray(scope)) throw new GateError(`${file} is missing or names no scope: the gate refuses rather than select too little`)
    const scoped = (scope as string[]).map((glob) => engine(glob, { dot: true, posix: true }))
    return paths.some((path) => scoped.some((match) => match(path)))
  }) }
}

/** The families of policy/ratchets/ with their lane (commit when absent) and tool, sorted by id. */
function ratchetFamilies(root: string): { id: string, lane: unknown, tool: unknown }[] {
  const dir = join(root, 'policy/ratchets')
  return readdirSync(dir).filter((name) => name.endsWith('.json') && !name.endsWith('.schema.json')).flatMap((name) => {
    let doc: { family?: unknown, lane?: unknown, tool?: unknown }
    try {
      doc = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { family?: unknown, lane?: unknown, tool?: unknown }
    } catch {
      throw new GateError(`policy/ratchets/${name} is unreadable: the gate refuses rather than select too little`)
    }
    return typeof doc.family === 'string' ? [{ id: doc.family, lane: doc.lane ?? 'commit', tool: doc.tool }] : []
  }).sort((a, b) => a.id.localeCompare(b.id))
}

/** The commit-lane families, by id. */
export const commitLaneFamilies = (root: string): string[] => ratchetFamilies(root).filter((f) => f.lane === 'commit').map((f) => f.id)

/** Each commit-lane family whose ratchet file, planted directory or adapter is one of `paths`. */
export function touchedFamilies(root: string, paths: readonly string[]): string[] {
  const touched = (family: { id: string, tool: unknown }) => paths.some((path) => path === `policy/ratchets/${family.id}.json`
    || path.startsWith(`policy/fixtures/rules/${family.id}/`) || path === `policy/adapters/${String(family.tool)}.mjs`)
  return ratchetFamilies(root).filter((family) => family.lane === 'commit' && touched(family)).map((family) => family.id)
}
