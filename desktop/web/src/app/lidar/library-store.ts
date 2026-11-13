import { signal, type ReadonlySignal } from '@preact/signals'
import type {
  AnalysisRunStatus,
  Freshness,
  LibraryItemRole,
  LibraryItemSummary,
  LibraryItemType,
  LibrarySnapshot,
  LidarColourRange,
  LidarPresentationEntry,
  LidarRamp,
  LidarResultState,
  StoreOpenStatus,
} from '../../generated/contracts'
import { lidarListLibrary } from '../../ipc/lidar'
import { derivedItemName } from '../analyses/registry'
import { currentDesign } from '../document-session/store'
import { storeStatus } from '../../failures/health'
import { raiseNotice, withdrawNotice } from '../../failures/notices'
import { reportFailure } from '../../failures/report'
import { showToast } from '../../failures/toasts'
import { referenceDrawOrder } from './reference-tree'

/** How the library opened, as far as a row reads it: only the status kind, never its code or counts. */
type LibraryOpenKind = StoreOpenStatus | { readonly kind: StoreOpenStatus['kind'] }

const LIDAR_POLL_INTERVAL_MS = 1500
/** The one notice a list that cannot be refreshed raises (2.1-Q297). */
const LIST_STALE_NOTICE = 'library.list-stale'

/** Library-side snapshot; null until the first successful read. */
export const lidarLibrary = signal<LibrarySnapshot | null>(null)
/** An action's message in the item's details; a list read never writes it. */
export const lidarStatusMessage = signal<string | null>(null)
const listStale = signal(false)
/**
 * Whether the latest list read failed: the last rows stay, marked stale, under one notice with Try again (2.1-Q297).
 * How the library opened is the health model's (`library_catalogue`), never this.
 */
export const lidarLibraryStale: ReadonlySignal<boolean> = listStale

/** How long the "Import cancelled" toast stays: short, it only confirms what the user did (2.1-Q298). */
const IMPORT_CANCELLED_TOAST_MS = 4000

// The imports the user cancelled whose outcome the list has not shown yet, by layer id.
const cancelledImports = signal<ReadonlySet<string>>(new Set())

/** Notes that the user pressed Cancel on an import, so its row leaving the list reads as cancelled, not lost. */
export function noteImportCancel(layerId: string): void {
  cancelledImports.value = new Set(cancelledImports.peek()).add(layerId)
}

/**
 * A cancelled import the list no longer has was withdrawn: one short toast in the window's toast position, which leaves
 * by itself and never waits behind the notice row's queue; nothing stored. One
 * the list still has settled otherwise (it failed first, or published before the cancel was seen) and keeps its row with
 * no notice; one still running waits.
 */
function settleCancelledImports(snapshot: LibrarySnapshot): void {
  const waiting = new Set<string>()
  for (const layerId of cancelledImports.peek()) {
    const item = snapshot.items.find((candidate) => candidate.id === layerId)
    const state = item?.import_job?.state
    if (state === 'Staging' || state === 'Applying') waiting.add(layerId)
    else if (!item) {
      showToast({
        key: `library.import-cancelled:${layerId}`,
        message: 'canvas.lidar.library.importCancelled',
        timeoutMs: IMPORT_CANCELLED_TOAST_MS,
      })
    }
  }
  if (waiting.size !== cancelledImports.peek().size) cancelledImports.value = waiting
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let refreshInFlight: Promise<void> | null = null
/**
 * Monotonic read-start sequence: a read writes the module state only while it
 * started after the last published read, so an older response cannot
 * overwrite a later snapshot, and a read the test reset abandoned (the reset
 * fences every read started before it) never writes at all.
 */
let readStartSequence = 0
let publishedReadSequence = 0

function isCurrentRead(startSequence: number): boolean {
  return startSequence > publishedReadSequence
}

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
  if (isCurrentRead(startSequence)) {
    publishedReadSequence = startSequence
    lidarLibrary.value = snapshot
    lidarStatusMessage.value = null
    settleCancelledImports(snapshot)
    if (listStale.peek()) {
      listStale.value = false
      withdrawNotice(LIST_STALE_NOTICE)
    }
  }
  return snapshot
}

/**
 * A failed read keeps the last rows, marked stale, and raises one notice with Try again (2.1-Q297); the failure goes to
 * the sink once per streak of failed reads, until a read succeeds.
 */
function markListStale(error: unknown): void {
  if (listStale.peek()) return
  listStale.value = true
  reportFailure(error, { shown: 'none', source: 'library.list', level: 'warning' })
  raiseNotice({
    key: LIST_STALE_NOTICE,
    message: 'health.libraryListStale',
    tone: 'warning',
    action: { label: 'boundary.tryAgain', run: () => { void refreshLidarLibrary() } },
    source: 'library.list',
  })
}

/**
 * Refresh the library snapshot. Overlapping callers coalesce onto the read in
 * flight; a read that started before the last published one is dropped; a
 * failed read keeps the previous snapshot, marked stale (Web has no library).
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
      if (!isCurrentRead(startSequence)) return
      // Polling goes on while work runs; a streak of failed reads is told and recorded once, until a read succeeds.
      markListStale(error)
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
 * message, failed-read streak) and fence every read started so far, so one
 * test's reads never leak into the next whatever the run order.
 *
 * @testonly
 */
export function resetLidarLibraryForTests(): void {
  stopLidarPolling()
  refreshInFlight = null
  publishedReadSequence = readStartSequence
  lidarLibrary.value = null
  lidarStatusMessage.value = null
  if (listStale.peek()) withdrawNotice(LIST_STALE_NOTICE)
  listStale.value = false
  cancelledImports.value = new Set()
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
function absentAvailability(library: LibrarySnapshot | null, status: LibraryOpenKind): LidarAvailability {
  if (status.kind === 'refused_newer') return 'needs-newer-canopi'
  if (status.kind === 'unavailable' || status.kind === 'set_aside_damaged') return 'library-unopened'
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
  libraryStatus: LibraryOpenKind = { kind: 'ready' },
): LidarPresentationItem[] {
  const entries = design?.lidar?.entries ?? []
  const sectionVisible = design?.lidar?.visible ?? true
  const items: Omit<LidarPresentationItem, 'parentId' | 'depth'>[] = []
  for (const entry of entries) {
    // An id names one item, whatever kind the entry stored or left out (a v10 Design's Site data); the item's role
    // is the kind (2.1-M493).
    const listed = library?.items.find((candidate) => candidate.id === entry.id)
    // An item a newer catalogue lists is never drawn: its row reads by its name, needing a newer Canopi (2.1-Q318).
    const item = listed?.state === 'NeedsNewer' ? undefined : listed
    const presentation = {
      kind: listed?.role ?? entry.kind,
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
          name: listed ? libraryItemName(listed, library) : entry.name,
          availability: listed ? 'needs-newer-canopi' as const : absentAvailability(library, libraryStatus),
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
  // How the library opened is the one status the banner and the report read too (canopi-f47t.52.142): a list that
  // cannot be read leaves its rows loading or stale, never "not opened".
  return readLidarPresentation(currentDesign.value, lidarLibrary.value, storeStatus('library_catalogue'))
}
