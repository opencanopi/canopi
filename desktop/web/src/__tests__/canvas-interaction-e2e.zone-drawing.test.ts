// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// tests that arm Polygon, Rectangle, Ellipse, Line or Measure.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts. The session draws its drafts into a recording
// renderer (the draft sink scene-runtime.ts passes); the tools' own behaviour is tested in canvas/runtime/tools/*.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { selectPlantStampSource } from '../canvas/plant-stamp-source'
import { currentCanvasSelection } from '../canvas/session-state'
import { snapToGridEnabled } from '../app/canvas-settings/signals'
import type { SceneStore, ScenePoint } from '../canvas/runtime/scene'
import type {
  SceneInteractionSession,
  SceneInteractionSessionDeps,
} from '../canvas/runtime/interaction-session'
import { SceneHistory } from '../canvas/runtime/scene-history'
import { SceneRuntimeReoriginController } from '../canvas/runtime/scene-runtime/reorigin'
import {
  SceneRuntimeEditCoordinator,
  type SceneEditCoordinator,
  type SceneEditTransaction,
} from '../canvas/runtime/scene-runtime/transactions'
import type { DraftShape } from '../canvas/runtime/tools/draft'
import { createRecordingRenderer, type RecordingRenderer } from './support/recording-renderer'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import { createTestView, type TestView } from './support/test-view'
import {
  storedGeo,
  contextMenuCommand,
  contextMenuHost,
  contextMenuItemIds,
  createInteractionDeps,
  makePlant,
  createSelectionCommands,
  plantTarget,
  createAbortFailingSceneEdits,
  withoutNativeRandomUUID,
  captureWindowErrors,
  installSceneInteractionFixture,
  enterOverview,
} from './support/canvas-interaction-setup'
import './support/camera-tolerance'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness
  let renderer: RecordingRenderer

  const fixture = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )
  const { openContextMenu, openContextMenuFromKeyboard } = fixture

  beforeEach(() => {
    renderer = createRecordingRenderer()
  })

  /** A session whose drafts reach this suite's recording renderer, in place of the one createInteractionDeps brings. */
  function createTestSession(deps: SceneInteractionSessionDeps): SceneInteractionSession {
    return fixture.createTestSession({ ...deps, renderer })
  }

  function draftShapes(): readonly DraftShape[] {
    return renderer.lastDraft()?.shapes ?? []
  }

  /** The first shape of the draft: the drag's rectangle, ellipse or line. */
  function draftOutline(): DraftShape | undefined {
    return draftShapes()[0]
  }

  /** The polygon draft's rubber band (today's SVG draft line), in world points; null without one. */
  function draftBand(): readonly ScenePoint[] | null {
    const band = draftShapes().find((shape) => shape.kind === 'polyline')
    return band?.kind === 'polyline' ? band.points : null
  }

  /** The draft's chips (today's zone measurement labels). */
  function draftChips(): string[] {
    return draftShapes().flatMap((shape) => shape.kind === 'label' ? [shape.text] : [])
  }

  /**
   * The drag's Scene Edit with `hook` run first in its commit continuation, where the tool clears its draft (today the
   * measurement overlay's replaceChildren): the fault point of the cleanup-fault test.
   */
  function withCommitContinuation(base: SceneEditCoordinator, type: string, hook: () => void): SceneEditCoordinator {
    return {
      run: (runType, edit, options) => base.run(runType, edit, options),
      begin(beginType, options) {
        if (beginType !== type) return base.begin(beginType, options)
        const onCommitted = options?.onCommitted
        return base.begin(beginType, {
          ...options,
          onCommitted: () => {
            hook()
            onCommitted?.()
          },
        })
      },
    }
  }

  it('opens the context menu during a drawing gesture without committing the draft', () => {
    const pasteAt = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      selectionCommands: createSelectionCommands({
        canPaste: () => true,
        pasteAt,
      }),
    })
    const session = createTestSession(deps)
    session.setTool('polygon')
    events.pointerDown({ x: 20, y: 20 })
    events.pointerDown({ x: 80, y: 20 })
    events.pointerDown({ x: 80, y: 80 })

    openContextMenu({ x: 200, y: 180 })
    contextMenuCommand('paste').run()

    expect(pasteAt).toHaveBeenCalledWith({ x: 200, y: 180 })
    expect(store.persisted.zones).toHaveLength(0)
    expect(draftBand()).not.toBeNull()
    session.dispose()
  })

  it('aborts an active drawing when overview begins and quarantines its late pointer-up', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('rectangle')

    events.pointerDown({ x: 20, y: 20 }, { button: 0, pointerId: 72 })
    events.pointerMove({ x: 80, y: 60 }, { button: 0, pointerId: 72 })
    enterOverview(testView)
    events.pointerUp({ x: 80, y: 60 }, { button: 0, pointerId: 72 })

    expect(store.persisted.zones).toEqual([])
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it.each([
    { label: 'Rectangle', tool: 'rectangle' },
    { label: 'Measurement Guide', tool: 'measurement-guide' },
  ] as const)('keeps a $label drag authoritative until pointer-up commits it', ({ tool }) => {
    const history = new SceneHistory()
    const record = history.record.bind(history)
    let unrelatedRecordFailures = 2
    vi.spyOn(history, 'record').mockImplementation((command, transaction) => {
      const recorded = record(command, transaction)
      if (command.type === 'unrelated-immediate' && unrelatedRecordFailures > 0) {
        unrelatedRecordFailures -= 1
        throw new Error('unrelated publication failed')
      }
      return recorded
    })
    const baseDeps = createInteractionDeps(container, store, testView)
    const coordinator = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      history,
      setSelection: baseDeps.setSelection,
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    const deps: SceneInteractionSessionDeps = {
      ...baseDeps,
      sceneEdits: coordinator,
      commandAdmission: coordinator,
    }
    const session = createTestSession(deps)
    session.setTool(tool)

    events.pointerDown({ x: 10, y: 20 })
    events.pointerMove({ x: 40, y: 60 })
    const unrelatedEdit = vi.fn((tx: SceneEditTransaction) => {
      tx.mutate((draft) => {
        draft.plantSpeciesColors['Malus domestica'] = '#335577'
      })
    })
    let unrelatedResult: boolean | undefined
    expect(() => {
      unrelatedResult = coordinator.run('unrelated-immediate', unrelatedEdit)
    }).not.toThrow()
    expect(unrelatedResult).toBe(false)
    events.pointerUp({ x: 40, y: 60 })

    expect(unrelatedEdit).not.toHaveBeenCalled()
    if (tool === 'rectangle') {
      expect(store.persisted.zones).toHaveLength(1)
      expect(store.persisted.zones[0]).toMatchObject({
        zoneType: 'rect',
        points: [
          { x: 10, y: 20 },
          { x: 40, y: 20 },
          { x: 40, y: 60 },
          { x: 10, y: 60 },
        ],
      })
    } else {
      expect(store.persisted.measurementGuides).toEqual([
        expect.objectContaining({
          start: { x: 10, y: 20 },
          end: { x: 40, y: 60 },
        }),
      ])
    }
    session.dispose()
  })

  it.each([
    {
      label: 'Rectangle',
      tool: 'rectangle',
      editType: 'interaction-rectangle',
    },
    {
      label: 'Measurement Guide',
      tool: 'measurement-guide',
      editType: 'interaction-measurement-guide',
    },
  ] as const)('a failed $label drag abort is rolled back by the fault rule at once, admitting the next gesture normally', ({
    tool,
    editType,
  }) => {
    const baseDeps = createInteractionDeps(container, store, testView)
    const abortFailure = createAbortFailingSceneEdits(
      baseDeps.sceneEdits,
      editType,
      `${editType} abort failed`,
    )
    const session = createTestSession({
      ...baseDeps,
      sceneEdits: abortFailure.sceneEdits,
    })
    session.setTool(tool)

    events.pointerDown({ x: 10, y: 20 }, { pointerId: 71 })
    events.pointerMove({ x: 40, y: 60 }, { pointerId: 71 })
    const errors = captureWindowErrors(() => {
      events.pointerCancel({ x: 40, y: 60 }, { pointerId: 71 })
    })

    expect(errors).toEqual([
      expect.objectContaining({ message: `${editType} abort failed` }),
    ])
    // The fault rule's abort inside the same cancellation has already rolled the edit back.
    expect(abortFailure.abortCalls()).toBe(2)
    expect(abortFailure.beginTypes()).toEqual([editType])

    events.pointerDown({ x: 10, y: 20 }, { pointerId: 72 })
    expect(abortFailure.abortCalls()).toBe(2)
    events.pointerMove({ x: 40, y: 60 }, { pointerId: 72 })
    events.pointerUp({ x: 40, y: 60 }, { pointerId: 72 })

    expect(abortFailure.beginTypes()).toEqual([editType, editType])
    if (tool === 'rectangle') {
      expect(store.persisted.zones).toHaveLength(1)
    } else {
      expect(store.persisted.measurementGuides).toHaveLength(1)
    }
    session.dispose()
  })

  it('a pointer-up whose commit fails finishes publication at once, then reaches the app', () => {
    const history = new SceneHistory()
    const record = history.record.bind(history)
    let publicationFailures = 2
    vi.spyOn(history, 'record').mockImplementation((command, transaction) => {
      const recorded = record(command, transaction)
      if (command.type === 'interaction-rectangle' && publicationFailures > 0) {
        publicationFailures -= 1
        throw new Error('rectangle publication failed')
      }
      return recorded
    })
    const baseDeps = createInteractionDeps(container, store, testView)
    const coordinator = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      history,
      setSelection: baseDeps.setSelection,
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    const session = createTestSession({
      ...baseDeps,
      sceneEdits: coordinator,
      commandAdmission: coordinator,
    })
    session.setTool('rectangle')
    const downstreamPointerUp = vi.fn()
    window.addEventListener('pointerup', downstreamPointerUp)

    try {
      events.pointerDown({ x: 10, y: 20 }, { pointerId: 81 })
      events.pointerMove({ x: 40, y: 60 }, { pointerId: 81 })
      const pointerUpEvents: PointerEvent[] = []
      const errors = captureWindowErrors(() => {
        pointerUpEvents.push(events.pointerUp({ x: 40, y: 60 }, { pointerId: 81 }))
      })

      // The commit ran once: history recorded it before its publication threw, and the fault rule aborted nothing. A
      // pointerup is not a press on the map host, so it rethrows and reaches the app rather than being quarantined.
      expect(errors).toHaveLength(1)
      expect(pointerUpEvents[0]?.defaultPrevented).toBe(false)
      expect(downstreamPointerUp).toHaveBeenCalled()
      expect(store.persisted.zones).toHaveLength(1)
      expect(coordinator.canUndo.value).toBe(true)
      expect(coordinator.undo()).toBe(true)
      expect(coordinator.undo()).toBe(false)
      expect(store.persisted.zones).toHaveLength(0)
    } finally {
      window.removeEventListener('pointerup', downstreamPointerUp)
      session.dispose()
    }
  })

  it.each([
    { label: 'Rectangle', tool: 'rectangle' },
    { label: 'Measurement Guide', tool: 'measurement-guide' },
  ] as const)('a $label commit whose cleanup throws keeps the shape once, leaving nothing open for the next drag', ({ tool }) => {
    const history = new SceneHistory()
    const baseDeps = createInteractionDeps(container, store, testView)
    const coordinator = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      history,
      setSelection: baseDeps.setSelection,
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    let cleanupFailures = 1
    const session = createTestSession({
      ...baseDeps,
      sceneEdits: withCommitContinuation(coordinator, `interaction-${tool}`, () => {
        if (cleanupFailures > 0) {
          cleanupFailures -= 1
          throw new Error(`${tool} cleanup failed`)
        }
      }),
      commandAdmission: coordinator,
    })
    session.setTool(tool)

    events.pointerDown({ x: 10, y: 20 }, { pointerId: 91 })
    events.pointerMove({ x: 40, y: 60 }, { pointerId: 91 })
    if (draftChips().length === 0) throw new Error(`Expected ${tool} draft measurements`)

    try {
      const errors = captureWindowErrors(() => {
        events.pointerUp({ x: 40, y: 60 }, { pointerId: 91 })
      })

      // The commit ran each step once: the shape is kept, the cleanup is not run again, and nothing is left open.
      expect(errors).toHaveLength(1)
      expect(cleanupFailures).toBe(0)
      expect(coordinator.canUndo.value).toBe(true)
      if (tool === 'rectangle') {
        expect(store.persisted.zones).toHaveLength(1)
      } else {
        expect(store.persisted.measurementGuides).toHaveLength(1)
      }

      events.pointerDown({ x: 50, y: 70 }, { pointerId: 93 })
      events.pointerMove({ x: 80, y: 100 }, { pointerId: 93 })
      events.pointerUp({ x: 80, y: 100 }, { pointerId: 93 })

      if (tool === 'rectangle') {
        expect(store.persisted.zones).toHaveLength(2)
        expect(coordinator.undo()).toBe(true)
        expect(store.persisted.zones).toHaveLength(1)
        expect(coordinator.undo()).toBe(true)
        expect(store.persisted.zones).toHaveLength(0)
      } else {
        expect(store.persisted.measurementGuides).toHaveLength(2)
        expect(coordinator.undo()).toBe(true)
        expect(store.persisted.measurementGuides).toHaveLength(1)
        expect(coordinator.undo()).toBe(true)
        expect(store.persisted.measurementGuides).toHaveLength(0)
      }
      expect(coordinator.undo()).toBe(false)
    } finally {
      session.dispose()
    }
  })

  it('does not create rectangle zones on a locked Zones Layer', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: true } : layer
      ))
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('rectangle')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 40, y: 60 }, { button: 0 })
    events.pointerUp({ x: 40, y: 60 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('creates a linear zone from the Line tool drag', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('line')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 40, y: 60 }, { button: 0 })

    expect(draftOutline()).toMatchObject({ kind: 'polyline', points: [{ x: 10, y: 20 }, { x: 40, y: 60 }] })

    events.pointerUp({ x: 40, y: 60 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'line',
      rotationDeg: 0,
      points: [
        { x: 10, y: 20 },
        { x: 40, y: 60 },
      ],
    })
    expect(store.toCanopiFile().zones[0]).toMatchObject({
      zone_type: 'line',
      rotation: 0,
      locked: false,
      points: [
        storedGeo(store, { x: 10, y: 20 }),
        storedGeo(store, { x: 40, y: 60 }),
      ],
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-line')
    expect(deps.setSelection).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('does not create linear zones on a locked Zones Layer', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: true } : layer
      ))
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('line')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 40, y: 60 }, { button: 0 })
    events.pointerUp({ x: 40, y: 60 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('shows live linear zone length while drawing without persisting it', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('line')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 70, y: 20 }, { button: 0 })

    expect(draftChips()).toEqual(['60 m'])
    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('previews and commits linear zones from snap-adjusted grid points', () => {
    // At scale=4, gridInterval() returns 5m.
    testView.setViewport({ x: 0, y: 0, scale: 4 })
    snapToGridEnabled.value = true

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('line')

    events.pointerDown({ x: 43, y: 87 }, { button: 0 })
    events.pointerMove({ x: 148, y: 254 }, { button: 0 })

    // Screen (40, 80) to (140, 260) at 4 px/m.
    expect(draftOutline()).toMatchObject({ kind: 'polyline', points: [{ x: 10, y: 20 }, { x: 35, y: 65 }] })

    events.pointerUp({ x: 148, y: 254 }, { button: 0 })

    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'line',
      rotationDeg: 0,
      points: [
        { x: 10, y: 20 },
        { x: 35, y: 65 },
      ],
    })
    session.dispose()
  })

  it('does not commit too-short linear zones', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('line')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerMove({ x: 10.2, y: 10.2 }, { button: 0 })
    events.pointerUp({ x: 10.2, y: 10.2 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('creates an elliptical zone from the ellipse tool drag', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('ellipse')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 70, y: 100 }, { button: 0 })

    expect(draftOutline()).toMatchObject({ kind: 'ellipse', center: { x: 40, y: 60 }, radiusX: 30, radiusY: 40 })

    events.pointerUp({ x: 70, y: 100 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'ellipse',
      rotationDeg: 0,
      points: [
        { x: 40, y: 60 },
        { x: 30, y: 40 },
      ],
    })
    expect(store.toCanopiFile().zones[0]).toMatchObject({
      zone_type: 'ellipse',
      rotation: 0,
      locked: false,
      // Files store the opposite corners of the unrotated bounding box.
      points: [
        storedGeo(store, { x: 10, y: 20 }),
        storedGeo(store, { x: 70, y: 100 }),
      ],
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-ellipse')
    expect(deps.setSelection).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('does not create elliptical zones on a locked Zones Layer', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: true } : layer
      ))
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('ellipse')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 70, y: 100 }, { button: 0 })
    events.pointerUp({ x: 70, y: 100 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('normalizes elliptical zone drags in any direction', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('ellipse')

    events.pointerDown({ x: 110, y: 90 }, { button: 0 })
    events.pointerMove({ x: 10, y: 10 }, { button: 0 })
    events.pointerUp({ x: 10, y: 10 }, { button: 0 })

    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'ellipse',
      rotationDeg: 0,
      points: [
        { x: 60, y: 50 },
        { x: 50, y: 40 },
      ],
    })
    session.dispose()
  })

  it('previews and commits elliptical zones from snap-adjusted grid points', () => {
    // At scale=4, gridInterval() returns 5m.
    testView.setViewport({ x: 0, y: 0, scale: 4 })
    snapToGridEnabled.value = true

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('ellipse')

    events.pointerDown({ x: 43, y: 87 }, { button: 0 })
    events.pointerMove({ x: 148, y: 254 }, { button: 0 })

    // Screen (40, 80) to (140, 260) at 4 px/m.
    expect(draftOutline()).toMatchObject({ kind: 'ellipse', center: { x: 22.5, y: 42.5 }, radiusX: 12.5, radiusY: 22.5 })

    events.pointerUp({ x: 148, y: 254 }, { button: 0 })

    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'ellipse',
      rotationDeg: 0,
      points: [
        { x: 22.5, y: 42.5 },
        { x: 12.5, y: 22.5 },
      ],
    })
    session.dispose()
  })

  it('shows live elliptical zone measurements while drawing without persisting them', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('ellipse')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 70, y: 100 }, { button: 0 })

    expect(draftChips()).toEqual([
      'W 60 m',
      'H 80 m',
      '3770 m²',
    ])
    expect(store.persisted.annotations).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('does not commit too-small elliptical zones', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('ellipse')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerMove({ x: 10.2, y: 10.4 }, { button: 0 })
    events.pointerUp({ x: 10.2, y: 10.4 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('does not create polygonal zones on a locked Zones Layer', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, locked: true } : layer
      ))
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 40 }, { button: 0 })
    events.keyDown({ key: 'Enter', cancelable: true })

    expect(store.persisted.zones).toHaveLength(0)
    expect(draftBand()).toBeNull()
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('previews polygonal zone active edges from snap-adjusted grid points', () => {
    // At scale=4, gridInterval() returns 5m.
    testView.setViewport({ x: 0, y: 0, scale: 4 })
    snapToGridEnabled.value = true

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 43, y: 87 }, { button: 0 })
    events.pointerMove({ x: 148, y: 254 }, { button: 0 })

    // Screen (40, 80) to (140, 260) at 4 px/m.
    expect(draftBand()).toEqual([{ x: 10, y: 20 }, { x: 35, y: 65 }])
    session.dispose()
  })

  it('shows a live polygonal zone active-edge measurement while drawing', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerMove({ x: 60, y: 10 }, { button: 0 })

    expect(draftChips()).toEqual(['50 m'])
    session.dispose()
  })

  it('clears existing selection when starting a polygonal zone draft', () => {
    store.updatePersisted((draft) => {
      draft.plants = [{
        kind: 'plant',
        locked: false,
        id: 'plant-1',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        canopySpreadM: 2,
        position: { x: 80, y: 80 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: 1,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    deps.setSelection([plantTarget('plant-1')])
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })

    expect(currentCanvasSelection.value.size).toBe(0)
    // History-free, through the session's selection (ToolEffects.setSelection).
    expect(deps.setSelection).toHaveBeenCalledTimes(2)
    expect(deps.setSelection).toHaveBeenLastCalledWith([])
    session.dispose()
  })

  it('shows polygonal zone draft edge measurements, closing edge, and live area', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerMove({ x: 60, y: 50 }, { button: 0 })

    expect(draftChips()).toEqual([
      '50 m',
      '40 m',
      '64 m',
      '1000 m²',
    ])
    session.dispose()
  })

  it('closes a polygonal zone by clicking the first vertex', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 50 }, { button: 0 })
    events.pointerDown({ x: 12, y: 11 }, { button: 0 })

    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'polygon',
      rotationDeg: 0,
      points: [
        { x: 10, y: 10 },
        { x: 60, y: 10 },
        { x: 60, y: 50 },
      ],
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-polygon')
    session.dispose()
  })

  it('finishes a polygonal zone with a double-click or the canvas menu\'s first entry, Finish shape', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 60, y: 50 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 60, y: 50 }, { button: 0, detail: 2 })
    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])

    events.pointerDown({ x: 110, y: 10 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 160, y: 10 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 160, y: 50 }, { button: 0, detail: 1 })
    openContextMenu({ x: 200, y: 180 })
    expect(contextMenuItemIds()[0]).toBe('finish-shape')
    contextMenuCommand('finish-shape').run()
    expect(store.persisted.zones).toHaveLength(2)
    expect(store.persisted.zones[1]!.points).toEqual([{ x: 110, y: 10 }, { x: 160, y: 10 }, { x: 160, y: 50 }])
    session.dispose()
  })

  it('a double-click finishes a polygon when the platform sends detail 0, with no duplicate corner', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    for (const point of [{ x: 10, y: 10 }, { x: 60, y: 10 }]) {
      events.pointerDown(point, { button: 0, detail: 0 })
      events.pointerUp(point, { button: 0 })
    }
    events.pointerDown({ x: 60, y: 50 }, { button: 0, detail: 0 })
    events.pointerUp({ x: 60, y: 50 }, { button: 0 })
    events.pointerDown({ x: 60, y: 50 }, { button: 0, detail: 0 })
    events.pointerUp({ x: 60, y: 50 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])
    session.dispose()
  })

  it('U39 a still right-click during a polygon draft keeps the selection, and the menu disables Cut and Delete', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('plant-2', 'Malus domestica', { x: 300, y: 250 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')
    events.pointerDown({ x: 110, y: 110 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 160, y: 110 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 160, y: 150 }, { button: 0, detail: 1 })
    // The first corner cleared the selection; a panel selects during the draft.
    deps.setSelection([plantTarget('plant-1')])

    openContextMenu({ x: 300, y: 250 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([plantTarget('plant-1')])
    expect(contextMenuItemIds()[0]).toBe('finish-shape')
    expect(contextMenuCommand('cut').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    expect(contextMenuCommand('copy').disabled).toBe(false)

    openContextMenuFromKeyboard()
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([plantTarget('plant-1')])
    expect(contextMenuItemIds()[0]).toBe('finish-shape')
    expect(contextMenuCommand('cut').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    expect(store.persisted.plants).toHaveLength(2)

    // Esc steps the draft back to nothing (A17): the menu retargets again.
    for (let corner = 0; corner < 3; corner += 1) events.keyDown({ key: 'Escape' })
    openContextMenu({ x: 300, y: 250 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-2']))
    expect(contextMenuCommand('cut').disabled).toBe(false)
    expect(contextMenuCommand('delete').disabled).toBe(false)
    session.dispose()
  })

  describe('the Esc chain in a polygon draft', () => {
    function escapeOnMap(): KeyboardEvent {
      return events.keyDown({ key: 'Escape', target: container })
    }

    function sessionWithToolLog(): { session: SceneInteractionSession, tools: string[] } {
      const tools: string[] = []
      const deps = createInteractionDeps(container, store, testView, { setTool: (name: string) => { tools.push(name) } })
      return { session: createTestSession(deps), tools }
    }

    it('steps a polygon draft back point by point, then returns to Select (A17)', () => {
      const { session, tools } = sessionWithToolLog()
      session.setTool('polygon')
      container.focus()
      events.pointerDown({ x: 20, y: 20 })
      events.pointerUp({ x: 20, y: 20 })
      events.pointerDown({ x: 80, y: 20 })
      events.pointerUp({ x: 80, y: 20 })

      escapeOnMap()
      escapeOnMap()
      expect(tools).not.toContain('select')
      expect(draftBand()).toBeNull()
      expect(document.activeElement).toBe(container)

      escapeOnMap()
      expect(tools.at(-1)).toBe('select')
      session.dispose()
    })
  })

  it('steps polygonal zone drafts back with Escape without dirtying the scene (A17)', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerUp({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerUp({ x: 60, y: 10 }, { button: 0 })
    events.keyDown({ key: 'Escape' })
    expect(draftBand()).not.toBeNull()
    events.keyDown({ key: 'Escape' })

    expect(store.persisted.zones).toHaveLength(0)
    expect(draftBand()).toBeNull()
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('keeps a Backspace the polygon draft consumed from reaching the app shortcuts', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')
    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    // App shortcuts (Delete/Backspace deletes the selection) listen in the bubble
    // phase and stand down for a defaultPrevented key; the event still reaches them.
    const appShortcuts = vi.fn((event: KeyboardEvent) => event.defaultPrevented)
    window.addEventListener('keydown', appShortcuts)
    try {
      const event = events.keyDown({ key: 'Backspace', target: container })
      expect(event.defaultPrevented).toBe(true)
      expect(appShortcuts).toHaveLastReturnedWith(true)
      const passthrough = events.keyDown({ key: 'a', target: container })
      expect(passthrough.defaultPrevented).toBe(false)
      expect(appShortcuts).toHaveLastReturnedWith(false)
      expect(appShortcuts).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener('keydown', appShortcuts)
    }
    session.dispose()
  })

  it('a live polygon draft holds re-origin, which runs after the draft ends and the camera moves', async () => {
    const view = createTestView({ screen: { width: 400, height: 300 }, viewport: { x: 0, y: 0, scale: 1 }, plane: store.sessionPlane })
    const deps = createInteractionDeps(container, store, view)
    const session = createTestSession(deps)
    const edits = deps.sceneEdits as SceneRuntimeEditCoordinator
    const reorigin = new SceneRuntimeReoriginController({
      sceneState: store,
      authority: edits,
      commandAdmission: edits,
      held: () => session.holdsReorigin(),
    })
    const settle = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }
    session.setTool('polygon')
    for (const corner of [{ x: 10, y: 10 }, { x: 60, y: 10 }]) {
      events.pointerDown(corner, { button: 0 })
      events.pointerUp(corner, { button: 0 })
    }
    const previous = store.sessionPlane
    // The viewport is 1 px per metre at the origin, so screen (10, 10) is plane (10, 10).
    const corners = [previous.toGeo({ x: 10, y: 10 }), previous.toGeo({ x: 60, y: 10 }), previous.toGeo({ x: 60, y: 50 })]

    // The view's centre is 20 km east: the draft holds the plane.
    view.navigation.panByPx({ x: -20_000, y: 0 })
    reorigin.observe(view.frames.viewFrame.peek())
    await settle()
    expect(store.sessionPlane).toBe(previous)

    view.navigation.panByPx({ x: 20_000, y: 0 })
    events.pointerDown({ x: 60, y: 50 }, { button: 0 })
    events.pointerUp({ x: 60, y: 50 }, { button: 0 })
    events.keyDown({ key: 'Enter' })
    const near = (geo: { lon: number; lat: number }) => ({ lon: expect.closeTo(geo.lon, 8), lat: expect.closeTo(geo.lat, 8) })
    expect(store.persisted.zones[0]!.points.map((point) => previous.toGeo(point))).toEqual(corners.map(near))

    // The draft has ended: the next far frame re-origins, and the zone keeps its lon/lat.
    view.navigation.panByPx({ x: -20_000, y: 0 })
    reorigin.observe(view.frames.viewFrame.peek())
    await settle()
    const plane = store.sessionPlane
    expect(plane).not.toBe(previous)
    expect(store.persisted.zones[0]!.points.map((point) => plane.toGeo(point))).toEqual(corners.map(near))
    reorigin.dispose()
    session.dispose()
    view.dispose()
  })

  it('undoes and redoes polygonal zone draft vertices without dirtying the scene', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerMove({ x: 60, y: 50 }, { button: 0 })

    expect(session.canUndoTransientHistory()).toBe(true)
    expect(session.undoTransientHistory()).toBe(true)

    expect(draftBand()).toEqual([{ x: 10, y: 10 }, { x: 60, y: 50 }])
    expect(session.canRedoTransientHistory()).toBe(true)

    expect(session.redoTransientHistory()).toBe(true)

    expect(draftBand()).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])
    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('undoes the only polygonal zone draft vertex and can redo it', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })

    expect(session.undoTransientHistory()).toBe(true)
    expect(draftBand()).toBeNull()
    expect(session.canUndoTransientHistory()).toBe(false)
    expect(session.canRedoTransientHistory()).toBe(true)

    expect(session.redoTransientHistory()).toBe(true)

    expect(draftBand()).toEqual([{ x: 10, y: 10 }, { x: 10, y: 10 }])
    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('cancels redo-only polygonal zone draft history with Escape and returns to Select in the same press (A17)', () => {
    const onSceneEditCommit = vi.fn()
    const tools: string[] = []
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit, setTool: (name: string) => { tools.push(name) } })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerUp({ x: 10, y: 10 }, { button: 0 })
    expect(session.undoTransientHistory()).toBe(true)
    expect(session.canRedoTransientHistory()).toBe(true)

    events.keyDown({ key: 'Escape' })

    expect(tools.at(-1)).toBe('select')
    expect(session.canRedoTransientHistory()).toBe(false)
    expect(session.redoTransientHistory()).toBe(false)
    expect(draftBand()).toBeNull()
    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('clears redo-only polygonal zone draft history on window blur', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { pointerId: 1 })
    events.pointerUp({ x: 10, y: 10 }, { pointerId: 1 })
    expect(session.undoTransientHistory()).toBe(true)
    expect(session.canRedoTransientHistory()).toBe(true)

    events.windowBlur()

    // Today's interruption kept the draft only while it had corners (hasPolygonDraft).
    expect(session.canRedoTransientHistory()).toBe(false)
    expect(session.redoTransientHistory()).toBe(false)
    expect(draftBand()).toBeNull()
    session.dispose()
  })

  it('clears polygonal zone draft redo when a new vertex branches the draft', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    expect(session.undoTransientHistory()).toBe(true)
    expect(session.canRedoTransientHistory()).toBe(true)

    events.pointerDown({ x: 60, y: 50 }, { button: 0 })

    expect(session.canRedoTransientHistory()).toBe(false)
    expect(session.redoTransientHistory()).toBe(false)
    session.dispose()
  })

  it('commits only visible polygonal zone draft vertices after undo', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 50 }, { button: 0 })
    events.pointerDown({ x: 10, y: 50 }, { button: 0 })
    expect(session.undoTransientHistory()).toBe(true)
    events.keyDown({ key: 'Enter' })

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'polygon',
      rotationDeg: 0,
      points: [
        { x: 10, y: 10 },
        { x: 60, y: 10 },
        { x: 60, y: 50 },
      ],
    })
    expect(session.canRedoTransientHistory()).toBe(false)
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-polygon')
    session.dispose()
  })

  it('clears polygonal zone draft redo on cancellation and tool switch', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerUp({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerUp({ x: 60, y: 10 }, { button: 0 })
    expect(session.undoTransientHistory()).toBe(true)
    expect(session.canRedoTransientHistory()).toBe(true)
    events.keyDown({ key: 'Escape' })
    expect(session.canRedoTransientHistory()).toBe(false)

    events.pointerDown({ x: 20, y: 20 }, { button: 0 })
    events.pointerDown({ x: 80, y: 20 }, { button: 0 })
    expect(session.undoTransientHistory()).toBe(true)
    expect(session.canRedoTransientHistory()).toBe(true)
    session.setTool('select')

    expect(session.canUndoTransientHistory()).toBe(false)
    expect(session.canRedoTransientHistory()).toBe(false)
    session.dispose()
  })

  it('preserves polygonal zone drafts while space-panning the canvas', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerMove({ x: 60, y: 10 }, { button: 0 })

    expect(draftBand()).not.toBeNull()

    events.keyDown({ code: 'Space' })
    events.pointerDown({ x: 200, y: 150 }, { button: 0 })
    events.pointerMove({ x: 220, y: 150 }, { button: 0 })
    events.pointerUp({ x: 220, y: 150 }, { button: 0 })
    events.keyUp({ code: 'Space' })

    expect(draftBand()).not.toBeNull()
    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it.each(['pointercancel', 'blur'] as const)(
    'preserves a polygon draft while %s cancels Space panning',
    (cancellation) => {
      const onSceneEditCommit = vi.fn()
      const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
      const session = createTestSession(deps)
      session.setTool('polygon')

      events.pointerDown({ x: 10, y: 10 }, { pointerId: 1 })
      events.pointerMove({ x: 60, y: 10 }, { pointerId: 1 })
      // The corner's press ends before the pan: one pointer session at a time (ADR 0017).
      events.pointerUp({ x: 60, y: 10 }, { pointerId: 1 })
      events.holdSpace()
      events.pointerDown({ x: 200, y: 150 }, { pointerId: 2 })
      events.pointerMove({ x: 220, y: 150 }, { pointerId: 2 })
      if (cancellation === 'pointercancel') {
        events.pointerCancel({ x: 220, y: 150 }, { pointerId: 2 })
      } else {
        events.windowBlur()
      }

      expect(draftBand()).not.toBeNull()
      expect(store.persisted.zones).toHaveLength(0)
      expect(onSceneEditCommit).not.toHaveBeenCalled()

      events.pointerMove({ x: 60, y: 10 }, { pointerId: 3 })
      events.pointerDown({ x: 60, y: 10 }, { pointerId: 3 })
      expect(session.undoTransientHistory()).toBe(true)
      expect(session.canUndoTransientHistory()).toBe(true)
      session.dispose()
    },
  )

  it('preserves polygonal zone drafts while middle-button panning the canvas', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerMove({ x: 60, y: 10 }, { button: 0 })
    events.pointerDown({ x: 200, y: 150 }, { button: 1 })
    events.pointerMove({ x: 220, y: 150 }, { button: 1 })
    events.pointerUp({ x: 220, y: 150 }, { button: 1 })

    expect(draftBand()).not.toBeNull()
    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('removes polygonal zone draft and measurement overlays on session dispose', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerMove({ x: 60, y: 10 }, { button: 0 })

    expect(draftBand()).not.toBeNull()
    expect(draftChips()).toEqual(['50 m'])

    session.dispose()

    expect(renderer.lastDraft()).toBeNull()
  })

  it('does not commit degenerate polygonal zones', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 }, { button: 0 })
    events.pointerDown({ x: 60, y: 10 }, { button: 0 })
    events.pointerDown({ x: 100, y: 10 }, { button: 0 })
    events.keyDown({ key: 'Enter' })

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('previews and commits rectangle zones from snap-adjusted grid points', () => {
    // At scale=4, gridInterval() returns 5m.
    testView.setViewport({ x: 0, y: 0, scale: 4 })
    snapToGridEnabled.value = true

    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('rectangle')

    events.pointerDown({ x: 43, y: 87 }, { button: 0 })
    events.pointerMove({ x: 148, y: 254 }, { button: 0 })

    // Screen (40, 80) to (140, 260) at 4 px/m.
    expect(draftOutline()).toMatchObject({
      kind: 'polygon',
      points: [{ x: 10, y: 20 }, { x: 35, y: 20 }, { x: 35, y: 65 }, { x: 10, y: 65 }],
    })

    events.pointerUp({ x: 148, y: 254 }, { button: 0 })

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]).toMatchObject({
      zoneType: 'rect',
      rotationDeg: 0,
      points: [
        { x: 10, y: 20 },
        { x: 35, y: 20 },
        { x: 35, y: 65 },
        { x: 10, y: 65 },
      ],
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rectangle')
    session.dispose()
  })

  it('shows live rectangle zone measurements while drawing without persisting them', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('rectangle')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerMove({ x: 70, y: 100 }, { button: 0 })

    expect(draftChips()).toEqual([
      '60 m',
      '80 m',
      '60 m',
      '80 m',
      '4800 m²',
    ])
    expect(store.persisted.annotations).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('creates tool objects when native randomUUID is unavailable', () => {
    withoutNativeRandomUUID(() => {
      let rectangleSession: SceneInteractionSession | null = null
      let plantSession: SceneInteractionSession | null = null

      try {
        rectangleSession = createTestSession(createInteractionDeps(container, store, testView))
        rectangleSession.setTool('rectangle')

        events.pointerDown({ x: 10, y: 20 }, { button: 0 })
        events.pointerMove({ x: 40, y: 60 }, { button: 0 })
        events.pointerUp({ x: 40, y: 60 }, { button: 0 })

        expect(store.persisted.zones).toHaveLength(1)
        rectangleSession.dispose()
        rectangleSession = null

        selectPlantStampSource({
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          stratum: 'high',
          width_max_m: 4,
        })
        plantSession = createTestSession(createInteractionDeps(container, store, testView))
        plantSession.setTool('plant-stamp')

        events.pointerDown({ x: 50, y: 70 }, { button: 0 })

        expect(store.persisted.plants).toHaveLength(1)
      } finally {
        rectangleSession?.dispose()
        plantSession?.dispose()
      }
    })
  })

  it('keeps a polygon edge on 45° angles while Shift is held', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 })
    events.pointerDown({ x: 60, y: 14 }, { shiftKey: true })
    events.pointerDown({ x: 60, y: 50 })
    events.keyDown({ key: 'Enter' })

    const [first, second, third] = store.persisted.zones[0]!.points
    expect(first).toEqual({ x: 10, y: 10 })
    expect(second!.y).toBeCloseTo(10)
    expect(second!.x).toBeCloseTo(Math.hypot(50, 4) + 10)
    expect(third).toEqual({ x: 60, y: 50 })
    session.dispose()
  })
})
