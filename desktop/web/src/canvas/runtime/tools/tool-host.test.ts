// @vitest-environment jsdom

import { effect, signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  createToolSceneSource,
  plantEntity,
  rectZone,
  sceneStoreWith,
  stubTool,
  useStubTools,
  type StubTool,
  type StubToolBehaviour,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import { createTestView } from '../../../__tests__/support/test-view'
import { closeCanvasContextMenu, openCanvasContextMenu } from '../../../app/canvas-context-menu/state'
import { CanvasContextMenu } from '../../../components/canvas/CanvasContextMenu'
import { gridInterval, snapToGrid } from '../../grid'
import { CanvasRuntimeCleanupError } from '../cleanup'
import type { PlantStampSourceInput } from '../../plant-stamp-source'
import { normalizeSavedObjectStampPayload } from '../../saved-object-stamp-payload'
import type { CanvasContextMenuCommands, CanvasContextMenuRequest } from '../app-adapter'
import type { CanvasDropPayload, ToolHandleId, ToolId } from '../interaction-types'
import type { SceneDesignObjectTarget } from '../scene/design-object-targets'
import type { SceneEditCoordinator, SceneEditTransaction } from '../scene-runtime/transactions'
import type { WorldPoint } from '../view/types'
import { getRectangularZoneCorners } from '../zone-geometry'
import { applyToolConstraint } from './constraints'
import type { DraftPresentation, DraftShape, ToolHandle } from './draft'
import { measureLabelShapes, selectedZoneMeasurementLabels } from './measure-labels'
import type { ToolReply } from './tool'
import { TOOL_REGISTRY, type ToolFactory } from './registry'
import { contextMenuTargetAt, createContextMenuPort, createToolScene } from './tool-host'
import { createPolygonTool } from './polygon'
import '../../../__tests__/support/camera-tolerance'

/** Shift at bearing 0: the nearest 45° direction from `origin` against the world axes, its length kept. */
function constrainPointTo45Degrees(origin: WorldPoint, point: WorldPoint): WorldPoint {
  return applyToolConstraint({ kind: 'direction', origin, stepDeg: 45 }, point, { right: { x: 1, y: 0 }, down: { x: 0, y: 1 } })
}

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  useStubTools()
})

const P1: SceneDesignObjectTarget = { kind: 'plant', id: 'p1' }
const Z1: SceneDesignObjectTarget = { kind: 'zone', id: 'z1' }
const OVERVIEW = { x: 200, y: 150, scale: 0.05 }

function appleAt(position: WorldPoint, overrides: Parameters<typeof plantEntity>[3] = {}) {
  return plantEntity('p1', 'Malus domestica', position, { commonName: 'Apple', ...overrides })
}

function bed() {
  return rectZone('z1', [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 60 }, { x: 10, y: 60 }])
}

function selectedZoneChips(h: ToolHarness): DraftShape[] {
  return measureLabelShapes(
    selectedZoneMeasurementLabels(h.store.persisted, [Z1]),
    (a, b) => h.view.view().screenDistance(a, b),
  )
}

