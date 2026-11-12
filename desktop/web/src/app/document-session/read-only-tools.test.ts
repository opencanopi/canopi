// @vitest-environment jsdom

// The read-only Session kind arms only read tools (2.1-M478, design check F3; canopi-f47t.52.270): a Design a newer
// Canopi saved can be looked at with Select and Pan, and no drawing tool's key arms one over it. Failure state "an edit
// tool reachable by shortcut", through the real Desktop key router and armCanvasTool.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTestCanvasCommandSurface,
  createTestCanvasKeyboardPort,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { installDesktopKeys } from '../../__tests__/support/desktop-key-router'
import { setCurrentCanvasSession } from '../../canvas/session'
import { currentCanvasTool } from '../../canvas/session-state'
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

it.fails('R1 canopi-f47t.52.270: a drawing tool\'s key arms nothing over a read-only Design; Pan\'s still arms', () => {
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
