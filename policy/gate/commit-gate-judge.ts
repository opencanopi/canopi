// policy/gate/commit-gate-judge.ts: the commit gate's rules on one commit's family changes and files (2.1-M195 to
// 2.1-M199, 2.1-M228, 2.1-M229, 2.1-Q224, 2.1-Q225, 2.1-Q242, 2.1-Q267; contracts §12), from files only, never gh, bd
// or the network (2.1-M197). commit-gate.ts reads the commit and calls these; the deletion guard judges its tests.
//
//   - an added or raised ratchet entry, a raised or removed budget, a lowered or removed floor and its patterns, a
//     header change (but a widened scope or an earlier lane) and a deleted family need an open bead and a Q row present
//     in the ledger at the merge base, both named in the message (gate-loosening-authority); an M or E row authorises
//     nothing;
//   - a family's creating commit names its ledger id, E and M rows included (gate-first-baseline);
//   - lowered, removed and renamed entries are free, but in guarded-files, where removing or renaming an entry needs a
//     Q row and adding one is free only with the file it guards, created in the same commit;
//   - a flake-quarantine entry added or raised needs only its own open bead with an assignee or owner (2.1-Q242);
//   - a guarded file changed, deleted or renamed needs a merge-base Q row; policy/ratchets/coverage.json also an open
//     bead and both numbers: a floor's old and new value, or for an exclusion change two measured values, counted as
//     values, so one value measured twice counts twice (gate-guarded-file);
//   - a decision ledger cell or test title newly citing a bead no committed export of the change holds: a typo, or an
//     export older than the citation (gate-absent-bead); a bead some ledger cell or test title of the first parent
//     already cites is history, never re-read, wherever the citation moves; with no committed export it is skipped;
//   - an inventory row demoted to advice or process or deleted outright, and a rules.json or primitives.json row dropped
//     or made planned, need a merge-base Q row (gate-inventory-demotion).
import { BEADS_FILE, exportRecords, textBeads } from '../beads.mjs'
import { RefusalError } from '../core/base.mjs'
import { LANES } from '../selection.mjs'
import type { Change } from './deletion-guard.ts'
import type { Finding } from './test-reader.ts'
import { ledgerIds, ledgerRows, Q_ROW } from './ledger.ts'

export const RATCHETS = 'policy/ratchets'
export const GUARDED = `${RATCHETS}/guarded-files.json`
export const COVERAGE = `${RATCHETS}/coverage.json`
export const FLAKES = 'flake-quarantine'
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

/** Beads and Q rows the messages may cite, from committed files only (2.1-M197). */
export class Authority {
  private readonly parsed = new Map<string, Map<string, Json>>()

  /**
   * mergeBase: the merge base whose ledger holds the Q rows; sources: the blob ids of the .beads/issues.jsonl
   * versions to read (each parsed once, when a bead is first asked for; a malformed line is refused as `unreadable`
   * naming it, never skipped); blob: reads one.
   */
  constructor(mergeBase: string, qRows: ReadonlySet<string>, sources: readonly string[], blob: (id: string) => Promise<string>) {
    this.mergeBase = mergeBase
    this.qRows = qRows
    this.sources = sources
    this.blob = blob
  }

  readonly mergeBase: string
  readonly qRows: ReadonlySet<string>
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

  citesQ(message: string): boolean {
    return ledgerIds(message).some((id) => this.qRows.has(id))
  }

  /** Undefined when the message names an open bead (when needed) and a merge-base Q row, else what is missing. */
  async whyNot(message: string, bead = true): Promise<string | undefined> {
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
    if (!this.citesQ(message)) {
      missing.push(`a Q row on the merge base ${this.mergeBase.slice(0, 9)} (named: ${ids.join(', ') || 'none'}; an E or M row, `
        + 'or a Q row added on the branch, authorises nothing)')
    }
    return missing.length ? missing.join(' and ') : undefined
  }
}

/** The Q rows of every ledger in `texts` (docs/decisions/*.md at the merge base). */
export function qRowsOf(texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap((text) => [...ledgerRows(text).keys()].filter((id) => Q_ROW.test(id))))
}

type Shape = 'budget' | 'floor' | 'ratchet'
const shape = (doc: Json): Shape => ('budgets' in doc ? 'budget' : 'floors' in doc ? 'floor' : 'ratchet')
const LOOSENING: Record<Shape, readonly string[]> = {
  ratchet: ['added', 'raised', 'deleted'],
  budget: ['raised', 'removed', 'deleted'],
  floor: ['lowered', 'removed', 'floor-globs', 'deleted'],
}

