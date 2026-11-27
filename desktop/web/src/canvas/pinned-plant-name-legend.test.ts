// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { geoAt } from '../__tests__/support/geo-design'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { buildPinnedPlantNameLegendEntries } from './pinned-plant-name-legend'
import { DEFAULT_PLANT_COLOR } from './plant-colors'
import { DEFAULT_PLANT_DISPLAY } from './runtime/plant-display'
import { resolvePlantDisplayColor } from './runtime/plant-presentation'
import type { SceneRendererSnapshot } from './runtime/renderers/scene-types'
import { createDetachedCanvasRuntimeAppAdapter } from '../__tests__/support/detached-canvas-app-adapter'
import { SceneCanvasRuntime } from './runtime/scene-runtime'
import type { SpeciesCacheEntry } from './runtime/presentation-data'

describe('pinned plant name legend through the runtime', () => {
  // A20: a plant carries no stratum; the canvas colours one without its own colour from the species catalog entries
  // the runtime loads before it first draws it. The legend reads the same entries, and the load advances the
  // plant-names revision DisplayLegend reads, so the legend matches the canvas.
  it('shows an opened plant in the colour the canvas paints it once the species catalog loads', async () => {
    const speciesCache = new Map<string, SpeciesCacheEntry>()
    const renderer = { setSnapshot: vi.fn(), setDraft: vi.fn(), requestRender: vi.fn() }
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createDetachedCanvasRuntimeAppAdapter(),
        presentationData: {
          speciesCache: {
            getCache: () => speciesCache,
            ensureEntries: async (canonicalNames) => {
              for (const name of canonicalNames) {
                speciesCache.set(name, { canonical_name: name, stratum: 'high', width_max_m: 4 } as SpeciesCacheEntry)
              }
              return true
            },
          },
          plantLabels: {
            getLocaleSnapshot: () => new Map(),
            getEnglishFallbackSnapshot: () => new Map(),
            ensureEntries: async () => false,
          },
        },
      },
    })
    runtime.connectRenderTarget(renderer)
    runtime.documentSurface.loadDocument(openedDesignWithPinnedPlant())
    const legendColor = () => buildPinnedPlantNameLegendEntries(runtime.querySurface, DEFAULT_PLANT_DISPLAY, 'en')[0]?.color
    // Before the first frame, the default plant colour is used.
    expect(legendColor()).toBe(DEFAULT_PLANT_COLOR)
    const plantNamesRevision = runtime.querySurface.revision.plantNames.value
    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    await runtime.init(host)
    await vi.waitFor(() => expect(renderer.setSnapshot).toHaveBeenCalled())

    const drawn = renderer.setSnapshot.mock.calls.at(-1)![0] as SceneRendererSnapshot
    const canvasColor = resolvePlantDisplayColor(drawn.scene.plants[0]!, drawn.speciesCache, DEFAULT_PLANT_DISPLAY)
    expect(canvasColor).toBe(DEFAULT_PLANT_COLOR)
    expect(legendColor()).toBe(canvasColor)
    expect(runtime.querySurface.revision.plantNames.value).toBeGreaterThan(plantNamesRevision)
    runtime.destroy()
  })

  it('falls back to the canonical name when commonName is empty', () => {
    const runtime = new SceneCanvasRuntime({ appAdapter: createDetachedCanvasRuntimeAppAdapter() })
    const design = openedDesignWithPinnedPlant()
    design.plants[0]!.common_name = ''
    runtime.documentSurface.loadDocument(design)
    expect(buildPinnedPlantNameLegendEntries(runtime.querySurface, DEFAULT_PLANT_DISPLAY)[0]?.label).toBe('Malus domestica')
    runtime.destroy()
  })

  it('canopi-knon: a Plants layer at zero opacity lists no pinned names, as the canvas draws none', () => {
    const runtime = new SceneCanvasRuntime({ appAdapter: createDetachedCanvasRuntimeAppAdapter() })
    const design = openedDesignWithPinnedPlant()
    runtime.documentSurface.loadDocument(design)
    expect(buildPinnedPlantNameLegendEntries(runtime.querySurface, DEFAULT_PLANT_DISPLAY, 'en')).toHaveLength(1)

    runtime.documentSurface.loadDocument({ ...design, layers: [{ name: 'plants', visible: true, locked: false, opacity: 0 }] })
    expect(buildPinnedPlantNameLegendEntries(runtime.querySurface, DEFAULT_PLANT_DISPLAY, 'en')).toEqual([])
    runtime.destroy()
  })

  it('2.1-Q94: sorts pinned legend entries with the interface language collation (Swedish ä/å after z)', () => {
    const runtime = new SceneCanvasRuntime({ appAdapter: createDetachedCanvasRuntimeAppAdapter() })
    const design = openedDesignWithPinnedPlant()
    runtime.documentSurface.loadDocument({
      ...design,
      plants: [
        { ...design.plants[0]!, id: 'p1', canonical_name: 'Malus domestica', common_name: 'Äpple' },
        { ...design.plants[0]!, id: 'p2', canonical_name: 'Ziziphus jujuba', common_name: 'Ziziphus' },
        { ...design.plants[0]!, id: 'p3', canonical_name: 'Alnus glutinosa', common_name: 'Ål' },
      ],
    })
    expect(buildPinnedPlantNameLegendEntries(runtime.querySurface, DEFAULT_PLANT_DISPLAY, 'sv').map((e) => e.label)).toEqual([
      'Ziziphus', 'Ål', 'Äpple',
    ])
    expect(buildPinnedPlantNameLegendEntries(runtime.querySurface, DEFAULT_PLANT_DISPLAY, 'en').map((e) => e.label)).toEqual([
      'Ål', 'Äpple', 'Ziziphus',
    ])
    runtime.destroy()
  })
})

/** A saved Design as the file holds it: the plant has no colour or stratum of its own. */
function openedDesignWithPinnedPlant(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Opened Design',
    description: null,
    plant_species_colors: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [{
      id: 'plant-1',
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      color: null,
      pinned_name: true,
      position: geoAt(10, 10, { lon: 0, lat: 0 }),
      rotation: null,
      canopy_spread_m: null,
      notes: null,
      planted_date: null,
      quantity: 1,
      locked: false,
    }],
    zones: [],
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
