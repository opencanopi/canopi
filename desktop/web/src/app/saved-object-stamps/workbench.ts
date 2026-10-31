import { batch, computed, signal, type ReadonlySignal } from '@preact/signals'
import type {
  CanvasDesignObjectSelectionModel,
  CanvasDesignObjectSelectionTarget,
  CanvasQuerySurface,
} from '../../canvas/runtime/runtime'
import {
  resolvePlantSymbolForPlant,
  type SceneAnnotationEntity,
  type SceneObjectGroupEntity,
  type SceneObjectGroupMember,
  type ScenePersistedState,
  type ScenePlantEntity,
  type SceneZoneEntity,
} from '../../canvas/runtime/scene'
import { currentCanvasQuerySurface, currentCanvasSelection } from '../../canvas/session'
import type { CanvasRuntimeSavedObjectStampCapture } from '../../canvas/runtime/app-adapter'
import { canSaveSelectionAsObjectStamp } from '../../canvas/runtime/interaction/contextual-selection-actions'
import { armCanvasTool, type ArmFrom } from '../keyboard/arming'
import { parseSavedObjectStampPayload, SAVED_OBJECT_STAMP_PAYLOAD_VERSION } from '../../canvas/saved-object-stamp-payload'
import {
  createSavedObjectStamp as createSavedObjectStampIpc,
  deleteSavedObjectStamp as deleteSavedObjectStampIpc,
  exportSavedObjectStampCanopiFile,
  getSavedObjectStamps as getSavedObjectStampsIpc,
  importSavedObjectStampCanopiFile,
  renameSavedObjectStamp as renameSavedObjectStampIpc,
  reorderSavedObjectStamps as reorderSavedObjectStampsIpc,
} from '../../ipc/saved-object-stamps'
import { encodeCanopiDesign } from '../contracts/canopi-design-wire'
import { designLoadFailureMessageKey, designLoadFailureOf } from '../contracts/canopi-design-errors'
import type { CanopiFile } from '../../types/design'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import type {
  SavedObjectStampAnnotation,
  SavedObjectStampPayload,
  SavedObjectStampPlant,
  SavedObjectStampZone,
} from '../../canvas/saved-object-stamp-payload'
import {
  composeSavedObjectStampCanopiFile,
  importedSavedObjectStampName,
  savedObjectStampPayloadFromCanopiFile,
} from './file'
import { createMutationQueue } from '../mutation-queue'
import type { LocaleKey } from '../../generated/locale-keys'

