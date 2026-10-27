// @vitest-environment jsdom

// Edit › Cut and Delete from the menu bar and the palette (runCanvasIntent) honour the re-origin hold as the keys and the
// canvas menu do (U39): while a draft is live they delete nothing, and the menu bar shows them disabled (S3b). The hold
// comes from a real interaction session, whose tool calls move the query revision's transient history as the runtime's do.
import { effect } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import type { SceneStore } from '../canvas/runtime/scene'
import { setCurrentCanvasSession } from '../canvas/session'
import { runCanvasIntent, workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import type { CanvasCommandFrom } from '../app/canvas-commands'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import type { TestView } from './support/test-view'
import {
  createInteractionDeps,
  installSceneInteractionFixture,
  makePlant,
  plantTarget,
} from './support/canvas-interaction-setup'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createLiveTestCanvasRuntimeHost } from './support/live-canvas-runtime'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'

describe('Edit › Cut and Delete during a draft (U39)', () => {
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

  it('the menu bar and the palette delete nothing while a polygon draft is live, and delete again after Esc', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    const copy = vi.fn()
    const deleteSelected = vi.fn()
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface({ sceneEdits: { copy, deleteSelected } }),
      queries: createTestCanvasQuerySurface({ selection: [plantTarget('plant-1')] }),
      documents: createTestCanvasDocumentSurface(),
      keyboard: session.keyboard,
    })
    session.setTool('polygon')
    container.focus()
    events.pointerDown({ x: 20, y: 20 })
    events.pointerUp({ x: 20, y: 20 })
    events.pointerDown({ x: 80, y: 20 })
    events.pointerUp({ x: 80, y: 20 })
    deps.setSelection([plantTarget('plant-1')])

    for (const from of ['menu', 'palette'] satisfies CanvasCommandFrom[]) {
      runCanvasIntent({ type: 'edit', action: 'delete' }, from)
      runCanvasIntent({ type: 'edit', action: 'cut' }, from)
    }
    expect(deleteSelected).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
    // Copy is not a delete: it still runs during the draft.
    runCanvasIntent({ type: 'edit', action: 'copy' }, 'menu')
    expect(copy).toHaveBeenCalledTimes(1)

    // Esc steps the draft back to nothing (A17): Edit › Delete deletes again.
    events.keyDown({ key: 'Escape', target: container })
    runCanvasIntent({ type: 'edit', action: 'delete' }, 'menu')
    expect(deleteSelected).not.toHaveBeenCalled()
    events.keyDown({ key: 'Escape', target: container })
    runCanvasIntent({ type: 'edit', action: 'delete' }, 'menu')
    expect(deleteSelected).toHaveBeenCalledTimes(1)
    session.dispose()
    setCurrentCanvasSession(null)
  })

  it('the menu bar greys Cut and Delete as the draft starts and enables them again after Esc', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
    })
    const queries = createTestCanvasQuerySurface({ selection: [plantTarget('plant-1')] })
    const deps = createInteractionDeps(container, store, testView)
    // As SceneCanvasRuntime wires it: each tool call moves the transient history the query revision exposes.
    deps.notifyTransientHistoryChange = () => queries.bumpTransientHistory()
    const session = createTestSession(deps)
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: session.keyboard,
    })
    deps.setSelection([plantTarget('plant-1')])
    const greyed = () => Object.fromEntries(workspaceCanvasCommandProjection.value.editActions
      .filter((command) => ['cut', 'copy', 'delete'].includes(command.id))
      .map((command) => [command.id, command.disabled]))
    expect(greyed()).toEqual({ cut: false, copy: false, delete: false })

    session.setTool('polygon')
    container.focus()
    events.pointerDown({ x: 20, y: 20 })
    events.pointerUp({ x: 20, y: 20 })
    events.pointerDown({ x: 80, y: 20 })
    events.pointerUp({ x: 80, y: 20 })
    // Edit › Select all during the draft reselects the plant, as in the live bug.
    deps.setSelection([plantTarget('plant-1')])
    expect(greyed()).toEqual({ cut: true, copy: false, delete: true })

    // Esc steps the draft back to nothing and leaves the selection: only the transient history tells the menu bar.
    events.keyDown({ key: 'Escape', target: container })
    expect(greyed()).toEqual({ cut: true, copy: false, delete: true })
    events.keyDown({ key: 'Escape', target: container })
    expect(greyed()).toEqual({ cut: false, copy: false, delete: false })
    session.dispose()
    setCurrentCanvasSession(null)
  })

  it('a hover over the map moves the transient history but leaves the menu bar\'s projection alone', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
    })
    const queries = createTestCanvasQuerySurface({ selection: [plantTarget('plant-1')] })
    const deps = createInteractionDeps(container, store, testView)
    let historyMoves = 0
    deps.notifyTransientHistoryChange = () => {
      historyMoves += 1
      queries.bumpTransientHistory()
    }
    const session = createTestSession(deps)
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: session.keyboard,
    })
    deps.setSelection([plantTarget('plant-1')])
    session.setTool('select')
    let projections = 0
    const stop = effect(() => {
      void workspaceCanvasCommandProjection.value
      projections += 1
    })
    const before = { projections, historyMoves }

    for (let step = 0; step < 20; step += 1) events.pointerMove({ x: 20 + step * 5, y: 40 })

    // Each hover is a tool call, so the history moves at pointer rate; the hold never flips, so nothing re-projects.
    expect(historyMoves).toBeGreaterThan(before.historyMoves)
    expect(projections).toBe(before.projections)
    stop()
    session.dispose()
    setCurrentCanvasSession(null)
  })

  it('a trackpad twist that ends without a tool call un-greys Cut and Delete as its hold ends', async () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
    })
    const queries = createTestCanvasQuerySurface({ selection: [plantTarget('plant-1')] })
    const deps = { ...createInteractionDeps(container, store, testView), platform: { os: 'mac', gestureEvents: true } as const }
    deps.notifyTransientHistoryChange = () => queries.bumpTransientHistory()
    const session = createTestSession(deps)
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: session.keyboard,
    })
    deps.setSelection([plantTarget('plant-1')])
    session.setTool('select')
    // The menu bar reads the projection throughout, as a rendered Edit menu does.
    const greyed = () => Object.fromEntries(workspaceCanvasCommandProjection.value.editActions
      .filter((command) => ['cut', 'delete'].includes(command.id))
      .map((command) => [command.id, command.disabled]))
    let shown = greyed()
    const stop = effect(() => { shown = greyed() })
    const gesture = (type: string, rotation: number) => {
      container.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        clientX: 200, clientY: 150, scale: 1, rotation, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      }))
    }
    // The cursor rests on the map, so each camera frame of the twist re-emits its hover: a tool call while the twist holds.
    events.pointerMove({ x: 200, y: 150 })

    gesture('gesturestart', 0)
    gesture('gesturechange', 14)
    gesture('gesturechange', 40)
    expect(session.keyboard.holdsSelectionDeletes()).toBe(true)
    expect(shown).toEqual({ cut: true, delete: true })

    // Ended 40° from north: the view keeps its turn, so no camera frame and no tool call follow the end.
    gesture('gestureend', 40)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(session.keyboard.holdsSelectionDeletes()).toBe(false)
    expect(shown).toEqual({ cut: false, delete: false })
    stop()
    session.dispose()
    setCurrentCanvasSession(null)
  })
})

