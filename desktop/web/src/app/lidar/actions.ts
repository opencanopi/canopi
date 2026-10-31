import { signal } from '@preact/signals'
import type {
  AnalysisReceipt,
  AnalysisRequest,
  AnalysisRunStatus,
  LibraryDeleteImpact,
  LibraryItemRole,
  LibrarySnapshot,
  LidarColourRange,
  LidarRamp,
  ProcessingHistoryPage,
  RasterQuantity,
} from '../../generated/contracts'
import {
  lidarCancelAnalysisJob,
  lidarCancelImport,
  lidarCreateAnalysis,
  lidarDeleteImpact,
  lidarDeleteItem,
  lidarDismissImport,
  lidarImportItem,
  lidarLayerCollection,
  lidarLibraryDiskUsage,
  lidarProcessingHistory,
  lidarRenameItem,
  lidarRerunAnalysis,
  lidarRetryImport,
  type LidarImportReceipt,
  type LidarLayerCollection,
} from '../../ipc/lidar'
import { showAppFolder } from '../../ipc/settings'
import { pickOpen } from '../../ipc/dialogs'
import {
  patchLidarEntryById,
  reconcileLidarEntryNames,
  sameColourRange,
  setLidarEntryOrders,
  removeLidarEntries,
  setSiteDataVisible,
  upsertLidarEntry,
} from '../design-edit/lidar'
import {
  ensureLidarPolling,
  libraryItemName,
  lidarLibrary,
  lidarStatusMessage,
  readCurrentLidarPresentation,
  refreshLidarLibrary,
} from './library-store'
import { lidarFailureMessage } from './lidar-failures'
import { siblingMoveOrders } from './reference-tree'
import { kindDisplayDefaults } from './item-types'
import { designSessionStore } from '../document-session/store'
import { isPresentableOutput } from '../analyses/registry'
import { isAdmittedColourRange, isAdmittedOpacity } from '../contracts/design-admission'

/**
 * Leaf action module for the Data Library and the Layers data band: every UI
 * mutation flows through here so panels never orchestrate IPC sequencing.
 *
 * Library operations (import, rename, delete, analyses and their reruns)
 * never dirty a Design.
 * Design references change only through Add to Design, visibility, opacity,
 * order and Remove from Design, which are Design Edits and undoable.
 */

/**
 * Let the user choose source files, without creating anything yet: the host's
 * GeoTIFF Open dialog, with the system's own title (2.1-Q241).
 *
 * Cancelling the chooser creates no item, no job and no asset, which is why
 * the chooser comes first and the interpretation is confirmed afterwards.
 */
export async function chooseImportFiles(): Promise<string[] | null> {
  const outcome = await pickOpen('lidar-geotiff-import')
  return outcome.kind === 'picked' ? outcome.paths : null
}

/**
 * Import the chosen files as one new library item.
 *
 * The listed order is the item's source priority: the first listed valid
 * value wins where files overlap. The item is saved to the library and never
 * moves the camera. An import always joins the Design session that asked once
 * it is published (the one attach rule); a Design switch, failure or cancel
 * drops that attachment.
 */
export async function importLibraryItem(
  paths: string[],
  name: string,
  quantity: RasterQuantity,
  unit: { label: string | null; unknown: boolean },
): Promise<LidarImportReceipt> {
  const identity = designSessionStore.sessionIdentity.value
  const receipt = await withLidarError(() => lidarImportItem(name, quantity, unit, paths))
  requestAttachment({ key: `import:${receipt.layer_id}`, kind: 'import', identity, itemIds: [receipt.layer_id] })
  await refreshLidarLibrary()
  ensureLidarPolling()
  return receipt
}

/**
 * Retry a failed or cancelled import with its saved selection. A refused
 * Retry still refreshes: the library writes the refusal onto the item's
 * latest job, and polling has stopped, so only this read shows the row
 * failed again.
 */
