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
import { parseSavedObjectStampPayload, type SavedObjectStampPayload } from '../../saved-object-stamp-payload'
import { SceneStore, type SceneDesignObjectTarget, type ScenePoint } from '../scene'
import { SceneRuntimeMutationController } from '../scene-runtime/mutations'
import { createDetachedSceneSessionAdapter, SceneRuntimeEditCoordinator } from '../scene-runtime/transactions'
import { createScreenAlignedBounds, degreesToRadians, rotatePointAround } from '../zone-geometry'
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
  const normalized = parseSavedObjectStampPayload(JSON.stringify({
    version: 2,
    anchor: { ...WORLD_AABB_CENTER },
    plants: [],
    zones: [{
      id: 'stamp-l-zone', name: 'L-bed', zoneType: 'polygon',
      points: L_SHAPE.map((p) => ({ ...p })), rotationDeg: 0, fillColor: null,
    }],
    annotations: [],
    groups: [],
  }))
  if (!normalized) throw new Error('Failed to normalize L-shape stamp payload')
  return normalized
}

function screenBoxCenterOf(points: readonly ScenePoint[], bearingDeg: number): ScenePoint {
  const box = createScreenAlignedBounds(bearingDeg)
  box.addPoints(points)
  return box.center()!
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

  it('saved-object stamp ghost preview and placement centre the turned template on at in screen coordinates at bearing 45°', () => {
    const h = createToolHarness({ camera: { bearingDeg: 45 } })
    harnesses.push(h)
    const scene = createToolScene(createToolSceneSource(h.store))
    const stamp = lShapeSavedStamp()
    const at = { x: 100, y: 120 }

    // 1. Level to the screen (rotationDeg = 45°, bearingDeg = 45°): the ghost and placed zone's screen-box centre equals `at`.
    const levelGhost = savedObjectStampGhostShapes(scene, stamp, at, 45, 45)
      ?.find((shape): shape is Extract<DraftShape, { kind: 'ghost' }> => shape.kind === 'ghost')
    expect(levelGhost?.entity.kind).toBe('objects')
    const levelGhostPoints = levelGhost?.entity.kind === 'objects' ? levelGhost.entity.template.zones[0]!.entity.points : []
    const levelGhostCenter = screenBoxCenterOf(levelGhostPoints, 45)
    expect(levelGhostCenter.x).toBeCloseTo(at.x, 5)
    expect(levelGhostCenter.y).toBeCloseTo(at.y, 5)

    const onCommitted = vi.fn()
    placeSavedObjectStamp(h.edits, scene, stamp, at, { rotationDeg: 45, bearingDeg: 45, onCommitted })
    expect(onCommitted).toHaveBeenCalledOnce()
    const levelPlacedCenter = screenBoxCenterOf(h.store.persisted.zones[0]!.points, 45)
    expect(levelPlacedCenter.x).toBeCloseTo(at.x, 5)
    expect(levelPlacedCenter.y).toBeCloseTo(at.y, 5)

    // 2. Unturned on a 45° map (rotationDeg = 0°, bearingDeg = 45°): still centred on `at` in screen coordinates (distinct from world AABB).
    const unturnedGhost = savedObjectStampGhostShapes(scene, stamp, at, 0, 45)
      ?.find((shape): shape is Extract<DraftShape, { kind: 'ghost' }> => shape.kind === 'ghost')
    const unturnedGhostPoints = unturnedGhost?.entity.kind === 'objects' ? unturnedGhost.entity.template.zones[0]!.entity.points : []
    const unturnedGhostCenter = screenBoxCenterOf(unturnedGhostPoints, 45)
    expect(unturnedGhostCenter.x).toBeCloseTo(at.x, 5)
    expect(unturnedGhostCenter.y).toBeCloseTo(at.y, 5)
    expect(Math.hypot(
      unturnedGhostPoints[0]!.x - (at.x - WORLD_AABB_CENTER.x),
      unturnedGhostPoints[0]!.y - (at.y - WORLD_AABB_CENTER.y),
    )).toBeGreaterThan(2)

    // 3. Through the live saved-object-stamp tool at bearing 45° (both level and after turning with `]`).
    h.arm('saved-object-stamp', { kind: 'saved-stamp', stamp })
    h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    h.host.command({ kind: 'rotate-held', stepDeg: 15 })
    const clickScreen = { x: 200, y: 150 }
    const clickWorld = h.world(clickScreen)
    h.click(clickScreen)
    expect(h.store.persisted.zones).toHaveLength(2)
    const toolPlacedCenter = screenBoxCenterOf(h.store.persisted.zones[1]!.points, 45)
    expect(toolPlacedCenter.x).toBeCloseTo(clickWorld.x, 5)
    expect(toolPlacedCenter.y).toBeCloseTo(clickWorld.y, 5)
  })

  it('saved-object stamp containing a note whose anchor comes from selection.bounds still pivots on the screen-aligned centre at bearing 45°', () => {
    const h = createToolHarness({ camera: { bearingDeg: 45 } })
    harnesses.push(h)
    const scene = createToolScene(createToolSceneSource(h.store))
    // Bare positions span [0, 10] x [0, 10] (world box centre (5, 5); screen box centre at 45° is (2.5, 2.5)).
    // Canvas selection.bounds includes the note text box, offsetting stamp.anchor well beyond 1e-3 m from (5, 5).
    const boundsAnchor = { x: 6.4, y: 5.8 }
    const stamp = parseSavedObjectStampPayload(JSON.stringify({
      version: 2,
      anchor: boundsAnchor,
      plants: [
        {
          id: 'p1', canonicalName: 'Malus domestica', commonName: 'Apple', color: '#4a7c59',
          symbol: null, scale: 2, position: { x: 0, y: 0 }, rotationDeg: 0,
        },
        {
          id: 'p2', canonicalName: 'Malus domestica', commonName: 'Apple', color: '#4a7c59',
          symbol: null, scale: 2, position: { x: 10, y: 0 }, rotationDeg: 0,
        },
      ],
      zones: [],
      annotations: [{
        id: 'n1', annotationType: 'label', position: { x: 0, y: 10 },
        text: 'South edge guild note', fontSize: 14, rotationDeg: 0,
      }],
      groups: [],
    }))!
    const at = { x: 80, y: 90 }

    const ghostShapes = savedObjectStampGhostShapes(scene, stamp, at, 0, 45) ?? []
    const ghostPoints: ScenePoint[] = []
    for (const shape of ghostShapes) {
      if (shape.kind === 'ghost' && shape.entity.kind === 'objects') {
        for (const p of shape.entity.template.plants) ghostPoints.push(p.entity.position)
        for (const a of shape.entity.template.annotations) ghostPoints.push(a.entity.position)
      }
    }
    const ghostCenter = screenBoxCenterOf(ghostPoints, 45)
    expect(ghostCenter.x).toBeCloseTo(at.x, 5)
    expect(ghostCenter.y).toBeCloseTo(at.y, 5)

    const onCommitted = vi.fn()
    placeSavedObjectStamp(h.edits, scene, stamp, at, { rotationDeg: 0, bearingDeg: 45, onCommitted })
    expect(onCommitted).toHaveBeenCalledOnce()
    const placedPoints: ScenePoint[] = [
      ...h.store.persisted.plants.map((p) => p.position),
      ...h.store.persisted.annotations.map((a) => a.position),
    ]
    const placedCenter = screenBoxCenterOf(placedPoints, 45)
    expect(placedCenter.x).toBeCloseTo(at.x, 5)
    expect(placedCenter.y).toBeCloseTo(at.y, 5)
    // Confirm it did not fall back to boundsAnchor (which would place (0, 0) at at - boundsAnchor).
    expect(Math.hypot(
      placedPoints[0]!.x - (at.x - boundsAnchor.x),
      placedPoints[0]!.y - (at.y - boundsAnchor.y),
    )).toBeGreaterThan(2)
  })

  it('saved-object stamp containing unequal plants whose anchor comes from selection.bounds still pivots on the screen-aligned centre at bearing 45°', () => {
    const h = createToolHarness({ camera: { bearingDeg: 45 } })
    harnesses.push(h)
    const scene = createToolScene(createToolSceneSource(h.store))
    // Bare positions span [0, 10] x [0, 10] (world box centre (5, 5); screen box centre at 45° is (2.5, 2.5)).
    // Unequal crowns (8 m spread at (0, 0) vs 2 m spread at (10, 0) and (0, 10)) shift selection.bounds to [-4, 11] x [-4, 11],
    // giving stamp.anchor = (3.5, 3.5), > 1e-3 m from the bare position box centre (5, 5).
    const crownBoundsAnchor = { x: 3.5, y: 3.5 }
    const stamp = parseSavedObjectStampPayload(JSON.stringify({
      version: 2,
      anchor: crownBoundsAnchor,
      plants: [
        {
          id: 'big-tree', canonicalName: 'Castanea sativa', commonName: 'Chestnut', color: '#3b6e4c',
          symbol: null, scale: 8, position: { x: 0, y: 0 }, rotationDeg: 0,
        },
        {
          id: 'small-1', canonicalName: 'Ribes nigrum', commonName: 'Blackcurrant', color: '#5c8a6b',
          symbol: null, scale: 2, position: { x: 10, y: 0 }, rotationDeg: 0,
        },
        {
          id: 'small-2', canonicalName: 'Ribes nigrum', commonName: 'Blackcurrant', color: '#5c8a6b',
          symbol: null, scale: 2, position: { x: 0, y: 10 }, rotationDeg: 0,
        },
      ],
      zones: [],
      annotations: [],
      groups: [],
    }))!
    const at = { x: 110, y: 70 }

    const ghost = savedObjectStampGhostShapes(scene, stamp, at, 0, 45)
      ?.find((shape): shape is Extract<DraftShape, { kind: 'ghost' }> => shape.kind === 'ghost')
    const ghostPoints = ghost?.entity.kind === 'objects'
      ? ghost.entity.template.plants.map((p) => p.entity.position)
      : []
    const ghostCenter = screenBoxCenterOf(ghostPoints, 45)
    expect(ghostCenter.x).toBeCloseTo(at.x, 5)
    expect(ghostCenter.y).toBeCloseTo(at.y, 5)

    const onCommitted = vi.fn()
    placeSavedObjectStamp(h.edits, scene, stamp, at, { rotationDeg: 0, bearingDeg: 45, onCommitted })
    expect(onCommitted).toHaveBeenCalledOnce()
    const placedPoints = h.store.persisted.plants.map((p) => p.position)
    const placedCenter = screenBoxCenterOf(placedPoints, 45)
    expect(placedCenter.x).toBeCloseTo(at.x, 5)
    expect(placedCenter.y).toBeCloseTo(at.y, 5)
    // Confirm it did not fall back to crownBoundsAnchor.
    expect(Math.hypot(
      placedPoints[0]!.x - (at.x - crownBoundsAnchor.x),
      placedPoints[0]!.y - (at.y - crownBoundsAnchor.y),
    )).toBeGreaterThan(1)
  })
})