describe('Edit › Lock and Unlock follow the Scene', () => {
  it('re-projects when only the Scene changes: Unlock all greys once nothing is locked, with the selection still empty', () => {
    const host = createLiveTestCanvasRuntimeHost()
    const { commands, documents } = host.surfaces
    documents.loadDocument({
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Locks',
      description: null,
      plant_species_colors: {},
      layers: [],
      plants: [{
        id: 'plant-1', canonical_name: 'Malus domestica', common_name: null, color: null, position: { lon: 0, lat: 0 },
        rotation: null, scale: null, notes: null, planted_date: null, quantity: 1, locked: false,
      }],
      zones: [],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-10-10T00:00:00.000Z',
      updated_at: '2026-10-10T00:00:00.000Z',
      extra: {},
    })
    setCurrentCanvasSession(host.surfaces)
    commands.sceneEdits.selectAll()
    // The Edit menu reads the projection as a rendered menu does: through an effect, which re-runs only on a change.
    const read = () => Object.fromEntries(workspaceCanvasCommandProjection.value.editActions
      .filter((command) => ['lock', 'unlock', 'unlock-all'].includes(command.id))
      .map((command) => [command.id, command.disabled]))
    let shown = read()
    const stop = effect(() => { shown = read() })
    expect(shown).toEqual({ lock: false, unlock: true, 'unlock-all': true })

    // Lock clears the selection, so the selection alone re-projects this one.
    runCanvasIntent({ type: 'edit', action: 'lock' }, 'menu')
    expect(shown).toEqual({ lock: true, unlock: true, 'unlock-all': false })

    // Unlock all leaves the empty selection as it was: the menu learns of it from the Scene edit.
    runCanvasIntent({ type: 'edit', action: 'unlock-all' }, 'menu')
    expect(host.surfaces.queries.getSceneSnapshot().plants[0]?.locked).toBe(false)
    expect(shown).toEqual({ lock: true, unlock: true, 'unlock-all': true })
    stop()
    setCurrentCanvasSession(null)
    void host.destroy()
  })
})
