import { signal } from '@preact/signals'
import type {
  AnalysisRunStatus,
  Freshness,
  LibraryItemRole,
  LibraryItemSummary,
  LibraryItemType,
  LibrarySnapshot,
  LidarColourRange,
  LidarLibraryStatus,
  LidarPresentationEntry,
  LidarRamp,
  LidarResultState,
} from '../../generated/contracts'
import { lidarListLibrary } from '../../ipc/lidar'
import { derivedItemName } from '../analyses/registry'
import { currentDesign } from '../document-session/store'
import { lidarLibraryStatus } from '../health/state'
import { lidarFailureMessage } from './lidar-failures'
import { referenceDrawOrder } from './reference-tree'

const LIDAR_POLL_INTERVAL_MS = 1500

/** Library-side snapshot; null until the first successful read. */
export const lidarLibrary = signal<LibrarySnapshot | null>(null)
export const lidarStatusMessage = signal<string | null>(null)
/** Whether the latest list read failed; with no snapshot yet, the library is unopened rather than loading. */
const lidarLibraryReadFailed = signal(false)

let pollTimer: ReturnType<typeof setInterval> | null = null
let refreshInFlight: Promise<void> | null = null
/**
 * Monotonic read-start sequence: an older passive response cannot overwrite a
 * snapshot from a read that started later.
 */
let readStartSequence = 0
let publishedReadSequence = 0

/** A snapshot without its item list is refused as a failed read, never published. */
function assertLibrarySnapshot(value: unknown): asserts value is LibrarySnapshot {
  const snapshot = value as Partial<LibrarySnapshot> | null
  if (!snapshot || !Array.isArray(snapshot.items)) {
    throw new Error('The LiDAR library returned a malformed snapshot.')
  }
}

async function readLibrarySnapshot(startSequence: number): Promise<LibrarySnapshot> {
  const snapshot: unknown = await lidarListLibrary()
  assertLibrarySnapshot(snapshot)
  if (startSequence >= publishedReadSequence) {
    publishedReadSequence = startSequence
    lidarLibrary.value = snapshot
    lidarStatusMessage.value = null
    lidarLibraryReadFailed.value = false
  }
  return snapshot
}

/**
 * Refresh the library snapshot. Overlapping callers coalesce onto the read in
 * flight; a failed read keeps the previous snapshot (Web has no library) and
 * publishes the generic message, its reason going to diagnostics once per
 * streak of failed reads.
 */
export async function refreshLidarLibrary(): Promise<void> {
  if (refreshInFlight) {
    return refreshInFlight
  }
  readStartSequence += 1
  const startSequence = readStartSequence
  // The read clears the in-flight slot only while it still holds it: a test reset may have abandoned it.
  let read: Promise<void> | null = null
  read = (async () => {
    try {
      await readLibrarySnapshot(startSequence)
    } catch (error) {
      // Polling goes on while work runs; a streak of failed reads is recorded once, until a read succeeds.
      lidarStatusMessage.value = lidarFailureMessage(error, !lidarLibraryReadFailed.value)
      lidarLibraryReadFailed.value = true
    } finally {
      if (refreshInFlight === read) refreshInFlight = null
    }
  })()
  refreshInFlight = read
  return read
}

/**
 * Whether any library operation is still running: an import, or an analysis
 * run (a first calculation or a refresh of a published result).
 */
export function hasActiveLibraryWork(snapshot: LibrarySnapshot | null): boolean {
  if (!snapshot) return false
  return snapshot.items.some((item) =>
    item.import_job?.state === 'Staging'
    || item.import_job?.state === 'Applying'
    || item.run?.state === 'Preparing')
}

async function pollLidarState(): Promise<void> {
  await refreshLidarLibrary()
  if (!hasActiveLibraryWork(lidarLibrary.value)) stopLidarPolling()
}

