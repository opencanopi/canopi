// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { librarySnapshot, slopeItem, slopeProvenance, sourceItem } from './support/library-fixtures'

const actions = vi.hoisted(() => ({
  cancelAnalysisJob: vi.fn().mockResolvedValue(true),
  cancelLibraryImport: vi.fn().mockResolvedValue(undefined),
  chooseImportFiles: vi.fn().mockResolvedValue(null),
  dismissAttachmentFailure: vi.fn(),
  moveReferenceTo: vi.fn(),
  removeFromDesign: vi.fn(),
  rerunAnalysis: vi.fn().mockResolvedValue(undefined),
  setLidarEntryDisplay: vi.fn(),
  setLidarEntryVisibility: vi.fn(),
  setSiteDataShown: vi.fn(),
}))
const pending = vi.hoisted(() => ({ attachments: null as unknown, failure: null as unknown, values: null as unknown }))

vi.mock('../app/lidar/actions', async () => {
  const { signal } = await import('@preact/signals')
  pending.attachments = signal([])
  pending.failure = signal(null)
  return { ...actions, pendingAttachments: pending.attachments, attachmentFailure: pending.failure }
})
vi.mock('../app/lidar/site-values', async () => {
  const { signal } = await import('@preact/signals')
  pending.values = signal(null)
  return { siteValues: pending.values }
})
vi.mock('../ipc/lidar', () => ({
  lidarDisplayDescriptor: vi.fn(() => new Promise(() => {})),
  // The panel's library observer reads the list on mount: it answers with the snapshot the test set.
  lidarListLibrary: vi.fn(async () => (await import('../app/lidar/library-store')).lidarLibrary.peek()),
  // The panel's Profile button imports the profile, which builds the app's one sampler on this transport.
  lidarSamplePoints: vi.fn(() => new Promise(() => {})),
}))
vi.mock('../app/document-session/store', async () => {
  const { signal } = await import('@preact/signals')
  return {
    currentDesign: signal<unknown>(null),
    designSessionStore: { sessionIdentity: signal({ session: 'design-a' }) },
  }
})

import { SiteDataPanel } from '../components/panels/lidar/SiteDataPanel'
import { lidarLibrary, refreshLidarLibrary } from '../app/lidar/library-store'
import { lidarListLibrary } from '../ipc/lidar'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { dataDialog, libraryView } from '../app/lidar/library-navigation'
import { showInSiteData, siteDataViewFor } from '../app/lidar/site-data-view'
import { pin, setPin, unpin } from '../app/lidar/site-transients'
import { activePanel, sidePanel } from '../app/shell/state'
import { locale } from '../app/settings/state'
import type { LibraryItemSummary } from '../generated/contracts'
import type { Signal } from '@preact/signals'
import { hoveredTooltip } from './support/tooltip'

const library = librarySnapshot

let container: HTMLDivElement

interface Entry { kind: 'Source' | 'Derived'; id: string; order: number; visible?: boolean; opacity?: number; name?: string }

function setDesign(entries: readonly Entry[], visible = true): void {
  (currentDesign as unknown as { value: unknown }).value = {
    lidar: { visible, entries: entries.map((entry) => ({ name: entry.id, visible: true, opacity: 1, ramp: null, reversed: false, range: null, ...entry })) },
  }
}

function newSession(): void {
  (designSessionStore.sessionIdentity as unknown as { value: object }).value = { session: Math.random() }
}

function buttons(root: ParentNode = container): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('button'))
}

/** A button's name: its aria-label, else its text. */
function nameOf(candidate: HTMLButtonElement): string {
  return candidate.getAttribute('aria-label') ?? (candidate.textContent ?? '').trim()
}

function button(label: string | RegExp, root: ParentNode = container): HTMLButtonElement {
  const found = buttons(root).find((candidate) => {
    const text = nameOf(candidate)
    return typeof label === 'string' ? text === label : label.test(text)
  })
  if (!found) throw new Error(`no button ${String(label)}`)
  return found
}

