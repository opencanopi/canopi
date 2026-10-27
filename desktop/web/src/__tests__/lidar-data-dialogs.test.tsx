// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItemSummary, LibrarySnapshot } from '../generated/contracts'
import { librarySnapshot, slopeItem, sourceItem } from './support/library-fixtures'

const actions = vi.hoisted(() => ({
  addToDesign: vi.fn(),
  runAnalysis: vi.fn().mockResolvedValue({ definition_id: 'adef-new', job_id: 'job', item_ids: ['new'] }),
  rerunAnalysis: vi.fn().mockResolvedValue({ definition_id: 'adef', job_id: 'job', item_ids: [] }),
  cancelAnalysisJob: vi.fn().mockResolvedValue(true),
  fetchProcessingHistory: vi.fn().mockResolvedValue({ definition_id: 'def', runs: [], next_cursor: null }),
  cancelLibraryImport: vi.fn().mockResolvedValue(undefined),
  chooseImportFiles: vi.fn(),
  deleteLibraryItem: vi.fn().mockResolvedValue(undefined),
  dismissLibraryImport: vi.fn().mockResolvedValue(undefined),
  fetchDeleteImpact: vi.fn(),
  fetchLibraryDiskUsage: vi.fn().mockResolvedValue(1_240_000_000),
  fetchItemSources: vi.fn().mockResolvedValue({ sources: [] }),
  importLibraryItem: vi.fn().mockResolvedValue({ layer_id: 'new', job_id: 'job' }),
  renameLibraryItem: vi.fn().mockResolvedValue(undefined),
  retryLibraryImport: vi.fn().mockResolvedValue(undefined),
  showDataLibraryFolder: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../app/shell/modal-layer', () => ({
  holdModalLayer: () => () => {},
  registerModalInertRegion: () => () => {},
}))

vi.mock('../app/lidar/actions', () => actions)

const coverage = vi.hoisted(() => ({ check: vi.fn().mockResolvedValue(null) }))
vi.mock('../app/lidar/import-coverage', () => ({ checkImportCoverage: coverage.check, coverageCanvas: () => null }))

vi.mock('../app/lidar/library-store', async () => {
  const { signal } = await import('@preact/signals')
  return {
    ...(await vi.importActual<typeof LibraryStoreModule>('../app/lidar/library-store')),
    installLidarLibraryObserver: () => () => {},
    lidarLibrary: signal<LibrarySnapshot | null>(null),
    lidarStatusMessage: signal<string | null>(null),
  }
})

vi.mock('../app/document-session/store', async () => {
  const { signal } = await import('@preact/signals')
  // Site data's view state (`site-data-view.ts`, real) is per Design session.
  return { currentDesign: signal<unknown>(null), designSessionStore: { sessionIdentity: signal<object>({}) } }
})


vi.mock('../components/panels/lidar/LibraryPreview', () => ({
  usePreviewClient: () => null,
  LibraryPreview: ({ item, large }: { item: { id: string }; large?: boolean }) => <span data-preview={large ? `large:${item.id}` : 'small'} />,
}))

import { DataDialogs } from '../components/panels/lidar/DataDialogs'
import { lidarLibrary } from '../app/lidar/library-store'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { analyzeItem, dataDialog, libraryView, openDataLibrary } from '../app/lidar/library-navigation'
import { siteDataViewFor } from '../app/lidar/site-data-view'
import { sidePanel } from '../app/shell/state'
import { locale } from '../app/settings/state'
import { openLayerRow } from '../app/canvas-layer-presentation/open-row'
import { dropdownTrigger } from './support/dropdown-trigger'
import { formatDiskSize } from '../components/panels/lidar/item-text'
import { hoveredTooltip } from './support/tooltip'
import type * as LibraryStoreModule from '../app/lidar/library-store'

function layer(id: string, name: string, overrides: Partial<LibraryItemSummary> = {}): LibraryItemSummary {
  return sourceItem(id, name, { resolution_m: 0.5, value_range: [1, 2], ...overrides })
}

function slope(id: string, source: string, overrides: Partial<LibraryItemSummary> = {}): LibraryItemSummary {
  return slopeItem(id, source, { value_range: [0, 30], ...overrides })
}

function library(layers: LibraryItemSummary[], analyses: LibraryItemSummary[] = []): LibrarySnapshot {
  return librarySnapshot([...layers, ...analyses])
}

function design(entries: { kind: 'Source' | 'Derived'; id: string }[]) {
  return {
    lidar: {
      visible: true,
      entries: entries.map((entry, order) => ({ ...entry, name: entry.id, order, visible: true, opacity: 1, ramp: null, reversed: false, range: null })),
    },
  }
}

let container: HTMLDivElement

/** The item Site data shows open (the real `showInSiteData` writes it). */
function siteDataOpenItem(): string | null {
  return siteDataViewFor(designSessionStore.sessionIdentity.peek()).openItem.value
}

function setDesign(value: unknown): void {
  (currentDesign as unknown as { value: unknown }).value = value
}

function button(text: string | RegExp): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((candidate) => {
    const label = `${candidate.textContent ?? ''} ${candidate.getAttribute('aria-label') ?? ''}`.trim()
    return typeof text === 'string' ? label.includes(text) : text.test(label)
  })
  if (!found) throw new Error(`no button ${String(text)}`)
  return found
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function chooseFrom(label: string, option: string): Promise<void> {
  const trigger = dropdownTrigger(container, label)
  if (!trigger) throw new Error(`no ${label} dropdown`)
  await click(trigger)
  const item = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find((candidate) => candidate.textContent === option)
  if (!item) throw new Error(`no ${option} option`)
  await click(item)
}

function mount(): void {
  act(() => {
    openDataLibrary()
    render(<DataDialogs />, container)
  })
}

/** The library row named `name`. */
function rowNamed(name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((candidate) => candidate.querySelector('strong')?.textContent === name)
  if (!row) throw new Error(`no row ${name}`)
  return row
}

/** Selects the library row named `name`; its details and actions show beside the list. */
async function selectRow(name: string): Promise<void> {
  await click(rowNamed(name))
}

async function focusItem(id: string): Promise<void> {
  await act(async () => { openDataLibrary(id) })
}

function selectedName(): string | null | undefined {
  return container.querySelector('[role="option"][aria-selected="true"] strong')?.textContent
}

function detailsHeading(): string | null | undefined {
  return container.querySelector('section[aria-labelledby] h3')?.textContent
}

