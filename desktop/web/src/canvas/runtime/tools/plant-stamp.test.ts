import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  createToolSceneSource,
  plantEntity,
  sceneStoreWith,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import { t } from '../../../i18n'
import { DEFAULT_PLANT_COLOR } from '../../plant-colors'
import type { PlantStampSourceInput } from '../../stamp-drag-data'
import { resolvePlantBaseColor } from '../plant-presentation'
import type { SpeciesCacheEntry } from '../presentation-data'
import type { WorldPoint } from '../../../geo/view/types'
import type { DraftShape } from './draft'
import { createPlantStampTool, placePlantFromSpecies } from './plant-stamp'
import { plantEntityFromStampSource } from './tool-actions'
import { createToolScene } from './tool-host'
import '../../../__tests__/support/camera-tolerance'

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const APPLE: PlantStampSourceInput = { canonical_name: 'Malus domestica', common_name: 'Apple', stratum: null, width_max_m: 6 }

/** The species' own symbol radius in CSS px: the plant a click would place, with no plant near it to crowd it. */
function uncrowdedRadiusPx(species: PlantStampSourceInput, pixelsPerMetre: number): number {
  const empty = sceneStoreWith({})
  const plant = plantEntityFromStampSource(empty.persisted, species, { x: 0, y: 0 }, 'probe')
  return createToolScene(createToolSceneSource(empty, { pixelsPerMetre: () => pixelsPerMetre })).plantPresentation(plant).radiusPx
}

const harnesses: ToolHarness[] = []

afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose()
})

/** Place plants armed on a harness at `scale` px/m, with `species` chosen (or none), translated as the app translates it. */
function stampHarness(
  species: PlantStampSourceInput | null = APPLE,
  options: ToolHarnessOptions & { readonly scale?: number } = {},
): ToolHarness {
  useStubTools(createPlantStampTool())
  const { scale = 1, ...rest } = options
  const h = createToolHarness({ viewport: { x: 0, y: 0, scale }, translate: t, ...rest })
  harnesses.push(h)
  h.arm('plant-stamp', species ? { kind: 'species', species } : null)
  return h
}

function shapes(h: ToolHarness): readonly DraftShape[] {
  return h.renderer.lastDraft()?.shapes ?? []
}

function shapesOf<K extends DraftShape['kind']>(h: ToolHarness, kind: K): Extract<DraftShape, { kind: K }>[] {
  return shapes(h).filter((shape): shape is Extract<DraftShape, { kind: K }> => shape.kind === kind)
}

function ghostPlant(h: ToolHarness) {
  const ghost = shapesOf(h, 'ghost')[0]
  return ghost?.entity.kind === 'plant' ? ghost.entity.plant : null
}

