// app/saved-object-stamps/workbench.ts
// Owner of the stamp import outcome (no-cancelled-literal, ADR 0025; §18 R14, 2.1-M268). Invariant: 'cancelled' is a
// SavedObjectStampImportOutcome status, built only from a dismissed pick or a Workbench disposed meanwhile; ast-grep
// skips this file, so a hand-written cancel guard added here goes uncounted and belongs to the catalogue's
// CancelToken instead.

import { batch, computed, signal, type ReadonlySignal } from '@preact/signals'
import { buildDeliveryFileName } from '../../platform/file-delivery'
import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { currentCanvasQuerySurface, currentCanvasSelection } from '../../canvas/session'
import type { CanvasRuntimeSavedObjectStampCapture } from '../../canvas/runtime/app-adapter'
import { armCanvasTool, type ArmFrom } from '../keyboard/arming'
import { normaliseObjectName } from '../contracts/object-name'
import {
  parseSavedObjectStampPayload,
  serializeSavedObjectStampPayloadV3,
} from '../../canvas/saved-object-stamp-payload'
import { savedObjectStampRowState } from './row-state'
import { showToast } from '../../failures/toasts'
import { placeStampThroughCore } from './place'
import { normalizeSelection, readSelectionModelView, type SavedObjectStampSelectionView } from './capture'
import {
  createSavedObjectStamp as createSavedObjectStampIpc,
  deleteSavedObjectStamp as deleteSavedObjectStampIpc,
  exportSavedObjectStampCanopiFile,
  getSavedObjectStamps as getSavedObjectStampsIpc,
  importSavedObjectStampCanopiFile,
  renameSavedObjectStamp as renameSavedObjectStampIpc,
  reorderSavedObjectStamps as reorderSavedObjectStampsIpc,
  restoreSavedObjectStamp as restoreSavedObjectStampIpc,
} from '../../ipc/saved-object-stamps'
import { flattenDocumentForJson, normalizeLoadedDocument } from '../contracts/document'
import { designLoadFailureMessageKey, designLoadFailureOf } from '../contracts/canopi-design-errors'
import type { CanopiFile } from '../../types/design'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import {
  composeSavedObjectStampCanopiFile,
  importedSavedObjectStampName,
  savedObjectStampPayloadFromCanopiFile,
  type SavedObjectStampCanopiDocument,
} from './file'
import { isCancelledFailure } from '../../failures/ipc-failure'
import { createMutationQueue } from '../mutation-queue'
import type { LocaleKey } from '../../generated/locale-keys'

export type { SavedObjectStampSelectionView }

/** Writes a stamp as a `.canopi` file in canonical wire form; the transport takes encoded JSON. */
export function exportSavedObjectStampFile(
  file: Parameters<typeof flattenDocumentForJson>[0],
  defaultName: string,
): Promise<string> {
  return exportSavedObjectStampCanopiFile(flattenDocumentForJson(file), defaultName)
}

export interface SavedObjectStampLibraryView {
  readonly items: readonly SavedObjectStamp[]
  readonly loading: boolean
  readonly revision: number
}

/**
 * What became of an import. `refused` carries the string that says why: the
 * typed load failure's wording (older version, damaged, …; the Start screen's
 * keys) or "No visible objects" for a file with nothing to stamp.
 */
type SavedObjectStampImportOutcome =
  | { readonly status: 'imported'; readonly stamp: SavedObjectStamp }
  /** The dialog was closed, or the Workbench went away meanwhile. */
  | { readonly status: 'cancelled' }
  | { readonly status: 'refused'; readonly messageKey: LocaleKey }

const IMPORT_CANCELLED: SavedObjectStampImportOutcome = { status: 'cancelled' }

