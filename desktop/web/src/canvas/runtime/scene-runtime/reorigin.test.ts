// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import '../../../__tests__/support/camera-tolerance'

vi.mock('../../../ipc/species', () => ({
  getSpeciesBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import { createSceneInteractionEventHarness } from '../../../__tests__/support/canvas-interaction-events'
import type { DraftPresentation, DraftShape } from '../tools/draft'
import { geoAt } from '../../../__tests__/support/geo-design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import type { CanopiFile } from '../../../types/design'
import { createSessionPlane, type SessionPlane } from '../../../geo/session-plane'
import { createTestView, placeOnHost } from '../../../__tests__/support/test-view'
import { createDetachedCanvasRuntimeAppAdapter } from '../../../__tests__/support/detached-canvas-app-adapter'
import { SceneCanvasRuntime } from '../scene-runtime'
import { SceneRuntimeReoriginController } from './reorigin'
import type { SceneCommandAdmission, SceneEditCoordinator } from './transactions'
import type { ViewFrame } from '../../../geo/view/types'
import { planarCameraOf } from '../../../geo/view/view-transform'

function makeFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Re-origin demo',
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
      { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
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
      {
        id: 'plant-2',
        canonical_name: 'Pyrus communis',
        common_name: 'Pear',
        color: null,
        position: geoAt(30, 20),
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
        id: 'bed', name: 'bed',
        zone_type: 'rect',
        rotation: 0,
        points: [geoAt(0, 0), geoAt(8, 0), geoAt(8, 6), geoAt(0, 6)],
        fill_color: null,
        notes: null,
        locked: false,
      },
      {
        id: 'pond', name: 'pond',
        zone_type: 'ellipse',
        rotation: 15,
        points: [geoAt(20, 30), geoAt(26, 34)],
        fill_color: null,
        notes: null,
        locked: false,
      },
    ],
    annotations: [{
      id: 'note-1',
      annotation_type: 'text',
      position: geoAt(5, 40),
      text: 'Gate',
      font_size: 14,
      rotation: null,
      locked: false,
    }],
    measurement_guides: [{
      id: 'measurement-guide-1',
      locked: false,
      start: geoAt(0, 50),
      end: geoAt(40, 50),
    }],
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

const SCREEN = { width: 400, height: 300 }
const FAR_EAST_METERS = 20_000

function createRuntime() {
  const runtime = new SceneCanvasRuntime({
    appAdapter: createDetachedCanvasRuntimeAppAdapter(),
  })
  const file = makeFile()
  runtime.documentSurface.loadDocument(file)
  runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
  return { runtime, file }
}

function sessionPlane(runtime: SceneCanvasRuntime): SessionPlane {
  return runtime.querySurface.sessionPlane.value!
}

/** The runtime camera's live frame. */
function frameOf(runtime: SceneCanvasRuntime): ViewFrame {
  return runtime.cameraHost.frames.viewFrame.peek()
}

/** Centres the view on a session-plane point at the given scale. */
function centreViewOn(runtime: SceneCanvasRuntime, point: { x: number; y: number }, scale = 1): void {
  const plane = runtime.querySurface.sessionPlane.peek()!
  const viewPoint = plane.toView(point)
  placeOnHost(runtime.cameraHost, plane,
    { x: SCREEN.width / 2 - viewPoint.x * scale, y: SCREEN.height / 2 - viewPoint.y * scale, scale })
}

function sceneEdits(runtime: SceneCanvasRuntime): SceneEditCoordinator {
  return (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
}

function savedScene(runtime: SceneCanvasRuntime, file: CanopiFile) {
  const content = runtime.documentSurface.captureForPersistence({ name: file.name }, file).content
  return {
    plants: content.plants,
    zones: content.zones,
    annotations: content.annotations,
    measurement_guides: content.measurement_guides,
  }
}

/** A runtime mounted over a renderer stub, with its interaction session live on a 400 × 300 map. */
async function createMountedRuntime() {
  const renderer = { setSnapshot: vi.fn(), setDraft: vi.fn(), requestRender: vi.fn() }
  const runtime = new SceneCanvasRuntime({ appAdapter: createDetachedCanvasRuntimeAppAdapter() })
  runtime.connectRenderTarget(renderer)
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: SCREEN.width })
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: SCREEN.height })
  await runtime.init(container)
  runtime.documentSurface.loadDocument(makeFile())
  runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
  centreViewOn(runtime, { x: 0, y: 0 })
  const events = createSceneInteractionEventHarness(container)
  return {
    runtime,
    container,
    events,
    renderer,
    dispose() {
      events.dispose()
      runtime.destroy()
    },
  }
}

