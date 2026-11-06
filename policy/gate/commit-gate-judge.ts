// policy/gate/commit-gate-judge.ts: the commit gate's rules on one commit's family changes and files (2.1-M195 to
// 2.1-M199, 2.1-M228, 2.1-M229, 2.1-Q224, 2.1-Q225, 2.1-Q242, 2.1-Q267; contracts §12), from files only, never gh, bd
// or the network (2.1-M197). commit-gate.ts reads the commit and calls these; the deletion guard judges its tests.
//
//   - an added or raised ratchet entry, a raised or removed budget, a lowered or removed floor and its patterns, a
//     header change (but a widened scope or an earlier lane) and a deleted family need an open bead and a Q or M row
//     present in the ledger at the merge base, both named in the message (gate-loosening-authority); an E row, or a row
//     added on the branch, authorises nothing. An M row authorises an engineering loosening (2.1-Q272); a judge that
//     guards a user decision keeps a Q row: the capability grants (PRODUCT_GUARDED) and the test guard;
//   - a family's creating commit names its ledger id, E and M rows included (gate-first-baseline);
//   - lowered, removed and renamed entries are free, but in guarded-files, where removing or renaming an entry needs a
//     Q or M row (a Q row for a PRODUCT_GUARDED file) and adding one is free only with the file it guards, created in the
//     same commit;
//   - a flake-quarantine entry added or raised needs only its own open bead with an assignee or owner (2.1-Q242);
//   - a guarded file changed, deleted or renamed needs a merge-base Q or M row (a Q row for a PRODUCT_GUARDED file);
//     policy/ratchets/coverage.json also an open
//     bead and both numbers: a floor's old and new value, or for an exclusion change two measured values, counted as
//     values, so one value measured twice counts twice (gate-guarded-file);
//   - a decision ledger cell or test title newly citing a bead no committed export of the change holds: a typo, or an
//     export older than the citation (gate-absent-bead); a bead some ledger cell or test title of the first parent
//     already cites is history, never re-read, wherever the citation moves; with no committed export it is skipped;
//   - an exists or planned inventory row demoted to advice or deleted outright, and a rules.json or primitives.json row dropped
//     or made planned, need a merge-base Q or M row (gate-inventory-demotion);
//   - an added *.py file is refused: no new Python tooling (2.1-M349, under 2.1-Q261); a renamed one is no addition
//     (gate-python-added).
import { basename } from 'node:path'
import { BEADS_FILE, exportRecords, textBeads } from '../beads.mjs'
import { RefusalError } from '../core/base.mjs'
import { LANES } from '../selection.mjs'
import type { Change } from './deletion-guard.ts'
import { escapeRegExp, type Finding } from './test-reader.ts'
import { ledgerIds, ledgerRows, M_ROW, Q_ROW, splitLines } from './ledger.ts'

export const RATCHETS = 'policy/ratchets'
export const GUARDED = `${RATCHETS}/guarded-files.json`
export const COVERAGE = `${RATCHETS}/coverage.json`
export const FLAKES = 'flake-quarantine'
/** The guarded files holding product behaviour, whose change stays a user decision (a Q row, 2.1-Q272): the capability
 * grants, what Canopi may do on the user's machine. The coverage floors and the bundle budgets are engineering. */
const PRODUCT_GUARDED: ReadonlySet<string> = new Set(['desktop/capabilities/main-window.json'])
const TABLES = ['policy/rules.json', 'policy/primitives.json']
const INVENTORY = 'policy/inventory.json'
const CLOSED = new Set(['closed', 'tombstone'])
export const BEAD = /(?<![\p{L}\p{N}_])canopi-[a-z0-9]+(?:\.[0-9]+)*(?![\p{L}\p{N}_])/gu

/** A family change as policy/core/diff.mjs's diffRatchets names it. */
export interface FamilyChange {
  readonly family: string
  readonly change: string
  readonly key?: string
  readonly from?: unknown
  readonly to?: unknown
  readonly fields?: readonly string[]
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A JSON file's value at a revision, or undefined when absent or unparsable. */
export type LoadJson = (rev: string, path: string) => Promise<unknown>

/** Beads and the Q and M rows the messages may cite, from committed files only (2.1-M197). */
export class Authority {
  private readonly parsed = new Map<string, Map<string, Json>>()