export async function retryLibraryImport(layerId: string): Promise<void> {
  try {
    await withLidarError(() => lidarRetryImport(layerId))
  } finally {
    await refreshLidarLibrary()
  }
  ensureLidarPolling()
}

/** Cancel one running import; only explicit Cancel stops library work. */
export async function cancelLibraryImport(jobId: string): Promise<void> {
  await withLidarError(() => lidarCancelImport(jobId))
  await refreshLidarLibrary()
}

/** Remove a never-published failed or cancelled import. */
export async function dismissLibraryImport(layerId: string): Promise<void> {
  await withLidarError(() => lidarDismissImport(layerId))
  await refreshLidarLibrary()
}

export async function renameLibraryItem(id: string, name: string): Promise<void> {
  await withLidarError(() => lidarRenameItem(id, name))
  await refreshLidarLibrary()
}

/** Data library footer: the bytes the library occupies on this device. */
export async function fetchLibraryDiskUsage(): Promise<number> {
  return lidarLibraryDiskUsage()
}

/**
 * Data library › Show in folder: the same reveal as Settings › Files and data.
 * Its failure reads like any library action's but is only thrown, for the view
 * to show inline: the reveal changes no library state, so it neither clears
 * nor replaces the shared status (a standing read failure stays shown).
 */
export async function showDataLibraryFolder(): Promise<void> {
  return withFailureMessage(() => showAppFolder('data_library'))
}

export async function fetchDeleteImpact(id: string): Promise<LibraryDeleteImpact> {
  return lidarDeleteImpact(id)
}

/**
 * Delete one library item.
 *
 * An item other results were calculated from is refused natively. On success the current
 * Design's reference is removed through Design Edit, but only while the same
 * Design session is still current: Undo can restore that reference, which then
 * honestly shows unavailable data. Other saved Designs keep their references.
 */
export async function deleteLibraryItem(id: string): Promise<void> {
  const identity = designSessionStore.sessionIdentity.value
  await withLidarError(() => lidarDeleteItem(id))
  await refreshLidarLibrary()
  if (designSessionStore.sessionIdentity.value === identity) {
    removePresentedEntities([id])
  }
}

/** Read the first page of an item's source files, for details. */
export async function fetchItemSources(layerId: string): Promise<LidarLayerCollection> {
  return lidarLayerCollection(layerId, null)
}

/**
 * Add a library item to the current Design.
 *
 * Idempotent: an existing reference keeps its visibility, opacity and order.
 * A new reference is visible at the top of the data band and dirties the
 * Design; the camera does not move.
 */
export function addToDesign(role: LibraryItemRole, id: string): void {
  const library = lidarLibrary.peek()
  const item = library?.items.find((candidate) => candidate.id === id && candidate.role === role)
  upsertLidarEntry(role, id, item ? libraryItemName(item, library) : id)
}

/**
 * Remove one reference from the current Design.
 *
 * A Design Edit, not a library operation: the item stays in the library and
 * in other Designs. Like every Design Edit it is saved continuously and has
 * no undo.
 */
export function removeFromDesign(id: string): void {
  removePresentedEntities([id])
}

export function setLidarEntryVisibility(id: string, visible: boolean): void {
  patchLidarEntryById(id, { visible })
}

/**
 * The Site data eye (Layers' summary row and the panel's "hidden from the map"
 * strip): shows or hides every entry at once, keeping each entry's own eye.
 */
export function setSiteDataShown(shown: boolean): void {
  setSiteDataVisible(shown)
}

/** An entry's display settings; a field left out keeps its stored value. */
export interface LidarEntryDisplay {
  readonly ramp?: LidarRamp | null
  readonly reversed?: boolean
  readonly range?: LidarColourRange | null
  readonly opacity?: number
}

