// @vitest-environment jsdom

// Saved stamps are Desktop's (2.1-Q150): Web keeps no stamp library, so its Edit menu, palette and right-click menu
// must not offer Save as stamp as a command that does nothing. Both runtimes are real, built from each edition's own
// adapter; Desktop is the control that shows the command is there where stamps can be saved.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof IpcSpeciesModule>(),
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import type { CanvasRuntimeAppAdapter } from '../canvas/runtime/app-adapter'
import type { CanvasRuntimeSurfaces } from '../canvas/runtime/runtime'
import { setCurrentCanvasSession } from '../canvas/session'
import { createBrowserCanvasRuntimeAppAdapter } from '../web/browser-canvas-runtime'
import { createDesktopCanvasRuntimeAppAdapter } from '../app/canvas-runtime/desktop-adapter'
import { canvasContextMenuRequest } from '../app/canvas-context-menu/state'
import { buildCanvasContextMenuEntries } from '../app/canvas-context-menu/entries'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { geoAt } from './support/geo-design'
import { installCanvasKeyRouter } from './support/key-router'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'
import type * as IpcSpeciesModule from '../ipc/species'

function onePlantFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Stamp edition',
    description: null,
    plant_species_colors: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [{
      id: 'plant-1',
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      color: null,
      position: geoAt(10, 10, { lon: 0, lat: 0 }),
      rotation: null,
      scale: null,
      notes: null,
      planted_date: null,
      quantity: 1,
      locked: false,
    }],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  }
}

let live: CanvasRuntimeHost | null = null

/** A real runtime from an edition's adapter, mounted, with one plant selected and published as the current canvas. */
async function mountWithSelection(appAdapter: CanvasRuntimeAppAdapter) {
  const host = createLiveTestCanvasRuntimeHost({ appAdapter, screen: { width: 400, height: 300 } })
  live = host
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
  await host.init(container)
  const { surfaces } = host
  surfaces.documents.loadDocument(onePlantFile())
  // View › Fit to design leaves the overview at once, without a drawn frame: editing and the right-click menu need it.
  surfaces.commands.viewport.zoomToFit()
  expect(surfaces.queries.view.mode.value).not.toBe('overview')
  setCurrentCanvasSession(surfaces)
  surfaces.commands.sceneEdits.selectAll()
  return { surfaces, container }
}

/** The Menu key on the focused map opens the right-click menu; its entries are what the menu draws. */
function rightClickMenuIds(surfaces: CanvasRuntimeSurfaces, container: HTMLElement): string[] {
  document.body.appendChild(container)
  container.tabIndex = -1
  container.focus()
  const keys = installCanvasKeyRouter(() => surfaces.keyboard)
  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
  keys.dispose()
  container.remove()
  const request = canvasContextMenuRequest.value
  expect(request?.selection?.editableTargets).toHaveLength(1)
  return buildCanvasContextMenuEntries(request!, {
    translate: (key) => key,
    characterKeyShortcuts: true,
    openPlantAppearance: () => {},
    summary: null,
    openSpeciesDetail: () => {},
    addToCalendar: () => {},
    setUnitCost: () => {},
  }).flatMap((entry) => ('id' in entry ? [entry.id] : []))
}

const editMenuSaveAsStamp = () =>
  workspaceCanvasCommandProjection.value.editActions.find((command) => command.id === 'save-as-stamp')

afterEach(() => {
  setCurrentCanvasSession(null)
  void live?.destroy()
  live = null
})

describe('Save as stamp by edition', () => {
  it('canopi-eon8.14.2: on Web, Save as stamp is disabled in the Edit menu and absent from the right-click menu', async () => {
    const { surfaces, container } = await mountWithSelection(createBrowserCanvasRuntimeAppAdapter())

    expect(editMenuSaveAsStamp()?.disabled).toBe(true)
    expect(surfaces.commands.sceneEdits.saveSelectionAsObjectStamp).toBeUndefined()
    expect(rightClickMenuIds(surfaces, container)).not.toContain('save-as-stamp')
  })

  it('canopi-eon8.14.2: on Desktop, Save as stamp is enabled in the Edit menu and offered in the right-click menu', async () => {
    const { surfaces, container } = await mountWithSelection(createDesktopCanvasRuntimeAppAdapter())

    expect(surfaces.commands.sceneEdits.saveSelectionAsObjectStamp).toBeTypeOf('function')
    expect(editMenuSaveAsStamp()?.disabled).toBe(false)
    expect(rightClickMenuIds(surfaces, container)).toContain('save-as-stamp')
  })
})