  /**
   * mergeBase: the merge base whose ledger holds the rows (its Q and M ids); sources: the blob ids of the .beads/issues.jsonl
   * versions to read (each parsed once, when a bead is first asked for; a malformed line is refused as `unreadable`
   * naming it, never skipped); blob: reads one.
   */
  constructor(mergeBase: string, rows: ReadonlySet<string>, sources: readonly string[], blob: (id: string) => Promise<string>) {
    this.mergeBase = mergeBase
    this.rows = rows
    this.sources = sources
    this.blob = blob
  }

  readonly mergeBase: string
  readonly rows: ReadonlySet<string>
  private readonly sources: readonly string[]
  private readonly blob: (id: string) => Promise<string>

  private async records(id: string): Promise<Map<string, Json>> {
    let records = this.parsed.get(id)
    if (!records) {
      const read = exportRecords(await this.blob(id))
      const [bad] = read.refusals
      if (bad) throw new RefusalError(bad.code, `${bad.where} (blob ${id.slice(0, 9)})`, bad.message)
      records = read.records
      this.parsed.set(id, records)
    }
    return records
  }

  /** The bead's record, an open one if any version holds it open, else the first version holding it. */
  async bead(id: string): Promise<Json | undefined> {
    const found: Json[] = []
    for (const source of this.sources) {
      const record = (await this.records(source)).get(id)
      if (record) found.push(record)
    }
    return found.find((record) => !CLOSED.has(String(record['status']))) ?? found[0]
  }

  async beadOpen(id: string): Promise<boolean> {
    const record = await this.bead(id)
    return record !== undefined && !CLOSED.has(String(record['status']))
  }

  /** Whether any committed export is read: a planted repository has none, so no bead reads as absent. */
  get hasExport(): boolean {
    return this.sources.length > 0
  }

  async known(id: string): Promise<boolean> {
    return (await this.bead(id)) !== undefined
  }

  async owned(id: string): Promise<boolean> {
    const record = await this.bead(id)
    return record !== undefined && !CLOSED.has(String(record['status'])) && Boolean(record['assignee'] || record['owner'])
  }

  /** Whether the message cites a merge-base Q row (a user decision), or with `engineering` a Q or M row. */
  cites(message: string, engineering: boolean): boolean {
    return ledgerIds(message).some((id) => this.rows.has(id) && (engineering || Q_ROW.test(id)))
  }

  citesQ(message: string): boolean {
    return this.cites(message, false)
  }

