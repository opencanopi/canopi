import type { AnalysisGroup } from '../../generated/analysis-registry'
import type {
  AnalysisOffer,
  AnalysisRunStatus,
  Freshness,
  LibraryItemKind,
  LibraryItemRole,
  LibraryItemType,
  LibrarySnapshot,
  LidarImportJob,
  LidarResultState,
  Provenance,
} from '../../generated/contracts'
import { analysisGroup } from '../analyses/registry'
import { itemDisplayRange, libraryItemName } from './library-store'
import { filterKeepingAncestors, treeRows } from './reference-tree'

/**
 * One reusable Data Library item: an imported source or a derived result.
 *
 * Both come from the library snapshot, which remains the only authority; this
 * is a read model for the dock, and search, filter and order are session view
 * state, never Design data.
 */
export interface LibraryItem {
  readonly role: LibraryItemRole
  readonly id: string
  readonly name: string
  readonly itemType: LibraryItemType
  /** `needs-newer`: listed by a newer catalogue, by name and type only, never drawn or changed (2.1-Q318). */
  readonly status: 'ready' | 'preparing' | 'failed' | 'needs-newer'
  /** The type a `needs-newer` item is listed by; null when this Canopi does not know it, and for any other item. */
  readonly newerKind: LibraryItemKind | null
  readonly generationId: string | null
  readonly units: string
  readonly resolutionM: number | null
  readonly bounds: readonly [number, number, number, number] | null
  readonly displayRange: readonly [number, number] | null
  /** The import operation of an unpublished source. */
  readonly importJob: LidarImportJob | null
  /** What produced a derived item; null for a source. */
  readonly provenance: Provenance | null
  readonly freshness: Freshness
  /** The latest run of a derived item: first calculation, retry or refresh. */
  readonly run: AnalysisRunStatus | null
  readonly offers: readonly AnalysisOffer[]
  /** Derived items calculated from this one. */
  readonly dependents: number
  /** The item a derived row nests under: its first input. */
  readonly parentId: string | null
  /** The registry group of the analysis that produced a derived item. */
  readonly group: AnalysisGroup | null
  /** Nesting depth in the list: 0 for a top-level row. */
  readonly depth: number
  /** When the item entered the library (epoch milliseconds as a string). */
  readonly createdAt: string
}

/** All, sources, or the derived items of one registry group. */
export type LibraryTypeFilter = 'all' | 'sources' | AnalysisGroup

/** The Data library's sort: by name, or most recently added first. */
export type LibrarySort = 'name' | 'recent'

type Unnested = Omit<LibraryItem, 'depth'>

const STATUS: Record<LidarResultState, LibraryItem['status']> = {
  Ready: 'ready',
  Preparing: 'preparing',
  Failed: 'failed',
  NeedsNewer: 'needs-newer',
}

/** Stable name order, identity as the tie-breaker: names are not unique. */
function byName(left: Unnested, right: Unnested): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id)
}

function byRecent(left: Unnested, right: Unnested): number {
  return Number(right.createdAt) - Number(left.createdAt) || byName(left, right)
}

/**
 * Library items in list order: top-level rows in `sort` order, each followed
 * by the derived items calculated from it, nested under their first input and
 * sorted the same way among themselves.
 */
export function libraryItems(snapshot: LibrarySnapshot | null, sort: LibrarySort = 'name'): LibraryItem[] {
  if (!snapshot) return []
  const items = snapshot.items.map((summary): Unnested => {
    const job = summary.import_job ?? null
    const published = summary.generation_id !== null
    return {
      role: summary.role,
      id: summary.id,
      name: libraryItemName(summary, snapshot),
      itemType: summary.item_type,
      status: STATUS[summary.state],
      newerKind: summary.state === 'NeedsNewer' ? summary.newer_kind ?? null : null,
      generationId: summary.generation_id ?? null,
      units: summary.units,
      resolutionM: summary.resolution_m ?? null,
      bounds: summary.bounds ?? null,
      displayRange: itemDisplayRange(summary),
      importJob: published ? null : job,
      provenance: summary.provenance,
      freshness: summary.freshness,
      run: summary.run,
      offers: summary.offers,
      dependents: summary.dependents,
      parentId: summary.provenance?.inputs[0]?.item_id ?? null,
      group: summary.provenance ? analysisGroup(summary.provenance.analysis_id) : null,
      createdAt: summary.created_at,
    }
  })
  return treeRows(items, sort === 'recent' ? byRecent : byName)
}

/**
 * Items matching a name search and type filter, each with the sources it was
 * calculated from above it (GeoLibre's browser tree filter). Operations in
 * progress or failed stay listed whatever the filter, so an import or
 * calculation started here is never hidden before it settles; a newer
 * Canopi's item is settled and filters like a ready one.
 */
export function filterLibraryItems(items: readonly LibraryItem[], query: string, type: LibraryTypeFilter): LibraryItem[] {
  const needle = query.trim().toLocaleLowerCase()
  return filterKeepingAncestors(items, (item) => {
    if (item.status === 'preparing' || item.status === 'failed') return true
    if (type === 'sources' && item.role !== 'Source') return false
    if (type !== 'all' && type !== 'sources' && item.group !== type) return false
    return needle === '' || item.name.toLocaleLowerCase().includes(needle)
  })
}

/**
 * The row selected once the list changes: the same item while it is listed;
 * else the row that took its place (the next one, or the last row when it was
 * last); else the first row. Null for an empty list.
 */
export function selectionAfter(
  before: readonly { readonly id: string }[],
  after: readonly { readonly id: string }[],
  selectedId: string | null,
): string | null {
  if (selectedId !== null && after.some((row) => row.id === selectedId)) return selectedId
  const index = selectedId === null ? -1 : before.findIndex((row) => row.id === selectedId)
  if (index < 0) return after[0]?.id ?? null
  const remaining = new Set(after.map((row) => row.id))
  const next = before.slice(index + 1).find((row) => remaining.has(row.id))
    ?? before.slice(0, index).reverse().find((row) => remaining.has(row.id))
  return next?.id ?? after[0]?.id ?? null
}

/** A default item name from the chosen files: their shared stem, or the first. */
export function suggestedItemName(paths: readonly string[]): string {
  const names = paths.map((path) => (path.split(/[\\/]/).pop() ?? path).replace(/\.(tiff?|asc|img|vrt)$/i, ''))
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  let prefix = names[0]!
  for (const name of names.slice(1)) {
    while (prefix && !name.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  const trimmed = prefix.replace(/[\s_\-.]+$/, '')
  return trimmed.length >= 3 ? trimmed : names[0]!
}

/**
 * The names library items use, trimmed and lower-cased: the set Import and
 * Rename check a new name against. `exceptId` leaves out the item being
 * renamed, so changing only the case of its own name is allowed.
 */
export function takenItemNames(library: LibrarySnapshot | null, exceptId?: string): Set<string> {
  return new Set((library?.items ?? [])
    .filter((item) => item.id !== exceptId)
    .map((item) => libraryItemName(item, library).trim().toLocaleLowerCase()))
}

/**
 * A name no library item uses yet, from `name`: "Terrain (2)", "Terrain (3)"…
 * `taken` holds used names trimmed and lower-cased. Import refuses a used
 * name so two items are never told apart by name alone.
 */
export function uniqueItemName(name: string, taken: ReadonlySet<string>): string {
  const base = name.trim().replace(/\s*\(\d+\)$/, '')
  for (let number = 2; ; number += 1) {
    const candidate = `${base} (${number})`
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate
  }
}
