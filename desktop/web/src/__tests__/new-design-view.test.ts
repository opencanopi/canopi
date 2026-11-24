import { afterEach, describe, expect, it } from 'vitest'
import { persistLastView } from '../app/canvas-map-surface/last-view'
import { resetSettingsProjectionForTests } from '../app/settings/projection'
import { lastView } from '../app/settings/state'
import { createDefaultScenePersistedState, SceneStore } from '../canvas/runtime/scene'
import { DEFAULT_NEW_DESIGN_VIEW } from '../geo/session-plane'
import { mapZoomToStageScale } from '../geo/projection'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { createTestView } from './support/test-view'
import './support/camera-tolerance'

function emptyDesign(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Empty',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
  }
}

/** The 100 m start frame the camera used to place on an 800 x 600 screen. */
const START = { screen: { width: 800, height: 600 }, viewport: { x: 100, y: 0, scale: 6 } }

afterEach(() => {
  resetSettingsProjectionForTests()
  lastView.value = null
})

describe('new Design view', () => {
  it('defaults to the Sahara at zoom 4 without a last view', () => {
    expect(DEFAULT_NEW_DESIGN_VIEW).toEqual({ lon: 13, lat: 23, zoom: 4 })
    expect(new SceneStore().hydrate(emptyDesign()).sessionPlane.origin).toEqual({ lon: 13, lat: 23 })
  })

  it('centres an empty Design on the last view', () => {
    const last = { lon: -1.5536, lat: 47.2184 }
    const store = new SceneStore(() => last).hydrate(emptyDesign())
    expect(store.sessionPlane.origin).toEqual(last)
    store.hydrate(emptyDesign())
    expect(store.sessionPlane.origin).toEqual(last)
  })

  it('centres a Design with objects on its objects, whatever the last view', () => {
    const file = emptyDesign()
    file.plants = [{
      id: 'p', locked: false, canonical_name: 'Malus domestica', common_name: null, color: null,
      pinned_name: false, position: { lon: 5, lat: 45 }, rotation: null, scale: null, notes: null,
      planted_date: null, quantity: null,
    }]
    const store = new SceneStore(() => ({ lon: -1.5536, lat: 47.2184 })).hydrate(file)
    expect(store.sessionPlane.origin).toEqual({ lon: 5, lat: 45 })
  })

  it('fits an empty Design to the plane origin at the requested scale', () => {
    const camera = createTestView(START)
    const { scaleBounds } = camera.frames.viewFrame.peek()
    const scale = mapZoomToStageScale(17, 47.2184)
    camera.setScene(createDefaultScenePersistedState(), { emptySceneScale: scale })
    camera.navigation.zoomToFit()
    const viewport = camera.viewport()
    expect(viewport.x).toBe(400)
    expect(viewport.y).toBe(300)
    expect(viewport.scale).toBeCloseTo(Math.min(Math.max(scale, scaleBounds.min), scaleBounds.max), 12)
  })

  it('remembers the settled view\'s centre and zoom as the last view, not its bearing', () => {
    persistLastView({ lon: 2.3522, lat: 48.8566, zoom: 18.25, bearing: 30 })
    expect(lastView.value).toEqual({ lon: 2.3522, lat: 48.8566, zoom: 18.25 })
  })
})
