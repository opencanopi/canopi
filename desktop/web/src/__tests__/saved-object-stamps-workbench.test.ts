import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultScenePersistedState,
  type SceneDesignObjectTarget,
} from '../canvas/runtime/scene'
import type { CanvasRuntimeSavedObjectStampCapture } from '../canvas/runtime/app-adapter'
import type { CanvasQuerySurface } from '../canvas/runtime/runtime'
import { createSavedObjectStampWorkbench } from '../app/saved-object-stamps/workbench'
import { parseSavedObjectStampPayload } from '../canvas/saved-object-stamp-payload'
import type { CanopiFile } from '../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import { geoAt } from './support/geo-design'
import type { SavedObjectStamp } from '../types/saved-object-stamps'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { setCurrentCanvasSession } from '../canvas/session'
import { setCanvasSelection } from '../canvas/session-state'

describe('Saved Object Stamp Workbench', () => {
  afterEach(() => {
    setCurrentCanvasSession(null)
    setCanvasSelection([])
  })

  const makeStamp = (id: string, name: string, sortOrder: number): SavedObjectStamp => ({
    id,
    name,
    payload_json: JSON.stringify({ plants: [], zones: [], annotations: [], groups: [] }),
    sort_order: sortOrder,
    created_at: `2026-06-19T09:00:0${sortOrder}Z`,
    updated_at: `2026-06-19T09:00:0${sortOrder}Z`,
  })

  function deferred<T>(): {
    readonly promise: Promise<T>
    readonly resolve: (value: T) => void
    readonly reject: (error: unknown) => void
  } {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  const importableFile = (): CanopiFile => ({
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Imported stamp',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [{
      id: 'note-1',
      annotation_type: 'text',
      position: geoAt(1, 2),
      text: 'Guild note',
      font_size: 12,
      rotation: null,
      locked: false,
    }],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    extra: {},
  })

  const captureFromQuery = (query: CanvasQuerySurface): CanvasRuntimeSavedObjectStampCapture => ({
    scene: query.getSceneSnapshot(),
    selection: query.getDesignObjectSelection(),
    localizedCommonNames: query.getLocalizedCommonNames(),
  })

  it('does not let an older library load overwrite a newly created stamp', async () => {
    const pendingLoad = deferred<SavedObjectStamp[]>()
    const getSavedObjectStamps = vi.fn(() => pendingLoad.promise)
    const scene = createDefaultScenePersistedState()
    scene.annotations = [{
      kind: 'annotation',
      id: 'note-1',
      locked: false,
      annotationType: 'text',
      position: { x: 1, y: 2 },
      text: 'Guild note',
      fontSize: 12,
      rotationDeg: null,
    }]
    const query = {
      ...createTestCanvasQuerySurface({ scene }),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'annotation' as const, id: 'note-1' }],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 1, minY: 2, maxX: 1, maxY: 2 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const created = makeStamp('stamp-new', 'New', 0)
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps,
      createSavedObjectStamp: async () => created,
      getCanvasQuerySurface: () => query,
    })

    const load = workbench.loadLibrary()
    expect(getSavedObjectStamps).toHaveBeenCalledTimes(1)
    await workbench.saveSelection(captureFromQuery(query))
    pendingLoad.resolve([makeStamp('stamp-old', 'Old', 0)])
    await load

    expect(workbench.library.value.items.map((stamp) => stamp.id)).toEqual([
      'stamp-new',
    ])
    expect(workbench.library.value.loading).toBe(false)
  })

  it('saves the admitted canvas capture when the mounted canvas has changed', async () => {
    const admittedScene = createDefaultScenePersistedState()
    admittedScene.annotations = [{
      kind: 'annotation',
      id: 'admitted-note',
      locked: false,
      annotationType: 'text',
      position: { x: 2, y: 3 },
      text: 'Runtime A',
      fontSize: 12,
      rotationDeg: null,
    }]
    const admittedQuery = {
      ...createTestCanvasQuerySurface({ scene: admittedScene }),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'annotation' as const, id: 'admitted-note' }],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 2, minY: 3, maxX: 2, maxY: 3 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface

    const mountedScene = createDefaultScenePersistedState()
    mountedScene.annotations = [{
      kind: 'annotation',
      id: 'mounted-note',
      locked: false,
      annotationType: 'text',
      position: { x: 8, y: 9 },
      text: 'Runtime B',
      fontSize: 12,
      rotationDeg: null,
    }]
    const mountedQuery = {
      ...createTestCanvasQuerySurface({ scene: mountedScene }),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'annotation' as const, id: 'mounted-note' }],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 8, minY: 9, maxX: 8, maxY: 9 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const createStamp = vi.fn(async (name: string, payloadJson: string): Promise<SavedObjectStamp> => ({
      id: 'stamp-capture',
      name,
      payload_json: payloadJson,
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }))
    const getMountedQuery = vi.fn(() => mountedQuery)
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      getCanvasQuerySurface: getMountedQuery,
    })

    await workbench.saveSelection(captureFromQuery(admittedQuery))

    expect(getMountedQuery).not.toHaveBeenCalled()
    const payload = JSON.parse(createStamp.mock.calls[0]![1])
    expect(payload.annotations).toEqual([
      expect.objectContaining({ text: 'Runtime A' }),
    ])
  })

  it('saves the current locked plant selection as an unlocked visible stamp payload', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [{
      kind: 'plant',
      id: 'source-plant-9',
      locked: true,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#c0442e',
      symbol: 'canopy',
      canopySpreadM: 2,
      position: { x: 12, y: 24 },
      rotationDeg: 15,
      notes: 'nursery note',
      plantedDate: '2026-04-01',
      quantity: 3,
    }]
    const query = {
      ...createTestCanvasQuerySurface({
        scene,
        localizedNames: new Map([['Malus domestica', 'Pommier']]),
      }),
      getDesignObjectSelection: () => ({
        editableTargets: [],
        lockedTargets: [{ kind: 'plant' as const, id: 'source-plant-9' }],
        blockedTargets: [{
          target: { kind: 'plant' as const, id: 'source-plant-9' },
          reason: 'locked-design-object' as const,
        }],
        bounds: { minX: 10, minY: 20, maxX: 14, maxY: 28 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const createStamp = vi.fn(async (name: string, payloadJson: string): Promise<SavedObjectStamp> => ({
      id: 'stamp-1',
      name,
      payload_json: payloadJson,
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      getCanvasQuerySurface: () => query,
    })

    const saved = await workbench.saveSelection(captureFromQuery(query))

    expect(saved?.name).toBe('Pommier')
    expect(createStamp).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(createStamp.mock.calls[0]![1])
    expect(payload.anchor).toEqual({ x: 12, y: 24 })
    expect(payload.plants).toEqual([{
      id: 'plant-1',
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#c0442e',
      symbol: 'canopy',
      position: { x: 12, y: 24 },
      rotationDeg: 15,
      scale: 2,
    }])
    expect(payload.plants[0]).not.toHaveProperty('locked')
    expect(payload.plants[0]).not.toHaveProperty('notes')
    expect(payload.plants[0]).not.toHaveProperty('plantedDate')
    expect(payload.plants[0]).not.toHaveProperty('quantity')
  })

  it('captures the effective Plant Symbol inherited from species defaults', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plantSpeciesSymbols = { 'Malus domestica': 'canopy' }
    scene.plants = [{
      kind: 'plant',
      id: 'source-plant-default-symbol',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      symbol: null,
      canopySpreadM: null,
      position: { x: 4, y: 5 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: null,
    }]
    const query = {
      ...createTestCanvasQuerySurface({ scene }),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'plant' as const, id: 'source-plant-default-symbol' }],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 3, minY: 4, maxX: 5, maxY: 6 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const createStamp = vi.fn(async (name: string, payloadJson: string): Promise<SavedObjectStamp> => ({
      id: 'stamp-symbol',
      name,
      payload_json: payloadJson,
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      getCanvasQuerySurface: () => query,
    })

    await workbench.saveSelection(captureFromQuery(query))

    const payload = JSON.parse(createStamp.mock.calls[0]![1])
    expect(payload.plants[0].symbol).toBe('canopy')
  })

  it('updates selection availability when the canvas selection changes without a scene edit', () => {
    let selectedTargets: SceneDesignObjectTarget[] = []
    const query = {
      ...createTestCanvasQuerySurface(),
      getSelection: () => selectedTargets.map((target) => ({ ...target })),
      getDesignObjectSelection: () => selectedTargets.length === 0
        ? {
            editableTargets: [],
            lockedTargets: [],
            blockedTargets: [],
            bounds: null,
            sameSpeciesReferenceCanonicalName: null,
            plantNamePinning: { plantIds: [], allPinned: false },
          }
        : {
            editableTargets: [{ kind: 'plant' as const, id: 'plant-1' }],
            lockedTargets: [],
            blockedTargets: [],
            bounds: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
            sameSpeciesReferenceCanonicalName: null,
            plantNamePinning: { plantIds: [], allPinned: false },
          },
    } satisfies CanvasQuerySurface
    setCurrentCanvasSession({
      queries: query,
      commands: {} as never,
      documents: {} as never,
      keyboard: {} as never,
    })
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      getCanvasQuerySurface: undefined,
    })

    expect(workbench.selection.value.canSave).toBe(false)

    selectedTargets = [{ kind: 'plant', id: 'plant-1' }]
    setCanvasSelection(selectedTargets.map((target) => target.id))

    expect(workbench.selection.value.canSave).toBe(true)
  })

  it('does not save when the selection has structural blockers', async () => {
    const query = {
      ...createTestCanvasQuerySurface(),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'plant' as const, id: 'plant-1' }],
        lockedTargets: [],
        blockedTargets: [{
          target: { kind: 'zone' as const, id: 'Hidden zone' },
          reason: 'structural' as const,
        }],
        bounds: null,
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const createStamp = vi.fn()
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      getCanvasQuerySurface: () => query,
    })

    const saved = await workbench.saveSelection(captureFromQuery(query))

    expect(saved).toBeNull()
    expect(workbench.selection.value).toMatchObject({
      canSave: false,
      reason: 'structural-blocker',
    })
    expect(createStamp).not.toHaveBeenCalled()
  })

  it('saves selected Object Groups with remapped visible members', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [{
      kind: 'plant',
      id: 'source-plant',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      symbol: null,
      canopySpreadM: null,
      position: { x: 2, y: 3 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: null,
    }]
    scene.zones = [{
      kind: 'zone',
      id: 'Source zone', name: 'Source zone',
      locked: true,
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }],
      rotationDeg: 10,
      fillColor: '#d8b35a',
      notes: 'mulch',
    }]
    scene.annotations = [{
      kind: 'annotation',
      id: 'source-note',
      locked: false,
      annotationType: 'text',
      position: { x: 6, y: 7 },
      text: 'Guild edge',
      fontSize: 14,
      rotationDeg: 5,
    }]
    scene.groups = [{
      kind: 'group',
      id: 'source-group',
      locked: true,
      name: 'Guild',
      members: [
        { kind: 'plant', id: 'source-plant' },
        { kind: 'zone', id: 'Source zone' },
        { kind: 'annotation', id: 'source-note' },
      ],
    }]
    const query = {
      ...createTestCanvasQuerySurface({ scene }),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'group' as const, id: 'source-group' }],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 0, minY: 0, maxX: 8, maxY: 8 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const createStamp = vi.fn(async (name: string, payloadJson: string): Promise<SavedObjectStamp> => ({
      id: 'stamp-2',
      name,
      payload_json: payloadJson,
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      getCanvasQuerySurface: () => query,
    })

    await workbench.saveSelection(captureFromQuery(query))

    const payload = JSON.parse(createStamp.mock.calls[0]![1])
    expect(payload.zones[0]).not.toHaveProperty('locked')
    expect(payload.zones[0]).not.toHaveProperty('notes')
    expect(payload.groups).toEqual([{
      id: 'group-1',
      name: 'Guild',
      members: [
        { kind: 'plant', id: 'plant-1' },
        { kind: 'zone', id: 'zone-1' },
        { kind: 'annotation', id: 'annotation-1' },
      ],
    }])
  })

  it('uses zone and annotation counts when a saved selection has no plants', async () => {
    const scene = createDefaultScenePersistedState()
    scene.zones = [{
      kind: 'zone',
      id: 'Water', name: 'Water',
      locked: false,
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }],
      rotationDeg: 0,
      fillColor: null,
      notes: null,
    }]
    scene.annotations = [{
      kind: 'annotation',
      id: 'note-1',
      locked: false,
      annotationType: 'text',
      position: { x: 1, y: 1 },
      text: 'Irrigation',
      fontSize: 12,
      rotationDeg: null,
    }]
    const query = {
      ...createTestCanvasQuerySurface({ scene }),
      getDesignObjectSelection: () => ({
        editableTargets: [
          { kind: 'zone' as const, id: 'Water' },
          { kind: 'annotation' as const, id: 'note-1' },
        ],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } satisfies CanvasQuerySurface
    const createStamp = vi.fn(async (name: string, payloadJson: string): Promise<SavedObjectStamp> => ({
      id: 'stamp-3',
      name,
      payload_json: payloadJson,
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      getCanvasQuerySurface: () => query,
    })

    const saved = await workbench.saveSelection(captureFromQuery(query))

    expect(saved?.name).toBe('1 zone, 1 annotation')
  })

  it('renames deletes and reorders saved stamps through the library adapters', async () => {
    const first = makeStamp('stamp-1', 'First', 0)
    const second = makeStamp('stamp-2', 'Second', 1)
    let persistedFirst = first
    const renameStamp = vi.fn(async (id: string, name: string): Promise<SavedObjectStamp> => {
      persistedFirst = {
        ...persistedFirst,
        id,
        name,
        updated_at: '2026-06-19T10:00:00Z',
      }
      return persistedFirst
    })
    const deleteStamp = vi.fn(async () => true)
    const reorderStamps = vi.fn(async (ids: string[]): Promise<SavedObjectStamp[]> => (
      ids.map((id, index) => ({
        ...(id === first.id ? persistedFirst : second),
        sort_order: index,
      }))
    ))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [first, second],
      createSavedObjectStamp: async () => first,
      renameSavedObjectStamp: renameStamp,
      deleteSavedObjectStamp: deleteStamp,
      reorderSavedObjectStamps: reorderStamps,
      getCanvasQuerySurface: () => null,
    })

    await workbench.loadLibrary()
    await workbench.renameStamp('stamp-1', 'Renamed')
    await workbench.reorderStamps(['stamp-2', 'stamp-1'])
    await workbench.deleteStamp('stamp-2')

    expect(renameStamp).toHaveBeenCalledWith('stamp-1', 'Renamed')
    expect(reorderStamps).toHaveBeenCalledWith(['stamp-2', 'stamp-1'])
    expect(deleteStamp).toHaveBeenCalledWith('stamp-2')
    expect(workbench.library.value.items.map((stamp) => stamp.name)).toEqual(['Renamed'])
  })

  it('publishes overlapping Saved Object Stamp mutations in admission order', async () => {
    const initial = makeStamp('stamp-1', 'Initial', 0)
    const firstRename = deferred<SavedObjectStamp>()
    const renameStamp = vi.fn((_: string, name: string) => (
      name === 'First name'
        ? firstRename.promise
        : Promise.resolve({ ...initial, name })
    ))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [initial],
      renameSavedObjectStamp: renameStamp,
      getCanvasQuerySurface: () => null,
    })
    await workbench.loadLibrary()

    const first = workbench.renameStamp('stamp-1', 'First name')
    const second = workbench.renameStamp('stamp-1', 'Second name')
    await Promise.resolve()

    expect(renameStamp.mock.calls.map(([, name]) => name)).toEqual(['First name'])

    firstRename.resolve({ ...initial, name: 'First name' })
    await Promise.all([first, second])

    expect(renameStamp.mock.calls.map(([, name]) => name)).toEqual([
      'First name',
      'Second name',
    ])
    expect(workbench.library.value.items[0]?.name).toBe('Second name')
  })

  it('queues a mutation synchronously re-entered by the first adapter', async () => {
    const initial = makeStamp('stamp-1', 'Initial', 0)
    const events: string[] = []
    let reentrantDelete: Promise<boolean> | null = null
    const workbench: ReturnType<typeof createSavedObjectStampWorkbench> = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [initial],
      renameSavedObjectStamp: (_id, name) => {
        events.push('rename:start')
        reentrantDelete = workbench.deleteStamp(initial.id)
        events.push('rename:end')
        return Promise.resolve({ ...initial, name })
      },
      deleteSavedObjectStamp: () => {
        events.push('delete')
        return Promise.resolve(true)
      },
      getCanvasQuerySurface: () => null,
    })
    await workbench.loadLibrary()

    await workbench.renameStamp(initial.id, 'Renamed')
    if (!reentrantDelete) throw new Error('Expected re-entrant delete admission')
    await reentrantDelete

    expect(events).toEqual(['rename:start', 'rename:end', 'delete'])
    expect(workbench.library.value.items).toEqual([])
  })

  it('continues queued Saved Object Stamp mutations after a predecessor rejects', async () => {
    const initial = makeStamp('stamp-1', 'Initial', 0)
    const firstRename = deferred<SavedObjectStamp>()
    const renameStamp = vi.fn((_id: string, name: string) => name === 'Rejected name'
      ? firstRename.promise
      : Promise.resolve({ ...initial, name }))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [initial],
      renameSavedObjectStamp: renameStamp,
      getCanvasQuerySurface: () => null,
    })
    await workbench.loadLibrary()

    const rejected = workbench.renameStamp(initial.id, 'Rejected name')
    const recovered = workbench.renameStamp(initial.id, 'Recovered name')
    await Promise.resolve()

    expect(renameStamp.mock.calls.map(([, name]) => name)).toEqual(['Rejected name'])

    firstRename.reject(new Error('rename failed'))
    await expect(rejected).rejects.toThrow('rename failed')
    await expect(recovered).resolves.toMatchObject({ name: 'Recovered name' })
    expect(renameStamp.mock.calls.map(([, name]) => name)).toEqual([
      'Rejected name',
      'Recovered name',
    ])
    expect(workbench.library.value.items[0]?.name).toBe('Recovered name')
  })

  it('disposes idempotently without publishing an in-flight mutation', async () => {
    const initial = makeStamp('stamp-1', 'Initial', 0)
    const pendingRename = deferred<SavedObjectStamp>()
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [initial],
      renameSavedObjectStamp: () => pendingRename.promise,
      getCanvasQuerySurface: () => null,
    })
    await workbench.loadLibrary()

    const rename = workbench.renameStamp('stamp-1', 'Renamed')
    await Promise.resolve()
    workbench.dispose()
    workbench.dispose()
    pendingRename.resolve({ ...initial, name: 'Renamed' })
    await rename

    expect(workbench.library.value.items[0]?.name).toBe('Initial')
  })

  it('does not invoke an already queued Saved Object Stamp mutation after disposal', async () => {
    const initial = makeStamp('stamp-1', 'Initial', 0)
    const pendingRename = deferred<SavedObjectStamp>()
    const renameStamp = vi.fn((_id: string, name: string) => name === 'First name'
      ? pendingRename.promise
      : Promise.resolve({ ...initial, name }))
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [initial],
      renameSavedObjectStamp: renameStamp,
      getCanvasQuerySurface: () => null,
    })
    await workbench.loadLibrary()

    const inFlight = workbench.renameStamp(initial.id, 'First name')
    const queued = workbench.renameStamp(initial.id, 'Queued name')
    expect(renameStamp).toHaveBeenCalledTimes(1)

    workbench.dispose()
    pendingRename.resolve({ ...initial, name: 'First name' })
    await Promise.all([inFlight, queued])

    expect(renameStamp).toHaveBeenCalledTimes(1)
    expect(workbench.library.value.items[0]?.name).toBe('Initial')
  })

  it('arms Place a stamp with the stamp and its caller through armCanvasTool', () => {
    const stamp: SavedObjectStamp = {
      ...makeStamp('stamp-1', ' Guild ', 0),
      payload_json: JSON.stringify({ version: 2, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }),
    }
    expect(parseSavedObjectStampPayload(stamp.payload_json)).not.toBeNull()
    const arm = vi.fn(() => true)
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [stamp],
      createSavedObjectStamp: async () => stamp,
      getCanvasQuerySurface: () => null,
      arm,
    })

    expect(workbench.placeStamp(stamp, 'panel')).toBe(true)
    expect(arm).toHaveBeenCalledWith('saved-object-stamp', {
      from: 'panel',
      source: { kind: 'saved-stamp', stamp: parseSavedObjectStampPayload(stamp.payload_json), name: 'Guild' },
    })
    // A stamp whose payload cannot be read arms nothing.
    expect(workbench.placeStamp({ ...stamp, payload_json: '{' }, 'card')).toBe(false)
    expect(arm).toHaveBeenCalledTimes(1)
    workbench.dispose()
    expect(workbench.placeStamp(stamp, 'card')).toBe(false)
  })

  it('exports a saved stamp as a Canopi file without touching the Design Session', async () => {
    const stamp: SavedObjectStamp = {
      id: 'stamp-1',
      name: 'Apple guild',
      payload_json: JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          symbol: null,
          position: { x: 0, y: 0 },
          rotationDeg: null,
        }],
        zones: [],
        annotations: [],
        groups: [],
      }),
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }
    const exportSavedObjectStamp = vi.fn(async (
      _file: CanopiFile,
      _defaultName: string,
    ): Promise<string> => '/tmp/Apple guild.canopi')
    const getCanvasQuerySurface = vi.fn(() => {
      throw new Error('Design Session should not be read during export')
    })
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [stamp],
      createSavedObjectStamp: async () => stamp,
      exportSavedObjectStamp,
      getCanvasQuerySurface,
    })

    const path = await workbench.exportStamp(stamp)

    expect(path).toBe('/tmp/Apple guild.canopi')
    expect(getCanvasQuerySurface).not.toHaveBeenCalled()
    expect(exportSavedObjectStamp).toHaveBeenCalledTimes(1)
    const [file, defaultName] = exportSavedObjectStamp.mock.calls[0]!
    expect(defaultName).toBe('Apple guild.canopi')
    expect(file).not.toHaveProperty('spatial_frame')
    expect(file).toMatchObject({
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Apple guild',
      description: null,
      plants: [{
        id: 'plant-1',
        locked: false,
        canonical_name: 'Malus domestica',
        // Stamp files place the arrangement around 0°/0°.
        position: { lon: 0, lat: 0 },
        notes: null,
        planted_date: null,
        quantity: null,
      }],
      consortiums: [],
      timeline: [],
      budget: [],
    })
  })

  it('imports a Canopi file as a saved stamp without touching the Design Session', async () => {
    const file: CanopiFile = {
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Imported design',
      description: 'Ignored description',
      plant_species_colors: {},
      plant_species_symbols: {},
      layers: [{ name: 'plants', visible: true, locked: true, opacity: 1 }],
      plants: [{
        id: 'source-plant',
        locked: true,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        symbol: null,
        position: geoAt(2, 3),
        rotation: null,
        scale: null,
        notes: 'private note',
        planted_date: '2026-04-01',
        quantity: 4,
      }],
      zones: [],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'USD',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-02T00:00:00.000Z',
      extra: { guides: [{ id: 'guide-1', axis: 'h', lat: 23 }] },
    }
    const importSavedObjectStampFile = vi.fn(async (): Promise<CanopiFile> => file)
    const createStamp = vi.fn(async (name: string, payloadJson: string): Promise<SavedObjectStamp> => ({
      id: 'stamp-imported',
      name,
      payload_json: payloadJson,
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
    }))
    const getCanvasQuerySurface = vi.fn(() => {
      throw new Error('Design Session should not be read during import')
    })
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      importSavedObjectStampFile,
      getCanvasQuerySurface,
    })

    const outcome = await workbench.importStampFile()
    const saved = outcome.status === 'imported' ? outcome.stamp : null

    expect(saved?.name).toBe('Imported design')
    expect(getCanvasQuerySurface).not.toHaveBeenCalled()
    expect(createStamp).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(createStamp.mock.calls[0]![1])
    // The stamp is relative: its only plant frames the import plane.
    expect(payload.anchor.x).toBeCloseTo(0, 6)
    expect(payload.anchor.y).toBeCloseTo(0, 6)
    expect(payload).toMatchObject({
      version: 2,
      plants: [{
        id: 'source-plant',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
      }],
      zones: [],
      annotations: [],
      groups: [],
    })
    expect(payload.plants[0]).not.toHaveProperty('locked')
    expect(payload.plants[0]).not.toHaveProperty('notes')
    expect(payload.plants[0]).not.toHaveProperty('plantedDate')
    expect(payload.plants[0]).not.toHaveProperty('quantity')
    expect(workbench.library.value.items).toEqual([saved])
  })

  it('does not continue an import after the Workbench is disposed', async () => {
    const pendingImport = deferred<CanopiFile>()
    const createStamp = vi.fn()
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      importSavedObjectStampFile: () => pendingImport.promise,
      getCanvasQuerySurface: () => null,
    })

    const importing = workbench.importStampFile()
    workbench.dispose()
    pendingImport.resolve(importableFile())

    await expect(importing).resolves.toEqual({ status: 'cancelled' })
    expect(createStamp).not.toHaveBeenCalled()
    expect(workbench.library.value.items).toEqual([])
  })

  it('does not create a saved stamp from an empty Canopi import, and says it has no visible objects', async () => {
    const importSavedObjectStampFile = vi.fn(async (): Promise<CanopiFile> => ({
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Empty design',
      description: null,
      plant_species_colors: {},
      plant_species_symbols: {},
      layers: [],
      plants: [],
      zones: [],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-02T00:00:00.000Z',
      extra: {},
    }))
    const createStamp = vi.fn()
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      importSavedObjectStampFile,
      getCanvasQuerySurface: () => null,
    })

    const outcome = await workbench.importStampFile()

    expect(outcome).toEqual({ status: 'refused', messageKey: 'savedObjectStamps.summaryEmpty' })
    expect(createStamp).not.toHaveBeenCalled()
  })

  it('refuses a stamp file saved before 2.0 with the typed older-version message', async () => {
    const createStamp = vi.fn()
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      createSavedObjectStamp: createStamp,
      // The shape `load_saved_object_stamp_canopi_file` rejects with: a
      // serialized DesignLoadFailure (pinned by the Rust test
      // load_design_file_refuses_a_file_saved_before_2_0_as_older_version).
      importSavedObjectStampFile: async () => {
        throw { kind: 'older_version', message: 'unsupported_version: 7' }
      },
      getCanvasQuerySurface: () => null,
    })

    await expect(workbench.importStampFile()).resolves.toEqual({
      status: 'refused',
      messageKey: 'start.cantReadOlderVersion',
    })
    expect(createStamp).not.toHaveBeenCalled()
    expect(workbench.library.value.items).toEqual([])
  })

  it('refuses an unreadable stamp file with the generic message, and treats a closed dialog as cancelled', async () => {
    let failure: unknown = new Error('Failed to read file')
    const workbench = createSavedObjectStampWorkbench({
      getSavedObjectStamps: async () => [],
      importSavedObjectStampFile: async () => { throw failure },
      getCanvasQuerySurface: () => null,
    })

    await expect(workbench.importStampFile()).resolves.toEqual({ status: 'refused', messageKey: 'start.cantRead' })
    failure = new Error('Dialog cancelled')
    await expect(workbench.importStampFile()).resolves.toEqual({ status: 'cancelled' })
  })
})
