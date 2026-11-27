// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale, unitSystem } from '../app/settings/state'
import { SelectionChip } from '../components/canvas/SelectionChip'
import { RenameZoneDialog } from '../components/canvas/RenameZoneDialog'
import { renameZoneDialog } from '../app/rename-zone/state'
import { SpeciesFocusChip } from '../components/canvas/SpeciesFocusChip'
import { plantFinderMapMatches } from '../app/plant-finder/map-matches'
import { SceneStore } from '../canvas/runtime/scene/store'
import type { SceneDesignObjectSelection } from '../canvas/runtime/scene'
import type { CanvasCommandSurface } from '../canvas/runtime/runtime'
import { setCurrentCanvasSession } from '../canvas/session'
import { currentCanvasSelection } from '../canvas/session-state'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
  createTestCanvasKeyboardPort,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'

const RECT_ID = 'zone-ee08f9f9-634f-4723-bbde-1200610562dc'
const ELLIPSE_ID = 'zone-0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
const LINE_ID = 'zone-9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'
const GUIDE_ID = 'measurement-guide-6f1e2d3c-4b5a-4968-8776-655443322110'

const PLANTS = [
  { id: 'apricot-1', canonicalName: 'Prunus armeniaca', commonName: 'Apricot' },
  { id: 'apricot-2', canonicalName: 'Prunus armeniaca', commonName: 'Apricot' },
  { id: 'apricot-3', canonicalName: 'Prunus armeniaca', commonName: 'Apricot' },
  { id: 'fig-1', canonicalName: 'Ficus carica', commonName: 'Fig' },
  { id: 'mint-1', canonicalName: 'Mentha spicata', commonName: null },
]