async function key(target: Element, name: string, options: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }))
  })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function title(): string | null | undefined {
  return container.querySelector('h2')?.textContent
}

describe('Data library, Import and Analyze dialogs', () => {
  beforeEach(() => {
    locale.value = 'en'
    vi.clearAllMocks()
    lidarLibrary.value = library([])
    setDesign(design([]))
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    vi.useRealTimers()
    render(null, container)
    container.remove()
    dataDialog.value = null
    libraryView.value = null
    openLayerRow.value = null
    siteDataViewFor(designSessionStore.sessionIdentity.peek()).openItem.value = null
    sidePanel.value = null
  })

  describe('the Data library sheet', () => {
    it('selects the first row on open, and ↑ and ↓ move the selection and focus', async () => {
      lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta'), layer('c', 'Gamma')])
      mount()
      expect(selectedName()).toBe('Alpha')
      expect(detailsHeading()).toBe('Alpha')
      const list = container.querySelector('[role="listbox"]')!
      // One tab stop: the selected row.
      expect(Array.from(list.querySelectorAll('[role="option"]')).map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
      await key(rowNamed('Alpha'), 'ArrowDown')
      expect(selectedName()).toBe('Beta')
      expect(document.activeElement).toBe(rowNamed('Beta'))
      await key(rowNamed('Beta'), 'End')
      expect(selectedName()).toBe('Gamma')
      await key(rowNamed('Gamma'), 'ArrowUp')
      expect(selectedName()).toBe('Beta')
      expect(detailsHeading()).toBe('Beta')
    })

    it('opens on the item it was asked for', async () => {
      lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta')])
      act(() => {
        openDataLibrary('b')
        render(<DataDialogs />, container)
      })
      expect(selectedName()).toBe('Beta')
    })

    it('keeps the item it was asked for until the library has loaded', async () => {
      lidarLibrary.value = null
      act(() => {
        openDataLibrary('b')
        render(<DataDialogs />, container)
      })
      await act(async () => { lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta')]) })
      expect(selectedName()).toBe('Beta')
      // Below 760 px the sheet shows one pane: the item asked for opens on its details, not on the list.
      expect(container.querySelector('[data-pane]')?.getAttribute('data-pane')).toBe('details')
    })

    it('scrolls the selected row into the list when the sheet opens on it or a search moves the selection', async () => {
      const scrolled: string[] = []
      const original = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
        if (this.getAttribute('role') === 'option' && typeof options === 'object' && options.block === 'nearest') {
          scrolled.push(this.querySelector('strong')?.textContent ?? '')
        }
      }
      try {
        lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta'), layer('c', 'Gamma')])
        act(() => {
          openDataLibrary('c')
          render(<DataDialogs />, container)
        })
        expect(scrolled).toEqual(['Gamma'])
        await type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'Be')
        expect(selectedName()).toBe('Beta')
        expect(scrolled).toEqual(['Gamma', 'Beta'])
      } finally {
        Element.prototype.scrollIntoView = original
      }
    })

    it('selects the row that took its place when the selected item leaves the library', async () => {
      lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta'), layer('c', 'Gamma')])
      mount()
      await selectRow('Beta')
      await act(async () => { lidarLibrary.value = library([layer('a', 'Alpha'), layer('c', 'Gamma')]) })
      expect(selectedName()).toBe('Gamma')
    })

    it('sorts by name or most recently added, keeping results under their source', async () => {
      lidarLibrary.value = library(
        [layer('old', 'Alpha', { created_at: '1000' }), layer('new', 'Beta', { created_at: '3000' })],
        [slope('s', 'old', { name: 'Steepness', created_at: '2000' })],
      )
      mount()
      const names = () => Array.from(container.querySelectorAll('[role="option"] strong')).map((node) => node.textContent)
      expect(names()).toEqual(['Alpha', 'Steepness', 'Beta'])
      expect(dropdownTrigger(container, 'Sort')?.textContent).toContain('Name')
      await chooseFrom('Sort', 'Recently added')
      expect(names()).toEqual(['Beta', 'Alpha', 'Steepness'])
    })

    it('measures the library on disk again when its items change, not when the order does', async () => {
      lidarLibrary.value = library([layer('old', 'Alpha', { created_at: '1000' }), layer('new', 'Beta', { created_at: '3000' })])
      mount()
      await act(async () => { await Promise.resolve() })
      expect(actions.fetchLibraryDiskUsage).toHaveBeenCalledOnce()
      await chooseFrom('Sort', 'Recently added')
      await chooseFrom('Sort', 'Name')
      await act(async () => { locale.value = 'fr' })
      expect(actions.fetchLibraryDiskUsage).toHaveBeenCalledOnce()
      await act(async () => {
        lidarLibrary.value = library([layer('old', 'Alpha', { created_at: '1000' }), layer('new', 'Beta', { created_at: '3000' }), layer('c', 'Gamma')])
      })
      expect(actions.fetchLibraryDiskUsage).toHaveBeenCalledTimes(2)
    })

    it('keeps a matching result\'s source in the list while searching', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')], [slope('s', 'a', { name: 'Steepness' })])
      mount()
      await type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'steep')
      expect(Array.from(container.querySelectorAll('[role="option"] strong')).map((node) => node.textContent)).toEqual(['Ground', 'Steepness'])
    })

    it('starts the selection\'s fetches once it has rested for 120 ms', async () => {
      vi.useFakeTimers()
      lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta'), layer('c', 'Gamma'), layer('d', 'Delta')])
      mount()
      await act(async () => { vi.advanceTimersByTime(120) })
      expect(actions.fetchItemSources.mock.calls.map(([id]) => id)).toEqual(['a'])
      actions.fetchItemSources.mockClear()
      // Holding ↓ over three rows, 40 ms apart, fetches only for the row it rests on.
      for (const name of ['Alpha', 'Beta', 'Delta']) {
        await key(rowNamed(name), 'ArrowDown')
        await act(async () => { vi.advanceTimersByTime(40) })
      }
      expect(actions.fetchItemSources).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(120) })
      expect(actions.fetchItemSources.mock.calls.map(([id]) => id)).toEqual(['c'])
    })

    it('renders the details\' large preview only once the selection has rested', async () => {
      vi.useFakeTimers()
      lidarLibrary.value = library([layer('a', 'Alpha'), layer('b', 'Beta'), layer('c', 'Gamma')])
      mount()
      const large = () => Array.from(container.querySelectorAll('[data-preview^="large:"]')).map((node) => node.getAttribute('data-preview'))
      await act(async () => { vi.advanceTimersByTime(120) })
      expect(large()).toEqual(['large:a'])
      // Each row passed while ↓ is held would start a full-size worker render the row's departure never cancels.
      await key(rowNamed('Alpha'), 'ArrowDown')
      expect(large()).toEqual([])
      await act(async () => { vi.advanceTimersByTime(40) })
      await key(rowNamed('Beta'), 'ArrowDown')
      expect(large()).toEqual([])
      await act(async () => { vi.advanceTimersByTime(120) })
      expect(large()).toEqual(['large:c'])
    })

    it('counts the library, says its size on this computer and shows its folder, with no Done', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')])
      mount()
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector('footer')?.textContent).toContain('2 items · 1.2 GB on this computer')
      expect(() => button(/^Done$/)).toThrow()
      await click(button(/^Show in folder$/))
      expect(actions.showDataLibraryFolder).toHaveBeenCalledOnce()
    })

    it('says when an item was added', () => {
      lidarLibrary.value = library([layer('a', 'Ground', { created_at: String(Date.UTC(2026, 8, 11, 9, 30)) })])
      mount()
      const facts = container.querySelector('dl')!.textContent
      expect(facts).toMatch(/Added.*2026/)
    })

    it('adds a ready item to the Design, and shows an item the Design has in Site data', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')])
      setDesign(design([{ kind: 'Source', id: 'a' }, { kind: 'Source', id: 'b' }]))
      // Layers keeps its own open row (Zones' settings); Show in Site data leaves it.
      openLayerRow.value = 'zones'
      mount()
      // The rows already show how many items there are; the header carries no bare count.
      expect(container.querySelector('header')?.textContent).not.toMatch(/\d/)
      expect(rowNamed('Canopy').textContent).toContain('In this Design')

      await selectRow('Canopy')
      expect(() => button('Add Canopy to this Design')).toThrow()
      await click(button(/^Show in Site data$/))
      expect(libraryView.value).toBeNull()
      expect(sidePanel.value).toBe('site-data')
      expect(siteDataOpenItem()).toBe('b')
      expect(openLayerRow.value).toBe('zones')
      setDesign(design([{ kind: 'Source', id: 'b' }]))

      act(() => { openDataLibrary() })
      await selectRow('Ground')
      await click(button('Add Ground to this Design'))
      expect(actions.addToDesign).toHaveBeenCalledWith('Source', 'a')
    })

    it('renames in place, and Esc cancels only the rename', async () => {
      lidarLibrary.value = library([layer('a', 'Elevation'), layer('b', 'Terrain')])
      mount()
      await selectRow('Terrain')
      await click(button(/^Rename…$/))
      const name = container.querySelector<HTMLInputElement>('section[aria-labelledby] form input')!
      expect(document.activeElement).toBe(name)
      await type(name, 'elevation')
      expect(container.textContent).toContain('already has data named “elevation”')
      expect(button('Save name').disabled).toBe(true)
      await key(name, 'Escape')
      expect(libraryView.value).not.toBeNull()
      expect(container.querySelector('section[aria-labelledby] form')).toBeNull()
      expect(detailsHeading()).toBe('Terrain')

      await click(button(/^Rename…$/))
      await type(container.querySelector<HTMLInputElement>('section[aria-labelledby] form input')!, 'Terrain model')
      await act(async () => {
        container.querySelector('section[aria-labelledby] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(actions.renameLibraryItem).toHaveBeenCalledWith('b', 'Terrain model')
    })

    // Esc pressed as soon as Rename… or Delete everywhere renders its form, before the browser paints (a busy machine,
    // or WebKit under load: canopi-kprb), reaches the form: the trigger it replaced has gone, so focus must already be
    // inside the form when the render commits, not one frame later.
    it.each([
      { trigger: /^Rename…$/, open: 'section[aria-labelledby] form' },
      { trigger: /^Delete everywhere$/, open: '[role="group"][aria-labelledby="library-delete-title"]' },
    ])('Esc right after $trigger opens, before a paint, cancels only it', async ({ trigger, open }) => {
      lidarLibrary.value = library([layer('a', 'Elevation'), layer('b', 'Terrain')])
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      mount()
      await selectRow('Terrain')
      button(trigger).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Preact renders on a microtask; effects that wait for a paint have not run yet.
      await Promise.resolve()
      expect(container.querySelector(open)).not.toBeNull()
      ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await act(async () => {})
      expect(libraryView.value, 'the sheet stays open').not.toBeNull()
      expect(container.querySelector(open), 'Esc cancelled it').toBeNull()
      expect(document.activeElement).toBe(button(trigger))
    })

    it('confirms Delete everywhere in place of the actions', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', { name: 'Steepness' })])
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      mount()
      await selectRow('Steepness')
      await click(button(/^Delete everywhere$/))
      // The library does not know which other Designs use an item, and says so.
      expect(container.textContent).toContain('Canopi doesn’t keep track of which other Designs use it.')
      expect(() => button(/^Rename…$/)).not.toThrow()
      await click(button(/^Keep$/))
      expect(actions.deleteLibraryItem).not.toHaveBeenCalled()
      await click(button(/^Delete everywhere$/))
      await click(button(/^Delete everywhere$/))
      expect(actions.deleteLibraryItem).toHaveBeenCalledWith('s')
    })

    it('refuses to delete an item other results use, and lists those results as links', async () => {
      lidarLibrary.value = library([layer('a', 'Ground', { dependents: 1 }), layer('b', 'Canopy')], [slope('s', 'a', { name: 'Steepness' })])
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: ['s'] })
      mount()
      await selectRow('Ground')
      const facts = container.querySelector('dl')!
      expect(facts.textContent).toContain('Saved results')
      await click(button(/^Delete everywhere$/))
      await act(async () => { await Promise.resolve() })
      expect(container.textContent).toContain('Saved results depend on this data (1)')
      expect(Array.from(container.querySelectorAll('section[aria-labelledby] button')).some((node) => node.textContent === 'Delete everywhere')).toBe(false)
      await click(button(/^Keep$/))
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>('dl button')).find((node) => node.textContent === 'Steepness')!)
      expect(selectedName()).toBe('Steepness')
      expect(actions.deleteLibraryItem).not.toHaveBeenCalled()
    })

    it('follows a result link to an item the type filter hides, clearing the filter', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')], [slope('s', 'a', { name: 'Steepness' })])
      mount()
      await chooseFrom('Type', 'Imported data')
      await selectRow('Ground')
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>('dl button')).find((node) => node.textContent === 'Steepness')!)
      expect(selectedName()).toBe('Steepness')
      expect(detailsHeading()).toBe('Steepness')
      expect(dropdownTrigger(container, 'Type')?.textContent).toContain('All')
      // Focus follows the link to the details it opened.
      expect(document.activeElement).toBe(container.querySelector('section[aria-labelledby] h3'))
    })

    it('closes Rename and Delete everywhere when a search moves the selection to another item', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Hedge DSM')])
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      mount()
      await selectRow('Ground')
      await click(button(/^Rename…$/))
      await type(container.querySelector<HTMLInputElement>('section[aria-labelledby] form input')!, 'Bare earth')
      const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
      await type(search, 'hedge')
      expect(detailsHeading()).toBe('Hedge DSM')
      expect(container.querySelector('section[aria-labelledby] form')).toBeNull()

      await type(search, '')
      await selectRow('Ground')
      await click(button(/^Delete everywhere$/))
      await type(search, 'hedge')
      expect(container.querySelector('#library-delete-title')).toBeNull()
      await type(search, '')
      expect(detailsHeading()).toBe('Hedge DSM')
      expect(container.querySelector('#library-delete-title')).toBeNull()
    })

    it('shows the list pane, with No match, when a search leaves nothing selected in the details pane', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')])
      await act(async () => {
        openDataLibrary('a')
        render(<DataDialogs />, container)
      })
      expect(container.querySelector('[data-pane]')?.getAttribute('data-pane')).toBe('details')
      await type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'zzz')
      expect(container.querySelector('[data-pane]')?.getAttribute('data-pane')).toBe('list')
      expect(container.textContent).toContain('No data matches this search.')
      // Clearing the search keeps the list the user was looking at.
      await click(button('Clear search and filters'))
      expect(container.querySelector('[data-pane]')?.getAttribute('data-pane')).toBe('list')
    })

    it('Esc backs out of Delete everywhere only, never the sheet', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')])
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      mount()
      await selectRow('Canopy')
      await click(button(/^Delete everywhere$/))
      expect(document.activeElement?.id).toBe('library-delete-title')
      await key(document.activeElement!, 'Escape')
      expect(libraryView.value).not.toBeNull()
      expect(container.querySelector('[role="group"][aria-labelledby="library-delete-title"]')).toBeNull()
      expect(selectedName()).toBe('Canopy')
      expect(document.activeElement).toBe(button(/^Delete everywhere$/))
      expect(actions.deleteLibraryItem).not.toHaveBeenCalled()
    })

    it('keeps focus in the sheet when Rename, Delete everywhere or a pane closes under it', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')])
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      mount()
      await selectRow('Ground')
      // A row opens the details pane; below 760 px only Back is shown there.
      expect(document.activeElement?.textContent).toContain('Back')
      await click(button(/Back$/))
      expect(document.activeElement).toBe(rowNamed('Ground'))

      await click(button(/^Rename…$/))
      await key(container.querySelector('section[aria-labelledby] form input')!, 'Escape')
      expect(document.activeElement).toBe(button(/^Rename…$/))
      await click(button(/^Rename…$/))
      await click(button(/^Cancel$/))
      expect(document.activeElement).toBe(button(/^Rename…$/))

      await click(button(/^Delete everywhere$/))
      await click(button(/^Keep$/))
      expect(document.activeElement).toBe(button(/^Delete everywhere$/))

      // After a deletion, the row that took the item's place.
      actions.deleteLibraryItem.mockImplementationOnce(async () => { lidarLibrary.value = library([layer('b', 'Canopy')]) })
      await click(button(/^Delete everywhere$/))
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button')).find((node) => node.textContent === 'Delete everywhere')!)
      expect(selectedName()).toBe('Canopy')
      expect(document.activeElement).toBe(rowNamed('Canopy'))
    })

    it('keeps focus in the sheet when a deletion leaves no row to select', async () => {
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      const confirmDelete = async () => {
        await click(button(/^Delete everywhere$/))
        await click(Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button')).find((node) => node.textContent === 'Delete everywhere')!)
      }

      // A search that matched only the deleted item: the search field, with No match below it.
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')])
      mount()
      const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
      await type(search, 'ground')
      await selectRow('Ground')
      actions.deleteLibraryItem.mockImplementationOnce(async () => { lidarLibrary.value = library([layer('b', 'Canopy')]) })
      await confirmDelete()
      expect(container.textContent).toContain('No data matches this search.')
      expect(document.activeElement).toBe(search)

      // The last item in the library: the empty library's Import…, and Esc still closes the sheet.
      await type(search, '')
      await selectRow('Canopy')
      actions.deleteLibraryItem.mockImplementationOnce(async () => { lidarLibrary.value = library([]) })
      await confirmDelete()
      expect(document.activeElement).toBe(button('Import'))
      await key(document.activeElement!, 'Escape')
      expect(libraryView.value).toBeNull()
    })

    it('keeps focus in the sheet when the last item goes with no Design open to import into', async () => {
      setDesign(null)
      actions.fetchDeleteImpact.mockResolvedValue({ dependent_item_ids: [] })
      lidarLibrary.value = library([layer('a', 'Ground')])
      mount()
      await selectRow('Ground')
      actions.deleteLibraryItem.mockImplementationOnce(async () => { lidarLibrary.value = library([]) })
      await click(button(/^Delete everywhere$/))
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button')).find((node) => node.textContent === 'Delete everywhere')!)
      expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
      await key(document.activeElement!, 'Escape')
      expect(libraryView.value).toBeNull()
    })

    it('gives focus back to the sheet when what opened a dialog over it is gone', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')])
      mount()
      const opener = document.createElement('button')
      document.body.append(opener)
      opener.focus()
      act(() => { dataDialog.value = { kind: 'import', paths: ['/data/tile.tif'] } })
      opener.remove()
      await act(async () => { dataDialog.value = null })
      expect(document.activeElement).toBe(rowNamed('Ground'))
    })

    it('names an input that left the library Deleted item', () => {
      lidarLibrary.value = library([], [slope('s', 'gone', { name: 'Orphan' })])
      mount()
      expect(container.querySelector('dl')!.textContent).toContain('Calculated fromDeleted item')
    })

    it('opens Run again with changes over the library, which comes back with its search and selection', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')], [slope('s', 'a', { name: 'Steepness' })])
      mount()
      await type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'steep')
      await selectRow('Steepness')
      await click(button(/^Run again with changes…$/))
      expect(dataDialog.value).toEqual({ kind: 'analyze', itemId: 'a', analysisId: 'terrain.slope', from: 's' })
      expect(container.querySelector('[data-library-sheet]')?.hasAttribute('inert')).toBe(true)
      expect(Array.from(container.querySelectorAll('h2')).map((node) => node.textContent)).toEqual(['Data library', 'Analyze'])
      expect(container.querySelector('[data-analysis-source]')?.textContent).toBe('SourceGround')
      await click(button(/^Cancel$/))
      expect(dataDialog.value).toBeNull()
      expect(container.querySelector('[data-library-sheet]')?.hasAttribute('inert')).toBe(false)
      expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('steep')
      expect(selectedName()).toBe('Steepness')
    })

    it('says results stay in the library when Run again with changes starts from an input this Design does not show', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', { name: 'Steepness' })])
      mount()
      await selectRow('Steepness')
      await click(button(/^Run again with changes…$/))
      expect(container.textContent).toContain('Results are kept in your library. This Design doesn’t show their source, so they aren’t added to Site data.')
      expect(container.textContent).not.toContain('Results are added under their source in Site data')
    })

    it('offers Import only in the empty library, disabled with the reason when no Design is open', async () => {
      setDesign(null)
      mount()
      expect(container.textContent).toContain('No data yet')
      const importButton = button(/^Import…/)
      expect(importButton.disabled).toBe(true)
      expect(hoveredTooltip(importButton)?.textContent).toBe('Open a Design to import data')

      setDesign(design([]))
      render(null, container)
      mount()
      actions.chooseImportFiles.mockResolvedValue(null)
      await click(button(/^Import…/))
      expect(actions.chooseImportFiles).toHaveBeenCalledTimes(1)
      expect(actions.importLibraryItem).not.toHaveBeenCalled()
      expect(libraryView.value).not.toBeNull()
    })

    it('offers no Import, Analyze or row menu once the library has items', () => {
      lidarLibrary.value = library([layer('a', 'Ground')])
      mount()
      expect(() => button(/^Import…/)).toThrow()
      expect(() => button(/^Analyze…/)).toThrow()
      expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull()
    })

    it('offers Retry and Dismiss for a failed import', async () => {
      lidarLibrary.value = library([layer('x', 'Broken', {
        generation_id: null, state: 'Failed',
        import_job: { job_id: 'job-x', layer_id: 'x', state: 'Failed', message: 'unreadable file', progress: null },
      })])
      mount()

      expect(container.textContent).toContain('Import failed')
      await click(button('Retry'))
      await click(button('Dismiss'))
      expect(actions.retryLibraryImport).toHaveBeenCalledWith('x')
      expect(actions.dismissLibraryImport).toHaveBeenCalledWith('x')
    })

    it('words a failed import row as Import failed, never the engine text stored on its job', () => {
      lidarLibrary.value = library([layer('x', 'Broken', {
        generation_id: null, state: 'Failed',
        import_job: { job_id: 'job-x', layer_id: 'x', state: 'Failed', message: 'TIFF read error: strip 3 is truncated', progress: null },
      })])
      mount()
      expect(container.textContent).toContain('Import failed')
      expect(container.textContent).not.toContain('truncated')
      expect(button('Retry')).toBeTruthy()
    })

    it('nests results under the data they were calculated from', () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Canopy')], [slope('s', 'a')])
      mount()
      const rows = Array.from(container.querySelectorAll('[role="option"]')).map((row) => [row.querySelector('strong')?.textContent, (row as HTMLElement).dataset.nested])
      expect(rows).toEqual([['Canopy', 'false'], ['Ground', 'false'], ['Ground · Slope', 'true']])
    })

    it('filters by analysis group from the registry', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a')])
      mount()
      expect(container.querySelector('select')).toBeNull()
      await click(dropdownTrigger(container, 'Type')!)
      expect(Array.from(container.querySelectorAll('[role="listbox"]:not([aria-label="Data library"]) [role="option"]')).map((option) => option.textContent))
        .toEqual(['All types', 'Imported data', 'Terrain'])
      await click(dropdownTrigger(container, 'Type')!)
      await chooseFrom('Type', 'Terrain')
      expect(dropdownTrigger(container, 'Type')?.textContent).toContain('Terrain')
      // The result's source stays above it.
      expect(Array.from(container.querySelectorAll('[role="option"] strong')).map((node) => node.textContent)).toEqual(['Ground', 'Ground · Slope'])
    })

    it('retries a failed calculation by rerunning its definition', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', {
        generation_id: null, state: 'Failed', name: 'Steepness', run: { job_id: 'j', state: 'Failed', message: 'engine stopped' },
      })])
      mount()
      await focusItem('s')

      expect(detailsHeading()).toBe('Steepness')
      expect(container.textContent).toContain('Calculation failed')
      expect(container.textContent).not.toContain('engine stopped')
      await click(button(/^Retry$/))
      expect(actions.rerunAnalysis).toHaveBeenCalledWith('s-def')
    })

    it('describes a result by its provenance, whose input selects it', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('new', 'a', { name: 'New' })])
      mount()
      await focusItem('new')
      const facts = container.querySelector('dl')!.textContent
      expect(facts).toContain('AnalysisSlope · Version 1')
      expect(facts).toContain('UnitDegrees')
      expect(facts).toContain('Calculated fromGround')
      expect(facts).toContain('geolibre-cli 1.5.3 (aac2b7439786)')
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>('dl button')).find((node) => node.textContent === 'Ground')!)
      expect(detailsHeading()).toBe('Ground')
    })

    it('marks an out-of-date result with its reasons and refreshes it', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', {
        name: 'Steepness',
        freshness: { state: 'Stale', reasons: [
          { reason: 'InputUpdated', input_key: 'dem', item_id: 'a' },
          { reason: 'ToolUpdated', from: 'geolibre-cli 1.5.2', to: 'geolibre-cli 1.5.3' },
        ] },
      })])
      mount()
      expect(rowNamed('Steepness').textContent).toContain('Out of date')
      await selectRow('Steepness')
      expect(container.textContent).toContain('Ground has changed since this was calculated.')
      expect(container.textContent).toContain('A different engine build is installed (geolibre-cli 1.5.3).')
      await click(button('Refresh Steepness'))
      expect(actions.rerunAnalysis).toHaveBeenCalledWith('s-def')
    })

    it('shows processing history with a result and pages it', async () => {
      const run = (job: string) => ({
        job_id: job, state: 'Complete' as const, message: null, recipe_version: 1, tool: null, inputs: [],
        created_at: '1790000000000', finished_at: null, outputs: [{ item_id: 's', generation_id: 'g', coverage_cells: '1200' }],
      })
      actions.fetchProcessingHistory
        .mockResolvedValueOnce({ definition_id: 's-def', runs: [run('j2')], next_cursor: 'c1' })
        .mockResolvedValueOnce({ definition_id: 's-def', runs: [{ ...run('j1'), state: 'Failed', message: 'engine stopped', outputs: [] }], next_cursor: null })
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', { name: 'Steepness' })])
      act(() => {
        openDataLibrary('s')
        render(<DataDialogs />, container)
      })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)) })
      await act(async () => {})
      expect(actions.fetchProcessingHistory).toHaveBeenCalledWith('s-def', null)
      const history = container.querySelector('section[aria-label="Processing history"]')!
      expect(history.textContent).toContain('Completed')
      expect(history.textContent).toContain('1,200 cells published')
      await act(async () => {})

      await click(button('Show more'))
      await act(async () => {})
      expect(actions.fetchProcessingHistory).toHaveBeenLastCalledWith('s-def', 'c1')
      expect(history.querySelectorAll('li')).toHaveLength(2)
      expect(history.textContent).toContain('Failed')
      expect(history.textContent).not.toContain('engine stopped')
      expect(history.textContent).toContain('Nothing published')
      expect(() => button('Show more')).toThrow()
    })

    it('words a cancelled run in history by its state, never the text its job stored', async () => {
      const run = (job: string, state: 'Cancelled' | 'Failed', message: string) => ({
        job_id: job, state, message, recipe_version: 1, tool: null, inputs: [],
        created_at: '1790000000000', finished_at: null, outputs: [],
      })
      locale.value = 'fr'
      actions.fetchProcessingHistory.mockResolvedValueOnce({
        definition_id: 's-def', runs: [run('j2', 'Cancelled', 'analysis cancelled'), run('j1', 'Failed', 'engine stopped')], next_cursor: null,
      })
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', { name: 'Steepness' })])
      act(() => {
        openDataLibrary('s')
        render(<DataDialogs />, container)
      })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)) })
      await act(async () => {})
      const [cancelled, failed] = Array.from(container.querySelectorAll('section[aria-label="Historique des traitements"] li'))
      expect(cancelled!.textContent).toContain('Annulé')
      expect(cancelled!.textContent).not.toContain('analysis cancelled')
      expect(failed!.textContent).toContain('Échec')
    })

    it('words a failed run in history by its state alone, keeping the engine text out of it', async () => {
      locale.value = 'fr'
      actions.fetchProcessingHistory.mockResolvedValueOnce({
        definition_id: 's-def',
        runs: [{ job_id: 'j1', state: 'Failed', message: 'engine stopped', recipe_version: 1, tool: null, inputs: [], created_at: '1790000000000', finished_at: null, outputs: [] }],
        next_cursor: null,
      })
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', { name: 'Steepness' })])
      act(() => {
        openDataLibrary('s')
        render(<DataDialogs />, container)
      })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)) })
      await act(async () => {})
      const [failed] = Array.from(container.querySelectorAll('section[aria-label="Historique des traitements"] li'))
      expect(failed!.textContent).toContain('Échec')
      expect(failed!.textContent).not.toContain('engine stopped')
    })

    it('offers Cancel for a running calculation and cancels its job', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', {
        generation_id: null, state: 'Preparing', name: 'Pending', run: { job_id: 'job-1', state: 'Preparing', message: null },
      })])
      mount()
      await selectRow('Pending')
      expect(container.textContent).toContain('Calculating')
      await click(button(/^Cancel calculation$/))
      expect(actions.cancelAnalysisJob).toHaveBeenCalledWith(expect.objectContaining({ id: 's', run: expect.objectContaining({ job_id: 'job-1' }) }))
    })

    it('labels a cancelled calculation as cancelled, not failed', () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [
        slope('c', 'a', { generation_id: null, state: 'Failed', name: 'Stopped', run: { job_id: 'j', state: 'Cancelled', message: null } }),
      ])
      mount()
      const row = rowNamed('Stopped')
      expect(row.textContent).toContain('Cancelled')
      expect(row.textContent).not.toContain('Calculation failed')
    })
  })

  describe('Import', () => {
    it('requires a measurement, then imports the files in order, joining this Design', async () => {
      await act(async () => {
        dataDialog.value = { kind: 'import', paths: ['/d/tile_02.tif', '/d/tile_01.tif'] }
        render(<DataDialogs />, container)
      })

      expect(title()).toBe('Import terrain or height data')
      expect(container.textContent).toContain('Single-band GeoTIFF rasters.')
      expect(container.textContent).toContain('added to this Design when it is ready')
      const submit = button('Import 2 files')
      expect(submit.disabled).toBe(true)
      expect(container.textContent).toContain('the first file in the list wins')
      await click(button('Move tile_01.tif up'))
      expect(Array.from(container.querySelectorAll('ol li > span:first-child')).map((row) => row.textContent)).toEqual(['tile_01.tif', 'tile_02.tif'])
      expect(container.querySelector('select')).toBeNull()
      expect(dropdownTrigger(container, 'What the values measure')?.textContent).toContain('Choose a measurement')
      await chooseFrom('What the values measure', 'Ground elevation (DTM)')
      expect(submit.disabled).toBe(false)
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })

      expect(actions.importLibraryItem).toHaveBeenCalledWith(
        ['/d/tile_01.tif', '/d/tile_02.tif'], 'tile_0', 'GroundElevation', { label: null, unknown: false })
      expect(actions.addToDesign).not.toHaveBeenCalled()
      expect(dataDialog.value).toBeNull()
    })

    it('asks Other values for its units and says elevations are metres', async () => {
      await act(async () => {
        dataDialog.value = { kind: 'import', paths: ['/d/one.tif'] }
        render(<DataDialogs />, container)
      })
      await chooseFrom('What the values measure', 'Ground elevation (DTM)')
      expect(container.textContent).toContain('Values are read in metres.')
      expect(container.querySelector('input[type="checkbox"]')).toBeNull()

      await chooseFrom('What the values measure', 'Other values')
      expect(container.textContent).not.toContain('Values are read in metres.')
      expect(button('Import 1 file').disabled).toBe(true)
      const unit = Array.from(container.querySelectorAll('label'))
        .find((label) => label.textContent === 'Unit')!.querySelector('input')!
      await type(unit, ' mg/kg ')
      expect(button('Import 1 file').disabled).toBe(false)
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(actions.importLibraryItem).toHaveBeenCalledWith(['/d/one.tif'], 'one', 'OtherContinuous', { label: 'mg/kg', unknown: false })
    })

    it('says whether the chosen files cover the Design before import', async () => {
      coverage.check.mockResolvedValueOnce({ kind: 'covers', widthM: 2000, heightM: 1000 })
      await act(async () => {
        dataDialog.value = { kind: 'import', paths: ['/d/one.tif', '/d/two.tif'] }
        render(<DataDialogs />, container)
      })
      await act(async () => { await Promise.resolve() })
      expect(coverage.check).toHaveBeenCalledWith(['/d/one.tif', '/d/two.tif'])
      expect(container.textContent).toContain('Covers your site. The files span 2 km × 1 km.')

      // Removing a file checks again; files away from the Design warn.
      coverage.check.mockResolvedValueOnce({ kind: 'apart', distanceM: 12_400.4 })
      await click(button('Remove two.tif'))
      await act(async () => { await Promise.resolve() })
      expect(coverage.check).toHaveBeenLastCalledWith(['/d/one.tif'])
      const warning = container.querySelector('[data-notice-tone="warning"]')!
      expect(warning.textContent).toContain('These files don’t cover your site. They lie 12 km from this Design.')
      // The import itself stays possible.
      await chooseFrom('What the values measure', 'Ground elevation (DTM)')
      expect(button('Import 1 file').disabled).toBe(false)
    })

    it('says when the files cover only part of the Design', async () => {
      coverage.check.mockResolvedValueOnce({ kind: 'partial', widthM: 800, heightM: 450 })
      await act(async () => {
        dataDialog.value = { kind: 'import', paths: ['/d/one.tif'] }
        render(<DataDialogs />, container)
      })
      await act(async () => { await Promise.resolve() })
      expect(container.textContent).toContain('Covers part of your site. The files span 800 m × 450 m. Part of this Design lies outside the files.')
    })

    it('accepts the same file under its default name again once its import was cancelled', async () => {
      lidarLibrary.value = library([layer('one', 'one', {
        generation_id: null, state: 'Preparing',
        import_job: { job_id: 'job-one', layer_id: 'one', state: 'Staging', message: null, progress: null },
      })])
      // Cancel deletes the unpublished item, and the action reads the library again (user, 2026-10-09).
      actions.cancelLibraryImport.mockImplementationOnce(async () => { lidarLibrary.value = library([]) })
      mount()
      await selectRow('one')
      await click(button('Cancel import'))
      expect(actions.cancelLibraryImport).toHaveBeenCalledWith('job-one')

      await act(async () => { dataDialog.value = { kind: 'import', paths: ['/d/one.tif'] } })
      expect(container.querySelector<HTMLInputElement>('input[required]')!.value).toBe('one')
      await chooseFrom('What the values measure', 'Ground elevation (DTM)')
      expect(container.textContent).not.toContain('already has data named')
      expect(button('Import 1 file').disabled).toBe(false)
    })

    it('refuses a name the library already uses and suggests a free one', async () => {
      lidarLibrary.value = library([layer('a', 'Terrain')])
      act(() => {
        dataDialog.value = { kind: 'import', paths: ['/d/one.tif'] }
        render(<DataDialogs />, container)
      })
      const name = container.querySelector<HTMLInputElement>('input[required]')!
      await type(name, 'terrain')
      await chooseFrom('What the values measure', 'Ground elevation (DTM)')
      expect(container.textContent).toContain('already has data named “terrain”')
      expect(container.textContent).toContain('“terrain (2)”')
      expect(button('Import 1 file').disabled).toBe(true)
    })
  })

  describe('Analyze', () => {
    function choose(label: string): Promise<void> {
      const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .find((candidate) => candidate.closest('label')?.textContent?.includes(label))!
      return act(async () => { input.click() })
    }

    async function submit(): Promise<void> {
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
    }

    function openAnalyze(itemId: string | null, options: Parameters<typeof analyzeItem>[1] = {}): void {
      act(() => {
        analyzeItem(itemId, options)
        render(<DataDialogs />, container)
      })
    }

    it('starts from the open item and lists this Design\'s eligible items as Source, in list order', async () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Surface')], [slope('s', 'a')])
      setDesign(design([{ kind: 'Source', id: 'b' }, { kind: 'Source', id: 'a' }, { kind: 'Derived', id: 's' }]))
      openAnalyze('a')
      expect(title()).toBe('Analyze')
      expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Ground')
      await click(dropdownTrigger(container, 'Source')!)
      // Site data lists the front item (Ground, order 1) first.
      expect(Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toEqual(['Ground', 'Surface'])
    })

    it('starts from the open result\'s input, else from the first eligible item in list order', () => {
      lidarLibrary.value = library([layer('a', 'Ground'), layer('b', 'Surface')], [slope('s', 'b')])
      setDesign(design([{ kind: 'Source', id: 'b' }, { kind: 'Source', id: 'a' }, { kind: 'Derived', id: 's' }]))
      openAnalyze('s')
      expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Surface')
      render(null, container)
      openAnalyze(null)
      expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Ground')
    })

    it('opens on an item no analysis accepts and says why each cannot run', () => {
      const refused = { reason: 'WrongInput' as const, expected: [{ kind: 'Raster' as const, quantity: 'GroundElevation' as const }] }
      lidarLibrary.value = library([layer('d', 'Surface', {
        item_type: { kind: 'Raster', quantity: 'SurfaceElevation' },
        offers: [{ analysis_id: 'terrain.slope', unavailable: refused }],
      })])
      setDesign(design([{ kind: 'Source', id: 'd' }]))
      openAnalyze('d')
      expect(title()).toBe('Analyze')
      expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Surface')
      expect(container.textContent).toContain('Needs Ground elevation (DTM).')
      expect(button(/^Run$/).disabled).toBe(true)
    })

    it('opens an item no analysis accepts on the first eligible item, listing only eligible items (spec §1.10)', async () => {
      const refused = { reason: 'WrongInput' as const, expected: [{ kind: 'Raster' as const, quantity: 'GroundElevation' as const }] }
      lidarLibrary.value = library([layer('a', 'Ground'), layer('d', 'Surface', {
        item_type: { kind: 'Raster', quantity: 'SurfaceElevation' },
        offers: [{ analysis_id: 'terrain.slope', unavailable: refused }],
      })])
      setDesign(design([{ kind: 'Source', id: 'd' }, { kind: 'Source', id: 'a' }]))
      openAnalyze('d')
      expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Ground')
      expect(container.textContent).not.toContain('Needs Ground elevation (DTM).')
      await click(dropdownTrigger(container, 'Source')!)
      expect(Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toEqual(['Ground'])
    })

    it('waits for the library to load before deciding there is nothing to analyze', () => {
      lidarLibrary.value = null
      setDesign(design([{ kind: 'Source', id: 'a' }]))
      openAnalyze('a')
      expect(dataDialog.value).not.toBeNull()
      act(() => { lidarLibrary.value = library([layer('a', 'Ground')]) })
      expect(title()).toBe('Analyze')
    })

    it('closes when nothing can be analyzed, so the Data library opened next is live', () => {
      lidarLibrary.value = library([layer('a', 'Ground')])
      setDesign(design([]))
      openAnalyze(null)
      expect(dataDialog.value).toBeNull()
      act(() => { openDataLibrary() })
      expect(container.querySelector('[data-library-sheet]')?.hasAttribute('inert')).toBe(false)
    })

    it('runs slope from a source once a unit is chosen, and closes', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')])
      setDesign(design([{ kind: 'Source', id: 'a' }]))
      openAnalyze('a')
      expect(container.textContent).toContain('Results are added under their source in Site data and kept in your library.')
      const name = container.querySelector<HTMLInputElement>('form input:not([type])')!
      expect(name.value).toBe('Ground · Slope')
      await submit()
      expect(actions.runAnalysis).not.toHaveBeenCalled()
      expect(container.textContent).toContain('Choose an option.')

      await choose('Percent')
      await submit()
      expect(actions.runAnalysis).toHaveBeenCalledWith({
        analysis_id: 'terrain.slope',
        inputs: [{ key: 'dem', item_id: 'a' }],
        parameters: [{ key: 'unit', value: { Choice: 'percent' } }],
        outputs: ['slope'],
        name: 'Ground · Slope',
      })
      await act(async () => {})
      expect(dataDialog.value).toBeNull()
    })

    it('explains by name why an analysis cannot run', async () => {
      lidarLibrary.value = library([
        layer('g', 'Ground', { offers: [{ analysis_id: 'terrain.slope', unavailable: { reason: 'EngineMissing', detail: 'not installed' } }] }),
      ])
      setDesign(design([{ kind: 'Source', id: 'g' }]))
      openAnalyze('g')
      expect(container.textContent).toContain('Unavailable: the GeoLibre engine is missing. (not installed)')
      expect(button(/^Run$/).disabled).toBe(true)
      expect(actions.runAnalysis).not.toHaveBeenCalled()
    })

    it('shows a result the Design already has in Site data instead of calculating it again', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a')])
      setDesign(design([{ kind: 'Source', id: 'a' }, { kind: 'Derived', id: 's' }]))
      openLayerRow.value = 'zones'
      openAnalyze('a')
      await choose('Degrees')
      expect(container.textContent).toContain('Already in Site data.')
      await click(button('Show in Site data'))
      expect(sidePanel.value).toBe('site-data')
      expect(siteDataOpenItem()).toBe('s')
      expect(openLayerRow.value).toBe('zones')
      expect(dataDialog.value).toBeNull()
      expect(actions.runAnalysis).not.toHaveBeenCalled()
    })

    it('offers an existing library result before calculating a duplicate', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a')])
      setDesign(design([{ kind: 'Source', id: 'a' }]))
      openLayerRow.value = 'zones'
      openAnalyze('a')
      await choose('Degrees')
      expect(container.textContent).toContain('already in the library')
      await click(button('Add existing'))
      expect(actions.addToDesign).toHaveBeenCalledWith('Derived', 's')
      expect(siteDataOpenItem()).toBe('s')
      expect(openLayerRow.value).toBe('zones')
      expect(actions.runAnalysis).not.toHaveBeenCalled()
    })

    it('runs a result again with changes as a new analysis prefilled from its provenance', async () => {
      lidarLibrary.value = library([layer('a', 'Ground')], [slope('s', 'a', { name: 'Steepness' })])
      mount()
      await selectRow('Steepness')
      await click(button(/^Run again with changes…$/))

      expect(Array.from(container.querySelectorAll('h2')).map((node) => node.textContent)).toContain('Analyze')
      const degrees = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .find((candidate) => candidate.closest('label')?.textContent === 'Degrees')!
      expect(degrees.checked).toBe(true)
      // The same settings are still a new calculation, never a refresh.
      await choose('Percent')
      await act(async () => {
        container.querySelector('form#' + CSS_ESCAPE(container.querySelector('button[type="submit"][form]')!.getAttribute('form')!))!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(actions.runAnalysis).toHaveBeenCalledWith({
        analysis_id: 'terrain.slope',
        inputs: [{ key: 'dem', item_id: 'a' }],
        parameters: [{ key: 'unit', value: { Choice: 'percent' } }],
        outputs: ['slope'],
        name: 'Ground · Slope',
      })
      expect(actions.rerunAnalysis).not.toHaveBeenCalled()
    })

    it('offers no run with changes once the input is gone', async () => {
      lidarLibrary.value = library([], [slope('s', 'a', { name: 'Steepness' })])
      mount()
      await selectRow('Steepness')
      expect(() => button(/^Run again with changes…$/)).toThrow()
    })
  })
})

/** An id usable in a selector. */
function CSS_ESCAPE(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
}

describe('Data library size', () => {
  it('reads as kilobytes, megabytes or gigabytes', () => {
    expect(formatDiskSize(0, 'en')).toBe('0 kB')
    expect(formatDiskSize(12_345, 'en')).toBe('12.3 kB')
    expect(formatDiskSize(340_000_000, 'en')).toBe('340 MB')
    expect(formatDiskSize(1_240_000_000, 'en')).toBe('1.2 GB')
  })
})
