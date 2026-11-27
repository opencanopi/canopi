// @vitest-environment jsdom

import { expect, it, vi } from 'vitest'
import { buildSpeciesKey } from './species-key'
import { geoAt } from '../../__tests__/support/geo-design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { getStratumColor } from '../plants'
import { createDetachedCanvasRuntimeAppAdapter } from '../../__tests__/support/detached-canvas-app-adapter'
import { SceneCanvasRuntime } from './scene-runtime'
import type { SpeciesCacheEntry } from './presentation-data'

it('the species key shows an opened plant\'s stratum colour once the catalog loads', async () => {
  // A saved plant carries no stratum: the key takes its colour from the species catalog, as the canvas does.
  const speciesCache = new Map<string, SpeciesCacheEntry>()
  const renderer = { setSnapshot: vi.fn(), setDraft: vi.fn(), requestRender: vi.fn() }
  const runtime = new SceneCanvasRuntime({
    appAdapter: {
      ...createDetachedCanvasRuntimeAppAdapter(),
      presentationData: {
        speciesCache: {
          getCache: () => speciesCache,
          ensureEntries: async (canonicalNames) => {
            for (const name of canonicalNames) speciesCache.set(name, { canonical_name: name, stratum: 'emergent' })
            return true
          },
          getSuggestedPlantColor: () => null,
        },
        plantLabels: { getLocaleSnapshot: () => new Map(), getEnglishFallbackSnapshot: () => new Map(), ensureEntries: async () => false },
      },
    },
  })
  runtime.connectRenderTarget(renderer)
  runtime.documentSurface.loadDocument({
    version: CURRENT_CANOPI_FILE_VERSION, name: 'Opened', description: null, plant_species_colors: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [{
      id: 'plant-1', canonical_name: 'Malus domestica', common_name: 'Apple', color: null,
      position: geoAt(10, 10, { lon: 0, lat: 0 }), rotation: null, canopy_spread_m: null, notes: null, planted_date: null,
      quantity: 1, locked: false,
    }],
    zones: [], annotations: [], consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z', updated_at: '2026-04-02T00:00:00.000Z', extra: {},
  })
  const keyColor = () => buildSpeciesKey(
    runtime.querySurface.getSceneSnapshot(),
    runtime.querySurface.getSpeciesCache(),
    new Map(),
    new Map(),
    'en',
  )[0]?.appearances[0]?.color
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

  await runtime.init(host)
  await vi.waitFor(() => expect(renderer.setSnapshot).toHaveBeenCalled())

  expect(keyColor()).toBe(getStratumColor('emergent'))
  runtime.destroy()
})

it('2.1-Q94: sorts species by shown name using the interface language collation (Swedish ä/å after z)', () => {
  const runtime = new SceneCanvasRuntime({ appAdapter: createDetachedCanvasRuntimeAppAdapter() })
  runtime.documentSurface.loadDocument({
    version: CURRENT_CANOPI_FILE_VERSION, name: 'Collation', description: null, plant_species_colors: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [
      {
        id: 'p1', canonical_name: 'Malus domestica', common_name: 'Äpple', color: null,
        position: geoAt(0, 0, { lon: 0, lat: 0 }), rotation: null, canopy_spread_m: null, notes: null, planted_date: null,
        quantity: 1, locked: false,
      },
      {
        id: 'p2', canonical_name: 'Ziziphus jujuba', common_name: 'Ziziphus', color: null,
        position: geoAt(5, 0, { lon: 0, lat: 0 }), rotation: null, canopy_spread_m: null, notes: null, planted_date: null,
        quantity: 1, locked: false,
      },
      {
        id: 'p3', canonical_name: 'Alnus glutinosa', common_name: 'Ål', color: null,
        position: geoAt(10, 0, { lon: 0, lat: 0 }), rotation: null, canopy_spread_m: null, notes: null, planted_date: null,
        quantity: 1, locked: false,
      },
    ],
    zones: [], annotations: [], consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z', updated_at: '2026-04-02T00:00:00.000Z', extra: {},
  })
  const snapshot = runtime.querySurface.getSceneSnapshot()
  const cache = runtime.querySurface.getSpeciesCache()

  const svOrder = buildSpeciesKey(snapshot, cache, new Map(), new Map(), 'sv').map((e) => e.commonName)
  const enOrder = buildSpeciesKey(snapshot, cache, new Map(), new Map(), 'en').map((e) => e.commonName)
  expect(svOrder).toEqual(['Ziziphus', 'Ål', 'Äpple'])
  expect(enOrder).toEqual(['Ål', 'Äpple', 'Ziziphus'])
  runtime.destroy()
})
