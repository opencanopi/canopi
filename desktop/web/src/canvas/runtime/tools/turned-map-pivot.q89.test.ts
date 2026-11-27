// Behavioural tests for 2.1-Q89:
// On a turned map (e.g. bearing 45°), rotation, paste, and saved-object stamps pivot/anchor
// on the centre of the screen-aligned bounding box rather than the world AABB centre.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { geoAt } from '../../../__tests__/support/geo-design'
import { makeTestDesign } from '../../../__tests__/support/session-core-fixture'
import {
  createToolHarness,
  createToolSceneSource,
  type ToolHarness,
} from '../../../__tests__/support/tool-harness'
import { normalizeSavedObjectStampPayload, type SavedObjectStampPayload } from '../../saved-object-stamp-payload'
import { SceneStore, type SceneDesignObjectTarget, type ScenePoint } from '../scene'
import { SceneRuntimeMutationController } from '../scene-runtime/mutations'
import { createDetachedSceneSessionAdapter, SceneRuntimeEditCoordinator } from '../scene-runtime/transactions'
import { degreesToRadians, rotatePointAround } from '../zone-geometry'
import type { DraftShape } from './draft'
import { placeSavedObjectStamp, savedObjectStampGhostShapes } from './saved-object-stamp'
import { createToolScene } from './tool-host'

/**
 * Asymmetric L-shaped polygon in plane metres:
 * - World AABB is [0, 10] x [0, 10] -> world AABB centre is (5, 5).
 * - At bearing 45°, screen axes are right = (√2/2, √2/2), down = (-√2/2, √2/2):
 *   - u = (x + y) * √2/2 spans [0, 12 * √2/2] -> uMid = 6 * √2/2
 *   - v = (-x + y) * √2/2 spans [-10 * √2/2, 10 * √2/2] -> vMid = 0
 *   - Screen-aligned box centre in world coords is (3, 3), 2.828 m from world AABB centre (5, 5).
 */
const L_SHAPE: readonly ScenePoint[] = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 10 }, { x: 0, y: 10 },
]

const WORLD_AABB_CENTER: ScenePoint = { x: 5, y: 5 }
const SCREEN_BOX_CENTER_AT_45: ScenePoint = { x: 3, y: 3 }
const noop = () => {}

const harnesses: ToolHarness[] = []

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

function makeLZoneScene(bearingDeg: number) {
  const file = makeTestDesign({
    name: 'Turned map pivot test',
    zones: [{
      id: 'l-zone', name: 'L-bed', zone_type: 'polygon', rotation: 0,
      points: L_SHAPE.map((p) => geoAt(p.x, p.y)), fill_color: null, notes: null, locked: false,
    }],
  })
  const sceneStore = new SceneStore().hydrate(file)
  const setSelection = (targets: Iterable<SceneDesignObjectTarget>) => sceneStore.setSelection(targets)
  const sceneSession = createDetachedSceneSessionAdapter()
  const sceneEdits = new SceneRuntimeEditCoordinator({
    sceneStore, sceneSession, setSelection,
    incrementSceneRevision: noop, syncCanvasSignalsFromScene: noop, invalidate: noop,
  })
  sceneSession.bindReplay((command, direction) => sceneEdits.replayCommand(command, direction))
  const controller = new SceneRuntimeMutationController({
    sceneStore, selection: { set: setSelection }, sceneEdits,
    commandAdmission: sceneEdits, settledReader: sceneEdits,
    presentation: {
      getViewportScale: () => 1,
      createPlantPresentationContext: (pixelsPerMetre = 1) => ({
        pixelsPerMetre, speciesCache: new Map(), localizedCommonNames: new Map(),
      }),
      getLocalizedCommonNames: () => new Map(),
      getSuggestedPlantColor: () => null,
    },
    getBearingDeg: () => bearingDeg,
    invalidateScene: noop,
  })
  sceneStore.setSelection([{ kind: 'zone', id: 'l-zone' }])
  const before = sceneStore.persisted.zones[0]!.points.map((p) => ({ ...p }))
  const origin = before[0]!
  return {
    controller,
    sceneStore,
    before,
    screenPivot: { x: origin.x + SCREEN_BOX_CENTER_AT_45.x, y: origin.y + SCREEN_BOX_CENTER_AT_45.y },
    worldPivot: { x: origin.x + WORLD_AABB_CENTER.x, y: origin.y + WORLD_AABB_CENTER.y },
  }
}

function lShapeSavedStamp(): SavedObjectStampPayload {
  const normalized = normalizeSavedObjectStampPayload({
    version: 2,
    anchor: { ...WORLD_AABB_CENTER },
    plants: [],
    zones: [{
      id: 'stamp-l-zone', name: 'L-bed', zoneType: 'polygon',
      points: L_SHAPE.map((p) => ({ ...p })), rotationDeg: 0, fillColor: null,
    }],
    annotations: [],
    groups: [],
  })
  if (!normalized) throw new Error('Failed to normalize L-shape stamp payload')
  return normalized
}

function stampedPoints(pivot: ScenePoint, at: ScenePoint, deg: number): ScenePoint[] {
  const rad = degreesToRadians(deg)
  return L_SHAPE.map((p) => {
    const turned = rotatePointAround(p, pivot, rad)
    return { x: turned.x + (at.x - pivot.x), y: turned.y + (at.y - pivot.y) }
  })
}

