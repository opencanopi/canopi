import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../ipc/species', () => ({
  getSpeciesBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import type { CanopiFile } from '../../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import { geoAt } from '../../../__tests__/support/geo-design'
import { SceneStore } from '../scene'
import { CanvasPlantLabelResolver } from '../plant-labels'
import { CanvasSpeciesCache, installSpeciesCacheLoader } from '../../../app/canvas-runtime/species-cache'
import { createDetachedCanvasPlantLabelSource } from '../presentation-data'
import { SceneRuntimePresentationController } from './presentation'
import { projectScenePlantLabels } from '../selection-labels'
import { getCommonNames, getSpeciesBatch } from '../../../ipc/species'
import { isPlantDbUnavailableError } from '../../../ipc/plant-db-errors'

installSpeciesCacheLoader({
  getSpeciesBatch,
  isPlantDbUnavailableError,
})

function makeFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Presentation demo',
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
    ],
    plants: [
      {
        id: 'plant-1',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(10, 10),
        rotation: null,
        canopy_spread_m: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
    ],
    zones: [
      {
        id: 'zone-1', name: null,
        zone_type: 'rect',
        rotation: 0,
        points: [
          geoAt(0, 0),
          geoAt(5, 0),
          geoAt(5, 5),
          geoAt(0, 5),
        ],
        fill_color: null,
        notes: null,
        locked: false,
      },
    ],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  }
}

function createController() {
  const sceneStore = new SceneStore().hydrate(makeFile())
  const state = {
    locale: 'fr',
    viewport: { x: 0, y: 0, scale: 2 },
    namesChanged: 0,
  }
  const controller = new SceneRuntimePresentationController({
    sceneStore,
    readPixelsPerMetre: () => state.viewport.scale,
    getLocale: () => state.locale,
    resolveHighlightedTargets: () => ({
      plantIds: ['plant-1'],
      zoneIds: ['zone-1'],
    }),
    onPlantNamesChanged: () => {
      state.namesChanged += 1
    },
    plantLabels: new CanvasPlantLabelResolver(async (names, locale) => ({ names: await getCommonNames([...names], locale), englishFallbacks: [] })),
    speciesCache: new CanvasSpeciesCache(),
  })
  return { controller, sceneStore, state }
}