/**
 * Poll while library work runs so operations settle without any user action;
 * an idle library stops polling. Work belongs to the library, not a panel or
 * a Design: closing the dock or switching Designs never stops it.
 */
export function ensureLidarPolling(): void {
  if (pollTimer !== null) return
  void pollLidarState()
  pollTimer = setInterval(() => {
    void pollLidarState()
  }, LIDAR_POLL_INTERVAL_MS)
}

export function stopLidarPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Test-only: forget all module state (timer, read in flight, snapshot,
 * message, failed-read streak, read counters) so one test's reads never leak
 * into the next whatever the run order.
 */
export function resetLidarLibraryForTests(): void {
  stopLidarPolling()
  refreshInFlight = null
  readStartSequence = 0
  publishedReadSequence = 0
  lidarLibrary.value = null
  lidarStatusMessage.value = null
  lidarLibraryReadFailed.value = false
}

/**
 * Subscribe a surface to the shared library snapshot: refresh on mount and
 * keep polling while work runs. Unmounting never stops library work.
 */
export function installLidarLibraryObserver(): () => void {
  void refreshLidarLibrary()
  ensureLidarPolling()
  return () => {}
}

/** Why an entry has no library item; each reason names its fix. */
export type LidarMissingReason = 'needs-newer-canopi' | 'library-unopened' | 'not-in-library'

/**
 * Whether an entry's library item is here: `present`, `loading` while the
 * first snapshot is still on its way (drawn as a normal row, never as
 * missing), or why it is missing.
 */
export type LidarAvailability = 'present' | 'loading' | LidarMissingReason

export interface LidarPresentationItem {
  kind: LibraryItemRole
  id: string
  /** The library's name, or the name the Design stored while the item is missing. */
  name: string
  availability: LidarAvailability
  /** `null` for a reference whose library item is gone. */
  itemType: LibraryItemType | null
  /** The item's own stored units, never an input's. */
  units: string
  /** The item's state; null unless `availability` is `present`. */
  state: LidarResultState | null
  /** The entry's own eye, which its row's eye button shows and writes. */
  visible: boolean
  /**
   * Whether the entry is shown: its own eye and the Site data eye both on.
   * Captions, values, profile curves and preparing checks read this; the map
   * adds a presented story step's choice through `mapShown` (display.ts).
   */
  shown: boolean
  opacity: number
  order: number
  /** The entry's colour ramp and range; null is the item kind's default. */
  ramp: LidarRamp | null
  reversed: boolean
  range: LidarColourRange | null
  bounds: [number, number, number, number] | null
  /** Current immutable generation; display and inspection aim at it. */
  generationId: string | null
  /** Stretch domain in the stored units, when known. */
  displayRange: [number, number] | null
  freshness: Freshness
  /** The definition a derived item belongs to, for Refresh and grouping in Layers. */
  definitionId: string | null
  /** The registry analysis and output a derived item is; null for a source. */
  analysisId: string | null
  outputKey: string | null
  /** The latest run of a derived item, for Refresh progress. */
  run: AnalysisRunStatus | null
  /** The item a derived result was calculated from (its first input). */
  inputId: string | null
  /** `inputId` when that item is in this Design too: the row nests under it. */
  parentId: string | null
  /** Nesting depth in Layers: 0 for a top-level row. */
  depth: number
}

/** The range styling and legends use: the labelled display range, else the exact values. */
export function itemDisplayRange(item: LibraryItemSummary): [number, number] | null {
  return item.display_range ? [item.display_range.min, item.display_range.max] : item.value_range ?? null
}

/** An item's name; an unnamed derived item is named by its first input and analysis. */
export function libraryItemName(item: LibraryItemSummary, library: LibrarySnapshot | null): string {
  if (item.name) return item.name
  const provenance = item.provenance
  if (!provenance) return item.id
  const inputId = provenance.inputs[0]?.item_id
  const input = inputId ? library?.items.find((candidate) => candidate.id === inputId) : undefined
  return derivedItemName(input?.name, provenance.analysis_id)
}

