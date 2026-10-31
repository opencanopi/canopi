// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { ViewSnapshotCapture, ViewSnapshotRequest } from '../maplibre/view-snapshot-map'

const snapshots = vi.hoisted(() => ({ requests: [] as ViewSnapshotRequest[] }))

vi.mock('../maplibre/view-snapshot-map', async (importOriginal) => {
  const actual = await importOriginal<typeof ViewSnapshotMapModule>()
  return {
    ...actual,
    createViewSnapshotMap: () => ({
      capture: async (request: ViewSnapshotRequest): Promise<ViewSnapshotCapture> => {
        snapshots.requests.push(request)
        return {
          blob: new Blob(['webp'], { type: 'image/webp' }),
          width: request.width,
          height: request.height,
          missingTiles: false,
          attribution: [],
          timings: { mapSetupMs: 0, settleMs: 0, readMs: 0, encodeMs: 0, totalMs: 0 },
        }
      },
      dispose: async () => undefined,
    }),
  }
})

import {
  closeManageViewsDialog,
  openManageViewsDialog,
  savedViewMenuActions,
} from '../app/saved-views'
import { disposeViewSnapshots } from '../app/saved-views/snapshot'
import { setCurrentCanvasSession } from '../canvas/session'
import { SavedViewDialogs } from '../components/shared/SavedViewDialogs'
import { MenuBar } from '../components/shared/MenuBar'
import type { CanopiFile, SavedView } from '../types/design'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import type * as ViewSnapshotMapModule from '../maplibre/view-snapshot-map'

const VIEW: SavedView = {
  id: 'pond',
  name: 'Pond',
  camera: { lon: 13.001, lat: 23.002, zoom: 17, bearing: 0, ground_size_m: { width: 20, height: 15 } },
  visible_layers: {
    background: { kind: 'none' },
    terrain: { contours: false, hillshade: false },
    scene_layers: [],
    site_data: [],
  },
  highlighted: { species: [], objects: [] },
  title: null,
  text: [],
}

function design(views: SavedView[]): CanopiFile {
  return {
    version: 9, name: 'Views', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR', views, stories: [],
    created_at: '', updated_at: '', extra: {},
  }
}

let container: HTMLDivElement
let queries: TestCanvasQuerySurface
let urls = 0
const revoked: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  urls = 0
  revoked.length = 0
  snapshots.requests = []
  vi.stubGlobal('URL', Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:view-${++urls}`,
    revokeObjectURL: (url: string) => { revoked.push(url) },
  }))
  container = document.createElement('div')
  document.body.append(container)
  queries = createTestCanvasQuerySurface()
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands: createTestCanvasCommandSurface(), queries }))
  replaceCurrentDesignState(design([VIEW]), null, 'Views')
})

afterEach(async () => {
  render(null, container)
  container.remove()
  closeManageViewsDialog()
  replaceCurrentDesignState(design([]), null, 'Empty')
  setCurrentCanvasSession(null)
  await disposeViewSnapshots()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settle(ms = 1000): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('saved view thumbnails in Manage views', () => {
  it('shows a snapshot of each view once drawn, and draws again after the Design changes', async () => {
    await act(async () => {
      openManageViewsDialog()
      render(<SavedViewDialogs />, container)
    })
    const frame = document.querySelector('[data-thumbnail-state]')!
    expect(frame.getAttribute('data-thumbnail-state')).toBe('loading')

    await settle()
    expect(snapshots.requests).toHaveLength(1)
    expect(snapshots.requests[0]).toMatchObject({ width: 320, height: 200, type: 'image/webp' })
    expect(document.querySelector('[data-thumbnail-state] img')?.getAttribute('src')).toBe('blob:view-1')

    await act(async () => { queries.bumpSceneRevision() })
    await settle()
    expect(snapshots.requests).toHaveLength(2)
    expect(document.querySelector('[data-thumbnail-state] img')?.getAttribute('src')).toBe('blob:view-2')
    expect(revoked).toEqual(['blob:view-1'])

    // Rendering again with nothing changed never draws again.
    await act(async () => { render(<SavedViewDialogs />, container) })
    await settle()
    expect(snapshots.requests).toHaveLength(2)
  })

  it('revokes every image when another Design replaces this one', async () => {
    await act(async () => {
      openManageViewsDialog()
      render(<SavedViewDialogs />, container)
    })
    await settle()
    await act(async () => { replaceCurrentDesignState(design([]), null, 'Other') })
    expect(revoked).toEqual(['blob:view-1'])
  })
})

describe('saved view thumbnails in the Saved views menu', () => {
  it('draws the thumbnail when the item is shown', async () => {
    const menus = [{
      id: 'view' as const,
      label: 'View',
      items: [{ type: 'submenu' as const, id: 'view.savedViews', label: 'Saved views', disabled: false, items: savedViewMenuActions() }],
    }]
    await act(async () => { render(<MenuBar menus={menus} label="Menu" />, container) })
    expect(snapshots.requests).toHaveLength(0)

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-menu-id="view"]')!.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-submenu-id="view.savedViews"]')!.click() })
    await settle()

    expect(snapshots.requests).toHaveLength(1)
    const item = container.querySelector('[data-command-id="view.goToView:pond"]')!
    expect(item.querySelector('img')?.getAttribute('src')).toBe('blob:view-1')
    expect(item.textContent).toContain('Pond')
  })
})