/**
 * Restyle one Site data entry: colours, Reverse, range and opacity. The one
 * writer of display settings: a ramp or range equal to the item kind's default
 * is stored as null, so `.canopi` files hold one encoding of each default and
 * Reset's "differs from the default" is one comparison. A missing item's kind
 * is unknown, so its settings are kept as written. A range or opacity the
 * Design would be refused with on reopening (an inverted, empty or non-finite
 * Custom range; an opacity outside [0, 1]) is never stored: that field is
 * dropped and the rest of the patch kept.
 */
export function setLidarEntryDisplay(id: string, display: LidarEntryDisplay): void {
  const item = readCurrentLidarPresentation().find((entry) => entry.id === id)
  const defaults = item?.itemType ? kindDisplayDefaults(item.itemType, item.units) : null
  const patch: { -readonly [K in keyof LidarEntryDisplay]: LidarEntryDisplay[K] } = { ...display }
  if (patch.range !== undefined && !isAdmittedColourRange(patch.range)) delete patch.range
  if (patch.opacity !== undefined && !isAdmittedOpacity(patch.opacity)) delete patch.opacity
  if (Object.keys(patch).length === 0) return
  if (defaults && patch.ramp === defaults.ramp) patch.ramp = null
  if (defaults && patch.range && sameColourRange(patch.range, defaults.range)) patch.range = null
  patchLidarEntryById(id, patch)
}

/**
 * Move one reference to a sibling's place in Site data (a drop, or Alt ↑/↓
 * to the neighbour), in one order write; nothing when the target is not a
 * sibling. Display order only: it never changes an item's source priority.
 */
export function moveReferenceTo(id: string, targetId: string): void {
  const orders = siblingMoveOrders(readCurrentLidarPresentation(), id, targetId)
  if (orders) setLidarEntryOrders(orders)
}

/**
 * Run one registered analysis as a new definition, saved to the library.
 *
 * Inputs and earlier results never change, and a second run with the same
 * settings is a second definition. The one attach rule: the finished results
 * join the open Design when that Design shows the input, wherever the run was
 * started (Analyze, Run again with changes…), and only the Design session that
 * asked: switching Designs while it runs leaves them in the library, never in
 * the replacement Design.
 */
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisReceipt> {
  const identity = designSessionStore.sessionIdentity.value
  const shown = new Set(readCurrentLidarPresentation().map((entry) => entry.id))
  const attachToDesign = request.inputs.some((input) => shown.has(input.item_id))
  const receipt = await withLidarError(() => lidarCreateAnalysis(request))
  if (attachToDesign) {
    requestAttachment({ key: receipt.definition_id, kind: 'analysis', identity, itemIds: receipt.item_ids })
  }
  await refreshLidarLibrary()
  ensureLidarPolling()
  return receipt
}

/**
 * Run one definition again with its saved inputs and parameters: Retry when
 * it produced no result, Refresh when it did. A refresh republishes in place,
 * so every Design that uses the result sees the new one; the earlier run stays
 * in the processing history. Never automatic.
 */
export async function rerunAnalysis(definitionId: string): Promise<AnalysisReceipt> {
  const receipt = await withLidarError(() => lidarRerunAnalysis(definitionId))
  await refreshLidarLibrary()
  ensureLidarPolling()
  return receipt
}

/** Library work waiting to join the Design session that asked. */
export interface PendingAttachment {
  /** The analysis definition, or `import:<item id>`. */
  readonly key: string
  readonly kind: 'import' | 'analysis'
  readonly identity: unknown
  readonly itemIds: readonly string[]
}

/**
 * Pending attachments, read by Site data to show their progress in its list.
 * Settled or dropped requests leave the list.
 */
export const pendingAttachments = signal<readonly PendingAttachment[]>([])

/**
 * The last import or analysis that failed before it could join its Design, so
 * Site data can say so; a cancel is the user's own choice and is not reported.
 * The job's stored text is never shown (it stays in the library for
 * diagnostics).
 */
export const attachmentFailure = signal<{ readonly itemId: string } | null>(null)

export function dismissAttachmentFailure(): void {
  attachmentFailure.value = null
}

