// @vitest-environment jsdom

// The runtime construction wires the Scene authority's read-only refusal (2.1-M478, design check F3) to the app
// adapter's read-only query: over a read-only Design a Select drag, Delete, a transaction or Undo changes nothing and
// records no history.
import { describe, expect, it, vi } from 'vitest'
import '../../../__tests__/support/camera-tolerance'

vi.mock('../../../ipc/species', () => ({
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import { createSceneInteractionEventHarness } from '../../../__tests__/support/canvas-interaction-events'
import { geoAt } from '../../../__tests__/support/geo-design'
import { placeOnHost } from '../../../__tests__/support/test-view'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import type { CanopiFile } from '../../../types/design'
import { createDetachedCanvasRuntimeAppAdapter } from '../app-adapter'
import { SceneCanvasRuntime } from '../scene-runtime'
import type { SceneEditCoordinator } from './transactions'

const SCREEN = { width: 400, height: 300 }

function makeFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Read-only orchard',
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
      { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
    ],
    plants: [{
      id: 'plant-1',
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      color: null,
      position: geoAt(10, 10),
      rotation: null,
      scale: null,
      notes: null,
      planted_date: null,
      quantity: 1,
      locked: false,
    }],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  } as CanopiFile
}

/** A runtime built by the real construction over a renderer stub, its interaction session live on a 400 × 300 map. */
async function createMountedRuntime(readOnly: { value: boolean }) {
  const runtime = new SceneCanvasRuntime({
    appAdapter: { ...createDetachedCanvasRuntimeAppAdapter(), isReadOnly: () => readOnly.value },
  })
  runtime.connectRenderTarget({ setSnapshot: vi.fn(), setDraft: vi.fn(), requestRender: vi.fn() })
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: SCREEN.width })
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: SCREEN.height })
  await runtime.init(container)
  const file = makeFile()
  runtime.documentSurface.loadDocument(file)
  runtime.documentSurface.resize(SCREEN.width, SCREEN.height)
  // The apple tree at the screen centre (200, 150), one pixel a metre.
  const plane = runtime.querySurface.sessionPlane.peek()!
  const tree = plane.toPlane(file.plants[0]!.position)
  placeOnHost(runtime.cameraHost, plane, { x: SCREEN.width / 2 - tree.x, y: SCREEN.height / 2 - tree.y, scale: 1 })
  runtime.commandSurface.tools.setTool('select')
  const events = createSceneInteractionEventHarness(container)
  return {
    runtime,
    events,
    file,
    sceneCommands: (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands,
    saved: () => runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.plants,
    dispose() {
      events.dispose()
      runtime.destroy()
    },
  }
}

function dragTree(events: ReturnType<typeof createSceneInteractionEventHarness>): void {
  events.pointerDown({ x: 200, y: 150 }, { button: 0 })
  events.pointerMove({ x: 215, y: 150 }, { button: 0 })
  events.pointerMove({ x: 230, y: 150 }, { button: 0 })
  events.pointerUp({ x: 230, y: 150 }, { button: 0 })
}

describe('the runtime construction (canopi-f47t.52.270)', () => {
  it('canopi-f47t.52.270: over a read-only Design a Select drag, Delete, a transaction or Undo leaves the Scene and records no step', async () => {
    const mounted = await createMountedRuntime({ value: true })
    const { runtime, events, sceneCommands } = mounted
    try {
      const shown = mounted.saved()

      dragTree(events)
      expect(mounted.saved()).toEqual(shown)

      runtime.commandSurface.sceneEdits.selectAll()
      runtime.commandSurface.sceneEdits.deleteSelected()
      expect(mounted.saved()).toEqual(shown)

      expect(sceneCommands.run('test-remove', (tx) => tx.mutate((draft) => { draft.plants.pop() }))).toBe(false)
      expect(mounted.saved()).toEqual(shown)
      expect(runtime.commandSurface.history.canUndo.value).toBe(false)
      runtime.commandSurface.history.undo()
      expect(mounted.saved()).toEqual(shown)
    } finally {
      mounted.dispose()
    }
  })

  it('the same drag moves the tree over an editable Design: the refusal, not a missed hit, keeps it', async () => {
    const mounted = await createMountedRuntime({ value: false })
    try {
      const shown = mounted.saved()

      dragTree(mounted.events)

      expect(mounted.saved()).not.toEqual(shown)
      expect(mounted.runtime.commandSurface.history.canUndo.value).toBe(true)
    } finally {
      mounted.dispose()
    }
  })

  it('the detached app adapter answers that no Design is read-only', () => {
    expect(createDetachedCanvasRuntimeAppAdapter().isReadOnly?.()).toBe(false)
  })
})
