// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// the Object and saved stamps end to end through the session: Esc and `[` `]` through the keyboard port, the
// saved-stamp read model through the session's source bridge, and a Favorites drag over a held stamp. The stamp tools' own
// behaviour is tested through the ToolHarness in canvas/runtime/tools/{object-stamp,saved-object-stamp}.test.ts (0B-3 D4).
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { describe, expect, it } from 'vitest'
import {
  clearSavedObjectStampDragSource,
  writeSavedObjectStampDragData,
} from '../canvas/stamp-drag-data'
import { armCanvasTool } from '../app/keyboard/arming'
import { parseSavedObjectStampPayload } from '../canvas/saved-object-stamp-payload'
import { setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import type { CanvasToolGuidance } from '../canvas/session-state'
import type { DraftPresentation } from '../canvas/runtime/tools/draft'
import type { ScenePoint, SceneStore } from '../canvas/runtime/scene'
import { singleKeyShortcuts } from '../app/settings/state'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import type { TestView } from './support/test-view'
import {
  createInteractionDeps,
  installSceneInteractionFixture,
} from './support/canvas-interaction-setup'
import './support/camera-tolerance'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const { createTestSession } = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  const world = (at: ScenePoint) => testView.view().screenToWorld(at)
  const screen = (at: ScenePoint) => testView.view().worldToScreen(at)

  /** A panel drag event over the map at a container point, carrying `data` (by default nothing of ours). */
  function dispatchDrag(type: 'dragover' | 'dragleave' | 'drop', at: { x: number, y: number }, data?: (transfer: DragDataLike) => void): void {
    const dragData = new Map<string, string>()
    const dataTransfer: DragDataLike = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() { return Array.from(dragData.keys()) },
      setData(format: string, value: string) { dragData.set(format, value) },
      getData(format: string) { return dragData.get(format) ?? '' },
    }
    data?.(dataTransfer)
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
    const point = events.clientPoint(at)
    Object.defineProperties(event, {
      clientX: { configurable: true, value: point.x },
      clientY: { configurable: true, value: point.y },
      dataTransfer: { configurable: true, value: dataTransfer },
    })
    container.dispatchEvent(event)
  }

  it('Esc drops the pick, a second Esc leaves', () => {
    store.updatePersisted((draft) => {
      draft.plants = [{
        kind: 'plant',
        locked: false,
        id: 'plant-1',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        canopySpreadM: 2,
        position: { x: 40, y: 40 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: 1,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.arm('object-stamp')

    events.pointerDown({ x: 40, y: 40 }, { button: 0 })
    events.pointerUp({ x: 40, y: 40 }, { button: 0 })
    // The held pick is the tool's transient: the first Esc drops it and the tool stays armed.
    expect(session.keyboard.escapeLayers()).toEqual(['tool-transient', 'tool'])
    events.keyDown({ key: 'Escape' })
    expect(session.tool).toBe('object-stamp')
    events.pointerDown({ x: 90, y: 90 }, { button: 0 })
    events.pointerUp({ x: 90, y: 90 }, { button: 0 })
    expect(store.persisted.plants).toHaveLength(1)

    // With nothing held, Esc leaves for Select.
    expect(session.keyboard.escapeLayers()).toEqual(['tool'])
    events.keyDown({ key: 'Escape' })
    expect(session.tool).toBe('select')
    session.dispose()
  })

  const appleStampSource = (x = 0) => ({
    kind: 'saved-stamp' as const,
    name: 'Apple',
    stamp: {
      version: 2 as const,
      anchor: { x: 0, y: 0 },
      plants: [{
        id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
        position: { x, y: 0 }, rotationDeg: null, scale: null,
      }],
      zones: [],
      annotations: [],
      groups: [],
    },
  })

  it('places a held saved stamp once, then returns to Select and drops the stamp', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.arm('saved-object-stamp', appleStampSource())

    events.pointerMove({ x: 100, y: 100 })
    events.pointerDown({ x: 100, y: 100 }, { button: 0 })
    events.pointerUp({ x: 100, y: 100 }, { button: 0 })

    expect(store.persisted.plants.map((plant) => plant.position)).toEqual([world({ x: 100, y: 100 })])
    expect(session.tool).toBe('select')
    events.pointerDown({ x: 150, y: 150 }, { button: 0 })
    events.pointerUp({ x: 150, y: 150 }, { button: 0 })
    expect(store.persisted.plants).toHaveLength(1)
    session.dispose()
  })

  it('a Favorites drag over the map hides the held stamp\'s ghost until the pointer moves over the map again', () => {
    const drafts: (DraftPresentation | null)[] = []
    /** Where the ghost draws the stamp's plant, which sits on its anchor. */
    const ghostAnchor = () => {
      const shape = drafts.at(-1)?.shapes.find((entry) => entry.kind === 'ghost')
      return shape?.kind === 'ghost' && shape.entity.kind === 'objects' ? shape.entity.template.plants[0]!.entity.position : null
    }
    /** Every ghost the last draft shows, by its plants' positions and species. */
    const ghosts = () => (drafts.at(-1)?.shapes ?? []).flatMap((shape) =>
      shape.kind === 'ghost' && shape.entity.kind === 'objects'
        ? [{
            at: shape.entity.template.plants.map(({ entity }) => entity.position),
            plants: shape.entity.template.plants.map(({ entity }) => entity.canonicalName),
          }]
        : [])
    const session = createTestSession({
      ...createInteractionDeps(container, store, testView),
      renderer: { setDraft: (draft) => { drafts.push(draft) } },
    })
    session.arm('saved-object-stamp', appleStampSource())
    events.pointerMove({ x: 100, y: 100 }, { buttons: 0 })
    expect(ghostAnchor()).toEqual(world({ x: 100, y: 100 }))

    try {
      // Another saved stamp dragged from Favorites: its ghost, the host's drop preview, takes the held stamp's place, as
      // today's one preview element.
      dispatchDrag('dragover', { x: 60, y: 60 }, (transfer) => writeSavedObjectStampDragData(transfer, PEAR_STAMP))
      expect(ghosts()).toEqual([{ at: [world({ x: 60, y: 60 })], plants: ['Pyrus communis'] }])
      dispatchDrag('dragleave', { x: 60, y: 60 })
      expect(drafts.at(-1)).toBeNull()
      events.pointerMove({ x: 120, y: 120 }, { buttons: 0 })
      expect(ghostAnchor()).toEqual(world({ x: 120, y: 120 }))

      // A drop that places nothing leaves the stamp armed: the next move shows its ghost again too.
      dispatchDrag('dragover', { x: 60, y: 60 })
      expect(drafts.at(-1)).toBeNull()
      dispatchDrag('drop', { x: 60, y: 60 })
      expect(drafts.at(-1)).toBeNull()
      expect(store.persisted.plants).toHaveLength(0)
      events.pointerMove({ x: 140, y: 140 }, { buttons: 0 })
      expect(ghostAnchor()).toEqual(world({ x: 140, y: 140 }))
      events.pointerDown({ x: 140, y: 140 }, { button: 0 })
      events.pointerUp({ x: 140, y: 140 }, { button: 0 })
      expect(store.persisted.plants.map((plant) => plant.position)).toEqual([world({ x: 140, y: 140 })])
    } finally {
      clearSavedObjectStampDragSource()
      session.dispose()
    }
  })

  it('choosing another saved stamp in Favorites hides the held stamp\'s turned ghost until the next move, which shows the new one upright', () => {
    const drafts: (DraftPresentation | null)[] = []
    const published: CanvasToolGuidance[] = []
    /** The ghost's plants, where a press would place them. */
    const ghost = () => {
      const shape = drafts.at(-1)?.shapes.find((entry) => entry.kind === 'ghost')
      if (shape?.kind !== 'ghost' || shape.entity.kind !== 'objects') return null
      return shape.entity.template.plants.map(({ entity }) => ({ name: entity.canonicalName, at: entity.position }))
    }
    const session = createTestSession({
      ...createInteractionDeps(container, store, testView, { publishToolGuidance: (guidance) => { published.push(guidance) } }),
      renderer: { setDraft: (draft) => { drafts.push(draft) } },
    })
    session.arm('saved-object-stamp', appleStampSource(10))
    events.pointerMove({ x: 100, y: 100 }, { buttons: 0 })
    events.keyDown({ key: ']', target: container })
    // 2.1-Q89: when turned 15°, the single-plant stamp pivots on its screen-aligned box centre (the plant itself).
    const anchor = world({ x: 100, y: 100 })
    const turned = ghost()!
    expect(turned.map(({ name }) => name)).toEqual(['Malus domestica'])
    expect(turned[0]!.at.x).toBeCloseTo(anchor.x, 6)
    expect(turned[0]!.at.y).toBeCloseTo(anchor.y, 6)
    expect(published.at(-1)?.stampRotationDeg).toBe(15)

    // Favorites' click: arming passes the new stamp directly through session.arm.
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ tools: { arm: (id, source, request) => session.arm(id, source, request) } }),
    }))
    const pear = parseSavedObjectStampPayload(PEAR_STAMP.payload_json)!
    expect(armCanvasTool('saved-object-stamp', { from: 'panel', source: { kind: 'saved-stamp', stamp: pear, name: PEAR_STAMP.name } })).toBe(true)
    expect(ghost()).toBeNull()

    events.pointerMove({ x: 120, y: 120 }, { buttons: 0 })
    expect(ghost()).toEqual([{ name: 'Pyrus communis', at: world({ x: 120, y: 120 }) }])
    expect(published.at(-1)?.stampRotationDeg).toBe(0)
    session.dispose()
  })

  describe('stamp rotation', () => {
    const SAVED_STAMP_SOURCE = {
      kind: 'saved-stamp' as const,
      name: 'Apple',
      stamp: {
        version: 2 as const,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
          position: { x: 10, y: 0 }, rotationDeg: null, scale: null,
        }],
        zones: [{
          id: 'zone-1', name: null, zoneType: 'rect' as const, rotationDeg: 0, fillColor: null,
          points: [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }],
        }],
        annotations: [{
          id: 'annotation-1', annotationType: 'text' as const, position: { x: 0, y: 10 }, text: 'Mulch', fontSize: 16, rotationDeg: null,
        }],
        groups: [],
      },
    }

    function rotationSession(overrides: Parameters<typeof createInteractionDeps>[3] = {}) {
      const published: CanvasToolGuidance[] = []
      const deps = createInteractionDeps(container, store, testView, {
        publishToolGuidance: (guidance) => { published.push(guidance) },
        ...overrides,
      })
      return { session: createTestSession(deps), angle: () => published.at(-1)?.stampRotationDeg }
    }

    it('keeps ] and [ to the stamp while one is held, and leaves them to the shortcuts otherwise', () => {
      const { session, angle } = rotationSession()
      session.arm('object-stamp')
      // Nothing held yet: ] falls back to Bring to front, which this fixture's command sink leaves unconsumed.
      expect(events.keyDown({ key: ']', target: container }).defaultPrevented).toBe(false)

      store.updatePersisted((draft) => {
        draft.plants = [{
          kind: 'plant', locked: false, id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple',
          color: null, canopySpreadM: 2, position: { x: 50, y: 60 }, rotationDeg: null,
          notes: null, plantedDate: null, quantity: 1,
        }]
      })
      events.pointerDown(screen({ x: 54, y: 63 }), { button: 0 })
      const held = events.keyDown({ key: ']', target: container })
      expect(held.defaultPrevented).toBe(true)
      expect(angle()).toBe(15)
      // Modified brackets and brackets typed in a field are not stamp turns.
      events.keyDown({ key: ']', ctrlKey: true, target: container })
      const field = document.createElement('input')
      container.appendChild(field)
      events.keyDown({ key: ']', target: field })
      expect(angle()).toBe(15)

      for (let turn = 0; turn < 5; turn += 1) events.keyDown({ key: ']', target: container })
      // The sampled plant was picked 4 m east and 3 m south of its centre; at 90° that offset turns too.
      events.pointerDown(screen({ x: 100, y: 120 }), { button: 0 })
      expect(store.persisted.plants[1]?.position.x).toBeCloseTo(103, 6)
      expect(store.persisted.plants[1]?.position.y).toBeCloseTo(116, 6)
      session.dispose()
    })

    it('with single-key shortcuts off, turns the stamp only while the map has focus', () => {
      singleKeyShortcuts.value = false
      const { session, angle } = rotationSession()
      session.arm('saved-object-stamp', SAVED_STAMP_SOURCE)
      events.pointerMove({ x: 100, y: 100 }, { button: 0 })

      expect(events.keyDown({ key: ']' }).defaultPrevented).toBe(false)
      expect(angle()).toBe(0)
      events.keyDown({ key: ']', target: container })
      expect(angle()).toBe(15)
      session.dispose()
    })

    it('starts each new stamp upright', () => {
      const { session, angle } = rotationSession()
      session.arm('saved-object-stamp', SAVED_STAMP_SOURCE)
      events.keyDown({ key: ']', target: container })
      expect(angle()).toBe(15)
      session.arm('saved-object-stamp', { ...SAVED_STAMP_SOURCE, stamp: { ...SAVED_STAMP_SOURCE.stamp } })
      events.pointerMove({ x: 100, y: 100 }, { button: 0 })
      expect(angle()).toBe(0)
      session.arm('select')
      expect(angle()).toBeNull()
      session.dispose()
    })
  })
})

/** A saved stamp record as Favorites drags it. */
const PEAR_STAMP = {
  id: 'stamp-pear',
  name: 'Pear',
  sort_order: 0,
  created_at: '2026-06-19T09:00:00Z',
  updated_at: '2026-06-19T09:00:00Z',
  payload_json: JSON.stringify({
    version: 2,
    anchor: { x: 0, y: 0 },
    plants: [{
      id: 'plant-1', canonicalName: 'Pyrus communis', commonName: 'Pear', color: null, symbol: null,
      position: { x: 0, y: 0 }, rotationDeg: null,
    }],
    zones: [],
    annotations: [],
    groups: [],
  }),
}

interface DragDataLike {
  effectAllowed: string
  dropEffect: string
  readonly types: readonly string[]
  setData(format: string, value: string): void
  getData(format: string): string
}
