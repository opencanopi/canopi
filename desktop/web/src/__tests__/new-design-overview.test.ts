// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { persistLastView } from '../app/canvas-map-surface/last-view'
import { createAppCanvasRuntimeAppAdapter } from '../app/canvas-runtime/app-adapter'
import { createCanvasDocumentReplacementToken } from '../canvas/runtime/runtime'
import { resetSettingsProjectionForTests } from '../app/settings/projection'
import { lastView } from '../app/settings/state'
import { geographicViewOfCamera } from '../geo/session-plane'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { clearCurrentDesignState, replaceCurrentDesignState } from './support/design-session-state'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'

function design(name: string, plants: CanopiFile['plants'] = []): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants,
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

const SITE = { lon: -1.5536, lat: 47.2184 }

function previousSiteDesign(): CanopiFile {
  return design('Previous', [{
    id: 'apple', locked: false, canonical_name: 'Malus domestica', common_name: null, color: null,
    pinned_name: false, position: SITE, rotation: null, scale: null, notes: null,
    planted_date: null, quantity: null,
  }])
}

const hosts: CanvasRuntimeHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.destroy()
  clearCurrentDesignState()
  resetSettingsProjectionForTests()
  lastView.value = null
})

/** New Design (Ctrl N) over an open Design, through the Design Session replacement. */
function newDesignOverOpenDesign(): { lon: number; lat: number; zoom: number } {
  const host = createLiveTestCanvasRuntimeHost({
    screen: { width: 1200, height: 800 },
    appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
  })
  hosts.push(host)
  const { documents: canvas, queries } = host.surfaces
  const previous = previousSiteDesign()
  replaceCurrentDesignState(previous, '/designs/previous.canopi', 'Previous')
  canvas.loadDocument(previous)
  canvas.zoomToFit()

  const next = design('Untitled')
  canvas.replaceDocument(next, createCanvasDocumentReplacementToken(), () => {
    replaceCurrentDesignState(next, null, 'Untitled')
  })
  canvas.zoomToFit()

  return geographicViewOfCamera(queries.view.captureView().camera)
}

describe('New Design opens at an overview', () => {
  it('opens a regional overview around the previous site, not its site-scale camera', () => {
    // The previous Design settled at site scale (about 1:190).
    persistLastView({ ...SITE, zoom: 18.25, bearing: 0 })

    const view = newDesignOverOpenDesign()

    expect(view.lon).toBeCloseTo(SITE.lon, 6)
    expect(view.lat).toBeCloseTo(SITE.lat, 6)
    expect(view.zoom).toBeCloseTo(5, 6)
  })

  it('keeps a last view that is already wider than the regional overview', () => {
    persistLastView({ ...SITE, zoom: 3, bearing: 0 })
    expect(newDesignOverOpenDesign().zoom).toBeCloseTo(3, 6)
  })

  it('opens the world overview when no last view is known', () => {
    const view = newDesignOverOpenDesign()
    expect(view.lon).toBeCloseTo(13, 6)
    expect(view.lat).toBeCloseTo(23, 6)
    expect(view.zoom).toBeCloseTo(4, 6)
  })
})
