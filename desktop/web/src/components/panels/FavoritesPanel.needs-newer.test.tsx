// @vitest-environment jsdom

// Favorites lists a saved stamp a newer Canopi wrote with its note and offers nothing on it (Step 2.0.4 R2-5,
// canopi-f47t.52.271; 2.1-M88), over the real stamp workbench with a fake store.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../../app/plant-browser/workbench'
import type * as PlantBrowserModule from '../../app/plant-browser'
import type * as WorkbenchModule from '../../app/saved-object-stamps/workbench'
import type * as FavoritesPanelModule from './FavoritesPanel'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import { readSavedObjectStampDragData } from '../../canvas/saved-object-stamp-source'
import { createTestSpeciesCatalogWorkbench } from '../../__tests__/support/species-catalog-workbench'

const V2 = { version: 2, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }
const stamp = (id: string, payload: Record<string, unknown>, sortOrder: number, needsNewer = false): SavedObjectStamp => ({
  id,
  name: id === 'v3' ? 'Apple guild' : 'Hedge',
  payload_json: JSON.stringify(payload),
  sort_order: sortOrder,
  created_at: `2026-11-0${sortOrder + 1}T00:00:00Z`,
  updated_at: `2026-11-0${sortOrder + 1}T00:00:00Z`,
  needs_newer: needsNewer,
})

const V3 = { ...V2, version: 3, guides: [] }
let libraryRows: SavedObjectStamp[] = []

/** The stamp store as user_db keeps it: a reorder numbers the ids it names 0..n-1, others keep their sort_order. */
function fakeStore() {
  let stored: SavedObjectStamp[] | null = null
  const rows = () => (stored ??= libraryRows.map((row) => ({ ...row })))
  const listed = () => [...rows()].sort((left, right) => left.sort_order - right.sort_order
    || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
  return {
    getSavedObjectStamps: vi.fn(async () => listed()),
    renameSavedObjectStamp: vi.fn(async (id: string, name: string) => ({ ...stamp(id, V2, 0), name })),
    deleteSavedObjectStamp: vi.fn(async (_id: string) => true),
    reorderSavedObjectStamps: vi.fn(async (ids: string[]): Promise<SavedObjectStamp[]> => {
      if (rows().some((row) => row.needs_newer && ids.includes(row.id))) throw new Error('saved_object_stamp_needs_newer')
      stored = rows().map((row) => ids.includes(row.id) ? { ...row, sort_order: ids.indexOf(row.id) } : row)
      return listed()
    }),
    arm: vi.fn(() => true),
  }
}

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')].map((row) => row.dataset.savedStampRow!)
}

function installRowRects(container: HTMLElement): void {
  for (const row of container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')) {
    row.getBoundingClientRect = () => {
      const top = 100 + [...container.querySelectorAll('[data-saved-stamp-row]')].indexOf(row) * 40
      return { top, bottom: top + 40, height: 40, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }
    }
  }
}

function dragStart():{ event: DragEvent; data: { getData(type: string): string } } {
  const values = new Map<string, string>()
  const data = {
    types: [] as string[],
    effectAllowed: 'none',
    setData: (type: string, value: string) => { values.set(type, value); data.types.push(type) },
    getData: (type: string) => values.get(type) ?? '',
  }
  const event = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: data })
  return { event, data }
}