  /**
   * Undefined when the message names an open bead (when needed) and a merge-base row: a Q or M row for an engineering
   * loosening (`engineering`), a Q row for product behaviour; else what is missing.
   */
  async whyNot(message: string, bead = true, engineering = true): Promise<string | undefined> {
    const ids = ledgerIds(message)
    const beads = [...message.matchAll(BEAD)].map((match) => match[0])
    const missing: string[] = []
    let open = false
    for (const id of beads) if (await this.beadOpen(id)) open = true
    if (bead && !open) {
      const named: string[] = []
      for (const id of beads) named.push(`${id} (${(await this.bead(id)) ? 'closed' : 'absent'})`)
      missing.push(`an open bead in a committed ${BEADS_FILE} of the change (named: ${named.join(', ') || 'none'})`)
    }
    if (!this.cites(message, engineering)) {
      missing.push(`a ${engineering ? 'Q or M' : 'Q'} row on the merge base ${this.mergeBase.slice(0, 9)} (named: ${ids.join(', ') || 'none'}; `
        + `${engineering ? 'an E row' : 'an E or M row'}, or a row added on the branch, authorises nothing)`)
    }
    return missing.length ? missing.join(' and ') : undefined
  }
}

/** git's empty tree: the parent of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface RangeCommit {
  readonly rev: string
  readonly parents: readonly string[]
  readonly message: string
}

/**
 * Whether a merge-base Q row routes the lost or loosened tests of a file (its base path, or its head path after a
 * rename): a commit of the range that touched the file cites one (a merge touches only what differs from every parent), or a PR body line citing one names the file by path
 * or by a base name no other changed file of the range shares. A Q row cited elsewhere, for another reason, routes
 * nothing (2.1-Q272).
 */
export function qRoute(changed: (from: string, to: string) => readonly Change[], mergeBase: string, head: string,
  commits: readonly RangeCommit[], body: string | undefined, auth: Authority): (path: string) => boolean {
  const cited = new Set<string>()
  for (const { rev, parents, message } of commits) {
    if (!auth.citesQ(message)) continue
    // A merge touched only what differs from every parent (--cc, as the commit gate judges it), never what it brings in.
    const [first = EMPTY_TREE, ...others] = parents
    const touched = others.map((other) => new Set(changed(other, rev).flatMap(([, old, now]) => [old, now])))
    for (const [, old, now] of changed(first, rev)) {
      if (touched.every((set) => set.has(old) || set.has(now))) cited.add(old).add(now)
    }
  }
  const net = changed(mergeBase, head)
  const renamed = new Map(net.map(([, old, now]) => [old, now]))
  const lines = splitLines(body ?? '').filter((line) => auth.citesQ(line))
  // A base name stands for its file only when no other changed file of the range shares it.
  const sharing = (name: string) => net.filter(([, old, now]) => basename(old) === name || basename(now) === name).length
  const names = (line: string, path: string) => line.includes(path) || (sharing(basename(path)) === 1
    && new RegExp(`(?<![\\w.-])${escapeRegExp(basename(path))}(?![\\w-])`, 'u').test(line))
  return (path) => [path, renamed.get(path) ?? path].some((p) => cited.has(p) || lines.some((line) => names(line, p)))
}

/** The Q and M rows of every ledger in `texts` (docs/decisions/*.md at the merge base). */
export function rowsOf(texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap((text) => [...ledgerRows(text).keys()].filter((id) => Q_ROW.test(id) || M_ROW.test(id))))
}

type Shape = 'budget' | 'floor' | 'ratchet'
const shape = (doc: Json): Shape => ('budgets' in doc ? 'budget' : 'floors' in doc ? 'floor' : 'ratchet')
const LOOSENING: Record<Shape, readonly string[]> = {
  ratchet: ['added', 'raised', 'deleted'],
  budget: ['raised', 'removed', 'deleted'],
  floor: ['lowered', 'removed', 'floor-globs', 'deleted'],
}

/** A widened scope, an earlier lane or ceilings turned off (counts that must shrink again), and nothing else, loosens
 * nothing. */
function headerFree(base: Json, head: Json, fields: readonly string[]): boolean {
  if (!fields.every((field) => field === 'scope' || field === 'lane' || field === 'ceilings')) return false
  const list = (doc: Json) => (Array.isArray(doc['scope']) ? doc['scope'] as unknown[] : []).map(String)
  const widened = list(base).every((glob) => list(head).includes(glob))
  const lane = (doc: Json) => LANES.indexOf(typeof doc['lane'] === 'string' ? doc['lane'] : 'ci')
  return widened && lane(head) <= lane(base) && (head['ceilings'] !== true || base['ceilings'] === true)
}

/** The numbers a message names, ledger ids and beads aside, each as often as it is named (DR2). */
export function numbers(message: string): number[] {
  const text = message.replace(BEAD, ' ').replace(/(?<![\p{L}\p{N}_])\p{Nd}+\.\p{Nd}+-[EMQ]\p{Nd}+[a-z]?(?![\p{L}\p{N}_])/gu, ' ')
  return [...text.matchAll(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?![\p{L}\p{N}_.])/gu)].map((match) => Number(match[0]))
}

/** Python's '%g' for the numbers a coverage refusal names. */
const general = (value: number) => String(Number(value.toPrecision(6)))

/**
 * gate-first-baseline, judged on each commit: the commit creating a family names the ledger id it carries there, so a
 * later commit may re-point the family to another row (a Q row until main writes the M row).
 */