export interface SavedObjectStampWorkbench {
  readonly library: ReadonlySignal<SavedObjectStampLibraryView>
  readonly selection: ReadonlySignal<SavedObjectStampSelectionView>
  loadLibrary(): Promise<void>
  saveSelection(capture: CanvasRuntimeSavedObjectStampCapture): Promise<SavedObjectStamp | null>
  renameStamp(id: string, name: string): Promise<SavedObjectStamp | null>
  deleteStamp(id: string): Promise<boolean>
  restoreStamp(stamp: SavedObjectStamp): Promise<SavedObjectStamp | null>
  reorderStamps(ids: string[]): Promise<void>
  /** Arms Place a stamp with it on the live canvas (Favorites: 'panel'; the tool card's chooser: 'card'). */
  placeStamp(stamp: SavedObjectStamp, from: Extract<ArmFrom, 'panel' | 'card'>): boolean
  commitStampPlacement: typeof placeStampThroughCore
  exportStamp(stamp: SavedObjectStamp): Promise<string | null>
  /** Rejects only when saving the imported stamp fails. */
  importStampFile(): Promise<SavedObjectStampImportOutcome>
  dispose(): void
}

interface SavedObjectStampWorkbenchOptions {
  readonly getSavedObjectStamps?: () => Promise<SavedObjectStamp[]>
  readonly createSavedObjectStamp?: (name: string, payloadJson: string) => Promise<SavedObjectStamp>
  readonly renameSavedObjectStamp?: (id: string, name: string) => Promise<SavedObjectStamp>
  readonly deleteSavedObjectStamp?: (id: string) => Promise<boolean>
  readonly restoreSavedObjectStamp?: (stamp: SavedObjectStamp) => Promise<SavedObjectStamp>
  readonly reorderSavedObjectStamps?: (ids: string[]) => Promise<SavedObjectStamp[]>
  readonly exportSavedObjectStamp?: (content: SavedObjectStampCanopiDocument, defaultName: string) => Promise<string>
  readonly importSavedObjectStampFile?: () => Promise<CanopiFile>
  readonly getCanvasQuerySurface?: () => CanvasQuerySurface | null
  readonly arm?: typeof armCanvasTool
}