function row(id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-site-row="${id}"]`)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function key(target: HTMLElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

function mount(): void {
  act(() => {
    render(<SiteDataPanel />, container)
  })
}

/** Each listed line, front first: its row id (or `[run]` for an analysis line) and its depth. */
function lines(): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-site-line]')).map((line) =>
    `${'  '.repeat(Number(line.dataset.depth))}${line.dataset.siteRow ?? `[${line.dataset.siteLine}]`}`)
}

function trailing(id: string): string {
  return row(id).querySelector('[data-trailing]')?.textContent ?? ''
}

function values(entries: Record<string, number | null>, at: 'pointer' | 'pin' = 'pointer'): void {
  (pending.values as Signal<unknown>).value = {
    at,
    rows: new Map(Object.entries(entries).map(([id, value]) => [id, value === null ? { kind: 'no-data' } : { kind: 'value', value }])),
  }
}

beforeEach(() => {
  locale.value = 'en'
  vi.clearAllMocks()
  newSession()
  sidePanel.value = 'site-data'
  dataDialog.value = null
  libraryView.value = null
  unpin()
  ;(pending.attachments as Signal<unknown[]>).value = []
  ;(pending.failure as Signal<unknown>).value = null
  ;(pending.values as Signal<unknown>).value = null
  lidarLibrary.value = library([
    sourceItem('a', 'Ground', { value_range: [100, 200] }),
    sourceItem('b', 'Canopy', { value_range: [0, 24], item_type: { kind: 'Raster', quantity: 'AboveGroundHeight' } }),
    slopeItem('s', 'a'),
  ])
  setDesign([])
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

describe('the Site data panel', () => {
  it('has a header with the Data library and close, and a toolbar with Import, Analyze and Profile', async () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0 }])
    mount()
    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Site data')
    expect(container.querySelector('h2')?.textContent).toBe('Site data')
    await click(button('Import…'))
    expect(actions.chooseImportFiles).toHaveBeenCalledWith()
    await click(button('Analyze…'))
    expect(dataDialog.value).toMatchObject({ kind: 'analyze', itemId: 'a' })
    await click(button('Ground'))
    await click(button('Data library'))
    expect(libraryView.value).toEqual({ focusId: 'a' })
    await click(button('Close panel'))
    expect(sidePanel.value).toBeNull()
  })

  it('offers files or the Data library to an empty Design, under the toolbar', async () => {
    mount()
    expect(container.textContent).toContain('No site data yet')
    await click(button('Open the Data library'))
    expect(libraryView.value).toEqual({ focusId: null })
    await click(button('Import files…'))
    expect(actions.chooseImportFiles).toHaveBeenCalledOnce()
  })

  it('opens Analyze on the open item, else the open result\'s input, else the first item an analysis accepts', async () => {
    // A Web Mercator grid: an analysis accepts it, and Analyze names the grid problem rather than skipping it.
    lidarLibrary.value = library([
      sourceItem('t1', 'Ground one'),
      sourceItem('w', 'Web grid', { offers: [{ analysis_id: 'terrain.slope', unavailable: { reason: 'GridNotProjectedMetres' } }] }),
      slopeItem('s', 'w'),
      sourceItem('i', 'Preparing', { state: 'Preparing' }),
    ])
    setDesign([
      { kind: 'Source', id: 't1', order: 1 },
      { kind: 'Source', id: 'w', order: 0 },
      { kind: 'Derived', id: 's', order: 0 },
      { kind: 'Source', id: 'i', order: 2 },
      { kind: 'Source', id: 'gone', order: 3 },
    ])
    const view = siteDataViewFor(designSessionStore.sessionIdentity.peek())
    mount()
    const analyzeOn = async (open: string | null) => {
      await act(async () => { view.openItem.value = open })
      await click(button('Analyze…'))
      return (dataDialog.value as { itemId?: string } | null)?.itemId
    }
    expect(await analyzeOn(null)).toBe('t1')
    expect(await analyzeOn('w')).toBe('w')
    // The slope result no analysis takes is open: its input, the Web grid, is the source.
    expect(await analyzeOn('s')).toBe('w')
    // An item still preparing, or one missing from the library, is not sent: the first eligible item is.
    expect(await analyzeOn('i')).toBe('t1')
    expect(await analyzeOn('gone')).toBe('t1')
  })

  it('keeps Analyze enabled when the only reason is a missing engine', async () => {
    lidarLibrary.value = library([
      sourceItem('a', 'Ground', { offers: [{ analysis_id: 'terrain.slope', unavailable: { reason: 'EngineMissing', detail: 'not installed' } }] }),
    ], false)
    setDesign([{ kind: 'Source', id: 'a', order: 0 }])
    mount()
    expect(button('Analyze…').getAttribute('aria-disabled')).toBeNull()
    await click(button('Analyze…'))
    expect(dataDialog.value).toMatchObject({ kind: 'analyze', itemId: 'a' })
  })

  it('says why Analyze and Profile are disabled', () => {
    lidarLibrary.value = library([sourceItem('a', 'Ground', { offers: [] }), slopeItem('s', 'a')])
    setDesign([{ kind: 'Derived', id: 's', order: 0 }])
    mount()
    const analyze = button('Analyze…')
    expect(analyze.getAttribute('aria-disabled')).toBe('true')
    expect(hoveredTooltip(analyze)?.textContent).toBe('Add terrain or height data first')
    const profile = button('Profile')
    expect(profile.getAttribute('aria-disabled')).toBe('true')
    expect(hoveredTooltip(profile)?.textContent).toBe('Show an elevation or height layer to draw a profile')
  })

  it('lists one line per item, front first, results under their source and a run under one analysis line', () => {
    const output = (id: string, key: string) => slopeItem(id, 'a', {
      provenance: slopeProvenance(id, 'a', { definition_id: 'flow-def', output_key: key }),
    })
    lidarLibrary.value = library([sourceItem('a', 'Ground'), sourceItem('b', 'Canopy'), output('o1', 'slope'), output('o2', 'other'), slopeItem('s', 'a')])
    setDesign([
      { kind: 'Source', id: 'a', order: 0 },
      { kind: 'Source', id: 'b', order: 1 },
      { kind: 'Derived', id: 'o1', order: 3 },
      { kind: 'Derived', id: 's', order: 2 },
      { kind: 'Derived', id: 'o2', order: 1 },
    ])
    mount()
    expect(lines()).toEqual(['b', 'a', '  [analysis:flow-def]', '    o1', '    o2', '  s'])
    // An analysis line has a chevron and no grip; a row's name is one line with its full name as its title.
    const group = container.querySelector<HTMLElement>('[data-site-line="analysis:flow-def"]')!
    expect(group.querySelector('[aria-label^="Reorder"]')).toBeNull()
    expect(button('Collapse Slope', group).getAttribute('aria-expanded')).toBe('true')
    expect(button('Ground · Slope', row('s')).getAttribute('title')).toBe('Ground · Slope')
    expect(row('a').querySelector('[data-swatch]')).not.toBeNull()
  })

  it('collapsing an analysis line closes an open item nested under one of its outputs', async () => {
    const output = (id: string, key: string) => slopeItem(id, 'a', {
      provenance: slopeProvenance(id, 'a', { definition_id: 'flow-def', output_key: key }),
    })
    lidarLibrary.value = library([sourceItem('a', 'Ground'), output('o1', 'slope'), output('o2', 'other'), slopeItem('n', 'o1')])
    setDesign([
      { kind: 'Source', id: 'a', order: 0 },
      { kind: 'Derived', id: 'o1', order: 2 },
      { kind: 'Derived', id: 'o2', order: 1 },
      { kind: 'Derived', id: 'n', order: 3 },
    ])
    mount()
    expect(lines()).toEqual(['a', '  [analysis:flow-def]', '    o1', '      n', '    o2'])
    await click(row('n').querySelector<HTMLButtonElement>('button[aria-expanded]')!)
    const view = siteDataViewFor(designSessionStore.sessionIdentity.value)
    expect(view.openItem.value).toBe('n')
    await click(button('Collapse Slope', container.querySelector<HTMLElement>('[data-site-line="analysis:flow-def"]')!))
    expect(lines()).toEqual(['a', '  [analysis:flow-def]'])
    expect(view.openItem.value).toBeNull()
  })

  it('opens one item at a time under its row, with its settings and actions, and closes it on a second click', async () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0 }, { kind: 'Source', id: 'b', order: 1 }])
    mount()
    const name = button('Ground')
    expect(name.getAttribute('aria-expanded')).toBe('false')
    await click(name)
    expect(name.getAttribute('aria-expanded')).toBe('true')
    const body = row('a')
    expect(body.textContent).toContain('Ground elevation (DTM)')
    expect(body.querySelector('[role="radiogroup"][aria-label="Colors"]')).not.toBeNull()
    // A ground elevation opens on Relief, which hides Range (D2, D5, user, 2026-10-15).
    expect(body.querySelector('[role="radiogroup"][aria-label="Range"]')).toBeNull()
    expect(body.querySelector('input[aria-label="Opacity: Ground"]')).not.toBeNull()
    await click(button('Details', body))
    expect(libraryView.value).toEqual({ focusId: 'a' })
    await click(button('Remove Ground from this Design', body))
    expect(actions.removeFromDesign).toHaveBeenCalledWith('a')
    expect(body.textContent).toContain('Your library keeps the data.')

    await click(button('Canopy'))
    expect(button('Ground').getAttribute('aria-expanded')).toBe('false')
    expect(row('a').querySelector('[role="radiogroup"]')).toBeNull()
    await click(button('Canopy'))
    expect(button('Canopy').getAttribute('aria-expanded')).toBe('false')
  })

  it('writes an eye through the one visibility writer, and dims a hidden row', async () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0, visible: false }])
    mount()
    expect(row('a').dataset.hidden).toBe('true')
    await click(button('Show Ground'))
    expect(actions.setLidarEntryVisibility).toHaveBeenCalledWith('a', true)
  })

  it('shows a missing item\'s stored name with Missing, and opened, the reason and Remove from Design only', async () => {
    setDesign([{ kind: 'Source', id: 'gone', name: 'Old survey', order: 0 }])
    mount()
    expect(button('Old survey')).toBeTruthy()
    expect(trailing('gone')).toBe('Missing')
    expect(row('gone').querySelector('[aria-label^="Hide"], [aria-label^="Show"]')).toBeNull()
    await click(button('Old survey'))
    const body = row('gone')
    expect(body.textContent).toContain('Not in this computer’s Data library')
    expect(buttons(body).map(nameOf))
      .toEqual(['Reorder Old survey', 'Old survey', 'Remove Old survey from this Design'])
  })

  it('draws an entry as a normal row while the library loads, and as missing once the list cannot be read', async () => {
    let fail!: (error: Error) => void
    vi.mocked(lidarListLibrary).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    lidarLibrary.value = null
    setDesign([{ kind: 'Source', id: 'ground', order: 0 }])
    mount()
    expect(trailing('ground')).toBe('')
    expect(button('Hide ground')).toBeTruthy()

    await act(async () => {
      fail(new Error('catalogue locked'))
      await refreshLidarLibrary()
    })
    expect(trailing('ground')).toBe('Missing')
    await click(button('ground'))
    expect(row('ground').textContent).toContain('The Data library couldn’t be opened. Restart Canopi.')
  })

  it('ends each shown, ready row with its value under the pointer, "—" off the data, and nothing on hidden rows', () => {
    setDesign([
      { kind: 'Source', id: 'a', order: 0 },
      { kind: 'Source', id: 'b', order: 1, visible: false },
      { kind: 'Derived', id: 's', order: 2 },
    ])
    values({ a: 312.456, b: 3, s: null })
    mount()
    expect(trailing('a')).toBe('312.46 m')
    expect(trailing('b')).toBe('')
    expect(trailing('s')).toBe('—')
    expect(row('s').querySelector('[data-trailing]')?.getAttribute('aria-label')).toBe('No data')
  })

  it('marks an out-of-date result with Refresh, says why when opened, and shows a refresh in progress', async () => {
    lidarLibrary.value = library([
      sourceItem('a', 'Ground'),
      slopeItem('s', 'a', { freshness: { state: 'Stale', reasons: [{ reason: 'InputUpdated', input_key: 'dem', item_id: 'a' }] } }),
    ])
    setDesign([{ kind: 'Derived', id: 's', order: 0 }])
    mount()
    await click(button('Refresh Ground · Slope'))
    expect(actions.rerunAnalysis).toHaveBeenCalledWith('s-def')
    await click(button('Ground · Slope'))
    expect(row('s').textContent).toContain('Ground has changed since this was calculated.')

    render(null, container)
    lidarLibrary.value = library([
      sourceItem('a', 'Ground'),
      slopeItem('s', 'a', {
        freshness: { state: 'Stale', reasons: [{ reason: 'RecipeUpdated', from: 1, to: 2 }] },
        run: { job_id: 'j', state: 'Preparing', message: null },
      }),
    ])
    mount()
    expect(trailing('s')).toBe('Refreshing')
    expect(() => button('Refresh Ground · Slope')).toThrow()
  })

  it('says Preparing while an item or its display prepares', () => {
    lidarLibrary.value = library([sourceItem('a', 'Ground', { state: 'Preparing' })])
    setDesign([{ kind: 'Source', id: 'a', order: 0 }])
    mount()
    expect(trailing('a')).toBe('Preparing')
  })
})

describe('collapse and the view that survives switching panels', () => {
  beforeEach(() => {
    setDesign([
      { kind: 'Source', id: 'a', order: 0 },
      { kind: 'Source', id: 'b', order: 1 },
      { kind: 'Derived', id: 's', order: 2 },
    ])
  })

  it('folds a source\'s results in the panel only, and collapsing closes an open result', async () => {
    mount()
    await click(button('Ground · Slope'))
    await click(button('Collapse Ground'))
    expect(lines()).toEqual(['b', 'a'])
    expect(siteDataViewFor(designSessionStore.sessionIdentity.value).openItem.value).toBeNull()
    expect(button('Expand Ground').getAttribute('aria-expanded')).toBe('false')
    await click(button('Expand Ground'))
    expect(lines()).toEqual(['b', 'a', '  s'])
  })

  it('keeps the open item and collapse when the panel mounts again', async () => {
    mount()
    await click(button('Canopy'))
    await click(button('Collapse Ground'))
    render(null, container)
    mount()
    expect(button('Canopy').getAttribute('aria-expanded')).toBe('true')
    expect(lines()).toEqual(['b', 'a'])
  })

  it('Show in Site data expands the item\'s source and opens it', async () => {
    mount()
    await click(button('Collapse Ground'))
    await act(async () => { showInSiteData('s') })
    expect(lines()).toEqual(['b', 'a', '  s'])
    expect(button('Ground · Slope').getAttribute('aria-expanded')).toBe('true')
  })

  it('a result that joins this Design expands its collapsed source', async () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0 }, { kind: 'Source', id: 'b', order: 1 }])
    lidarLibrary.value = library([sourceItem('a', 'Ground'), sourceItem('b', 'Canopy'), slopeItem('s', 'a'), slopeItem('t', 'a')])
    setDesign([{ kind: 'Source', id: 'a', order: 0 }, { kind: 'Source', id: 'b', order: 1 }, { kind: 'Derived', id: 's', order: 2 }])
    mount()
    await click(button('Collapse Ground'))
    await act(async () => {
      setDesign([
        { kind: 'Source', id: 'a', order: 0 }, { kind: 'Source', id: 'b', order: 1 },
        { kind: 'Derived', id: 's', order: 2 }, { kind: 'Derived', id: 't', order: 3 },
      ])
    })
    expect(lines()).toEqual(['b', 'a', '  t', '  s'])
  })
})

describe('the filter', () => {
  const many = Array.from({ length: 9 }, (_, index) => sourceItem(`n${index}`, `North block ${index}`))

  it('shows only above eight items, keeps a match\'s source, hides the grips and clears with Esc', async () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0 }, { kind: 'Derived', id: 's', order: 1 }])
    mount()
    expect(container.querySelector('input[type="search"]')).toBeNull()
    render(null, container)

    lidarLibrary.value = library([sourceItem('a', 'Ground'), slopeItem('s', 'a', { name: 'Steepness' }), ...many])
    setDesign([
      { kind: 'Source', id: 'a', order: 20 }, { kind: 'Derived', id: 's', order: 21 },
      ...many.map((item, index) => ({ kind: 'Source' as const, id: item.id, order: index })),
    ])
    mount()
    const field = container.querySelector<HTMLInputElement>('input[type="search"][aria-label="Filter site data"]')!
    expect(field.placeholder).toBe('Filter by name')
    await act(async () => {
      field.value = 'steep'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(lines()).toEqual(['a', '  s'])
    expect(container.querySelector('[aria-label^="Reorder"]')).toBeNull()
    await key(button('Steepness'), { key: 'ArrowUp', altKey: true })
    expect(actions.moveReferenceTo).not.toHaveBeenCalled()

    await act(async () => {
      field.value = 'zzz'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('No data matches this search.')
    await key(field, { key: 'Escape' })
    expect(field.value).toBe('')
    expect(lines()).toHaveLength(11)
  })
})

describe('reordering', () => {
  function rects(ids: readonly string[]): void {
    ids.forEach((id, index) => {
      vi.spyOn(row(id), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 32, 440, 32))
    })
  }

  async function drag(grip: HTMLElement, toY: number): Promise<void> {
    grip.setPointerCapture = vi.fn()
    grip.releasePointerCapture = vi.fn()
    await act(async () => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientY: 0, bubbles: true }))
    })
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: toY, bubbles: true }))
    })
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: toY + 1, bubbles: true }))
    })
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientY: toY + 1, bubbles: true }))
    })
  }

  const output = (id: string) => slopeItem(id, 'a', { provenance: slopeProvenance(id, 'a', { definition_id: 'flow-def', output_key: id }) })

  beforeEach(() => {
    lidarLibrary.value = library([sourceItem('a', 'Ground'), output('o1'), output('o2'), slopeItem('s', 'a'), sourceItem('b', 'Canopy')])
    setDesign([
      { kind: 'Source', id: 'a', order: 0 },
      { kind: 'Derived', id: 'o1', order: 3 },
      { kind: 'Derived', id: 'o2', order: 2 },
      { kind: 'Derived', id: 's', order: 1 },
      { kind: 'Source', id: 'b', order: 1 },
    ])
  })

  it('drags a row past a whole analysis run among its siblings, reflowing live and writing one order on the drop', async () => {
    mount()
    expect(lines()).toEqual(['b', 'a', '  [analysis:flow-def]', '    o1', '    o2', '  s'])
    rects(['b', 'a', 'o1', 'o2', 's'])
    // The slope dropped over the run's first output lands before the whole run.
    await drag(button('Reorder Ground · Slope', row('s')), 2 * 32 + 4)
    expect(actions.moveReferenceTo).toHaveBeenCalledTimes(1)
    expect(actions.moveReferenceTo).toHaveBeenCalledWith('s', 'o1')
  })

  it('keeps a run\'s output inside its run, and a top-level row among top-level rows', async () => {
    mount()
    rects(['b', 'a', 'o1', 'o2', 's'])
    // Dragged far below the list, the second output stays the run's last.
    await drag(button('Reorder Ground · Slope', row('o1')), 10 * 32)
    expect(actions.moveReferenceTo).toHaveBeenCalledWith('o1', 'o2')
    vi.clearAllMocks()
    await drag(button('Reorder Ground'), 0)
    expect(actions.moveReferenceTo).toHaveBeenCalledWith('a', 'b')
  })

  it('measures a collapsed run by its analysis line, so a row behind it can drop in front of it', async () => {
    mount()
    await click(button('Collapse Slope', container.querySelector<HTMLElement>('[data-site-line="analysis:flow-def"]')!))
    expect(lines()).toEqual(['b', 'a', '  [analysis:flow-def]', '  s'])
    const run = container.querySelector<HTMLElement>('[data-site-line="analysis:flow-def"]')!
    rects(['b', 'a'])
    vi.spyOn(run, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 64, 440, 32))
    vi.spyOn(row('s'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 96, 440, 32))
    // The slope dropped over the run's line lands before the whole run.
    await drag(button('Reorder Ground · Slope', row('s')), 64 + 4)
    expect(actions.moveReferenceTo).toHaveBeenCalledTimes(1)
    expect(actions.moveReferenceTo).toHaveBeenCalledWith('s', 'o1')
  })

  it('keeps a row in front of a collapsed run where it started while the pointer stays on it', async () => {
    lidarLibrary.value = library([sourceItem('a', 'Ground'), output('o1'), output('o2'), slopeItem('s', 'a'), slopeItem('t', 'a', { name: 'Terrace' }), sourceItem('b', 'Canopy')])
    setDesign([
      { kind: 'Source', id: 'a', order: 0 },
      { kind: 'Derived', id: 's', order: 4 },
      { kind: 'Derived', id: 'o1', order: 3 },
      { kind: 'Derived', id: 'o2', order: 2 },
      { kind: 'Derived', id: 't', order: 1 },
      { kind: 'Source', id: 'b', order: 1 },
    ])
    mount()
    await click(button('Collapse Slope', container.querySelector<HTMLElement>('[data-site-line="analysis:flow-def"]')!))
    expect(lines()).toEqual(['b', 'a', '  s', '  [analysis:flow-def]', '  t'])
    const run = container.querySelector<HTMLElement>('[data-site-line="analysis:flow-def"]')!
    rects(['b', 'a', 's'])
    vi.spyOn(run, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 96, 440, 32))
    vi.spyOn(row('t'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 128, 440, 32))
    await drag(button('Reorder Ground · Slope', row('s')), 64 + 4)
    expect(actions.moveReferenceTo).not.toHaveBeenCalled()
  })

  it('writes nothing for a drop where the row started', async () => {
    mount()
    rects(['b', 'a', 'o1', 'o2', 's'])
    await drag(button('Reorder Canopy'), 4)
    expect(actions.moveReferenceTo).not.toHaveBeenCalled()
  })

  it('moves a row with Alt ↑ and Alt ↓ on its grip or name, keeping focus on the control', async () => {
    mount()
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 0 })
    const grip = button('Reorder Ground · Slope', row('s'))
    grip.focus()
    await key(grip, { key: 'ArrowUp', altKey: true })
    expect(actions.moveReferenceTo).toHaveBeenCalledWith('s', 'o2')
    expect(document.activeElement).toBe(button('Reorder Ground · Slope', row('s')))
    await key(button('Canopy'), { key: 'ArrowDown', altKey: true })
    expect(actions.moveReferenceTo).toHaveBeenCalledWith('b', 'a')
    await key(button('Ground'), { key: 'ArrowDown', altKey: true })
    expect(actions.moveReferenceTo).toHaveBeenCalledTimes(2)
    frame.mockRestore()
  })
})

describe('pending work, failures and the Site data eye', () => {
  it('places an import at the top and a calculation under its source, with progress and Cancel', async () => {
    const preparing: Partial<LibraryItemSummary> = { state: 'Preparing', generation_id: null }
    lidarLibrary.value = library([
      sourceItem('a', 'Ground'),
      sourceItem('b', 'Canopy'),
      sourceItem('n', 'North tiles', {
        ...preparing,
        import_job: { job_id: 'job-n', layer_id: 'n', state: 'Applying', message: null, progress: { phase: 'RenderingMap', percent: 42 } },
      }),
      slopeItem('r', 'a', { ...preparing, name: 'Terrace', run: { job_id: 'job-r', state: 'Preparing', message: null } }),
    ])
    ;(pending.attachments as Signal<unknown[]>).value = [
      { key: 'import:n', kind: 'import', identity: designSessionStore.sessionIdentity.value, itemIds: ['n'] },
      { key: 'r-def', kind: 'analysis', identity: designSessionStore.sessionIdentity.value, itemIds: ['r'] },
      { key: 'import:other', kind: 'import', identity: { another: true }, itemIds: ['a'] },
    ]
    setDesign([{ kind: 'Source', id: 'a', order: 0 }, { kind: 'Source', id: 'b', order: 1 }])
    mount()
    expect(lines()).toEqual(['[pending:import:n]', 'b', 'a', '  [pending:r-def]'])
    const importing = container.querySelector<HTMLElement>('[data-site-line="pending:import:n"]')!
    expect(importing.textContent).toContain('Importing · 42%')
    expect(importing.querySelector('progress')).not.toBeNull()
    expect(importing.textContent).not.toContain('You can keep working.')
    await click(button('Cancel import', importing))
    expect(actions.cancelLibraryImport).toHaveBeenCalledWith('job-n')
    const calculating = container.querySelector<HTMLElement>('[data-site-line="pending:r-def"]')!
    expect(calculating.textContent).toContain('Calculating')
    await click(button('Cancel calculation', calculating))
    expect(actions.cancelAnalysisJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }))
  })

  it('says when work started here could not join the Design, with Show in the Data library', async () => {
    ;(pending.failure as Signal<unknown>).value = { itemId: 'a' }
    mount()
    expect(container.textContent).toContain('Ground could not be added to this Design.')
    await click(button('Show in the Data library'))
    expect(actions.dismissAttachmentFailure).toHaveBeenCalled()
    expect(libraryView.value).toEqual({ focusId: 'a' })
  })

  it('says work could not join the Design without the engine text its job stored', () => {
    ;(pending.failure as Signal<unknown>).value = { itemId: 'a', message: 'not a raster' }
    mount()
    expect(container.textContent).toContain('Ground could not be added to this Design.')
    expect(container.textContent).not.toContain('not a raster')
  })

  it('says when the Layers eye hides all site data, with Show, and dims the rows keeping their eyes', async () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0 }], false)
    mount()
    expect(container.textContent).toContain('Site data is hidden from the map')
    expect(row('a').dataset.hidden).toBe('true')
    expect(button('Hide Ground')).toBeTruthy()
    await click(button('Show'))
    expect(actions.setSiteDataShown).toHaveBeenCalledWith(true)
  })
})

describe('the pinned point', () => {
  it('shows the pin\'s coordinates with Unpin, and otherwise a hint while a row can show a value', async () => {
    activePanel.value = 'canvas'
    setDesign([{ kind: 'Source', id: 'a', order: 0 }])
    mount()
    expect(container.textContent).toContain('Point at the map to read values · click to pin')
    await act(async () => { setPin({ lon: 2.35211, lat: 48.85123 }) })
    expect(container.textContent).toContain('48.851230° N, 2.352110° E')
    expect(container.textContent).not.toContain('Point at the map')
    await click(button('Unpin'))
    expect(pin.value).toBeNull()
  })

  it('shows no hint without a row that can show a value', () => {
    setDesign([{ kind: 'Source', id: 'a', order: 0, visible: false }])
    mount()
    expect(container.textContent).not.toContain('Point at the map')
  })
})