describe('scene runtime presentation controller', () => {
  beforeEach(() => {
    vi.mocked(getCommonNames).mockReset()
    vi.mocked(getSpeciesBatch).mockReset()
    vi.mocked(getCommonNames).mockResolvedValue({})
    vi.mocked(getSpeciesBatch).mockResolvedValue([])
  })

  it('loads labels and species data as one plant-names revision, leaving the Scene as saved', async () => {
    vi.mocked(getCommonNames).mockResolvedValue({
      'Malus domestica': 'Pommier',
    })
    vi.mocked(getSpeciesBatch).mockResolvedValue([{
      canonical_name: 'Malus domestica',
      locked: false,
      stratum: 'canopy',
      width_max_m: 4.5,
    } as never])

    const { controller, sceneStore, state } = createController()
    const saved = sceneStore.persisted

    const result = await controller.refreshCurrentPresentationData()
    expect(state.namesChanged).toBe(0)
    controller.publishRefresh(result)

    expect(result.changed).toBe(true)
    expect(state.namesChanged).toBe(1)
    expect(controller.getLocalizedCommonNames().get('Malus domestica')).toBe('Pommier')
    expect(sceneStore.persisted).toEqual(saved)
    expect(controller.getSpeciesCache().get('Malus domestica')).toMatchObject({
      stratum: 'canopy',
      width_max_m: 4.5,
    })
  })

  it('counts a species-data load with no new names as a plant-names revision', async () => {
    vi.mocked(getSpeciesBatch).mockResolvedValue([{ canonical_name: 'Malus domestica', stratum: 'canopy' } as never])
    let namesChanged = 0
    const controller = new SceneRuntimePresentationController({
      sceneStore: new SceneStore().hydrate(makeFile()),
      readPixelsPerMetre: () => 2,
      getLocale: () => 'en',
      resolveHighlightedTargets: () => ({ plantIds: [], zoneIds: [] }),
      onPlantNamesChanged: () => { namesChanged += 1 },
      plantLabels: createDetachedCanvasPlantLabelSource(),
      speciesCache: new CanvasSpeciesCache(),
    })

    controller.publishRefresh(await controller.refreshCurrentPresentationData())

    // Lists that colour plants by stratum (the species key, the legend) refresh on this revision.
    expect(namesChanged).toBe(1)
    expect(controller.getSpeciesCache().get('Malus domestica')).toMatchObject({ stratum: 'canopy' })
  })

  it('builds renderer snapshots from scene, viewport, and highlighted targets', async () => {
    vi.mocked(getCommonNames).mockResolvedValue({
      'Malus domestica': 'Pommier',
    })
    const { controller, sceneStore } = createController()
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }])
    sceneStore.updateSession((session) => {
      session.hoveredTarget = { kind: 'plant', id: 'plant-1' }
    })

    await controller.refreshSpeciesCacheEntries(['Malus domestica'], 'fr')
    const snapshot = controller.buildRendererSnapshot()

    expect(snapshot.selectedPlantIds).toEqual(new Set(['plant-1']))
    expect(snapshot.highlightedPlantIds).toEqual(new Set(['plant-1']))
    expect(snapshot.highlightedZoneIds).toEqual(new Set(['zone-1']))
    expect(snapshot.hoveredCanonicalName).toBe('Malus domestica')
    expect(snapshot.localizedCommonNames.get('Malus domestica')).toBe('Pommier')
    expect(snapshot).not.toHaveProperty('sizeMode')
    expect(snapshot).not.toHaveProperty('colorByAttr')
  })

  it('omits detailed Scene projection work from overview snapshots', () => {
    const { controller, sceneStore } = createController()
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }])
    sceneStore.setHoveredTarget({ kind: 'plant', id: 'plant-1' })

    const snapshot = controller.buildRendererSnapshot({ overview: true })

    expect(snapshot.scene.plants).toEqual([])
    expect(snapshot.scene.zones).toEqual([])
    expect(snapshot.selectedPlantIds).toEqual(new Set())
    expect(snapshot.hoverTarget).toBeNull()
    expect(projectScenePlantLabels(snapshot, 2).pinnedPlantNameLabels).toEqual([])
  })

  it('restores detail from the latest authoritative Scene after overview', () => {
    const { controller, sceneStore } = createController()
    expect(controller.buildRendererSnapshot({ overview: true }).scene.plants).toEqual([])
    sceneStore.updatePersisted((draft) => {
      draft.plants[0] = {
        ...draft.plants[0]!,
        position: { x: 42, y: 64 },
      }
    })

    const restored = controller.buildRendererSnapshot()

    expect(restored.scene.plants).toHaveLength(1)
    expect(restored.scene.plants[0]?.position).toEqual({ x: 42, y: 64 })
  })

  it('does not show a transient Plant label for a mixed Design Object selection', () => {
    const { controller, sceneStore } = createController()
    sceneStore.setSelection([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'zone-1' },
    ])

    const snapshot = controller.buildRendererSnapshot()

    expect(snapshot.selectionLabelPlantIds).toEqual(new Set())
    expect(projectScenePlantLabels(snapshot, 2).selectionLabels).toEqual([])
  })

  it('preserves hover kind when a Plant and Zone share the same raw id', () => {
    const { controller, sceneStore } = createController()
    sceneStore.updatePersisted((draft) => {
      draft.plants[0] = { ...draft.plants[0]!, id: 'shared-id' }
      draft.zones[0] = { ...draft.zones[0]!, id: 'shared-id', name: 'shared-id' }
    })
    sceneStore.setHoveredTarget({ kind: 'zone', id: 'shared-id' })

    const snapshot = controller.buildRendererSnapshot()

    expect(snapshot.hoveredCanonicalName).toBeNull()
    expect(snapshot.hoverTarget).toEqual({ kind: 'zone', id: 'shared-id', state: 'hover' })
  })

  it('marks hovered targets with locked hover reasons for renderer cues', () => {
    const { controller, sceneStore } = createController()
    sceneStore.updateSession((session) => {
      session.hoveredTarget = { kind: 'zone', id: 'zone-1' }
    })
    sceneStore.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: true } : layer
      ))
    })

    expect(controller.buildRendererSnapshot().hoverTarget).toEqual({
      kind: 'zone',
      id: 'zone-1',
      state: 'locked-layer',
    })

    sceneStore.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: false } : layer
      ))
      draft.zones = draft.zones.map((zone) => (
        zone.id === 'zone-1' ? { ...zone, locked: true } : zone
      ))
    })

    expect(controller.buildRendererSnapshot().hoverTarget).toEqual({
      kind: 'zone',
      id: 'zone-1',
      state: 'locked-design-object',
    })
  })

  it('marks a hovered cross-Layer group locked when any member Layer is locked, and drops a missing hover target', () => {
    const { controller, sceneStore } = createController()
    sceneStore.updatePersisted((draft) => {
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: null,
        members: [{ kind: 'plant', id: 'plant-1' }, { kind: 'zone', id: 'zone-1' }],
      }]
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: true } : layer
      ))
    })
    sceneStore.setHoveredTarget({ kind: 'group', id: 'group-1' })

    expect(controller.buildRendererSnapshot().hoverTarget).toEqual({
      kind: 'group',
      id: 'group-1',
      state: 'locked-layer',
    })

    sceneStore.setHoveredTarget({ kind: 'group', id: 'missing-group' })

    expect(controller.buildRendererSnapshot().hoverTarget).toBeNull()
  })

  it('treats label-only refreshes as presentation changes', async () => {
    vi.mocked(getCommonNames).mockResolvedValue({
      'Malus domestica': 'Pommier',
    })

    const { controller } = createController()
    const result = await controller.refreshSpeciesCacheEntries(['Malus domestica'], 'fr')

    expect(result.changed).toBe(true)
    expect(controller.getLocalizedCommonNames().get('Malus domestica')).toBe('Pommier')
  })

  it('publishes an unpublished label revision through a later cached refresh', async () => {
    vi.mocked(getCommonNames).mockResolvedValue({
      'Malus domestica': 'Pommier',
    })
    const { controller, state } = createController()

    const staleRefresh = await controller.refreshCurrentPresentationData()
    const currentRefresh = await controller.refreshCurrentPresentationData()
    expect(currentRefresh.plantNamesRevision).toBe(staleRefresh.plantNamesRevision)
    expect(currentRefresh.changed).toBe(false)

    expect(controller.publishRefresh(currentRefresh)).toBe(true)

    expect(staleRefresh.plantNamesRevision).toBeGreaterThan(0)
    expect(state.namesChanged).toBe(1)
    expect(controller.publishRefresh(staleRefresh)).toBe(false)
  })
})
