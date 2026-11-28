// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { installCanvasHostRuntime } from '../app/canvas-map-surface/use-canvas-host'
import { createBrowserCanvasHostRuntime } from '../editions/web/browser-workspace-runtime'
import { createMapLifetimeSlot } from '../maplibre/map-lifetime'
import type { WorkspaceRuntimeComposition } from '../app/canvas-map-surface/workspace-runtime-composition'
import { flattenDocumentForJson as encodeCanopiDesign } from '../app/contracts/document'
import { designSessionStore } from '../app/document-session/store'
import { currentCanvasSession } from '../canvas/session'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { createBrowserCanvasRuntimeAppAdapter } from '../editions/web/browser-canvas-runtime'
import type { KeyRouterHandle } from '../app/keyboard/key-router'
import { installWebKeyRouter } from '../editions/web/browser-shell-commands'
import { WebCanvasWorkspace } from '../editions/web/WebCanvasWorkspace'
import { geoAt } from './support/geo-design'
import { createLiveTestCanvasRuntimeHost } from './support/live-canvas-runtime'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'

/**
 * canopi-28w8 on the Web Edition: the Web workspace with its real floating
 * chrome, Draft session and keyboard routing over a live Scene runtime (the
 * map itself is left out; it plays no part in the prompt or in history).
 */
describe('Where is your site? and Undo on the Web Edition', () => {
  let container: HTMLDivElement
  let keys: KeyRouterHandle | null = null
  let session: TestSessionCoreHandle | null = null

  afterEach(async () => {
    // Unmounting the workspace releases the runtime through the composition.
    await act(async () => {
      render(null, container)
      await flushMicrotasks()
    })
    container.remove()
    keys?.dispose()
    keys = null
    session?.dispose()
    session = null
  })

  it('select all, delete, Ctrl+Z restores every object on the Web edition', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    session = createTestSessionCore({ file: null })
    const host = createLiveTestCanvasRuntimeHost({ appAdapter: createBrowserCanvasRuntimeAppAdapter() })
    const mapSlot = createMapLifetimeSlot(
      { restart: () => false, retryLayer: () => {}, release: () => {} },
      { kind: 'ready', attempt: 1, layers: new Map() },
    )
    const composition: WorkspaceRuntimeComposition = {
      surfaces: host.surfaces,
      mapLifetime: mapSlot.handle,
      start: async () => 'shared-ready',
      dispose: () => host.destroy(),
    }
    const uninstallCanvasHost = installCanvasHostRuntime(() => ({
      core: createBrowserCanvasHostRuntime().core,
      createComposition: () => composition,
    }))
    keys = installWebKeyRouter({
      catalog: [],
      readState: () => ({ hasDesign: true, revertAvailable: false, sidePanel: null }),
    })

    try {
      await act(async () => {
        render(<WebCanvasWorkspace />, container)
        await flushMicrotasks()
      })
    } finally {
      uninstallCanvasHost()
    }
    await flushMicrotasks()
    expect(currentCanvasSession.value).toBe(host.surfaces)

    // Open Design… from the start screen: the orchard opens as a Draft.
    await act(async () => {
      await session!.core.openFrom({
        kind: 'bytes',
        name: 'orchard.canopi',
        bytes: new TextEncoder().encode(JSON.stringify(encodeCanopiDesign(orchard()))),
      })
      await flushMicrotasks()
    })
    const { queries } = host.surfaces
    const opened = queries.getSceneSnapshot()
    expect(designSessionStore.designPath.value).toBeNull()
    expect(opened.plants).toHaveLength(3)
    expect(opened.zones).toHaveLength(1)
    expect(opened.annotations).toHaveLength(1)
    expect(undoButton()).not.toBeNull()

    await press({ key: 'a', ctrlKey: true })
    await press({ key: 'Delete' })

    const emptied = queries.getSceneSnapshot()
    expect([emptied.plants, emptied.zones, emptied.annotations].flat()).toEqual([])
    expect(container.querySelector('[data-site-locate]')).toBeNull()
    expect(undoButton()).not.toBeNull()
    expect(undoButton()!.getAttribute('aria-disabled')).toBeNull()

    await press({ key: 'z', ctrlKey: true })

    const restored = queries.getSceneSnapshot()
    expect(restored.plants).toEqual(opened.plants)
    expect(restored.zones).toEqual(opened.zones)
    expect(restored.annotations).toEqual(opened.annotations)
  })

  function undoButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-command="edit.undo"]')
  }
})

/** A key pressed wherever focus is, as the browser delivers it. */
async function press(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
    await flushMicrotasks()
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function orchard(): CanopiFile {
  const plant = (id: string, x: number, y: number): CanopiFile['plants'][number] => ({
    id, locked: false, canonical_name: 'Malus domestica', common_name: 'Apple', color: null,
    position: geoAt(x, y), rotation: null, canopy_spread_m: null, notes: null, planted_date: null, quantity: 1,
  })
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [plant('apple-1', 0, 0), plant('apple-2', 6, 0), plant('apple-3', 12, 0)],
    zones: [{
      id: 'bed', name: 'Bed', zone_type: 'ellipse', points: [geoAt(-4, -4), geoAt(16, 4)],
      rotation: 0, fill_color: null, notes: null, locked: false,
    }],
    annotations: [{
      id: 'note', annotation_type: 'text', position: geoAt(0, 8), text: 'Mulch in spring',
      font_size: 16, rotation: null, locked: false,
    }],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
  }
}
