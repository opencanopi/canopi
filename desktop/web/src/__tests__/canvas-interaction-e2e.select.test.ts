// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// tests that arm Select, or arm no tool and assert no listener, wheel or key behaviour.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { writePlantStampDragData } from '../canvas/plant-stamp-source'
import { writeSavedObjectStampDragData } from '../canvas/saved-object-stamp-source'
import { currentCanvasLockedMoveNotice, currentCanvasSelection } from '../canvas/session-state'
import { snapToGridEnabled } from '../app/canvas-settings/signals'
import { createMapLibreCameraDriver } from '../maplibre/camera-driver'
import { createSessionPlane } from '../canvas/session-plane'
import type { SceneStore, ScenePoint } from '../canvas/runtime/scene'
import {
  createSceneInteractionSession,
  type SceneInteractionSession,
  type SceneInteractionSessionDeps,
} from '../canvas/runtime/interaction-session'
import type { CanvasDesignObjectSelectionModel } from '../canvas/runtime/runtime'
import type { ViewFrameSource } from '../canvas/runtime/view/types'
import type {
  SceneCommandAdmission,
  SettledSceneReader,
} from '../canvas/runtime/scene-runtime/transactions'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from './support/canvas-interaction-events'
import {
  AttachedInteractionMap,
  contextMenuHost,
  contextMenuCommand,
  contextMenuItemIds,
  createInteractionDeps,
  createSelectionCommands,
  plantTarget,
  zoneTarget,
  annotationTarget,
  measurementGuideTarget,
  groupTarget,
  createAbortFailingSceneEdits,
  plantHoverTooltip,
  nextAnimationFrame,
  captureWindowErrors,
  makePlant,
  makeRectZone,
  makeTextAnnotation,
  makeMeasurementGuide,
  getDesignObjectSelectionFromStore,
  rotationHandle,
  rotationHandleCenter,
  zoneControlPoint,
  zoneControlPointCenter,
  measurementGuideControlPoint,
  measurementGuideControlPointCenter,
  draftLabelTexts,
  draftShapes,
  selectionBoundsCenter,
  quarterTurnClockwise,
  expectPointCloseTo,
  pointsCenter,
  installSceneInteractionFixture,
} from './support/canvas-interaction-setup'
import { createTestView, type TestView } from './support/test-view'
import './support/camera-tolerance'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const {
    createTestSession,
    openContextMenu,
    openContextMenuFromKeyboard,
    appContextMenu,
    keyCommands,
  } = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  it('refreshes mounted interaction translations in place without closing or moving focus', () => {
    let language = 'en'
    const translate = (key: string, options?: Readonly<Record<string, unknown>>): string =>
      `${language}:${key}${options?.count === undefined ? '' : `:${String(options.count)}`}`
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 100, y: 100 },
        { x: 160, y: 150 },
      ])]
    })
    const deps = createInteractionDeps(container, store, testView, {
      translate,
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    const rotateButton = rotationHandle(container)!
    rotateButton.focus()

    expect(rotateButton.getAttribute('aria-label')).toBe('en:canvas.rotationHandle.label')

    language = 'fr'
    session.refreshTranslations()

    expect(rotationHandle(container)).toBe(rotateButton)
    expect(rotateButton.style.display).toBe('inline-flex')
    expect(document.activeElement).toBe(rotateButton)
    expect(rotateButton.getAttribute('aria-label')).toBe('fr:canvas.rotationHandle.label')
  })

  it('names zone control points and guide ends through translate, and relabels them on a locale switch', () => {
    let language = 'en'
    const translate = (key: string, options?: Readonly<Record<string, unknown>>): string =>
      `${language}:${key}${options?.index === undefined ? '' : `:${String(options.index)}`}`
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 100, y: 100 },
        { x: 160, y: 100 },
        { x: 160, y: 150 },
        { x: 100, y: 150 },
      ])]
      draft.measurementGuides = [
        makeMeasurementGuide('measurement-guide-1', { x: 10, y: 10 }, { x: 60, y: 10 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView, {
      translate,
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')

    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()
    const corner = zoneControlPoint(container, 'rect-corner', 1)!
    expect(corner.getAttribute('aria-label')).toBe('en:canvas.zoneControlPoint.label:2')
    language = 'fr'
    session.refreshTranslations()
    expect(zoneControlPoint(container, 'rect-corner', 1)?.getAttribute('aria-label'))
      .toBe('fr:canvas.zoneControlPoint.label:2')

    deps.setSelection([measurementGuideTarget('measurement-guide-1')])
    session.refreshMeasurements()
    expect(measurementGuideControlPoint(container, 1)?.getAttribute('aria-label'))
      .toBe('fr:canvas.guideEnd.label:2')
    language = 'en'
    session.refreshTranslations()
    expect(measurementGuideControlPoint(container, 0)?.getAttribute('aria-label'))
      .toBe('en:canvas.guideEnd.label:1')
  })

  it('shows no floating action bar: rotation is the only control on a selection', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 100, y: 100 },
        { x: 160, y: 150 },
      ])]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)?.style.display).toBe('inline-flex')
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
    expect(container.querySelector('[data-selection-action-toolbar]')).toBeNull()
    session.dispose()
  })

  it('keeps the rotation handle inside the visible map area, clear of the tool rail and title bar', () => {
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 10, y: 40 },
        { x: 70, y: 90 },
      ])]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()
    const handle = rotationHandle(container)!
    // Without chrome it sits centred above the selection.
    expect(Number.parseFloat(handle.style.left)).toBeCloseTo(26, 6)
    expect(Number.parseFloat(handle.style.top)).toBeCloseTo(8, 6)

    // The labelled tool rail covers 240 px on the left, the title bar 60 px on top.
    testView.navigation.setFramingInsets({ top: 60, right: 0, bottom: 0, left: 240 })
    session.refreshMeasurements()

    expect(Number.parseFloat(handle.style.left)).toBe(248)
    expect(Number.parseFloat(handle.style.top)).toBe(68)
    session.dispose()
  })

  it('selects and drags a plant in scene space', () => {
    store.updatePersisted((draft) => {
      draft.plants = [{
        kind: 'plant',
        id: 'plant-1',
        locked: false,
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        canopySpreadM: 2,
        position: { x: 20, y: 30 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: 1,
      }]
    })

    const render = vi.fn()
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { render, onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 })
    events.pointerMove({ x: 35, y: 45 })
    events.pointerUp({ x: 35, y: 45 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')
    expect(deps.setSelection).toHaveBeenCalledWith([plantTarget('plant-1')])
    session.dispose()
  })

  it('aborts only the matching active pointer on pointer cancellation and accepts the next gesture', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const render = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit, render })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 7, timeStamp: 0 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 7 })
    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })

    events.pointerCancel({ x: 35, y: 45 }, { pointerId: 8 })
    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })

    render.mockClear()
    events.pointerCancel({ x: 35, y: 45 }, { pointerId: 7 })
    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalled()

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 9 })
    events.pointerMove({ x: 25, y: 35 }, { pointerId: 9 })
    events.pointerUp({ x: 25, y: 35 }, { pointerId: 9 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 25, y: 35 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('captures an admitted pointer and fences release-generated loss after committing its edit', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(container, {
      pointerCapture: { synchronousLossOnRelease: true },
    })
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 17 })
    expect(events.pointerCapture.setCalls).toHaveBeenCalledWith(17)
    expect(events.pointerCapture.has(17)).toBe(true)
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 17 })
    events.pointerUp({ x: 35, y: 45 }, { pointerId: 17 })

    expect(events.pointerCapture.releaseCalls).toHaveBeenCalledWith(17)
    expect(events.pointerCapture.has(17)).toBe(false)
    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('rolls back a matching unexpected capture loss without history and accepts the next gesture', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 18, timeStamp: 0 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 18 })
    events.lostPointerCapture(18)

    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 19 })
    events.pointerMove({ x: 40, y: 50 }, { pointerId: 19 })
    events.pointerUp({ x: 40, y: 50 }, { pointerId: 19 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 40, y: 50 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('stops pointer-down routing when capture is lost synchronously during acquisition', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(container, {
      pointerCapture: { synchronousLossOnSet: true },
    })
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 24, timeStamp: 0 })

    expect(events.pointerCapture.setCalls).toHaveBeenCalledWith(24)
    expect(events.pointerCapture.has(24)).toBe(false)
    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })
    expect(deps.setSelection).not.toHaveBeenCalled()
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    events.dispose()
    events = createSceneInteractionEventHarness(container)
    events.pointerDown({ x: 20, y: 30 }, { pointerId: 25 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 25 })
    events.pointerUp({ x: 35, y: 45 }, { pointerId: 25 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('ignores stale capture loss and competing pointer IDs while one captured edit is active', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 20 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 20 })
    events.lostPointerCapture(21)
    events.pointerDown({ x: 200, y: 150 }, { pointerId: 21 })
    events.pointerMove({ x: 220, y: 170 }, { pointerId: 21 })
    events.pointerUp({ x: 220, y: 170 }, { pointerId: 21 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    events.pointerUp({ x: 35, y: 45 }, { pointerId: 20 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    session.dispose()
  })

  it.each([
    ['is unavailable', { available: false }],
    ['throws during acquisition', { setThrows: new Error('capture unavailable') }],
  ] as const)('retains window-listener pointer completion when container capture %s', (_name, pointerCapture) => {
    events.dispose()
    events = createSceneInteractionEventHarness(container, { pointerCapture })
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 22 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 22 })
    events.pointerUp({ x: 35, y: 45 }, { pointerId: 22 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    expect(events.pointerCapture.releaseCalls).not.toHaveBeenCalled()
    session.dispose()
  })

  it('finishes edit cleanup and listener removal when capture release throws', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(container, {
      trackListeners: true,
      pointerCapture: { releaseThrows: new Error('capture release failed') },
    })
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 23 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 23 })
    events.pointerUp({ x: 35, y: 45 }, { pointerId: 23 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    expect(events.pointerCapture.releaseCalls).toHaveBeenCalledWith(23)
    expect(() => session.dispose()).not.toThrow()
    // The source's press listener and the selection-drag guard's.
    expect(events.listenerLog?.containerRemoves('pointerdown')).toHaveLength(2)
    expect(events.listenerLog?.windowRemoves('pointermove')).toHaveLength(1)
  })

  it.each([
    ['pointer cancellation', (_session: SceneInteractionSession) => events.pointerCancel({ x: 35, y: 45 }, { pointerId: 25 })],
    ['Escape', (_session: SceneInteractionSession) => events.keyDown({ key: 'Escape', code: 'Escape' })],
    ['window blur', (_session: SceneInteractionSession) => events.windowBlur()],
    ['tool change', (session: SceneInteractionSession) => session.setTool('rectangle')],
    ['document replacement', (session: SceneInteractionSession) => session.prepareForDocumentReplacement()],
    ['Session disposal', (session: SceneInteractionSession) => session.dispose()],
  ] as const)('releases capture and rolls back an unfinished edit on %s', (_name, cancel) => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 25 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 25 })
    cancel(session)

    expect(events.pointerCapture.releaseCalls).toHaveBeenCalledWith(25)
    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
  })

  it('routes navigation through an attached MapLibre camera while tool drags change only the Scene and detach restores fallback navigation', () => {
    const plane = createSessionPlane({ lat: 48.8566, lon: 2.3522 })
    const attachedView = createTestView({ plane })
    const map = new AttachedInteractionMap()
    const driver = createMapLibreCameraDriver(map, plane, attachedView.host.driverDeps)
    expect(driver.failure.peek()).toBeNull()
    attachedView.host.attach(driver)
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const session = createTestSession(createInteractionDeps(
      container,
      store,
      attachedView,
      { onSceneEditCommit },
    ))
    session.setTool('select')

    const mapCallsBeforeNavigation = map.jumpTo.mock.calls.length
    const plantBeforeNavigation = store.persisted.plants[0]?.position
    events.pointerDown({ x: 200, y: 150 }, { button: 1, pointerId: 26 })
    events.pointerMove({ x: 230, y: 170 }, { button: 1, pointerId: 26 })
    events.pointerUp({ x: 230, y: 170 }, { button: 1, pointerId: 26 })
    events.wheel({ x: 200, y: 150 }, { deltaY: -120 })

    expect(map.jumpTo.mock.calls.length).toBeGreaterThan(mapCallsBeforeNavigation)
    expect(store.persisted.plants[0]?.position).toEqual(plantBeforeNavigation)
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    const mapCallsBeforeToolDrag = map.jumpTo.mock.calls.length
    const viewportBeforeToolDrag = attachedView.viewport()
    events.pointerDown({ x: 140, y: 110 }, { pointerId: 27 })
    events.pointerMove({ x: 180, y: 150 }, { pointerId: 27 })
    events.pointerUp({ x: 180, y: 150 }, { pointerId: 27 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: expect.closeTo(40, 6), y: expect.closeTo(50, 6) })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')
    expect(attachedView.viewport()).toEqual(viewportBeforeToolDrag)
    expect(map.jumpTo).toHaveBeenCalledTimes(mapCallsBeforeToolDrag)

    attachedView.host.detach()
    const mapCallsBeforeDetachPan = map.jumpTo.mock.calls.length
    const viewportBeforeDetachPan = attachedView.viewport()
    events.pointerDown({ x: 200, y: 150 }, { button: 1, pointerId: 28 })
    events.pointerMove({ x: 220, y: 165 }, { button: 1, pointerId: 28 })
    events.pointerUp({ x: 220, y: 165 }, { button: 1, pointerId: 28 })

    expect(attachedView.viewport()).toEqual({
      x: viewportBeforeDetachPan.x + 20,
      y: viewportBeforeDetachPan.y + 15,
      scale: viewportBeforeDetachPan.scale,
    })
    expect(map.jumpTo).toHaveBeenCalledTimes(mapCallsBeforeDetachPan)
    session.dispose()
    attachedView.dispose()
  })

  it('does not let a second pointer replace the active Scene Edit gesture', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 1 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 1 })

    events.pointerDown({ x: 200, y: 150 }, { pointerId: 2 })
    events.pointerMove({ x: 220, y: 170 }, { pointerId: 2 })
    events.pointerUp({ x: 220, y: 170 }, { pointerId: 2 })
    events.pointerCancel({ x: 220, y: 170 }, { pointerId: 2 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    events.pointerMove({ x: 40, y: 50 }, { pointerId: 1 })
    events.pointerUp({ x: 40, y: 50 }, { pointerId: 1 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 40, y: 50 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('aborts an active Scene Edit and releases Space when the window loses focus', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const onSceneEditCommit = vi.fn()
    const setHoveredTarget = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit, setHoveredTarget })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 3 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 3 })
    events.holdSpace()
    setHoveredTarget.mockClear()
    events.windowBlur()

    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(setHoveredTarget).toHaveBeenCalledWith(null)
    expect(container.style.cursor).toBe('default')

    events.pointerDown({ x: 200, y: 150 }, { pointerId: 4 })
    events.pointerMove({ x: 220, y: 150 }, { pointerId: 4 })
    events.pointerUp({ x: 220, y: 150 }, { pointerId: 4 })

    expect(testView.viewport().x).toBeCloseTo(0, 6)
    expect(testView.viewport().y).toBeCloseTo(0, 6)
    session.dispose()
  })

  it('shows the two nearest non-dragged Placed Plant distances while dragging selected Plants', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 0, y: 0 }),
        makePlant('plant-2', 'Malus domestica', { x: -20, y: -20 }),
        makePlant('plant-3', 'Pyrus communis', { x: 6, y: 8 }),
        makePlant('plant-4', 'Prunus avium', { x: 3, y: 9 }),
        makePlant('plant-5', 'Cydonia oblonga', { x: 13, y: 4 }),
        makePlant('plant-6', 'Mespilus germanica', { x: 103, y: 4 }),
      ]
    })

    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([plantTarget('plant-1'), plantTarget('plant-2')])

    events.pointerDown({ x: 0, y: 0 })
    events.pointerMove({ x: 3, y: 4 })

    const lines = draftShapes(deps).filter((shape) => shape.kind === 'polyline')

    expect(store.persisted.plants.find((plant) => plant.id === 'plant-1')?.position).toEqual({ x: 3, y: 4 })
    expect(draftLabelTexts(deps)).toEqual(['5 m', '5 m'])
    expect(lines).toHaveLength(2)
    expect(draftLabelTexts(deps)).not.toContain('10 m')
    expect(draftLabelTexts(deps)).not.toContain('100 m')
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    events.pointerUp({ x: 3, y: 4 })

    expect(draftLabelTexts(deps)).toEqual([])
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')
    session.dispose()
  })

  it('hides the Rotation Handle while dragging a selected Design Object', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()
    expect(rotationHandle(container)?.style.display).toBe('inline-flex')

    events.pointerDown({ x: 20, y: 110 }, { button: 0 })

    expect(rotationHandle(container)).toBeNull()

    events.pointerMove({ x: 40, y: 130 }, { button: 0 })
    events.pointerUp({ x: 40, y: 130 }, { button: 0 })

    expect(rotationHandle(container)?.style.display).toBe('inline-flex')
    session.dispose()
  })

  it('clears Plant Hover Tooltip presentation while dragging a selected Plant', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }, { commonName: 'Apple' })]
    })
    const setHoveredTarget = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { setHoveredTarget })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([plantTarget('plant-1')])

    events.pointerMove({ x: 20, y: 30 })
    const tooltip = plantHoverTooltip()
    expect(tooltip.style.display).toBe('block')
    expect(setHoveredTarget).toHaveBeenCalledWith(plantTarget('plant-1'))
    setHoveredTarget.mockClear()

    events.pointerDown({ x: 20, y: 30 }, { button: 0 })

    expect(tooltip.style.display).toBe('none')
    expect(setHoveredTarget).toHaveBeenCalledWith(null)

    events.pointerMove({ x: 35, y: 45 }, { button: 0 })
    events.pointerUp({ x: 35, y: 45 }, { button: 0 })

    expect(tooltip.style.display).toBe('none')
    session.dispose()
  })

  it('a wheel under a resting pointer hides the Plant Hover Tooltip and keeps the hover on its plant until the next move (Q3 D)', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }, { commonName: 'Apple' })]
    })
    const setHoveredTarget = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { setHoveredTarget }))
    session.setTool('select')

    events.pointerMove({ x: 20, y: 30 })
    const tooltip = plantHoverTooltip()
    expect(tooltip.style.display).toBe('block')
    expect(setHoveredTarget).toHaveBeenLastCalledWith(plantTarget('plant-1'))
    setHoveredTarget.mockClear()
    const viewport = testView.viewport()

    events.wheel({ x: 20, y: 30 }, { deltaY: -120 })

    expect(testView.viewport()).not.toEqual(viewport)
    expect(tooltip.style.display).toBe('none')
    expect(setHoveredTarget).not.toHaveBeenCalled()

    events.pointerMove({ x: 300, y: 250 })
    expect(setHoveredTarget).toHaveBeenLastCalledWith(null)
    session.dispose()
  })

  it('restores selection overlays after a no-op Design Object drag without history', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    events.pointerDown({ x: 20, y: 110 }, { button: 0 })
    expect(rotationHandle(container)).toBeNull()
    events.pointerUp({ x: 20, y: 110 }, { button: 0 })

    expect(rotationHandle(container)?.style.display).toBe('inline-flex')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('restores selection overlays when a Design Object drag is canceled by a tool change', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()
    expect(rotationHandle(container)).not.toBeNull()

    events.pointerDown({ x: 20, y: 110 }, { button: 0 })
    events.pointerMove({ x: 40, y: 130 }, { button: 0 })
    expect(rotationHandle(container)).toBeNull()
    session.setTool('rectangle')

    expect(rotationHandle(container)).toBeNull()
    expect(store.persisted.zones[0]?.points[0]).toEqual({ x: 20, y: 80 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('keeps active drag and rotation gestures moving over the canvas\'s own chrome', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
        // Hovering it brings the plant tooltip, the session's own chrome, onto the map.
        makePlant('plant-2', 'Malus domestica', { x: 300, y: 250 }),
      ]
      draft.zones = [makeRectZone('zone-1', [
        { x: 80, y: 80 },
        { x: 140, y: 80 },
        { x: 140, y: 120 },
        { x: 80, y: 120 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerMove({ x: 300, y: 250 })
    events.pointerMove({ x: 360, y: 280 })

    deps.setSelection([plantTarget('plant-1')])
    session.refreshMeasurements()
    const overlay = plantHoverTooltip()

    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    const overlayMove = events.pointerMove(
      { x: 35, y: 45 },
      { button: 0, target: overlay },
    )
    expect(overlayMove.target).toBe(overlay)
    events.pointerUp({ x: 35, y: 45 }, { button: 0, target: overlay })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 35, y: 45 })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')

    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()
    const handle = rotationHandle(container)!
    const chromeElement = plantHoverTooltip()
    const pivot = selectionBoundsCenter(getDesignObjectSelectionFromStore(store, testView))
    const start = rotationHandleCenter(container)
    const end = quarterTurnClockwise(pivot, start)

    events.pointerDown(start, { button: 0, target: handle })
    const chromeMove = events.pointerMove(
      end,
      { button: 0, target: chromeElement },
    )
    expect(chromeMove.target).toBe(chromeElement)

    expect(store.persisted.zones[0]?.rotationDeg).toBeCloseTo(90)

    events.pointerUp(end, { button: 0, target: chromeElement })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rotate')
    session.dispose()
  })

  it('ends middle-button panning when pointer continuation targets the canvas\'s own chrome', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
        // Hovering it brings the plant tooltip, the session's own chrome, onto the map.
        makePlant('plant-2', 'Malus domestica', { x: 300, y: 250 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerMove({ x: 300, y: 250 })
    events.pointerMove({ x: 360, y: 280 })
    deps.setSelection([plantTarget('plant-1')])
    session.refreshMeasurements()
    const overlay = plantHoverTooltip()

    events.pointerDown({ x: 200, y: 150 }, { pointerId: 41, button: 1 })
    events.pointerMove(
      { x: 230, y: 170 },
      { pointerId: 41, button: 1, target: overlay },
    )
    expect(testView.viewport()).toMatchObject({ x: 30, y: 20 })

    events.pointerUp(
      { x: 230, y: 170 },
      { pointerId: 41, button: 1, target: overlay },
    )
    const releasedViewport = { ...testView.viewport() }
    events.pointerMove({ x: 260, y: 190 }, { pointerId: 41, button: 1 })

    expect(testView.viewport()).toEqual(releasedViewport)
    session.dispose()
  })

  it('selects all visible editable same-Species plants on Select-tool double-click without scene edits', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('apple-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('apple-2', 'Malus domestica', { x: 620, y: 30 }),
        makePlant('pear-1', 'Pyrus communis', { x: 80, y: 30 }),
        makePlant('locked-apple', 'Malus domestica', { x: 120, y: 30 }, { locked: true }),
        makePlant('grouped-apple', 'Malus domestica', { x: 160, y: 30 }),
      ]
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: null,
        members: [{ kind: 'plant', id: 'grouped-apple' }],
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 20, y: 30 }, { button: 0, detail: 1 })
    vi.mocked(deps.setSelection).mockClear()

    events.pointerDown({ x: 20, y: 30 }, { button: 0, detail: 2 })
    events.pointerUp({ x: 20, y: 30 }, { button: 0, detail: 2 })

    expect(currentCanvasSelection.value).toEqual(new Set(['apple-1', 'apple-2']))
    expect(deps.setSelection).toHaveBeenCalledWith([
      plantTarget('apple-1'),
      plantTarget('apple-2'),
    ])
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('toggles same-Species plant sets with Shift double-click', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('apple-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('apple-2', 'Malus domestica', { x: 80, y: 30 }),
        makePlant('pear-1', 'Pyrus communis', { x: 140, y: 30 }),
      ]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    deps.setSelection([plantTarget('pear-1')])
    vi.mocked(deps.setSelection).mockClear()
    const session = createTestSession(deps)
    session.setTool('select')

    // The double-click's first press toggles the apple in; its second adds the species.
    events.pointerDown({ x: 20, y: 30 }, { button: 0, detail: 1, shiftKey: true })
    events.pointerUp({ x: 20, y: 30 }, { button: 0, detail: 1, shiftKey: true })
    events.pointerDown({ x: 20, y: 30 }, { button: 0, detail: 2, shiftKey: true })
    events.pointerUp({ x: 20, y: 30 }, { button: 0, detail: 2, shiftKey: true })

    expect(currentCanvasSelection.value).toEqual(new Set(['pear-1', 'apple-1', 'apple-2']))

    // A further click on the same plant, with the whole species selected, removes it.
    events.pointerDown({ x: 20, y: 30 }, { button: 0, detail: 3, shiftKey: true })
    events.pointerUp({ x: 20, y: 30 }, { button: 0, detail: 3, shiftKey: true })

    expect(currentCanvasSelection.value).toEqual(new Set(['pear-1']))
    session.dispose()
  })

  it('hides the Rotation Handle outside Select affordance states', () => {
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 80, y: 80 },
        { x: 160, y: 80 },
        { x: 160, y: 140 },
        { x: 80, y: 140 },
      ])]
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 220, y: 100 }, 'Edit me')]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)?.style.display).toBe('inline-flex')

    session.setTool('rectangle')

    expect(rotationHandle(container)).toBeNull()

    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])
    session.refreshMeasurements()
    expect(rotationHandle(container)?.style.display).toBe('inline-flex')

    events.keyDown({ key: 'F2', cancelable: true, target: container })

    expect(container.querySelector('textarea')).not.toBeNull()
    expect(rotationHandle(container)).toBeNull()
    session.dispose()
  })

  it('shows a Rotation Handle for a Zone or a Measurement Guide (canopi-xjym) but not for a lone Placed Plant', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 40 },
        { x: 120, y: 40 },
        { x: 120, y: 100 },
        { x: 20, y: 100 },
      ])]
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 180, y: 90 })]
      draft.measurementGuides = [
        makeMeasurementGuide('measurement-guide-1', { x: 20, y: 140 }, { x: 120, y: 140 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)

    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)).not.toBeNull()
    expect(rotationHandle(container)?.style.display).toBe('inline-flex')

    deps.setSelection([plantTarget('plant-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)).toBeNull()

    deps.setSelection([measurementGuideTarget('measurement-guide-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)).not.toBeNull()

    deps.setSelection([plantTarget('plant-1'), measurementGuideTarget('measurement-guide-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)).not.toBeNull()
    session.dispose()
  })

  it('shows a Rotation Handle for one selected text annotation', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [{
        kind: 'annotation',
        id: 'annotation-1',
        locked: false,
        annotationType: 'text',
        position: { x: 80, y: 90 },
        text: 'Label',
        fontSize: 20,
        rotationDeg: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)

    deps.setSelection([annotationTarget('annotation-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)).not.toBeNull()
    expect(rotationHandle(container)?.style.display).toBe('inline-flex')
    session.dispose()
  })

  it('drags the Rotation Handle to rotate a selected Zone with live readout and one Scene Edit', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    const handle = rotationHandle(container)!
    const start = {
      x: Number.parseFloat(handle.style.left) + 14,
      y: Number.parseFloat(handle.style.top) + 14,
    }

    events.pointerDown(start, { button: 0, target: handle })
    expect(handle.querySelector<HTMLElement>('[data-canvas-handle-readout]')?.textContent).toBe('0°')
    events.pointerMove({ x: 128, y: 110 }, { button: 0 })

    expect(store.persisted.zones[0]?.rotationDeg).toBeCloseTo(90)
    // As today, the handle and its readout hide once the turn changes the scene (tools/select/rotate-handle.test.ts reads '+90°').
    expect(rotationHandle(container)).toBeNull()

    events.pointerUp({ x: 128, y: 110 }, { button: 0 })

    expect(store.persisted.zones[0]?.rotationDeg).toBeCloseTo(90)
    expect(onSceneEditCommit).toHaveBeenCalledTimes(1)
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rotate')
    session.dispose()
  })

  it('aborts an active Rotation Handle drag on pointer cancellation without creating history', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    const handle = rotationHandle(container)!
    const start = rotationHandleCenter(container)

    events.pointerDown(start, { button: 0, pointerId: 11, target: handle })
    events.pointerMove({ x: 128, y: 110 }, { button: 0, pointerId: 11 })
    expect(store.persisted.zones[0]?.rotationDeg).toBeCloseTo(90)

    events.pointerCancel({ x: 128, y: 110 }, { button: 0, pointerId: 11 })
    events.pointerUp({ x: 128, y: 110 }, { button: 0, pointerId: 11 })

    expect(store.persisted.zones[0]?.rotationDeg).toBe(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(rotationHandle(container)?.querySelector<HTMLElement>('[data-canvas-handle-readout]')?.style.display).toBe('none')
    session.dispose()
  })

  it('commits a Rotation Handle drag on pointer-up outside the canvas', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    const handle = rotationHandle(container)!
    const start = {
      x: Number.parseFloat(handle.style.left) + 14,
      y: Number.parseFloat(handle.style.top) + 14,
    }

    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 128, y: 110 }, { button: 0 })
    events.pointerUp({ x: 500, y: 110 }, { button: 0 })

    expect(store.persisted.zones[0]?.rotationDeg).toBeCloseTo(90)
    expect(onSceneEditCommit).toHaveBeenCalledTimes(1)
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rotate')
    session.dispose()
  })

  it('hides the Rotation Handle for locked Design Objects, hidden Layers, and locked Layers', () => {
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)
    deps.setSelection([zoneTarget('zone-1')])

    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ], { locked: true })]
    })
    session.refreshMeasurements()
    expect(rotationHandle(container)).toBeNull()

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, visible: false, locked: false } : layer
      ))
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    session.refreshMeasurements()
    expect(rotationHandle(container)).toBeNull()

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'zones' ? { ...layer, visible: true, locked: true } : layer
      ))
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    session.refreshMeasurements()
    expect(rotationHandle(container)).toBeNull()
    session.dispose()
  })

  it('rotates multi-plant selections around one shared Rotation Pivot without plant orientation', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 60, y: 120 }),
        makePlant('plant-2', 'Pyrus communis', { x: 90, y: 120 }),
      ]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([plantTarget('plant-1'), plantTarget('plant-2')])
    session.refreshMeasurements()
    const selection = getDesignObjectSelectionFromStore(store, testView)
    const pivot = selectionBoundsCenter(selection)
    const start = rotationHandleCenter(container)
    const end = quarterTurnClockwise(pivot, start)

    events.pointerDown(start, {
      button: 0,
      target: rotationHandle(container)!,
    })
    events.pointerMove(end, { button: 0 })
    events.pointerUp(end, { button: 0 })

    expectPointCloseTo(store.persisted.plants[0]?.position, quarterTurnClockwise(pivot, { x: 60, y: 120 }))
    expectPointCloseTo(store.persisted.plants[1]?.position, quarterTurnClockwise(pivot, { x: 90, y: 120 }))
    expect(store.persisted.plants[0]?.rotationDeg).toBeNull()
    expect(store.persisted.plants[1]?.rotationDeg).toBeNull()
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rotate')
    session.dispose()
  })

  it('rotates mixed selections through one Rotation Handle transaction', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 60, y: 120 })]
      draft.zones = [
        makeRectZone('line-1', [
          { x: 90, y: 120 },
          { x: 110, y: 120 },
        ], { zoneType: 'line' }),
        makeRectZone('rect-1', [
          { x: 130, y: 110 },
          { x: 150, y: 110 },
          { x: 150, y: 130 },
          { x: 130, y: 130 },
        ]),
      ]
      draft.annotations = [{
        kind: 'annotation',
        id: 'annotation-1',
        locked: false,
        annotationType: 'text',
        position: { x: 170, y: 120 },
        text: 'A',
        fontSize: 20,
        rotationDeg: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([plantTarget('plant-1'), zoneTarget('line-1'), zoneTarget('rect-1'), annotationTarget('annotation-1')])
    session.refreshMeasurements()
    const selection = getDesignObjectSelectionFromStore(store, testView)
    const pivot = selectionBoundsCenter(selection)
    const start = rotationHandleCenter(container)
    const end = quarterTurnClockwise(pivot, start)

    events.pointerDown(start, {
      button: 0,
      target: rotationHandle(container)!,
    })
    events.pointerMove(end, { button: 0 })
    events.pointerUp(end, { button: 0 })

    const line = store.persisted.zones.find((zone) => zone.id === 'line-1')
    const rect = store.persisted.zones.find((zone) => zone.id === 'rect-1')
    expectPointCloseTo(store.persisted.plants[0]?.position, quarterTurnClockwise(pivot, { x: 60, y: 120 }))
    expectPointCloseTo(line?.points[0], quarterTurnClockwise(pivot, { x: 90, y: 120 }))
    expectPointCloseTo(line?.points[1], quarterTurnClockwise(pivot, { x: 110, y: 120 }))
    expectPointCloseTo(pointsCenter(rect?.points ?? []), quarterTurnClockwise(pivot, { x: 140, y: 120 }))
    expect(rect?.rotationDeg).toBeCloseTo(90)
    expectPointCloseTo(store.persisted.annotations[0]?.position, quarterTurnClockwise(pivot, { x: 170, y: 120 }))
    expect(store.persisted.annotations[0]?.rotationDeg).toBeCloseTo(90)
    expect(onSceneEditCommit).toHaveBeenCalledTimes(1)
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rotate')
    session.dispose()
  })

  it('rotates Object Groups by mutating member geometry instead of group rotation', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 60, y: 120 })]
      draft.zones = [makeRectZone('line-1', [
        { x: 90, y: 120 },
        { x: 110, y: 120 },
      ], { zoneType: 'line' })]
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: 'Group',
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'zone', id: 'line-1' },
        ],
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([groupTarget('group-1')])
    session.refreshMeasurements()
    const selection = getDesignObjectSelectionFromStore(store, testView)
    const pivot = selectionBoundsCenter(selection)
    const start = rotationHandleCenter(container)
    const end = quarterTurnClockwise(pivot, start)

    events.pointerDown(start, {
      button: 0,
      target: rotationHandle(container)!,
    })
    events.pointerMove(end, { button: 0 })
    events.pointerUp(end, { button: 0 })

    const line = store.persisted.zones.find((zone) => zone.id === 'line-1')
    const group = store.persisted.groups[0]
    expectPointCloseTo(store.persisted.plants[0]?.position, quarterTurnClockwise(pivot, { x: 60, y: 120 }))
    expectPointCloseTo(line?.points[0], quarterTurnClockwise(pivot, { x: 90, y: 120 }))
    expectPointCloseTo(line?.points[1], quarterTurnClockwise(pivot, { x: 110, y: 120 }))
    expect(group?.members).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'line-1' },
    ])
    expect(onSceneEditCommit).toHaveBeenCalledTimes(1)
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-rotate')
    session.dispose()
  })

  it('hides the Rotation Handle for Object Groups that contain locked members', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 60, y: 120 }, { locked: true })]
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: 'Group',
        members: [{ kind: 'plant', id: 'plant-1' }],
      }]
    })
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
    })
    const session = createTestSession(deps)

    deps.setSelection([groupTarget('group-1')])
    session.refreshMeasurements()

    expect(rotationHandle(container)).toBeNull()
    session.dispose()
  })

  it('hovering a directly locked object shows the locked hover stroke and no chip; each refused drag raises the lock toast once (2.1-Q177)', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('locked-plant', 'Malus domestica', { x: 20, y: 30 }, { locked: true })]
    })
    const hovered: unknown[] = []
    const deps = createInteractionDeps(container, store, testView, {
      setHoveredTarget: (target) => hovered.push(target),
    })
    const session = createTestSession(deps)
    session.setTool('select')
    const notices: (number | null)[] = []
    const unsubscribe = currentCanvasLockedMoveNotice.subscribe((notice) => notices.push(notice?.id ?? null))
    notices.length = 0

    events.pointerMove({ x: 20, y: 30 })

    // The renderer draws a hovered, directly locked object with the locked-object stroke (scene-runtime/presentation.ts).
    expect(hovered.at(-1)).toEqual(plantTarget('locked-plant'))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.filter((button) => /unlock/i.test(button.getAttribute('aria-label') ?? button.textContent ?? '')))
      .toEqual([])
    expect(currentCanvasSelection.value).toEqual(new Set())
    expect(notices).toEqual([])

    // A click selects it and raises nothing; a drag raises the toast once, however far it goes, and moves nothing.
    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerUp({ x: 20, y: 30 }, { button: 0 })
    expect(notices).toEqual([])
    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerMove({ x: 35, y: 45 }, { button: 0 })
    events.pointerMove({ x: 50, y: 60 }, { button: 0 })
    events.pointerUp({ x: 50, y: 60 }, { button: 0 })
    expect(notices).toHaveLength(1)
    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerMove({ x: 35, y: 45 }, { button: 0 })
    events.pointerUp({ x: 35, y: 45 }, { button: 0 })
    expect(notices).toHaveLength(2)
    expect(notices[1]).not.toBe(notices[0])
    expect(store.persisted.plants[0]!.position).toEqual({ x: 20, y: 30 })
    expect(currentCanvasSelection.value).toEqual(new Set(['locked-plant']))
    unsubscribe()
    session.dispose()
  })

  it('opens the empty-map menu with Place plants here, Paste and Select all at the pointer', () => {
    const pasteAt = vi.fn()
    const selectAll = vi.fn()
    let canPaste = false
    const session = createTestSession(createInteractionDeps(container, store, testView, {
      selectionCommands: createSelectionCommands({ canPaste: () => canPaste, pasteAt, selectAll }),
    }))

    const event = openContextMenu({ x: 320, y: 260 })

    expect(event.defaultPrevented).toBe(true)
    const request = contextMenuHost.current!
    expect(request.selection).toBeNull()
    expect(request.anchor).toEqual({ left: 320, top: 260, right: 320, bottom: 260 })
    expect(request.world).toEqual({ x: 320, y: 260 })
    expect(contextMenuItemIds()).toEqual(['place-plants-here', 'paste', 'select-all'])
    expect(contextMenuCommand('paste').disabled).toBe(true)
    contextMenuCommand('select-all').run()
    expect(selectAll).toHaveBeenCalledOnce()

    canPaste = true
    openContextMenu({ x: 320, y: 260 })
    contextMenuCommand('paste').run()
    expect(pasteAt).toHaveBeenCalledWith({ x: 320, y: 260 })
    session.dispose()
  })

  it('keeps the current selection when right-clicking the empty map', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([plantTarget('plant-1')])
    vi.mocked(deps.setSelection).mockClear()

    openContextMenu({ x: 300, y: 250 })

    expect(contextMenuHost.current?.selection).toBeNull()
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(deps.setSelection).not.toHaveBeenCalled()
    session.dispose()
  })

  it('runs Context Menu edit commands through the scene edit surface', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const commands = createSelectionCommands({ canPaste: vi.fn(() => true) })
    const deps = createInteractionDeps(container, store, testView, { selectionCommands: commands })
    const session = createTestSession(deps)
    session.setTool('select')

    openContextMenu({ x: 20, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([plantTarget('plant-1')])
    expect(contextMenuHost.current?.commands).toBe(commands)
    contextMenuCommand('copy').run()
    expect(commands.copy).toHaveBeenCalledOnce()
    contextMenuCommand('paste').run()
    expect(commands.pasteAt).toHaveBeenCalledWith({ x: 20, y: 30 })
    contextMenuCommand('duplicate').run()
    expect(commands.duplicateSelected).toHaveBeenCalledOnce()
    contextMenuCommand('delete').run()
    expect(commands.deleteSelected).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('offers Save as stamp only with the saved-stamp capability and disables it for structural blockers', () => {
    const saveSelectionAsObjectStamp = vi.fn()
    let selectionModel: CanvasDesignObjectSelectionModel = {
      editableTargets: [{ kind: 'plant' as const, id: 'plant-1' }],
      lockedTargets: [],
      blockedTargets: [],
      bounds: { minX: 20, minY: 20, maxX: 24, maxY: 24 },
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: { plantIds: [], allPinned: false },
    }
    const baseDeps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => selectionModel,
    })
    const withoutStamps = createTestSession(baseDeps)
    openContextMenuFromKeyboard()
    expect(contextMenuItemIds()).not.toContain('save-as-stamp')
    withoutStamps.dispose()

    const session = createTestSession({ ...baseDeps, contextualCommands: { saveSelectionAsObjectStamp } })
    openContextMenuFromKeyboard()
    const save = contextMenuCommand('save-as-stamp')
    expect(save.label).toBe('Save as stamp')
    expect(save.disabled).toBe(false)
    save.run()
    expect(saveSelectionAsObjectStamp).toHaveBeenCalledOnce()

    selectionModel = {
      ...selectionModel,
      blockedTargets: [{
        target: { kind: 'plant' as const, id: 'grouped-plant' },
        reason: 'structural' as const,
      }],
    }
    openContextMenuFromKeyboard()
    expect(contextMenuCommand('save-as-stamp').disabled).toBe(true)
    contextMenuCommand('save-as-stamp').run()
    expect(saveSelectionAsObjectStamp).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('offers Cut, Copy, Delete, Duplicate, stacking and Lock on the unlocked part of a mixed selection, not Group or Rotate, and disables them for a structurally blocked one', () => {
    let selectionModel: CanvasDesignObjectSelectionModel = {
      editableTargets: [{ kind: 'plant' as const, id: 'editable-plant' }, { kind: 'plant' as const, id: 'other-plant' }],
      lockedTargets: [{ kind: 'plant' as const, id: 'locked-plant' }],
      blockedTargets: [{
        target: { kind: 'plant' as const, id: 'locked-plant' },
        reason: 'locked-design-object' as const,
      }],
      bounds: { minX: 20, minY: 20, maxX: 60, maxY: 24 },
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: { plantIds: [], allPinned: false },
    }
    const commands = createSelectionCommands({ canPaste: vi.fn(() => true) })
    const session = createTestSession(createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => selectionModel,
      selectionCommands: commands,
    }))

    // U59 (U55 overturned): the commands run, and the runtime leaves the locked plant (mutations.test.ts).
    for (const id of ['cut', 'copy', 'delete'] as const) {
      openContextMenuFromKeyboard()
      expect(contextMenuCommand(id).disabled, id).toBe(false)
      contextMenuCommand(id).run()
    }
    openContextMenuFromKeyboard()
    for (const id of ['duplicate', 'bring-to-front', 'send-to-back', 'lock'] as const) {
      expect(contextMenuCommand(id).disabled, id).toBe(false)
    }
    // Group and Rotate… stay strict: two editable plants would group and turn, but not with a locked one selected.
    for (const id of ['group', 'rotate'] as const) expect(contextMenuCommand(id).disabled, id).toBe(true)
    expect(contextMenuCommand('paste').disabled).toBe(false)
    expect(contextMenuCommand('unlock').disabled).toBe(false)
    expect(commands.copy).toHaveBeenCalledTimes(2)
    expect(commands.deleteSelected).toHaveBeenCalledTimes(2)

    selectionModel = {
      ...selectionModel,
      lockedTargets: [],
      blockedTargets: [{
        target: { kind: 'plant' as const, id: 'grouped-plant' },
        reason: 'structural' as const,
      }],
    }
    openContextMenuFromKeyboard()
    expect(contextMenuCommand('copy').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    expect(contextMenuCommand('paste').disabled).toBe(false)
    expect(contextMenuCommand('unlock').disabled).toBe(true)
    session.dispose()
  })

  it('disables Context Menu edits when a blocked hit would otherwise preserve another selection', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
      ]
      draft.zones = [
        makeRectZone('locked-zone', [
          { x: 110, y: 20 },
          { x: 130, y: 20 },
          { x: 130, y: 40 },
          { x: 110, y: 40 },
        ]),
      ]
      draft.layers = draft.layers.map((layer) =>
        layer.name === 'zones' ? { ...layer, locked: true } : layer,
      )
    })
    const commands = createSelectionCommands({ canPaste: vi.fn(() => true) })
    const deps = createInteractionDeps(container, store, testView, { selectionCommands: commands })
    const session = createTestSession(deps)

    deps.setSelection([plantTarget('plant-1')])
    vi.mocked(deps.setSelection).mockClear()
    openContextMenu({ x: 110, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(deps.setSelection).not.toHaveBeenCalled()
    expect(contextMenuCommand('copy').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    expect(contextMenuCommand('paste').disabled).toBe(false)
    contextMenuCommand('copy').run()
    contextMenuCommand('delete').run()
    contextMenuCommand('paste').run()
    expect(commands.copy).not.toHaveBeenCalled()
    expect(commands.deleteSelected).not.toHaveBeenCalled()
    expect(commands.pasteAt).toHaveBeenCalledWith({ x: 110, y: 30 })
    session.dispose()
  })

  it('disables Context Menu edits for a topmost blocked hit over an editable target', () => {
    store.updatePersisted((draft) => {
      draft.zones = [
        makeRectZone('editable-zone', [
          { x: 110, y: 20 },
          { x: 130, y: 20 },
          { x: 130, y: 40 },
          { x: 110, y: 40 },
        ]),
      ]
      draft.plants = [
        makePlant('locked-layer-plant', 'Malus domestica', { x: 120, y: 30 }),
      ]
      draft.layers = draft.layers.map((layer) =>
        layer.name === 'plants' ? { ...layer, locked: true } : layer,
      )
    })
    const commands = createSelectionCommands({ canPaste: vi.fn(() => true) })
    const deps = createInteractionDeps(container, store, testView, { selectionCommands: commands })
    const session = createTestSession(deps)

    openContextMenu({ x: 120, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set())
    expect(deps.setSelection).not.toHaveBeenCalled()
    expect(contextMenuHost.current?.selection).not.toBeNull()
    expect(contextMenuCommand('copy').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    contextMenuCommand('paste').run()
    expect(commands.pasteAt).toHaveBeenCalledWith({ x: 120, y: 30 })
    session.dispose()
  })

  it('disables Context Menu edits for a topmost cross-Layer Object Group with a locked member Layer', () => {
    store.updatePersisted((draft) => {
      draft.zones = [
        makeRectZone('editable-zone', [
          { x: 110, y: 20 },
          { x: 130, y: 20 },
          { x: 130, y: 40 },
          { x: 110, y: 40 },
        ]),
        makeRectZone('grouped-zone', [
          { x: 10, y: 120 },
          { x: 30, y: 120 },
          { x: 30, y: 140 },
          { x: 10, y: 140 },
        ]),
      ]
      draft.plants = [makePlant('grouped-plant', 'Malus domestica', { x: 120, y: 30 })]
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: 'Group',
        members: [
          { kind: 'plant', id: 'grouped-plant' },
          { kind: 'zone', id: 'grouped-zone' },
        ],
      }]
      draft.layers = draft.layers.map((layer) =>
        layer.name === 'plants' ? { ...layer, locked: true } : layer,
      )
    })
    const commands = createSelectionCommands({ canPaste: vi.fn(() => true) })
    const deps = createInteractionDeps(container, store, testView, { selectionCommands: commands })
    const session = createTestSession(deps)

    openContextMenu({ x: 120, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set())
    expect(deps.setSelection).not.toHaveBeenCalled()
    expect(contextMenuCommand('copy').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    session.dispose()
  })

  it('updates Context Menu target selection like a design tool', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('plant-2', 'Pyrus communis', { x: 80, y: 30 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    deps.setSelection([plantTarget('plant-1')])
    vi.mocked(deps.setSelection).mockClear()
    openContextMenu({ x: 80, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-2']))
    expect(deps.setSelection).toHaveBeenCalledWith([plantTarget('plant-2')])
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([plantTarget('plant-2')])

    deps.setSelection([plantTarget('plant-1'), plantTarget('plant-2')])
    vi.mocked(deps.setSelection).mockClear()
    openContextMenu({ x: 80, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1', 'plant-2']))
    expect(deps.setSelection).not.toHaveBeenCalled()
    expect(contextMenuHost.current?.selection?.editableTargets).toHaveLength(2)
    session.dispose()
  })

  it('selects directly locked Context Menu targets with mutation commands disabled', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('locked-plant', 'Malus domestica', { x: 20, y: 30 }, { locked: true }),
      ]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')

    openContextMenu({ x: 20, y: 30 })

    expect(currentCanvasSelection.value).toEqual(new Set(['locked-plant']))
    expect(contextMenuCommand('copy').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    expect(contextMenuCommand('unlock').disabled).toBe(false)
    session.dispose()
  })

  it('opens the menu from the Menu key or Shift F10 beside the selection bounds', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 100, y: 100 },
        { x: 160, y: 100 },
        { x: 160, y: 150 },
        { x: 100, y: 150 },
      ])]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    container.tabIndex = -1
    container.focus()

    const menuKey = events.keyDown({ key: 'ContextMenu', cancelable: true, target: container })

    expect(menuKey.defaultPrevented).toBe(true)
    const request = contextMenuHost.current!
    expect(request.selection?.editableTargets).toEqual([zoneTarget('zone-1')])
    expect(request.anchor.left).toBeCloseTo(100)
    expect(request.anchor.top).toBeCloseTo(100)
    expect(request.anchor.right).toBeCloseTo(160)
    expect(request.anchor.bottom).toBeCloseTo(150)
    expect(request.world.x).toBeCloseTo(130)
    expect(request.world.y).toBeCloseTo(125)

    // The key's own trailing contextmenu event does not reopen the menu at a pointer.
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(contextMenuHost.opened).toHaveLength(1)

    // A control keeps the key; with nothing focused the map takes it after a press on the map (the canvas-focus scope,
    // spec §1.6).
    contextMenuHost.reset()
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: button })
    expect(contextMenuHost.current).toBeNull()
    button.remove()
    events.pointerDown({ x: 20, y: 30 })
    events.pointerUp({ x: 20, y: 30 })
    // The press on empty ground cleared the selection; the menu needs one.
    deps.setSelection([zoneTarget('zone-1')])
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: document.body })
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([zoneTarget('zone-1')])

    contextMenuHost.reset()
    container.focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: container })
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([zoneTarget('zone-1')])

    contextMenuHost.current!.returnFocus()
    expect(document.activeElement).toBe(container)
    session.dispose()
  })

  it('selects locked Design Objects for right-click Unlock without allowing drag mutations', () => {
    store.updatePersisted((draft) => {
      draft.plants = [{
        kind: 'plant',
        id: 'locked-plant',
        locked: true,
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        canopySpreadM: 2,
        position: { x: 20, y: 30 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: 1,
      }]
    })

    const onSceneEditCommit = vi.fn()
    const baseDeps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const unlockSelected = vi.fn(() => {
      baseDeps.sceneEdits.run('unlock-selected', (tx) => {
        tx.mutate((draft) => {
          const plant = draft.plants.find((entry) => entry.id === 'locked-plant')
          if (plant) plant.locked = false
        })
      })
    })
    const deps = {
      ...baseDeps,
      selectionCommands: {
        ...baseDeps.selectionCommands,
        unlockSelected,
      },
    }
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerMove({ x: 35, y: 45 }, { button: 0 })
    events.pointerUp({ x: 35, y: 45 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['locked-plant']))
    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })

    openContextMenu({ x: 20, y: 30 })
    expect(contextMenuCommand('duplicate').disabled).toBe(true)
    expect(contextMenuCommand('bring-to-front').disabled).toBe(true)
    expect(contextMenuCommand('send-to-back').disabled).toBe(true)
    expect(contextMenuCommand('delete').disabled).toBe(true)
    expect(contextMenuCommand('lock').disabled).toBe(true)
    const unlock = contextMenuCommand('unlock')
    expect(unlock.disabled).toBe(false)
    expect(unlock.label).toBe('Unlock')

    unlock.run()
    session.refreshMeasurements()

    expect(unlockSelected).toHaveBeenCalledTimes(1)
    expect(onSceneEditCommit).toHaveBeenCalledWith('unlock-selected')
    expect(store.persisted.plants[0]?.locked).toBe(false)
    expect(currentCanvasSelection.value).toEqual(new Set(['locked-plant']))
    openContextMenu({ x: 20, y: 30 })
    expect(contextMenuCommand('unlock').disabled).toBe(true)
    expect(contextMenuCommand('lock').disabled).toBe(false)
    expect(contextMenuCommand('duplicate').disabled).toBe(false)
    session.dispose()
  })

  it('drags only editable objects from a mixed locked and unlocked selection', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('editable-plant', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('locked-plant', 'Malus domestica', { x: 60, y: 30 }, { locked: true }),
      ]
    })

    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerUp({ x: 20, y: 30 }, { button: 0 })
    events.pointerDown({ x: 60, y: 30 }, { button: 0, shiftKey: true })
    events.pointerUp({ x: 60, y: 30 }, { button: 0, shiftKey: true })
    vi.mocked(deps.setSelection).mockClear()

    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerMove({ x: 35, y: 45 }, { button: 0 })
    events.pointerUp({ x: 35, y: 45 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['editable-plant', 'locked-plant']))
    expect(store.persisted.plants.find((plant) => plant.id === 'editable-plant')?.position).toEqual({ x: 35, y: 45 })
    expect(store.persisted.plants.find((plant) => plant.id === 'locked-plant')?.position).toEqual({ x: 60, y: 30 })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')
    expect(deps.setSelection).not.toHaveBeenCalled()
    session.dispose()
  })

  it('canopi-eon8.14.3: a click on a group with a locked member selects the group, and a drag does not move it', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('locked-member', 'Malus domestica', { x: 20, y: 30 }, { locked: true }),
        makePlant('free-member', 'Malus domestica', { x: 60, y: 30 }),
      ]
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: null,
        members: [{ kind: 'plant', id: 'locked-member' }, { kind: 'plant', id: 'free-member' }],
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    session.setTool('select')

    // A click on either member selects the group (2.1-Q161).
    events.pointerDown({ x: 20, y: 30 }, { button: 0 })
    events.pointerUp({ x: 20, y: 30 }, { button: 0 })
    expect(currentCanvasSelection.value).toEqual(new Set(['group-1']))
    deps.setSelection([])
    events.pointerDown({ x: 60, y: 30 }, { button: 0 })
    events.pointerUp({ x: 60, y: 30 }, { button: 0 })
    expect(currentCanvasSelection.value).toEqual(new Set(['group-1']))

    // Its drag moves nothing, commits nothing and keeps the selection.
    const noticeBefore = currentCanvasLockedMoveNotice.value?.id
    events.pointerDown({ x: 60, y: 30 }, { button: 0 })
    events.pointerMove({ x: 80, y: 50 }, { button: 0 })
    events.pointerUp({ x: 80, y: 50 }, { button: 0 })
    expect(store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: 20, y: 30 }, { x: 60, y: 30 }])
    expect(onSceneEditCommit).not.toHaveBeenCalledWith('interaction-drag')
    expect(currentCanvasSelection.value).toEqual(new Set(['group-1']))
    // The refused drag raises the lock toast (2.1-Q177).
    expect(currentCanvasLockedMoveNotice.value?.id).not.toBe(noticeBefore)

    // A band over the group still selects nothing.
    events.pointerDown({ x: 5, y: 5 }, { button: 0 })
    events.pointerMove({ x: 90, y: 60 }, { button: 0 })
    events.pointerUp({ x: 90, y: 60 }, { button: 0 })
    expect(currentCanvasSelection.value).toEqual(new Set())
    session.dispose()
  })

  it('reveals an overview marker, keeps its selected text hittable, and navigates without a Scene edit', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('note', { x: 100, y: 100 }, 'A long overview note')]
    })
    const before = store.persisted
    const onSceneEditCommit = vi.fn()
    const setHoveredTarget = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit, setHoveredTarget })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 96, y: 100 }, { button: 0 })
    events.pointerUp({ x: 96, y: 100 }, { button: 0 })
    expect(store.session.selectedTargets).toEqual([annotationTarget('note')])
    expect(getDesignObjectSelectionFromStore(store, testView).bounds!.maxX).toBeGreaterThan(200)
    events.pointerMove({ x: 150, y: 105 })
    expect(setHoveredTarget).toHaveBeenLastCalledWith(annotationTarget('note'))
    for (const deltaY of [-120, 120, -120, 120]) {
      container.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true }))
    }
    events.keyDown({ key: 'F2', cancelable: true, target: container })
    expect(container.querySelector('textarea')?.value).toBe('A long overview note')
    container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(store.persisted).toEqual(before)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('edits an existing text Annotation in place after double-click and Enter', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Old note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea.value).toBe('Old note')

    textarea.value = 'Updated note'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations[0]).toMatchObject({
      id: 'annotation-1',
      text: 'Updated note',
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-annotation-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('keeps an inline text Annotation edit recoverable while the Scene is busy', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Original note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'Deferred inline note'
    const active = deps.sceneEdits.begin('external-preview')

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations[0]?.text).toBe('Original note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Deferred inline note')

    active.abort()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations[0]?.text).toBe('Deferred inline note')
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-annotation-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('commits an inline text Annotation edit whose blur commit was refused on the next click on the map', async () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Before')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    container.tabIndex = 0
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 2 })
    await nextAnimationFrame()
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(document.activeElement).toBe(textarea)
    textarea.value = 'After'

    // Focus leaves the editor while the scene is busy: its blur commit is refused, and the editor stays without focus.
    const busy = deps.sceneEdits.begin('external-preview')
    textarea.blur()
    await nextAnimationFrame()
    expect(container.querySelector('textarea')).toBe(textarea)
    busy.abort()

    events.pointerDown({ x: 200, y: 200 }, { button: 0 })
    events.pointerUp({ x: 200, y: 200 }, { button: 0 })
    expect(store.persisted.annotations[0]?.text).toBe('After')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('detaches an inline Annotation draft before document replacement', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Old document')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])
    events.keyDown({ key: 'F2', cancelable: true, target: container })
    const oldTextarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    oldTextarea.value = 'Stale draft'

    session.prepareForDocumentReplacement()
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'New document')]
    })
    oldTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(container.querySelector('textarea')).toBeNull()
    expect(store.persisted.annotations[0]?.text).toBe('New document')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
  })

  it('opens existing text Annotation editing from two primary clicks without pointer detail', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Portable note')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 27, y: 35 }, { button: 0, detail: 1 })

    expect(currentCanvasSelection.value).toEqual(new Set(['annotation-1']))
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Portable note')
    session.dispose()
  })

  it('does not open existing text Annotation editing when the second click is additive or too far away', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Portable note')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1, timeStamp: 0 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1, timeStamp: 0 })
    events.pointerDown({ x: 27, y: 35 }, { button: 0, detail: 1, shiftKey: true, timeStamp: 100 })
    expect(container.querySelector('textarea')).toBeNull()

    events.pointerUp({ x: 27, y: 35 }, { button: 0, detail: 1, shiftKey: true })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    expect(container.querySelector('textarea')).toBeNull()
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 60, y: 70 }, { button: 0, detail: 1 })

    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not open existing text Annotation editing after an intervening empty click without pointer detail', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Portable note')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 200, y: 200 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 200, y: 200 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 27, y: 35 }, { button: 0, detail: 1 })

    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('opens selected text Annotation editing from F2 and keeps Shift+Enter inside the editor', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Line one')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])

    events.keyDown({ key: 'F2', cancelable: true, target: container })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea.value).toBe('Line one')

    textarea.value = 'Line one\nLine two'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(container.querySelector('textarea')).toBe(textarea)
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(store.persisted.annotations[0]?.text).toBe('Line one\nLine two')
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-annotation-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('opens selected text Annotation editing from Enter when the canvas has keyboard focus', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Keyboard note')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])

    const event = events.keyDown({ key: 'Enter', cancelable: true, target: container })

    expect(event.defaultPrevented).toBe(true)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keyboard note')
    session.dispose()
  })

  it('does not intercept Annotation edit shortcuts from focused controls outside the canvas', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Keyboard note')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])
    const externalButton = document.createElement('button')
    document.body.appendChild(externalButton)
    externalButton.focus()

    const enterEvent = events.keyDown({ key: 'Enter', cancelable: true, target: externalButton })
    const f2Event = events.keyDown({ key: 'F2', cancelable: true, target: externalButton })

    expect(enterEvent.defaultPrevented).toBe(false)
    expect(f2Event.defaultPrevented).toBe(false)
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
    externalButton.remove()
  })

  it('cancels existing text Annotation edits with Escape without history', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Original note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'Discard me'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(store.persisted.annotations[0]?.text).toBe('Original note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not create history when committing unchanged existing text Annotation text', async () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Stable note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.dispatchEvent(new FocusEvent('blur'))
    await nextAnimationFrame()

    expect(store.persisted.annotations[0]?.text).toBe('Stable note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('commits existing text Annotation edits when clicking away on the canvas', async () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Before click-away')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'After click-away'
    // The entry takes focus on the next frame; the press elsewhere moves focus to the map, and the entry commits on its blur.
    await nextAnimationFrame()
    events.pointerDown({ x: 320, y: 240 }, { button: 0 })

    expect(store.persisted.annotations[0]?.text).toBe('After click-away')
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-annotation-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not commit existing text Annotation edits after the Annotation becomes locked before blur commit', async () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Original note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'Blocked edit'
    store.updatePersisted((draft) => {
      draft.annotations = draft.annotations.map((annotation) => (
        annotation.id === 'annotation-1' ? { ...annotation, locked: true } : annotation
      ))
    })
    textarea.dispatchEvent(new FocusEvent('blur'))
    await nextAnimationFrame()

    expect(store.persisted.annotations[0]?.text).toBe('Original note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not commit existing text Annotation edits after the Annotations Layer becomes locked', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Original note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'Locked layer edit'
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'annotations' ? { ...layer, locked: true } : layer
      ))
    })
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations[0]?.text).toBe('Original note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not commit existing text Annotation edits after the Annotations Layer becomes hidden', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Original note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'Hidden layer edit'
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'annotations' ? { ...layer, visible: false } : layer
      ))
    })
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations[0]?.text).toBe('Original note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('deletes an existing text Annotation when committed text is empty', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Delete me')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])

    events.keyDown({ key: 'F2', cancelable: true, target: container })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '   '
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations).toHaveLength(0)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-annotation-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not delete an existing text Annotation after it becomes locked before empty commit', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Delete me')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([annotationTarget('annotation-1')])

    events.keyDown({ key: 'F2', cancelable: true, target: container })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '   '
    store.updatePersisted((draft) => {
      draft.annotations = draft.annotations.map((annotation) => (
        annotation.id === 'annotation-1' ? { ...annotation, locked: true } : annotation
      ))
    })
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations).toHaveLength(1)
    expect(store.persisted.annotations[0]?.text).toBe('Delete me')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not edit locked, locked-Layer, hidden, or grouped text Annotations', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [
        makeTextAnnotation('locked-annotation', { x: 24, y: 32 }, 'Locked', { locked: true }),
        makeTextAnnotation('layer-blocked-annotation', { x: 80, y: 32 }, 'Layer blocked'),
        makeTextAnnotation('hidden-annotation', { x: 140, y: 32 }, 'Hidden'),
        makeTextAnnotation('grouped-annotation', { x: 200, y: 32 }, 'Grouped'),
      ]
      draft.groups = [{
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: null,
        members: [
          { kind: 'annotation', id: 'grouped-annotation' },
          { kind: 'annotation', id: 'missing-partner' },
        ],
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    deps.setSelection([annotationTarget('locked-annotation')])
    events.keyDown({ key: 'F2', cancelable: true, target: container })
    expect(container.querySelector('textarea')).toBeNull()

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'annotations' ? { ...layer, locked: true } : layer
      ))
    })
    events.pointerDown({ x: 82, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 82, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 82, y: 34 }, { button: 0, detail: 2 })
    expect(container.querySelector('textarea')).toBeNull()

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'annotations' ? { ...layer, locked: false, visible: false } : layer
      ))
    })
    events.pointerDown({ x: 142, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 142, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 142, y: 34 }, { button: 0, detail: 2 })
    expect(container.querySelector('textarea')).toBeNull()

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'annotations' ? { ...layer, visible: true } : layer
      ))
    })
    events.pointerDown({ x: 202, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 202, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 202, y: 34 }, { button: 0, detail: 2 })
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('cleans up existing text Annotation editors on tool change and disposal', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Cleanup note')]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const firstTextarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    firstTextarea.value = 'Discard on tool change'
    session.setTool('rectangle')
    expect(container.querySelector('textarea')).toBeNull()
    expect(store.persisted.annotations[0]?.text).toBe('Cleanup note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    session.setTool('select')
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const secondTextarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    secondTextarea.value = 'Discard on dispose'
    session.dispose()

    expect(container.querySelector('textarea')).toBeNull()
    expect(store.persisted.annotations[0]?.text).toBe('Cleanup note')
    expect(onSceneEditCommit).not.toHaveBeenCalled()
  })

  it('cleans up existing text Annotation editors when the document no longer contains the Annotation', () => {
    store.updatePersisted((draft) => {
      draft.annotations = [makeTextAnnotation('annotation-1', { x: 24, y: 32 }, 'Document note')]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    expect(container.querySelector('textarea')).not.toBeNull()

    store.updatePersisted((draft) => {
      draft.annotations = []
    })
    session.refreshMeasurements()

    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('shows elliptical zone measurements when one top-level ellipse is selected', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'ellipse-1', name: 'ellipse-1',
        zoneType: 'ellipse',
        rotationDeg: 0,
        points: [
          { x: 50, y: 60 },
          { x: 30, y: 20 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 80, y: 60 }, { button: 0 })
    events.pointerUp({ x: 80, y: 60 }, { button: 0 })

    expect(draftLabelTexts(deps)).toEqual([
      'W 60 m',
      'H 40 m',
      '1885 m²',
    ])
    session.dispose()
  })

  it('suppresses elliptical zone measurements for multi-selection', () => {
    store.updatePersisted((draft) => {
      draft.zones = [
        {
          kind: 'zone',
          locked: false,
          id: 'ellipse-1', name: 'ellipse-1',
          zoneType: 'ellipse',
          rotationDeg: 0,
          points: [
            { x: 50, y: 60 },
            { x: 30, y: 20 },
          ],
          fillColor: null,
          notes: null,
        },
        {
          kind: 'zone',
          locked: false,
          id: 'ellipse-2', name: 'ellipse-2',
          zoneType: 'ellipse',
          rotationDeg: 0,
          points: [
            { x: 150, y: 60 },
            { x: 30, y: 20 },
          ],
          fillColor: null,
          notes: null,
        },
      ]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 80, y: 60 }, { button: 0 })
    events.pointerUp({ x: 80, y: 60 }, { button: 0 })
    expect(draftLabelTexts(deps)).not.toEqual([])

    events.pointerDown({ x: 180, y: 60 }, { button: 0, shiftKey: true })
    events.pointerUp({ x: 180, y: 60 }, { button: 0 })

    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  it('selects elliptical zones through ellipse hit testing', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'zone-ellipse', name: null,
        zoneType: 'ellipse',
        rotationDeg: 0,
        points: [
          { x: 50, y: 50 },
          { x: 30, y: 20 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 80, y: 50 }, { button: 0 })
    events.pointerUp({ x: 80, y: 50 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['zone-ellipse']))
    expect(deps.setSelection).toHaveBeenCalledWith([zoneTarget('zone-ellipse')])
    session.dispose()
  })

  it('moves elliptical zones without changing their radii', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'zone-ellipse', name: null,
        zoneType: 'ellipse',
        rotationDeg: 0,
        points: [
          { x: 50, y: 50 },
          { x: 30, y: 20 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 80, y: 50 }, { button: 0 })
    events.pointerMove({ x: 90, y: 65 }, { button: 0 })
    events.pointerUp({ x: 90, y: 65 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['zone-ellipse']))
    expect(store.persisted.zones[0]?.points).toEqual([
      { x: 60, y: 65 },
      { x: 30, y: 20 },
    ])
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')
    session.dispose()
  })

  it('a wheel over a corner, a midpoint dot or the rotate handle zooms the map about the pointer, as over the map (U38)', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: square, fillColor: null, notes: null,
      }]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    events.pointerDown({ x: 70, y: 20 }, { button: 0 })
    events.pointerUp({ x: 70, y: 20 }, { button: 0 })
    const scene = structuredClone(store.persisted)

    let scale = testView.viewport().scale
    for (const id of ['vertex:polygon-1:0', 'edge-mid:polygon-1:0', 'rotate']) {
      const handle = container.querySelector<HTMLElement>(`[data-canvas-handle="${id}"]`)
      expect(handle, id).not.toBeNull()
      const pointer = { x: 70, y: 40 }
      const anchor = testView.view().screenToWorld(pointer)
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: pointer.x, clientY: pointer.y, deltaY: -120 })
      handle!.dispatchEvent(wheel)

      expect(wheel.defaultPrevented, id).toBe(true)
      expect(testView.viewport().scale, id).toBeCloseTo(scale * Math.exp(0.24), 6)
      expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
      scale = testView.viewport().scale
    }
    expect(store.persisted).toEqual(scene)
    session.dispose()
  })

  it('adds a polygon corner from a double-clicked midpoint dot and deletes the last pressed corner, keeping 3', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: square, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 20 }, { button: 0, timeStamp: 0 })
    events.pointerUp({ x: 70, y: 20 }, { button: 0, timeStamp: 0 })

    const dot = container.querySelector<HTMLElement>('[data-canvas-handle="edge-mid:polygon-1:0"]')!
    expect(dot.dataset.canvasHandleGlyph).toBe('midpoint')
    events.pointerDown({ x: 70, y: 20 }, { button: 0, detail: 1, target: dot })
    events.pointerUp({ x: 70, y: 20 }, { button: 0, detail: 1 })
    expect(store.persisted.zones[0]!.points).toHaveLength(4)
    events.pointerDown({ x: 70, y: 20 }, { button: 0, detail: 2, target: dot })
    events.pointerUp({ x: 70, y: 20 }, { button: 0, detail: 2 })
    expect(store.persisted.zones[0]!.points).toEqual([square[0], { x: 70, y: 20 }, square[1], square[2], square[3]])

    const corner = container.querySelector<HTMLElement>('[data-canvas-handle="vertex:polygon-1:1"]')!
    events.pointerDown({ x: 70, y: 20 }, { button: 0, target: corner })
    events.pointerUp({ x: 70, y: 20 }, { button: 0 })
    expect(container.querySelector('[data-canvas-handle-active="true"]')?.getAttribute('data-canvas-handle')).toBe('vertex:polygon-1:1')
    expect(session.keyboard.command({ kind: 'delete-handle' })).toBe(true)
    expect(store.persisted.zones[0]!.points).toEqual(square)
    session.dispose()
  })

  it('Delete on a Tab-focused polygon corner removes that corner, not the last pressed one or the zone; with 3 corners nothing goes', () => {
    const pentagon = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 140, y: 80 }, { x: 70, y: 130 }, { x: 0, y: 80 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: pentagon, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = (index: number) => container.querySelector<HTMLElement>(`[data-canvas-handle="vertex:polygon-1:${index}"]`)!

    // A press on corner 1 focuses it and makes it the selected corner; Tab then moves focus to corner 3.
    events.pointerDown({ x: 120, y: 20 }, { button: 0, target: corner(1) })
    events.pointerUp({ x: 120, y: 20 }, { button: 0 })
    corner(1).focus()
    corner(3).focus()
    events.keyDown({ key: 'Delete', code: 'Delete', target: corner(3) })

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[1], pentagon[2], pentagon[4]])
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')

    corner(0).focus()
    events.keyDown({ key: 'Delete', code: 'Delete', target: corner(0) })
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[1], pentagon[2], pentagon[4]])

    // Three corners left: Delete on a corner removes nothing, the zone included.
    corner(1).focus()
    events.keyDown({ key: 'Delete', code: 'Delete', target: corner(1) })
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[1], pentagon[2], pentagon[4]])
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')
    session.dispose()
  })

  it('a refused corner removal keeps the selected corner and the zone: a second Delete on a triangle deletes nothing', () => {
    const triangle = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 70, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: triangle, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = container.querySelector<HTMLElement>('[data-canvas-handle="vertex:polygon-1:1"]')!
    events.pointerDown({ x: 120, y: 20 }, { button: 0, target: corner })
    events.pointerUp({ x: 120, y: 20 }, { button: 0 })
    corner.blur()
    container.focus()

    for (const key of ['Delete', 'Delete', 'Backspace']) events.keyDown({ key, code: key, target: container })

    expect(store.persisted.zones[0]!.points).toEqual(triangle)
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')
    expect(container.querySelector('[data-canvas-handle-active="true"]')?.getAttribute('data-canvas-handle')).toBe('vertex:polygon-1:1')
    session.dispose()
  })

  it('Delete selects the corner now at the removed index, wrapping and keeping focus, so Delete goes on down to 3; a press elsewhere or Esc clears it (U37)', () => {
    const hexagon = [
      { x: 20, y: 20 }, { x: 120, y: 20 }, { x: 160, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }, { x: 0, y: 80 },
    ]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: hexagon, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = (index: number) => container.querySelector<HTMLElement>(`[data-canvas-handle="vertex:polygon-1:${index}"]`)!
    const active = () => container.querySelector('[data-canvas-handle-active="true"]')?.getAttribute('data-canvas-handle') ?? null

    // The last corner pressed, the map focused: its removal selects the first corner (the index wraps).
    events.pointerDown({ x: 0, y: 80 }, { button: 0, target: corner(5) })
    events.pointerUp({ x: 0, y: 80 }, { button: 0 })
    container.focus()
    events.keyDown({ key: 'Delete', code: 'Delete', target: container })
    expect(store.persisted.zones[0]!.points).toEqual(hexagon.slice(0, 5))
    expect(active()).toBe('vertex:polygon-1:0')
    // The next Delete removes that corner, and the one after it is selected.
    events.keyDown({ key: 'Delete', code: 'Delete', target: container })
    expect(store.persisted.zones[0]!.points).toEqual(hexagon.slice(1, 5))
    expect(active()).toBe('vertex:polygon-1:0')

    // A focused last corner: focus wraps to the first corner with the selection, and Delete goes on from there.
    corner(3).focus()
    events.keyDown({ key: 'Delete', code: 'Delete', target: corner(3) })
    expect(store.persisted.zones[0]!.points).toEqual(hexagon.slice(1, 4))
    expect(active()).toBe('vertex:polygon-1:0')
    expect(document.activeElement).toBe(corner(0))
    // Refused at 3: the shape, the selected corner and the focus stay; nothing else is deleted.
    events.keyDown({ key: 'Delete', code: 'Delete', target: document.activeElement! })
    expect(store.persisted.zones[0]!.points).toEqual(hexagon.slice(1, 4))
    expect(active()).toBe('vertex:polygon-1:0')
    expect(document.activeElement).toBe(corner(0))
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')

    // A press on the zone's outline keeps it selected and clears the corner.
    events.pointerDown({ x: 122, y: 80 }, { button: 0 })
    events.pointerUp({ x: 122, y: 80 }, { button: 0 })
    expect(session.keyboard.command({ kind: 'delete-handle' })).toBe(false)
    expect(active()).toBeNull()
    expect(store.persisted.zones[0]!.points).toEqual(hexagon.slice(1, 4))

    // Esc clears a selected corner with the selection.
    events.pointerDown({ x: 120, y: 20 }, { button: 0, target: corner(0) })
    events.pointerUp({ x: 120, y: 20 }, { button: 0 })
    expect(active()).toBe('vertex:polygon-1:0')
    container.focus()
    events.keyDown({ key: 'Escape', code: 'Escape', target: container })
    expect(active()).toBeNull()
    session.dispose()
  })

  it("Backspace, the Mac's delete key, removes a focused or selected polygon corner, not the zone; with no corner it deletes the selection", () => {
    const pentagon = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 140, y: 80 }, { x: 70, y: 130 }, { x: 0, y: 80 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: pentagon, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = (index: number) => container.querySelector<HTMLElement>(`[data-canvas-handle="vertex:polygon-1:${index}"]`)!

    // Tab-focused corner 3.
    corner(3).focus()
    events.keyDown({ key: 'Backspace', code: 'Backspace', target: corner(3) })
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[1], pentagon[2], pentagon[4]])

    // A press on corner 1 selects it; focus then returns to the map.
    events.pointerDown({ x: 120, y: 20 }, { button: 0, target: corner(1) })
    events.pointerUp({ x: 120, y: 20 }, { button: 0 })
    corner(1).blur()
    events.keyDown({ key: 'Backspace', code: 'Backspace' })
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[2], pentagon[4]])
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')

    // A press on the zone's outline clears the corner selected after the removal (U37); with no corner focused or
    // selected the selection goes, as before.
    events.pointerDown({ x: 50, y: 78 }, { button: 0 })
    events.pointerUp({ x: 50, y: 78 }, { button: 0 })
    events.keyDown({ key: 'Backspace', code: 'Backspace' })
    expect(keyCommands).toHaveBeenCalledWith('canvas.deleteSelected')
    session.dispose()
  })

  it('a right-click on a polygon corner, or Shift+F10 on a focused one, opens the point menu: Delete point alone, one undo step; on a triangle it is refused; a dot gets the zone\'s menu (A16)', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: square, fillColor: null, notes: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 20 }, { button: 0 })
    events.pointerUp({ x: 70, y: 20 }, { button: 0 })
    const handle = (id: string) => container.querySelector<HTMLElement>(`[data-canvas-handle="${id}"]`)!
    vi.mocked(deps.setSelection).mockClear()

    events.pointerDown({ x: 120, y: 20 }, { button: 2, target: handle('vertex:polygon-1:1') })
    events.pointerUp({ x: 120, y: 20 }, { button: 2 })
    expect(contextMenuItemIds()).toEqual(['delete-point'])
    expect(contextMenuHost.current?.selection).toBeNull()
    expect(deps.setSelection).not.toHaveBeenCalled()
    contextMenuCommand('delete-point').run()
    expect(store.persisted.zones[0]!.points).toEqual([square[0], square[2], square[3]])
    expect(onSceneEditCommit.mock.calls).toEqual([['interaction-zone-corner']])

    // Three corners left: Delete point is shown, disabled, and removes nothing.
    handle('vertex:polygon-1:0').focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: handle('vertex:polygon-1:0') })
    expect(contextMenuItemIds()).toEqual(['delete-point'])
    expect(contextMenuCommand('delete-point').disabled).toBe(true)
    contextMenuCommand('delete-point').run()
    expect(store.persisted.zones[0]!.points).toHaveLength(3)
    expect(onSceneEditCommit).toHaveBeenCalledOnce()

    // A midpoint dot is no point: the zone's own menu.
    events.pointerDown({ x: 70, y: 70 }, { button: 2, target: handle('edge-mid:polygon-1:0') })
    events.pointerUp({ x: 70, y: 70 }, { button: 2 })
    expect(contextMenuItemIds()).toContain('delete')
    expect(contextMenuItemIds()).not.toContain('delete-point')
    session.dispose()
  })

  it('a point menu opened with Shift+F10 on a focused corner gives focus back to that corner, so Delete then removes the corner, never the zone (A16, U37)', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: square, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = (index: number) => container.querySelector<HTMLElement>(`[data-canvas-handle="vertex:polygon-1:${index}"]`)!

    // Esc (the menu's restoring close): focus is back on corner 1, and Delete removes it.
    corner(1).focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: corner(1) })
    expect(contextMenuItemIds()).toEqual(['delete-point'])
    contextMenuHost.current!.returnFocus()
    expect(document.activeElement).toBe(corner(1))
    events.keyDown({ key: 'Delete', code: 'Delete', target: corner(1) })
    expect(store.persisted.zones[0]!.points).toEqual([square[0], square[2], square[3]])
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')

    // A triangle: after Esc, Delete on the corner is refused and the zone stays.
    expect(document.activeElement).toBe(corner(1))
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: corner(1) })
    contextMenuHost.current!.returnFocus()
    expect(document.activeElement).toBe(corner(1))
    events.keyDown({ key: 'Delete', code: 'Delete', target: corner(1) })
    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]!.points).toHaveLength(3)
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')
    session.dispose()
  })

  it('Delete point chosen from a keyboard point menu leaves focus on the corner now at its place, as the Delete key does (A16, U37)', () => {
    const pentagon = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 140, y: 80 }, { x: 70, y: 130 }, { x: 0, y: 80 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: pentagon, fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = (index: number) => container.querySelector<HTMLElement>(`[data-canvas-handle="vertex:polygon-1:${index}"]`)!

    // The app's menu closes with focus restored, then runs the command (ActionMenu.activate).
    const choose = () => {
      const request = contextMenuHost.current!
      request.returnFocus()
      contextMenuCommand('delete-point').run()
    }
    corner(1).focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: corner(1) })
    choose()
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[2], pentagon[3], pentagon[4]])
    expect(document.activeElement).toBe(corner(1))

    // The last corner: focus wraps to the first, as the Delete key's does.
    corner(3).focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: corner(3) })
    choose()
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[2], pentagon[3]])
    expect(document.activeElement).toBe(corner(0))
    session.dispose()
  })

  // The canvas menu's keys are its entries' shortcuts on what it names (Delete on the selection's menu deletes the
  // selection); on a point menu, which names a point, Delete and Backspace are Delete point, never the zone's deletion.
  // Through the app's own menu, which holds focus as it does in the workspace.
  it('Delete or Backspace in a point menu deletes its corner, never the zone; on a triangle the menu stays and nothing goes (A16)', () => {
    const pentagon = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 140, y: 80 }, { x: 70, y: 130 }, { x: 0, y: 80 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: pentagon, fillColor: null, notes: null,
      }]
    })
    const menu = appContextMenu()
    const deps = createInteractionDeps(container, store, testView, { contextMenu: menu.adapter })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const corner = (index: number) => container.querySelector<HTMLElement>(`[data-canvas-handle="vertex:polygon-1:${index}"]`)!
    const pressInMenu = (key: string) => events.keyDown({ key, code: key, cancelable: true, target: document.activeElement! })
    const openOnCorner = (index: number) => {
      corner(index).focus()
      events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: corner(index) })
      const deletePoint = menu.item('delete-point')
      expect(document.activeElement, 'the point menu takes focus').toBe(deletePoint)
    }

    openOnCorner(1)
    pressInMenu('Delete')
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[2], pentagon[3], pentagon[4]])
    expect(menu.isOpen(), 'Delete closes the point menu').toBe(false)
    expect(document.activeElement, 'focus is on the corner now at its place, as Delete point leaves it').toBe(corner(1))

    openOnCorner(1)
    pressInMenu('Backspace')
    expect(store.persisted.zones[0]!.points).toEqual([pentagon[0], pentagon[3], pentagon[4]])
    expect(menu.isOpen(), 'Backspace closes the point menu').toBe(false)

    // A triangle: Delete point is refused, so the key removes nothing and the menu stays, as its disabled entry does.
    openOnCorner(1)
    for (const key of ['Delete', 'Backspace']) {
      pressInMenu(key)
      expect(store.persisted.zones).toHaveLength(1)
      expect(store.persisted.zones[0]!.points).toHaveLength(3)
      expect(menu.isOpen(), `${key} on a refused point keeps the menu`).toBe(true)
    }
    expect(keyCommands).not.toHaveBeenCalledWith('canvas.deleteSelected')
    session.dispose()
  })

  // A point menu names its point by index; once the corners, the selection or the tool change, that index may be
  // another corner's, so the menu closes and an entry chosen from it anyway removes nothing.
  it('an open point menu closes when the Scene, the selection or the tool changes, and its stale Delete point removes nothing (A16)', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    const inserted = { x: 70, y: 0 }
    const zone = (id: string, points: readonly ScenePoint[]) => ({
      kind: 'zone' as const, locked: false, id, name: id, zoneType: 'polygon' as const, rotationDeg: 0,
      points: [...points], fillColor: null, notes: null,
    })
    store.updatePersisted((draft) => {
      draft.zones = [zone('polygon-1', square), zone('polygon-2', square.map((point) => ({ x: point.x + 200, y: point.y })))]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const handle = (id: string) => container.querySelector<HTMLElement>(`[data-canvas-handle="${id}"]`)!
    const rightClick = (at: ScenePoint, id: string) => {
      events.pointerDown(at, { button: 2, target: handle(id) })
      events.pointerUp(at, { button: 2 })
    }
    /** What the runtime does on any Scene edit, undo and redo included: the Scene changes, then the session refreshes. */
    const setCorners = (points: readonly ScenePoint[]) => {
      store.updatePersisted((draft) => { draft.zones[0] = zone('polygon-1', points) })
      session.refreshMeasurements()
    }

    // An edit inserted a corner before the second one, then the point menu opens on that corner, now corner 2.
    setCorners([square[0]!, inserted, ...square.slice(1)])
    rightClick({ x: 120, y: 20 }, 'vertex:polygon-1:2')
    expect(contextMenuItemIds()).toEqual(['delete-point'])
    const afterUndo = contextMenuCommand('delete-point')
    // Undo takes the inserted corner back: corner 2 is now the third corner of the square.
    setCorners(square)
    expect(contextMenuHost.current, 'a Scene change closes the point menu').toBeNull()
    afterUndo.run()
    expect(store.persisted.zones[0]!.points, 'a stale Delete point removes nothing').toEqual(square)

    rightClick({ x: 120, y: 20 }, 'vertex:polygon-1:1')
    const afterSelection = contextMenuCommand('delete-point')
    deps.setSelection([zoneTarget('polygon-2')])
    session.refreshMeasurements()
    expect(contextMenuHost.current, 'a selection change closes the point menu').toBeNull()
    afterSelection.run()
    expect(store.persisted.zones.map((entry) => entry.points)).toEqual([square, square.map((point) => ({ x: point.x + 200, y: point.y }))])

    deps.setSelection([zoneTarget('polygon-1')])
    session.refreshMeasurements()
    rightClick({ x: 120, y: 20 }, 'vertex:polygon-1:1')
    const afterTool = contextMenuCommand('delete-point')
    // The app's menu holds focus, as a tool letter pressed in it finds it.
    const menuItem = document.body.appendChild(document.createElement('button'))
    menuItem.focus()
    session.setTool('plant-spacing')
    expect(contextMenuHost.current, 'a tool change closes the point menu').toBeNull()
    expect(document.activeElement, 'focus goes back to the map, as the menu\'s Esc gives it').toBe(container)
    afterTool.run()
    expect(store.persisted.zones[0]!.points).toEqual(square)
    menuItem.remove()
    session.dispose()
  })

  it('a selection command chosen from a menu opened on a line\'s end gives focus to the map once the command removes that end', async () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('line-1', [{ x: 20, y: 20 }, { x: 120, y: 20 }], { zoneType: 'line' })]
    })
    let session: ReturnType<typeof createTestSession> | null = null
    const commands = createSelectionCommands({
      deleteSelected: vi.fn(() => {
        store.updatePersisted((draft) => { draft.zones = [] })
        session!.refreshMeasurements()
      }),
    })
    const deps = createInteractionDeps(container, store, testView, { selectionCommands: commands })
    session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 20 }, { button: 0 })
    events.pointerUp({ x: 70, y: 20 }, { button: 0 })
    const end = container.querySelector<HTMLElement>('[data-canvas-handle="vertex:line-1:0"]')!

    // A line's end has no point menu: Shift+F10 opens the selection's, with the end as its opener.
    end.focus()
    events.keyDown({ key: 'F10', shiftKey: true, cancelable: true, target: end })
    expect(contextMenuItemIds()).toContain('delete')
    // The app's menu closes with focus restored, then runs the command (ActionMenu.activate).
    contextMenuHost.current!.returnFocus()
    expect(document.activeElement).toBe(end)
    contextMenuCommand('delete').run()
    await Promise.resolve()

    expect(store.persisted.zones).toHaveLength(0)
    expect(end.isConnected).toBe(false)
    expect(document.activeElement).toBe(container)
    session.dispose()
  })

  it('dragging a polygon\'s midpoint dot inserts a corner where it is released, in one undo step; a still press or Esc inserts nothing (A2)', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: square, fillColor: null, notes: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 70 }, { button: 0, timeStamp: 0 })
    events.pointerUp({ x: 70, y: 70 }, { button: 0, timeStamp: 0 })
    const dot = () => container.querySelector<HTMLElement>('[data-canvas-handle="edge-mid:polygon-1:0"]')!

    // A still press on the dot inserts nothing.
    events.pointerDown({ x: 70, y: 20 }, { button: 0, buttons: 1, target: dot(), timeStamp: 1000 })
    events.pointerUp({ x: 70, y: 20 }, { button: 0, timeStamp: 1010 })
    expect(store.persisted.zones[0]!.points).toEqual(square)

    // Esc mid-drag rolls the inserted corner back.
    events.pointerDown({ x: 70, y: 20 }, { button: 0, buttons: 1, target: dot(), timeStamp: 3000 })
    events.pointerMove({ x: 70, y: 0 }, { button: -1, buttons: 1, timeStamp: 3010 })
    expect(store.persisted.zones[0]!.points).toHaveLength(5)
    events.keyDown({ key: 'Escape', code: 'Escape' })
    events.pointerUp({ x: 70, y: 0 }, { button: 0, timeStamp: 3020 })
    expect(store.persisted.zones[0]!.points).toEqual(square)
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    events.pointerDown({ x: 70, y: 20 }, { button: 0, buttons: 1, target: dot(), timeStamp: 5000 })
    events.pointerMove({ x: 70, y: 10 }, { button: -1, buttons: 1, timeStamp: 5010 })
    events.pointerMove({ x: 75, y: 0 }, { button: -1, buttons: 1, timeStamp: 5020 })
    // The corner follows the pointer; nothing is committed before the release.
    expect(store.persisted.zones[0]!.points).toEqual([square[0], { x: 75, y: 0 }, square[1], square[2], square[3]])
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    events.pointerUp({ x: 80, y: 0 }, { button: 0, timeStamp: 5030 })
    expect(store.persisted.zones[0]!.points).toEqual([square[0], { x: 80, y: 0 }, square[1], square[2], square[3]])
    expect(onSceneEditCommit.mock.calls).toEqual([['interaction-zone-corner']])
    session.dispose()
  })

  it('arrow keys do nothing while a polygon corner or midpoint dot holds focus (U36)', () => {
    const square = [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }, { x: 20, y: 120 }]
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: square, fillColor: null, notes: null,
      }]
    })
    const nudge = { nudgeSelected: vi.fn(() => true), endNudge: vi.fn() }
    const deps = createInteractionDeps(container, store, testView, { nudge })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 70, y: 22 }, { button: 0 })
    events.pointerUp({ x: 70, y: 22 }, { button: 0 })
    const before = testView.viewport()

    for (const handle of ['vertex:polygon-1:1', 'edge-mid:polygon-1:0']) {
      const element = container.querySelector<HTMLElement>(`[data-canvas-handle="${handle}"]`)!
      element.focus()
      for (const key of ['ArrowRight', 'ArrowDown']) {
        events.keyDown({ key, code: key, target: element })
        events.keyDown({ key, code: key, ctrlKey: true, target: element })
      }
    }

    expect(nudge.nudgeSelected).not.toHaveBeenCalled()
    expect(testView.viewport()).toEqual(before)
    // From the map the arrow nudges as before.
    container.focus()
    events.keyDown({ key: 'ArrowRight', code: 'ArrowRight', target: container })
    expect(nudge.nudgeSelected).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('leaves the short edges of a selected polygon without midpoint dots until a zoom makes room, and draws dots under the corners', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: [{ x: 20, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 100 }, { x: 20, y: 100 }], fillColor: null, notes: null,
      }]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 50, y: 60 }, { button: 0 })
    events.pointerUp({ x: 50, y: 60 }, { button: 0 })
    const dots = () => [...container.querySelectorAll<HTMLElement>('[data-canvas-handle-glyph="midpoint"]')]
      .map((dot) => dot.dataset.canvasHandle).sort()
    expect(dots()).toEqual(['edge-mid:polygon-1:1', 'edge-mid:polygon-1:3'])

    testView.setViewport({ x: 0, y: 0, scale: 2 })
    expect(dots()).toEqual(['edge-mid:polygon-1:0', 'edge-mid:polygon-1:1', 'edge-mid:polygon-1:2', 'edge-mid:polygon-1:3'])
    const corner = container.querySelector<HTMLElement>('[data-canvas-handle="vertex:polygon-1:0"]')!
    const dot = container.querySelector<HTMLElement>('[data-canvas-handle="edge-mid:polygon-1:0"]')!
    expect(Number(dot.style.zIndex)).toBeLessThan(Number(corner.style.zIndex))
    session.dispose()
  })

  it('shows selected polygonal zone edge measurements and area', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'polygon-1', name: 'polygon-1',
        zoneType: 'polygon',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 60, y: 10 },
          { x: 60, y: 50 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 40, y: 10 }, { button: 0 })
    events.pointerUp({ x: 40, y: 10 }, { button: 0 })

    expect(draftLabelTexts(deps)).toEqual([
      '50 m',
      '40 m',
      '64 m',
      '1000 m²',
    ])
    session.dispose()
  })

  it('suppresses polygonal zone measurements for multi-selection', () => {
    store.updatePersisted((draft) => {
      draft.zones = [
        {
          kind: 'zone',
          locked: false,
          id: 'polygon-1', name: 'polygon-1',
          zoneType: 'polygon',
          rotationDeg: 0,
          points: [
            { x: 10, y: 10 },
            { x: 60, y: 10 },
            { x: 60, y: 50 },
          ],
          fillColor: null,
          notes: null,
        },
        {
          kind: 'zone',
          locked: false,
          id: 'polygon-2', name: 'polygon-2',
          zoneType: 'polygon',
          rotationDeg: 0,
          points: [
            { x: 100, y: 10 },
            { x: 150, y: 10 },
            { x: 150, y: 50 },
          ],
          fillColor: null,
          notes: null,
        },
      ]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 40, y: 10 }, { button: 0 })
    events.pointerUp({ x: 40, y: 10 }, { button: 0 })
    expect(draftLabelTexts(deps)).not.toEqual([])

    events.pointerDown({ x: 130, y: 10 }, { button: 0, shiftKey: true })
    events.pointerUp({ x: 130, y: 10 }, { button: 0 })

    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  it('does not select polygonal zones from empty bounding-box space', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'polygon-1', name: 'polygon-1',
        zoneType: 'polygon',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 60, y: 10 },
          { x: 60, y: 50 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 15, y: 45 }, { button: 0 })
    events.pointerUp({ x: 15, y: 45 }, { button: 0 })

    expect(currentCanvasSelection.value.size).toBe(0)
    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  it('shows selected linear zone length from stroke-proximity hit testing', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'line-1', name: 'line-1',
        zoneType: 'line',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 50, y: 13 }, { button: 0 })
    events.pointerUp({ x: 50, y: 13 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['line-1']))
    expect(draftLabelTexts(deps)).toEqual(['100 m'])
    session.dispose()
  })

  it('does not select linear zones from empty bounding-box space', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'line-1', name: 'line-1',
        zoneType: 'line',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 60 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 60, y: 60 }, { button: 0 })
    events.pointerUp({ x: 60, y: 60 }, { button: 0 })

    expect(currentCanvasSelection.value.size).toBe(0)
    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  it('band-selects linear zones when the selection rectangle crosses the segment', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'line-1', name: 'line-1',
        zoneType: 'line',
        rotationDeg: 0,
        points: [
          { x: 10, y: 50 },
          { x: 110, y: 50 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 40, y: 40 }, { button: 0 })
    events.pointerMove({ x: 80, y: 60 }, { button: 0 })
    events.pointerUp({ x: 80, y: 60 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['line-1']))
    session.dispose()
  })

  it('quarantines band-selection completion while another Scene Edit owns authority', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 20 }),
        makePlant('plant-2', 'Pyrus communis', { x: 120, y: 120 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([plantTarget('plant-2')])

    events.pointerDown({ x: 0, y: 0 }, { button: 0, pointerId: 101 })
    events.pointerMove({ x: 50, y: 50 }, { button: 0, pointerId: 101 })
    expect(store.session.selectedTargets).toEqual([])
    const unrelated = deps.sceneEdits.begin('external-preview')
    unrelated.mutate((draft) => {
      draft.plants[1]!.position = { x: 130, y: 130 }
    })

    const blockedPointerUp = events.pointerUp(
      { x: 50, y: 50 },
      { button: 0, pointerId: 101 },
    )

    expect(blockedPointerUp.defaultPrevented).toBe(true)
    expect(store.session.selectedTargets).toEqual([])
    unrelated.abort()

    events.pointerDown({ x: 0, y: 0 }, { button: 0, pointerId: 102 })
    events.pointerMove({ x: 50, y: 50 }, { button: 0, pointerId: 102 })
    events.pointerUp({ x: 50, y: 50 }, { button: 0, pointerId: 102 })

    expect(store.session.selectedTargets).toEqual([plantTarget('plant-1')])
    session.dispose()
  })

  it('shows rectangle zone measurements when one top-level zone is selected', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'zone-1', name: null,
        zoneType: 'rect',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
          { x: 110, y: 90 },
          { x: 10, y: 90 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerUp({ x: 10, y: 20 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['zone-1']))
    expect(draftLabelTexts(deps)).toEqual([
      '100 m',
      '80 m',
      '100 m',
      '80 m',
      '8000 m²',
    ])
    session.dispose()
  })

  it('suppresses rectangle zone measurements for multi-selection', () => {
    store.updatePersisted((draft) => {
      draft.zones = [
        {
          kind: 'zone',
          locked: false,
          id: 'zone-1', name: null,
          zoneType: 'rect',
          rotationDeg: 0,
          points: [
            { x: 10, y: 10 },
            { x: 110, y: 10 },
            { x: 110, y: 90 },
            { x: 10, y: 90 },
          ],
          fillColor: null,
          notes: null,
        },
        {
          kind: 'zone',
          locked: false,
          id: 'zone-2', name: null,
          zoneType: 'rect',
          rotationDeg: 0,
          points: [
            { x: 150, y: 10 },
            { x: 250, y: 10 },
            { x: 250, y: 90 },
            { x: 150, y: 90 },
          ],
          fillColor: null,
          notes: null,
        },
      ]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerUp({ x: 10, y: 20 }, { button: 0 })
    expect(draftLabelTexts(deps)).not.toEqual([])

    events.pointerDown({ x: 150, y: 20 }, { button: 0, shiftKey: true })
    events.pointerUp({ x: 150, y: 20 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['zone-1', 'zone-2']))
    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  it('suppresses rectangle zone measurements for group selection', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'zone-1', name: null,
        zoneType: 'rect',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
          { x: 110, y: 90 },
          { x: 10, y: 90 },
        ],
        fillColor: null,
        notes: null,
      }]
      draft.groups = [{
        kind: 'group',
        locked: false,
        id: 'group-1',
        name: null,
        members: [{ kind: 'zone', id: 'zone-1' }],
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerUp({ x: 10, y: 20 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['group-1']))
    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  it('hides short rectangle edge measurements while keeping the area visible', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'zone-1', name: null,
        zoneType: 'rect',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
          { x: 30, y: 110 },
          { x: 10, y: 110 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 20 }, { button: 0 })
    events.pointerUp({ x: 10, y: 20 }, { button: 0 })

    expect(draftLabelTexts(deps)).toEqual([
      '100 m',
      '100 m',
      '2000 m²',
    ])
    session.dispose()
  })

  it('suppresses selected rectangle zone measurements when the zones layer is hidden', () => {
    store.updatePersisted((draft) => {
      const zonesLayer = draft.layers.find((layer) => layer.name === 'zones')
      if (zonesLayer) zonesLayer.visible = false
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'zone-1', name: null,
        zoneType: 'rect',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
          { x: 110, y: 90 },
          { x: 10, y: 90 },
        ],
        fillColor: null,
        notes: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    deps.setSelection([zoneTarget('zone-1')])
    const session = createTestSession(deps)

    session.refreshMeasurements()

    expect(draftLabelTexts(deps)).toEqual([])
    session.dispose()
  })

  // The guard of canopi-c7k8, restored for canopi-qd2k: the user's decision (2026-10-14) is that a zone is picked by its
  // outline only. Rewriting this test needs the user's word, cited in the commit.
  it('(canopi-qd2k) selects a Zone by its outline only: a click inside picks what lies beneath or clears, and a drag inside bands without moving it', () => {
    const corners = [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 90 },
      { x: 10, y: 90 },
    ]
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', corners)]
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 80, y: 60 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 50 }, { button: 0 })
    events.pointerUp({ x: 10, y: 50 }, { button: 0 })
    expect(currentCanvasSelection.value).toEqual(new Set(['zone-1']))

    // Inside, away from the outline: empty ground clears the selection.
    events.pointerDown({ x: 40, y: 50 }, { button: 0 })
    events.pointerUp({ x: 40, y: 50 }, { button: 0 })
    expect(currentCanvasSelection.value).toEqual(new Set())

    // Inside, on a plant: the plant alone.
    events.pointerDown({ x: 80, y: 60 }, { button: 0 })
    events.pointerUp({ x: 80, y: 60 }, { button: 0 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    // A drag from inside the zone bands: the press clears, the band selects only what it holds, never the zone.
    events.pointerDown({ x: 30, y: 30 }, { button: 0 })
    events.pointerMove({ x: 95, y: 75 }, { buttons: 1 })
    events.pointerUp({ x: 95, y: 75 }, { button: 0 })
    expect(store.persisted.zones[0]!.points).toEqual(corners)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    session.dispose()
  })

  it('prioritizes Placed Plants over Zone boundary hits', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 10, y: 10 },
        { x: 110, y: 10 },
        { x: 110, y: 90 },
        { x: 10, y: 90 },
      ])]
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 10, y: 50 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 50 }, { button: 0 })
    events.pointerUp({ x: 10, y: 50 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    session.dispose()
  })

  it('reshapes Linear Zones by dragging endpoint Zone Control Points with live measurements', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'line-1', name: 'line-1',
        zoneType: 'line',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 60, y: 10 },
        ],
        fillColor: null,
        notes: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 30, y: 10 }, { button: 0 })
    events.pointerUp({ x: 30, y: 10 }, { button: 0 })

    const handle = zoneControlPoint(container, 'line-endpoint', 1)!
    const start = zoneControlPointCenter(container, 'line-endpoint', 1)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 80, y: 10 }, { button: 0 })

    expect(store.persisted.zones[0]?.points[1]).toEqual({ x: 80, y: 10 })
    expect(draftLabelTexts(deps)).toEqual(['70 m'])

    events.pointerUp({ x: 80, y: 10 }, { button: 0 })

    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-zone-control-point')
    session.dispose()
  })

  it('does not reshape Linear Zones or commit edits from no-op Zone Control Point taps', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'line-1', name: 'line-1',
        zoneType: 'line',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 60, y: 10 },
        ],
        fillColor: null,
        notes: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 30, y: 10 }, { button: 0 })
    events.pointerUp({ x: 30, y: 10 }, { button: 0 })

    const handle = zoneControlPoint(container, 'line-endpoint', 1)!
    const start = zoneControlPointCenter(container, 'line-endpoint', 1)
    const hitTargetOffset = { x: start.x + 5, y: start.y }
    events.pointerDown(hitTargetOffset, { button: 0, target: handle })
    events.pointerUp(hitTargetOffset, { button: 0, target: handle })

    expect(store.persisted.zones[0]?.points).toEqual([
      { x: 10, y: 10 },
      { x: 60, y: 10 },
    ])
    expect(draftLabelTexts(deps)).toEqual(['50 m'])
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('drags Measurement Guide endpoints with live distance labels', () => {
    store.updatePersisted((draft) => {
      draft.plants = []
      draft.zones = []
      draft.annotations = []
      draft.measurementGuides = [
        makeMeasurementGuide('measurement-guide-1', { x: 10, y: 10 }, { x: 60, y: 10 }),
      ]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 30, y: 10 }, { button: 0 })
    events.pointerUp({ x: 30, y: 10 }, { button: 0 })

    const handle = measurementGuideControlPoint(container, 1)!
    const start = measurementGuideControlPointCenter(container, 1)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 80, y: 10 }, { button: 0 })

    expect(store.persisted.measurementGuides[0]?.end).toEqual({ x: 80, y: 10 })
    expect(draftLabelTexts(deps)).toEqual(['70 m'])

    events.pointerUp({ x: 80, y: 10 }, { button: 0 })

    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-measurement-guide-control-point')
    session.dispose()
  })

  it('aborts Measurement Guide endpoint drags on Escape and skips no-op commits', () => {
    store.updatePersisted((draft) => {
      draft.plants = []
      draft.zones = []
      draft.annotations = []
      draft.measurementGuides = [
        makeMeasurementGuide('measurement-guide-1', { x: 10, y: 10 }, { x: 60, y: 10 }),
      ]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 30, y: 10 }, { button: 0 })
    events.pointerUp({ x: 30, y: 10 }, { button: 0 })

    let handle = measurementGuideControlPoint(container, 1)!
    let start = measurementGuideControlPointCenter(container, 1)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 80, y: 10 }, { button: 0 })
    events.keyDown({ key: 'Escape' })

    expect(store.persisted.measurementGuides[0]).toMatchObject({
      start: { x: 10, y: 10 },
      end: { x: 60, y: 10 },
    })
    expect(draftLabelTexts(deps)).toEqual([])

    handle = measurementGuideControlPoint(container, 1)!
    start = measurementGuideControlPointCenter(container, 1)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerUp(start, { button: 0, target: handle })

    expect(store.persisted.measurementGuides[0]).toMatchObject({
      start: { x: 10, y: 10 },
      end: { x: 60, y: 10 },
    })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('reshapes Polygonal Zones by dragging existing vertex Zone Control Points', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'poly-1', name: 'poly-1',
        zoneType: 'polygon',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 60, y: 10 },
          { x: 10, y: 60 },
        ],
        fillColor: null,
        notes: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 30 }, { button: 0 })
    events.pointerUp({ x: 10, y: 30 }, { button: 0 })

    const handle = zoneControlPoint(container, 'polygon-vertex', 1)!
    const start = zoneControlPointCenter(container, 'polygon-vertex', 1)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 80, y: 10 }, { button: 0 })

    expect(store.persisted.zones[0]?.points[1]).toEqual({ x: 80, y: 10 })
    expect(draftLabelTexts(deps)).toContain('1750 m²')

    events.pointerUp({ x: 80, y: 10 }, { button: 0 })

    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-zone-control-point')
    session.dispose()
  })

  it('resizes Rectangular Zones from corner Zone Control Points while preserving rectangle geometry', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('rect-1', [
        { x: 10, y: 10 },
        { x: 60, y: 10 },
        { x: 60, y: 50 },
        { x: 10, y: 50 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 10, y: 30 }, { button: 0 })
    events.pointerUp({ x: 10, y: 30 }, { button: 0 })

    const handle = zoneControlPoint(container, 'rect-corner', 2)!
    const start = zoneControlPointCenter(container, 'rect-corner', 2)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 90, y: 70 }, { button: 0 })

    expect(store.persisted.zones[0]?.points).toEqual([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 70 },
      { x: 10, y: 70 },
    ])
    expect(draftLabelTexts(deps)).toContain('4800 m²')

    events.pointerUp({ x: 90, y: 70 }, { button: 0 })

    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-zone-control-point')
    session.dispose()
  })

  it('resizes Elliptical Zones from cardinal Zone Control Points with live measurements', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'ellipse-1', name: 'ellipse-1',
        zoneType: 'ellipse',
        rotationDeg: 0,
        points: [
          { x: 50, y: 50 },
          { x: 20, y: 10 },
        ],
        fillColor: null,
        notes: null,
      }]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 70, y: 50 }, { button: 0 })
    events.pointerUp({ x: 70, y: 50 }, { button: 0 })

    const handle = zoneControlPoint(container, 'ellipse-east', 0)!
    const start = zoneControlPointCenter(container, 'ellipse-east', 0)
    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 90, y: 50 }, { button: 0 })

    expect(store.persisted.zones[0]?.points).toEqual([
      { x: 60, y: 50 },
      { x: 30, y: 10 },
    ])
    expect(draftLabelTexts(deps)).toEqual(['W 60 m', 'H 20 m', '942 m²'])

    events.pointerUp({ x: 90, y: 50 }, { button: 0 })

    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-zone-control-point')
    session.dispose()
  })

  it('snaps dragged plant to grid when snap is enabled', () => {
    // At scale=4, gridInterval() returns 5m (first NICE_DISTANCE where d*4 >= 20)
    testView.setViewport({ x: 0, y: 0, scale: 4 })
    snapToGridEnabled.value = true
    store.updatePersisted((draft) => {
      draft.plants = [
        {
          kind: 'plant',
          locked: false,
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          canopySpreadM: 2,
          position: { x: 50, y: 50 },
          rotationDeg: null,
          notes: null,
          plantedDate: null,
          quantity: 1,
        },
        makePlant('plant-2', 'Pyrus communis', { x: 70, y: 60 }),
      ]
    })

    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')

    // Plant at (50,50). Screen = world * scale = (200,200).
    // Click screen (201,202) → world (50.25, 50.5). snapRef = plant at (50,50).
    // Drag screen (232,248) → world (58,62). rawDelta = (7.75, 11.5).
    // candidate = (50+7.75, 50+11.5) = (57.75, 61.5) → snaps to (60,60).
    // delta = (60-50, 60-50) = (10,10). Final = (60,60).
    events.pointerDown({ x: 201, y: 202 }, { button: 0 })
    events.pointerMove({ x: 232, y: 248 }, { button: 0 })
    expect(draftLabelTexts(deps)).toEqual(['10 m'])
    events.pointerUp({ x: 232, y: 248 }, { button: 0 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 60, y: 60 })
    expect(draftLabelTexts(deps)).toEqual([])
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drag')
    session.dispose()
  })

  it('places Saved Object Stamps from drag-and-drop payloads with full geometry ghost preview', () => {
    testView.setViewport({ x: 0, y: 0, scale: 2 })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    let protectedDragData = true
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        if (protectedDragData) return ''
        return dragData.get(type) ?? ''
      },
    }
    writeSavedObjectStampDragData(dataTransfer, {
      id: 'stamp-1',
      name: 'Guild',
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: '#C44230',
          symbol: 'canopy',
          position: { x: -4, y: 0 },
          rotationDeg: null,
        }],
        zones: [{
          id: 'zone-1',
          name: 'Kitchen bed',
          zoneType: 'rect',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }],
          rotationDeg: 30,
          fillColor: '#CBA24A',
        }],
        annotations: [{
          id: 'annotation-1',
          annotationType: 'text',
          position: { x: 2, y: -5 },
          text: 'Guild',
          fontSize: 11,
          rotationDeg: 45,
        }],
        groups: [],
      }),
    })

    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragOverEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dropEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })

    container.dispatchEvent(dragOverEvent)
    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
    // The ghosts are the host's drop preview (spec §1.4 "Drops"): the bed and the apple in one 'objects' ghost, the note
    // in a second, each where the drop would put it, in full geometry; the draft layer draws them (a note as its marker
    // or its text, by scale: renderers/draft-layer.test.ts "an objects ghost's note draws as its marker at an overview
    // scale and as its turned text closer in").
    const ghosts = () => draftShapes(deps).flatMap((shape) =>
      shape.kind === 'ghost' && shape.entity.kind === 'objects' ? [shape.entity] : [])
    expect(ghosts()).toHaveLength(2)
    const [objects, notes] = ghosts()
    expect(objects!.template.zones.map(({ entity }) => entity)).toEqual([expect.objectContaining({
      zoneType: 'rect',
      points: [{ x: 40, y: 45 }, { x: 50, y: 45 }, { x: 50, y: 51 }, { x: 40, y: 51 }],
      rotationDeg: 30,
      fillColor: '#CBA24A',
    })])
    expect(objects!.template.plants.map(({ entity }) => entity)).toEqual([expect.objectContaining({
      symbol: 'canopy',
      color: '#C44230',
      position: { x: 36, y: 45 },
    })])
    expect(notes!.template.annotations.map(({ entity }) => entity)).toEqual([expect.objectContaining({
      text: 'Guild',
      fontSize: 11,
      rotationDeg: 45,
      position: { x: 42, y: 40 },
    })])
    const overviewViewport = testView.viewport()
    testView.setViewport({ ...overviewViewport, scale: 20 })
    container.dispatchEvent(dragOverEvent)
    // Closer in, the ghosts follow the ground under the pointer: the bed's corner is the stamp's anchor.
    const [closerObjects, closerNotes] = ghosts()
    expect(closerObjects!.template.zones[0]!.entity.points[0]).toEqual({ x: 4, y: 4.5 })
    expect(closerNotes!.template.annotations[0]!.entity.position).toEqual({ x: 6, y: -0.5 })

    testView.setViewport(overviewViewport)
    container.dispatchEvent(dragOverEvent)

    protectedDragData = false
    container.dispatchEvent(dropEvent)
    expect(dropEvent.defaultPrevented).toBe(true)

    expect(store.persisted.plants).toHaveLength(1)
    expect(store.persisted.plants[0]).toMatchObject({
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#C44230',
      symbol: 'canopy',
      position: { x: 36, y: 45 },
      locked: false,
    })
    expect(store.persisted.zones[0]).toMatchObject({
      name: 'Kitchen bed',
      rotationDeg: 30,
      fillColor: '#CBA24A',
    })
    expect(store.persisted.annotations[0]).toMatchObject({
      text: 'Guild',
      fontSize: 11,
      rotationDeg: 45,
      position: { x: 42, y: 40 },
    })
    expect(currentCanvasSelection.value).toEqual(new Set([
      store.persisted.plants[0]!.id,
      store.persisted.zones[0]!.id,
      store.persisted.annotations[0]!.id,
    ]))
    expect(deps.renderer.lastDraft()).toBeNull()
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-saved-object-stamp')
    session.dispose()
  })

  it('preserves Saved Object Stamp drag state while another Scene edit owns admission', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    let protectedDragData = true
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'copy',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        if (protectedDragData) return ''
        return dragData.get(type) ?? ''
      },
    }
    writeSavedObjectStampDragData(dataTransfer, {
      id: 'stamp-1',
      name: 'Apple',
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          symbol: null,
          position: { x: 0, y: 0 },
          rotationDeg: null,
        }],
        zones: [],
        annotations: [],
        groups: [],
      }),
    })
    const dragEvent = (type: 'dragover' | 'drop') => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperties(event, {
        clientX: { configurable: true, value: 80 },
        clientY: { configurable: true, value: 90 },
        dataTransfer: { configurable: true, value: dataTransfer },
      })
      return event
    }
    const active = deps.sceneEdits.begin('external-preview')

    container.dispatchEvent(dragEvent('dragover'))
    expect(dataTransfer.dropEffect).toBe('none')
    expect(deps.renderer.lastDraft()).toBeNull()

    protectedDragData = false
    container.dispatchEvent(dragEvent('drop'))
    expect(store.persisted.plants).toHaveLength(0)

    active.abort()
    protectedDragData = true
    container.dispatchEvent(dragEvent('dragover'))
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(draftShapes(deps).map((shape) => shape.kind)).toEqual(['ghost'])

    protectedDragData = false
    container.dispatchEvent(dragEvent('drop'))
    expect(store.persisted.plants).toHaveLength(1)
    session.dispose()
  })

  it('blocks Saved Object Stamp drops when any target Layer is locked', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) =>
        layer.name === 'zones' ? { ...layer, locked: true } : layer,
      )
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'copy',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        return dragData.get(type) ?? ''
      },
    }
    writeSavedObjectStampDragData(dataTransfer, {
      id: 'stamp-1',
      name: 'Bed',
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [],
        zones: [{
          id: 'zone-1',
          name: 'Kitchen bed',
          zoneType: 'rect',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
          rotationDeg: 0,
          fillColor: null,
        }],
        annotations: [],
        groups: [],
      }),
    })
    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragOverEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dropEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })

    container.dispatchEvent(dragOverEvent)
    expect(dataTransfer.dropEffect).toBe('none')
    expect(deps.renderer.lastDraft()).toBeNull()

    container.dispatchEvent(dropEvent)

    expect(store.persisted.zones).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('creates plant placements from drag-and-drop payloads through protected dragover data', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    let protectedDragData = true
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        if (protectedDragData) return ''
        return dragData.get(type) ?? ''
      },
    }
    writePlantStampDragData(dataTransfer, {
      canonical_name: 'Pyrus communis',
      common_name: 'Pear',
      stratum: 'mid',
      width_max_m: 3,
    })

    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragOverEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: {
        configurable: true,
        value: dataTransfer,
      },
    })
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dropEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: {
        configurable: true,
        value: dataTransfer,
      },
    })
    container.dispatchEvent(dragOverEvent)
    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
    // The drop cue is the host's draft: today's band box at the pointer (spec §1.4 "Drops").
    expect(draftShapes(deps).map((shape) => shape.kind)).toEqual(['quad'])

    protectedDragData = false
    container.dispatchEvent(dropEvent)
    expect(dropEvent.defaultPrevented).toBe(true)

    expect(store.persisted.plants).toHaveLength(1)
    expect(store.persisted.plants[0]).toMatchObject({
      canonicalName: 'Pyrus communis',
      commonName: 'Pear',
      position: { x: 80, y: 90 },
      canopySpreadM: 3,
    })
    expect(deps.renderer.lastDraft()).toBeNull()
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-drop')
    session.dispose()
  })

  it('previews dragover without invoking recovery-capable command admission', () => {
    const commandAdmission: SceneCommandAdmission = {
      revision: signal(0),
      runWhenSettled: vi.fn(() => {
        throw new Error('dragover must not resume pending maintenance')
      }),
    }
    const readWhenSettled = vi.fn()
    const settledReader: SettledSceneReader = {
      revision: signal(0),
      readWhenSettled<T>(operation: () => T): T {
        readWhenSettled()
        return operation()
      },
    }
    const deps = {
      ...createInteractionDeps(container, store, testView, { commandAdmission }),
      settledReader,
    } as SceneInteractionSessionDeps
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        return dragData.get(type) ?? ''
      },
    }
    writePlantStampDragData(dataTransfer, {
      canonical_name: 'Pyrus communis',
      common_name: 'Pear',
      stratum: 'mid',
      width_max_m: 3,
    })
    const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(event, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })

    const errors = captureWindowErrors(() => {
      container.dispatchEvent(event)
    })

    expect(errors).toEqual([])
    expect(commandAdmission.runWhenSettled).not.toHaveBeenCalled()
    expect(readWhenSettled).toHaveBeenCalledOnce()
    expect(dataTransfer.dropEffect).toBe('copy')
    session.dispose()
  })

  it('does not show plant drop feedback for protected ordinary text drags', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    const dataTransfer = {
      dropEffect: 'copy',
      types: ['text/plain'],
      getData() {
        return ''
      },
    }
    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragOverEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: {
        configurable: true,
        value: dataTransfer,
      },
    })
    container.dispatchEvent(dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('none')
    expect(deps.renderer.lastDraft()).toBeNull()
    session.dispose()
  })

  it('does not create plant placements from drag-and-drop payloads on a locked Plants Layer', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'plants' ? { ...layer, locked: true } : layer
      ))
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        return dragData.get(type) ?? ''
      },
    }
    writePlantStampDragData(dataTransfer, {
      canonical_name: 'Pyrus communis',
      common_name: 'Pear',
      stratum: 'mid',
      width_max_m: 3,
    })

    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragOverEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: {
        configurable: true,
        value: dataTransfer,
      },
    })
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dropEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: {
        configurable: true,
        value: dataTransfer,
      },
    })
    container.dispatchEvent(dragOverEvent)
    container.dispatchEvent(dropEvent)

    expect(store.persisted.plants).toHaveLength(0)
    expect(deps.renderer.lastDraft()).toBeNull()
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('selects the typed Annotation before an overlapping Zone with the same raw id', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone',
        locked: false,
        id: 'shared', name: 'shared',
        zoneType: 'rect',
        rotationDeg: 0,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
          { x: 110, y: 80 },
          { x: 10, y: 80 },
        ],
        fillColor: null,
        notes: null,
      }]
      draft.annotations = [{
        kind: 'annotation',
        locked: false,
        id: 'shared',
        annotationType: 'text',
        position: { x: 20, y: 20 },
        text: 'Top note',
        fontSize: 16,
        rotationDeg: null,
      }]
    })

    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 24, y: 24 }, { button: 0 })
    events.pointerUp({ x: 24, y: 24 }, { button: 0 })

    expect(currentCanvasSelection.value).toEqual(new Set(['shared']))
    expect(deps.setSelection).toHaveBeenCalledWith([annotationTarget('shared')])
    session.dispose()
  })

  it('clears selection through the runtime seam when clicking empty canvas', () => {
    currentCanvasSelection.value = new Set(['plant-1'])
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 380, y: 280 }, { button: 0 })
    events.pointerUp({ x: 380, y: 280 }, { button: 0 })

    expect(currentCanvasSelection.value.size).toBe(0)
    // The ToolHost's history-free selection (ToolHostDeps.setSelection); the runtime's clearSelection is the same write.
    expect(deps.setSelection).toHaveBeenCalledTimes(1)
    expect(deps.setSelection).toHaveBeenCalledWith([])
    session.dispose()
  })

  it('temporarily pans with the space key while select is active', () => {
    const render = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { render })
    const session = createTestSession(deps)
    session.setTool('select')

    events.holdSpace()
    events.pointerDown({ x: 100, y: 100 })
    events.pointerMove({ x: 130, y: 120 })
    events.pointerUp({ x: 130, y: 120 })
    events.releaseSpace()

    expect(testView.viewport().x).toBeCloseTo(30, 6)
    expect(testView.viewport().y).toBeCloseTo(20, 6)
    expect(render, 'its camera frame repaints the layer, not the session').not.toHaveBeenCalled()
    session.dispose()
  })

  it('uses the pointer-down bounds for the full captured gesture', () => {
    events.setBounds({ left: 10, top: 20, width: 400, height: 300 })
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 12 })
    events.setBounds({ left: 30, top: 40, width: 400, height: 300 })
    events.pointerMoveClient({ x: 55, y: 75 }, { pointerId: 12 })
    events.pointerUpClient({ x: 55, y: 75 }, { pointerId: 12 })

    expect(store.persisted.plants[0]?.position).toEqual({ x: 45, y: 55 })
    session.dispose()
  })

  it('finishes independent transient cleanup when one presentation callback fails', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    let failHoveredWrite = false
    const setHoveredTarget = vi.fn(() => {
      if (failHoveredWrite) throw new Error('hover cleanup failed')
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      onSceneEditCommit,
      setHoveredTarget,
    })
    const session = createTestSession(deps)
    session.setTool('select')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 15 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 15 })
    events.holdSpace()
    failHoveredWrite = true
    expect(() => session.setTool('rectangle')).toThrow('hover cleanup failed')
    failHoveredWrite = false

    expect(store.persisted.plants[0]?.position).toEqual({ x: 20, y: 30 })
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.style.cursor).toBe('default')
    session.dispose()
  })

  it('rolls back earlier resources when a collaborator fails during Session construction', () => {
    const deps = createInteractionDeps(container, store, testView)
    const originalAppendChild = container.appendChild.bind(container)
    let earlierResources = 0
    const appendChild = vi.spyOn(container, 'appendChild').mockImplementation(
      (<T extends Node>(node: T): T => {
        // The handle layer comes after the map host's key description and the bridge's drop preview.
        if (node instanceof HTMLElement && node.dataset.canvasHandleLayer === 'true') {
          earlierResources = container.children.length
          throw new Error('handle layer construction failed')
        }
        return originalAppendChild(node) as T
      }) as typeof container.appendChild,
    )

    try {
      expect(() => createSceneInteractionSession(deps)).toThrow('handle layer construction failed')
    } finally {
      appendChild.mockRestore()
    }

    expect(earlierResources).toBeGreaterThan(0)
    expect(container.children).toHaveLength(0)
  })

  it('removes an eager collaborator root when its initialization throws after append', () => {
    let handleLayerAppended = false
    const originalAppendChild = container.appendChild.bind(container)
    const appendChild = vi.spyOn(container, 'appendChild').mockImplementation(
      (<T extends Node>(node: T): T => {
        const appended = originalAppendChild(node) as T
        if (node instanceof HTMLElement && node.dataset.canvasHandleLayer === 'true') handleLayerAppended = true
        return appended
      }) as typeof container.appendChild,
    )
    // The handle layer appends its root, then follows the camera's overlay frames.
    const frames = testView.frames
    const deps = {
      ...createInteractionDeps(container, store, testView),
      frames: {
        viewFrame: frames.viewFrame,
        settledViewFrame: frames.settledViewFrame,
        onViewFrame: (phase, listener) => {
          if (handleLayerAppended && phase === 'overlays') throw new Error('handle layer initialization failed')
          return frames.onViewFrame(phase, listener)
        },
      } satisfies ViewFrameSource,
    }

    try {
      expect(() => createSceneInteractionSession(deps)).toThrow('handle layer initialization failed')
    } finally {
      appendChild.mockRestore()
    }

    expect(handleLayerAppended).toBe(true)
    expect(container.children).toHaveLength(0)
  })

  it('refreshes presentation after pointer-up cancellation reports an error', () => {
    const getDesignObjectSelection = vi.fn(() => getDesignObjectSelectionFromStore(store, testView))
    let failHoveredWrite = false
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection,
      setHoveredTarget: () => {
        if (failHoveredWrite) throw new Error('pointer-up cleanup failed')
      },
    })
    const session = createTestSession(deps)
    session.setTool('select')
    events.pointerDown({ x: 300, y: 200 }, { pointerId: 21 })
    const readsBeforePointerUp = getDesignObjectSelection.mock.calls.length

    failHoveredWrite = true
    const errors = captureWindowErrors(() => {
      events.pointerUp({ x: 300, y: 200 }, { pointerId: 21 })
    })
    failHoveredWrite = false

    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual(expect.objectContaining({ message: 'pointer-up cleanup failed' }))
    expect(getDesignObjectSelection.mock.calls.length).toBeGreaterThan(readsBeforePointerUp)
    session.dispose()
  })

  it.each(['Zone', 'Measurement Guide'] as const)(
    'restores selection presentation when %s Control Point cancellation rendering fails',
    (kind) => {
      if (kind === 'Zone') {
        store.updatePersisted((draft) => {
          draft.zones = [makeRectZone('zone-1', [
            { x: 10, y: 10 },
            { x: 60, y: 10 },
            { x: 60, y: 50 },
            { x: 10, y: 50 },
          ])]
        })
      } else {
        store.updatePersisted((draft) => {
          draft.measurementGuides = [
            makeMeasurementGuide('measurement-guide-1', { x: 10, y: 10 }, { x: 60, y: 10 }),
          ]
        })
      }
      let failRender = false
      const deps = createInteractionDeps(container, store, testView, {
        render: () => {
          if (failRender) throw new Error(`${kind} cancellation render failed`)
        },
      })
      deps.setSelection([
        kind === 'Zone' ? zoneTarget('zone-1') : measurementGuideTarget('measurement-guide-1'),
      ])
      const session = createTestSession(deps)
      session.setTool('select')
      session.refreshMeasurements()
      const handle = kind === 'Zone'
        ? zoneControlPoint(container, 'rect-corner', 0)!
        : measurementGuideControlPoint(container, 1)!
      const start = kind === 'Zone'
        ? zoneControlPointCenter(container, 'rect-corner', 0)
        : measurementGuideControlPointCenter(container, 1)
      expect(rotationHandle(container)).not.toBeNull()

      events.pointerDown(start, { pointerId: 22, target: handle })
      events.pointerMove({ x: 90, y: 70 }, { pointerId: 22 })
      expect(rotationHandle(container)).toBeNull()

      failRender = true
      const errors = captureWindowErrors(() => {
        events.pointerCancel({ x: 90, y: 70 }, { pointerId: 22 })
      })
      failRender = false

      expect(errors).toHaveLength(1)
      expect(errors[0]).toEqual(expect.objectContaining({ message: `${kind} cancellation render failed` }))
      expect(rotationHandle(container)).not.toBeNull()
      session.dispose()
    },
  )

  it.each(['Rotation Handle', 'Zone Control Point', 'Measurement Guide Control Point'] as const)(
    'rolls back live geometry when %s transaction commit fails',
    (kind) => {
      const targetId = kind === 'Measurement Guide Control Point' ? 'measurement-guide-1' : 'zone-1'
      if (kind === 'Measurement Guide Control Point') {
        store.updatePersisted((draft) => {
          draft.measurementGuides = [
            makeMeasurementGuide(targetId, { x: 20, y: 80 }, { x: 120, y: 80 }),
          ]
        })
      } else {
        store.updatePersisted((draft) => {
          draft.zones = [makeRectZone(targetId, [
            { x: 20, y: 80 },
            { x: 120, y: 80 },
            { x: 120, y: 140 },
            { x: 20, y: 140 },
          ])]
        })
      }
      const onSceneEditCommit = vi.fn(() => {
        throw new Error(`${kind} commit failed`)
      })
      const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
      deps.setSelection([
        kind === 'Measurement Guide Control Point'
          ? measurementGuideTarget(targetId)
          : zoneTarget(targetId),
      ])
      const session = createTestSession(deps)
      session.setTool('select')
      session.refreshMeasurements()
      const persistedBefore = store.persisted
      expect(rotationHandle(container)).not.toBeNull()

      let handle: HTMLElement
      let start: ScenePoint
      let end: ScenePoint
      if (kind === 'Rotation Handle') {
        handle = rotationHandle(container)!
        start = rotationHandleCenter(container)
        end = { x: 128, y: 110 }
      } else if (kind === 'Zone Control Point') {
        handle = zoneControlPoint(container, 'rect-corner', 2)!
        start = zoneControlPointCenter(container, 'rect-corner', 2)
        end = { x: 150, y: 170 }
      } else {
        handle = measurementGuideControlPoint(container, 1)!
        start = measurementGuideControlPointCenter(container, 1)
        end = { x: 150, y: 110 }
      }

      events.pointerDown(start, { pointerId: 23, target: handle })
      events.pointerMove(end, { pointerId: 23 })
      expect(store.persisted).not.toEqual(persistedBefore)

      const errors = captureWindowErrors(() => {
        events.pointerUp(end, { pointerId: 23 })
      })

      expect(errors).toHaveLength(1)
      expect(errors[0]).toEqual(expect.objectContaining({ message: `${kind} commit failed` }))
      expect(onSceneEditCommit).toHaveBeenCalledTimes(1)
      expect(store.persisted).toEqual(persistedBefore)
      expect(rotationHandle(container)).not.toBeNull()
      // No handle is left marked as dragged, and the rotation handle has its resting cursor again.
      expect(container.querySelector('[data-canvas-handle-active]')).toBeNull()
      if (kind === 'Rotation Handle') expect(rotationHandle(container)?.style.cursor).toBe('grab')
      session.dispose()
    },
  )

  it.each(['Rotation Handle', 'Zone Control Point', 'Measurement Guide Control Point'] as const)(
    'rolls the %s transaction back at once when its first abort fails',
    (kind) => {
      const designObjectId = kind === 'Measurement Guide Control Point' ? 'measurement-guide-1' : 'zone-1'
      if (kind !== 'Measurement Guide Control Point') {
        store.updatePersisted((draft) => {
          draft.zones = [makeRectZone(designObjectId, [
            { x: 20, y: 80 },
            { x: 120, y: 80 },
            { x: 120, y: 140 },
            { x: 20, y: 140 },
          ])]
        })
      } else {
        store.updatePersisted((draft) => {
          draft.measurementGuides = [
            makeMeasurementGuide(designObjectId, { x: 20, y: 80 }, { x: 120, y: 80 }),
          ]
        })
      }
      const baseDeps = createInteractionDeps(container, store, testView)
      const editType = kind === 'Rotation Handle'
        ? 'interaction-rotate'
        : kind === 'Zone Control Point'
          ? 'interaction-zone-control-point'
          : 'interaction-measurement-guide-control-point'
      const abortFailure = createAbortFailingSceneEdits(
        baseDeps.sceneEdits,
        editType,
        `${kind} abort failed`,
      )
      const deps: SceneInteractionSessionDeps = { ...baseDeps, sceneEdits: abortFailure.sceneEdits }
      deps.setSelection([
        kind === 'Measurement Guide Control Point'
          ? measurementGuideTarget(designObjectId)
          : zoneTarget(designObjectId),
      ])
      const session = createTestSession(deps)
      session.setTool('select')
      session.refreshMeasurements()
      const persistedBefore = store.persisted
      const handle = kind === 'Rotation Handle'
        ? rotationHandle(container)!
        : kind === 'Zone Control Point'
          ? zoneControlPoint(container, 'rect-corner', 2)!
          : measurementGuideControlPoint(container, 1)!
      const start = kind === 'Rotation Handle'
        ? rotationHandleCenter(container)
        : kind === 'Zone Control Point'
          ? zoneControlPointCenter(container, 'rect-corner', 2)
          : measurementGuideControlPointCenter(container, 1)
      const end = kind === 'Rotation Handle' ? { x: 128, y: 110 } : { x: 150, y: 170 }

      events.pointerDown(start, { pointerId: 24, target: handle })
      events.pointerMove(end, { pointerId: 24 })
      expect(store.persisted).not.toEqual(persistedBefore)

      const errors = captureWindowErrors(() => {
        events.pointerCancel(end, { pointerId: 24 })
      })

      expect(errors).toHaveLength(1)
      expect(errors[0]).toEqual(expect.objectContaining({ message: `${kind} abort failed` }))
      // The fault rule's abort inside the same cancellation has already rolled the edit back: nothing is left open.
      expect(abortFailure.abortCalls()).toBe(2)
      expect(abortFailure.beginCalls()).toBe(1)
      expect(abortFailure.beginTypes()).toEqual([editType])
      expect(store.persisted).toEqual(persistedBefore)
      // The handles are back at once, none marked as dragged.
      expect(container.querySelector('[data-canvas-handle]')).not.toBeNull()
      expect(container.querySelector('[data-canvas-handle-active]')).toBeNull()

      // A fresh drag on the restored handle is an ordinary press.
      const freshHandle = kind === 'Rotation Handle'
        ? rotationHandle(container)!
        : kind === 'Zone Control Point'
          ? zoneControlPoint(container, 'rect-corner', 2)!
          : measurementGuideControlPoint(container, 1)!
      events.pointerDown(start, { pointerId: 25, target: freshHandle })
      expect(abortFailure.beginTypes()).toEqual([editType, editType])
      events.pointerMove(end, { pointerId: 25 })
      events.pointerUp(end, { pointerId: 25 })
      expect(store.persisted).not.toEqual(persistedBefore)
      session.dispose()
      expect(abortFailure.abortCalls()).toBe(2)
    },
  )

  it.each(['Rotation Handle', 'Zone Control Point', 'Measurement Guide Control Point'] as const)(
    'removes owned %s resources when abort keeps failing during disposal',
    (kind) => {
      const designObjectId = kind === 'Measurement Guide Control Point' ? 'measurement-guide-1' : 'zone-1'
      if (kind === 'Measurement Guide Control Point') {
        store.updatePersisted((draft) => {
          draft.measurementGuides = [
            makeMeasurementGuide(designObjectId, { x: 20, y: 80 }, { x: 120, y: 80 }),
          ]
        })
      } else {
        store.updatePersisted((draft) => {
          draft.zones = [makeRectZone(designObjectId, [
            { x: 20, y: 80 },
            { x: 120, y: 80 },
            { x: 120, y: 140 },
            { x: 20, y: 140 },
          ])]
        })
      }
      const editType = kind === 'Rotation Handle'
        ? 'interaction-rotate'
        : kind === 'Zone Control Point'
          ? 'interaction-zone-control-point'
          : 'interaction-measurement-guide-control-point'
      const baseDeps = createInteractionDeps(container, store, testView)
      const abortFailure = createAbortFailingSceneEdits(
        baseDeps.sceneEdits,
        editType,
        `${kind} abort failed`,
        'always',
      )
      const session = createTestSession({ ...baseDeps, sceneEdits: abortFailure.sceneEdits })
      baseDeps.setSelection([
        kind === 'Measurement Guide Control Point'
          ? measurementGuideTarget(designObjectId)
          : zoneTarget(designObjectId),
      ])
      session.setTool('select')
      session.refreshMeasurements()
      const handle = kind === 'Rotation Handle'
        ? rotationHandle(container)!
        : kind === 'Zone Control Point'
          ? zoneControlPoint(container, 'rect-corner', 2)!
          : measurementGuideControlPoint(container, 1)!
      const start = kind === 'Rotation Handle'
        ? rotationHandleCenter(container)
        : kind === 'Zone Control Point'
          ? zoneControlPointCenter(container, 'rect-corner', 2)
          : measurementGuideControlPointCenter(container, 1)

      events.pointerDown(start, { pointerId: 27, target: handle })
      events.pointerMove({ x: 150, y: 170 }, { pointerId: 27 })
      // The selected zone's chips, or the dragged guide's length chip, are the host's draft (today's measurement overlay).
      expect(baseDeps.renderer.lastDraft()).not.toBeNull()

      // The ToolHost disposes the tool: the live drag's cancel fails, the fault rule's abort fails too, and so does the
      // tool's own transient cleanup after it.
      expect(() => session.dispose()).toThrow('Tool host disposal failed')
      expect(abortFailure.abortCalls()).toBe(3)
      expect(container.querySelector('[data-canvas-handle-layer]')).toBeNull()
      expect(container.querySelector('[data-rotation-handle]')).toBeNull()
      expect(container.querySelector('[data-zone-control-points]')).toBeNull()
      expect(container.querySelector('[data-measurement-guide-control-points]')).toBeNull()
      expect(baseDeps.renderer.lastDraft()).toBeNull()
    },
  )

  it('a failed shared-drag cancellation is rolled back at once, admitting another pointerdown normally', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const baseDeps = createInteractionDeps(container, store, testView)
    const abortFailure = createAbortFailingSceneEdits(
      baseDeps.sceneEdits,
      'interaction-drag',
      'shared drag abort failed',
    )
    const deps: SceneInteractionSessionDeps = { ...baseDeps, sceneEdits: abortFailure.sceneEdits }
    const session = createTestSession(deps)
    session.setTool('select')
    const persistedBefore = store.persisted

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 26 })
    events.pointerMove({ x: 40, y: 50 }, { pointerId: 26 })
    expect(store.persisted).not.toEqual(persistedBefore)

    const errors = captureWindowErrors(() => {
      events.pointerCancel({ x: 40, y: 50 }, { pointerId: 26 })
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual(expect.objectContaining({ message: 'shared drag abort failed' }))
    // The fault rule's abort inside the same cancellation has already rolled the edit back.
    expect(abortFailure.abortCalls()).toBe(2)
    expect(abortFailure.beginCalls()).toBe(1)
    expect(store.persisted).toEqual(persistedBefore)

    events.pointerDown({ x: 40, y: 50 }, { pointerId: 27 })

    expect(abortFailure.abortCalls()).toBe(2)
    session.dispose()
    expect(abortFailure.abortCalls()).toBe(2)
  })

  it('a failed shared-drag cancellation is rolled back at once, admitting a later pointerup normally', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const baseDeps = createInteractionDeps(container, store, testView)
    const abortFailure = createAbortFailingSceneEdits(
      baseDeps.sceneEdits,
      'interaction-drag',
      'shared drag abort failed',
    )
    const deps: SceneInteractionSessionDeps = { ...baseDeps, sceneEdits: abortFailure.sceneEdits }
    const session = createTestSession(deps)
    session.setTool('select')
    const persistedBefore = store.persisted

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 28 })
    events.pointerMove({ x: 40, y: 50 }, { pointerId: 28 })
    expect(store.persisted).not.toEqual(persistedBefore)

    const errors = captureWindowErrors(() => {
      events.pointerCancel({ x: 40, y: 50 }, { pointerId: 28 })
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual(expect.objectContaining({ message: 'shared drag abort failed' }))
    expect(abortFailure.abortCalls()).toBe(2)
    expect(abortFailure.beginCalls()).toBe(1)
    expect(store.persisted).toEqual(persistedBefore)

    // A right-click on the map, a release outside the tool: the fault armed a fresh Select, so nothing is left to abort.
    events.pointerDown({ x: 40, y: 50 }, { pointerId: 29, button: 2 })
    events.pointerUp({ x: 40, y: 50 }, { pointerId: 29, button: 2 })

    expect(abortFailure.abortCalls()).toBe(2)
    expect(store.persisted).toEqual(persistedBefore)
    session.dispose()
    expect(abortFailure.abortCalls()).toBe(2)
  })

  it('a failed shared-drag cancellation is rolled back at once, admitting a later plant drop normally', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const baseDeps = createInteractionDeps(container, store, testView)
    const abortFailure = createAbortFailingSceneEdits(
      baseDeps.sceneEdits,
      'interaction-drag',
      'shared drag abort failed',
    )
    const deps: SceneInteractionSessionDeps = { ...baseDeps, sceneEdits: abortFailure.sceneEdits }
    const session = createTestSession(deps)
    session.setTool('select')
    const persistedBefore = store.persisted

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 29 })
    events.pointerMove({ x: 40, y: 50 }, { pointerId: 29 })
    const errors = captureWindowErrors(() => {
      events.pointerCancel({ x: 40, y: 50 }, { pointerId: 29 })
    })
    expect(errors).toHaveLength(1)
    expect(abortFailure.abortCalls()).toBe(2)
    expect(store.persisted).toEqual(persistedBefore)

    const dragData = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        return dragData.get(type) ?? ''
      },
    }
    writePlantStampDragData(dataTransfer, {
      canonical_name: 'Pyrus communis',
      common_name: 'Pear',
      stratum: 'mid',
      width_max_m: 3,
    })
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dropEvent, {
      clientX: { configurable: true, value: 80 },
      clientY: { configurable: true, value: 90 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })

    container.dispatchEvent(dropEvent)

    // Nothing is left pending: the drop is admitted and places the pear.
    expect(dropEvent.defaultPrevented).toBe(true)
    expect(abortFailure.abortCalls()).toBe(2)
    expect(abortFailure.beginCalls()).toBe(1)
    expect(store.persisted.plants).toHaveLength(2)
    // The fault armed a fresh Select: disposal has nothing left to abort.
    session.dispose()
    expect(abortFailure.abortCalls()).toBe(2)
  })

  it('a failed cancellation is rolled back at once, with no key swallowed for a later shortcut', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const baseDeps = createInteractionDeps(container, store, testView)
    const abortFailure = createAbortFailingSceneEdits(
      baseDeps.sceneEdits,
      'interaction-drag',
      'shared drag abort failed',
    )
    const deps: SceneInteractionSessionDeps = { ...baseDeps, sceneEdits: abortFailure.sceneEdits }
    const session = createTestSession(deps)
    session.setTool('select')
    const persistedBefore = store.persisted

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 30 })
    events.pointerMove({ x: 40, y: 50 }, { pointerId: 30 })
    const errors = captureWindowErrors(() => {
      events.pointerCancel({ x: 40, y: 50 }, { pointerId: 30 })
    })
    expect(errors).toHaveLength(1)
    // The fault rule's abort inside the same cancellation has already rolled the edit back: no key needs swallowing.
    expect(abortFailure.abortCalls()).toBe(2)
    expect(store.persisted).toEqual(persistedBefore)
    session.dispose()
  })

  it('clears hover when disposed', () => {
    const setHoveredTarget = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { setHoveredTarget })
    const session = createTestSession(deps)

    session.dispose()

    expect(setHoveredTarget).toHaveBeenCalledWith(null)
  })

  it('a handle pressed and moved 2 px with a mouse, or 7 px with a finger, records no history (A9)', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()
    const before = store.persisted.zones[0]
    /** The handle's box centre, whatever its size. */
    const centre = (element: HTMLElement): ScenePoint => ({
      x: Number.parseFloat(element.style.left) + Number.parseFloat(element.style.width) / 2,
      y: Number.parseFloat(element.style.top) + Number.parseFloat(element.style.height) / 2,
    })
    let time = 0
    /** A still press on `handle` that wanders `jitterPx` to the right before it lifts there, within its pointer's slop. */
    const jitteredTap = (handle: () => HTMLElement, jitterPx: number, pointerType: 'mouse' | 'touch') => {
      const element = handle()
      const at = centre(element)
      const moved = { x: at.x + jitterPx, y: at.y }
      time += 1000
      const options = { pointerType, pointerId: pointerType === 'touch' ? 7 : 1, isPrimary: true }
      events.pointerDown(at, { ...options, button: 0, buttons: 1, target: element, timeStamp: time })
      events.pointerMove(moved, { ...options, button: -1, buttons: 1, timeStamp: time + 20 })
      events.pointerUp(moved, { ...options, button: 0, buttons: 0, timeStamp: time + 40 })
    }
    const corner = () => zoneControlPoint(container, 'rect-corner', 1)!
    const rotate = () => rotationHandle(container)!

    jitteredTap(corner, 2, 'mouse')
    jitteredTap(rotate, 2, 'mouse')
    jitteredTap(corner, 7, 'touch')
    jitteredTap(rotate, 7, 'touch')

    expect(store.persisted.zones[0]).toEqual(before)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('a finger that jitters 5 px on empty ground draws no band (A9)', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([plantTarget('plant-1')])
    const finger = { pointerType: 'touch', pointerId: 7, isPrimary: true }

    const bands = () => deps.renderer.drafts.filter((draft) => draft?.shapes.some((shape) => shape.kind === 'quad')).length

    events.pointerDown({ x: 200, y: 200 }, { ...finger, button: 0, buttons: 1 })
    events.pointerMove({ x: 203, y: 204 }, { ...finger, button: -1, buttons: 1 })
    events.pointerUp({ x: 204, y: 203 }, { ...finger, button: 0, buttons: 0 })

    // The lift is a tap on empty ground: it clears the selection, and no band was drawn.
    expect(bands()).toBe(0)
    expect(currentCanvasSelection.value).toEqual(new Set())
    session.dispose()
  })
})