describe('Place plants tool', () => {
  it('a press places one plant of the species at the snapped point, with its colour and symbol, selected', () => {
    const h = stampHarness(APPLE, {
      scene: { plantSpeciesColors: { 'Malus domestica': '#C44230' }, plantSpeciesSymbols: { 'Malus domestica': 'canopy' } },
    })

    h.click({ x: 50, y: 70 })

    expect(h.store.persisted.plants).toHaveLength(1)
    expect(h.store.persisted.plants[0]).toMatchObject({
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#C44230',
      symbol: 'canopy',
      position: h.world({ x: 50, y: 70 }),
    })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'plant', id: h.store.persisted.plants[0]!.id }])
    expect(h.history.canUndo.value).toBe(true)
    h.undo()
    expect(h.store.persisted.plants).toHaveLength(0)
  })

  it('a press places nothing while the plants layer is locked', () => {
    const h = stampHarness(APPLE)
    h.store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, locked: true } : layer))
    })

    h.click({ x: 50, y: 70 })

    expect(h.store.persisted.plants).toHaveLength(0)
    expect(h.store.session.selectedTargets).toEqual([])
    expect(h.history.canUndo.value).toBe(false)
  })

  it('a press with no species places nothing and asks for one, each press again, until a species arrives', () => {
    const h = stampHarness(null)
    expect(h.record.guidance.at(-1)?.speciesPrompts).toBe(0)

    h.click({ x: 40, y: 40 })

    expect(h.store.persisted.plants).toHaveLength(0)
    expect(h.record.guidance.at(-1)?.speciesPrompts).toBe(1)
    h.click({ x: 40, y: 40 })
    expect(h.record.guidance.at(-1)?.speciesPrompts, 'each press asks again').toBe(2)

    h.arm('plant-stamp', { kind: 'species', species: APPLE })
    expect(h.record.guidance.at(-1)?.speciesPrompts).toBe(0)
    h.click({ x: 40, y: 40 })
    expect(h.store.persisted.plants).toHaveLength(1)
  })

  it('place-at waits at its snapped point for the species, then places once', () => {
    const h = stampHarness(null, { scale: 4, snapping: { grid: true } })

    // Place plants here, from the menu: the host snaps the point (5 m grid at 4 px/m).
    expect(h.host.command({ kind: 'place-at', world: { x: 13.25, y: 16.75 } })).toBe('handled')
    expect(h.store.persisted.plants).toHaveLength(0)
    expect(h.record.guidance.at(-1)?.speciesPrompts).toBe(1)

    h.arm('plant-stamp', { kind: 'species', species: APPLE })

    expect(h.store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: 15, y: 15 }])
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'plant', id: h.store.persisted.plants[0]!.id }])
    expect(h.record.guidance.at(-1)?.speciesPrompts).toBe(0)

    // The pick is spent: another species places nothing more.
    h.arm('plant-stamp', { kind: 'species', species: { ...APPLE, canonical_name: 'Pyrus communis' } })
    expect(h.store.persisted.plants).toHaveLength(1)
  })

  it('the waiting point holds re-origin but is no Esc layer, and leaves with the tool', () => {
    const h = stampHarness(null)
    h.host.command({ kind: 'place-at', world: { x: 30, y: 20 } })
    expect(h.host.holdsReorigin()).toBe(true)

    // The tool layer's Esc leaves for Select at once (U35); the tool takes no Esc of its own.
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    h.arm('select')
    expect(h.host.holdsReorigin()).toBe(false)

    // The point left with the tool: a pick no longer places there.
    h.arm('plant-stamp', { kind: 'species', species: APPLE })
    expect(h.store.persisted.plants).toHaveLength(0)
  })

  it('place-at with a species chosen places at once', () => {
    const h = stampHarness(APPLE)

    h.host.command({ kind: 'place-at', world: { x: 60, y: 40 } })

    expect(h.store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: 60, y: 40 }])
  })

  it('the drop route\'s placement places a selected plant as one Scene Edit, or nothing on a closed layer', () => {
    const h = stampHarness(null)
    const scene = createToolScene(createToolSceneSource(h.store))
    const committed = vi.fn()

    placePlantFromSpecies({ edits: h.edits, scene }, APPLE, { x: 12, y: 9 }, 'interaction-drop', committed)

    expect(h.store.persisted.plants).toMatchObject([{ canonicalName: 'Malus domestica', position: { x: 12, y: 9 } }])
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'plant', id: h.store.persisted.plants[0]!.id }])
    expect(committed).toHaveBeenCalledOnce()
    const closed = { isLayerOpenForCreation: () => false }
    placePlantFromSpecies({ edits: h.edits, scene: closed }, APPLE, { x: 1, y: 1 }, 'interaction-drop', committed)
    expect(h.store.persisted.plants).toHaveLength(1)
    expect(committed).toHaveBeenCalledOnce()
  })

  describe('the hover preview', () => {
    it('draws the symbol, the mature-width ring and the nearest plant\'s guide, and changes nothing', () => {
      const h = stampHarness(APPLE, {
        scale: 10,
        scene: {
          plants: [
            plantEntity('pear', 'Pyrus communis', { x: 10, y: 10 }, { commonName: 'Pear' }),
            plantEntity('far', 'Prunus avium', { x: 90, y: 90 }),
          ],
        },
      })
      const before = h.store.persisted

      const pointer = h.screen({ x: 13, y: 14 })
      expect(h.hover(pointer)).toEqual({})

      const at: WorldPoint = h.world(pointer)
      expect(ghostPlant(h)).toMatchObject({ canonicalName: 'Malus domestica', position: at })
      expect(shapesOf(h, 'ghost')[0]).toMatchObject({ opacity: 0.85, entity: { mark: 'symbol' } })
      expect(shapesOf(h, 'ellipse')).toEqual([{
        kind: 'ellipse', center: at, radiusX: 3, radiusY: 3, rotationDeg: 0, style: { token: 'draft', widthPx: 1.5, dash: [6, 5] },
      }])
      expect(shapesOf(h, 'polyline')).toEqual([{ kind: 'polyline', points: [at, { x: 10, y: 10 }], style: { token: 'draft', widthPx: 1.5, dash: [4, 4] } }])
      const radiusPx = uncrowdedRadiusPx(APPLE, 10)
      expect(shapesOf(h, 'label')).toEqual([
        { kind: 'label', anchor: { x: at.x, y: at.y - 3 }, offsetPx: { x: 0, y: 0 }, text: 'Mature width up to 6 m', tone: 'hint' },
        { kind: 'label', anchor: at, offsetPx: { x: 0, y: Math.max(radiusPx, 6) + 16 }, text: '5 m to Pear', tone: 'measure' },
      ])
      // The guide and the ring under the symbol, the labels on top.
      expect(shapes(h).map((shape) => shape.kind)).toEqual(['ellipse', 'polyline', 'ghost', 'label', 'label'])
      // The preview replaces the hover restyle and the plant tooltip.
      expect(h.chrome.tooltip).toBeNull()
      expect(h.store.persisted).toEqual(before)
    })

    it('the Place plants ghost of a species not in the Design shows the default plant colour', () => {
      const h = stampHarness({ ...APPLE, stratum: 'emergent' }, { scale: 10 })

      h.hover({ x: 130, y: 140 })

      expect(ghostPlant(h)?.color).toBe(DEFAULT_PLANT_COLOR)
    })

    it('the ghost of a Design species picked without a stratum takes the colour its placed plant draws in', () => {
      const speciesCache = new Map([['Malus domestica', { stratum: 'high' } as SpeciesCacheEntry]])
      const h = stampHarness(APPLE, {
        scale: 10,
        scene: { plants: [plantEntity('tree', 'Malus domestica', { x: 0, y: 0 })] },
      })

      h.hover({ x: 130, y: 140 })
      const ghost = ghostPlant(h)!
      h.click({ x: 130, y: 140 })
      const placed = h.store.persisted.plants.at(-1)!

      expect(resolvePlantBaseColor(placed, speciesCache)).toBe(DEFAULT_PLANT_COLOR)
      expect(resolvePlantBaseColor(ghost, speciesCache)).toBe(DEFAULT_PLANT_COLOR)
    })

    it('has no ring without a mature width and no guide to a plant beyond 320 px', () => {
      const h = stampHarness({ ...APPLE, width_max_m: null }, {
        scale: 10,
        scene: { plants: [plantEntity('far', 'Prunus avium', { x: 90, y: 90 })] },
      })

      h.hover({ x: 130, y: 140 })

      expect(shapes(h).map((shape) => shape.kind)).toEqual(['ghost'])
    })

    it('draws nothing before a species is chosen, and the passive hover runs', () => {
      const h = stampHarness(null, { scale: 10, scene: { plants: [plantEntity('pear', 'Pyrus communis', { x: 13, y: 14 })] } })

      h.hover({ x: 130, y: 140 })

      expect(h.renderer.lastDraft()).toBeNull()
      expect(h.chrome.tooltip).toEqual({ target: { kind: 'plant', id: 'pear' }, at: { x: 130, y: 140 } })
    })

    it('hides when the pointer leaves the map and when the tool changes', () => {
      const h = stampHarness(APPLE, { scale: 10 })

      h.hover({ x: 130, y: 140 })
      expect(ghostPlant(h)).not.toBeNull()
      h.leave()
      expect(h.renderer.lastDraft()).toBeNull()

      h.hover({ x: 130, y: 140 })
      expect(ghostPlant(h)).not.toBeNull()
      h.arm('select')
      expect(h.renderer.lastDraft()).toBeNull()
    })

    it('stays when Place plants is armed again', () => {
      const h = stampHarness(APPLE, { scale: 10 })

      h.hover({ x: 130, y: 140 })
      // P while Place plants is armed: the host cancels the transient interaction, and the tool stays.
      h.arm('plant-stamp', { kind: 'species', species: APPLE })

      expect(ghostPlant(h)).toMatchObject({ position: h.world({ x: 130, y: 140 }) })
    })

    it('hides on entering overview, and shows nothing on the way back until the next hover', () => {
      const h = stampHarness(APPLE, { scale: 10 })

      h.hover({ x: 130, y: 140 })
      h.view.setViewport({ x: 200, y: 150, scale: 0.05 })
      h.advance(0)
      expect(h.renderer.lastDraft()).toBeNull()

      h.view.setViewport({ x: 0, y: 0, scale: 10 })
      h.advance(0)
      expect(h.renderer.lastDraft()).toBeNull()
      h.hover({ x: 130, y: 140 })
      expect(ghostPlant(h)).not.toBeNull()
    })

    it('sets the nearest plant\'s label below the symbol at its crowded radius', () => {
      // At 200 px/m the species' own radius is 6.3 px; 5 cm from a plant the symbol crowds to 4.2 px, under the 6 px floor.
      const h = stampHarness(APPLE, { scale: 200, scene: { plants: [plantEntity('pear', 'Pyrus communis', { x: 0.55, y: 0.5 })] } })
      expect(uncrowdedRadiusPx(APPLE, 200)).toBeGreaterThan(6)

      h.hover({ x: 100, y: 100 })

      const nearest = shapesOf(h, 'label').find((label) => label.tone === 'measure')
      expect(nearest?.offsetPx).toEqual({ x: 0, y: 6 + 16 })
    })

    it('follows a placement to the new nearest plant', () => {
      const h = stampHarness(APPLE, { scale: 10 })

      h.click({ x: 100, y: 100 })
      h.hover({ x: 120, y: 100 })
      expect(h.store.persisted.plants).toHaveLength(1)
      h.hover({ x: 130, y: 100 })

      expect(shapesOf(h, 'label').filter((label) => label.tone === 'measure').map((label) => label.text)).toEqual(['3 m to Apple'])
    })

    it('stays under a still pointer through a wheel zoom', () => {
      const h = stampHarness(APPLE, { scale: 10 })
      const pointer = { x: 130, y: 140 }

      h.hover(pointer)
      h.wheelZoom({ x: 0, y: 0 }, 2)

      expect(ghostPlant(h)!.position).toEqual(h.world(pointer))
    })
  })
})
