// @vitest-environment jsdom

// The saved stamp rows preview on the bubbling focusin and focusout, the core event names (no compat alias,
// no-compat-event-alias).
import { render } from 'preact'
import { signal, type Signal } from '@preact/signals'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import { readSavedObjectStampDragData } from '../canvas/saved-object-stamp-source'
import type { SpeciesListItem } from '../types/species'
import type { CanopiFile } from '../types/design'
import { beforePaint, holdAfterPaint } from './support/before-paint'
import {
  createTestSpeciesCatalogWorkbench,
  makeSpeciesListItem,
} from './support/species-catalog-workbench'
import type * as FavoritesPanelModule from '../components/panels/FavoritesPanel'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantBrowserModule from '../app/plant-browser'
import type * as FavoritesControllerModule from '../app/favorites/controller'

vi.mock('../components/plant-detail/PlantDetailCard', () => ({
  PlantDetailCard: ({ canonicalName }: { canonicalName: string }) => (
    <div data-testid="favorite-detail"><button type="button" data-detail-back>{canonicalName}</button></div>
  ),
}))

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function dragDataStore() {
  const values = new Map<string, string>()
  const types: string[] = []
  return {
    values,
    types,
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type: string, value: string) {
      values.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    getData(type: string) {
      return values.get(type) ?? ''
    },
  }
}

function dragStartEvent(dataTransfer: ReturnType<typeof dragDataStore>): DragEvent {
  const event = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: dataTransfer,
  })
  return event
}

