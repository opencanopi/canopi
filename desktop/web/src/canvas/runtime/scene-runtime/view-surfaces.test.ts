// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import '../../../__tests__/support/camera-tolerance'

vi.mock('../../../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof IpcSpeciesModule>(),
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import { geoAt } from '../../../__tests__/support/geo-design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import type { CanopiFile } from '../../../types/design'
import { stageScaleToMapZoom } from '../../projection'
import type { GeoPosition } from '../../session-plane'
import { AttachedInteractionMap } from '../../../__tests__/support/canvas-interaction-setup'
import { placeOnHost } from '../../../__tests__/support/test-view'
import { createMapLibreCameraDriver } from '../../../maplibre/camera-driver'
import { planarCameraOf } from '../view/view-transform'
import { SceneCanvasRuntime } from '../scene-runtime'
import type * as IpcSpeciesModule from '../../../ipc/species'

const SCREEN = { width: 400, height: 300 }

type DesignZone = CanopiFile['zones'][number]

function bedAt(origin: GeoPosition): DesignZone {
  return {
    id: 'bed', name: 'bed', zone_type: 'rect', rotation: 0,
    points: [geoAt(0, 0, origin), geoAt(8, 0, origin), geoAt(8, 6, origin), geoAt(0, 6, origin)],
    fill_color: null, notes: null, locked: false,
  }
}

function designAt(origin: GeoPosition, name: string, zones: readonly DesignZone[] = [bedAt(origin)]): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
    ],
    plants: [],
    zones: [...zones],
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

/** The runtime camera's bearing-0 placement in today's terms. */
function placementOf(runtime: SceneCanvasRuntime) {
  const { x, y, scale } = planarCameraOf(runtime.cameraHost.frames.viewFrame.peek().view)
  return { x, y, scale }
}

/** A placement on the runtime's live camera, bearing 0, through the runtime's plane. */
function placeAt(runtime: SceneCanvasRuntime, placement: { x: number; y: number; scale: number }): void {
  placeOnHost(runtime.cameraHost, runtime.querySurface.sessionPlane.peek()!, placement)
}

/** Today's reads: the plane viewport interpreted on the Scene's plane (current-view.ts, controller.ts before 0A-2). */
function todaysCapture(runtime: SceneCanvasRuntime) {
  const viewport = placementOf(runtime)
  const { width, height } = runtime.querySurface.view.captureView().screen
  const plane = runtime.querySurface.sessionPlane.peek()!
  const centre = plane.toGeo({ x: (width / 2 - viewport.x) / viewport.scale, y: (height / 2 - viewport.y) / viewport.scale })
  return {
    view: { lon: centre.lon, lat: centre.lat, zoom: stageScaleToMapZoom(viewport.scale, plane.origin.lat) },
  }
}

