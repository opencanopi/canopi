// @vitest-environment jsdom

// The read-only Session kind arms only read tools (2.1-M478, design check F3; canopi-f47t.52.270): a Design a newer
// Canopi saved can be looked at with Select and Pan, and no drawing tool's key arms one over it. Failure state "an edit
// tool reachable by shortcut", through the real Desktop key router and armCanvasTool. The one canvas command projection
// greys the drawing tools, Undo, Redo and the edits that change an object, so the rail, menus and palette follow it.
import { signal } from '@preact/signals'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTestCanvasCommandSurface,
  createTestCanvasKeyboardPort,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { installDesktopKeys } from '../../__tests__/support/desktop-key-router'
import { setCurrentCanvasSession } from '../../canvas/session'
import { currentCanvasTool, setCanvasSelection } from '../../canvas/session-state'
import { dispatchWorkspaceCanvasIntent, workspaceCanvasCommandProjection } from '../workspace-commands/canvas-actions'
import { focusOwner } from '../keyboard/focus-owner'
import { singleKeyShortcuts } from '../settings/state'
import { activePanel } from '../shell/state'
import { createDesignSessionStoreTestFixture, designSessionStore } from './store'
import type { CanopiFile } from '../../types/design'

const fixture = createDesignSessionStoreTestFixture(designSessionStore)

const SHOWN: CanopiFile = {
  version: 9,
  name: 'Orchard 2.1',
  description: null,
  plant_species_colors: {},
  plant_species_symbols: {},
  layers: [],
  plants: [],
  zones: [],
  annotations: [],
  measurement_guides: [],
  groups: [],
  consortiums: [],
  timeline: [],
  budget: [],
  budget_currency: 'EUR',
  views: [],
  stories: [],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  extra: {},
}

let host: HTMLDivElement
let elsewhere: HTMLButtonElement
let setTool: ReturnType<typeof vi.fn<(name: string) => void>>
let releaseRegion: () => void

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  elsewhere = document.createElement('button')
  document.body.append(host, elsewhere)
  releaseRegion = focusOwner.registerRegion('map', host)
  setTool = vi.fn<(name: string) => void>()
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({ tools: { setTool } }),
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
  activePanel.value = 'canvas'
  currentCanvasTool.value = 'select'
  singleKeyShortcuts.value = true
  designSessionStore.replaceCurrentDesignState(SHOWN, null, 'Orchard 2.1', {
    kind: 'read-only',
    origin: 'newer-version',
    savedByVersion: 10,
  })
})

afterEach(() => {
  releaseRegion()
  setCurrentCanvasSession(null)
  fixture.reset()
  host.remove()
  elsewhere.remove()
})

it('R1 canopi-f47t.52.270: a drawing tool\'s key arms nothing over a read-only Design; Pan\'s still arms', () => {
  elsewhere.focus()
  const keys = installDesktopKeys()
  try {
    elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true, cancelable: true }))
    elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true }))
  } finally {
    keys.dispose()
  }
  expect(setTool).not.toHaveBeenCalledWith('line')
  expect(setTool).toHaveBeenCalledWith('hand')
})

it('R1 canopi-f47t.52.270: the one command projection greys the drawing tools, Undo and the object edits over a read-only Design', () => {
  const deleteSelected = vi.fn()
  const undo = vi.fn()
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({
      tools: { setTool },
      history: { canUndo: signal(true), canRedo: signal(true), undo },
      sceneEdits: { deleteSelected },
    }),
    queries: createTestCanvasQuerySurface({ selection: [{ kind: 'plant', id: 'plant-1' }] }),
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
  setCanvasSelection(['plant-1'])
  try {
    const projection = workspaceCanvasCommandProjection.value
    const enabledTools = projection.toolGroups.flatMap((group) => group.tools).filter((tool) => !tool.disabled)
    expect(enabledTools.map((tool) => tool.tool)).toEqual(['select', 'hand'])
    expect(projection.historyActions.filter((action) => !action.disabled)).toEqual([])
    const enabledEdits = projection.editActions.filter((action) => !action.disabled).map((action) => action.id)
    expect(enabledEdits).toEqual(['copy', 'select-all', 'deselect'])
    dispatchWorkspaceCanvasIntent({ type: 'edit', action: 'delete' }, 'shortcut')
    dispatchWorkspaceCanvasIntent({ type: 'undo' }, 'shortcut')
    expect(deleteSelected).not.toHaveBeenCalled()
    expect(undo).not.toHaveBeenCalled()
  } finally {
    setCanvasSelection([])
  }
})