/** Writes a stamp as a `.canopi` file in canonical wire form; the transport takes encoded JSON. */
export function exportSavedObjectStampFile(file: CanopiFile, defaultName: string): Promise<string> {
  return exportSavedObjectStampCanopiFile(encodeCanopiDesign(file), defaultName)
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

export interface SavedObjectStampSelectionView {
  readonly canSave: boolean
  readonly reason: 'no-canvas' | 'empty-selection' | 'structural-blocker' | null
  readonly selectedCount: number
}

export interface SavedObjectStampWorkbench {
  readonly library: ReadonlySignal<SavedObjectStampLibraryView>
  readonly selection: ReadonlySignal<SavedObjectStampSelectionView>
  loadLibrary(): Promise<void>
  saveSelection(capture: CanvasRuntimeSavedObjectStampCapture): Promise<SavedObjectStamp | null>
  renameStamp(id: string, name: string): Promise<SavedObjectStamp | null>
  deleteStamp(id: string): Promise<boolean>
  reorderStamps(ids: string[]): Promise<void>
  /** Arms Place a stamp with it on the live canvas (Favorites: 'panel'; the tool card's chooser: 'card'). */
  placeStamp(stamp: SavedObjectStamp, from: Extract<ArmFrom, 'panel' | 'card'>): boolean
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
  readonly reorderSavedObjectStamps?: (ids: string[]) => Promise<SavedObjectStamp[]>
  readonly exportSavedObjectStamp?: (content: CanopiFile, defaultName: string) => Promise<string>
  readonly importSavedObjectStampFile?: () => Promise<CanopiFile>
  readonly getCanvasQuerySurface?: () => CanvasQuerySurface | null
  readonly arm?: typeof armCanvasTool
}

interface NormalizedSelection {
  readonly name: string
  readonly payload: SavedObjectStampPayload
}

export function createSavedObjectStampWorkbench({
  getSavedObjectStamps = getSavedObjectStampsIpc,
  createSavedObjectStamp = createSavedObjectStampIpc,
  renameSavedObjectStamp = renameSavedObjectStampIpc,
  deleteSavedObjectStamp = deleteSavedObjectStampIpc,
  reorderSavedObjectStamps = reorderSavedObjectStampsIpc,
  exportSavedObjectStamp = exportSavedObjectStampFile,
  importSavedObjectStampFile = importSavedObjectStampCanopiFile,
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
      items.value = loaded
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
        JSON.stringify(normalized.payload),
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

  function renameStamp(id: string, name: string): Promise<SavedObjectStamp | null> {
    const nextName = name.trim()
    if (nextName.length === 0) return Promise.resolve(null)
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

  function deleteStamp(id: string): Promise<boolean> {
    return queue.enqueue(false, async (admittedLifetime) => {
      const deleted = await deleteSavedObjectStamp(id)
      if (!queue.isCurrent(admittedLifetime)) return false
      if (deleted) {
        batch(() => {
          items.value = items.value.filter((stamp) => stamp.id !== id)
          revision.value += 1
        })
      }
      return deleted
    })
  }

  function reorderStamps(ids: string[]): Promise<void> {
    const nextOrder = [...ids]
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
    if (queue.disposed) return false
    const payload = parseSavedObjectStampPayload(stamp.payload_json)
    if (!payload) return false
    return arm('saved-object-stamp', { from, source: { kind: 'saved-stamp', stamp: payload, name: stamp.name.trim() || null } })
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
      if (isDialogCancelled(error)) return null
      throw error
    }
  }

  function importStampFile(): Promise<SavedObjectStampImportOutcome> {
    return queue.enqueue(IMPORT_CANCELLED, async (admittedLifetime) => {
      let file: CanopiFile
      try {
        file = await importSavedObjectStampFile()
      } catch (error) {
        if (!queue.isCurrent(admittedLifetime) || isDialogCancelled(error)) return IMPORT_CANCELLED
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
    reorderStamps,
    placeStamp,
    exportStamp,
    importStampFile,
    dispose,
  }
}

function isDialogCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'Dialog cancelled'
}

function savedObjectStampFileName(name: string): string {
  const base = name.trim() || 'Saved Object Stamp'
  return `${base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ')}.canopi`
}

function readSelectionView(query: CanvasQuerySurface): SavedObjectStampSelectionView {
  return readSelectionModelView(query.getDesignObjectSelection())
}

function readSelectionModelView(
  selection: CanvasDesignObjectSelectionModel,
): SavedObjectStampSelectionView {
  const selectedCount = selection.editableTargets.length + selection.lockedTargets.length
  if (canSaveSelectionAsObjectStamp(selection)) return { canSave: true, reason: null, selectedCount }
  return {
    canSave: false,
    reason: selectedCount === 0 && selection.blockedTargets.length === 0
      ? 'empty-selection'
      : 'structural-blocker',
    selectedCount,
  }
}

function normalizeSelection(capture: CanvasRuntimeSavedObjectStampCapture): NormalizedSelection | null {
  const selectionView = readSelectionModelView(capture.selection)
  if (!selectionView.canSave) return null

  const { scene, selection } = capture
  const selectedTargets = [...selection.editableTargets, ...selection.lockedTargets]
  const selected = collectSelectedConcreteTargets(scene, selectedTargets)
  const selectedGroups = collectSelectedGroups(scene, selectedTargets)
  const idMap = new Map<string, string>()

  const plants = scene.plants
    .filter((plant) => selected.plants.has(plant.id))
    .map((plant, index) => {
      const id = `plant-${index + 1}`
      idMap.set(concreteKey({ kind: 'plant', id: plant.id }), id)
      return savedPlantFromScene(plant, id, scene.plantSpeciesSymbols)
    })
  const zones = scene.zones
    .filter((zone) => selected.zones.has(zone.id))
    .map((zone, index) => {
      const id = `zone-${index + 1}`
      idMap.set(concreteKey({ kind: 'zone', id: zone.id }), id)
      return savedZoneFromScene(zone, id)
    })
  const annotations = scene.annotations
    .filter((annotation) => selected.annotations.has(annotation.id))
    .map((annotation, index) => {
      const id = `annotation-${index + 1}`
      idMap.set(concreteKey({ kind: 'annotation', id: annotation.id }), id)
      return savedAnnotationFromScene(annotation, id)
    })
  const groups = selectedGroups.map((group, index) => ({
    id: `group-${index + 1}`,
    name: group.name,
    members: group.members
      .map((member) => remapGroupMember(member, idMap))
      .filter((member): member is SceneObjectGroupMember => member !== null),
  }))

  const payload: SavedObjectStampPayload = {
    version: SAVED_OBJECT_STAMP_PAYLOAD_VERSION,
    anchor: selection.bounds
      ? {
          x: (selection.bounds.minX + selection.bounds.maxX) / 2,
          y: (selection.bounds.minY + selection.bounds.maxY) / 2,
        }
      : { x: 0, y: 0 },
    plants,
    zones,
    annotations,
    groups,
  }
  return {
    name: defaultStampName(payload, capture.localizedCommonNames),
    payload,
  }
}

function collectSelectedConcreteTargets(
  scene: ScenePersistedState,
  targets: readonly CanvasDesignObjectSelectionTarget[],
): { plants: Set<string>; zones: Set<string>; annotations: Set<string> } {
  const plants = new Set<string>()
  const zones = new Set<string>()
  const annotations = new Set<string>()
  const groupById = new Map(scene.groups.map((group) => [group.id, group]))

  for (const target of targets) {
    if (target.kind === 'plant') plants.add(target.id)
    if (target.kind === 'zone') zones.add(target.id)
    if (target.kind === 'annotation') annotations.add(target.id)
    if (target.kind === 'group') {
      for (const member of groupById.get(target.id)?.members ?? []) {
        if (member.kind === 'plant') plants.add(member.id)
        if (member.kind === 'zone') zones.add(member.id)
        if (member.kind === 'annotation') annotations.add(member.id)
      }
    }
  }

  return { plants, zones, annotations }
}

function collectSelectedGroups(
  scene: ScenePersistedState,
  targets: readonly CanvasDesignObjectSelectionTarget[],
): SceneObjectGroupEntity[] {
  const selectedGroupIds = new Set(targets.filter((target) => target.kind === 'group').map((target) => target.id))
  return scene.groups.filter((group) => selectedGroupIds.has(group.id))
}

function savedPlantFromScene(
  plant: ScenePlantEntity,
  id: string,
  plantSpeciesSymbols: Readonly<Record<string, string>>,
): SavedObjectStampPlant {
  return {
    id,
    canonicalName: plant.canonicalName,
    commonName: plant.commonName,
    color: plant.color,
    symbol: resolvePlantSymbolForPlant(plant, plantSpeciesSymbols),
    position: { ...plant.position },
    rotationDeg: plant.rotationDeg,
    scale: plant.canopySpreadM,
  }
}

function savedZoneFromScene(zone: SceneZoneEntity, id: string): SavedObjectStampZone {
  return {
    id,
    name: zone.name,
    zoneType: zone.zoneType,
    points: zone.points.map((point) => ({ ...point })),
    rotationDeg: zone.rotationDeg,
    fillColor: zone.fillColor,
  }
}

function savedAnnotationFromScene(annotation: SceneAnnotationEntity, id: string): SavedObjectStampAnnotation {
  return {
    id,
    annotationType: annotation.annotationType,
    position: { ...annotation.position },
    text: annotation.text,
    fontSize: annotation.fontSize,
    rotationDeg: annotation.rotationDeg,
  }
}

function remapGroupMember(
  member: SceneObjectGroupMember,
  idMap: ReadonlyMap<string, string>,
): SceneObjectGroupMember | null {
  const id = idMap.get(concreteKey(member))
  if (!id) return null
  return { kind: member.kind, id }
}

function concreteKey(member: SceneObjectGroupMember): string {
  return `${member.kind}:${member.id}`
}

function defaultStampName(
  payload: SavedObjectStampPayload,
  localizedNames: ReadonlyMap<string, string | null>,
): string {
  if (payload.plants.length > 0) {
    const counts = new Map<string, { count: number; firstIndex: number }>()
    payload.plants.forEach((plant, index) => {
      const name = localizedNames.get(plant.canonicalName) ?? plant.commonName ?? plant.canonicalName
      const current = counts.get(name)
      counts.set(name, current
        ? { ...current, count: current.count + 1 }
        : { count: 1, firstIndex: index })
    })
    return [...counts.entries()]
      .sort(([, left], [, right]) => right.count - left.count || left.firstIndex - right.firstIndex)
      .slice(0, 3)
      .map(([name]) => name)
      .join(', ')
  }

  const zonePart = payload.zones.length === 1 ? '1 zone' : `${payload.zones.length} zones`
  const annotationPart = payload.annotations.length === 1
    ? '1 annotation'
    : `${payload.annotations.length} annotations`
  return `${zonePart}, ${annotationPart}`
}

function compareSavedObjectStamps(left: SavedObjectStamp, right: SavedObjectStamp): number {
  return left.sort_order - right.sort_order || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
}
