// @vitest-environment jsdom

import { effect, signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ipc/species', () => ({
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import { geoAt } from '../../__tests__/support/geo-design'
import { placeOnHost } from '../../__tests__/support/test-view'
import type { WorkspaceMapContributionSnapshot } from '../../app/canvas-map-surface/workspace-map-contribution-adapter'
import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'
import { SETTLE_MS } from '../../geo/view/frame-source'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import { createBrowserWorkspaceMapContributionAdapter } from './browser-workspace-map-contribution-adapter'

afterEach(() => {
  vi.useRealTimers()
})

function design(): CanopiFile {
  const origin = { lon: 2.35, lat: 48.85 }
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Reads',
    description: null,
    plant_species_colors: {},
    layers: [{ name: 'zones', visible: true, locked: false, opacity: 1 }],
    plants: [],
    zones: [{
      id: 'bed', name: 'bed', zone_type: 'rect', rotation: 0,
      points: [geoAt(0, 0, origin), geoAt(8, 0, origin), geoAt(8, 6, origin), geoAt(0, 6, origin)],
      fill_color: null, notes: null, locked: false,
    }],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:00.000Z',
  }
}

/** Moves of the runtime's live camera, as a map gesture or a command makes them. */
function cameraOf(runtime: SceneCanvasRuntime) {
  const driver = () => runtime.cameraHost.current()
  return {
    setViewport: (placement: { x: number; y: number; scale: number }) =>
      placeOnHost(runtime.cameraHost, runtime.querySurface.sessionPlane.peek()!, placement),
    panBy: (deltaPx: { x: number; y: number }) => driver().apply({ kind: 'pan-by', deltaPx }),
    zoomIn: () => runtime.commandSurface.viewport.zoomIn(),
  }
}

describe('browser workspace map contribution reads', () => {
  it('re-read on a settled camera or a mode change, never on a camera frame alone', () => {
    vi.useFakeTimers()
    const runtime = new SceneCanvasRuntime()
    try {
      runtime.documentSurface.loadDocument(design())
      runtime.documentSurface.resize(400, 300)
      const camera = cameraOf(runtime)
      camera.setViewport({ x: 0, y: 0, scale: 2 })
      vi.advanceTimersByTime(SETTLE_MS)
      const adapter = createBrowserWorkspaceMapContributionAdapter({ sessionIdentity: signal({}), hasCurrentDesign: () => true })
      const reads: Array<WorkspaceMapContributionSnapshot | null> = []
      const stop = effect(() => { reads.push(adapter.read(runtime.querySurface)) })
      try {
        expect(reads).toHaveLength(1)

        camera.panBy({ x: 12, y: 0 })
        camera.panBy({ x: 0, y: -7 })
        camera.zoomIn()
        expect(reads).toHaveLength(1)

        vi.advanceTimersByTime(SETTLE_MS)
        expect(reads).toHaveLength(2)

        // Overview drops the panel Targets at once.
        camera.setViewport({ x: 0, y: 0, scale: 0.01 })
        expect(reads).toHaveLength(3)
      } finally {
        stop()
      }
    } finally {
      runtime.destroy()
    }
  })
})