describe('Favorites with a saved stamp a newer Canopi wrote (canopi-f47t.52.271)', () => {
  let container: HTMLDivElement
  let species: SpeciesCatalogWorkbench
  let store: ReturnType<typeof fakeStore>
  let FavoritesPanel: typeof FavoritesPanelModule.FavoritesPanel

  beforeEach(async () => {
    vi.resetModules()
    const settings = await import('../../app/settings/state')
    settings.locale.value = 'en'
    libraryRows = [stamp('v2', V2, 0), stamp('v3', V3, 1, true)]
    species = await createTestSpeciesCatalogWorkbench({ locale: settings.locale, getFavorites: async () => [] })
    store = fakeStore()
    vi.doMock('../../app/plant-browser', async () => ({
      ...await vi.importActual<typeof PlantBrowserModule>('../../app/plant-browser'),
      speciesCatalogWorkbench: species,
    }))
    vi.doMock('../../app/saved-object-stamps', async () => {
      const { createSavedObjectStampWorkbench } = await vi.importActual<typeof WorkbenchModule>('../../app/saved-object-stamps/workbench')
      return { savedObjectStampWorkbench: createSavedObjectStampWorkbench(store) }
    })
    ;({ FavoritesPanel } = await import('./FavoritesPanel'))
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    species.dispose()
    vi.doUnmock('../../app/plant-browser')
    vi.doUnmock('../../app/saved-object-stamps')
  })

  async function renderPanel(): Promise<HTMLElement> {
    await act(async () => { render(<FavoritesPanel />, container) })
    await vi.waitFor(() => expect(container.querySelector('[data-saved-stamp-row="v3"]')).not.toBeNull())
    return container.querySelector<HTMLElement>('[data-saved-stamp-row="v3"]')!
  }

  it('reader release: a saved stamp with a v3 payload lists by name with a note to update, every action off', async () => {
    const row = await renderPanel()

    expect(row.textContent).toContain('Apple guild')
    expect(row.textContent).toContain('Saved with a newer Canopi; update Canopi to place it.')
    // No Place, More actions (Export, Rename, Delete) or Delete: the only button is the reorder grip, off.
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((button) => [button.hasAttribute('data-saved-stamp-grip'), button.disabled])).toEqual([[true, true]])
    const body = row.querySelector<HTMLElement>('[data-saved-stamp-body="v3"]')!
    expect(body.getAttribute('draggable')).not.toBe('true')
    const { event, data } = dragStart()
    body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(readSavedObjectStampDragData(data as unknown as DataTransfer)).toBeNull()
  })

  it('canopi-f47t.52.271: Alt+ArrowUp on the older stamp below it sends no reorder naming the v3 row', async () => {
    await renderPanel()
    const grip = container.querySelector<HTMLButtonElement>('[data-saved-stamp-row="v2"] [data-saved-stamp-grip]')!

    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
      await Promise.resolve()
    })

    expect(store.reorderSavedObjectStamps.mock.calls.flat().flat()).not.toContain('v3')
    expect(store.renameSavedObjectStamp).not.toHaveBeenCalled()
    expect(store.deleteSavedObjectStamp).not.toHaveBeenCalled()
    expect(store.arm).not.toHaveBeenCalled()
  })

  it('canopi-f47t.52.271: Alt+ArrowUp past a v3 row moves the older stamp, and the order shown is the order saved', async () => {
    // The v3 row sits between the older two in the store; B and the v3 row would tie on sort_order after the move.
    libraryRows = [stamp('A', V2, 0), stamp('v3', V3, 1, true), stamp('B', V2, 2)]
    await renderPanel()
    expect(rowIds(container), 'the v3 row lists after the stamps this Canopi reads').toEqual(['A', 'B', 'v3'])
    const grip = container.querySelector<HTMLButtonElement>('[data-saved-stamp-row="B"] [data-saved-stamp-grip]')!

    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
      await vi.waitFor(() => expect(store.reorderSavedObjectStamps).toHaveBeenCalled())
    })

    expect(store.reorderSavedObjectStamps).toHaveBeenCalledWith(['B', 'A'])
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['B', 'A', 'v3']))
  })

  it('canopi-f47t.52.271: dragging an older stamp below a v3 row drops it above the v3 row, the preview matching the saved order', async () => {
    libraryRows = [stamp('A', V2, 0), stamp('B', V2, 1), stamp('v3', V3, 2, true)]
    await renderPanel()
    expect(rowIds(container)).toEqual(['A', 'B', 'v3'])
    installRowRects(container)
    const grip = container.querySelector<HTMLButtonElement>('[data-saved-stamp-row="A"] [data-saved-stamp-grip]')!
    grip.setPointerCapture = vi.fn()
    grip.releasePointerCapture = vi.fn()

    await act(async () => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 3, clientY: 110 }))
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientY: 230 }))
      await Promise.resolve()
    })
    expect(rowIds(container), 'the preview keeps the v3 row last').toEqual(['B', 'A', 'v3'])

    await act(async () => {
      grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientY: 230 }))
      await vi.waitFor(() => expect(store.reorderSavedObjectStamps).toHaveBeenCalled())
    })

    expect(store.reorderSavedObjectStamps).toHaveBeenCalledWith(['B', 'A'])
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['B', 'A', 'v3']))
  })
})