describe('the runtime view surfaces', () => {
  it('capture the Design\'s ground on a headless runtime, before and after a hydration replaces the plane', () => {
    const runtime = new SceneCanvasRuntime()
    try {
      runtime.documentSurface.loadDocument(designAt({ lon: 2.35, lat: 48.85 }, 'Paris'))
      runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
      placeAt(runtime, { x: 120.5, y: -40.25, scale: 3.5 })

      for (const design of [null, designAt({ lon: -71.06, lat: 42.36 }, 'Boston')]) {
        if (design) runtime.documentSurface.loadDocument(design)
        const today = todaysCapture(runtime)
        const captured = runtime.querySurface.view.captureView()
        // At bearing 0 the headless camera reads as today's arithmetic, within the camera tolerance.
        expect(captured.camera).toEqual({
          center: { lon: today.view.lon, lat: today.view.lat },
          zoom: today.view.zoom,
          bearingDeg: 0,
          pitchDeg: 0,
        })
        expect(captured.screen).toEqual({ ...SCREEN, devicePixelRatio: 1 })
        expect(runtime.querySurface.view.settledCamera.peek()).toBeDefined()
      }
      // The hydration kept the plane placement.
      expect(placementOf(runtime)).toEqual({ x: 120.5, y: -40.25, scale: 3.5 })
    } finally {
      runtime.destroy()
    }
  })

  it('follow every Scene plane change on the runtime\'s camera until it is destroyed', async () => {
    const runtime = new SceneCanvasRuntime()
    const { frames } = runtime.cameraHost
    try {
      runtime.documentSurface.loadDocument(designAt({ lon: 2.35, lat: 48.85 }, 'Paris'))
      runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
      placeAt(runtime, { x: 120.5, y: -40.25, scale: 3.5 })

      // A detached hydration: the camera keeps its plane placement and reads its ground on the Design's plane.
      const beforeHydration = frames.viewFrame.peek().view.planeRevision
      runtime.documentSurface.loadDocument(designAt({ lon: -71.06, lat: 42.36 }, 'Boston'))
      const boston = runtime.querySurface.sessionPlane.peek()!
      const hydrated = frames.viewFrame.peek().view
      expect(hydrated.planeRevision).toBeGreaterThan(beforeHydration)
      expect(placementOf(runtime).x).toBeCloseTo(120.5, 6)
      expect(placementOf(runtime).scale).toBeCloseTo(3.5, 6)
      const centre = boston.toGeo(hydrated.screenToWorld({ x: SCREEN.width / 2, y: SCREEN.height / 2 }))
      expect(hydrated.camera.center.lon).toBeCloseTo(centre.lon, 9)
      expect(hydrated.camera.center.lat).toBeCloseTo(centre.lat, 9)

      // A re-origin: the camera keeps its ground in the new plane.
      placeAt(runtime, { x: SCREEN.width / 2 - 20_000 * 3.5, y: SCREEN.height / 2, scale: 3.5 })
      const shown = runtime.querySurface.view.captureView().camera
      await Promise.resolve()
      await Promise.resolve()
      expect(runtime.querySurface.sessionPlane.peek()).not.toBe(boston)
      const kept = runtime.querySurface.view.captureView().camera
      expect(kept.center.lon).toBeCloseTo(shown.center.lon, 9)
      expect(kept.center.lat).toBeCloseTo(shown.center.lat, 9)
      expect(kept.zoom).toBeCloseTo(shown.zoom, 9)
    } finally {
      runtime.destroy()
    }
    // Destroyed with the runtime: no late frame.
    const last = frames.viewFrame.peek()
    runtime.cameraHost.current().apply({ kind: 'zoom-around', anchorPx: { x: 0, y: 0 }, factor: 2 })
    expect(frames.viewFrame.peek()).toBe(last)
  })

  it('a Design loaded while the map is attached frames in the Design\'s plane', () => {
    const runtime = new SceneCanvasRuntime()
    const map = new AttachedInteractionMap()
    try {
      runtime.documentSurface.loadDocument(designAt({ lon: 2.35, lat: 48.85 }, 'Paris'))
      const paris = runtime.querySurface.sessionPlane.peek()!
      runtime.cameraHost.attach(createMapLibreCameraDriver(map, paris, runtime.cameraHost.driverDeps))
      const centre = runtime.querySurface.view.captureView().camera.center
      map.jumpTo.mockClear()

      runtime.documentSurface.loadDocument(designAt({ lon: 2.4, lat: 48.9 }, 'Vincennes'))

      // The map stays put; the frame reads it in the Design's plane.
      const vincennes = runtime.querySurface.sessionPlane.peek()!
      expect(map.jumpTo).not.toHaveBeenCalled()
      const { view, attached } = runtime.cameraHost.frames.viewFrame.peek()
      expect(attached).toBe(true)
      const atCentre = view.worldToScreen(vincennes.toPlane(centre))
      expect(atCentre.x).toBeCloseTo(view.screen.width / 2, 6)
      expect(atCentre.y).toBeCloseTo(view.screen.height / 2, 6)
    } finally {
      runtime.destroy()
    }
  })

  it('show a camera and fit the selection through the runtime\'s camera', () => {
    const runtime = new SceneCanvasRuntime()
    try {
      const origin = { lon: 2.35, lat: 48.85 }
      runtime.documentSurface.loadDocument(designAt(origin, 'Paris'))
      runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
      const plane = runtime.querySurface.sessionPlane.peek()!
      const target = plane.toGeo({ x: 30, y: -20 })

      runtime.commandSurface.viewport.showCamera({ center: target, zoom: 19, bearingDeg: 30, pitchDeg: 0 }, { motion: 'jump' })

      const shown = runtime.querySurface.view.captureView().camera
      expect(shown.center.lon).toBeCloseTo(target.lon, 9)
      expect(shown.center.lat).toBeCloseTo(target.lat, 9)
      expect(shown.zoom).toBeCloseTo(19, 9)
      expect(shown.bearingDeg).toBe(30)
      expect(runtime.querySurface.view.bearingDeg.peek()).toBe(30)

      runtime.commandSurface.sceneEdits.selectAll()
      runtime.commandSurface.viewport.zoomToSelection()

      // The bed fills the screen at the kept bearing: its centre is the screen centre's ground.
      const fitted = runtime.querySurface.view.captureView().camera
      expect(fitted.bearingDeg).toBe(30)
      const bedCentre = plane.toPlane(fitted.center)
      const bed = runtime.querySurface.getDesignObjectSelection().bounds!
      expect(bedCentre.x).toBeCloseTo((bed.minX + bed.maxX) / 2, 6)
      expect(bedCentre.y).toBeCloseTo((bed.minY + bed.maxY) / 2, 6)
      expect(fitted.zoom).toBeGreaterThan(19)
    } finally {
      runtime.destroy()
    }
  })

  it('fit the selection\'s own outline at the bearing, never its world-axis box', () => {
    const runtime = new SceneCanvasRuntime()
    try {
      const origin = { lon: 2.35, lat: 48.85 }
      // A path 28 m long and 1.4 m wide, along the south-east diagonal.
      const path: DesignZone = {
        id: 'path', name: 'path', zone_type: 'polygon', rotation: 0,
        points: [geoAt(0, 0, origin), geoAt(20, 20, origin), geoAt(19, 21, origin), geoAt(-1, 1, origin)],
        fill_color: null, notes: null, locked: false,
      }
      runtime.documentSurface.loadDocument(designAt(origin, 'Paris', [path]))
      runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
      const plane = runtime.querySurface.sessionPlane.peek()!
      runtime.commandSurface.viewport.showCamera(
        { center: plane.toGeo({ x: 0, y: 0 }), zoom: 17, bearingDeg: 45, pitchDeg: 0 },
        { motion: 'jump' },
      )

      runtime.commandSurface.sceneEdits.selectAll()
      runtime.commandSurface.viewport.zoomToSelection()

      // At 45 the path runs along screen-right, so its length spans the framing width less the padding; the corners of its
      // world-axis box would also reach 29 m down the screen and fit further out.
      const [start, end, , back] = path.points.map((point) => plane.toPlane(point))
      const along = ((end!.x - start!.x) + (end!.y - start!.y)) * Math.SQRT1_2
      expect(placementOf(runtime).scale).toBeCloseTo((SCREEN.width * 0.8) / along, 6)
      const centre = plane.toPlane(runtime.querySurface.view.captureView().camera.center)
      expect(centre.x).toBeCloseTo((back!.x + end!.x) / 2, 6)
      expect(centre.y).toBeCloseTo((back!.y + end!.y) / 2, 6)
    } finally {
      runtime.destroy()
    }
  })

  it('put the inspection lens on the ground under the screen at the live bearing', () => {
    vi.useFakeTimers()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const runtime = new SceneCanvasRuntime()
    try {
      const origin = { lon: 2.35, lat: 48.85 }
      runtime.documentSurface.loadDocument(designAt(origin, 'Paris'))
      runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
      const plane = runtime.querySurface.sessionPlane.peek()!
      const target = { x: 30, y: -20 }
      runtime.commandSurface.viewport.showCamera(
        { center: plane.toGeo(target), zoom: 19, bearingDeg: 30, pitchDeg: 0 },
        { motion: 'jump' },
      )
      const scale = placementOf(runtime).scale
      const lens = runtime.documentSurface.attachInspectionTo(document.createElement('div'))

      lens.centerOnCanvas()
      vi.advanceTimersByTime(20)
      expect(lens.state.value!.point.x).toBeCloseTo(target.x, 6)
      expect(lens.state.value!.point.y).toBeCloseTo(target.y, 6)

      // 40 px right of the centre and 30 px down: screen-right is (cos 30, sin 30) on the ground, screen-down (-sin 30, cos 30).
      lens.inspectAtScreenPoint({ x: SCREEN.width / 2 + 40, y: SCREEN.height / 2 + 30 })
      vi.advanceTimersByTime(20)
      const cos = Math.cos(Math.PI / 6)
      const sin = Math.sin(Math.PI / 6)
      expect(lens.state.value!.point.x).toBeCloseTo(target.x + (40 * cos - 30 * sin) / scale, 6)
      expect(lens.state.value!.point.y).toBeCloseTo(target.y + (40 * sin + 30 * cos) / scale, 6)
      lens.dispose()
    } finally {
      runtime.destroy()
      getContext.mockRestore()
      vi.useRealTimers()
    }
  })
})