export async function judgeFirstBaseline(tree: string, message: string, changes: readonly FamilyChange[],
  load: LoadJson): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const { family, change: kind } of changes) {
    if (kind !== 'created') continue
    const doc = await load(tree, `${RATCHETS}/${family}.json`)
    const ledger = isObject(doc) ? doc['ledger'] : undefined
    if (!ledgerIds(message).includes(String(ledger))) {
      findings.push(['gate-first-baseline', `${family}: ${kind}: the creating commit names the family's ledger id ${pyStr(ledger)}`])
    }
  }
  return findings
}

/** The loosening judges of a change's family changes; a created family is judgeFirstBaseline's, on each commit. */
export async function judgeFamilies(parent: string, tree: string, message: string, auth: Authority,
  changes: readonly FamilyChange[], files: readonly Change[], load: LoadJson): Promise<Finding[]> {
  const findings: Finding[] = []
  const created = new Set(files.filter(([status]) => status === 'A').map(([, , path]) => path))
  for (const change of changes) {
    const { family, change: kind, key } = change
    if (kind === 'created') continue
    const file = `${RATCHETS}/${family}.json`
    const at = await load(tree, file)
    const before = await load(parent, file)
    const doc = isObject(at) && Object.keys(at).length ? at : isObject(before) && Object.keys(before).length ? before : {}
    const baseDoc = isObject(before) ? before : {}
    const what = `${family}: ${kind}${key ? ` ${key}` : ''}`
    if (file === GUARDED) {
      const engineering = key === undefined || !PRODUCT_GUARDED.has(key)
      if (!(kind === 'added' && key !== undefined && created.has(key)) && !auth.cites(message, engineering)) {
        findings.push(['gate-guarded-file', `${what} needs a ${engineering ? 'Q or M' : 'Q'} row on the merge base, or for an `
          + 'added entry the file it guards created in the same commit (2.1-Q225, 2.1-M229, 2.1-Q272)'])
      }
      continue
    }
    if (family === FLAKES && (kind === 'added' || kind === 'raised')) {
      const entries = isObject(doc['entries']) ? doc['entries'] : {}
      const entry = key !== undefined && isObject(entries[key]) ? entries[key] : {}
      const bead = typeof entry['bead'] === 'string' && entry['bead'] ? entry['bead'] : undefined
      if (!(bead && await auth.owned(bead))) {
        findings.push(['gate-loosening-authority', `${what} needs its own open bead with an assignee or owner `
          + `(entry bead: ${bead ?? 'none'}; 2.1-Q242)`])
      }
      continue
    }
    if ((kind === 'header' && !headerFree(baseDoc, doc, change.fields ?? [])) || LOOSENING[shape(doc)].includes(kind)) {
      const why = await auth.whyNot(message)
      if (why) findings.push(['gate-loosening-authority', `${what} needs ${why}`])
    }
  }
  return findings
}

export async function judgeGuarded(parent: string, message: string, auth: Authority, changes: readonly FamilyChange[],
  files: readonly Change[], load: LoadJson): Promise<Finding[]> {
  const doc = await load(parent, GUARDED)
  const guarded = isObject(doc) && isObject(doc['entries']) ? doc['entries'] : {}
  const findings: Finding[] = []
  for (const [status, old, now] of files) {
    if (!(old in guarded)) continue
    const what = `${old} (${status === 'D' ? 'deleted' : old !== now ? `renamed to ${now}` : 'changed'})`
    const why = await auth.whyNot(message, old === COVERAGE, !PRODUCT_GUARDED.has(old))
    if (why) {
      findings.push(['gate-guarded-file', `${what}: a guarded file needs ${why} (2.1-Q225)`])
      continue
    }
    if (old === COVERAGE) {
      const moved = changes.filter((c) => c.family === 'coverage' && (c.change === 'raised' || c.change === 'lowered'))
      const needed = moved.flatMap((c) => [Number(c.from), Number(c.to)])
      const have = numbers(message)
      if (needed.some((value) => !have.includes(value)) || (!moved.length && have.length < 2)) {
        const need = moved.length ? needed.map(general).join(', ') : 'the measured value before and after'
        findings.push(['gate-guarded-file', `${what}: the message names both numbers (${need}; ADR 0028 Coverage)`])
      }
    }
  }
  return findings
}

