// @vitest-environment jsdom

// canopi-f47t.52.228.20: Manage views moved focus after paint (Preact 11 useEffect) when a control it replaced went
// away: into the rename field, onto the delete confirmation's Cancel, and back to the list after a delete. Until then
// focus was on the page, so an Esc pressed as the change showed was heard by nobody.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../maplibre/view-snapshot-map', async (importOriginal) => ({
  ...await importOriginal<typeof ViewSnapshotMapModule>(),
  createViewSnapshotMap: () => ({ capture: () => new Promise(() => {}), dispose: async () => undefined }),
}))

import {
  closeManageViewsDialog,
  dismissDeleteViewUndo,
  manageViewsDialogOpen,
  openManageViewsDialog,
  savedViewDeleteConfirmation,
} from '../app/saved-views'
import { disposeViewSnapshots } from '../app/saved-views/snapshot'
import { setCurrentCanvasSession } from '../canvas/session'
import { SavedViewDialogs } from '../components/shared/SavedViewDialogs'
import { t } from '../i18n'
import type { CanopiFile, SavedView, Story } from '../types/design'
import { beforePaint, holdAfterPaint } from './support/before-paint'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import type * as ViewSnapshotMapModule from '../maplibre/view-snapshot-map'

function view(id: string, name: string): SavedView {
  return {
    id,
    name,
    camera: { lon: 13.001, lat: 23.002, zoom: 17, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: { background: { kind: 'none' }, terrain: { contours: false, hillshade: false }, scene_layers: [], site_data: [] },
    highlighted: { species: [], objects: [] },
    title: null,
    text: [],
  }
}

function design(views: SavedView[], stories: Story[] = []): CanopiFile {
  return {
    version: 9, name: 'Views', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR', views, stories,
    created_at: '', updated_at: '', extra: {},
  }
}

const POND = view('pond', 'Pond')
const HEDGE = view('hedge', 'Hedge')
const TOUR: Story = { id: 'tour', name: 'Open day', steps: [{ id: 'step', view_id: 'pond', title: 'Step', text: [], images: [] }] }

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands: createTestCanvasCommandSurface(), queries: createTestCanvasQuerySurface() }))
})

afterEach(async () => {
  render(null, container)
  container.remove()
  closeManageViewsDialog()
  dismissDeleteViewUndo()
  replaceCurrentDesignState(design([]), null, 'Empty')
  setCurrentCanvasSession(null)
  await disposeViewSnapshots()
})

async function openManageViews(views: SavedView[], stories: Story[] = []): Promise<void> {
  replaceCurrentDesignState(design(views, stories), null, 'Views')
  await act(async () => {
    openManageViewsDialog()
    render(<SavedViewDialogs />, container)
  })
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function escape(): void {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

describe('Manage views keeps focus with the control that replaced the focused one', () => {
  it('canopi-f47t.52.228.20: Rename focuses its field as it shows, and an Esc at once cancels the rename only', async () => {
    const release = holdAfterPaint()
    try {
      await openManageViews([POND])
      button(t('savedViews.renameAria', { name: 'Pond' })).click()
      await beforePaint()
      const field = container.querySelector<HTMLInputElement>('input[aria-label]')!
      expect(field.getAttribute('aria-label')).toBe(t('savedViews.renameField', { name: 'Pond' }))
      expect(document.activeElement, 'the field has focus as it first shows').toBe(field)

      escape()
      await beforePaint()
      expect(container.querySelector('input[aria-label]'), 'the rename is cancelled').toBeNull()
      expect(manageViewsDialogOpen.value, 'the dialog stays open').toBe(true)
      expect(document.activeElement, 'focus is back on Rename').toBe(button(t('savedViews.renameAria', { name: 'Pond' })))
    } finally {
      release()
    }
  })

  it('canopi-f47t.52.228.20: a delete confirmation focuses Cancel as it shows, and an Esc at once closes the dialog', async () => {
    const release = holdAfterPaint()
    try {
      await openManageViews([POND], [TOUR])
      button(t('savedViews.deleteAria', { name: 'Pond' })).click()
      await beforePaint()
      expect(savedViewDeleteConfirmation.value).not.toBeNull()
      const confirmation = container.querySelector('[role="alertdialog"]')!
      expect(document.activeElement, 'Cancel has focus as the confirmation first shows').toBe(
        Array.from(confirmation.querySelectorAll('button')).find((node) => node.textContent === t('savedViews.cancel')),
      )
      escape()
      expect(manageViewsDialogOpen.value, 'Esc closed the dialog').toBe(false)
    } finally {
      release()
    }
  })

  it('canopi-f47t.52.228.20: after a delete focus is in the list at once, so an Esc closes the dialog', async () => {
    const release = holdAfterPaint()
    try {
      await openManageViews([POND, HEDGE])
      button(t('savedViews.deleteAria', { name: 'Pond' })).click()
      await beforePaint()
      expect(container.querySelector('[role="dialog"] ul')!.contains(document.activeElement), 'focus is in the list').toBe(true)
      escape()
      expect(manageViewsDialogOpen.value, 'Esc closed the dialog').toBe(false)
    } finally {
      release()
    }
  })
})