function requestAttachment(pending: PendingAttachment): void {
  pendingAttachments.value = [...pendingAttachments.peek().filter((entry) => entry.key !== pending.key), pending]
}

/**
 * Attach finished work to its originating Design session,
 * and drop requests whose session ended or whose work failed or was cancelled.
 *
 * An import joins once it is published. Every presentable output of an
 * analysis joins, in registry output order, once all of them are published;
 * outputs kept only for provenance never do.
 */
export function settleResultAttachments(snapshot: LibrarySnapshot | null): void {
  // Peeked: the settling effect depends on the snapshot and session only.
  const pendingList = pendingAttachments.peek()
  if (!snapshot || pendingList.length === 0) return
  const current = designSessionStore.sessionIdentity.value
  const remaining: PendingAttachment[] = []
  for (const pending of pendingList) {
    if (pending.identity !== current) continue
    const items = pending.itemIds.map((id) => snapshot.items.find((candidate) => candidate.id === id))
    // An item the library no longer lists (a dismissed import) can never publish.
    const gone = items.some((item) => item === undefined)
    const failed = items.find((item) => item?.state === 'Failed' && !item.generation_id)
    if (gone || failed) {
      const job = failed?.import_job ?? null
      const run = failed?.run ?? null
      if (failed && (job?.state === 'Failed' || run?.state === 'Failed')) {
        attachmentFailure.value = { itemId: failed.id }
      }
      continue
    }
    if (!items.every((item) => item?.generation_id)) {
      remaining.push(pending)
      continue
    }
    for (const item of items) {
      if (pending.kind === 'import') {
        upsertLidarEntry('Source', item!.id, libraryItemName(item!, snapshot))
      } else if (item?.provenance && isPresentableOutput(item.provenance.analysis_id, item.provenance.output_key)) {
        upsertLidarEntry('Derived', item.id, libraryItemName(item, snapshot))
      }
    }
  }
  if (remaining.length !== pendingList.length) pendingAttachments.value = remaining
}

/**
 * Refresh the open Design's stored entry names from a library snapshot, so a
 * missing row later shows the name the library last had. A library rename is
 * not a Design Edit: this never dirties the Design, and names already current
 * leave it untouched. The Desktop workflow calls it on each snapshot and
 * Design switch; nothing happens before the first snapshot.
 */
export function reconcileEntryNames(snapshot: LibrarySnapshot | null): void {
  if (!snapshot) return
  reconcileLidarEntryNames(new Map(snapshot.items.map((item) => [item.id, libraryItemName(item, snapshot)])))
}

/** Cancel the running job of one derived item; false when nothing runs. */
export async function cancelAnalysisJob(item: { readonly run: AnalysisRunStatus | null }): Promise<boolean> {
  const run = item.run
  if (!run || run.state !== 'Preparing') return false
  await withLidarError(() => lidarCancelAnalysisJob(run.job_id))
  await refreshLidarLibrary()
  return true
}

/** One page of a definition's processing history, newest first. */
export async function fetchProcessingHistory(
  definitionId: string,
  cursor: string | null = null,
): Promise<ProcessingHistoryPage> {
  return lidarProcessingHistory(definitionId, cursor)
}

function removePresentedEntities(ids: string[]): void {
  removeLidarEntries(ids)
}

/**
 * Run one library action, surfacing its failure through the shared status in
 * the interface language (`lidarFailureMessage`; the failure's own text goes
 * to diagnostics). The message is published and re-thrown so callers can show
 * it inline.
 */
async function withLidarError<T>(work: () => Promise<T>): Promise<T> {
  lidarStatusMessage.value = null
  try {
    return await withFailureMessage(work)
  } catch (error) {
    lidarStatusMessage.value = (error as Error).message
    throw error
  }
}

/** Re-throw `work`'s failure as `lidarFailureMessage`, leaving the shared status alone. */
async function withFailureMessage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new Error(lidarFailureMessage(error))
  }
}
