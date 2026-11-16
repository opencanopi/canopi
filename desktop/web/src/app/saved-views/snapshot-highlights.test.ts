// @vitest-environment jsdom
//
// Phase 2 commit 0: 2.1-Q352, written before 2d-3 builds it (it.fails until then). A saved view's thumbnail draws the
// view's highlighted objects: the scene its snapshot builds, from the live scene runtime, carries them. 2d-3 turns
// it.fails into it.

import { afterEach, describe, expect, it } from 'vitest'
import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile, SavedView } from '../../types/design'
import { geoAt, TEST_GEO_ORIGIN } from '../../__tests__/support/geo-design'
import { createTestRendererView } from '../../__tests__/support/scene-renderer-snapshot'
import { createDefaultMapLayers } from '../map-layers/state'
import { describeSavedViewSnapshot, VIEW_SNAPSHOT_THUMBNAIL } from './snapshot'

const runtimes: SceneCanvasRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy()
})

const VIEW: SavedView = {
  id: 'apples',
  name: 'Apples',
  camera: { lon: TEST_GEO_ORIGIN.lon, lat: TEST_GEO_ORIGIN.lat, zoom: 19, bearing: 0, ground_size_m: { width: 60, height: 45 } },
  visible_layers: { background: { kind: 'none' }, terrain: { contours: false, hillshade: false }, scene_layers: ['plants'], site_data: [] },
  highlighted: { species: [], objects: [{ kind: 'plant', id: 'p1' }] },
  title: null,
  text: [],
}

function design(): CanopiFile {
  const plant = (id: string, x: number): CanopiFile['plants'][number] => ({
    id, canonical_name: 'Malus domestica', common_name: 'Apple', color: null, position: geoAt(x, 0),
    rotation: null, scale: null, notes: null, planted_date: null, quantity: 1, locked: false,
  })
  return {
    version: CURRENT_CANOPI_FILE_VERSION, name: 'Orchard', description: null, plant_species_colors: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [plant('p1', 0), plant('p2', 5)], zones: [], annotations: [], measurement_guides: [], consortiums: [],
    groups: [], timeline: [], budget: [], budget_currency: 'EUR', views: [VIEW],
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', extra: {},
  }
}

describe('2.1-Q352 saved view thumbnails', () => {
  it.fails('Q352 (2d-3): a saved view thumbnail draws the view highlighted plant', () => {
    const runtime = new SceneCanvasRuntime()
    runtimes.push(runtime)
    runtime.documentSurface.loadDocument(design())
    const request = describeSavedViewSnapshot(VIEW, VIEW_SNAPSHOT_THUMBNAIL, {
      queries: runtime.querySurface, mapLayers: createDefaultMapLayers(), locale: 'en', plantLabels: 'names',
    })
    expect(request, 'the view has a snapshot request').not.toBeNull()
    const scene = request!.scene.build(createTestRendererView({ x: 160, y: 100, scale: 4 }))
    expect([...scene.highlightedPlantIds]).toEqual(['p1'])
  })
})