/** Whether an entry's library item is missing, rather than present or still loading. */
export function isMissing(item: Pick<LidarPresentationItem, 'availability'>): boolean {
  return item.availability !== 'present' && item.availability !== 'loading'
}

/** Why an entry the library does not list is missing, from how the library opened. */
function absentAvailability(library: LibrarySnapshot | null, status: LidarLibraryStatus): LidarAvailability {
  if (status.kind === 'refused_newer') return 'needs-newer-canopi'
  if (status.kind === 'unavailable') return 'library-unopened'
  return library ? 'not-in-library' : 'loading'
}

/**
 * Join library identity/status with document presentation entries, in drawing
 * order (back to front): results draw over the item they come from
 * (`reference-tree.ts`). Unavailable references persist and are flagged
 * with the reason instead of dropped.
 *
 * Effective visibility is folded here, once, before anything reads the
 * entries: `shown` is the entry's own eye and the Site data eye together,
 * and each entry keeps its own eye (GeoLibre `effectiveLayerRenderState`,
 * packages/core/src/layer-groups.ts). Saved-view capture, which may not
 * import this module, folds the same two stored flags itself.
 */
export function readLidarPresentation(
  design: {
    lidar?: { visible: boolean; entries: readonly LidarPresentationEntry[] } | null
  } | null,
  library: LibrarySnapshot | null,
  libraryStatus: LidarLibraryStatus = { kind: 'ready' },
): LidarPresentationItem[] {
  const entries = design?.lidar?.entries ?? []
  const sectionVisible = design?.lidar?.visible ?? true
  const items: Omit<LidarPresentationItem, 'parentId' | 'depth'>[] = []
  for (const entry of entries) {
    const item = library?.items.find((candidate) => candidate.id === entry.id && candidate.role === entry.kind)
    const presentation = {
      kind: entry.kind,
      id: entry.id,
      visible: entry.visible,
      shown: entry.visible && sectionVisible,
      opacity: entry.opacity,
      order: entry.order,
      ramp: entry.ramp,
      reversed: entry.reversed,
      range: entry.range,
    }
    items.push(item
      ? {
          ...presentation,
          name: libraryItemName(item, library),
          availability: 'present' as const,
          itemType: item.item_type,
          units: item.units,
          state: item.state,
          bounds: item.bounds ?? null,
          generationId: item.generation_id ?? null,
          displayRange: itemDisplayRange(item),
          freshness: item.freshness,
          definitionId: item.provenance?.definition_id ?? null,
          analysisId: item.provenance?.analysis_id ?? null,
          outputKey: item.provenance?.output_key ?? null,
          run: item.run,
          inputId: item.provenance?.inputs[0]?.item_id ?? null,
        }
      : {
          ...presentation,
          name: entry.name,
          availability: absentAvailability(library, libraryStatus),
          itemType: null,
          units: '',
          state: null,
          bounds: null,
          generationId: null,
          displayRange: null,
          freshness: { state: 'Current' },
          definitionId: null,
          analysisId: null,
          outputKey: null,
          run: null,
          inputId: null,
        })
  }
  const present = new Set(items.map((item) => item.id))
  return referenceDrawOrder(items.map((item) => ({
    ...item,
    parentId: item.inputId !== null && present.has(item.inputId) ? item.inputId : null,
  })))
}

/**
 * Presentation join for the current Design and the latest library snapshot;
 * this seam owns the design read so map snapshot code never bypasses it.
 */
export function readCurrentLidarPresentation(): LidarPresentationItem[] {
  const library = lidarLibrary.value
  // A library whose list cannot be read and that has no snapshot yet is unopened: its entries are missing, not loading.
  const status: LidarLibraryStatus = library === null && lidarLibraryReadFailed.value
    ? { kind: 'unavailable' }
    : lidarLibraryStatus.value
  return readLidarPresentation(currentDesign.value, library, status)
}