/** A widened scope or an earlier lane, and nothing else, loosens nothing. */
function headerFree(base: Json, head: Json, fields: readonly string[]): boolean {
  if (!fields.every((field) => field === 'scope' || field === 'lane')) return false
  const list = (doc: Json) => (Array.isArray(doc['scope']) ? doc['scope'] as unknown[] : []).map(String)
  const widened = list(base).every((glob) => list(head).includes(glob))
  const lane = (doc: Json) => LANES.indexOf(typeof doc['lane'] === 'string' ? doc['lane'] : 'ci')
  return widened && lane(head) <= lane(base)
}

/** The numbers a message names, ledger ids and beads aside, each as often as it is named (DR2). */
export function numbers(message: string): number[] {
  const text = message.replace(BEAD, ' ').replace(/(?<![\p{L}\p{N}_])\p{Nd}+\.\p{Nd}+-[EMQ]\p{Nd}+[a-z]?(?![\p{L}\p{N}_])/gu, ' ')
  return [...text.matchAll(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?![\p{L}\p{N}_.])/gu)].map((match) => Number(match[0]))
}

/** Python's '%g' for the numbers a coverage refusal names. */
const general = (value: number) => String(Number(value.toPrecision(6)))

export async function judgeFamilies(parent: string, tree: string, message: string, auth: Authority,
  changes: readonly FamilyChange[], files: readonly Change[], load: LoadJson): Promise<Finding[]> {
  const findings: Finding[] = []
  const created = new Set(files.filter(([status]) => status === 'A').map(([, , path]) => path))
  for (const change of changes) {
    const { family, change: kind, key } = change
    const file = `${RATCHETS}/${family}.json`
    const at = await load(tree, file)
    const before = await load(parent, file)
    const doc = isObject(at) && Object.keys(at).length ? at : isObject(before) && Object.keys(before).length ? before : {}
    const baseDoc = isObject(before) ? before : {}
    const what = `${family}: ${kind}${key ? ` ${key}` : ''}`
    if (kind === 'created') {
      if (!ledgerIds(message).includes(String(doc['ledger']))) {
        findings.push(['gate-first-baseline', `${what}: the creating commit names the family's ledger id ${pyStr(doc['ledger'])}`])
      }
      continue
    }
    if (file === GUARDED) {
      if (!(kind === 'added' && key !== undefined && created.has(key)) && !auth.citesQ(message)) {
        findings.push(['gate-guarded-file', `${what} needs a Q row on the merge base, or for an added entry `
          + 'the file it guards created in the same commit (2.1-Q225, 2.1-M229)'])
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
    const why = await auth.whyNot(message, old === COVERAGE)
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
  if (auth.citesQ(message)) return []
  const findings: Finding[] = []
  if (paths.has(INVENTORY)) {
    const now = new Map(rows(await load(tree, INVENTORY)).map((row) => [String(row['id']), row]))
    for (const row of rows(await load(parent, INVENTORY))) {
      const was = state(row)
      if (was !== 'exists' && was !== 'planned') continue
      const after = now.get(String(row['id']))
      if (!after) {
        findings.push(['gate-inventory-demotion', `${INVENTORY}: ${pyStr(row['id'])} is deleted from ${was} without a merge-base `
          + 'Q row (ctr §12, design check A23)'])
      } else if (state(after) === 'advice' || state(after) === 'process') {
        findings.push(['gate-inventory-demotion', `${INVENTORY}: ${pyStr(row['id'])} moves from ${was} to `
          + `${state(after)} without a merge-base Q row (ctr §12)`])
      }
    }
  }
  for (const table of TABLES.filter((t) => paths.has(t))) {
    const now = new Map(rows(await load(tree, table)).map((row) => [String(row['id']), row]))
    for (const row of rows(await load(parent, table))) {
      const after = now.get(String(row['id']))
      if (row['status'] !== 'planned' && (after === undefined || after['status'] === 'planned')) {
        findings.push(['gate-inventory-demotion', `${table}: rule ${pyStr(row['id'])} is `
          + `${after === undefined ? 'dropped' : 'made planned'} without a merge-base Q row (2.1-M229)`])
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