describe('Selection chip', () => {
  let container: HTMLDivElement
  let queries: TestCanvasQuerySurface
  let selectSpecies: ReturnType<typeof vi.fn<CanvasCommandSurface['sceneEdits']['selectSpecies']>>
  let clearSelection: ReturnType<typeof vi.fn<CanvasCommandSurface['sceneEdits']['clearSelection']>>

  beforeEach(() => {
    locale.value = 'en'
    unitSystem.value = 'metric'
    container = document.createElement('div')
    document.body.append(container)
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.plants = PLANTS.map((plant, index) => ({
        id: plant.id,
        canonicalName: plant.canonicalName,
        commonName: plant.commonName,
        kind: 'plant',
        locked: false,
        color: null,
        symbol: 'herb',
        position: { x: index * 5, y: 0 },
        canopySpreadM: null,
        rotationDeg: 0,
        notes: null,
        plantedDate: null,
        quantity: 1,
      }))
      draft.zones = [{
        kind: 'zone', id: 'zone-z04', name: 'Z04', locked: false, zoneType: 'polygon', rotationDeg: 0, fillColor: null, notes: null,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      }, {
        // Drawn with the Rectangle tool and never named.
        kind: 'zone', id: RECT_ID, name: null, locked: false, zoneType: 'rect', rotationDeg: 30, fillColor: null, notes: null,
        points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }],
      }, {
        kind: 'zone', id: ELLIPSE_ID, name: null, locked: false, zoneType: 'ellipse', rotationDeg: 0, fillColor: null, notes: null,
        points: [{ x: 50, y: 50 }, { x: 10, y: 5 }],
      }, {
        kind: 'zone', id: LINE_ID, name: null, locked: false, zoneType: 'line', rotationDeg: 0, fillColor: null, notes: null,
        points: [{ x: 0, y: 0 }, { x: 30, y: 40 }],
      }]
      draft.annotations = [{
        kind: 'annotation', id: 'note-1', locked: false, annotationType: 'text', position: { x: 1, y: 1 },
        text: 'Mulch in November', fontSize: 14, rotationDeg: null,
      }]
      draft.measurementGuides = [{
        kind: 'measurement-guide', id: GUIDE_ID, locked: false, start: { x: 0, y: 0 }, end: { x: 3, y: 4 },
      }]
      draft.groups = [{
        kind: 'group', id: 'guild', locked: false, name: 'Guild',
        members: [{ kind: 'plant', id: 'fig-1' }, { kind: 'plant', id: 'mint-1' }],
      }]
    })
    queries = createTestCanvasQuerySurface({
      scene: store.persisted,
      localizedNames: new Map([['Prunus armeniaca', 'Apricot'], ['Mentha spicata', null]]),
    })
    selectSpecies = vi.fn<CanvasCommandSurface['sceneEdits']['selectSpecies']>()
    clearSelection = vi.fn<CanvasCommandSurface['sceneEdits']['clearSelection']>()
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface({ sceneEdits: { selectSpecies, clearSelection } }),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    currentCanvasSelection.value = new Set()
    plantFinderMapMatches.value = null
    setCurrentCanvasSession(null)
  })

  async function select(targets: SceneDesignObjectSelection): Promise<void> {
    await act(() => {
      queries.setSelection(targets)
      currentCanvasSelection.value = new Set(targets.map((target) => target.id))
    })
  }

  const chip = () => container.querySelector<HTMLElement>('[data-selection-chip]')
  const status = () => chip()?.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim()
  const buttons = () => [...(chip()?.querySelectorAll('button') ?? [])].map((button) => button.textContent)

  it('shows nothing without a selection', async () => {
    await act(() => render(<SelectionChip />, container))
    expect(chip()).toBeNull()
  })

  it('names one plant and offers Select all of this species and Clear selection', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'plant', id: 'apricot-1' }])

    expect(chip()!.getAttribute('role')).toBe('group')
    expect(chip()!.getAttribute('aria-label')).toBe('Selection')
    const live = chip()!.querySelector('[role="status"]')!
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(status()).toBe('Apricot')
    expect(buttons()).toEqual(['Select all of this species', 'Dimensions', 'Clear selection'])
    for (const button of chip()!.querySelectorAll('button')) {
      expect(button.getAttribute('type')).toBe('button')
      expect(button.tabIndex).toBe(0)
    }

    await act(() => chip()!.querySelector<HTMLButtonElement>('button')!.click())
    expect(selectSpecies).toHaveBeenCalledWith(['Prunus armeniaca'])
    await act(() => [...chip()!.querySelectorAll<HTMLButtonElement>('button')].at(-1)!.click())
    expect(clearSelection).toHaveBeenCalledTimes(1)
  })

  it('in the phone\'s context bar keeps Select all of this species and Clear selection on one line, with short labels', async () => {
    await act(() => render(<SelectionChip placement="bar" />, container))
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'apricot-2' }])
    expect(chip()!.dataset.selectionChip).toBe('bar')
    expect(status()).toBe('2 plants · Apricot · 5 m apart')
    expect(buttons()).toEqual(['Same species', 'Clear'])

    await act(() => chip()!.querySelector<HTMLButtonElement>('button')!.click())
    expect(selectSpecies).toHaveBeenCalledWith(['Prunus armeniaca'])
    await act(() => [...chip()!.querySelectorAll<HTMLButtonElement>('button')].at(-1)!.click())
    expect(clearSelection).toHaveBeenCalledTimes(1)
  })

  it('counts plants of one species, and drops Select all once the whole species is selected', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'apricot-2' }])
    expect(status()).toBe('2 plants · Apricot · 5 m apart')
    expect(buttons()).toEqual(['Select all of this species', 'Clear selection'])

    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'apricot-2' }, { kind: 'plant', id: 'apricot-3' }])
    expect(status()).toBe('3 plants · Apricot · 5 m apart')
    expect(buttons()).toEqual(['Clear selection'])
  })

  it('counts species across plants, expanding groups, and falls back to the scientific name', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'group', id: 'guild' }])
    expect(status()).toBe('3 plants · 3 species · 8.3 m apart')
    expect(buttons()).toEqual(['Clear selection'])

    await select([{ kind: 'plant', id: 'mint-1' }])
    expect(status()).toBe('Mentha spicata')
  })

  it('names a species with no name in the interface language by its English name, marked', async () => {
    await act(() => render(<SelectionChip />, container))
    await act(() => {
      locale.value = 'fr'
      queries.setEnglishFallbackNames(new Map([['Mentha spicata', 'Spearmint']]))
      queries.bumpPlantNamesRevision()
    })
    await select([{ kind: 'plant', id: 'mint-1' }])
    const live = chip()!.querySelector('[role="status"]')!
    expect(live.querySelector('b [lang="en"]')?.textContent).toBe('Spearmint')
    expect(live.querySelector('b [aria-hidden="true"]')?.textContent).toBe('(angl.)')
  })

  it('marks the English name in the one-species detail and the right-click heading', async () => {
    const { readMapSelectionSummary } = await import('../app/map-selection/summary')
    const { mapSelectionHeading } = await import('../app/map-selection/summary-text')
    await act(() => {
      locale.value = 'fr'
      queries.setLocalizedNames(new Map([['Prunus armeniaca', null]]))
      queries.setEnglishFallbackNames(new Map([['Prunus armeniaca', 'Apricot']]))
      queries.bumpPlantNamesRevision()
    })
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'apricot-2' }])
    const detail = [...chip()!.querySelectorAll('[role="status"] span')].find((span) => span.querySelector('[lang="en"]'))
    expect(detail?.querySelector('[lang="en"]')?.textContent).toBe('Apricot')
    expect(mapSelectionHeading(readMapSelectionSummary(queries)!, 'fr').replace(/\s+/g, ' ')).toBe('2 plantes · Apricot (angl.) · espacées de 5 m')
  })

  it('gives the spacing of the selected plants', async () => {
    await act(() => render(<SelectionChip />, container))
    // Plants sit 5 m apart in a row; the mean nearest-neighbour distance is 5 m.
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'apricot-2' }, { kind: 'plant', id: 'apricot-3' }])
    expect(status()).toBe('3 plants · Apricot · 5 m apart')
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'fig-1' }, { kind: 'plant', id: 'mint-1' }])
    // 1 → 4 and 4 ↔ 5: (15 + 5 + 5) / 3 m.
    expect(status()).toBe('3 plants · 3 species · 8.3 m apart')
    await act(() => { locale.value = 'fr' })
    expect(status()).toBe('3 plantes · 3 espèces · espacées de 8,3 m')
  })

  it('names a zone by its name, with its area and perimeter', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'zone', id: 'zone-z04' }])
    // A right triangle with 10 m legs: 50 m², 10 + 10 + 14.1 m around (rounded to whole m at >= 10 m).
    expect(status()).toBe('Zone · Z04 · 50 m² · 34 m')
  })

  it('never shows an id: an unnamed zone is named by its type', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'zone', id: RECT_ID }])
    expect(status()).toBe('Rectangle zone · 120 m² · 44 m')
    await select([{ kind: 'zone', id: ELLIPSE_ID }])
    // π · 10 · 5 m², and Ramanujan's perimeter of a 20 × 10 m ellipse (rounded to whole m at >= 10 m).
    expect(status()).toBe('Ellipse zone · 157 m² · 48 m')
    await select([{ kind: 'zone', id: LINE_ID }])
    expect(status()).toBe('Line zone · 50 m')
    await act(() => { locale.value = 'fr' })
    expect(status()).toBe('Zone linéaire · 50 m')
  })

  it('formats zone area, perimeter and plant spacing in US customary when unitSystem changes', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'zone', id: RECT_ID }])
    expect(status()).toBe('Rectangle zone · 120 m² · 44 m')

    await act(() => { unitSystem.value = 'us_customary' })
    expect(status()).toBe('Rectangle zone · 1,292 ft² · 144 ft')

    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'apricot-2' }])
    expect(status()).toBe('2 plants · Apricot · 16 ft apart')
  })

  it('offers Rename… for one zone, which renames it by its id through the runtime', async () => {
    const renameZone = vi.fn<CanvasCommandSurface['sceneEdits']['renameZone']>(() => true)
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface({ sceneEdits: { selectSpecies, clearSelection, renameZone } }),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
    await act(() => render(<><SelectionChip /><RenameZoneDialog /></>, container))
    await select([{ kind: 'zone', id: 'zone-z04' }, { kind: 'zone', id: RECT_ID }])
    expect(buttons()).toEqual(['Clear selection'])

    await select([{ kind: 'zone', id: RECT_ID }])
    await act(() => chip()!.querySelector<HTMLButtonElement>('button')!.click())
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(input.value).toBe('')
    await act(() => {
      input.value = '  Kitchen bed '
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(() => input.form!.requestSubmit())

    expect(renameZone).toHaveBeenCalledWith(RECT_ID, 'Kitchen bed')
    expect(renameZoneDialog.value).toBeNull()
  })

  it('a mouse click on Rename… opens the dialog (a finger\'s trailing click is the DOM input source\'s)', async () => {
    await act(() => render(<><SelectionChip /><RenameZoneDialog /></>, container))
    await select([{ kind: 'zone', id: RECT_ID }])
    const rename = [...chip()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Rename…')!

    await act(() => {
      rename.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }))
      rename.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      rename.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(renameZoneDialog.value).not.toBeNull()
  })

  it('names a text note by its text and a measurement by its length', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'annotation', id: 'note-1' }])
    expect(status()).toBe('Text note · Mulch in November')
    await select([{ kind: 'measurement-guide', id: GUIDE_ID }])
    expect(status()).toBe('Measurement · 5 m')
  })

  it('names a zone and summarises a mixed selection', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'zone', id: 'zone-z04' }])
    expect(status()).toContain('Zone · Z04')
    expect(buttons()).toEqual(['Dimensions', 'Rename…', 'Clear selection'])

    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'fig-1' }, { kind: 'zone', id: 'zone-z04' }, { kind: 'annotation', id: 'note-1' }])
    expect(status()).toBe('4 selected · 2 plants · 1 zone · 1 text note')
  })

  it('follows the language', async () => {
    await act(() => render(<SelectionChip />, container))
    await select([{ kind: 'plant', id: 'apricot-1' }, { kind: 'plant', id: 'fig-1' }])
    await act(() => { locale.value = 'fr' })
    expect(status()).toBe('2 plantes · 2 espèces · espacées de 15 m')
    expect(buttons()).toEqual(['Effacer la sélection'])
  })

  it('sits apart from the finder chip: a separate bottom chip in the visible map area', async () => {
    plantFinderMapMatches.value = { query: 'apri', canonicalNames: ['Prunus armeniaca'] }
    await act(() => render(<><SpeciesFocusChip /><SelectionChip /></>, container))
    await select([{ kind: 'plant', id: 'apricot-1' }])
    const finder = container.querySelector('[aria-label="Plants highlighted on the map"]')
    expect(finder).not.toBeNull()
    expect(finder!.contains(chip())).toBe(false)
    expect(chip()!.dataset.selectionChip).toBe('bottom')
  })

  it('never shows an object id, whatever is selected', async () => {
    await act(() => render(<SelectionChip />, container))
    const scene = queries.getSceneSnapshot()
    const ids = [
      ...scene.plants.map((plant) => plant.id),
      ...scene.zones.map((zone) => zone.id),
      ...scene.annotations.map((note) => note.id),
      ...scene.measurementGuides.map((guide) => guide.id),
      ...scene.groups.map((group) => group.id),
    ]
    const targets: SceneDesignObjectSelection = [
      ...scene.plants.map((plant) => ({ kind: 'plant' as const, id: plant.id })),
      ...scene.zones.map((zone) => ({ kind: 'zone' as const, id: zone.id })),
      ...scene.annotations.map((note) => ({ kind: 'annotation' as const, id: note.id })),
      ...scene.measurementGuides.map((guide) => ({ kind: 'measurement-guide' as const, id: guide.id })),
      { kind: 'group' as const, id: 'guild' },
    ]
    const selections: SceneDesignObjectSelection[] = [
      ...targets.map((target) => [target]),
      targets,
      targets.filter((target) => target.kind === 'zone'),
      [{ kind: 'group', id: 'guild' }, { kind: 'annotation', id: 'note-1' }],
    ]
    for (const selection of selections) {
      await select(selection)
      const text = chip()!.textContent ?? ''
      for (const id of ids) expect(text).not.toContain(id)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
    }
  })
})