function elementRect({
  left = 0,
  top = 0,
  width = 0,
  height = 0,
}: {
  left?: number
  top?: number
  width?: number
  height?: number
}): DOMRect {
  return {
    width,
    height,
    top,
    right: left + width,
    bottom: top + height,
    left,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

function installSavedStampRowRects(container: HTMLElement): void {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
  rows.forEach((row) => {
    row.getBoundingClientRect = () => {
      const currentRows = [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      const index = currentRows.indexOf(row)
      return elementRect({ top: 100 + index * 40, height: 40 })
    }
  })
}

function preparePointerGrip(grip: HTMLElement): void {
  grip.setPointerCapture = vi.fn()
  grip.releasePointerCapture = vi.fn()
}

describe('FavoritesPanel', () => {
  let container: HTMLDivElement
  let FavoritesPanel: typeof FavoritesPanelModule.FavoritesPanel
  let locale: typeof SettingsStateModule.locale
  let savedStampsFrameHeight: typeof SettingsStateModule.savedStampsFrameHeight
  let workbench: SpeciesCatalogWorkbench
  let getFavoritesMock: ReturnType<typeof vi.fn>
  let resolveCommonNamesMock: ReturnType<typeof vi.fn>
  let loadStampLibraryMock: ReturnType<typeof vi.fn>
  let saveSelectionMock: ReturnType<typeof vi.fn>
  let saveCanvasSelectionMock: ReturnType<typeof vi.fn>
  let renameStampMock: ReturnType<typeof vi.fn>
  let deleteStampMock: ReturnType<typeof vi.fn>
  let reorderStampMock: ReturnType<typeof vi.fn>
  let placeStampMock: ReturnType<typeof vi.fn>
  let exportStampMock: ReturnType<typeof vi.fn>
  let importStampFileMock: ReturnType<typeof vi.fn>
  let stampLibrary: Signal<{
    items: SavedStampFixture[]
    loading: boolean
    revision: number
  }>

  interface SavedStampFixture {
    id: string
    name: string
    payload_json: string
    sort_order: number
    created_at: string
    updated_at: string
  }

  beforeEach(async () => {
    vi.resetModules()
    const settings = await import('../app/settings/state')
    locale = settings.locale
    savedStampsFrameHeight = settings.savedStampsFrameHeight
    locale.value = 'en'
    savedStampsFrameHeight.value = 220
    getFavoritesMock = vi.fn(async () => [
      makeSpeciesListItem('Malus domestica', true),
    ])
    resolveCommonNamesMock = vi.fn(async () => ({}))
    workbench = await createTestSpeciesCatalogWorkbench({
      locale,
      getFavorites: getFavoritesMock as unknown as (locale: string) => Promise<SpeciesListItem[]>,
      resolveCommonNames: resolveCommonNamesMock as unknown as (names: readonly string[], locale: string) => Promise<Record<string, string>>,
    })
    loadStampLibraryMock = vi.fn(async () => {})
    saveSelectionMock = vi.fn(async () => null)
    saveCanvasSelectionMock = vi.fn()
    renameStampMock = vi.fn(async () => null)
    deleteStampMock = vi.fn(async () => true)
    reorderStampMock = vi.fn(async () => {})
    placeStampMock = vi.fn(() => true)
    exportStampMock = vi.fn(async () => '/tmp/Pommier, Lavande.canopi')
    importStampFileMock = vi.fn(async () => ({ status: 'cancelled' }))
    stampLibrary = signal({
      items: [{
        id: 'stamp-1',
        name: 'Pommier, Lavande',
        payload_json: JSON.stringify({
          version: 2,
          anchor: { x: 10, y: 10 },
          plants: [
            {
              id: 'plant-1',
              canonicalName: 'Malus domestica',
              commonName: 'Apple',
              color: null,
              symbol: null,
              position: { x: 10, y: 10 },
              rotationDeg: null,
              scale: 2,
            },
            {
              id: 'plant-2',
              canonicalName: 'Lavandula angustifolia',
              commonName: 'Lavender',
              color: null,
              symbol: null,
              position: { x: 12, y: 10 },
              rotationDeg: null,
              scale: 1,
            },
          ],
          zones: [{
            id: 'zone-1',
            name: 'Bed',
            zoneType: 'rect',
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
            rotationDeg: 0,
            fillColor: null,
          }],
          annotations: [{
            id: 'annotation-1',
            annotationType: 'text',
            position: { x: 10, y: 8 },
            text: 'Guild',
            fontSize: 12,
            rotationDeg: null,
          }],
          groups: [],
        }),
        sort_order: 0,
        created_at: '2026-06-19T09:00:00Z',
        updated_at: '2026-06-19T09:00:00Z',
      }],
      loading: false,
      revision: 0,
    })
    vi.doMock('../app/plant-browser', async () => {
      const actual = await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser')
      return {
        ...actual,
        speciesCatalogWorkbench: workbench,
      }
    })
    vi.doMock('../app/saved-object-stamps', () => ({
      savedObjectStampWorkbench: {
        library: stampLibrary,
        selection: signal({
          canSave: true,
          reason: null,
          selectedCount: 3,
        }),
        loadLibrary: loadStampLibraryMock,
        saveCurrentSelection: saveSelectionMock,
        renameStamp: renameStampMock,
        deleteStamp: deleteStampMock,
        reorderStamps: reorderStampMock,
        placeStamp: placeStampMock,
        exportStamp: exportStampMock,
        importStampFile: importStampFileMock,
      },
    }))
    vi.doMock('../app/favorites/controller', async () => {
      const actual = await vi.importActual<typeof FavoritesControllerModule>(
        '../app/favorites/controller',
      )
      return {
        ...actual,
        saveCanvasSelectionAsObjectStamp: saveCanvasSelectionMock,
      }
    })
    ;({ FavoritesPanel } = await import('../components/panels/FavoritesPanel'))

    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    workbench.dispose()
    vi.doUnmock('../app/plant-browser')
    vi.doUnmock('../app/saved-object-stamps')
    vi.doUnmock('../app/favorites/controller')
  })

  it('requests favorites on mount and renders the current favorite list', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    expect(getFavoritesMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await workbench.loadFavorites()
      await flushEffects()
    })

    expect(container.textContent).toContain('Favorites')
    expect(container.textContent).toContain('Malus domestica')
  })

  it('searches favorites and clears a no-results state without changing the library', async () => {
    await act(async () => { render(<FavoritesPanel />, container); await flushEffects(); await workbench.loadFavorites() })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search favorites and stamps"]')!
    await act(async () => { input.value = 'no-such-species'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(container.textContent).toContain('No matching species.')
    expect(container.querySelector('[data-favorite-species]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click() })
    expect(container.querySelector('[data-favorite-species]')?.textContent).toContain('Malus domestica')
    expect(workbench.favorites.value.items).toHaveLength(1)
    expect(document.activeElement).toBe(input)
  })

  it('shows the English catalog name marked (en) for a favourite with no name in the interface language', async () => {
    resolveCommonNamesMock.mockImplementation(async (names: readonly string[], requested: string) => (
      requested === 'en' && names.includes('Malus domestica') ? { 'Malus domestica': 'Apple' } : {}
    ))
    getFavoritesMock.mockImplementation(async () => [{ ...makeSpeciesListItem('Malus domestica', true), common_name: null }])
    locale.value = 'fr'
    await act(async () => { render(<FavoritesPanel />, container); await flushEffects() })
    await act(async () => { await workbench.loadFavorites(); await flushEffects() })
    const favorite = container.querySelector<HTMLElement>('[data-favorite-species="Malus domestica"]')!
    // The English name follows the catalog's projection: the language's lookup, then English.
    await vi.waitFor(() => expect(favorite.querySelector('strong [lang="en"]')?.textContent).toBe('Apple'))
    expect(favorite.querySelector('strong')?.textContent).toContain('(angl.)')
    expect(favorite.querySelector('em[lang="la"]')?.textContent).toBe('Malus domestica')
    expect(resolveCommonNamesMock).toHaveBeenCalledWith(['Malus domestica'], 'en')
    const buttons = [...favorite.querySelectorAll<HTMLButtonElement>(':scope > button')]
    expect(buttons.at(-1)!.getAttribute('aria-label')).toContain('Apple')
  })

  it('leads favourite rows with the star and names Place with its plant', async () => {
    await act(async () => { render(<FavoritesPanel />, container); await flushEffects() })
    await act(async () => { await workbench.loadFavorites(); await flushEffects() })
    const favorite = container.querySelector<HTMLElement>('[data-favorite-species="Malus domestica"]')!
    const buttons = [...favorite.querySelectorAll<HTMLButtonElement>(':scope > button')]
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Remove Malus domestica from favorites')
    expect(buttons.at(-1)!.getAttribute('aria-label')).toBe('Place Malus domestica')
    expect(buttons.at(-1)!.textContent).toBe('Place')
  })

  it('restores the information button, search and list position after detail closes', async () => {
    await act(async () => { render(<FavoritesPanel />, container); await flushEffects(); await workbench.loadFavorites() })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search favorites and stamps"]')!
    await act(async () => { input.value = 'Malus'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    const list = container.querySelector<HTMLElement>('[role="list"]')!
    list.scrollTop = 90
    const info = container.querySelector<HTMLButtonElement>('[data-species-detail]')!
    await act(async () => { info.focus(); info.click(); await flushEffects() })
    expect(container.querySelector('[data-favorites-main]')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector<HTMLElement>('[data-favorites-main]')?.hidden).toBe(true)
    expect(container.querySelector('[data-testid="favorite-detail"]')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-detail-back]'))
    await act(async () => workbench.closeSpeciesDetail())
    expect(document.activeElement).toBe(info)
    expect(input.value).toBe('Malus')
    expect(list.scrollTop).toBe(90)
  })

  it('renders Saved Stamps below species favorites and saves the current selection', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    expect(loadStampLibraryMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Saved stamps')
    expect(container.querySelector('button[aria-label^="More actions for "]')).toBeTruthy()
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')).toBeNull()
    expect(container.textContent).toContain('Pommier, Lavande')
    expect(container.textContent).toContain('2 plants · 1 zone · 1 annotation')

    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save selection'))
    expect(saveButton).toBeTruthy()

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    expect(saveCanvasSelectionMock).toHaveBeenCalledTimes(1)
    expect(saveSelectionMock).not.toHaveBeenCalled()

    const importButton = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Import stamps…')
    expect(importButton).toBeTruthy()

    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    expect(importStampFileMock).toHaveBeenCalledTimes(1)

    const placeButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Place stamp "]')
    expect(placeButton).toBeTruthy()

    await act(async () => {
      placeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    // Arming focuses the map (app/keyboard/arming.test.ts); the panel passes its caller.
    expect(placeStampMock).toHaveBeenCalledWith(stampLibrary.value.items[0], 'panel')

    await openStampActions()
    const exportButton = document.querySelector<HTMLButtonElement>('button[aria-label="Export stamp…"]')
    expect(exportButton).toBeTruthy()

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    expect(exportStampMock).toHaveBeenCalledWith(stampLibrary.value.items[0])
  })

  it('says why a stamp file was refused, and clears the message on the next import', async () => {
    importStampFileMock.mockResolvedValueOnce({ status: 'refused', messageKey: 'start.cantReadOlderVersion' })
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const importButton = container.querySelector<HTMLButtonElement>('button[aria-label="Import stamps…"]')!
    await act(async () => {
      importButton.click()
      await flushEffects()
    })

    const notice = container.querySelector<HTMLElement>('[data-saved-stamps-frame] [role="alert"]')
    expect(notice?.textContent).toBe('Made with Canopi before 2.0; Canopi 2.0 and later can’t open it')

    importStampFileMock.mockResolvedValueOnce({ status: 'cancelled' })
    await act(async () => {
      importButton.click()
      await flushEffects()
    })
    expect(container.querySelector('[data-saved-stamps-frame] [role="alert"]')).toBeNull()
  })

  it('clears a stamp import refusal once Save selection is pressed or the library changes', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const importButton = container.querySelector<HTMLButtonElement>('button[aria-label="Import stamps…"]')!
    const alert = () => container.querySelector<HTMLElement>('[data-saved-stamps-frame] [role="alert"]')

    importStampFileMock.mockResolvedValueOnce({ status: 'refused', messageKey: 'savedObjectStamps.summaryEmpty' })
    await act(async () => {
      importButton.click()
      await flushEffects()
    })
    expect(alert()?.textContent).toBe('No visible objects')
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save selection'))!
    await act(async () => {
      saveButton.click()
      await flushEffects()
    })
    expect(alert()).toBeNull()

    importStampFileMock.mockResolvedValueOnce({ status: 'refused', messageKey: 'savedObjectStamps.summaryEmpty' })
    await act(async () => {
      importButton.click()
      await flushEffects()
    })
    expect(alert()?.textContent).toBe('No visible objects')
    await act(async () => {
      stampLibrary.value = { ...stampLibrary.value, revision: stampLibrary.value.revision + 1 }
      await flushEffects()
    })
    expect(alert()).toBeNull()
  })

  it('clears a stamp import refusal once another Design is opened', async () => {
    const { designSessionStore } = await import('../app/document-session/store')
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const alert = () => container.querySelector<HTMLElement>('[data-saved-stamps-frame] [role="alert"]')
    importStampFileMock.mockResolvedValueOnce({ status: 'refused', messageKey: 'savedObjectStamps.summaryEmpty' })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Import stamps…"]')!.click()
      await flushEffects()
    })
    expect(alert()?.textContent).toBe('No visible objects')

    await act(async () => {
      designSessionStore.replaceCurrentDesignState(otherDesign(), '/designs/other.canopi', 'Other')
      await flushEffects()
    })

    expect(alert()).toBeNull()
  })

  it('tells the user when saving an imported stamp fails', async () => {
    const failure = new Error('database is locked')
    importStampFileMock.mockRejectedValueOnce(failure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act(async () => {
        render(<FavoritesPanel />, container)
        await flushEffects()
      })
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Import stamps…"]')!.click()
        await flushEffects()
      })
      expect(container.querySelector('[role="alert"]')?.textContent)
        .toBe('Couldn’t save the imported stamp.')
      expect(consoleError).toHaveBeenCalledWith('Saved stamp import failed:', failure)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('renders plant favorites and Saved Stamps as sibling frames', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const plantsFrame = container.querySelector<HTMLElement>('[data-favorites-plants-frame]')
    const stampsFrame = container.querySelector<HTMLElement>('[data-saved-stamps-frame]')

    expect(plantsFrame).toBeTruthy()
    expect(stampsFrame).toBeTruthy()
    expect(plantsFrame?.textContent).toContain('Plants')
    expect(stampsFrame?.textContent).toContain('Saved stamps')
  })

  it('manages Saved Stamps with ledger actions rename delete and separate drag handles', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const row = container.querySelector<HTMLElement>('[data-saved-stamp-row="stamp-1"]')
    const body = container.querySelector<HTMLElement>('[data-saved-stamp-body="stamp-1"]')
    const grip = container.querySelector<HTMLElement>('[data-saved-stamp-grip]')
    expect(row).toBeTruthy()
    expect(body).toBeTruthy()
    expect(grip).toBeTruthy()
    expect(row?.getAttribute('draggable')).not.toBe('true')
    expect(body?.getAttribute('draggable')).toBe('true')
    expect(grip?.getAttribute('draggable')).not.toBe('true')

    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
    expect(placeStampMock).not.toHaveBeenCalled()

    const placementDragData = dragDataStore()
    body!.dispatchEvent(dragStartEvent(placementDragData))
    expect(readSavedObjectStampDragData(placementDragData)?.plants).toHaveLength(2)

    const reorderDragData = dragDataStore()
    grip!.dispatchEvent(dragStartEvent(reorderDragData))
    expect(readSavedObjectStampDragData(reorderDragData)).toBeNull()

    await openStampActions()
    expect(container.querySelector('button[aria-label^="Place stamp "]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="Export stamp…"]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="Rename"]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="Delete"]')).toBeTruthy()

    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')
    expect(renameInput).toBeTruthy()
    expect(container.querySelector('button[aria-label^="Place stamp "]')).toBeNull()
    expect(document.querySelector('button[aria-label="Export stamp…"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Confirm rename"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Cancel rename"]')).toBeTruthy()

    await act(async () => {
      renameInput!.value = 'Kitchen guild'
      renameInput!.dispatchEvent(new Event('input', { bubbles: true }))
      await flushEffects()
    })
    await act(async () => {
      renameInput!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
      await flushEffects()
    })
    expect(renameStampMock).toHaveBeenCalledWith('stamp-1', 'Kitchen guild')

    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
    const emptyRenameInput = container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')
    await act(async () => {
      emptyRenameInput!.value = '   '
      emptyRenameInput!.dispatchEvent(new Event('input', { bubbles: true }))
      emptyRenameInput!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await flushEffects()
    })
    expect(renameStampMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')).toBeNull()
    expect(container.textContent).toContain('Pommier, Lavande')

    await openStampActions()
    const deleteButton = document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')
    expect(deleteButton).toBeTruthy()

    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
    expect(container.textContent).toContain('Delete this saved stamp?')
    expect(container.querySelector('button[aria-label^="Place stamp "]')).toBeNull()
    expect(document.querySelector('button[aria-label="Export stamp…"]')).toBeNull()
    expect(document.querySelector('button[aria-label="Rename"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Confirm delete"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Cancel delete"]')).toBeTruthy()

    const cancelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel delete"]')
    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
    expect(deleteStampMock).not.toHaveBeenCalled()
    await openStampActions()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
    const confirmButton = container.querySelector<HTMLButtonElement>('button[aria-label="Confirm delete"]')
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    expect(deleteStampMock).toHaveBeenCalledWith('stamp-1')
  })

  it('says a stamp saved before 2.0 cannot be placed and offers only Delete, which removes it', async () => {
    const current = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [{
        ...current,
        id: 'stamp-old',
        name: 'Old guild',
        payload_json: JSON.stringify({ ...JSON.parse(current.payload_json), version: 1 }),
      }],
    }
    deleteStampMock.mockImplementation(async (id: string) => {
      stampLibrary.value = { ...stampLibrary.value, items: stampLibrary.value.items.filter((stamp) => stamp.id !== id), revision: stampLibrary.value.revision + 1 }
      return true
    })
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const row = container.querySelector<HTMLElement>('[data-saved-stamp-row="stamp-old"]')!
    expect(row.textContent).toContain('Old guild')
    expect(row.textContent).toContain('Saved with Canopi before 2.0; Canopi 2.0 can’t place it.')
    expect(row.textContent).not.toContain('2 plants')
    // No Place, drag, Export or Rename: only Delete.
    expect(row.querySelector('button[aria-label^="Place stamp "]')).toBeNull()
    expect(row.querySelector('button[aria-label^="More actions for "]')).toBeNull()
    expect(row.querySelector('[data-saved-stamp-body="stamp-old"]')?.getAttribute('draggable')).not.toBe('true')
    const dragData = dragDataStore()
    const dragStart = dragStartEvent(dragData)
    row.querySelector<HTMLElement>('[data-saved-stamp-body="stamp-old"]')!.dispatchEvent(dragStart)
    expect(readSavedObjectStampDragData(dragData)).toBeNull()
    const actions = [...row.querySelectorAll<HTMLButtonElement>('button:not([data-saved-stamp-grip])')]
    // The only action names its stamp, and its description says why it is the only one,
    // so a keyboard or screen-reader user hears both while tabbing.
    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual(['Delete stamp Old guild'])
    const describedBy = actions[0]!.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe('Saved with Canopi before 2.0; Canopi 2.0 can’t place it.')

    await act(async () => {
      actions[0]!.click()
      await flushEffects()
    })
    expect(row.textContent).toContain('Delete this saved stamp?')
    expect(deleteStampMock).not.toHaveBeenCalled()
    await act(async () => {
      row.querySelector<HTMLButtonElement>('button[aria-label="Confirm delete"]')!.click()
      await flushEffects()
    })
    expect(deleteStampMock).toHaveBeenCalledWith('stamp-old')
    expect(container.querySelector('[data-saved-stamp-row="stamp-old"]')).toBeNull()
    expect(placeStampMock).not.toHaveBeenCalled()
    expect(exportStampMock).not.toHaveBeenCalled()
  })

  // canopi-f47t.52.228.20: the stamp name field, and the delete confirmation's Cancel and the Delete it returns to, took
  // focus after paint (Preact 11 useEffect) once the control they replaced had gone, so focus sat on the page as they
  // first showed and an Esc then was heard by nobody. From the actions menu the row renders twice as the menu closes,
  // and Preact runs a pending effect before a re-render, so the rename test held before the fix too; it guards the
  // focus staying in the commit.
  it('canopi-f47t.52.228.20: the stamp name field has focus as it appears, and an Esc at once cancels the rename', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    await openStampActions()
    const release = holdAfterPaint()
    try {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!.click()
      await beforePaint()
      const field = container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')!
      expect(document.activeElement, 'the field has focus as it first shows').toBe(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await beforePaint()
      expect(container.querySelector('input[aria-label="Stamp name"]'), 'Esc ended the rename').toBeNull()
      expect(renameStampMock).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  it('canopi-f47t.52.228.20: Cancel has focus as a delete confirmation appears, and Delete as it goes', async () => {
    const current = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [{ ...current, id: 'stamp-old', name: 'Old guild', payload_json: JSON.stringify({ ...JSON.parse(current.payload_json), version: 1 }) }],
    }
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const row = container.querySelector<HTMLElement>('[data-saved-stamp-row="stamp-old"]')!
    const release = holdAfterPaint()
    try {
      row.querySelector<HTMLButtonElement>('button[aria-label="Delete stamp Old guild"]')!.click()
      await beforePaint()
      const cancel = row.querySelector<HTMLButtonElement>('button[aria-label="Cancel delete"]')!
      expect(document.activeElement, 'Cancel has focus as the confirmation first shows').toBe(cancel)
      cancel.click()
      await beforePaint()
      expect(document.activeElement, 'Delete has focus as the confirmation goes').toBe(
        row.querySelector('button[aria-label="Delete stamp Old guild"]'),
      )
    } finally {
      release()
    }
  })

  it('keeps keyboard focus in the row through Delete and Cancel on a stamp saved before 2.0', async () => {
    const current = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [{
        ...current,
        id: 'stamp-old',
        name: 'Old guild',
        payload_json: JSON.stringify({ ...JSON.parse(current.payload_json), version: 1 }),
      }],
    }
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const row = container.querySelector<HTMLElement>('[data-saved-stamp-row="stamp-old"]')!
    const deleteButton = row.querySelector<HTMLButtonElement>('button[aria-label="Delete stamp Old guild"]')!
    await act(async () => {
      deleteButton.focus()
      deleteButton.click()
      await flushEffects()
    })
    // Focus moves to the safe choice, which reads the question as its description.
    const cancelButton = row.querySelector<HTMLButtonElement>('button[aria-label="Cancel delete"]')!
    expect(document.activeElement).toBe(cancelButton)
    const describedBy = cancelButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe('Delete this saved stamp?')
    expect(row.querySelector('button[aria-label="Confirm delete"]')?.getAttribute('aria-describedby')).toBe(describedBy)

    await act(async () => {
      cancelButton.click()
      await flushEffects()
    })
    // Focus returns to the row's Delete button.
    expect(document.activeElement).toBe(row.querySelector('button[aria-label="Delete stamp Old guild"]'))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('moves keyboard focus to the next row, the previous row, then the heading as confirmed deletes empty the list', async () => {
    const current = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        current,
        { ...current, id: 'stamp-old', name: 'Old guild', sort_order: 1, payload_json: JSON.stringify({ ...JSON.parse(current.payload_json), version: 1 }) },
        { ...current, id: 'stamp-3', name: 'Hedge', sort_order: 2 },
      ],
    }
    deleteStampMock.mockImplementation(async (id: string) => {
      stampLibrary.value = { ...stampLibrary.value, items: stampLibrary.value.items.filter((stamp) => stamp.id !== id), revision: stampLibrary.value.revision + 1 }
      return true
    })
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-saved-stamp-row="${id}"]`)
    const confirmWithKeyboard = async (id: string) => {
      const confirm = row(id)!.querySelector<HTMLButtonElement>('button[aria-label="Confirm delete"]')!
      await act(async () => {
        confirm.focus()
        confirm.click()
        await flushEffects()
      })
    }

    // A stamp from before 2.0, in the middle: focus goes to the next row.
    await act(async () => {
      row('stamp-old')!.querySelector<HTMLButtonElement>('button[aria-label="Delete stamp Old guild"]')!.click()
      await flushEffects()
    })
    await confirmWithKeyboard('stamp-old')
    expect(row('stamp-old')).toBeNull()
    expect(document.activeElement).toBe(row('stamp-3')!.querySelector('[data-saved-stamp-grip]'))

    // The last row: focus goes to the previous one.
    await act(async () => {
      row('stamp-3')!.querySelector<HTMLButtonElement>('button[aria-label^="More actions for "]')!.click()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click()
      await flushEffects()
    })
    await confirmWithKeyboard('stamp-3')
    expect(row('stamp-3')).toBeNull()
    expect(document.activeElement).toBe(row('stamp-1')!.querySelector('[data-saved-stamp-grip]'))

    // The only row: focus goes to the Saved stamps heading above the empty list.
    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click()
      await flushEffects()
    })
    await confirmWithKeyboard('stamp-1')
    expect(row('stamp-1')).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('saved-object-stamps-title'))
  })

  // canopi-f47t.52.228.20: the deleted row moved focus to its neighbour from a useEffect cleanup, which Preact 11 runs
  // after paint, so for a frame focus sat on the page and an Esc then was heard by nobody.
  it('canopi-f47t.52.228.20: a confirmed delete hands focus to the next row before any after-paint work', async () => {
    const current = stampLibrary.value.items[0]!
    stampLibrary.value = { ...stampLibrary.value, items: [current, { ...current, id: 'stamp-3', name: 'Hedge', sort_order: 1 }] }
    deleteStampMock.mockImplementation(async (id: string) => {
      stampLibrary.value = { ...stampLibrary.value, items: stampLibrary.value.items.filter((stamp) => stamp.id !== id), revision: stampLibrary.value.revision + 1 }
      return true
    })
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-saved-stamp-row="${id}"]`)
    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click()
      await flushEffects()
    })
    const release = holdAfterPaint()
    try {
      const confirm = row('stamp-1')!.querySelector<HTMLButtonElement>('button[aria-label="Confirm delete"]')!
      confirm.focus()
      confirm.click()
      await beforePaint()
      expect(row('stamp-1'), 'the row is gone').toBeNull()
      expect(document.activeElement, 'the next row has focus').toBe(row('stamp-3')!.querySelector('[data-saved-stamp-grip]'))
    } finally {
      release()
    }
  })

  it('keeps keyboard focus in the row through Delete and Cancel from the row actions menu', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click()
      await flushEffects()
    })
    const cancelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel delete"]')!
    expect(document.activeElement).toBe(cancelButton)

    await act(async () => {
      cancelButton.click()
      await flushEffects()
    })
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^More actions for /)
  })

  it('cancels Saved Stamp rename drafts on Escape without saving', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')
    expect(renameInput).toBeTruthy()

    await act(async () => {
      renameInput!.focus()
      renameInput!.value = 'Discarded guild'
      renameInput!.dispatchEvent(new Event('input', { bubbles: true }))
      renameInput!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
      await flushEffects()
    })

    expect(renameStampMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')).toBeNull()
    expect(container.textContent).toContain('Pommier, Lavande')
  })

  it('cancels Saved Stamp rename drafts from the Cancel action without saving', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')
    const cancelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel rename"]')
    expect(renameInput).toBeTruthy()
    expect(cancelButton).toBeTruthy()

    await act(async () => {
      renameInput!.focus()
      renameInput!.value = 'Discarded guild'
      renameInput!.dispatchEvent(new Event('input', { bubbles: true }))
      await flushEffects()
    })
    await act(async () => {
      renameInput!.dispatchEvent(new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: cancelButton,
      }))
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    expect(renameStampMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')).toBeNull()
    expect(container.textContent).toContain('Pommier, Lavande')
  })

  it('starts Saved Stamp rename as a focused edit mode with the whole name selected', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    await openStampActions()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="Stamp name"]')
    expect(renameInput).toBeTruthy()
    expect(document.activeElement).toBe(renameInput)
    expect(renameInput?.selectionStart).toBe(0)
    expect(renameInput?.selectionEnd).toBe('Pommier, Lavande'.length)
    expect(container.querySelector('button[aria-label^="Place stamp "]')).toBeNull()
    expect(document.querySelector('button[aria-label="Export stamp…"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Confirm rename"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Cancel rename"]')).toBeTruthy()
  })

  it('moves a Saved Stamp with Alt and the arrow keys from its named handle', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
      ],
    }
    await act(async () => { render(<FavoritesPanel />, container); await flushEffects() })
    const grip = container.querySelector<HTMLButtonElement>('[aria-label="Reorder Berry guild (Alt ↑ or ↓)"]')!
    expect(grip.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    expect(container.querySelector('button[aria-label="Place stamp Berry guild"]')).not.toBeNull()

    await act(async () => { grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(reorderStampMock).not.toHaveBeenCalled()
    await act(async () => { grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })) })
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-2', 'stamp-1'])
  })

  it('previews Saved Stamp reorder during pointer drag and persists once on release', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
        { ...baseStamp, id: 'stamp-3', name: 'Canopy guild', sort_order: 2 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const visibleNames = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.textContent ?? '')

    expect(visibleNames()[0]).toContain('Alpha guild')
    expect(visibleNames()[1]).toContain('Berry guild')
    expect(visibleNames()[2]).toContain('Canopy guild')

    const sourceGrip = container.querySelector<HTMLElement>(
      '[data-saved-stamp-row="stamp-3"] [data-saved-stamp-grip]',
    )
    expect(sourceGrip).toBeTruthy()
    installSavedStampRowRects(container)
    preparePointerGrip(sourceGrip!)

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 4,
        clientY: 190,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 4,
        clientY: 110,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).not.toHaveBeenCalled()
    expect(visibleNames()[0]).toContain('Canopy guild')
    expect(visibleNames()[1]).toContain('Alpha guild')
    expect(visibleNames()[2]).toContain('Berry guild')

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 4,
        clientY: 110,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-3', 'stamp-1', 'stamp-2'])
    expect(visibleNames()[0]).toContain('Canopy guild')
    expect(visibleNames()[1]).toContain('Alpha guild')
    expect(visibleNames()[2]).toContain('Berry guild')
  })

  it('keeps hidden Saved Stamps in their slots when reordering a searched list', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-a', name: 'Oak', sort_order: 0 },
        { ...baseStamp, id: 'stamp-b', name: 'Hazel ring', sort_order: 1 },
        { ...baseStamp, id: 'stamp-c', name: 'Pine', sort_order: 2 },
        { ...baseStamp, id: 'stamp-d', name: 'Hazel hedge', sort_order: 3 },
        { ...baseStamp, id: 'stamp-e', name: 'Yew', sort_order: 4 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search favorites and stamps"]')!
    await act(async () => {
      input.value = 'hazel'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushEffects()
    })
    const visibleIds = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.dataset.savedStampRow)
    expect(visibleIds()).toEqual(['stamp-b', 'stamp-d'])

    // A click on a grip without moving must not rewrite the library.
    const clickGrip = container.querySelector<HTMLElement>('[data-saved-stamp-row="stamp-b"] [data-saved-stamp-grip]')!
    installSavedStampRowRects(container)
    preparePointerGrip(clickGrip)
    await act(async () => {
      clickGrip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, clientY: 120 }))
      clickGrip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientY: 120 }))
      await flushEffects()
    })
    expect(reorderStampMock).not.toHaveBeenCalled()

    const sourceGrip = container.querySelector<HTMLElement>('[data-saved-stamp-row="stamp-d"] [data-saved-stamp-grip]')!
    preparePointerGrip(sourceGrip)
    await act(async () => {
      sourceGrip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 8, clientY: 160 }))
      sourceGrip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 8, clientY: 110 }))
      await flushEffects()
    })
    expect(visibleIds()).toEqual(['stamp-d', 'stamp-b'])
    await act(async () => {
      sourceGrip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8, clientY: 110 }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-a', 'stamp-d', 'stamp-c', 'stamp-b', 'stamp-e'])

    // Once the library reflects the saved order, the full list shows exactly that order.
    await act(async () => {
      stampLibrary.value = {
        ...stampLibrary.value,
        items: ['stamp-a', 'stamp-d', 'stamp-c', 'stamp-b', 'stamp-e'].map((id, index) => ({
          ...stampLibrary.value.items.find((item) => item.id === id)!,
          sort_order: index,
        })),
        revision: stampLibrary.value.revision + 1,
      }
      await flushEffects()
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushEffects()
    })
    expect(visibleIds()).toEqual(['stamp-a', 'stamp-d', 'stamp-c', 'stamp-b', 'stamp-e'])
  })

  it('reorders Saved Stamps after the hovered row when dragging through the lower half', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
        { ...baseStamp, id: 'stamp-3', name: 'Canopy guild', sort_order: 2 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const visibleNames = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.textContent ?? '')
    const sourceGrip = container.querySelector<HTMLElement>(
      '[data-saved-stamp-row="stamp-1"] [data-saved-stamp-grip]',
    )
    expect(sourceGrip).toBeTruthy()
    installSavedStampRowRects(container)
    preparePointerGrip(sourceGrip!)

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 5,
        clientY: 110,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 5,
        clientY: 212,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).not.toHaveBeenCalled()
    expect(visibleNames()[0]).toContain('Berry guild')
    expect(visibleNames()[1]).toContain('Canopy guild')
    expect(visibleNames()[2]).toContain('Alpha guild')

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 5,
        clientY: 212,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-2', 'stamp-3', 'stamp-1'])
  })

  it('previews a downward Saved Stamp reorder just before the target row midpoint', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
        { ...baseStamp, id: 'stamp-3', name: 'Canopy guild', sort_order: 2 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const visibleNames = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.textContent ?? '')
    const sourceGrip = container.querySelector<HTMLElement>(
      '[data-saved-stamp-row="stamp-1"] [data-saved-stamp-grip]',
    )
    expect(sourceGrip).toBeTruthy()
    installSavedStampRowRects(container)
    preparePointerGrip(sourceGrip!)

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 8,
        clientY: 110,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 8,
        clientY: 156,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).not.toHaveBeenCalled()
    expect(visibleNames()[0]).toContain('Berry guild')
    expect(visibleNames()[1]).toContain('Alpha guild')
    expect(visibleNames()[2]).toContain('Canopy guild')

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 8,
        clientY: 156,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-2', 'stamp-1', 'stamp-3'])
  })

  it('reorders Saved Stamps after the bottom row from the list space below it', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
        { ...baseStamp, id: 'stamp-3', name: 'Canopy guild', sort_order: 2 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const visibleNames = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.textContent ?? '')
    const sourceGrip = container.querySelector<HTMLElement>(
      '[data-saved-stamp-row="stamp-1"] [data-saved-stamp-grip]',
    )
    expect(sourceGrip).toBeTruthy()
    installSavedStampRowRects(container)
    preparePointerGrip(sourceGrip!)

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 6,
        clientY: 110,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 6,
        clientY: 260,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).not.toHaveBeenCalled()
    expect(visibleNames()[0]).toContain('Berry guild')
    expect(visibleNames()[1]).toContain('Canopy guild')
    expect(visibleNames()[2]).toContain('Alpha guild')

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 6,
        clientY: 260,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-2', 'stamp-3', 'stamp-1'])
  })

  it('commits the same Saved Stamp order that the pointer reorder session previews', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
        { ...baseStamp, id: 'stamp-3', name: 'Canopy guild', sort_order: 2 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    installSavedStampRowRects(container)
    const visibleNames = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.textContent ?? '')
    const sourceGrip = container.querySelector<HTMLElement>(
      '[data-saved-stamp-row="stamp-1"] [data-saved-stamp-grip]',
    )
    expect(sourceGrip).toBeTruthy()
    sourceGrip!.setPointerCapture = vi.fn()
    sourceGrip!.releasePointerCapture = vi.fn()

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 4,
        clientY: 110,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 4,
        clientY: 212,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).not.toHaveBeenCalled()
    expect(visibleNames()[0]).toContain('Berry guild')
    expect(visibleNames()[1]).toContain('Canopy guild')
    expect(visibleNames()[2]).toContain('Alpha guild')

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 4,
        clientY: 212,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-2', 'stamp-3', 'stamp-1'])
    expect(visibleNames()[0]).toContain('Berry guild')
    expect(visibleNames()[1]).toContain('Canopy guild')
    expect(visibleNames()[2]).toContain('Alpha guild')
  })

  it('keeps downward Saved Stamp reorder active if pointer capture is lost during row reflow', async () => {
    const baseStamp = stampLibrary.value.items[0]!
    stampLibrary.value = {
      ...stampLibrary.value,
      items: [
        { ...baseStamp, id: 'stamp-1', name: 'Alpha guild', sort_order: 0 },
        { ...baseStamp, id: 'stamp-2', name: 'Berry guild', sort_order: 1 },
        { ...baseStamp, id: 'stamp-3', name: 'Canopy guild', sort_order: 2 },
      ],
    }

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    installSavedStampRowRects(container)
    const visibleNames = () => [...container.querySelectorAll<HTMLElement>('[data-saved-stamp-row]')]
      .map((row) => row.textContent ?? '')
    const sourceGrip = container.querySelector<HTMLElement>(
      '[data-saved-stamp-row="stamp-1"] [data-saved-stamp-grip]',
    )
    expect(sourceGrip).toBeTruthy()
    preparePointerGrip(sourceGrip!)

    await act(async () => {
      sourceGrip!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 7,
        clientY: 110,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 7,
        clientY: 152,
      }))
      sourceGrip!.dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true,
        pointerId: 7,
      }))
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 7,
        clientY: 252,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).not.toHaveBeenCalled()
    expect(visibleNames()[0]).toContain('Berry guild')
    expect(visibleNames()[1]).toContain('Canopy guild')
    expect(visibleNames()[2]).toContain('Alpha guild')

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 7,
        clientY: 252,
      }))
      await flushEffects()
    })

    expect(reorderStampMock).toHaveBeenCalledTimes(1)
    expect(reorderStampMock).toHaveBeenCalledWith(['stamp-2', 'stamp-3', 'stamp-1'])
  })

  it('shows a clamped visual-only thumbnail from row-body hover and Place focus', async () => {
    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const main = container.querySelector<HTMLElement>('[data-favorites-main]')
    const body = container.querySelector<HTMLElement>('[data-saved-stamp-body="stamp-1"]')
    const placeButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Place stamp "]')
    const exportButton = container.querySelector<HTMLButtonElement>('button[aria-label^="More actions for "]')
    expect(main).toBeTruthy()
    expect(body).toBeTruthy()
    expect(placeButton).toBeTruthy()
    expect(exportButton).toBeTruthy()
    if (!main || !body || !placeButton || !exportButton) return

    main.getBoundingClientRect = () => elementRect({ left: 260, top: 36, width: 280, height: 520 })
    body.getBoundingClientRect = () => elementRect({ left: 280, top: 520, width: 220, height: 36 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    vi.useFakeTimers()

    try {
      await act(async () => {
        body.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
        vi.advanceTimersByTime(119)
      })
      expect(container.querySelector('[data-saved-stamp-thumbnail-overlay]')).toBeNull()

      await act(async () => {
        vi.advanceTimersByTime(1)
        await Promise.resolve()
      })

      const hoverOverlay = container.querySelector<HTMLElement>('[data-saved-stamp-thumbnail-overlay]')
      expect(hoverOverlay).toBeTruthy()
      expect(hoverOverlay?.style.width).toBe('180px')
      expect(hoverOverlay?.style.height).toBe('150px')
      expect(hoverOverlay?.style.left).toBe('72px')
      expect(hoverOverlay?.style.top).toBe('442px')
      expect(hoverOverlay?.textContent).not.toContain('Pommier')
      expect(hoverOverlay?.textContent).not.toContain('2 plants')

      await act(async () => {
        body.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-saved-stamp-thumbnail-overlay]')).toBeNull()

      await act(async () => {
        placeButton.dispatchEvent(new FocusEvent('focusin', { bubbles: false }))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-saved-stamp-thumbnail-overlay]')).toBeTruthy()

      await act(async () => {
        placeButton.dispatchEvent(new FocusEvent('focusout', { bubbles: false }))
        exportButton.dispatchEvent(new FocusEvent('focusin', { bubbles: false }))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-saved-stamp-thumbnail-overlay]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('previews Saved Stamps frame resize and commits the preference when dragging ends', async () => {
    savedStampsFrameHeight.value = 240

    await act(async () => {
      render(<FavoritesPanel />, container)
      await flushEffects()
    })

    const main = container.querySelector<HTMLElement>('[data-favorites-main]')
    const frame = container.querySelector<HTMLElement>('[data-saved-stamps-frame]')
    const handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-orientation="horizontal"]',
    )

    expect(main).toBeTruthy()
    expect(frame).toBeTruthy()
    expect(handle).toBeTruthy()
    if (!main || !frame || !handle) return

    main.getBoundingClientRect = () => ({
      width: 320,
      height: 520,
      top: 0,
      right: 320,
      bottom: 520,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    })

    expect(frame.style.height).toBe('240px')

    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientY: 300,
      }))
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientY: 250,
      }))
    })

    expect(frame.style.height).toBe('290px')
    expect(savedStampsFrameHeight.value).toBe(240)

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        clientY: 250,
      }))
    })

    expect(savedStampsFrameHeight.value).toBe(290)
  })

  it('clamps the Saved Stamps frame to leave room for plant favorites', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = []
      constructor(readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this)
      }
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    }
    ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = FakeResizeObserver as typeof ResizeObserver
    savedStampsFrameHeight.value = 280

    try {
      await act(async () => {
        render(<FavoritesPanel />, container)
        await flushEffects()
      })

      const main = container.querySelector<HTMLElement>('[data-favorites-main]')
      const frame = container.querySelector<HTMLElement>('[data-saved-stamps-frame]')
      const handle = container.querySelector<HTMLElement>(
        '[role="separator"][aria-orientation="horizontal"]',
      )
      expect(main).toBeTruthy()
      expect(frame).toBeTruthy()
      expect(handle).toBeTruthy()
      expect(FakeResizeObserver.instances).toHaveLength(1)
      if (!main || !frame || !handle) throw new Error('Favorites panel frames were not rendered')

      main.getBoundingClientRect = () => ({
        width: 320,
        height: 360,
        top: 0,
        right: 320,
        bottom: 360,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      const header = main.firstElementChild as HTMLElement
      header.getBoundingClientRect = () => elementRect({ height: 40 })
      handle.getBoundingClientRect = () => elementRect({ height: 8 })

      await act(async () => {
        FakeResizeObserver.instances[0]!.callback([], {} as ResizeObserver)
        await flushEffects()
      })

      expect(frame.style.height).toBe('192px')
      expect(savedStampsFrameHeight.value).toBe(280)
    } finally {
      ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = originalResizeObserver
    }
  })
})

async function openStampActions() {
  if (document.querySelector('[role="menu"]')) return
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label^="More actions for "]')!.click()
  })
}

function otherDesign(): CanopiFile {
  return {
    version: 9,
    name: 'Other',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-12T00:00:00.000Z',
    updated_at: '2026-04-12T00:00:00.000Z',
    extra: {},
  }
}