describe('ToolHost', () => {
  describe('points', () => {
    it('holds re-origin while a press is live, the tool has a transient or the text entry is open', () => {
      let transient = false
      const rectangle = stubTool('rectangle', { hasTransient: () => transient })
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle' })
      expect(h.host.holdsReorigin()).toBe(false)

      h.press({ x: 100, y: 100 })
      expect(h.host.holdsReorigin()).toBe(true)
      h.move({ x: 150, y: 120 })
      h.release()
      expect(h.host.holdsReorigin()).toBe(false)

      transient = true
      expect(h.host.holdsReorigin()).toBe(true)
      transient = false

      h.openTextEntry()
      expect(h.host.holdsReorigin()).toBe(true)
      h.enterText()
      expect(h.host.holdsReorigin()).toBe(false)
    })

    it('a plane change hides the tool\'s ghost until the next hover', () => {
      const ghost: DraftShape = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], style: { token: 'draft', widthPx: 1 } }
      // A ghost that stays when the pointer leaves the map, as the stamps' do.
      const stamp: StubTool = stubTool('object-stamp', {
        gesture: (g) => {
          if (g.kind === 'hover') stamp.ctx().effects.setDraft({ shapes: [ghost] })
          return 'pass'
        },
      })
      useStubTools(stamp)
      const h = harness({ tool: 'object-stamp' })

      h.hover({ x: 100, y: 100 })
      h.leave()
      expect(h.renderer.lastDraft()?.shapes).toEqual([ghost])

      h.reorigin({ lon: 0.01, lat: 0.005 })
      expect(h.renderer.lastDraft()).toBeNull()

      h.hover({ x: 120, y: 100 })
      expect(h.renderer.lastDraft()?.shapes).toEqual([ghost])
    })

    it('a plane change under a still pointer on the map keeps the tool\'s ghost, re-emitted at the pointer', () => {
      const hovers: WorldPoint[] = []
      const stamp: StubTool = stubTool('object-stamp', {
        gesture: (g) => {
          if (g.kind !== 'hover') return 'pass'
          hovers.push(g.point.world)
          stamp.ctx().effects.setDraft({ shapes: [{ kind: 'polyline', points: [g.point.world, g.point.world], style: { token: 'draft', widthPx: 1 } }] })
          return 'handled'
        },
      })
      useStubTools(stamp)
      const h = harness({ tool: 'object-stamp' })

      h.hover({ x: 100, y: 100 })
      h.reorigin({ lon: 0.01, lat: 0.005 })
      h.advance(0)

      const at = h.world({ x: 100, y: 100 })
      expect(hovers.at(-1)).toEqual(at)
      expect(h.renderer.lastDraft()?.shapes).toEqual([{ kind: 'polyline', points: [at, at], style: { token: 'draft', widthPx: 1 } }])
    })

    it('constraint wins, then length snaps along the ray', () => {
      const origin = { x: 0, y: 0 }
      for (const id of ['polygon', 'plant-spacing', 'line', 'measurement-guide'] as const) {
        const tool = stubTool(id, { constraint: () => ({ kind: 'direction', origin, stepDeg: 45 }) })
        useStubTools(tool)
        const h = harness({ tool: id, viewport: { x: 0, y: 0, scale: 10 }, snapping: { grid: true } })
        const interval = gridInterval(10).interval
        const at = { x: 473, y: 191 }
        const raw = h.world(at)
        const constrained = constrainPointTo45Degrees(origin, raw)
        const length = Math.hypot(constrained.x, constrained.y)
        const stepped = Math.round(length / interval) * interval

        h.hover(at, { shift: true })
        const point = tool.last('hover')!.point
        expect(point.world).toEqual(raw)
        expect(point.free).toEqual(snapToGrid(raw.x, raw.y, interval))
        expect(point.constrained).toEqual(constrained)
        // The Shift point stays on its 45° ray, its length a whole number of grid steps.
        expect(Math.atan2(point.snapped.y, point.snapped.x)).toBeCloseTo(Math.atan2(constrained.y, constrained.x), 9)
        expect(Math.hypot(point.snapped.x, point.snapped.y)).toBeCloseTo(stepped, 9)
        expect(point.modifiers).toMatchObject({ constrain: true, noSnap: false, additive: true })

        h.hover(at)
        expect(tool.last('hover')!.point).toMatchObject({ constrained: raw, snapped: snapToGrid(raw.x, raw.y, interval) })
      }
    })

    it('Ctrl or Cmd is Plant a row\'s no-snap, and Shift constrains only the drawing tools and the rotate handle', () => {
      const row = stubTool('plant-spacing')
      const select = stubTool('select')
      useStubTools(row, select)
      const h = harness({ tool: 'plant-spacing', viewport: { x: 0, y: 0, scale: 10 }, snapping: { grid: true } })
      const at = { x: 473, y: 191 }

      for (const mods of [{ ctrl: true }, { meta: true }]) {
        h.hover(at, mods)
        expect(row.last('hover')!.point).toMatchObject({ snapped: h.world(at), modifiers: { noSnap: true, constrain: false } })
      }
      h.arm('select')
      h.hover(at, { shift: true, ctrl: true, alt: true })
      expect(select.last('hover')!.point.modifiers).toEqual({ additive: true, subtractive: true, constrain: false, noSnap: false })
    })

    it('Shift steps only the rotate handle: a point handle ignores it and snaps as usual (U36)', () => {
      const select = stubTool('select')
      useStubTools(select)
      const h = harness({ viewport: { x: 0, y: 0, scale: 10 }, snapping: { grid: true } })
      const at = { x: 473, y: 191 }
      const interval = gridInterval(10).interval

      h.press(at, { mods: { shift: true }, target: { kind: 'handle', id: 'zone-corner:z1:0' as ToolHandleId } })
      h.move({ x: 481, y: 203 }, { shift: true })
      const corner = select.last('handle-drag')!.point
      expect(corner.modifiers.constrain).toBe(false)
      expect(corner.snapped).toEqual(snapToGrid(48.1, 20.3, interval))
      h.release()

      h.press(at, { mods: { shift: true }, target: { kind: 'handle', id: 'rotate' as ToolHandleId } })
      expect(select.last('handle-drag')!.point.modifiers.constrain).toBe(true)
      h.release()
    })

    it('snapping follows the settings at each point', () => {
      const rectangle = stubTool('rectangle')
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle', snapping: { grid: true } })
      const at = { x: 123, y: 77 }

      h.hover(at)
      expect(rectangle.last('hover')!.point.snapped).toEqual(snapToGrid(123, 77, gridInterval(1).interval))
      expect(rectangle.ctx().snap({ x: 124, y: 3 })).toEqual(snapToGrid(124, 3, gridInterval(1).interval))

      h.snapping = { grid: false }
      h.hover(at)
      expect(rectangle.last('hover')!.point.snapped).toEqual(h.world(at))
    })

    it('place-at is snapped and ignored in overview', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ snapping: { grid: true } })

      h.host.command({ kind: 'place-at', world: { x: 13.2, y: 27.9 } })
      expect(h.toolState.peek()).toBe('plant-stamp')
      expect(stamp.commands).toEqual([
        { kind: 'place-at', world: snapToGrid(13.2, 27.9, gridInterval(1).interval) },
      ])

      const overview = harness({ viewport: OVERVIEW })
      expect(overview.host.command({ kind: 'place-at', world: { x: 13.2, y: 27.9 } })).toBe('pass')
      expect(overview.toolState.peek()).toBe('select')
      expect(stamp.commands).toHaveLength(1)
    })
  })

  describe('the view moving under a still pointer (plan §1, exception 1)', () => {
    it('a drag start stays on the ground through a wheel zoom', () => {
      const rectangle = stubTool('rectangle')
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle' })
      const press = { x: 100, y: 100 }
      const ground = h.world(press)

      h.press(press)
      h.move({ x: 160, y: 140 })
      h.wheelZoom({ x: 300, y: 200 }, 2)
      expect(h.world(press)).not.toEqual(ground)
      h.move({ x: 170, y: 150 })
      expect(rectangle.last('drag-move')!.start.world).toEqual(ground)
      h.release({ x: 170, y: 150 })
      expect(rectangle.last('drag-end')!.start.world).toEqual(ground)
    })

    it('Shift+→ during a left drag keeps the draft\'s start on the ground', () => {
      vi.useFakeTimers()
      try {
        const rectangle = stubTool('rectangle')
        useStubTools(rectangle)
        const h = harness({ tool: 'rectangle' })
        const press = { x: 100, y: 100 }
        const ground = h.world(press)

        h.press(press)
        h.move({ x: 160, y: 140 })
        // Shift+→ is the keyboard's rotate-view, a 15° turn about the centre (ViewNavigation.rotateBy).
        h.view.navigation.rotateBy(1)
        vi.advanceTimersByTime(400)
        expect(h.view.view().camera.bearingDeg).toBe(15)
        expect(h.world(press)).not.toEqual(ground)
        // Each camera frame of the turn re-emitted the drag from the press's ground.
        expect(rectangle.last('drag-move')!.start.world).toEqual(ground)
        expect(rectangle.last('drag-move')!.point.world).toEqual(h.world({ x: 160, y: 140 }))
        h.release({ x: 170, y: 150 })
        expect(rectangle.last('drag-end')!.start.world).toEqual(ground)
      } finally {
        vi.useRealTimers()
      }
    })

    it('the draft stays under the cursor through a right-drag pan', () => {
      useStubTools(createPolygonTool())
      const h = harness({ tool: 'polygon' })
      h.click({ x: 100, y: 100 })
      h.click({ x: 160, y: 100 })
      const corners = [h.world({ x: 100, y: 100 }), h.world({ x: 160, y: 100 })]
      h.hover({ x: 200, y: 150 })

      // The right press reaches the host only as a raw press; the recogniser pans while the pointer moves.
      h.host.rawPress('secondary', { kind: 'surface' })
      h.pan({ x: 200, y: 150 }, { x: 260, y: 190 })

      const band = h.renderer.lastDraft()!.shapes.find((shape) => shape.kind === 'polyline')
      const points = band?.kind === 'polyline' ? band.points : []
      // The corners stay on the ground, and the rubber band ends under the moved pointer.
      expect(points.slice(0, 2)).toEqual(corners)
      expect(h.view.view().worldToScreen(points[2]!).x).toBeCloseTo(260, 6)
      expect(h.view.view().worldToScreen(points[2]!).y).toBeCloseTo(190, 6)
      expect(h.host.activeToolHasEscapeTransient()).toBe(true)
    })

    it('re-emits the drag on a camera frame', () => {
      const rectangle = stubTool('rectangle')
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle' })
      const ground = h.world({ x: 100, y: 100 })

      h.press({ x: 100, y: 100 })
      h.move({ x: 160, y: 140 })
      expect(rectangle.count('drag-move')).toBe(0)
      h.wheelZoom({ x: 300, y: 200 }, 2)

      expect(rectangle.count('drag-move')).toBe(1)
      const reemitted = rectangle.last('drag-move')!
      expect(reemitted.point.world).toEqual(h.world({ x: 160, y: 140 }))
      expect(reemitted.start.world).toEqual(ground)
      expect(rectangle.calls).not.toContain('viewChanged')
    })

    it('a camera frame under a resting pointer re-emits only the tool\'s hover and hides the tooltip; the hover stays on its object until the next pointer move; the ghost still follows (Q3 D)', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp', scene: { plants: [appleAt({ x: 50, y: 50 })] } })
      const pointer = { x: 50, y: 50 }

      h.hover(pointer)
      expect(h.record.hovers).toEqual([P1])
      expect(h.chrome.tooltip).toEqual({ target: P1, at: pointer })
      // A pan and a zoom carry the apple away from the still pointer: the tool hears its hover at the pointer each frame,
      // so its ghost stays under it, while the apple keeps its ring and the tooltip hides.
      h.view.navigation.panByPx({ x: 120, y: 0 })
      h.wheelZoom({ x: 0, y: 0 }, 2)

      expect(stamp.count('hover')).toBe(3)
      expect(stamp.last('hover')!.point.world).toEqual(h.world(pointer))
      expect(h.record.hovers).toEqual([P1])
      expect(h.chrome.tooltip).toBeNull()
      // A re-emit is not a pointer move: the inspection lens keeps its point.
      expect(h.record.pointerWorld).toHaveLength(1)
      expect(stamp.calls).not.toContain('viewChanged')

      // The next pointer move hovers what is under it now.
      h.hover(pointer)
      expect(h.record.hovers.at(-1)).toBeNull()
    })

    it('a camera frame during a drag the tool passes on leaves the passive hover where it is', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp', scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.press({ x: 40, y: 50 })
      h.move({ x: 50, y: 50 })
      expect(h.record.hovers.at(-1)).toEqual(P1)
      const hovers = h.record.hovers.length
      const moves = stamp.count('drag-move')
      h.wheelZoom({ x: 0, y: 0 }, 2)

      expect(stamp.count('drag-move')).toBe(moves + 1)
      expect(h.record.hovers).toHaveLength(hovers)
      expect(h.chrome.tooltip).toBeNull()
    })

    it('a camera frame during a press that has not dragged hides the plant tooltip', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.hover({ x: 50, y: 50 })
      h.press({ x: 50, y: 50 })
      expect(h.chrome.tooltip?.target).toEqual(P1)
      h.wheelZoom({ x: 0, y: 0 }, 2)

      expect(h.chrome.tooltip).toBeNull()
    })

    it('a click or a drag leaves a still pointer that the next camera frame re-emits; a touch tap does not', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp' })

      h.click({ x: 120, y: 90 })
      h.view.navigation.zoomIn()
      expect(stamp.count('hover')).toBe(1)
      expect(stamp.last('hover')!.point.world).toEqual(h.world({ x: 120, y: 90 }))

      h.drag({ x: 50, y: 50 }, { x: 80, y: 60 })
      h.view.navigation.zoomOut()
      expect(stamp.count('hover')).toBe(2)
      expect(stamp.last('hover')!.point.world).toEqual(h.world({ x: 80, y: 60 }))
      expect(stamp.calls).not.toContain('viewChanged')

      // A finger that lifted leaves nothing under it.
      h.click({ x: 30, y: 30 }, { pointer: 'touch' })
      h.view.navigation.zoomIn()
      expect(stamp.count('hover')).toBe(2)
      expect(stamp.calls).toContain('viewChanged')
    })

    it('interrupted and a document replacement forget the still pointer', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp', scene: { plants: [appleAt({ x: 100, y: 100 })] } })

      h.hover({ x: 100, y: 100 })
      expect(h.chrome.tooltip?.target).toEqual(P1)
      h.blur()
      const hovers = h.record.hovers.length
      // The view moves while the pointer may be elsewhere (a resize, a focus fit): the hover stays cleared.
      h.view.navigation.zoomIn()
      expect(stamp.count('hover')).toBe(1)
      expect(h.record.hovers).toHaveLength(hovers)
      expect(h.chrome.tooltip).toBeNull()
      expect(stamp.calls.filter((call) => call === 'viewChanged')).toHaveLength(1)

      h.hover({ x: 100, y: 100 })
      h.host.prepareForDocumentReplacement()
      h.view.navigation.zoomOut()
      expect(stamp.count('hover')).toBe(2)
      expect(stamp.calls.filter((call) => call === 'viewChanged')).toHaveLength(2)
    })

    it('a pointer pan moves the resting pointer, re-emitted at once and on each camera frame', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp' })
      const ghost = h.world({ x: 100, y: 100 })

      h.hover({ x: 100, y: 100 })
      // A middle drag, in either order: the ground follows the pointer, and the router notes where the pointer is.
      h.view.navigation.panByPx({ x: 50, y: 20 })
      h.host.notePointer({ x: 150, y: 120 })
      const reemitted = stamp.last('hover')!.point.world
      expect(reemitted.x).toBeCloseTo(ghost.x, 6)
      expect(reemitted.y).toBeCloseTo(ghost.y, 6)
      h.host.notePointer({ x: 200, y: 140 })
      h.view.navigation.panByPx({ x: 50, y: 20 })
      const again = stamp.last('hover')!.point.world
      expect(again.x).toBeCloseTo(ghost.x, 6)
      expect(again.y).toBeCloseTo(ghost.y, 6)
      // The pointer's world point is published only by hovers, never by a pan.
      expect(h.record.pointerWorld).toHaveLength(1)
      expect(stamp.calls).not.toContain('viewChanged')

      // Past the map's edge nothing is re-emitted; back on the map it is again.
      const hovers = stamp.count('hover')
      h.host.notePointer({ x: 450, y: 120 })
      h.view.navigation.panByPx({ x: 300, y: 0 })
      expect(stamp.count('hover')).toBe(hovers)
      expect(stamp.calls).toEqual(['activate', 'viewChanged'])
      h.host.notePointer({ x: 150, y: 120 })
      expect(stamp.count('hover')).toBe(hovers + 1)
    })

    it('a camera frame with the pointer off the map calls viewChanged', () => {
      const polygon = stubTool('polygon')
      useStubTools(polygon)
      const h = harness({ tool: 'polygon' })

      h.hover({ x: 50, y: 50 })
      h.leave()
      // A key or button zoom: nothing is under the pointer to re-emit.
      h.view.navigation.zoomIn()
      h.view.navigation.zoomOut()

      expect(polygon.calls.filter((call) => call === 'viewChanged')).toHaveLength(2)
      expect(polygon.count('hover')).toBe(1)
    })
  })

  describe('interceptors', () => {
    it('J10: a Select tap on empty ground, inside a zone too, reaches Select, then pins its point; an object or a zone\'s outline selects only', () => {
      const order: string[] = []
      const select = stubTool('select', {
        gesture: (g) => {
          if (g.kind === 'tap') order.push('tap')
          return 'pass'
        },
      })
      useStubTools(select)
      const pin = vi.fn(() => { order.push('pin') })
      const h = harness({ pin, scene: { plants: [appleAt({ x: 200, y: 200 })], zones: [bed()] } })

      // Empty ground, with a little jitter inside the slop: the tool hears the tap first, and nothing is claimed.
      expect(h.press({ x: 300, y: 100 })).toEqual({})
      expect(h.release({ x: 301, y: 101 })).toEqual({})
      expect(order).toEqual(['tap', 'pin'])
      expect(pin).toHaveBeenCalledWith(h.world({ x: 301, y: 101 }))

      // A plant, and a zone's outline: Select selects them, and nothing pins.
      pin.mockClear()
      h.click({ x: 200, y: 200 })
      h.click({ x: 60, y: 12 })
      expect(select.count('tap')).toBe(3)
      expect(pin).not.toHaveBeenCalled()

      // (canopi-qd2k, the user's decision of 2026-10-14) Inside a zone, away from its outline, is empty ground: it pins.
      h.click({ x: 60, y: 35 })
      expect(pin).toHaveBeenCalledWith(h.world({ x: 60, y: 35 }))
      pin.mockClear()

      // A double-click on empty ground pins at each of its taps.
      h.click({ x: 300, y: 100 }, { clickCount: 2 })
      expect(pin).toHaveBeenCalledTimes(1)
    })

    it('J10: a drag, a handle, a lost capture, overview and the drawing tools never pin; any Pan-tool tap pins', () => {
      const select = stubTool('select')
      const polygon = stubTool('polygon')
      const hand = stubTool('hand')
      useStubTools(select, polygon, hand)
      const pin = vi.fn()
      const h = harness({ pin, scene: { plants: [appleAt({ x: 200, y: 200 })] } })

      // A band from empty ground, and a drag of the rotate handle.
      h.drag({ x: 300, y: 100 }, { x: 350, y: 150 })
      h.press({ x: 50, y: 50 }, { target: { kind: 'handle', id: 'rotate' as ToolHandleId } })
      h.release()
      expect(select.last('handle-drag')).toMatchObject({ phase: 'end', handle: 'rotate' })

      // Polygon adds its point and pins nothing.
      h.arm('polygon')
      h.click({ x: 300, y: 100 })
      expect(polygon.count('tap')).toBe(1)
      expect(pin).not.toHaveBeenCalled()

      // The Pan tool: any tap pins, on an object too.
      h.arm('hand')
      h.click({ x: 200, y: 200 })
      expect(hand.count('tap')).toBe(1)
      expect(pin).toHaveBeenCalledWith(h.world({ x: 200, y: 200 }))

      // A press whose capture was lost while it was taken ends with the lost-capture outcome and pins nothing.
      pin.mockClear()
      const lost = harness({ pin, capturePress: () => false })
      expect(lost.click({ x: 300, y: 100 })).toEqual({ rejectSession: true })

      // Overview: a press pans in the recogniser (U36); one that reached the host would pin nothing.
      const overview = harness({ tool: 'hand', viewport: OVERVIEW, pin })
      overview.click({ x: 120, y: 80 })
      expect(pin).not.toHaveBeenCalled()
    })

    it('Profile hands its finished line to the Site data profile, never pins, constrains with Shift and shows the crosshair', () => {
      const line = [{ x: 1, y: 2 }, { x: 30, y: 40 }]
      const profile: StubTool = stubTool('profile', {
        gesture: (g) => {
          if (g.kind === 'tap' && g.clickCount === 2) profile.ctx().effects.finishProfile(line)
          return 'pass'
        },
      })
      useStubTools(profile)
      const pin = vi.fn()
      const finishProfile = vi.fn()
      const h = harness({ tool: 'profile', pin, finishProfile })
      expect(h.chrome.cursor).toBe('crosshair')

      h.hover({ x: 50, y: 50 }, { shift: true })
      expect(profile.last('hover')!.point.modifiers.constrain).toBe(true)
      h.click({ x: 300, y: 100 })
      expect(finishProfile).not.toHaveBeenCalled()
      h.click({ x: 300, y: 100 }, { clickCount: 2 })

      expect(finishProfile).toHaveBeenCalledWith(line)
      expect(pin).not.toHaveBeenCalled()
    })

    it('Profile finishing on empty ground and then requesting Select never pins: the tool that heard the tap decides', () => {
      const line = [{ x: 1, y: 2 }, { x: 30, y: 40 }]
      const profile: StubTool = stubTool('profile', {
        gesture: (g) => {
          if (g.kind === 'tap' && g.clickCount === 2) {
            profile.ctx().effects.finishProfile(line)
            profile.ctx().effects.requestTool('select')
          }
          return 'pass'
        },
      })
      useStubTools(profile, stubTool('select'))
      const pin = vi.fn()
      const h = harness({ tool: 'profile', pin, finishProfile: vi.fn() })

      h.click({ x: 300, y: 100 })
      h.click({ x: 300, y: 100 }, { clickCount: 2 })

      expect(h.host.activeToolIsSelect()).toBe(true)
      expect(pin).not.toHaveBeenCalled()
    })

    it('J10: a finger\'s Select tap on empty ground pins at the down point', () => {
      useStubTools(stubTool('select'))
      const pin = vi.fn()
      const h = harness({ pin })

      // The recogniser resolves a finger's tap at its down point (input/recognise.ts).
      h.click({ x: 120, y: 90 }, { pointer: 'touch' })

      expect(pin).toHaveBeenCalledWith(h.world({ x: 120, y: 90 }))
    })

    it('a press the scene does not admit is quarantined and rejected', () => {
      const rectangle = stubTool('rectangle')
      useStubTools(rectangle)
      const h = harness({
        tool: 'rectangle',
        admission: { revision: signal(0), runWhenSettled: <T,>(_operation: () => T, busy: T) => busy },
      })

      expect(h.press({ x: 10, y: 10 })).toEqual({ quarantine: true, rejectSession: true })
      expect(rectangle.count('press')).toBe(0)
      expect(h.record.focus).toEqual([])
      expect(h.host.hasLiveGesture()).toBe(false)
    })

    it('a settled release runs inside the admission; a refused one cancels the tool and is quarantined', () => {
      let busy = false
      const admitted: string[] = []
      let settled = true
      const select = stubTool('select', { settledRelease: () => settled })
      useStubTools(select)
      const h = harness({
        admission: {
          revision: signal(0),
          runWhenSettled: <T,>(operation: () => T, busyResult: T) => {
            admitted.push(busy ? 'refused' : 'admitted')
            return busy ? busyResult : operation()
          },
        },
      })

      // Select's band (today's requiresSettledPointerUp): its release waits for the scene, as the press did.
      h.press({ x: 10, y: 10 })
      h.move({ x: 60, y: 40 })
      admitted.length = 0
      expect(h.release({ x: 80, y: 60 })).toEqual({})
      expect(admitted).toEqual(['admitted'])
      expect(select.count('drag-end')).toBe(1)

      // The scene is busy at the release: the tool is cancelled, as today's refused pointerup cancelled the transient.
      h.press({ x: 10, y: 10 })
      h.move({ x: 60, y: 40 })
      busy = true
      admitted.length = 0
      expect(h.release({ x: 80, y: 60 })).toEqual({ quarantine: true })
      expect(admitted).toEqual(['refused'])
      expect(select.count('drag-end')).toBe(1)
      expect(select.last('cancel')).toEqual({ kind: 'cancel', reason: 'tool-change' })
      expect(select.calls.at(-1)).toBe('cancelTransient:tool-change')
      expect(h.host.hasLiveGesture()).toBe(false)

      // A settled tap too.
      busy = false
      h.press({ x: 10, y: 10 })
      busy = true
      expect(h.release()).toEqual({ quarantine: true })
      expect(select.count('tap')).toBe(0)

      // Any other release runs at once, busy or not (today's pointerup outside a band).
      settled = false
      busy = false
      h.press({ x: 10, y: 10 })
      h.move({ x: 60, y: 40 })
      busy = true
      admitted.length = 0
      expect(h.release({ x: 80, y: 60 })).toEqual({})
      expect(admitted).toEqual([])
      expect(select.count('drag-end')).toBe(2)
    })

    it('a press moves focus to the map, which commits the text entry on its blur', () => {
      const submitted: string[] = []
      const text: StubTool = stubTool('text', {
        gesture: (g) => {
          if (g.kind === 'tap') {
            text.ctx().effects.requestTextEntry(
              { anchor: g.point.snapped, rotationDeg: 0, initialText: 'Compost', placeholderKey: 'canvas.textNote.placeholder' },
              (value) => {
                submitted.push(value)
                return 'close'
              },
            )
          }
          return 'pass'
        },
      })
      useStubTools(text)
      const h = harness({ tool: 'text' })

      h.click({ x: 40, y: 40 })
      expect(h.chrome.textEntry?.request.initialText).toBe('Compost')
      h.press({ x: 90, y: 90 })
      expect(h.record.focus.at(-1)).toBe('map')
      expect(submitted).toEqual(['Compost'])
      expect(h.chrome.textEntry).toBeNull()
    })

    it('a press or a menu submits a text entry whose blur commit was refused, once; a focused one commits on its blur', () => {
      let busy = true
      const submitted: string[] = []
      const select: StubTool = stubTool('select', {
        command: (c) => {
          if (c.kind !== 'edit-text') return 'pass'
          select.ctx().effects.requestTextEntry(
            { anchor: { x: 20, y: 20 }, rotationDeg: 0, initialText: 'Old', placeholderKey: 'canvas.textNote.placeholder' },
            (text) => {
              submitted.push(text)
              return busy ? 'keep' : 'close'
            },
          )
          return 'handled'
        },
      })
      useStubTools(select)
      const h = harness()

      // Focus leaves the entry while the scene refuses the edit: the entry stays open, without focus.
      h.host.command({ kind: 'edit-text' })
      h.typeText('New')
      expect(h.blurTextEntry()).toBe('keep')
      busy = false
      // The map taking focus cannot blur it again: the press submits it, as today's press committed the editor.
      h.click({ x: 300, y: 250 })
      expect(submitted).toEqual(['New', 'New'])
      expect(h.chrome.textEntry).toBeNull()
      expect(select.count('press')).toBe(1)

      // A menu, a keyboard one included, does the same.
      for (const source of ['mouse', 'keyboard'] as const) {
        busy = true
        h.host.command({ kind: 'edit-text' })
        h.blurTextEntry()
        busy = false
        h.menu(source === 'mouse' ? { x: 300, y: 250 } : 'selection', source)
        expect(h.chrome.textEntry).toBeNull()
      }
      expect(submitted).toHaveLength(6)

      // An entry that holds focus commits once, on the blur the map's focus causes.
      h.host.command({ kind: 'edit-text' })
      h.click({ x: 300, y: 250 })
      expect(submitted).toHaveLength(7)
      expect(h.chrome.textEntry).toBeNull()
    })

    it('textEntryOpen answers whether the entry a tool opened is open', () => {
      const text: StubTool = stubTool('text', {
        gesture: (g) => {
          if (g.kind === 'tap') {
            text.ctx().effects.requestTextEntry(
              { anchor: g.point.snapped, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
              () => 'close',
            )
          }
          return 'pass'
        },
      })
      useStubTools(text)
      const h = harness({ tool: 'text' })

      expect(h.host.textEntryOpen()).toBe(false)
      h.click({ x: 10, y: 10 })
      expect(h.host.textEntryOpen()).toBe(true)
      h.enterText()
      expect(h.host.textEntryOpen()).toBe(false)
    })

    it('the host reads the text entry\'s state live', () => {
      const handle: ToolHandle = { id: 'rotate' as ToolHandleId, anchor: { x: 10, y: 10 }, hitRadiusPx: 10, glyph: 'rotate', label: 'Rotate' }
      const select = stubTool('select', { activate: (ctx) => ctx.effects.setHandles([handle]) })
      const text: StubTool = stubTool('text', {
        gesture: (g) => {
          if (g.kind === 'tap') {
            text.ctx().effects.requestTextEntry(
              { anchor: g.point.snapped, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
              () => 'close',
            )
          }
          return 'pass'
        },
      })
      useStubTools(select, text)
      const h = harness()
      expect(h.chrome.handles).toEqual([handle])

      // An entry no tool asked for: Select's handles hide while it is open,
      h.openTextEntry()
      h.host.sceneChanged()
      expect(h.chrome.handles).toEqual([])
      // a menu takes focus first, so the entry commits on its blur and the handles return,
      h.menu({ x: 300, y: 250 })
      expect(h.record.focus).toEqual(['map'])
      expect(h.chrome.textEntry).toBeNull()
      expect(h.chrome.handles).toEqual([handle])
      // and so does the next press, a middle one too.
      h.openTextEntry()
      h.host.sceneChanged()
      h.host.rawPress('middle', { kind: 'surface' })
      expect(h.record.focus).toEqual(['map', 'map'])
      expect(h.chrome.textEntry).toBeNull()
      expect(h.chrome.handles).toEqual([handle])

      // An entry the tool opened and Esc closed in its own element handler: the next press finds it closed.
      h.arm('text')
      h.click({ x: 40, y: 40 })
      expect(h.chrome.textEntry).not.toBeNull()
      h.escapeTextEntry()
      h.click({ x: 90, y: 90 })
      // The click reached Text, which opened a new entry there: a press that found an entry open would place nothing.
      expect(h.record.focus.at(-1)).toBe('map')
      expect(h.chrome.textEntry?.request.anchor.x).toBeCloseTo(90, 6)
    })

    it('under Text, the click whose raw press finds the note entry open commits it and reaches no tool', () => {
      const text: StubTool = stubTool('text', {
        gesture: (g) => {
          if (g.kind === 'press') {
            text.ctx().effects.requestTextEntry(
              { anchor: g.point.world, rotationDeg: 0, initialText: 'Compost', placeholderKey: 'canvas.textNote.placeholder' },
              () => 'close',
            )
          }
          return 'pass'
        },
      })
      const select: StubTool = stubTool('select', {
        command: (c) => {
          if (c.kind !== 'edit-text') return 'pass'
          select.ctx().effects.requestTextEntry(
            { anchor: { x: 20, y: 20 }, rotationDeg: 0, initialText: 'Old', placeholderKey: 'canvas.textNote.placeholder' },
            () => 'close',
          )
          return 'handled'
        },
      })
      useStubTools(text, select)
      const h = harness({ tool: 'text' })

      h.click({ x: 40, y: 40 })
      const heard = text.gestures.length
      // The press's focus move commits the entry on its blur, and the click places nothing (spec §3.2, as today).
      expect(h.click({ x: 90, y: 90 })).toEqual({})
      expect(h.record.focus.at(-1)).toBe('map')
      expect(h.chrome.textEntry).toBeNull()
      expect(text.gestures).toHaveLength(heard)
      // The next click is the tool's again, and so is one after a middle press committed the entry.
      h.click({ x: 120, y: 120 })
      expect(text.count('press')).toBe(2)
      h.host.rawPress('middle', { kind: 'surface' })
      expect(h.chrome.textEntry).toBeNull()
      h.click({ x: 150, y: 150 })
      expect(text.count('press')).toBe(3)

      // Select's in-place editor commits on the press too, and the press goes on to Select, as today.
      h.arm('select')
      h.host.command({ kind: 'edit-text' })
      expect(h.chrome.textEntry).not.toBeNull()
      h.click({ x: 200, y: 200 })
      expect(h.chrome.textEntry).toBeNull()
      expect(select.count('press')).toBe(1)
    })

    it('entering overview submits an open entry and closes it, even when its commit is refused', () => {
      const submitted: string[] = []
      const text: StubTool = stubTool('text', {
        gesture: (g) => {
          if (g.kind === 'tap') {
            text.ctx().effects.requestTextEntry(
              { anchor: g.point.world, rotationDeg: 0, initialText: 'Compost', placeholderKey: 'canvas.textNote.placeholder' },
              (value) => {
                submitted.push(value)
                return 'keep'
              },
            )
          }
          return 'pass'
        },
      })
      useStubTools(text)
      const h = harness({ tool: 'text' })

      h.click({ x: 40, y: 40 })
      h.view.setViewport(OVERVIEW)
      h.advance(0)
      expect(submitted).toEqual(['Compost'])
      expect(h.chrome.textEntry).toBeNull()
      expect(h.host.textEntryOpen()).toBe(false)
    })

    it('the text entry\'s own Esc reaches the tool through onCancel, and what the tool publishes follows at once', () => {
      const cancels: number[] = []
      const text: StubTool = stubTool('text', {
        gesture: (g) => {
          if (g.kind !== 'press') return 'pass'
          const effects = text.ctx().effects
          effects.requestTextEntry(
            { anchor: g.point.world, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
            () => 'close',
            () => {
              cancels.push(h.record.guidance.length)
              effects.setGuidance({ gesture: false })
            },
          )
          effects.setGuidance({ gesture: true })
          return 'pass'
        },
      })
      useStubTools(text)
      const h = harness({ tool: 'text' })

      h.click({ x: 40, y: 40 })
      expect(h.record.guidance.at(-1)?.gesture).toBe(true)
      h.escapeTextEntry()
      expect(cancels).toHaveLength(1)
      expect(h.record.guidance.at(-1)?.gesture).toBe(false)

      // An entry the host closes (here on a tool change) was not cancelled by its own Esc: no onCancel.
      h.click({ x: 90, y: 90 })
      expect(h.chrome.textEntry).not.toBeNull()
      h.arm('select')
      expect(h.chrome.textEntry).toBeNull()
      expect(cancels).toHaveLength(1)
    })
  })

  describe('raw presses', () => {
    const SURFACE = { kind: 'surface' } as const

    it('every raw press commits the nudge series and, on any button, closes the menu and focuses the map', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 10, y: 10 })] } })
      h.select(P1)
      h.menu({ x: 300, y: 250 })
      h.record.focus.length = 0

      // A right press commits the series, closes the menu (its release opens the next one) and commits an open entry.
      h.openTextEntry()
      h.arrow('ArrowRight')
      h.host.rawPress('secondary', SURFACE)
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.record.nudges).toEqual(['nudge:0.1,0', 'end'])
      expect(h.menuOpen).toBe(false)
      expect(h.record.focus).toEqual(['map'])
      expect(h.chrome.textEntry).toBeNull()
      h.menu({ x: 300, y: 250 })
      h.record.focus.length = 0

      // A press inside the text entry commits the series and keeps the entry open.
      h.openTextEntry()
      h.arrow('ArrowRight')
      h.host.rawPress('primary', { kind: 'owned-text' })
      expect(h.record.nudges).toEqual(['nudge:0.1,0', 'end', 'nudge:0.1,0', 'end'])
      expect(h.menuOpen).toBe(true)
      expect(h.record.focus).toEqual([])
      expect(h.chrome.textEntry).not.toBeNull()

      // A middle press anywhere else, a map button included: the menu closes and the map takes focus, so the entry commits.
      h.arrow('ArrowRight')
      h.host.rawPress('middle', { kind: 'owned-chrome' })
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.menuOpen).toBe(false)
      expect(h.record.focus).toEqual(['map'])
      expect(h.chrome.textEntry).toBeNull()

      // A primary press: the same, once; the press it becomes moves focus no further.
      h.menu({ x: 300, y: 250 })
      h.record.focus.length = 0
      h.arrow('ArrowRight')
      h.click({ x: 200, y: 150 })
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.menuOpen).toBe(false)
      expect(h.record.focus).toEqual(['map'])
      expect(h.history.canUndo.value).toBe(true)
    })

    it('a raw press moves nothing during another live press or a busy scene', () => {
      let busy = false
      let failing = false
      const rectangle: StubTool = stubTool('rectangle', {
        cancelTransient: () => {
          if (failing) throw new Error('cancel failed')
        },
      })
      useStubTools(stubTool('select'), rectangle)
      const h = harness({
        admission: { revision: signal(0), runWhenSettled: <T,>(operation: () => T, busyResult: T) => (busy ? busyResult : operation()) },
      })

      // Another pointer's press is live: today's one pointer gesture at a time.
      h.press({ x: 100, y: 100 }, { pointerId: 3 })
      h.menu('selection', 'keyboard')
      h.host.rawPress('primary', SURFACE, 4)
      expect(h.menuOpen).toBe(true)
      expect(h.record.focus).toEqual(['map'])
      // The live pointer pressed again, its up lost: today's _onPointerDown skipped only another pointer's press.
      h.host.rawPress('primary', SURFACE, 3)
      expect(h.menuOpen).toBe(false)
      expect(h.record.focus).toEqual(['map', 'map'])
      h.release()
      h.menu('selection', 'keyboard')

      // The scene is not settled.
      busy = true
      h.host.rawPress('middle', SURFACE)
      expect(h.menuOpen).toBe(true)
      expect(h.record.focus).toEqual(['map', 'map'])
      busy = false

      // A failed cancellation leaves no edit open to wait for: the next raw press moves focus at once.
      h.arm('rectangle')
      failing = true
      h.press({ x: 10, y: 10 })
      expect(() => h.blur()).toThrow('cancel failed')
      failing = false
      const focus = h.record.focus.length
      h.host.rawPress('primary', SURFACE)
      expect(h.record.focus).toHaveLength(focus + 1)
    })
  })

  describe('hover', () => {
    it('the pointer world point is published in overview and while a tool handles the hover', () => {
      const stamp = stubTool('plant-stamp', { gesture: (g) => (g.kind === 'hover' ? 'handled' : 'pass') })
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp', scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.hover({ x: 50, y: 50 })
      expect(h.record.pointerWorld).toEqual([h.world({ x: 50, y: 50 })])
      expect(h.record.hovers).toEqual([null])

      const overview = harness({ tool: 'plant-stamp', viewport: OVERVIEW })
      overview.hover({ x: 10, y: 20 })
      expect(overview.record.pointerWorld).toEqual([overview.world({ x: 10, y: 20 })])
      expect(stamp.count('hover')).toBe(1)

      overview.leave()
      expect(overview.record.pointerWorld.at(-1)).toBeNull()
    })

    it('the pointer is published with its screen point and its kind, so a readout can query the map there (R1) and read a finger through the pin', () => {
      useStubTools(stubTool('plant-stamp'))
      const h = harness({ tool: 'plant-stamp', viewport: { x: 10, y: -20, scale: 2 } })
      const points: unknown[] = []
      h.host.subscribePointerWorld((point) => { points.push(point) })

      h.hover({ x: 50, y: 60 })
      h.leave()
      h.click({ x: 70, y: 80 }, { pointer: 'touch' })

      expect(points).toEqual([
        { world: h.world({ x: 50, y: 60 }), screen: { x: 50, y: 60 }, pointerKind: 'mouse' },
        null,
        { world: h.world({ x: 70, y: 80 }), screen: { x: 70, y: 80 }, pointerKind: 'touch' },
      ])
    })

    it('a camera change under a still pointer republishes it on the settled frame, so readouts follow the ground (canopi-f47t.42)', () => {
      vi.useFakeTimers()
      try {
        useStubTools(stubTool('select'))
        const h = harness()
        const points: unknown[] = []
        h.host.subscribePointerWorld((point) => { points.push(point) })
        h.hover({ x: 100, y: 100 })
        const before = h.world({ x: 100, y: 100 })

        h.wheelZoom({ x: 200, y: 150 }, 2)
        h.wheelZoom({ x: 200, y: 150 }, 2)
        // Not at each camera frame: once the camera has settled.
        expect(points).toHaveLength(1)
        vi.advanceTimersByTime(150)

        const after = h.world({ x: 100, y: 100 })
        expect(after).not.toEqual(before)
        expect(points).toEqual([
          { world: before, screen: { x: 100, y: 100 }, pointerKind: 'mouse' },
          { world: after, screen: { x: 100, y: 100 }, pointerKind: 'mouse' },
        ])

        // With the pointer off the map, a settled frame publishes nothing.
        h.leave()
        h.wheelZoom({ x: 200, y: 150 }, 0.5)
        vi.advanceTimersByTime(150)
        expect(points).toHaveLength(3)
        expect(points.at(-1)).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('the lens is fed only over the map', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp' })

      h.hover({ x: 50, y: 50 })
      // Over a map button or off the map, the lens keeps its point, as today's skips buttons, inputs, textareas,
      // contenteditable and [data-preserve-overlays] and hears no move off the host.
      h.hover({ x: 60, y: 60 }, {}, { kind: 'owned-chrome' })
      h.hover({ x: 80, y: 80 }, {}, { kind: 'foreign' })
      expect(h.record.pointerWorld).toEqual([h.world({ x: 50, y: 50 })])
      // Only the lens is fed by target: the tool hears every hover, as today.
      expect(stamp.count('hover')).toBe(3)

      h.hover({ x: 90, y: 90 })
      h.leave()
      expect(h.record.pointerWorld).toEqual([h.world({ x: 50, y: 50 }), h.world({ x: 90, y: 90 }), null])

      // Under Select the lens hears the moves by the same rule.
      h.arm('select')
      h.hover({ x: 60, y: 60 }, {}, { kind: 'owned-chrome' })
      h.hover({ x: 20, y: 30 })
      expect(h.record.pointerWorld.slice(3)).toEqual([h.world({ x: 20, y: 30 })])
    })

    it('a handled hover skips the host\'s hover', () => {
      let reply: ToolReply = 'pass'
      const stamp = stubTool('plant-stamp', { gesture: (g) => (g.kind === 'hover' ? reply : 'pass') })
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp', scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.hover({ x: 50, y: 50 })
      expect(h.record.hovers.at(-1)).toEqual(P1)
      expect(h.chrome.tooltip).toEqual({ target: P1, at: { x: 50, y: 50 } })

      reply = 'handled'
      h.hover({ x: 50, y: 50 })
      expect(h.record.hovers.at(-1)).toBeNull()
      expect(h.chrome.tooltip).toBeNull()
    })

    it('a passing hover restyles a directly locked object, which draws the locked hover stroke', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 }, { locked: true })] } })

      h.hover({ x: 50, y: 50 })
      expect(h.record.hovers.at(-1)).toEqual(P1)
      h.hover({ x: 300, y: 250 })
      expect(h.record.hovers.at(-1)).toBeNull()
    })

    it('hover-end clears the passive hover and leaves the preview to the tool', () => {
      const ghost: DraftPresentation = {
        shapes: [{ kind: 'circle-px', center: { x: 50, y: 50 }, radiusPx: 4, style: { token: 'draft', widthPx: 1 } }],
      }
      const stamp: StubTool = stubTool('plant-stamp', {
        gesture: (g) => {
          if (g.kind === 'hover') stamp.ctx().effects.setDraft(ghost)
          return 'pass'
        },
      })
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp', scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.hover({ x: 50, y: 50 })
      expect(h.record.hovers.at(-1)).toEqual(P1)
      h.leave()
      expect(h.record.hovers.at(-1)).toBeNull()
      expect(h.chrome.tooltip).toBeNull()
      expect(stamp.last('hover-end')).toEqual({ kind: 'hover-end' })
      expect(h.renderer.lastDraft()).toEqual(ghost)
      expect(h.record.pointerWorld.at(-1)).toBeNull()
    })
  })

  describe('translations', () => {
    it('a language change rebuilds the tool\'s translated draft: sceneChanged, then the still pointer or viewChanged', () => {
      const stamp = stubTool('plant-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'plant-stamp' })

      h.hover({ x: 100, y: 100 })
      h.host.refreshTranslations()
      expect(stamp.calls).toEqual(['activate', 'sceneChanged'])
      expect(stamp.count('hover')).toBe(2)
      expect(stamp.last('hover')!.point.world).toEqual(h.world({ x: 100, y: 100 }))

      h.leave()
      h.host.refreshTranslations()
      expect(stamp.calls).toEqual(['activate', 'sceneChanged', 'sceneChanged', 'viewChanged'])
      expect(stamp.count('hover')).toBe(2)
    })
  })

  describe('activation rollback', () => {
    it('a tool whose activation throws leaves Select armed, never no tool', () => {
      const select = stubTool('select')
      const hand = stubTool('hand')
      const broken = stubTool('polygon', {
        activate: () => {
          throw new Error('boom')
        },
      })
      useStubTools(select, hand, broken)
      const h = harness({ tool: 'hand' })

      expect(() => h.arm('polygon')).toThrow('boom')

      expect(h.host.activeToolIsSelect()).toBe(true)
      expect(hand.calls).toContain('deactivate:switch')
      expect(select.calls).toContain('activate')
      // The armed Select is a tool: it hears the next hover and press.
      h.hover({ x: 40, y: 40 })
      h.click({ x: 40, y: 40 })
      expect(select.count('hover')).toBeGreaterThan(0)
      expect(select.count('press')).toBe(1)
      expect(broken.count('hover')).toBe(0)
    })
  })

  describe('decorations', () => {
    it('a selected zone shows its chips under every tool', () => {
      useStubTools(stubTool('polygon'), stubTool('plant-stamp'))
      const h = harness({ scene: { zones: [bed()] } })

      h.select(Z1)
      const chips = selectedZoneChips(h)
      expect(chips.length).toBeGreaterThan(1)
      expect(h.renderer.lastDraft()).toEqual({ shapes: chips })

      h.arm('plant-stamp')
      expect(h.renderer.lastDraft()).toEqual({ shapes: chips })
      h.arm('polygon')
      expect(h.renderer.lastDraft()).toEqual({ shapes: chips })

      h.select()
      expect(h.renderer.lastDraft()).toBeNull()
    })

    it('a zone draft with measure labels hides the selected-zone chips', () => {
      const rectangle = stubTool('rectangle')
      const measure = stubTool('measurement-guide')
      useStubTools(stubTool('polygon'), rectangle, measure)
      const h = harness({ tool: 'rectangle', scene: { zones: [bed()] } })
      h.select(Z1)
      const chips = selectedZoneChips(h)
      const outline: DraftShape = {
        kind: 'polygon',
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
        style: { token: 'draft', widthPx: 2 },
      }
      const edgeChip: DraftShape = { kind: 'label', anchor: { x: 2.5, y: 0 }, offsetPx: { x: 0, y: 0 }, text: '5 m', tone: 'measure-quiet' }

      rectangle.ctx().effects.setDraft({ shapes: [outline, edgeChip] })
      expect(h.renderer.lastDraft()).toEqual({ shapes: [outline, edgeChip] })
      rectangle.ctx().effects.setDraft({ shapes: [outline] })
      expect(h.renderer.lastDraft()).toEqual({ shapes: [outline, ...chips] })

      // The Measure tool's chips show beside the zone's, as today.
      h.arm('measurement-guide')
      measure.ctx().effects.setDraft({ shapes: [edgeChip] })
      expect(h.renderer.lastDraft()).toEqual({ shapes: [edgeChip, ...chips] })
    })

    it('a tool call that mutates the open transaction invalidates', () => {
      let edit: SceneEditTransaction | null = null
      const rectangle: StubTool = stubTool('rectangle', {
        gesture: (g) => {
          if (g.kind === 'drag-start') edit = rectangle.ctx().effects.edits.begin('interaction-rectangle')
          if (g.kind === 'drag-move') {
            edit!.mutate((draft) => {
              draft.zones = [rectZone('z2', [g.start.snapped, g.point.snapped, g.point.snapped, g.start.snapped])]
            })
          }
          if (g.kind === 'drag-end') {
            edit!.commit()
            edit = null
          }
          return 'pass'
        },
      })
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle' })

      h.hover({ x: 5, y: 5 })
      h.press({ x: 10, y: 10 })
      h.move({ x: 40, y: 30 })
      expect(h.record.invalidations).toBe(0)
      expect(h.record.guidance.at(-1)).toMatchObject({ gesture: true })
      h.move({ x: 60, y: 50 })
      expect(h.record.invalidations).toBe(1)
      h.release()
      expect(h.store.persisted.zones.map((zone) => zone.id)).toEqual(['z2'])
      expect(h.record.guidance.at(-1)).toMatchObject({ gesture: false })
    })
  })

  describe('Select\'s handles and edits', () => {
    const ROTATE: ToolHandle = { id: 'rotate' as ToolHandleId, anchor: { x: 10, y: 10 }, hitRadiusPx: 14, glyph: 'rotate', label: 'Rotate' }

    /** A Select stand-in that shows the rotate handle and opens a Scene Edit at a press, as a move or a handle drag does. */
    function editingSelect(): StubTool {
      let edit: SceneEditTransaction | null = null
      const select: StubTool = stubTool('select', {
        activate: (ctx) => ctx.effects.setHandles([ROTATE]),
        gesture: (g) => {
          const phase = g.kind === 'handle-drag' ? g.phase : null
          if (g.kind === 'press' || phase === 'start') edit = select.ctx().effects.edits.begin('interaction-test')
          if (g.kind === 'drag-move' || phase === 'move') {
            const world = 'point' in g ? g.point.world : { x: 0, y: 0 }
            edit?.mutate((draft) => {
              draft.plants = [appleAt(world)]
            })
          }
          if (g.kind === 'tap' || g.kind === 'drag-end' || g.kind === 'cancel' || phase === 'end') {
            edit?.abort()
            edit = null
          }
          return 'pass'
        },
      })
      return select
    }

    it('Select\'s handles hide while a Scene Edit is open; a handle\'s own press keeps them until it changes the scene', () => {
      useStubTools(editingSelect())
      const h = harness()
      expect(h.chrome.handles).toEqual([ROTATE])

      // A press that opens an edit (a move): the handles hide at once and come back when it ends.
      h.press({ x: 100, y: 100 })
      expect(h.chrome.handles).toEqual([])
      h.release()
      expect(h.chrome.handles).toEqual([ROTATE])

      // The handle's own press marks it active and keeps the handles until its edit first changes the scene, as today.
      h.press({ x: 10, y: 10 }, { target: { kind: 'handle', id: ROTATE.id } })
      expect(h.chrome.handles).toEqual([ROTATE])
      expect(h.chrome.activeHandle).toBe(ROTATE.id)
      h.move({ x: 30, y: 30 })
      expect(h.chrome.handles).toEqual([])
      h.release()
      expect(h.chrome.handles).toEqual([ROTATE])
      expect(h.chrome.activeHandle).toBeNull()
    })

    it('a press that opens a Scene Edit clears the passive hover', () => {
      useStubTools(editingSelect())
      const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.hover({ x: 50, y: 50 })
      expect(h.chrome.tooltip).toEqual({ target: P1, at: { x: 50, y: 50 } })
      h.press({ x: 50, y: 50 })
      expect(h.chrome.tooltip).toBeNull()
      expect(h.record.hovers.at(-1)).toBeNull()
      h.release()
    })

    it('an aborted Scene Edit redraws the scene it restored', () => {
      useStubTools(editingSelect())
      const h = harness()

      h.press({ x: 100, y: 100 })
      h.move({ x: 120, y: 120 })
      h.move({ x: 140, y: 140 })
      const before = h.record.invalidations
      h.cancel('pointercancel')

      expect(h.store.persisted.plants).toEqual([])
      expect(h.record.invalidations).toBe(before + 1)
    })

    it('a text entry the tool\'s submit closes shows Select\'s handles again', () => {
      const submitted: string[] = []
      const select: StubTool = stubTool('select', {
        activate: (ctx) => ctx.effects.setHandles([ROTATE]),
        command: (c) => {
          if (c.kind !== 'edit-text') return 'pass'
          select.ctx().effects.requestTextEntry(
            { anchor: { x: 20, y: 20 }, rotationDeg: 0, initialText: 'Old', placeholderKey: 'canvas.textNote.placeholder' },
            (text) => {
              submitted.push(text)
              return text.length > 0 ? 'close' : 'keep'
            },
          )
          return 'handled'
        },
      })
      useStubTools(select)
      const h = harness()

      expect(h.host.command({ kind: 'edit-text' })).toBe('handled')
      expect(h.chrome.handles).toEqual([])
      // A refused commit keeps the entry, and the handles stay hidden.
      expect(h.chrome.textEntry!.submit('')).toBe('keep')
      expect(h.chrome.textEntry).not.toBeNull()
      expect(h.chrome.handles).toEqual([])

      expect(h.chrome.textEntry!.submit('New')).toBe('close')
      expect(submitted).toEqual(['', 'New'])
      expect(h.chrome.textEntry).toBeNull()
      expect(h.chrome.handles).toEqual([ROTATE])
    })

    it('the same handles again change nothing and redraw nothing', () => {
      const select: StubTool = stubTool('select', {
        activate: (ctx) => ctx.effects.setHandles([ROTATE]),
        viewChanged: () => select.ctx().effects.setHandles([{ ...ROTATE }]),
      })
      useStubTools(select)
      const h = harness()
      const before = h.record.invalidations

      // A camera frame with the pointer off the map: the tool refreshes its handles, which have not changed.
      h.view.navigation.zoomIn()
      h.advance(1000)

      expect(select.calls).toContain('viewChanged')
      expect(h.record.invalidations).toBe(before)
      expect(h.chrome.handles).toEqual([ROTATE])
    })

    it('a tool call made from inside an effect leaves the effect independent of what the tool reads and bumps', () => {
      const selectionRevision = signal(0)
      const select = stubTool('select', { sceneChanged: () => void selectionRevision.value })
      useStubTools(select)
      const h = harness()
      let runs = 0

      // The runtime refreshes the session from inside its camera-frame effect.
      const stop = effect(() => {
        runs += 1
        h.host.sceneChanged()
      })
      selectionRevision.value += 1
      stop()

      expect(runs).toBe(1)
      expect(h.record.transientHistoryChanges).toBeGreaterThan(0)
    })
  })

  describe('transient history', () => {
    it('transient history undoes a polygon corner and reports canUndo', () => {
      const corners: WorldPoint[] = []
      const redo: WorldPoint[] = []
      const polygon = stubTool('polygon', {
        gesture: (g) => {
          if (g.kind === 'tap') {
            corners.push(g.point.snapped)
            redo.length = 0
          }
          return 'pass'
        },
        command: (c) => {
          const from = c.kind === 'undo-transient' ? corners : c.kind === 'redo-transient' ? redo : null
          const moved = from?.pop()
          if (!moved) return 'pass'
          ;(from === corners ? redo : corners).push(moved)
          return 'handled'
        },
        canUndoTransient: () => corners.length > 0,
        canRedoTransient: () => redo.length > 0,
      })
      useStubTools(polygon)
      const h = harness({ tool: 'polygon' })
      const history = h.host.transientHistory

      expect(history.canUndo()).toBe(false)
      h.click({ x: 10, y: 10 })
      h.click({ x: 60, y: 10 })
      const changes = h.record.transientHistoryChanges

      expect(history.canUndo()).toBe(true)
      expect(history.undo()).toBe(true)
      expect(corners).toEqual([{ x: 10, y: 10 }])
      expect(history.canRedo()).toBe(true)
      expect(h.record.transientHistoryChanges).toBeGreaterThan(changes)

      expect(history.undo()).toBe(true)
      expect(history.canUndo()).toBe(false)
      expect(history.undo()).toBe(false)
      expect(history.redo()).toBe(true)
      expect(corners).toEqual([{ x: 10, y: 10 }])
    })

    it('the transient-history revision bumps after a deferred onCommitted', () => {
      let deferred: (() => void) | null = null
      const edits: SceneEditCoordinator = {
        run(_type, _edit, options) {
          deferred = options?.onCommitted ?? null
          return true
        },
        begin() {
          throw new Error('not used')
        },
      }
      const corners = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]
      const polygon: StubTool = stubTool('polygon', {
        command: (c) => {
          if (c.kind !== 'confirm') return 'pass'
          polygon.ctx().effects.edits.run('interaction-polygon', () => {}, {
            onCommitted: () => {
              corners.length = 0
            },
          })
          return 'handled'
        },
        canUndoTransient: () => corners.length > 0,
      })
      useStubTools(polygon)
      const h = harness({ tool: 'polygon', edits })

      expect(h.host.command({ kind: 'confirm' })).toBe('handled')
      const changes = h.record.transientHistoryChanges
      expect(h.host.transientHistory.canUndo()).toBe(true)

      deferred!()
      expect(h.record.transientHistoryChanges).toBe(changes + 1)
      expect(h.host.transientHistory.canUndo()).toBe(false)
    })
  })

  describe('nudges', () => {
    it('an arrow with a selection nudges and one series is one undo', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 10, y: 10 })] } })
      h.select(P1)

      expect(h.arrow('ArrowRight')).toBe('handled')
      expect(h.arrow('ArrowRight')).toBe('handled')
      expect(h.arrow('ArrowDown', true)).toBe('handled')
      expect(h.record.nudges).toEqual(['nudge:0.1,0', 'nudge:0.1,0', 'nudge:0,1'])
      expect(h.host.hasNudgeSeries()).toBe(true)

      h.advance(799)
      expect(h.host.hasNudgeSeries()).toBe(true)
      expect(h.history.canUndo.value).toBe(false)
      h.advance(1)
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.record.nudges.at(-1)).toBe('end')
      const moved = h.store.persisted.plants[0]!.position
      expect(moved.x).toBeCloseTo(10.2, 9)
      expect(moved.y).toBeCloseTo(11, 9)

      expect(h.undo()).toBe(true)
      expect(h.store.persisted.plants[0]!.position).toEqual({ x: 10, y: 10 })
      expect(h.history.canUndo.value).toBe(false)
    })

    it('nudge follows the screen at 30', () => {
      useStubTools(stubTool('select'))
      const h = harness({ camera: { bearingDeg: 30 }, scene: { plants: [appleAt({ x: 0, y: 0 })] } })
      h.select(P1)
      const screenOfApple = () => h.view.view().worldToScreen(h.store.persisted.plants[0]!.position)
      const before = screenOfApple()
      const pixelsPerMetre = h.view.view().pixelsPerMetre

      expect(h.arrow('ArrowUp')).toBe('handled')
      const after = screenOfApple()
      expect(after.x - before.x).toBeCloseTo(0, 6)
      expect(after.y - before.y).toBeCloseTo(-0.1 * pixelsPerMetre, 6)

      // The large step (mod+arrow, chosen by the keymap) is 1 m along the screen.
      expect(h.arrow('ArrowRight', true)).toBe('handled')
      const moved = screenOfApple()
      expect(moved.x - after.x).toBeCloseTo(pixelsPerMetre, 6)
      expect(moved.y - after.y).toBeCloseTo(0, 6)
    })

    it('a refused nudge answers refused, and without Select or a selection nudge answers pass', () => {
      useStubTools(stubTool('select'), stubTool('plant-stamp'))
      const nudgeSelected = vi.fn(() => false)
      const endNudge = vi.fn()
      const h = harness({ scene: { plants: [appleAt({ x: 10, y: 10 })] }, nudge: { nudgeSelected, endNudge } })

      expect(h.arrow('ArrowLeft')).toBe('pass')
      expect(nudgeSelected).not.toHaveBeenCalled()
      h.select(P1)
      expect(h.arrow('ArrowLeft')).toBe('refused')
      expect(nudgeSelected).toHaveBeenCalledWith({ x: -0.1, y: 0 })
      expect(h.host.hasNudgeSeries()).toBe(false)
      h.arm('plant-stamp')
      expect(h.arrow('ArrowLeft')).toBe('pass')

      const overview = harness({ viewport: OVERVIEW, scene: { plants: [appleAt({ x: 10, y: 10 })] }, nudge: { nudgeSelected, endNudge } })
      overview.select(P1)
      expect(overview.arrow('ArrowLeft')).toBe('pass')
      expect(nudgeSelected).toHaveBeenCalledTimes(1)
      expect(endNudge).not.toHaveBeenCalled()
    })

    it('focus-out commits the nudge series', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 10, y: 10 })] } })
      h.select(P1)

      h.arrow('ArrowUp')
      h.focusOut()
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.record.nudges).toEqual(['nudge:0,-0.1', 'end'])
      expect(h.history.canUndo.value).toBe(true)
      h.advance(1_000)
      expect(h.record.nudges).toHaveLength(2)
    })

    it('interrupted commits the nudge series, clears the passive hover and keeps a draft that survives pans', () => {
      const draft: DraftPresentation = {
        shapes: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], style: { token: 'draft', widthPx: 2 } }],
      }
      const polygon: StubTool = stubTool('polygon', {
        cancelTransient: (reason) => {
          if (reason !== 'navigate') polygon.ctx().effects.setDraft(null)
        },
      })
      useStubTools(stubTool('select'), polygon)
      const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.select(P1)
      h.arrow('ArrowUp')
      h.hover({ x: 50, y: 50 })
      expect(h.chrome.tooltip?.target).toEqual(P1)
      h.blur()
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.record.nudges.at(-1)).toBe('end')
      expect(h.record.hovers.at(-1)).toBeNull()
      expect(h.chrome.tooltip).toBeNull()

      h.arm('polygon')
      polygon.ctx().effects.setDraft(draft)
      h.blur()
      expect(polygon.calls).toContain('cancelTransient:navigate')
      expect(h.renderer.lastDraft()).toEqual(draft)
      expect(h.chrome.cursor).toBe('crosshair')
    })
  })

  describe('releases the tool did not hear (today\'s pointerup cleanup)', () => {
    it('released commits the nudge series, clears the passive hover and runs the tool\'s cancelTransient(\'navigate\')', () => {
      const select = stubTool('select')
      const stamp = stubTool('object-stamp', { gesture: (g) => (g.kind === 'hover' ? 'pass' : 'handled') })
      useStubTools(select, stamp)
      const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      h.select(P1)
      h.arrow('ArrowUp')
      h.hover({ x: 50, y: 50 })
      expect(h.chrome.tooltip?.target).toEqual(P1)
      h.host.released()
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.record.nudges.at(-1)).toBe('end')
      expect(h.chrome.tooltip).toBeNull()
      expect(select.calls).toContain('cancelTransient:navigate')

      h.arm('object-stamp')
      h.host.released()
      expect(stamp.calls).toContain('cancelTransient:navigate')
    })

    it('released does nothing while a press of the tool\'s is live: its own release ends it', () => {
      const rectangle = stubTool('rectangle')
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle' })

      h.press({ x: 10, y: 10 })
      h.host.released()
      expect(rectangle.calls.filter((call) => call.startsWith('cancelTransient'))).toEqual([])
      expect(h.host.hasLiveGesture()).toBe(true)
    })

    it('the release of a press the tool never heard runs it: a new note\'s committing click', () => {
      const text = stubTool('text', {
        gesture: (g) => {
          if (g.kind === 'press') {
            text.ctx().effects.requestTextEntry(
              { anchor: g.point.world, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
              () => 'close',
            )
          }
          return 'pass'
        },
      })
      useStubTools(text)
      const h = harness({ tool: 'text' })
      const navigates = (): number => text.calls.filter((call) => call === 'cancelTransient:navigate').length

      h.click({ x: 10, y: 10 })
      expect(h.chrome.textEntry).not.toBeNull()
      expect(navigates()).toBe(0)
      // The next click commits the note and reaches no tool (spec §3.2); its release is not the tool's.
      h.click({ x: 40, y: 40 })
      expect(text.count('press')).toBe(1)
      expect(navigates()).toBe(1)
    })
  })

  describe('faults (spec §1.4 "Faults")', () => {
    /** A registered tool whose every arming builds a fresh, recorded stub: the host arms a fresh instance after a fault. */
    function freshTools(id: ToolId, behaviour: (instance: number) => StubToolBehaviour = () => ({})): StubTool[] {
      const instances: StubTool[] = []
      ;(TOOL_REGISTRY as Partial<Record<ToolId, ToolFactory>>)[id] = () => {
        const tool = stubTool(id, behaviour(instances.length))
        instances.push(tool)
        return tool
      }
      return instances
    }

    /** A press that opens a Scene Edit, draws `id` into it, and commits on release; `fails` makes the press throw. */
    function zonePress(tool: () => StubTool, zoneId: () => string, fails: () => boolean): StubToolBehaviour {
      let edit: SceneEditTransaction | null = null
      return {
        gesture: (g) => {
          if (g.kind === 'press') {
            edit = tool().ctx().effects.edits.begin('interaction-rectangle')
            edit.mutate((draft) => {
              draft.zones.push(rectZone(zoneId(), [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }]))
            })
            if (fails()) throw new Error('press failed')
          }
          if (g.kind === 'tap' || g.kind === 'drag-end') edit?.commit()
          return 'handled'
        },
      }
    }

    it('a press whose tool throws after begin() leaves the Scene as before, with one undo entry fewer, and the next press is admitted', () => {
      let failing = false
      let zones = 0
      const instances: StubTool[] = freshTools('rectangle', (n) => zonePress(() => instances[n]!, () => `z${++zones}`, () => failing))
      const h = harness({ tool: 'rectangle' })

      h.click({ x: 10, y: 10 })
      expect(h.store.persisted.zones.map((zone) => zone.id)).toEqual(['z1'])

      failing = true
      expect(() => h.press({ x: 20, y: 20 })).toThrow('press failed')
      failing = false
      // The press's zone is gone, and no edit is left open: the scene is as the first click left it.
      expect(h.store.persisted.zones.map((zone) => zone.id)).toEqual(['z1'])
      expect(h.host.hasLiveGesture()).toBe(false)
      expect(h.undo()).toBe(true)
      expect(h.store.persisted.zones).toEqual([])
      expect(h.undo()).toBe(false)

      expect(h.press({ x: 30, y: 30 })).toEqual({})
      h.release({ x: 30, y: 30 })
      expect(h.store.persisted.zones.map((zone) => zone.id)).toEqual(['z3'])
    })

    it('a tool call that throws aborts the open edits, ends the live press and arms a fresh instance of the tool, which never hears deactivate', () => {
      let failing = true
      let zones = 0
      const instances: StubTool[] = freshTools('rectangle', (n) => zonePress(() => instances[n]!, () => `z${++zones}`, () => failing))
      const h = harness({ tool: 'rectangle' })

      expect(() => h.press({ x: 20, y: 20 })).toThrow('press failed')
      failing = false
      expect(h.host.hasLiveGesture()).toBe(false)
      expect(h.store.persisted.zones).toEqual([])
      expect(instances).toHaveLength(2)
      expect(instances[0]!.calls).toEqual(['activate'])
      expect(instances[1]!.calls).toEqual(['activate'])
      expect(h.host.activeToolIsSelect()).toBe(false)

      h.click({ x: 30, y: 30 })
      expect(instances[1]!.count('press')).toBe(1)
      expect(h.store.persisted.zones.map((zone) => zone.id)).toEqual(['z2'])
    })

    it('a release whose tool call throws arms a fresh instance, with no edit left open, so the next press is admitted', () => {
      const instances = freshTools('rectangle', (n) => ({
        gesture: (g) => {
          if (g.kind === 'press') instances[n]!.ctx().effects.edits.begin('interaction-rectangle')
          if (g.kind === 'drag-end' && n === 0) throw new Error('commit failed')
          return 'handled'
        },
      }))
      const h = harness({ tool: 'rectangle' })

      expect(() => h.drag({ x: 10, y: 10 }, { x: 40, y: 40 })).toThrow('commit failed')
      expect(instances).toHaveLength(2)
      expect(instances[0]!.calls).not.toContain('cancelTransient:tool-change')
      expect(h.press({ x: 50, y: 50 })).toEqual({})
      expect(instances[1]!.count('press')).toBe(1)
    })

    it('an activation that throws arms a fresh Select', () => {
      const selects = freshTools('select')
      freshTools('ellipse', () => ({ activate: () => { throw new Error('activation failed') } }))
      const h = harness()

      expect(() => h.arm('ellipse')).toThrow('activation failed')
      expect(h.host.activeToolIsSelect()).toBe(true)
      expect(selects).toHaveLength(2)
      expect(selects[0]!.calls).toEqual(['activate', 'cancelTransient:tool-change', 'deactivate:switch'])
      expect(selects[1]!.calls).toEqual(['activate'])
    })

    it('any throw while arming another tool arms a fresh Select, a failed cancellation of the tool left too', () => {
      const selects = freshTools('select')
      const rectangles = freshTools('rectangle', () => ({ cancelTransient: () => { throw new Error('cancel failed') } }))
      const ellipses = freshTools('ellipse')
      const h = harness({ tool: 'rectangle' })

      expect(() => h.arm('ellipse')).toThrow('cancel failed')
      expect(h.host.activeToolIsSelect()).toBe(true)
      expect(selects).toHaveLength(1)
      expect(rectangles).toHaveLength(1)
      expect(ellipses).toHaveLength(0)
    })

    it('a re-arm that throws is not handled again: the host keeps a fresh Select, and both failures are reported', () => {
      const selects = freshTools('select')
      const rectangles = freshTools('rectangle', (n) => ({
        ...(n > 0 ? { activate: () => { throw new Error('re-arm failed') } } : {}),
        gesture: (g) => {
          if (g.kind === 'press') throw new Error('press failed')
          return 'pass'
        },
      }))
      const h = harness({ tool: 'rectangle' })

      let reported: unknown = null
      try {
        h.press({ x: 20, y: 20 })
      } catch (error) {
        reported = error
      }
      expect(reported).toBeInstanceOf(CanvasRuntimeCleanupError)
      expect((reported as CanvasRuntimeCleanupError).errors.map((error) => (error as Error).message))
        .toEqual(['press failed', 're-arm failed'])
      expect(rectangles).toHaveLength(2)
      expect(h.host.activeToolIsSelect()).toBe(true)
      expect(selects).toHaveLength(1)
      expect(selects[0]!.calls).toEqual(['activate'])
    })

    it('only the outermost tool call handles a fault, once: a tool\'s request for a tool whose activation throws arms one fresh Select', () => {
      const selects = freshTools('select')
      const rectangles = freshTools('rectangle', (n) => ({
        gesture: (g) => {
          if (g.kind === 'press') rectangles[n]!.ctx().effects.requestTool('ellipse')
          return 'handled'
        },
      }))
      freshTools('ellipse', () => ({ activate: () => { throw new Error('activation failed') } }))
      const h = harness({ tool: 'rectangle' })

      expect(() => h.press({ x: 20, y: 20 })).toThrow('activation failed')
      expect(h.host.activeToolIsSelect()).toBe(true)
      expect(h.host.hasLiveGesture()).toBe(false)
      expect(selects).toHaveLength(1)
      expect(rectangles).toHaveLength(1)
    })

    it('a fault closes an open text entry', () => {
      const instances = freshTools('text', (n) => ({
        gesture: (g) => {
          if (g.kind === 'press') {
            instances[n]!.ctx().effects.requestTextEntry(
              { anchor: g.point.world, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
              () => 'close',
            )
            throw new Error('press failed')
          }
          return 'handled'
        },
      }))
      const h = harness({ tool: 'text' })

      expect(() => h.press({ x: 20, y: 20 })).toThrow('press failed')
      expect(h.chrome.textEntry).toBeNull()
      expect(instances).toHaveLength(2)
    })
  })

  describe('cancellation', () => {
    it('a tool cancel that throws during dispose still aborts the open edit', () => {
      let edit: SceneEditTransaction | null = null
      const rectangle: StubTool = stubTool('rectangle', {
        gesture: (g) => {
          if (g.kind === 'press') {
            edit = rectangle.ctx().effects.edits.begin('interaction-rectangle')
            edit.mutate((draft) => {
              draft.zones = [rectZone('z2', [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }])]
            })
          }
          if (g.kind === 'cancel') throw new Error('cancel failed')
          return 'pass'
        },
      })
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle' })

      h.press({ x: 10, y: 10 })
      expect(h.store.persisted.zones.map((zone) => zone.id)).toEqual(['z2'])
      expect(() => h.dispose()).toThrow('cancel failed')
      // The edit is aborted even though the tool's own cancel failed during dispose.
      expect(h.store.persisted.zones).toEqual([])
    })

    it('arming another tool cancels the live press and switches the tools', () => {
      const rectangle = stubTool('rectangle')
      const ellipse = stubTool('ellipse')
      useStubTools(rectangle, ellipse)
      const h = harness({ tool: 'rectangle' })

      h.press({ x: 10, y: 10 })
      h.move({ x: 30, y: 30 })
      h.arm('ellipse')
      expect(rectangle.last('cancel')).toEqual({ kind: 'cancel', reason: 'tool-change' })
      expect(rectangle.calls).toEqual(['activate', 'cancelTransient:tool-change', 'deactivate:switch'])
      expect(ellipse.calls).toEqual(['activate'])
      expect(h.host.hasLiveGesture()).toBe(false)
    })

    it('entering overview cancels the tool\'s transient with the overview reason', () => {
      const stamp = stubTool('object-stamp')
      useStubTools(stamp)
      const h = harness({ tool: 'object-stamp' })

      h.view.setViewport(OVERVIEW)
      h.advance(0)
      expect(stamp.calls).toContain('cancelTransient:overview')
      expect(stamp.calls).not.toContain('cancelTransient:tool-change')
    })
  })

  describe('registered tools against today\'s session (0B-3 host rulings)', () => {
    it('an admitted press takes its capture before the tool hears it, and a refused press takes none', () => {
      const order: string[] = []
      const rectangle = stubTool('rectangle', {
        gesture: (g) => {
          if (g.kind === 'press' || g.kind === 'handle-drag') order.push(g.kind)
          return 'pass'
        },
      })
      useStubTools(rectangle)
      let busy = false
      const h = harness({
        tool: 'rectangle',
        admission: { revision: signal(0), runWhenSettled: (operation, busyResult) => busy ? busyResult : operation() },
        capturePress: (pointerId) => {
          order.push(`capture:${pointerId}`)
          return true
        },
      })

      h.click({ x: 10, y: 10 }, { pointerId: 7 })
      h.click({ x: 10, y: 10 }, { pointerId: 8, target: { kind: 'handle', id: 'rotate' as ToolHandleId } })
      expect(order).toEqual(['capture:7', 'press', 'capture:8', 'handle-drag', 'handle-drag'])

      busy = true
      expect(h.press({ x: 20, y: 20 }, { pointerId: 9 })).toEqual({ quarantine: true, rejectSession: true })
      expect(h.record.captures).toEqual([7, 8])
    })

    it('a press whose capture is lost while it is taken stops before the tool', () => {
      const rectangle = stubTool('rectangle')
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle', capturePress: () => false })

      expect(h.press({ x: 10, y: 10 }, { pointerId: 4 })).toEqual({ rejectSession: true })
      expect(h.record.captures).toEqual([4])
      expect(rectangle.count('press')).toBe(0)
      expect(h.host.hasLiveGesture()).toBe(false)
    })

    it('a tool call inside an effect neither loops on the transient-history revision nor leaves the effect reading the tool\'s signals', () => {
      const probe = signal(0)
      const select = stubTool('select', {
        sceneChanged: () => {
          void probe.value
        },
      })
      useStubTools(select)
      const h = harness()
      let runs = 0

      const stop = effect(() => {
        runs += 1
        h.host.sceneChanged()
      })
      try {
        expect(runs).toBe(1)
        probe.value += 1
        expect(runs).toBe(1)
      } finally {
        stop()
      }
    })

    it('a deferred commit that settles inside an effect bumps the transient-history revision without looping', () => {
      let settle: (() => void) | null = null
      // A coordinator that holds the commit's continuation (today's retained publication) until the effect runs it.
      const edits: SceneEditCoordinator = {
        begin: () => {
          throw new Error('unused')
        },
        run(_type, _edit, options) {
          settle = options?.onCommitted ?? null
          return true
        },
      }
      const polygon: StubTool = stubTool('polygon', {
        gesture: (g) => {
          if (g.kind === 'tap') polygon.ctx().effects.edits.run('interaction-polygon', () => {}, { onCommitted: () => {} })
          return 'pass'
        },
      })
      useStubTools(polygon)
      const h = harness({ tool: 'polygon', edits })
      h.click({ x: 10, y: 10 })
      const changes = h.record.transientHistoryChanges

      let runs = 0
      const stop = effect(() => {
        runs += 1
        settle?.()
      })
      try {
        expect(runs).toBe(1)
        expect(h.record.transientHistoryChanges).toBe(changes + 1)
      } finally {
        stop()
      }
    })

    it('a dragover hides the tool\'s draft until the pointer next moves over the map, as today\'s one preview element', () => {
      const ghost: DraftPresentation = {
        shapes: [{ kind: 'circle-px', center: { x: 50, y: 50 }, radiusPx: 4, style: { token: 'draft', widthPx: 1 } }],
      }
      const stamp: StubTool = stubTool('object-stamp', {
        gesture: (g) => {
          if (g.kind === 'hover') stamp.ctx().effects.setDraft(ghost)
          return 'handled'
        },
      })
      useStubTools(stamp)
      const h = harness({ tool: 'object-stamp' })
      const ghostShown = (): boolean => h.renderer.lastDraft()?.shapes.includes(ghost.shapes[0]!) ?? false
      h.hover({ x: 50, y: 50 })
      expect(h.renderer.lastDraft()).toEqual(ghost)

      h.drop('over', { x: 60, y: 60 }, { kind: 'species', species: null })
      expect(ghostShown()).toBe(false)
      expect(h.renderer.lastDraft()?.shapes.map((shape) => shape.kind)).toEqual(['quad'])
      // A camera frame re-emits the resting pointer: the draft stays hidden while the drop preview shows.
      h.wheelZoom({ x: 60, y: 60 }, 1.5)
      h.advance(16)
      expect(ghostShown()).toBe(false)
      h.drop('leave')
      expect(h.renderer.lastDraft()).toBeNull()

      h.hover({ x: 70, y: 70 })
      expect(h.renderer.lastDraft()).toEqual(ghost)

      h.drop('over', { x: 60, y: 60 }, { kind: 'unknown' })
      h.drop('drop', { x: 60, y: 60 }, { kind: 'unknown' })
      expect(h.renderer.lastDraft()).toBeNull()
      h.hover({ x: 80, y: 80 })
      expect(h.renderer.lastDraft()).toEqual(ghost)
    })

    it('a press after a dragover shows the tool\'s draft again', () => {
      const corners: DraftPresentation = {
        shapes: [{ kind: 'circle-px', center: { x: 50, y: 50 }, radiusPx: 4, style: { token: 'draft', widthPx: 1 } }],
      }
      const polygon: StubTool = stubTool('polygon', {
        gesture: (g) => {
          if (g.kind === 'press') polygon.ctx().effects.setDraft(corners)
          return 'handled'
        },
      })
      useStubTools(polygon)
      const h = harness({ tool: 'polygon' })
      h.click({ x: 50, y: 50 }, { pointer: 'pen' })
      expect(h.renderer.lastDraft()).toEqual(corners)

      h.drop('over', { x: 60, y: 60 }, { kind: 'unknown' })
      h.drop('leave')
      expect(h.renderer.lastDraft()).toBeNull()
      // A pen or a finger presses with no hover between: the press over the map shows the draft again, as a hover would.
      h.press({ x: 70, y: 70 }, { pointer: 'pen' })
      expect(h.renderer.lastDraft()).toEqual(corners)
    })
  })

  describe('drops (spec §1.4 "Drops")', () => {
    const PEAR: PlantStampSourceInput = { canonical_name: 'Pyrus communis', common_name: 'Pear', stratum: 'mid', width_max_m: 3 }
    const PEAR_OVER: CanvasDropPayload = { kind: 'species', species: null }
    const PEAR_DROP: CanvasDropPayload = { kind: 'species', species: PEAR }
    /** A saved stamp of one bed and one apple, its anchor at the bed's corner. */
    const GUILD = normalizeSavedObjectStampPayload({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [{
        id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
        position: { x: 4, y: 3 }, rotationDeg: null,
      }],
      zones: [{
        id: 'zone-1', name: 'Bed', zoneType: 'rect', rotationDeg: 0, fillColor: null,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }],
      }],
      annotations: [],
      groups: [],
    })!
    const GUILD_DRAG: CanvasDropPayload = { kind: 'saved-stamp', stamp: GUILD }
    /** Today's band select draft: the selection stroke at 2 px over the selection fill. */
    const BAND_STYLE = { style: { token: 'selection', widthPx: 2 }, fill: { token: 'selection-fill' } } as const

    function lockLayer(h: ToolHarness, name: string): void {
      h.store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === name ? { ...layer, locked: true } : layer))
      })
    }

    /** The Scene Edits that committed, by history type. */
    function committedEdits(h: ToolHarness): string[] {
      const committed: string[] = []
      const run = h.edits.run.bind(h.edits)
      vi.spyOn(h.edits, 'run').mockImplementation((type, edit, options) => {
        const done = run(type, edit, options)
        if (done) committed.push(type)
        return done
      })
      return committed
    }

    /** The first corner of each bed the saved stamps' ghosts draw (GUILD's bed corner is its anchor). */
    function ghostBedCorners(h: ToolHarness): WorldPoint[] {
      return (h.renderer.lastDraft()?.shapes ?? []).flatMap((shape) =>
        shape.kind === 'ghost' && shape.entity.kind === 'objects'
          ? shape.entity.template.zones.map(({ entity }) => entity.points[0]!)
          : [])
    }

    it('a species drop places a plant and returns to Select in any tool', () => {
      for (const id of ['select', 'polygon', 'text', 'object-stamp', 'plant-spacing'] as const) {
        const armed = stubTool(id)
        useStubTools(armed, ...(id === 'select' ? [] : [stubTool('select')]))
        const h = harness({ tool: id, snapping: { grid: true } })
        const committed = committedEdits(h)
        const at = { x: 53, y: 67 }
        const interval = gridInterval(h.view.view().pixelsPerMetre).interval
        const snapped = snapToGrid(53, 67, interval)

        expect(h.drop('drop', at, PEAR_DROP), id).toEqual({})

        expect(h.store.persisted.plants, id).toHaveLength(1)
        const plant = h.store.persisted.plants[0]!
        expect(plant, id).toMatchObject({ canonicalName: 'Pyrus communis', commonName: 'Pear', position: snapped, canopySpreadM: 3 })
        expect(h.store.session.selectedTargets, id).toEqual([{ kind: 'plant', id: plant.id }])
        expect(committed, id).toEqual(['interaction-drop'])
        expect(h.toolState.value, id).toBe('select')
        expect(h.record.focus, id).toEqual(['map'])
        expect(h.record.drops, id).toEqual(['species'])
        // A drop is no tool gesture.
        expect(armed.gestures, id).toEqual([])
      }
    })

    it('a saved-stamp drop places its objects at the snapped point, selected, returns to Select and reports it', () => {
      useStubTools(stubTool('rectangle'), stubTool('select'))
      const h = harness({ tool: 'rectangle', snapping: { grid: true } })
      const committed = committedEdits(h)
      const interval = gridInterval(h.view.view().pixelsPerMetre).interval
      const anchor = snapToGrid(83, 91, interval)

      h.drop('drop', { x: 83, y: 91 }, GUILD_DRAG)

      expect(h.store.persisted.zones.map((zone) => zone.points[0])).toEqual([anchor])
      expect(h.store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: anchor.x + 4, y: anchor.y + 3 }])
      expect(h.store.session.selectedTargets).toHaveLength(2)
      expect(committed).toEqual(['interaction-saved-object-stamp'])
      expect(h.toolState.value).toBe('select')
      expect(h.record.focus).toEqual(['map'])
      expect(h.record.drops).toEqual(['saved-stamp'])

      // A stamp whose layer is locked places nothing and is not reported: the drag source stays with the panel.
      lockLayer(h, 'zones')
      h.drop('drop', { x: 120, y: 120 }, GUILD_DRAG)
      expect(h.store.persisted.zones).toHaveLength(1)
      expect(h.record.drops).toEqual(['saved-stamp'])
    })

    it('a saved stamp dropped from Favorites at 30 is level to the screen', () => {
      useStubTools(stubTool('rectangle'), stubTool('select'))
      const h = harness({ tool: 'rectangle', camera: { bearingDeg: 30 } })
      const at = { x: 150, y: 120 }
      const screenOf = (world: WorldPoint) => h.view.view().worldToScreen(world)

      // Its dragover ghost is the pick a click would make: turned by the bearing.
      h.drop('over', at, GUILD_DRAG)
      const ghost = (h.renderer.lastDraft()?.shapes ?? []).find((shape) => shape.kind === 'ghost' && shape.entity.kind === 'objects')
      expect(ghost?.kind === 'ghost' && ghost.entity.kind === 'objects' ? ghost.entity.template.zones[0]!.entity.rotationDeg : null)
        .toBe(30)

      h.drop('drop', at, GUILD_DRAG)

      // The bed and the apple sit on screen as they were saved, north up: the bed's top edge level, the apple 4 px
      // right of and 3 px below its corner (scale 1).
      const bed = h.store.persisted.zones[0]!
      expect(bed.rotationDeg).toBeCloseTo(30, 6)
      const [nw, ne] = getRectangularZoneCorners(bed)!.map(screenOf)
      expect(nw!.x).toBeCloseTo(at.x, 6)
      expect(nw!.y).toBeCloseTo(at.y, 6)
      expect(ne!.y).toBeCloseTo(at.y, 6)
      expect(ne!.x - nw!.x).toBeCloseTo(10, 6)
      const apple = screenOf(h.store.persisted.plants[0]!.position)
      expect(apple.x).toBeCloseTo(at.x + 4, 6)
      expect(apple.y).toBeCloseTo(at.y + 3, 6)
    })

    it('dragover answers copy or none from the payload kind', () => {
      useStubTools(stubTool('rectangle'))
      const h = harness({ tool: 'rectangle' })
      const at = { x: 80, y: 90 }

      expect(h.drop('over', at, PEAR_OVER)).toEqual({ dropEffect: 'copy' })
      expect(h.drop('over', at, GUILD_DRAG)).toEqual({ dropEffect: 'copy' })
      // Not ours: an ordinary text drag, or a saved stamp whose drag source is gone.
      expect(h.drop('over', at, { kind: 'unknown' })).toEqual({ dropEffect: 'none' })

      // The open layers decide: a species needs the plants layer, a stamp every layer it adds to.
      lockLayer(h, 'zones')
      expect(h.drop('over', at, PEAR_OVER)).toEqual({ dropEffect: 'copy' })
      expect(h.drop('over', at, GUILD_DRAG)).toEqual({ dropEffect: 'none' })
      lockLayer(h, 'plants')
      expect(h.drop('over', at, PEAR_OVER)).toEqual({ dropEffect: 'none' })
    })

    it('an unsettled dragover answers none and is quarantined, and an unsettled drop places nothing', () => {
      useStubTools(stubTool('rectangle'), stubTool('select'))
      const h = harness({ tool: 'rectangle' })
      const at = { x: 80, y: 90 }
      const external = h.edits.begin('external-preview')

      expect(h.drop('over', at, PEAR_OVER)).toEqual({ quarantine: true, dropEffect: 'none' })
      expect(h.drop('drop', at, PEAR_DROP)).toEqual({ quarantine: true })
      expect(h.store.persisted.plants).toHaveLength(0)
      expect(h.toolState.value).toBe('rectangle')

      external.abort()
      expect(h.drop('over', at, PEAR_OVER)).toEqual({ dropEffect: 'copy' })
      expect(h.drop('drop', at, PEAR_DROP)).toEqual({})
      expect(h.store.persisted.plants).toHaveLength(1)
    })

    it('dragover shows the drop preview and dragleave, drop and overview clear it', () => {
      useStubTools(stubTool('rectangle'), stubTool('select'))
      const h = harness({ tool: 'rectangle', snapping: { grid: true } })
      const at = { x: 83, y: 91 }
      const interval = gridInterval(h.view.view().pixelsPerMetre).interval

      // A species: a box from the pointer to 12 px right and down, drawn as the band select's draft.
      h.drop('over', at, PEAR_OVER)
      expect(h.renderer.lastDraft()).toEqual({
        shapes: [{
          kind: 'quad',
          corners: [h.world(at), h.world({ x: 95, y: 91 }), h.world({ x: 95, y: 103 }), h.world({ x: 83, y: 103 })],
          ...BAND_STYLE,
        }],
      })
      h.drop('leave')
      expect(h.renderer.lastDraft()).toBeNull()

      // A saved stamp: its ghosts with the anchor at the snapped point, as a placement would put them.
      h.drop('over', at, GUILD_DRAG)
      expect(ghostBedCorners(h)).toEqual([snapToGrid(83, 91, interval)])
      h.drop('drop', at, { kind: 'unknown' })
      expect(h.renderer.lastDraft()).toBeNull()

      // A refused dragover clears it: one that answers none, and one the scene is too busy to read.
      h.drop('over', at, PEAR_OVER)
      h.drop('over', at, { kind: 'unknown' })
      expect(h.renderer.lastDraft()).toBeNull()
      h.drop('over', at, PEAR_OVER)
      const external = h.edits.begin('external-preview')
      h.drop('over', at, PEAR_OVER)
      expect(h.renderer.lastDraft()).toBeNull()
      external.abort()

      // Merged like the decorations: the selected zone's chips stay beside it.
      h.store.updatePersisted((draft) => {
        draft.zones = [bed()]
      })
      h.select(Z1)
      const chips = h.renderer.lastDraft()!.shapes
      h.drop('over', at, PEAR_OVER)
      expect(h.renderer.lastDraft()!.shapes.map((shape) => shape.kind)).toEqual(['quad', ...chips.map((shape) => shape.kind)])

      // Entering overview clears it, and a dragover there shows nothing.
      h.view.setViewport(OVERVIEW)
      expect(h.renderer.lastDraft()?.shapes.some((shape) => shape.kind === 'quad') ?? false).toBe(false)
      h.drop('over', at, PEAR_OVER)
      expect(h.renderer.lastDraft()?.shapes.some((shape) => shape.kind === 'quad') ?? false).toBe(false)
    })

    it('in overview a plant or saved stamp drop is taken, places nothing and goes to the session (canopi-n2cg)', () => {
      useStubTools(stubTool('rectangle'), stubTool('select'))
      const h = harness({ tool: 'rectangle', viewport: OVERVIEW })
      const at = { x: 83, y: 91 }

      // Copy, so the browser fires the drop; no preview.
      expect(h.drop('over', at, PEAR_OVER)).toEqual({ dropEffect: 'copy' })
      expect(h.drop('over', at, GUILD_DRAG)).toEqual({ dropEffect: 'copy' })
      expect(h.renderer.lastDraft()).toBeNull()
      expect(h.drop('over', at, { kind: 'unknown' })).toEqual({ quarantine: true, dropEffect: 'none' })

      expect(h.drop('drop', at, PEAR_DROP)).toEqual({})
      expect(h.drop('drop', at, GUILD_DRAG)).toEqual({})
      expect(h.drop('drop', at, { kind: 'unknown' })).toEqual({ quarantine: true })
      expect(h.record.overviewDrops).toEqual([PEAR_DROP, GUILD_DRAG])
      expect(h.record.drops).toEqual([])
      expect(h.store.persisted.plants).toHaveLength(0)
      expect(h.store.persisted.zones).toHaveLength(0)
    })

  })

  describe('menus', () => {
    /** The real menu port over a store, recording every request it opens. */
    function menuPortFor(store: ReturnType<typeof sceneStoreWith>) {
      const source = createToolSceneSource(store)
      const opened: CanvasContextMenuRequest[] = []
      const view = createTestView()
      const scene = createToolScene(source)
      const port = createContextMenuPort({
        container: document.createElement('div'),
        view: view.view,
        adapter: { open: (request) => opened.push(request), close: () => {} },
        commands: {} as never,
        returnFocus: () => {},
        scene,
        selectionModel: source.selectionModel,
      })
      /** A mouse menu's pick at `at`, as the host makes it (contextMenuTargetAt). */
      const pickAt = (at: WorldPoint) => contextMenuTargetAt(scene, at, 'mouse')
      return { port, opened, view, source, pickAt }
    }

    it('a right-click retargets the selection to the object under it and opens the menu there', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })

      expect(h.menu({ x: 50, y: 50 })).toEqual({})
      expect(h.record.selections).toEqual([[P1]])
      expect(h.record.menus).toEqual([
        { at: h.world({ x: 50, y: 50 }), screen: { x: 50, y: 50 }, pick: { visible: P1, target: P1 } },
      ])

      h.menu({ x: 300, y: 250 })
      expect(h.record.selections).toHaveLength(1)
      expect(h.record.menus.at(-1)).toEqual({
        at: h.world({ x: 300, y: 250 }),
        screen: { x: 300, y: 250 },
        pick: { visible: null, target: null },
      })

      h.menu('selection', 'keyboard')
      expect(h.record.menus.at(-1)).toEqual({ at: 'selection', screen: null })
    })

    it('Turn view to this edge is offered within the pick tolerance (6 px mouse, 16 px long press) of a polygon, rectangle or line edge, on a locked zone too, never from the keyboard and never for an ellipse', () => {
      vi.useFakeTimers()
      try {
        useStubTools(stubTool('select'))
        const zone = (id: string, zoneType: 'polygon' | 'rect' | 'line' | 'ellipse', points: WorldPoint[], locked = false) =>
          ({ ...rectZone(id, points), zoneType, locked })
        // Scale 1: a screen pixel is a metre and the screen is the world.
        const h = harness({
          scene: {
            zones: [
              // A field whose south-east edge runs from (100, 20) down to (60, 100).
              zone('field', 'polygon', [{ x: 20, y: 20 }, { x: 100, y: 20 }, { x: 60, y: 100 }]),
              zone('bed', 'rect', [{ x: 150, y: 20 }, { x: 250, y: 20 }, { x: 250, y: 60 }, { x: 150, y: 60 }], true),
              zone('hedge', 'line', [{ x: 300, y: 20 }, { x: 340, y: 120 }]),
              zone('pond', 'ellipse', [{ x: 200, y: 200 }, { x: 40, y: 20 }]),
            ],
          },
        })
        const offered = () => h.record.menus.at(-1)!.turnViewToEdge

        // 5 px off the field's slanted edge, within its 6 px hit: the field's menu, with the entry (canopi-qd2k: one table).
        const normal = { x: 2 / Math.sqrt(5), y: 1 / Math.sqrt(5) }
        h.menu({ x: 80 + normal.x * 5, y: 60 + normal.y * 5 })
        expect(h.record.selections).toEqual([[{ kind: 'zone', id: 'field' }]])
        expect(offered()).toBeTypeOf('function')
        offered()!()
        vi.advanceTimersByTime(400)
        const view = h.view.view()
        const [a, b] = [view.worldToScreen({ x: 100, y: 20 }), view.worldToScreen({ x: 60, y: 100 })]
        expect(b.y - a.y).toBeCloseTo(0, 6)
        h.view.navigation.resetNorth()
        vi.advanceTimersByTime(400)

        h.menu({ x: 80 + normal.x * 7, y: 60 + normal.y * 7 })
        expect(offered()).toBeUndefined()
        // A long press: a finger's 16 px.
        h.menu({ x: 80 + normal.x * 14, y: 60 + normal.y * 14 }, 'long-press')
        expect(offered()).toBeTypeOf('function')
        h.menu({ x: 80 + normal.x * 18, y: 60 + normal.y * 18 }, 'long-press')
        expect(offered()).toBeUndefined()
        // The locked bed: its own menu, with the entry; the view turns, no object moves.
        h.menu({ x: 200, y: 63 })
        expect(h.record.selections.at(-1)).toEqual([{ kind: 'zone', id: 'bed' }])
        expect(offered()).toBeTypeOf('function')
        h.menu({ x: 324, y: 78 })
        expect(offered()).toBeTypeOf('function')
        h.menu({ x: 240, y: 200 })
        expect(offered()).toBeUndefined()

        h.select({ kind: 'zone', id: 'field' })
        h.menu('selection', 'keyboard')
        expect(offered()).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('a right-click during a nudge series commits the series and opens the menu', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: { plants: [appleAt({ x: 10, y: 10 })] } })
      h.select(P1)

      // The right press commits the series before its menu arrives (rawPress); a keyboard menu, with no press, commits it
      // itself, as today's key did.
      expect(h.arrow('ArrowRight')).toBe('handled')
      expect(h.menu({ x: 300, y: 250 })).toEqual({})
      expect(h.host.hasNudgeSeries()).toBe(false)
      expect(h.record.nudges).toEqual(['nudge:0.1,0', 'end'])
      expect(h.history.canUndo.value).toBe(true)
      expect(h.record.menus).toHaveLength(1)

      expect(h.arrow('ArrowLeft')).toBe('handled')
      expect(h.menu('selection', 'keyboard')).toEqual({})
      expect(h.record.nudges).toEqual(['nudge:0.1,0', 'end', 'nudge:-0.1,0', 'end'])
      expect(h.record.menus).toHaveLength(2)
      h.advance(1_000)
      expect(h.record.nudges).toHaveLength(4)
    })

    describe('the point menu (A16)', () => {
      const CORNER = 'vertex:z1:0' as ToolHandleId
      const DOT = 'edge-mid:z1:0' as ToolHandleId
      const CORNER_HANDLE: ToolHandle = { id: CORNER, anchor: { x: 30, y: 40 }, hitRadiusPx: 10, glyph: 'vertex', label: 'Corner' }

      /** A Select stand-in whose corners answer the point menu (Delete point) and whose dots answer nothing. */
      function pointSelect(behaviour: Parameters<typeof stubTool>[1] = {}): StubTool & { readonly asked: ToolHandleId[] } {
        const asked: ToolHandleId[] = []
        const select = stubTool('select', {
          activate: (ctx) => ctx.effects.setHandles([CORNER_HANDLE]),
          pointMenu: (handle) => {
            asked.push(handle)
            return handle.startsWith('vertex:') ? [{ action: 'delete-point', disabled: false }] : []
          },
          ...behaviour,
        })
        return Object.assign(select, { asked })
      }

      it('a right-click or a long press on a point opens its point menu there, retargeting nothing; a dot\'s empty answer opens today\'s menu', () => {
        const select = pointSelect()
        useStubTools(select, stubTool('rectangle'))
        const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })

        h.host.rawPress('secondary', { kind: 'handle', id: CORNER })
        expect(h.host.menuAt({ x: 50, y: 50 }, 'mouse', CORNER)).toEqual({})
        expect(select.asked).toEqual([CORNER])
        expect(h.record.selections).toEqual([])
        expect(h.record.menus).toEqual([{
          at: h.world({ x: 50, y: 50 }),
          screen: { x: 50, y: 50 },
          pointActions: [{ action: 'delete-point', disabled: false, run: expect.any(Function) }],
        }])
        h.record.menus[0]!.pointActions![0]!.run()
        expect(select.commands).toEqual([{ kind: 'point-action', handle: CORNER, action: 'delete-point' }])

        h.host.menuAt({ x: 50, y: 50 }, 'long-press', CORNER)
        expect(h.record.menus.at(-1)!.pointActions).toHaveLength(1)
        expect(h.record.selections).toEqual([])

        // A dot (an empty answer) opens today's menu at that point, retargeted to the object under it.
        h.host.menuAt({ x: 50, y: 50 }, 'mouse', DOT)
        expect(select.asked).toEqual([CORNER, CORNER, DOT])
        expect(h.record.menus.at(-1)).toEqual({ at: h.world({ x: 50, y: 50 }), screen: { x: 50, y: 50 }, pick: { visible: P1, target: P1 } })
        expect(h.record.selections).toEqual([[P1]])

        // An entry of a tool since retired sends nothing, as Finish shape.
        const stale = h.record.menus[0]!.pointActions![0]!
        h.host.setTool('rectangle', null)
        stale.run()
        expect(select.commands).toHaveLength(1)
      })

      it('a tool with no point menu, or the map itself, gets today\'s menu', () => {
        useStubTools(stubTool('select'))
        const h = harness({ scene: { plants: [appleAt({ x: 50, y: 50 })] } })
        h.host.menuAt({ x: 50, y: 50 }, 'mouse', CORNER)
        expect(h.record.menus).toEqual([{ at: h.world({ x: 50, y: 50 }), screen: { x: 50, y: 50 }, pick: { visible: P1, target: P1 } }])
        expect(h.record.selections).toEqual([[P1]])
      })

      it('Finish shape leads a point menu while the draft can finish', () => {
        const select = pointSelect({ canFinish: () => true })
        useStubTools(select)
        const h = harness()
        h.host.menuAt({ x: 50, y: 50 }, 'mouse', CORNER)
        const menu = h.record.menus.at(-1)!
        expect(menu.finishShape).toBeTypeOf('function')
        expect(menu.pointActions?.map((entry) => entry.action)).toEqual(['delete-point'])
        menu.finishShape!()
        expect(select.commands).toEqual([{ kind: 'confirm' }])
      })

      it('a point entry runs only when the scene admits it', () => {
        let busy = false
        const select = pointSelect()
        useStubTools(select)
        const h = harness({
          admission: { revision: signal(0), runWhenSettled: <T,>(operation: () => T, busyResult: T) => (busy ? busyResult : operation()) },
        })
        h.host.menuAt({ x: 50, y: 50 }, 'mouse', CORNER)
        busy = true
        h.record.menus.at(-1)!.pointActions![0]!.run()
        expect(select.commands).toEqual([])
      })

      it('Shift+F10 on a focused point opens its point menu beside the point; with no point focused, the selection\'s menu', () => {
        const select = pointSelect()
        useStubTools(select)
        const h = harness()
        h.chrome.focusedHandle = CORNER
        h.menu('selection', 'keyboard')
        const screen = h.view.view().worldToScreen(CORNER_HANDLE.anchor)
        expect(h.record.menus.at(-1)).toEqual({
          at: CORNER_HANDLE.anchor,
          screen,
          pointActions: [{ action: 'delete-point', disabled: false, run: expect.any(Function) }],
        })

        h.chrome.focusedHandle = null
        h.menu('selection', 'keyboard')
        expect(h.record.menus.at(-1)).toEqual({ at: 'selection', screen: null })
        expect(select.asked).toEqual([CORNER])
      })
    })

    it('disposing the host closes the canvas menu', () => {
      useStubTools(stubTool('select'))
      const h = harness()

      h.menu({ x: 50, y: 50 })
      expect(h.menuOpen).toBe(true)
      h.host.dispose()
      expect(h.menuOpen).toBe(false)
    })

    it('a menu during a Scene Edit is quarantined', () => {
      const rectangle: StubTool = stubTool('rectangle', {
        gesture: (g) => {
          if (g.kind === 'press') rectangle.ctx().effects.edits.begin('interaction-rectangle')
          return 'pass'
        },
      })
      useStubTools(rectangle)
      const h = harness({ tool: 'rectangle', admission: { revision: signal(0), runWhenSettled: (operation) => operation() } })

      h.press({ x: 10, y: 10 })
      expect(h.menu({ x: 10, y: 10 })).toEqual({ quarantine: true })
      expect(h.record.menus).toEqual([])
    })

    it('the menu port rebuilds today\'s three menu states', () => {
      const store = sceneStoreWith({
        plants: [appleAt({ x: 50, y: 50 }), plantEntity('p2', 'Pyrus communis', { x: 150, y: 50 })],
      })
      store.updateSession((session) => {
        session.selectedTargets = [P1]
      })
      const { port, opened, view, source, pickAt } = menuPortFor(store)

      port.open({ at: { x: 50, y: 50 }, screen: { x: 50, y: 50 }, pick: pickAt({ x: 50, y: 50 }) })
      expect(opened.at(-1)!.selection?.editableTargets).toEqual([P1])
      expect(port.isOpen()).toBe(true)

      port.open({ at: 'selection', screen: null })
      expect(opened.at(-1)!.selection).toEqual(source.selectionModel())
      expect(opened.at(-1)!.world).toEqual({ x: 50, y: 50 })

      port.open({ at: { x: 300, y: 250 }, screen: null, pick: pickAt({ x: 300, y: 250 }) })
      expect(opened.at(-1)!.selection).toBeNull()
      expect(opened.at(-1)!.turnViewToEdge).toBeUndefined()
      // The host's edge turn rides on the request, for the empty map's menu as for an object's.
      const turnViewToEdge = vi.fn()
      port.open({ at: { x: 300, y: 250 }, screen: null, turnViewToEdge })
      expect(opened.at(-1)!.turnViewToEdge).toBe(turnViewToEdge)
      port.open({ at: { x: 50, y: 50 }, screen: { x: 50, y: 50 }, turnViewToEdge })
      expect(opened.at(-1)!.turnViewToEdge).toBe(turnViewToEdge)

      // A point menu (A16): its entries and Finish shape ride on the request, which names no selection.
      const pointActions = [{ action: 'delete-point' as const, disabled: false, run: vi.fn() }]
      const finishShape = vi.fn()
      port.open({ at: { x: 50, y: 50 }, screen: { x: 50, y: 50 }, pointActions, finishShape })
      expect(opened.at(-1)!.pointActions).toBe(pointActions)
      expect(opened.at(-1)!.finishShape).toBe(finishShape)
      expect(opened.at(-1)!.selection).toBeNull()
      expect(opened.at(-1)!.anchor).toEqual({ left: 50, top: 50, right: 50, bottom: 50 })

      store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, locked: true } : layer))
      })
      port.open({ at: { x: 150, y: 50 }, screen: { x: 150, y: 50 }, pick: pickAt({ x: 150, y: 50 }) })
      expect(opened.at(-1)!.selection?.editableTargets).toEqual([])

      port.close()
      expect(port.isOpen()).toBe(false)
      view.dispose()
    })

    it('(canopi-qd2k) a right-click inside a zone, selected or not, opens the empty map\'s menu; on its outline the zone\'s; this reverses canopi-f47t.40', () => {
      const store = sceneStoreWith({
        zones: [rectZone('z1', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }])],
        plants: [appleAt({ x: 50, y: 50 })],
      })
      const { port, opened, view, pickAt } = menuPortFor(store)

      for (const selected of [[], [Z1]]) {
        store.updateSession((session) => { session.selectedTargets = selected })
        expect(pickAt({ x: 30, y: 70 })).toEqual({ visible: null, target: null })
        port.open({ at: { x: 30, y: 70 }, screen: null, pick: pickAt({ x: 30, y: 70 }) })
        expect(opened.at(-1)!.selection).toBeNull()
        expect(pickAt({ x: 3, y: 70 })).toEqual({ visible: Z1, target: Z1 })
      }
      // The outline, once the host has retargeted the selection to it: the zone's menu.
      port.open({ at: { x: 3, y: 70 }, screen: null, pick: pickAt({ x: 3, y: 70 }) })
      expect(opened.at(-1)!.selection?.editableTargets).toEqual([Z1])

      // A locked Zones layer: the outline gets the zone's disabled menu, the inside the empty map's.
      store.updatePersisted((draft) => {
        draft.layers = draft.layers.map((layer) => (layer.name === 'zones' ? { ...layer, locked: true } : layer))
      })
      expect(pickAt({ x: 3, y: 70 })).toEqual({ visible: Z1, target: null })
      expect(pickAt({ x: 30, y: 70 })).toEqual({ visible: null, target: null })
      port.close()
      view.dispose()
    })

    it('(canopi-qd2k) a right-click inside a selected zone retargets nothing and opens the empty map\'s menu; a plant inside it takes the selection', () => {
      useStubTools(stubTool('select'))
      const h = harness({ scene: {
        zones: [rectZone('z1', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }])],
        plants: [appleAt({ x: 50, y: 50 })],
      } })
      h.store.updateSession((session) => { session.selectedTargets = [Z1] })

      h.menu({ x: 30, y: 70 })
      expect(h.record.selections).toEqual([])
      expect(h.record.menus.at(-1)!.pick).toEqual({ visible: null, target: null })
      h.menu({ x: 50, y: 50 })
      expect(h.record.selections).toEqual([[P1]])
    })

    it('the keyboard menu opens beside a shape drawn level at 45, not beside its world box', () => {
      const bed = rectZone('bed', [{ x: -50, y: -10 }, { x: 50, y: -10 }, { x: 50, y: 10 }, { x: -50, y: 10 }], { rotationDeg: 45 })
      const store = sceneStoreWith({ zones: [bed] })
      store.updateSession((session) => {
        session.selectedTargets = [{ kind: 'zone', id: 'bed' }]
      })
      const source = createToolSceneSource(store)
      const opened: CanvasContextMenuRequest[] = []
      const view = createTestView({ screen: { width: 800, height: 600 }, camera: { bearingDeg: 45 } })
      const port = createContextMenuPort({
        container: document.createElement('div'),
        view: view.view,
        adapter: { open: (request) => opened.push(request), close: () => {} },
        commands: {} as never,
        returnFocus: () => {},
        scene: createToolScene(source),
        selectionModel: source.selectionModel,
      })

      port.open({ at: 'selection', screen: null })

      // The bed on screen: a level 100 × 20 px box (1 px/m).
      const corners = getRectangularZoneCorners(bed)!.map((corner) => view.view().worldToScreen(corner))
      const xs = corners.map((corner) => corner.x)
      const ys = corners.map((corner) => corner.y)
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 6)
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6)
      const anchor = opened.at(-1)!.anchor
      expect(anchor.left).toBeCloseTo(Math.min(...xs), 6)
      expect(anchor.right).toBeCloseTo(Math.max(...xs), 6)
      expect(anchor.top).toBeCloseTo(Math.min(...ys), 6)
      expect(anchor.bottom).toBeCloseTo(Math.max(...ys), 6)
      expect(opened.at(-1)!.world).toEqual({ x: 0, y: 0 })
      port.close()
      view.dispose()
    })

    it("the menu port follows every close of the app's menu, with or without a focus return", async () => {
      const source = createToolSceneSource(sceneStoreWith({}))
      const returnFocus = vi.fn()
      const view = createTestView()
      // The app's menu over its own state, which app/canvas-runtime/app-adapter.ts lends the runtime as its adapter.
      const app = document.body.appendChild(document.createElement('div'))
      await act(async () => render(h(CanvasContextMenu, null), app))
      const port = createContextMenuPort({
        container: document.createElement('div'),
        view: view.view,
        adapter: { open: openCanvasContextMenu, close: closeCanvasContextMenu },
        // No command runs here: each one does nothing.
        commands: new Proxy({}, { get: () => () => false }) as CanvasContextMenuCommands,
        returnFocus,
        scene: createToolScene(source),
        selectionModel: source.selectionModel,
      })
      const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
      const openMenu = async () => {
        await act(async () => port.open({ at: { x: 10, y: 10 }, screen: { x: 10, y: 10 } }))
        expect(menu()).not.toBeNull()
        expect(port.isOpen()).toBe(true)
      }

      try {
        // A press or focus elsewhere, a resize, a scroll: the app's menu closes itself and gives no focus back.
        for (const closeElsewhere of [
          () => document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })),
          () => app.dispatchEvent(new FocusEvent('focusin', { bubbles: true })),
          () => window.dispatchEvent(new Event('resize')),
          () => document.dispatchEvent(new Event('scroll')),
        ]) {
          await openMenu()
          await act(async () => { closeElsewhere() })
          expect(menu()).toBeNull()
          expect(port.isOpen()).toBe(false)
        }
        expect(returnFocus).not.toHaveBeenCalled()

        // Esc: the menu closes and gives focus back to the map.
        await openMenu()
        await act(async () => {
          menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(menu()).toBeNull()
        expect(returnFocus).toHaveBeenCalledOnce()
        expect(port.isOpen()).toBe(false)

        // A newer menu replaces the open one, whose close leaves the newer one open until the runtime closes it.
        await openMenu()
        await openMenu()
        await act(async () => port.close())
        expect(menu()).toBeNull()
        expect(port.isOpen()).toBe(false)
      } finally {
        await act(async () => {
          closeCanvasContextMenu()
          render(null, app)
        })
        app.remove()
        view.dispose()
      }
    })
  })
})