/**
 * gate-absent-bead: each bead a changed ledger or test file cites (policy/beads.mjs textBeads) that no committed export
 * of the change holds, unless `history` holds it: the beads of `asked` some ledger cell or test title of the first
 * parent already cites, so a citation moved, split or copied into another file is not judged again. `contents` holds
 * each changed citing file's path and text. Skipped with no committed export.
 */
export async function judgeCitations(contents: readonly (readonly [string, string])[], auth: Authority,
  history: (asked: readonly string[]) => Promise<ReadonlySet<string>>): Promise<Finding[]> {
  if (!auth.hasExport) return []
  const absent: [string, string, string][] = []
  for (const [path, is] of contents) {
    for (const { bead, at } of textBeads(path, is) as { bead: string, at: string }[]) {
      if (!absent.some(([p, b]) => p === path && b === bead) && !await auth.known(bead)) absent.push([path, bead, at])
    }
  }
  const held = absent.length ? await history([...new Set(absent.map(([, bead]) => bead))]) : new Set<string>()
  return absent.filter(([, bead]) => !held.has(bead)).map(([path, bead, at]): Finding => ['gate-absent-bead',
    `${path}: ${bead} (${at}) is in no committed ${BEADS_FILE} of the change; cite a bead the tracker holds (bd export `
    + 'after bd create), or write a crate or other name in a code span'])
}

/** A row's state: its string, or its object's first key. */
function state(row: Json): string | undefined {
  const value = row['state']
  if (typeof value === 'string') return value
  return isObject(value) ? Object.keys(value)[0] : undefined
}

/** A table's rows with ids: the list itself, the `key` list, or the first list it holds. */
function rows(doc: unknown, key = 'rules'): Json[] {
  let found: unknown = doc
  if (isObject(doc)) found = doc[key] ?? Object.values(doc).find((value) => Array.isArray(value)) ?? []
  return (Array.isArray(found) ? found : []).filter((row): row is Json => isObject(row) && 'id' in row)
}

export async function judgeDemotions(parent: string, tree: string, message: string, auth: Authority,
  paths: ReadonlySet<string>, load: LoadJson): Promise<Finding[]> {
  if (auth.cites(message, true)) return []
  const findings: Finding[] = []
  if (paths.has(INVENTORY)) {
    const now = new Map(rows(await load(tree, INVENTORY)).map((row) => [String(row['id']), row]))
    for (const row of rows(await load(parent, INVENTORY))) {
      const was = state(row)
      if (was !== 'exists' && was !== 'planned') continue
      const after = now.get(String(row['id']))
      if (!after) {
        findings.push(['gate-inventory-demotion', `${INVENTORY}: ${pyStr(row['id'])} is deleted from ${was} without a merge-base `
          + 'Q or M row (ctr §12, design check A23)'])
      } else if (state(after) === 'advice') {
        findings.push(['gate-inventory-demotion', `${INVENTORY}: ${pyStr(row['id'])} moves from ${was} to `
          + `${state(after)} without a merge-base Q or M row (ctr §12)`])
      }
    }
  }
  for (const table of TABLES.filter((t) => paths.has(t))) {
    const now = new Map(rows(await load(tree, table)).map((row) => [String(row['id']), row]))
    for (const row of rows(await load(parent, table))) {
      const after = now.get(String(row['id']))
      if (row['status'] !== 'planned' && (after === undefined || after['status'] === 'planned')) {
        findings.push(['gate-inventory-demotion', `${table}: rule ${pyStr(row['id'])} is `
          + `${after === undefined ? 'dropped' : 'made planned'} without a merge-base Q or M row (2.1-M229)`])
      }
    }
  }
  return findings
}

/** A JSON value as Python's f-string shows it (None for a missing one). */
function pyStr(value: unknown): string {
  if (value === undefined || value === null) return 'None'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** gate-python-added: each *.py file the commit adds; git -M reads a renamed one as a rename, never an addition. */
export const judgeAddedPython = (files: readonly Change[]): Finding[] => files
  .filter(([status, , now]) => status === 'A' && now.endsWith('.py'))
  .map(([, , now]): Finding => ['gate-python-added', `${now} adds a Python file: new tooling is TypeScript under policy/ or `
    + 'Rust beside canopi-types, and a Python tool a change would grow is ported (2.1-M349, 2.1-Q261)'])