describe('Turned map screen-aligned pivot and anchor (2.1-Q89)', () => {
  it('rotateSelected pivots on the centre of the screen-aligned box at bearing 45°', () => {
    const { controller, sceneStore, before, screenPivot, worldPivot } = makeLZoneScene(45)

    controller.rotateSelected(90)

    const after = sceneStore.persisted.zones[0]!.points
    const expectedScreen = before.map((p) => rotatePointAround(p, screenPivot, degreesToRadians(90)))
    const expectedWorld = before.map((p) => rotatePointAround(p, worldPivot, degreesToRadians(90)))

    for (let i = 0; i < after.length; i += 1) {
      expect(after[i]!.x).toBeCloseTo(expectedScreen[i]!.x, 4)
      expect(after[i]!.y).toBeCloseTo(expectedScreen[i]!.y, 4)
      expect(Math.hypot(after[i]!.x - expectedWorld[i]!.x, after[i]!.y - expectedWorld[i]!.y)).toBeGreaterThan(2)
    }
  })

  it('pasteAt anchors clipboard contents on the centre of their screen-aligned box at bearing 45°', () => {
    const { controller, sceneStore, before, screenPivot, worldPivot } = makeLZoneScene(45)

    controller.copy()
    const target = { x: 50, y: 60 }
    controller.pasteAt(target)

    expect(sceneStore.persisted.zones).toHaveLength(2)
    const pasted = sceneStore.persisted.zones[1]!.points
    const screenDelta = { x: target.x - screenPivot.x, y: target.y - screenPivot.y }
    const worldDelta = { x: target.x - worldPivot.x, y: target.y - worldPivot.y }

    for (let i = 0; i < pasted.length; i += 1) {
      expect(pasted[i]!.x).toBeCloseTo(before[i]!.x + screenDelta.x, 4)
      expect(pasted[i]!.y).toBeCloseTo(before[i]!.y + screenDelta.y, 4)
      expect(Math.hypot(pasted[i]!.x - (before[i]!.x + worldDelta.x), pasted[i]!.y - (before[i]!.y + worldDelta.y))).toBeGreaterThan(2)
    }
  })

  it('saved-object stamp ghost preview and placement pivot and anchor on the screen-aligned box centre at bearing 45°', () => {
    const h = createToolHarness({ camera: { bearingDeg: 45 } })
    harnesses.push(h)
    const scene = createToolScene(createToolSceneSource(h.store))
    const stamp = lShapeSavedStamp()
    const at = { x: 100, y: 120 }

    // 1. Direct ghost preview and placement API at bearing 45° (with rotationDeg = 45°).
    const ghostShapes = savedObjectStampGhostShapes(scene, stamp, at, 45, 45)
    const ghost = ghostShapes?.find((shape): shape is Extract<DraftShape, { kind: 'ghost' }> => shape.kind === 'ghost')
    expect(ghost?.entity.kind).toBe('objects')
    const ghostPoints = ghost?.entity.kind === 'objects' ? ghost.entity.template.zones[0]!.entity.points : []

    const onCommitted = vi.fn()
    placeSavedObjectStamp(h.edits, scene, stamp, at, { rotationDeg: 45, bearingDeg: 45, onCommitted })
    expect(onCommitted).toHaveBeenCalledOnce()

    const placedPoints = h.store.persisted.zones[0]!.points
    const expectedScreen = stampedPoints(SCREEN_BOX_CENTER_AT_45, at, 45)
    const expectedWorld = stampedPoints(WORLD_AABB_CENTER, at, 45)

    for (let i = 0; i < L_SHAPE.length; i += 1) {
      expect(ghostPoints[i]!.x).toBeCloseTo(expectedScreen[i]!.x, 5)
      expect(ghostPoints[i]!.y).toBeCloseTo(expectedScreen[i]!.y, 5)
      expect(placedPoints[i]!.x).toBeCloseTo(expectedScreen[i]!.x, 5)
      expect(placedPoints[i]!.y).toBeCloseTo(expectedScreen[i]!.y, 5)
      expect(Math.hypot(placedPoints[i]!.x - expectedWorld[i]!.x, placedPoints[i]!.y - expectedWorld[i]!.y)).toBeGreaterThan(2)
    }

    // 2. Through the live saved-object-stamp tool at bearing 45°.
    h.arm('saved-object-stamp', { kind: 'saved-stamp', stamp })
    const clickScreen = { x: 200, y: 150 }
    const clickWorld = h.world(clickScreen)
    h.click(clickScreen)
    expect(h.store.persisted.zones).toHaveLength(2)
    const toolPlaced = h.store.persisted.zones[1]!.points
    const expectedClick = stampedPoints(SCREEN_BOX_CENTER_AT_45, clickWorld, 45)
    for (let i = 0; i < L_SHAPE.length; i += 1) {
      expect(toolPlaced[i]!.x).toBeCloseTo(expectedClick[i]!.x, 5)
      expect(toolPlaced[i]!.y).toBeCloseTo(expectedClick[i]!.y, 5)
    }
  })
})
