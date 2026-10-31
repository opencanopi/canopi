// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// the Object and saved stamps end to end through the session: Esc and `[` `]` through the keyboard port, the
// saved-stamp read model through the session's source bridge, and a Favorites drag over a held stamp. The stamp tools' own
// behaviour is tested through the ToolHarness in canvas/runtime/tools/{object-stamp,saved-object-stamp}.test.ts (0B-3 D4).
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { describe, expect, it, vi } from 'vitest'
import {
  clearSavedObjectStampDragSource,
  readSavedObjectStampSource,
  selectSavedObjectStampSource,
  writeSavedObjectStampDragData,
} from '../canvas/saved-object-stamp-source'
import { armCanvasTool } from '../app/keyboard/arming'
import { parseSavedObjectStampPayload } from '../canvas/saved-object-stamp-payload'
import { setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import type { CanvasToolGuidance } from '../canvas/session-state'
import type { DraftPresentation } from '../canvas/runtime/tools/draft'
import type { SceneStore } from '../canvas/runtime/scene'
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

    const setTool = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { setTool })
    const session = createTestSession(deps)
    session.setTool('object-stamp')

    events.pointerDown({ x: 40, y: 40 }, { button: 0 })
    events.pointerUp({ x: 40, y: 40 }, { button: 0 })
    // The held pick is the tool's transient: the first Esc drops it and the tool stays armed.
    expect(session.keyboard.escapeLayers()).toEqual(['tool-transient', 'tool'])
    events.keyDown({ key: 'Escape' })
    expect(setTool).not.toHaveBeenCalledWith('select')
    events.pointerDown({ x: 90, y: 90 }, { button: 0 })
    events.pointerUp({ x: 90, y: 90 }, { button: 0 })
    expect(store.persisted.plants).toHaveLength(1)

    // With nothing held, Esc leaves for Select.
    expect(session.keyboard.escapeLayers()).toEqual(['tool'])
    events.keyDown({ key: 'Escape' })
    expect(setTool).toHaveBeenCalledWith('select')
    session.dispose()
  })

  it('places a held saved stamp once, then returns to Select and drops the stamp', () => {
    selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [{
        id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
        position: { x: 0, y: 0 }, rotationDeg: null, scale: null,
      }],
      zones: [],
      annotations: [],
      groups: [],
    })
    const setTool = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { setTool })
    const session = createTestSession(deps)
    session.setTool('saved-object-stamp')

    events.pointerMove({ x: 100, y: 100 })
    events.pointerDown({ x: 100, y: 100 }, { button: 0 })
    events.pointerUp({ x: 100, y: 100 }, { button: 0 })

    expect(store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: 100, y: 100 }])
    expect(setTool).toHaveBeenCalledWith('select')
    expect(readSavedObjectStampSource()).toBeNull()
    events.pointerDown({ x: 150, y: 150 }, { button: 0 })
    events.pointerUp({ x: 150, y: 150 }, { button: 0 })
    expect(store.persisted.plants).toHaveLength(1)
    session.dispose()
  })

  it('a Favorites drag over the map hides the held stamp\'s ghost until the pointer moves over the map again', () => {
    selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [{
        id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
        position: { x: 0, y: 0 }, rotationDeg: null, scale: null,
      }],
      zones: [],
      annotations: [],
      groups: [],
    })
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
    session.setTool('saved-object-stamp')
    events.pointerMove({ x: 100, y: 100 }, { buttons: 0 })
    expect(ghostAnchor()).toEqual({ x: 100, y: 100 })

    try {
      // Another saved stamp dragged from Favorites: its ghost, the host's drop preview, takes the held stamp's place, as
      // today's one preview element.
      dispatchDrag('dragover', { x: 60, y: 60 }, (transfer) => writeSavedObjectStampDragData(transfer, PEAR_STAMP))
      expect(ghosts()).toEqual([{ at: [{ x: 60, y: 60 }], plants: ['Pyrus communis'] }])
      dispatchDrag('dragleave', { x: 60, y: 60 })
      expect(drafts.at(-1)).toBeNull()
      events.pointerMove({ x: 120, y: 120 }, { buttons: 0 })
      expect(ghostAnchor()).toEqual({ x: 120, y: 120 })

      // A drop that places nothing leaves the stamp armed: the next move shows its ghost again too.
      dispatchDrag('dragover', { x: 60, y: 60 })
      expect(drafts.at(-1)).toBeNull()
      dispatchDrag('drop', { x: 60, y: 60 })
      expect(drafts.at(-1)).toBeNull()
      expect(store.persisted.plants).toHaveLength(0)
      events.pointerMove({ x: 140, y: 140 }, { buttons: 0 })
      expect(ghostAnchor()).toEqual({ x: 140, y: 140 })
      events.pointerDown({ x: 140, y: 140 }, { button: 0 })
      events.pointerUp({ x: 140, y: 140 }, { button: 0 })
      expect(store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: 140, y: 140 }])
    } finally {
      clearSavedObjectStampDragSource()
      session.dispose()
    }
  })

  it('choosing another saved stamp in Favorites hides the held stamp\'s turned ghost until the next move, which shows the new one upright', () => {
    selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [{
        id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
        position: { x: 10, y: 0 }, rotationDeg: null, scale: null,
      }],
      zones: [],
      annotations: [],
      groups: [],
    })
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
    session.setTool('saved-object-stamp')
    events.pointerMove({ x: 100, y: 100 }, { buttons: 0 })
    events.keyDown({ key: ']', target: container })
    // The apple saved 10 m east of the anchor turns 15° about the pointer.
    const turned = ghost()!
    expect(turned.map(({ name }) => name)).toEqual(['Malus domestica'])
    expect(turned[0]!.at.x).toBeCloseTo(100 + 10 * Math.cos(Math.PI / 12), 6)
    expect(turned[0]!.at.y).toBeCloseTo(100 + 10 * Math.sin(Math.PI / 12), 6)
    expect(published.at(-1)?.stampRotationDeg).toBe(15)

    // Favorites' click: arming writes the read model, then arms the tool again (the session's setTool runs the cancellation).
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ tools: { setTool: (name) => session.setTool(name) } }),
    }))
    const pear = parseSavedObjectStampPayload(PEAR_STAMP.payload_json)!
    expect(armCanvasTool('saved-object-stamp', { from: 'panel', source: { kind: 'saved-stamp', stamp: pear, name: PEAR_STAMP.name } })).toBe(true)
    expect(ghost()).toBeNull()

    events.pointerMove({ x: 120, y: 120 }, { buttons: 0 })
    expect(ghost()).toEqual([{ name: 'Pyrus communis', at: { x: 120, y: 120 } }])
    expect(published.at(-1)?.stampRotationDeg).toBe(0)
    session.dispose()
  })

  describe('stamp rotation', () => {
    function holdSavedStamp(): void {
      selectSavedObjectStampSource({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
          position: { x: 10, y: 0 }, rotationDeg: null, scale: null,
        }],
        zones: [{
          id: 'zone-1', name: null, zoneType: 'rect', rotationDeg: 0, fillColor: null,
          points: [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }],
        }],
        annotations: [{
          id: 'annotation-1', annotationType: 'text', position: { x: 0, y: 10 }, text: 'Mulch', fontSize: 16, rotationDeg: null,
        }],
        groups: [],
      })
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
      session.setTool('object-stamp')
      // Nothing held yet: ] falls back to Bring to front, which this fixture's command sink leaves unconsumed.
      expect(events.keyDown({ key: ']', target: container }).defaultPrevented).toBe(false)

      store.updatePersisted((draft) => {
        draft.plants = [{
          kind: 'plant', locked: false, id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple',
          color: null, canopySpreadM: 2, position: { x: 50, y: 60 }, rotationDeg: null,
          notes: null, plantedDate: null, quantity: 1,
        }]
      })
      events.pointerDown({ x: 54, y: 63 }, { button: 0 })
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
      events.pointerDown({ x: 100, y: 120 }, { button: 0 })
      expect(store.persisted.plants[1]?.position).toEqual({ x: 103, y: 116 })
      session.dispose()
    })

    it('with single-key shortcuts off, turns the stamp only while the map has focus', () => {
      holdSavedStamp()
      singleKeyShortcuts.value = false
      const { session, angle } = rotationSession()
      session.setTool('saved-object-stamp')
      events.pointerMove({ x: 100, y: 100 }, { button: 0 })

      expect(events.keyDown({ key: ']' }).defaultPrevented).toBe(false)
      expect(angle()).toBe(0)
      events.keyDown({ key: ']', target: container })
      expect(angle()).toBe(15)
      session.dispose()
    })

    it('starts each new stamp upright', () => {
      holdSavedStamp()
      const { session, angle } = rotationSession()
      session.setTool('saved-object-stamp')
      events.keyDown({ key: ']', target: container })
      expect(angle()).toBe(15)
      holdSavedStamp()
      events.pointerMove({ x: 100, y: 100 }, { button: 0 })
      expect(angle()).toBe(0)
      session.setTool('select')
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