export function createSavedObjectStampWorkbench({
  getSavedObjectStamps = getSavedObjectStampsIpc,
  createSavedObjectStamp = createSavedObjectStampIpc,
  renameSavedObjectStamp = renameSavedObjectStampIpc,
  deleteSavedObjectStamp = deleteSavedObjectStampIpc,
  restoreSavedObjectStamp = restoreSavedObjectStampIpc,
  reorderSavedObjectStamps = reorderSavedObjectStampsIpc,
  exportSavedObjectStamp = exportSavedObjectStampFile,
  importSavedObjectStampFile = async () => normalizeLoadedDocument(await importSavedObjectStampCanopiFile()),
  getCanvasQuerySurface = () => currentCanvasQuerySurface.value,
  arm = armCanvasTool,
}: SavedObjectStampWorkbenchOptions = {}): SavedObjectStampWorkbench {
  const items = signal<SavedObjectStamp[]>([])
  const loading = signal(false)
  const revision = signal(0)
  const selectionRevision = signal(0)
  const queue = createMutationQueue()
  let loadGeneration = 0

  const library = computed<SavedObjectStampLibraryView>(() => ({
    items: items.value,
    loading: loading.value,
    revision: revision.value,
  }))

  const selection = computed<SavedObjectStampSelectionView>(() => {
    selectionRevision.value
    void currentCanvasSelection.value
    const query = getCanvasQuerySurface()
    if (!query) {
      return { canSave: false, reason: 'no-canvas', selectedCount: 0 }
    }
    void query.revision.scene.value
    void query.revision.plantNames.value
    return readSelectionView(query)
  })

  async function loadLibrary(): Promise<void> {
    if (queue.disposed) return
    const requestGeneration = ++loadGeneration
    const requestSnapshotEpoch = queue.epoch
    const admittedLifetime = queue.lifetime
    const mutationBarrier = queue.tail
    loading.value = true
    try {
      if (mutationBarrier) {
        await mutationBarrier
        if (
          !queue.isCurrent(admittedLifetime)
          || isLibraryLoadStale(requestGeneration, requestSnapshotEpoch)
        ) return
      }
      const loaded = await getSavedObjectStamps()
      if (
        !queue.isCurrent(admittedLifetime)
        || isLibraryLoadStale(requestGeneration, requestSnapshotEpoch)
      ) return
      items.value = [...loaded].sort(compareSavedObjectStamps)
    } finally {
      if (isCurrentLibraryLoad(requestGeneration)) loading.value = false
    }
  }

  function saveSelection(
    capture: CanvasRuntimeSavedObjectStampCapture,
  ): Promise<SavedObjectStamp | null> {
    if (queue.disposed) return Promise.resolve(null)
    const normalized = normalizeSelection(capture)
    if (!normalized) {
      selectionRevision.value += 1
      return Promise.resolve(null)
    }

    return queue.enqueue(null, async (admittedLifetime) => {
      const saved = await createSavedObjectStamp(
        normalized.name,
        serializeSavedObjectStampPayloadV3(normalized.payload),
      )
      if (!queue.isCurrent(admittedLifetime)) return null
      batch(() => {
        items.value = [...items.value, saved].sort(compareSavedObjectStamps)
        revision.value += 1
        selectionRevision.value += 1
      })
      return saved
    })
  }

  /** A listed stamp a newer Canopi saved: the store refuses its writes, so none is sent (2.1-M88). */
  function needsNewer(id: string): boolean {
    const stamp = items.value.find((item) => item.id === id)
    return stamp !== undefined && savedObjectStampRowState(stamp) === 'needs-newer'
  }

  function renameStamp(id: string, name: string): Promise<SavedObjectStamp | null> {
    const normalised = normaliseObjectName(name)
    if (!normalised.ok || needsNewer(id)) return Promise.resolve(null)
    const nextName = normalised.name
    return queue.enqueue(null, async (admittedLifetime) => {
      const renamed = await renameSavedObjectStamp(id, nextName)
      if (!queue.isCurrent(admittedLifetime)) return null
      batch(() => {
        items.value = items.value.map((stamp) => stamp.id === id ? renamed : stamp)
        revision.value += 1
      })
      return renamed
    })
  }

  function restoreStamp(stamp: SavedObjectStamp): Promise<SavedObjectStamp | null> {
    if (queue.disposed) return Promise.resolve(null)
    return queue.enqueue(null, async (admittedLifetime) => {
      const restored = await restoreSavedObjectStamp(stamp)
      if (!queue.isCurrent(admittedLifetime)) return null
      batch(() => {
        items.value = [...items.value.filter((entry) => entry.id !== restored.id), restored].sort(compareSavedObjectStamps)
        revision.value += 1
      })
      return restored
    })
  }

  function deleteStamp(id: string): Promise<boolean> {
    if (needsNewer(id)) return Promise.resolve(false)
    const removed = items.peek().find((stamp) => stamp.id === id) ?? null
    return queue.enqueue(false, async (admittedLifetime) => {
      const deleted = await deleteSavedObjectStamp(id)
      if (!queue.isCurrent(admittedLifetime)) return false
      if (deleted) {
        batch(() => {
          items.value = items.value.filter((stamp) => stamp.id !== id)
          revision.value += 1
        })
        if (removed) {
          showToast({
            key: `saved-object-stamp-deleted:${removed.id}`,
            message: 'savedObjectStamps.deletedToast',
            params: { name: removed.name },
            actionLabel: 'savedObjectStamps.undo',
            onAction: () => {
              void restoreStamp(removed)
            },
          })
        }
      }
      return deleted
    })
  }

  /** Renumbers the stamps this Canopi reads; a newer one stays listed after them, since the store refuses a list naming it. */
  function reorderStamps(ids: string[]): Promise<void> {
    const nextOrder = ids.filter((id) => !needsNewer(id))
    return queue.enqueue(undefined, async (admittedLifetime) => {
      const reordered = await reorderSavedObjectStamps(nextOrder)
      if (!queue.isCurrent(admittedLifetime)) return
      batch(() => {
        items.value = [...reordered].sort(compareSavedObjectStamps)
        revision.value += 1
      })
    })
  }

  function placeStamp(stamp: SavedObjectStamp, from: Extract<ArmFrom, 'panel' | 'card'>): boolean {
    if (queue.disposed || savedObjectStampRowState(stamp) !== 'ready') return false
    const payload = parseSavedObjectStampPayload(stamp.payload_json)
    if (!payload) return false
    return arm('saved-object-stamp', {
      from,
      source: { kind: 'saved-stamp', stamp: payload, name: stamp.name.trim() || null },
    })
  }

  async function exportStamp(stamp: SavedObjectStamp): Promise<string | null> {
    if (queue.disposed) return null
    const payload = parseSavedObjectStampPayload(stamp.payload_json)
    if (!payload) return null
    const admittedLifetime = queue.lifetime
    try {
      const exportedPath = await exportSavedObjectStamp(
        composeSavedObjectStampCanopiFile({ name: stamp.name, payload }),
        savedObjectStampFileName(stamp.name),
      )
      return queue.isCurrent(admittedLifetime) ? exportedPath : null
    } catch (error) {
      if (!queue.isCurrent(admittedLifetime)) return null
      if (isCancelledFailure(error)) return null
      throw error
    }
  }

  function importStampFile(): Promise<SavedObjectStampImportOutcome> {
    return queue.enqueue(IMPORT_CANCELLED, async (admittedLifetime) => {
      let file: CanopiFile
      try {
        file = await importSavedObjectStampFile()
      } catch (error) {
        if (!queue.isCurrent(admittedLifetime) || isCancelledFailure(error)) return IMPORT_CANCELLED
        const failure = designLoadFailureOf(error)
        return {
          status: 'refused',
          messageKey: failure ? designLoadFailureMessageKey(failure.kind) : 'start.cantRead',
        }
      }
      if (!queue.isCurrent(admittedLifetime)) return IMPORT_CANCELLED

      const payload = savedObjectStampPayloadFromCanopiFile(file)
      if (!payload) return { status: 'refused', messageKey: 'savedObjectStamps.summaryEmpty' }

      const saved = await createSavedObjectStamp(
        importedSavedObjectStampName(file, payload),
        JSON.stringify(payload),
      )
      if (!queue.isCurrent(admittedLifetime)) return IMPORT_CANCELLED
      batch(() => {
        items.value = [...items.value, saved].sort(compareSavedObjectStamps)
        revision.value += 1
      })
      return { status: 'imported', stamp: saved }
    })
  }

  function isLibraryLoadStale(
    requestGeneration: number,
    requestSnapshotEpoch: number,
  ): boolean {
    return !isCurrentLibraryLoad(requestGeneration)
      || requestSnapshotEpoch !== queue.epoch
  }

  function isCurrentLibraryLoad(requestGeneration: number): boolean {
    return !queue.disposed && requestGeneration === loadGeneration
  }

  function dispose(): void {
    if (queue.disposed) return
    queue.dispose()
    loadGeneration += 1
  }


  return {
    library,
    selection,
    loadLibrary,
    saveSelection,
    renameStamp,
    deleteStamp,
    restoreStamp,
    reorderStamps,
    placeStamp,
    commitStampPlacement: placeStampThroughCore,
    exportStamp,
    importStampFile,
    dispose,
  }
}

function savedObjectStampFileName(name: string): string {
  return buildDeliveryFileName('stamp', name.trim() || 'Saved Object Stamp')
}

function readSelectionView(query: CanvasQuerySurface): SavedObjectStampSelectionView {
  return readSelectionModelView(query.getDesignObjectSelection())
}

/**
 * The library order: the stamps this Canopi reads by the store's order, then those a newer Canopi saved. A reorder
 * renumbers only the first (the store refuses a list naming a newer row), so listing those last keeps the order shown
 * the order saved, whatever sort_order a newer row holds (canopi-f47t.52.271).
 */
function compareSavedObjectStamps(left: SavedObjectStamp, right: SavedObjectStamp): number {
  return Number(left.needs_newer === true) - Number(right.needs_newer === true)
    || left.sort_order - right.sort_order || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
}
