// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof IpcSpeciesModule>(),
  getSpeciesBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from '../../__tests__/support/canvas-interaction-events'
import { createTestSceneCanvasRuntime } from '../../__tests__/support/detached-canvas-app-adapter'
import { createSessionPlane } from '../../geo/session-plane'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import type { SceneCanvasRuntime } from './scene-runtime'
import type { PointerWorld } from './interaction-ports'
import type * as IpcSpeciesModule from '../../ipc/species'

const harnesses: SceneInteractionEventHarness[] = []

afterEach(() => {
  for (const events of harnesses.splice(0)) events.dispose()
  document.body.replaceChildren()
})

async function mountedRuntime(): Promise<{ runtime: SceneCanvasRuntime, container: HTMLDivElement, events: SceneInteractionEventHarness }> {
  const runtime = createTestSceneCanvasRuntime()
  runtime.connectRenderTarget({ setSnapshot: vi.fn(), setDraft: vi.fn(), requestRender: vi.fn() })
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
  await runtime.init(container)
  const events = createSceneInteractionEventHarness(container)
  harnesses.push(events)
  return { runtime, container, events }
}

describe('the runtime query surface', () => {
  it('subscribePointerWorld hears the live interaction session over the map, and nothing once the map unmounts', async () => {
    const { runtime, container, events } = await mountedRuntime()
    const points: (PointerWorld | null)[] = []
    const stop = runtime.querySurface.subscribePointerWorld((point) => { points.push(point) })

    // A button-less move over the map itself is heard; one over the page beside it is not.
    events.pointerMove({ x: 100, y: 80 }, { target: container, buttons: 0 })
    events.pointerMove({ x: 110, y: 80 }, { target: document.body, buttons: 0 })
    const { frames } = runtime.cameraHost
    const expected = frames.viewFrame.peek().view.screenToWorld({ x: 100, y: 80 })
    expect(points).toHaveLength(1)
    expect(points[0]!.world.x).toBeCloseTo(expected!.x, 9)
    expect(points[0]!.world.y).toBeCloseTo(expected!.y, 9)
    expect(points[0]!.screen).toEqual({ x: 100, y: 80 })
    expect(points[0]!.pointerKind).toBe('mouse')
    events.pointerLeave({ x: 100, y: 80 })
    expect(points.at(-1)).toBeNull()

    expect(runtime.keyboardPort).not.toBeNull()
    await runtime.unmountRenderer()
    expect(runtime.keyboardPort).toBeNull()
    events.pointerMove({ x: 120, y: 90 }, { target: container, buttons: 0 })
    expect(points).toHaveLength(2)
    stop()
    runtime.destroy()
  })

  it('the pointer ends with the map: an unmount with the mouse still over it publishes null', async () => {
    const { runtime, container, events } = await mountedRuntime()
    const points: (PointerWorld | null)[] = []
    const stop = runtime.querySurface.subscribePointerWorld((point) => { points.push(point) })

    events.pointerMove({ x: 100, y: 80 }, { target: container, buttons: 0 })
    expect(points.at(-1)).not.toBeNull()
    // A map failure unmounts the renderer; until Retry no cursor is over a map, so nothing reads the old point.
    await runtime.unmountRenderer()

    expect(points).toHaveLength(2)
    expect(points.at(-1)).toBeNull()
    stop()
    runtime.destroy()
  })

  it('a pointer feed subscribed before a Retry is heard from the session remountRenderer mounts', async () => {
    const { runtime, container, events } = await mountedRuntime()
    const points: (PointerWorld | null)[] = []
    const stop = runtime.querySurface.subscribePointerWorld((point) => { points.push(point) })
    await runtime.unmountRenderer()

    await runtime.remountRenderer(container)
    events.pointerMove({ x: 60, y: 40 }, { target: container, buttons: 0 })

    const expected = runtime.cameraHost.frames.viewFrame.peek().view.screenToWorld({ x: 60, y: 40 })
    expect(points).toHaveLength(1)
    expect(points[0]!.world.x).toBeCloseTo(expected.x, 9)
    expect(points[0]!.world.y).toBeCloseTo(expected.y, 9)
    stop()
    runtime.destroy()
  })

  it('getSettledDesignOutline returns rotated rectangle zone corners in WGS84 from the zone kernel (2.1-Q45)', () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    const unrotated = [
      plane.toGeo({ x: -50, y: -10 }),
      plane.toGeo({ x: 50, y: -10 }),
      plane.toGeo({ x: 50, y: 10 }),
      plane.toGeo({ x: -50, y: 10 }),
    ]
    const file: CanopiFile = {
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Rotated zone',
      description: null,
      plant_species_colors: {},
      layers: [{ name: 'zones', visible: true, locked: false, opacity: 1 }],
      plants: [],
      zones: [{
        id: 'rect-1',
        name: 'Rotated',
        zone_type: 'rect',
        rotation: 45,
        points: unrotated,
        fill_color: null,
        notes: null,
        locked: false,
      }],
      annotations: [],
      measurement_guides: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    }
    const runtime = createTestSceneCanvasRuntime()
    try {
      runtime.documentSurface.loadDocument(file)
      const outline = runtime.querySurface.getSettledDesignOutline()
      expect(outline).toHaveLength(4)
      const maxLat = Math.max(...outline!.map((point) => point.lat))
      const unrotatedMaxLat = Math.max(...unrotated.map((point) => point.lat))
      // Rotating the 100 m x 20 m rectangle 45° pushes its northern corner well past the unrotated ±10 m band.
      expect(maxLat).toBeGreaterThan(unrotatedMaxLat + 0.0002)
    } finally {
      runtime.destroy()
    }
  })
})