async function settleReorigin(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// Changed positions are saved at 1e-9 degree precision.
function geoNear(point: { lon: number; lat: number }) {
  return { lon: expect.closeTo(point.lon, 8), lat: expect.closeTo(point.lat, 8) }
}

describe('session plane re-origin', () => {
  it('moves the plane origin to a distant view centre without moving any saved lon/lat or dirtying the Design', async () => {
    const { runtime, file } = createRuntime()
    try {
      const before = savedScene(runtime, file)
      const previous = sessionPlane(runtime)
      const farCentre = { x: FAR_EAST_METERS, y: 0 }
      const expectedOrigin = previous.toGeo(farCentre)

      centreViewOn(runtime, farCentre)
      await settleReorigin()

      const next = sessionPlane(runtime)
      expect(next).not.toBe(previous)
      expect(next.origin.lon).toBeCloseTo(expectedOrigin.lon, 9)
      expect(next.origin.lat).toBeCloseTo(expectedOrigin.lat, 9)
      // The camera is reprojected with the plane, so the view stays put.
      const viewport = planarCameraOf(frameOf(runtime).view)
      const centre = {
        x: (SCREEN.width / 2 - viewport.x) / viewport.scale,
        y: (SCREEN.height / 2 - viewport.y) / viewport.scale,
      }
      expect(Math.hypot(centre.x, centre.y)).toBeLessThan(0.01)

      expect(savedScene(runtime, file)).toEqual(before)
      expect(runtime.commandSurface.history.canUndo.value).toBe(false)
      expect(runtime.commandSurface.history.canRedo.value).toBe(false)
    } finally {
      runtime.destroy()
    }
  })

  it('does not re-origin while the view stays within 10 km of the origin', async () => {
    const { runtime } = createRuntime()
    try {
      const previous = sessionPlane(runtime)
      centreViewOn(runtime, { x: 9_000, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).toBe(previous)
    } finally {
      runtime.destroy()
    }
  })

  it('remaps undo history so replayed edits restore the right geographic positions', async () => {
    const { runtime, file } = createRuntime()
    try {
      const original = savedScene(runtime, file).plants[0]!.position
      expect(sceneEdits(runtime).run('move-plant', (tx) => {
        tx.mutate((draft) => {
          draft.plants[0]!.position = { x: draft.plants[0]!.position.x + 3, y: draft.plants[0]!.position.y }
        })
      })).toBe(true)
      const moved = savedScene(runtime, file).plants[0]!.position
      const previous = sessionPlane(runtime)

      centreViewOn(runtime, { x: FAR_EAST_METERS, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).not.toBe(previous)
      expect(savedScene(runtime, file).plants[0]!.position).toEqual(moved)

      runtime.commandSurface.history.undo()
      expect(savedScene(runtime, file).plants[0]!.position).toEqual(original)

      runtime.commandSurface.history.redo()
      expect(savedScene(runtime, file).plants[0]!.position).toEqual(moved)
    } finally {
      runtime.destroy()
    }
  })

  it('pastes a selection copied before re-origin at the same lon/lat plus the paste offset', async () => {
    const { runtime, file } = createRuntime()
    try {
      runtime.commandSurface.sceneEdits.selectAll()
      runtime.commandSurface.sceneEdits.copy()
      const previous = sessionPlane(runtime)
      const copiedPlant = runtime.querySurface.getSceneSnapshot().plants[0]!
      // Paste places copies one metre east of their source.
      const expectedPaste = previous.toGeo({ x: copiedPlant.position.x + 1, y: copiedPlant.position.y })

      centreViewOn(runtime, { x: FAR_EAST_METERS, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).not.toBe(previous)

      runtime.commandSurface.sceneEdits.paste()
      const plants = savedScene(runtime, file).plants
      expect(plants).toHaveLength(4)
      expect(plants[2]!.canonical_name).toBe(copiedPlant.canonicalName)
      expect(plants[2]!.position).toEqual(geoNear(expectedPaste))
    } finally {
      runtime.destroy()
    }
  })

  it('pastes a selection copied in another Design at the same lon/lat plus the paste offset', async () => {
    const { runtime } = createRuntime()
    try {
      runtime.commandSurface.sceneEdits.selectAll()
      runtime.commandSurface.sceneEdits.copy()
      const previous = sessionPlane(runtime)
      const copiedPlant = runtime.querySurface.getSceneSnapshot().plants[0]!
      const expectedPaste = previous.toGeo({ x: copiedPlant.position.x + 1, y: copiedPlant.position.y })

      // The next Design sits 50 km east, so its session plane has a different origin.
      const farOrigin = previous.toGeo({ x: 50_000, y: 0 })
      const other = makeFile()
      other.name = 'Elsewhere'
      other.plants = other.plants.map((plant) => ({ ...plant, position: geoAt(0, 0, farOrigin) }))
      other.zones = []
      other.annotations = []
      other.measurement_guides = []
      other.extra = {}
      runtime.documentSurface.loadDocument(other)
      expect(sessionPlane(runtime)).not.toBe(previous)

      runtime.commandSurface.sceneEdits.paste()
      const plants = savedScene(runtime, other).plants
      expect(plants).toHaveLength(4)
      expect(plants[2]!.canonical_name).toBe(copiedPlant.canonicalName)
      expect(plants[2]!.position).toEqual(geoNear(expectedPaste))
    } finally {
      runtime.destroy()
    }
  })

  it('waits for an active Scene Edit to settle before re-origining', async () => {
    const { runtime } = createRuntime()
    try {
      const previous = sessionPlane(runtime)
      const active = sceneEdits(runtime).begin('interaction-drag')

      centreViewOn(runtime, { x: FAR_EAST_METERS, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).toBe(previous)

      active.abort()
      // The next camera frame after the edit settles re-origins.
      centreViewOn(runtime, { x: FAR_EAST_METERS + 1, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).not.toBe(previous)
    } finally {
      runtime.destroy()
    }
  })

  it('a frame that keeps the placement, screen and mode (a hydration, an inset change) is not observed', async () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    const viewport = { x: SCREEN.width / 2 - FAR_EAST_METERS, y: SCREEN.height / 2, scale: 1 }
    const view = createTestView({ plane, screen: SCREEN, viewport })
    // Refused, so the plane stays and every observed far frame would ask again.
    const reoriginSessionPlane = vi.fn(() => null)
    const controller = new SceneRuntimeReoriginController({
      sceneState: { sessionPlane: plane },
      authority: { reoriginSessionPlane },
      commandAdmission: { runWhenSettled: (run: () => void) => run() } as unknown as SceneCommandAdmission,
      held: () => false,
    })
    try {
      controller.observe(view.frames.viewFrame.peek())
      await settleReorigin()
      expect(reoriginSessionPlane).toHaveBeenCalledOnce()

      view.navigation.setFramingInsets({ top: 40, right: 0, bottom: 0, left: 0 })
      controller.observe(view.frames.viewFrame.peek())
      const hydrated = createTestView({ plane: createSessionPlane({ lon: 13, lat: 23 }), screen: SCREEN, viewport })
      controller.observe(hydrated.frames.viewFrame.peek())
      hydrated.dispose()
      await settleReorigin()
      expect(reoriginSessionPlane).toHaveBeenCalledOnce()

      view.navigation.panByPx({ x: 10, y: 0 })
      controller.observe(view.frames.viewFrame.peek())
      await settleReorigin()
      expect(reoriginSessionPlane).toHaveBeenCalledTimes(2)
    } finally {
      controller.dispose()
      view.dispose()
    }
  })

  it('a live polygon draft holds re-origin, which runs on the last frame once the draft ends', async () => {
    const mounted = await createMountedRuntime()
    const { runtime, events } = mounted
    try {
      runtime.commandSurface.tools.arm('polygon')
      events.pointerDown({ x: 200, y: 150 })
      events.pointerUp({ x: 200, y: 150 })
      events.pointerDown({ x: 250, y: 150 })
      events.pointerUp({ x: 250, y: 150 })
      const previous = sessionPlane(runtime)

      centreViewOn(runtime, { x: FAR_EAST_METERS, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).toBe(previous)

      // Esc steps the draft back to nothing, one corner at a time (A17): the view has not moved since, and the plane
      // moves to its centre.
      runtime.keyboardPort!.escape('tool-transient')
      runtime.keyboardPort!.escape('tool-transient')
      await settleReorigin()
      const next = sessionPlane(runtime)
      expect(next).not.toBe(previous)
      const expectedOrigin = previous.toGeo({ x: FAR_EAST_METERS, y: 0 })
      expect(next.origin.lon).toBeCloseTo(expectedOrigin.lon, 9)
      expect(next.origin.lat).toBeCloseTo(expectedOrigin.lat, 9)
    } finally {
      mounted.dispose()
    }
  })

  it('an open new-note entry holds re-origin', async () => {
    const mounted = await createMountedRuntime()
    const { runtime, events, container } = mounted
    try {
      runtime.commandSurface.tools.arm('text')
      events.pointerDown({ x: 200, y: 150 })
      events.pointerUp({ x: 200, y: 150 })
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
      expect(textarea).not.toBeNull()
      const previous = sessionPlane(runtime)

      centreViewOn(runtime, { x: FAR_EAST_METERS, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).toBe(previous)

      textarea!.value = 'Gate'
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(container.querySelector('textarea')).toBeNull()
      // The note keeps the lon/lat it was typed at.
      const note = runtime.querySurface.getSceneSnapshot().annotations.find((annotation) => annotation.text === 'Gate')
      expect(note).toBeDefined()
      const noteGeo = previous.toGeo(note!.position)
      await settleReorigin()
      const next = sessionPlane(runtime)
      expect(next).not.toBe(previous)
      const saved = runtime.querySurface.getSceneSnapshot().annotations.find((annotation) => annotation.text === 'Gate')!
      expect(next.toGeo(saved.position)).toEqual(geoNear(noteGeo))
    } finally {
      mounted.dispose()
    }
  })

  it('a re-origin with the pointer off the map hides the held stamp\'s ghost until the next hover, which draws it under the pointer in the new plane', async () => {
    const mounted = await createMountedRuntime()
    const { runtime, events, renderer } = mounted
    /** The held stamp's ghost plant in the draft the renderer last drew, or null. */
    const ghostPlant = () => {
      const draft = renderer.setDraft.mock.calls.at(-1)?.[0] as DraftPresentation | null | undefined
      const ghost = (draft?.shapes ?? []).find((shape): shape is Extract<DraftShape, { kind: 'ghost' }> => shape.kind === 'ghost')
      return ghost?.entity.kind === 'objects' ? ghost.entity.template.plants[0]!.entity : null
    }
    try {
      runtime.commandSurface.tools.arm('saved-object-stamp', {
        kind: 'saved-stamp',
        stamp: {
          version: 2,
          anchor: { x: 0, y: 0 },
          plants: [{
            id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
            position: { x: 0, y: 0 }, rotationDeg: null, scale: null,
          }],
          zones: [],
          annotations: [],
          groups: [],
        },
      })
      events.pointerMove({ x: 250, y: 150 })
      events.pointerLeave({ x: 450, y: 150 })
      expect(ghostPlant()).not.toBeNull()
      const previous = sessionPlane(runtime)

      // The held stamp is no transient: the controller does not hold, and the plane moves to the view centre.
      centreViewOn(runtime, { x: FAR_EAST_METERS, y: 0 })
      await settleReorigin()
      expect(sessionPlane(runtime)).not.toBe(previous)
      expect(ghostPlant()).toBeNull()

      events.pointerMove({ x: 120, y: 80 })
      const under = frameOf(runtime).view.screenToWorld({ x: 120, y: 80 })
      expect(ghostPlant()!.position.x).toBeCloseTo(under.x, 6)
      expect(ghostPlant()!.position.y).toBeCloseTo(under.y, 6)
    } finally {
      mounted.dispose()
    }
  })

  it('does not re-origin in overview mode', async () => {
    const { runtime } = createRuntime()
    try {
      const previous = sessionPlane(runtime)
      centreViewOn(runtime, { x: 500_000, y: 0 }, 0.001)
      expect(frameOf(runtime).mode).toBe('overview')
      await settleReorigin()
      expect(sessionPlane(runtime)).toBe(previous)
    } finally {
      runtime.destroy()
    }
  })
})
