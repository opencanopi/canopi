// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ToolId } from '../canvas/runtime/interaction-types'
import { locale, scrollWheel } from '../app/settings/state'
import { t } from '../i18n'
import { activePanel, sidePanel } from '../app/shell/state'
import { phoneLayout } from '../app/shell/phone-layout'
import { ToolCard } from '../components/canvas/ToolCard'
import { armCanvasTool } from '../app/keyboard/arming'
import { focusOwner } from '../app/keyboard/focus-owner'
import { parseSavedObjectStampPayload } from '../canvas/saved-object-stamp-payload'
import { StampChooser } from '../components/canvas/StampChooser'
import { clearPlantStampSource, selectPlantStampSource } from '../canvas/plant-stamp-source'
import {
  clearSavedObjectStampSource,
} from '../canvas/saved-object-stamp-source'
import { setCurrentCanvasSession } from '../canvas/session'
import {
  IDLE_CANVAS_TOOL_GUIDANCE,
  setCanvasTool,
  setCanvasToolGuidance,
  type CanvasPlantRowGuidance,
  type CanvasToolGuidance,
} from '../canvas/session-state'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
  createTestCanvasKeyboardPort,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { hoveredTooltip } from './support/tooltip'
import { beforePaint, holdAfterPaint } from './support/before-paint'
import type * as SiteOnboardingStateModule from '../app/site-onboarding/state'
import type * as SavedObjectStampsModule from '../ipc/saved-object-stamps'
import type { SavedObjectStamp } from '../types/saved-object-stamps'
import { savedObjectStampWorkbench } from '../app/saved-object-stamps'

const locating = vi.hoisted(() => ({ open: null as null | { value: boolean } }))
vi.mock('../app/site-onboarding/state', async (importOriginal) => {
  const original = await importOriginal<typeof SiteOnboardingStateModule>()
  const { signal } = await import('@preact/signals')
  const open = signal(false)
  locating.open = open
  return { ...original, siteLocateOpen: open }
})

const savedStamps = vi.hoisted(() => ({ items: [] as SavedObjectStamp[], loaded: Promise.resolve() }))
vi.mock('../ipc/saved-object-stamps', async (importOriginal) => ({
  ...(await importOriginal<typeof SavedObjectStampsModule>()),
  getSavedObjectStamps: vi.fn(async () => { await savedStamps.loaded; return savedStamps.items }),
}))

function savedStamp(id: string, name: string, canonicalNames: readonly string[]) {
  return {
    id,
    name,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    payload_json: JSON.stringify({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: canonicalNames.map((canonicalName, index) => ({
        id: `${id}-${index}`, canonicalName, commonName: null, color: null, position: { x: index, y: 0 }, rotationDeg: null, scale: null,
      })),
      zones: [],
      annotations: [],
      groups: [],
    }),
  }
}

const APPLE = { canonical_name: 'Malus domestica', common_name: 'Apple', stratum: 'high', width_max_m: 6 }

describe('Tool card', () => {
  let container: HTMLDivElement

  beforeEach(async () => {
    locale.value = 'en'
    scrollWheel.value = 'zoom'
    container = document.createElement('div')
    document.body.append(container)
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries: createTestCanvasQuerySurface(),
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
    await act(() => render(<ToolCard />, container))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCanvasTool('select')
    setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    clearPlantStampSource()
    clearSavedObjectStampSource()
    locating.open!.value = false
    setCurrentCanvasSession(null)
    sidePanel.value = null
    activePanel.value = 'canvas'
  })

  async function choose(tool: ToolId, guidance: Partial<CanvasToolGuidance> = {}): Promise<void> {
    await act(() => {
      setCanvasTool(tool)
      setCanvasToolGuidance({ ...IDLE_CANVAS_TOOL_GUIDANCE, ...guidance })
    })
  }

  const card = () => container.querySelector<HTMLElement>('[data-tool-card]')
  const live = () => container.querySelector<HTMLElement>('[role="status"]')!
  const lines = () => [...live().children].map((line) => line.textContent)

  it('while Pan is armed its card reads Drag to move the map', async () => {
    await choose('hand')
    expect(card()!.dataset.toolCard).toBe('hand')
    expect(card()!.getAttribute('aria-label')).toBe('Pan')
    expect(lines()).toEqual(['Pan', 'Drag to move the map', 'Esc to go back to Select'])
    expect(live().getAttribute('aria-live')).toBe('polite')
  })

  it('the Select card follows the pointing device', async () => {
    expect(card()!.dataset.toolCard).toBe('select')
    expect(card()!.getAttribute('aria-label')).toBe('Select')
    // Mouse (stored scroll_wheel 'zoom').
    expect(lines()).toEqual(['Select', 'Drag to select · Shift-click adds · Alt-click removes · right-drag pans · wheel zooms'])
    expect(live().querySelector('b')).toBeNull()

    // Trackpad (stored 'pan').
    await act(() => { scrollWheel.value = 'pan' })
    expect(lines()).toEqual(['Select', 'Drag to select · Shift-click adds · Alt-click removes · two fingers pan · pinch zooms'])

    await act(() => { locale.value = 'fr' })
    expect(lines()).toEqual(['Sélection', 'Glisser pour sélectionner · Maj-clic ajoute · Alt-clic retire · deux doigts déplacent la carte · pincement zoome'])
  })

  it('on a coarse pointer (a touch screen) the Select card names two fingers and a pinch, whatever the pointing device', async () => {
    render(null, container)
    let coarse = true
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === '(pointer: coarse)' && coarse },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }))
    try {
      await act(() => render(<ToolCard />, container))
      expect(lines()).toEqual(['Select', 'Drag to select · Shift-click adds · Alt-click removes · two fingers pan · pinch zooms'])
      // A mouse plugged into a tablet makes the pointer fine again.
      await act(() => { coarse = false; for (const listener of listeners) listener() })
      expect(lines()).toEqual(['Select', 'Drag to select · Shift-click adds · Alt-click removes · right-drag pans · wheel zooms'])
    } finally {
      render(null, container)
      vi.unstubAllGlobals()
    }
  })

  it('names the species for Place plants, offers Change species and says Esc stops placing', async () => {
    selectPlantStampSource(APPLE)
    await choose('plant-stamp')

    expect(card()!.getAttribute('aria-label')).toBe('Place plants')
    // The species takes its own line, so the instruction never breaks around it.
    expect(lines()).toEqual(['Place plants', 'Apple', 'click the map to place one', 'Esc to stop placing'])
    expect(live().querySelector('b')?.textContent).toBe('Apple')
    expect(card()!.querySelector('button')?.textContent).toBe('Change species')
  })

  // canopi-f47t.52.228.20: the chooser took focus after paint (Preact 11 useEffect), so in WebKit an Esc in between reached
  // the canvas's tool layer and put Place plants away instead of only closing the chooser.
  it('canopi-f47t.52.228.20: Change species has focus in the chooser and closes it on Esc before any after-paint work', async () => {
    selectPlantStampSource(APPLE)
    await choose('plant-stamp')
    const release = holdAfterPaint()
    try {
      // A click as WebKit gives it: the link is not focused.
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Change species')!.click()
      await beforePaint()
      const input = card()!.querySelector('input')
      expect(input, 'the chooser shows').not.toBeNull()
      expect(document.activeElement, 'focus is in the chooser as it first shows').toBe(input)
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await beforePaint()
      expect(card()!.querySelector('input'), 'Esc closed the chooser').toBeNull()
      expect(card()!.getAttribute('aria-label'), 'and kept Place plants').toBe('Place plants')
    } finally {
      release()
    }
  })

  it('names a species with no name in the interface language by its English name, marked', async () => {
    await act(() => {
      locale.value = 'fr'
      setCurrentCanvasSession({
        commands: createTestCanvasCommandSurface(),
        queries: createTestCanvasQuerySurface({ englishFallbackNames: new Map([['Malus domestica', 'Apple']]) }),
        documents: createTestCanvasDocumentSurface(),
        keyboard: createTestCanvasKeyboardPort(),
      })
    })
    selectPlantStampSource({ ...APPLE, common_name: null })
    await choose('plant-stamp')

    const subject = live().querySelector('b')!
    expect(subject.querySelector('[lang="en"]')?.textContent).toBe('Apple')
    expect(subject.textContent).toContain(t('speciesName.englishMark'))
    expect(subject.textContent).toContain(t('speciesName.englishFallbackNote'))
  })

  it('prefers the name in the interface language over the one saved with the source', async () => {
    await act(() => {
      locale.value = 'fr'
      setCurrentCanvasSession({
        commands: createTestCanvasCommandSurface(),
        queries: createTestCanvasQuerySurface({ localizedNames: new Map([['Malus domestica', 'Pommier']]) }),
        documents: createTestCanvasDocumentSurface(),
        keyboard: createTestCanvasKeyboardPort(),
      })
    })
    selectPlantStampSource(APPLE)
    await choose('plant-stamp')
    expect(live().querySelector('b')?.textContent).toBe('Pommier')
  })

  it('leads the card with the species glyph in the colour and symbol a click places', async () => {
    await act(() => {
      setCurrentCanvasSession({
        commands: createTestCanvasCommandSurface(),
        queries: createTestCanvasQuerySurface({
          scene: {
            ...createDefaultScenePersistedState(),
            plantSpeciesColors: { 'Malus domestica': '#b06045' },
            plantSpeciesSymbols: { 'Malus domestica': 'apple' },
          },
        }),
        documents: createTestCanvasDocumentSurface(),
        keyboard: createTestCanvasKeyboardPort(),
      })
    })
    selectPlantStampSource(APPLE)
    await choose('plant-stamp')

    const lead = card()!.querySelector<HTMLElement>('[data-tool-card-lead]')!
    expect(lead.getAttribute('aria-hidden')).toBe('true')
    expect(lead.querySelector('svg')?.getAttribute('data-plant-symbol')).toBe('apple')
    expect(lead.style.color).toBe('rgb(176, 96, 69)')

    // No species yet: no glyph.
    await act(() => { clearPlantStampSource() })
    expect(card()!.querySelector('[data-tool-card-lead]')).toBeNull()
  })

  it('leads a stamp card with the stamp icon, and drawing tools with none', async () => {
    await choose('object-stamp', { stamp: { kind: 'group', name: 'Pear guild', plants: 10, species: 4 } })
    expect(card()!.querySelector('[data-tool-card-lead="stamp"] svg')).not.toBeNull()
    await choose('polygon')
    expect(card()!.querySelector('[data-tool-card-lead]')).toBeNull()
  })

  it('announces a tool change in the same live region', async () => {
    const region = live()
    await choose('polygon')
    expect(live()).toBe(region)
    expect(region.textContent).toContain('Polygon zone')

    await choose('measurement-guide')
    expect(live()).toBe(region)
    expect(lines()[0]).toBe('Measure')
  })

  it('switches the Esc meaning to removing the last point while a polygon is being drawn (U58)', async () => {
    await choose('polygon')
    expect(lines()).toEqual([
      'Polygon zone',
      'Click to add corners. Click the first corner, double-click or press Enter to finish.',
      'Shift keeps 45° angles · Esc to go back to Select',
    ])

    await choose('polygon', { gesture: true })
    expect(lines()[2]).toBe('Shift keeps 45° angles · Esc or Backspace removes the last corner')
  })

  it('tells how to draw a profile line and switches the Esc meaning to removing the last point while one is drawn (canopi-f47t.42, U58)', async () => {
    await choose('profile')
    expect(lines()).toEqual([
      'Profile',
      'Click to add points. Double-click or press Enter to finish.',
      'Shift keeps 45° angles · Esc to go back to Select',
    ])

    await choose('profile', { gesture: true })
    expect(lines()[2]).toBe('Shift keeps 45° angles · Esc or Backspace removes the last point')
  })

  it.each([
    ['rectangle', 'Rectangle zone', 'Drag across the map to draw the rectangle.', 'Shift draws a square'],
    ['ellipse', 'Ellipse zone', 'Drag across the map to draw the ellipse.', 'Shift draws a circle'],
    ['line', 'Line zone', 'Drag along the map to draw the line.', 'Shift keeps 45° angles'],
    ['measurement-guide', 'Measure', 'Drag from one point to another to measure. The line stays as a guide.', 'Shift keeps 45° angles'],
  ] as const)('explains the %s gesture and what Shift does', async (tool, title, instruction, keys) => {
    await choose(tool)
    expect(lines()).toEqual([title, instruction, `${keys} · Esc to go back to Select`])
  })

  it('tells how to place a text note, then how to finish it', async () => {
    await choose('text')
    expect(lines()).toEqual(['Text note', 'Click the map where the note goes.', 'Esc to go back to Select'])

    await choose('text', { gesture: true })
    expect(lines()).toEqual([
      'Text note',
      'Type the note. Enter to finish.',
      'Shift Enter for a new line · Esc to cancel',
    ])
  })

  it('asks for an object to copy, then names the stamp with its plant and species counts', async () => {
    await choose('object-stamp')
    expect(lines()).toEqual(['Place a stamp', 'Click a plant, zone, note or group to copy it', 'Esc to stop placing'])

    await choose('object-stamp', { stamp: { kind: 'group', name: 'Pear guild', plants: 10, species: 4 }, stampRotationDeg: 0 })
    expect(lines().slice(1, 3)).toEqual(['Pear guild', '10 plants · 4 species · click to place'])

    await choose('object-stamp', { stamp: { kind: 'zone', name: null, plants: 0, species: 0 } })
    expect(lines().slice(1, 3)).toEqual(['Zone', 'click to place'])
  })

  it('tells how to turn a held stamp and shows its angle once turned', async () => {
    const guild = { kind: 'group', name: 'Pear guild', plants: 10, species: 4 } as const
    // A held pick: the first Esc clears it.
    await choose('object-stamp', { stamp: guild, stampRotationDeg: 0 })
    expect(lines().slice(1)).toEqual(['Pear guild', '10 plants · 4 species · click to place', '[ and ] rotate by 15° · Esc to clear the stamp'])

    await choose('object-stamp', { stamp: guild, stampRotationDeg: 30 })
    expect(lines().slice(1)).toEqual(['Pear guild', '10 plants · 4 species · turned 30° · click to place', '[ and ] rotate by 15° · Esc to clear the stamp'])
  })

  describe('Change stamp', () => {
    // The live workbench keeps the last list it read, and the chooser shows a list read before at once; reading the
    // empty list again leaves each test's chooser loading as it opens, in any shuffled order.
    afterEach(async () => {
      savedStamps.items = []
      savedStamps.loaded = Promise.resolve()
      await act(() => savedObjectStampWorkbench.loadLibrary())
    })

    it('opens a chooser of saved stamps that arms the chosen one and gives the map focus back', async () => {
      savedStamps.items = [savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica', 'Rubus idaeus']), savedStamp('stamp-2', '', ['Malus domestica'])]
      const setTool = vi.fn((tool: ToolId) => setCanvasTool(tool))
      const map = document.createElement('div')
      map.tabIndex = 0
      document.body.append(map)
      const releaseMap = focusOwner.registerRegion('map', map)
      setCurrentCanvasSession({
        commands: createTestCanvasCommandSurface({ tools: { setTool } }),
        queries: createTestCanvasQuerySurface(),
        documents: createTestCanvasDocumentSurface(),
        keyboard: createTestCanvasKeyboardPort(),
      })
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })

      const link = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change stamp')!
      await act(() => link.click())
      await vi.waitFor(() => expect(container.querySelectorAll('[data-stamp-option]')).toHaveLength(2))
      const options = [...container.querySelectorAll<HTMLButtonElement>('[data-stamp-option]')]
      expect(options.map((option) => option.textContent)).toEqual(['Guilde pommier2 plants · 2 species', 'Untitled stamp1 plant'])
      // Focus went to Copy an object on the map as the chooser opened, and the list arriving leaves it there.
      expect(document.activeElement?.textContent).toBe('Copy an object on the map')

      await act(() => options[0]!.click())
      expect(setTool).toHaveBeenLastCalledWith('saved-object-stamp')
      expect(container.querySelector('[data-stamp-chooser]')).toBeNull()
      expect(document.activeElement).toBe(map)
      expect(lines()[1]).toBe('Guilde pommier')
      releaseMap()
      map.remove()
    })

    it('canopi-f47t.52.228.20: Change stamp has focus in the chooser from its first painted frame, and Esc closes it', async () => {
      savedStamps.items = [savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica'])]
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
      const release = holdAfterPaint()
      try {
        // A click as WebKit gives it: Change stamp is not focused, and unmounts.
        ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Change stamp')!.click()
        await beforePaint()
        const chooser = container.querySelector('[data-stamp-chooser]')!
        expect(document.activeElement, 'its first button has focus as it first shows').toBe(chooser.querySelector('button'))
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await beforePaint()
        expect(container.querySelector('[data-stamp-chooser]'), 'Esc closed the chooser').toBeNull()
      } finally {
        release()
      }
    })

    it('canopi-f47t.52.228.20: a click that left focus on the map, as Safari and WebKit do, still ends in the chooser, and the list arriving leaves it there', async () => {
      savedStamps.items = [savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica'])]
      let finishLoading!: () => void
      savedStamps.loaded = new Promise((resolve) => { finishLoading = resolve })
      const map = document.createElement('div')
      map.tabIndex = 0
      document.body.append(map)
      try {
        await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
        await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
        map.focus()
        // A click that does not focus the button it lands on, as in Safari and WKWebView.
        await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Change stamp')!.click())
        const opened = document.activeElement
        expect(container.querySelector('[data-stamp-chooser]')!.querySelector('button'), 'focus is on the chooser\'s first button').toBe(opened)
        await act(async () => { finishLoading(); await savedStamps.loaded })
        await vi.waitFor(() => expect(container.querySelector('[data-stamp-option="stamp-1"]')).not.toBeNull())
        expect(document.activeElement, 'the list arriving moved no focus').toBe(opened)
      } finally {
        map.remove()
      }
    })

    // canopi-f47t.52.228.20 (Desktop live check): the chooser took focus only once its list loaded, so an Esc pressed
    // while it still read the saved stamps fell through to the tool and put Place a stamp away.
    it('canopi-f47t.52.228.20: an Esc while the list loads closes only the chooser and keeps Place a stamp', async () => {
      savedStamps.items = [savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica'])]
      let finishLoading!: () => void
      savedStamps.loaded = new Promise((resolve) => { finishLoading = resolve })
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
      await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Change stamp')!.click())
      try {
        expect(container.querySelector('[data-stamp-chooser]')!.contains(document.activeElement), 'focus is in the loading chooser').toBe(true)
        await act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
        expect(container.querySelector('[data-stamp-chooser]'), 'Esc closed the chooser').toBeNull()
        expect(card()!.getAttribute('aria-label'), 'and kept Place a stamp').toBe('Place a stamp')
      } finally {
        await act(async () => { finishLoading(); await savedStamps.loaded })
      }
    })

    // canopi-f47t.52.228.20 (review): a reopened chooser shows the stamps it read before at once and reads them again;
    // a Tab to another stamp before that read ends must not be undone when it does.
    it('canopi-f47t.52.228.20: a stamp the user moved to in a reopened chooser keeps focus when the list is read again', async () => {
      savedStamps.items = [savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica']), savedStamp('stamp-2', 'Haie', ['Rubus idaeus'])]
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
      const changeStamp = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Change stamp')!
      await act(() => changeStamp().click())
      await vi.waitFor(() => expect(container.querySelector('[data-stamp-option="stamp-2"]')).not.toBeNull())
      await act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(container.querySelector('[data-stamp-chooser]')).toBeNull()

      let finishLoading!: () => void
      savedStamps.loaded = new Promise((resolve) => { finishLoading = resolve })
      await act(() => changeStamp().click())
      expect(document.activeElement, 'the stamps read before show, the first focused').toBe(container.querySelector('[data-stamp-option="stamp-1"]'))
      const second = container.querySelector<HTMLButtonElement>('[data-stamp-option="stamp-2"]')!
      second.focus()
      await act(async () => { finishLoading(); await savedStamps.loaded })
      await act(async () => {})
      expect(document.activeElement, 'the stamp the user moved to keeps focus').toBe(container.querySelector('[data-stamp-option="stamp-2"]'))
    })

    it('canopi-f47t.52.228.20: a list that loads after the user moved on leaves their focus where it is', async () => {
      savedStamps.items = [savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica'])]
      let finishLoading!: () => void
      savedStamps.loaded = new Promise((resolve) => { finishLoading = resolve })
      const field = document.createElement('input')
      document.body.append(field)
      try {
        await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
        await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
        await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Change stamp')!.click())
        field.focus()
        await act(async () => { finishLoading(); await savedStamps.loaded })
        await vi.waitFor(() => expect(container.querySelector('[data-stamp-option="stamp-1"]')).not.toBeNull())
        expect(document.activeElement, 'focus stays in the field the user chose').toBe(field)
      } finally {
        field.remove()
      }
    })

    it('leaves out a stamp saved before 2.0, which Canopi 2.0 cannot place', async () => {
      const before2_0 = savedStamp('stamp-old', 'Old guild', ['Malus domestica'])
      savedStamps.items = [
        { ...before2_0, payload_json: JSON.stringify({ ...JSON.parse(before2_0.payload_json), version: 1 }) },
        savedStamp('stamp-1', 'Guilde pommier', ['Malus domestica']),
      ]
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
      const link = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change stamp')!
      await act(() => link.click())
      await vi.waitFor(() => expect(container.querySelector('[data-stamp-option="stamp-1"]')).not.toBeNull())
      expect([...container.querySelectorAll<HTMLElement>('[data-stamp-option]')].map((option) => option.dataset.stampOption)).toEqual(['stamp-1'])

      // With only stamps from before 2.0, the chooser says there is nothing to place.
      savedStamps.items = [savedStamps.items[0]!]
      await act(() => { render(null, container) })
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('select')
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
      const again = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change stamp')!
      await act(() => again.click())
      await vi.waitFor(() => expect(container.querySelector('[data-stamp-chooser]')?.textContent).toContain('No saved stamps'))
      expect(container.querySelector('[data-stamp-option]')).toBeNull()
    })

    it('is not offered where the edition keeps no saved stamps (Web)', async () => {
      await choose('object-stamp', { stamp: { kind: 'plant', name: 'Apple', plants: 1, species: 1 }, stampRotationDeg: 0 })
      expect([...container.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Change stamp')
    })

    it('offers copying an object from the map instead, and closes on Esc', async () => {
      const setTool = vi.fn((tool: ToolId) => setCanvasTool(tool))
      setCurrentCanvasSession({
        commands: createTestCanvasCommandSurface({ tools: { setTool } }),
        queries: createTestCanvasQuerySurface(),
        documents: createTestCanvasDocumentSurface(),
        keyboard: createTestCanvasKeyboardPort(),
      })
      await act(() => render(<ToolCard stampChooser={StampChooser} />, container))
      await choose('object-stamp')
      // Before anything is picked the card offers the saved stamps.
      const link = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Choose a saved stamp')!
      await act(() => link.click())
      await vi.waitFor(() => expect(container.querySelector('[data-stamp-chooser]')?.textContent).toContain('No saved stamps yet'))

      const copy = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy an object on the map')!
      await act(() => copy.click())
      // Leaving and re-arming Place a stamp drops what it held, so the next click picks again.
      expect(setTool.mock.calls.map(([tool]) => tool)).toEqual(['select', 'object-stamp'])
      expect(container.querySelector('[data-stamp-chooser]')).toBeNull()

      // The chooser replaced the link, so Preact made a new one when it closed.
      await act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Choose a saved stamp')!.click())
      const chooser = container.querySelector<HTMLElement>('[data-stamp-chooser]')!
      await act(() => { chooser.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(container.querySelector('[data-stamp-chooser]')).toBeNull()
    })
  })

  it('names a saved stamp from Favorites with its counts', async () => {
    await act(() => {
      const stamp = parseSavedObjectStampPayload(JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [
          { id: 'a', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, position: { x: 0, y: 0 }, rotationDeg: null, scale: null },
          { id: 'b', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, position: { x: 1, y: 0 }, rotationDeg: null, scale: null },
          { id: 'c', canonicalName: 'Rubus idaeus', commonName: 'Raspberry', color: null, position: { x: 2, y: 0 }, rotationDeg: null, scale: null },
        ],
        zones: [],
        annotations: [],
        groups: [],
      }))!
      armCanvasTool('saved-object-stamp', { from: 'panel', source: { kind: 'saved-stamp', stamp, name: 'Guilde pommier' } })
    })

    expect(lines()).toEqual(['Place a stamp', 'Guilde pommier', '3 plants · 2 species · click to place', '[ and ] rotate by 15° · Esc to stop placing'])
  })

  describe('Plant a row', () => {
    const ROW: CanvasPlantRowGuidance = {
      phase: 'row', plantName: 'Apple', glyph: { symbol: 'berry', color: '#ab5268' }, interval: '50 cm', intervalValid: true, count: null, density: 'normal', focusRequest: 1,
    }
    const field = () => container.querySelector<HTMLInputElement>('[data-plant-spacing-interval-input]')
    const count = () => container.querySelector<HTMLElement>('[data-plant-spacing-generated-count]')
    let spacing: {
      input: Mock<(text: string) => void>
      commit: Mock<(text: string) => void>
      blur: Mock<(text: string) => void>
      cancel: Mock<() => void>
    }
    let path: {
      finish: Mock<() => void>
      setMode: Mock<(mode: 'interval' | 'count') => void>
    }

    beforeEach(async () => {
      spacing = { input: vi.fn(), commit: vi.fn(), blur: vi.fn(), cancel: vi.fn() }
      path = { finish: vi.fn(), setMode: vi.fn() }
      await act(() => {
        setCurrentCanvasSession({
          commands: createTestCanvasCommandSurface({ tools: { plantRowSpacing: spacing, plantRowPath: path } }),
          queries: createTestCanvasQuerySurface(),
          documents: createTestCanvasDocumentSurface(),
          keyboard: createTestCanvasKeyboardPort(),
        })
      })
    })

    it('asks for a plant to repeat in the shared card, then says a missed click needs a usable plant', async () => {
      await choose('plant-spacing', { plantRow: { ...ROW, phase: 'pick', plantName: null, glyph: null, focusRequest: 0 } })
      expect(card()!.getAttribute('data-tool-card')).toBe('plant-spacing')
      expect(lines()).toEqual(['Plant a row', 'Click a placed plant to repeat it along a row', 'Esc to go back to Select'])
      expect(field()).toBeNull()

      await choose('plant-spacing', { plantRow: { ...ROW, phase: 'missed', plantName: null, glyph: null, focusRequest: 0 } })
      expect(lines()).toEqual(['Plant a row', 'Click a visible, unlocked placed plant', 'Esc to go back to Select'])
    })

    it('names the picked plant, holds the spacing field and counts the row with its density', async () => {
      await choose('plant-spacing', { gesture: true, plantRow: ROW })
      expect(lines().slice(1, 3)).toEqual(['Apple', 'drag along the row'])
      expect(live().querySelector('b')?.textContent).toBe('Apple')
      const lead = card()!.querySelector<HTMLElement>('[data-tool-card-lead]')!
      expect(lead.querySelector('svg')?.getAttribute('data-plant-symbol')).toBe('berry')
      expect(lead.style.color).toBe('rgb(171, 82, 104)')
      expect(live().textContent).toContain('Shift keeps 45° angles · Ctrl turns off snapping · Esc to clear the row')
      const input = field()!
      expect(input.value).toBe('50 cm')
      expect(input.getAttribute('inputmode')).toBe('decimal')
      expect(input.getAttribute('aria-invalid')).toBe('false')
      expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Interval')
      expect(count()).toBeNull()

      await choose('plant-spacing', { gesture: true, plantRow: { ...ROW, count: 3 } })
      expect(count()!.textContent).toBe('3 generated')
      expect(count()!.dataset.density).toBe('normal')
      // The count changes with every pointer move, so it is not announced.
      expect(count()!.closest('[aria-live="off"]')).not.toBeNull()

      await choose('plant-spacing', { gesture: true, plantRow: { ...ROW, count: 140, density: 'dense' } })
      expect(count()!.dataset.density).toBe('dense')

      await choose('plant-spacing', { gesture: true, plantRow: { ...ROW, count: 6000, density: 'blocked', intervalValid: false } })
      expect(count()!.textContent).toBe('6000 generated · Increase interval or shorten the line')
      expect(count()!.dataset.density).toBe('blocked')
      expect(field()!.getAttribute('aria-invalid')).toBe('true')
    })

    it('focuses the spacing field on request and drives it from the keyboard', async () => {
      await choose('plant-spacing', { gesture: true, plantRow: ROW })
      const input = field()!
      expect(document.activeElement).toBe(input)

      input.value = '0,75m'
      await act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
      expect(spacing.input).toHaveBeenCalledWith('0,75m')

      const onWindowKeyDown = vi.fn()
      window.addEventListener('keydown', onWindowKeyDown)
      try {
        await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(spacing.commit).toHaveBeenCalledWith('0,75m')
        await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
        expect(spacing.cancel).toHaveBeenCalledOnce()
        // Enter and Esc belong to the field; other keys (Ctrl S) still reach the shortcuts.
        expect(onWindowKeyDown).not.toHaveBeenCalled()
        await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })) })
        expect(onWindowKeyDown).toHaveBeenCalledOnce()
      } finally {
        window.removeEventListener('keydown', onWindowKeyDown)
      }

      // Enter and Esc that end an IME composition are the IME's (keyCode 229 is WebKit's commit).
      const commits = spacing.commit.mock.calls.length
      const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
      const committing = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      Object.defineProperty(committing, 'keyCode', { value: 229 })
      await act(() => { input.dispatchEvent(composing) })
      await act(() => { input.dispatchEvent(committing) })
      expect([composing.defaultPrevented, committing.defaultPrevented]).toEqual([false, false])
      expect(spacing.commit).toHaveBeenCalledTimes(commits)
      expect(spacing.cancel).toHaveBeenCalledOnce()

      // Leaving the field keeps a valid spacing without moving focus.
      const typed = input.value
      await act(() => { input.blur() })
      expect(spacing.blur).toHaveBeenCalledWith(typed)

      // An invalid spacing kept on Enter asks for the field again.
      const other = document.createElement('button')
      document.body.append(other)
      other.focus()
      await choose('plant-spacing', { gesture: true, plantRow: { ...ROW, intervalValid: false, focusRequest: 2 } })
      expect(document.activeElement).toBe(field())
      other.remove()
    })

    describe('along a path (U58)', () => {
      const PATH: CanvasPlantRowGuidance = {
        ...ROW, focusRequest: 0, count: 7, points: 3, closed: false, mode: 'interval', countText: '', countValid: true,
        length: '14 m', loopSpacing: null, touch: false,
      }
      const finish = () => container.querySelector<HTMLButtonElement>('[data-plant-row-finish]')
      const modes = () => [...container.querySelectorAll<HTMLButtonElement>('[data-plant-row-mode]')]

      it('keeps the straight row\'s card while only the plant is picked', async () => {
        await choose('plant-spacing', { gesture: true, plantRow: { ...ROW, points: 1, mode: 'interval', length: null } })
        expect(lines().slice(1, 3)).toEqual(['Apple', 'drag along the row'])
        expect(live().textContent).toContain('Esc to clear the row')
        expect(finish()).toBeNull()
        expect(modes()).toEqual([])
        expect(container.querySelector('[data-plant-row-length]')).toBeNull()
      })

      it('tells how to draw and plant the path, offers the mode switch, and plants from the check button outside the live region', async () => {
        await choose('plant-spacing', { gesture: true, plantRow: PATH })
        expect(lines().slice(1, 3)).toEqual(['Apple', 'click to add points, Enter plants'])
        expect(live().textContent).toContain('Alt adds a sharp point · Shift keeps 45° angles · Ctrl turns off snapping · Esc or Backspace removes the last point')
        expect(modes().map((mode) => [mode.dataset.plantRowMode, mode.getAttribute('aria-pressed'), mode.textContent])).toEqual([
          ['interval', 'true', 'Interval'],
          ['count', 'false', 'Plants'],
        ])
        expect(modes()[0]!.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Spacing')
        expect(field()!.value).toBe('50 cm')

        // The length moves with the pointer: its own element, never announced.
        const length = container.querySelector<HTMLElement>('[data-plant-row-length]')!
        expect(length.textContent).toBe('Length 14 m')
        expect(length.getAttribute('aria-live')).toBe('off')
        expect(length.closest('[data-plant-spacing-generated-count]')).toBeNull()
        expect(live().contains(finish())).toBe(false)
        expect(finish()!.textContent).toBe('Plant the row')

        await act(() => { modes()[1]!.click() })
        expect(path.setMode).toHaveBeenCalledWith('count')
        await act(() => { finish()!.click() })
        expect(path.finish).toHaveBeenCalledOnce()
      })

      it('takes a count in Plants mode through the same field commands', async () => {
        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, mode: 'count', countText: '12', focusRequest: 3 } })
        const input = container.querySelector<HTMLInputElement>('[data-plant-row-count-input]')!
        expect(field()).toBeNull()
        expect(input.value).toBe('12')
        expect(input.getAttribute('inputmode')).toBe('numeric')
        expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Plants in the row')
        // A focus request the field has not taken yet (a fresh field's, here) focuses the count, as the pick's focuses the
        // interval; switching modes alone moves no focus.
        expect(document.activeElement).toBe(input)
        input.value = '5'
        await act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
        expect(spacing.input).toHaveBeenCalledWith('5')
        await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(spacing.commit).toHaveBeenCalledWith('5')

        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, mode: 'count', countText: '1', countValid: false } })
        expect(container.querySelector('[data-plant-row-count-input]')!.getAttribute('aria-invalid')).toBe('true')
      })

      it('keeps the focus on the mode switch as it switches, both ways; only a new focus request moves it to the field', async () => {
        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, focusRequest: 1 } })
        expect(document.activeElement).toBe(field())

        modes()[1]!.focus()
        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, focusRequest: 1, mode: 'count', countText: '8' } })
        expect(modes()[1]!.getAttribute('aria-pressed')).toBe('true')
        expect(document.activeElement, 'Interval to Plants').toBe(modes()[1])

        modes()[0]!.focus()
        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, focusRequest: 1 } })
        expect(modes()[0]!.getAttribute('aria-pressed')).toBe('true')
        expect(document.activeElement, 'Plants to Interval').toBe(modes()[0])

        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, focusRequest: 2 } })
        expect(document.activeElement).toBe(field())
      })

      it('shows a loop\'s rounded spacing; the foot holds the row\'s facts and the check button alone (decision 16: points are edited where they are)', async () => {
        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, closed: true, loopSpacing: '3.1 m' } })
        expect(container.querySelector('[data-plant-row-loop-spacing]')!.textContent).toBe('3.1 m')
        expect(container.querySelector('[data-plant-row-loop-spacing]')!.parentElement!.textContent).toBe('Equal gaps of 3.1 m')
        expect(container.querySelector('[data-plant-row-loop-spacing]')!.closest('[aria-live="off"]')).not.toBeNull()

        // The point menu (a long press or a right-click on a point), Alt+click and Delete edit points; the card offers no
        // point buttons.
        const foot = finish()!.closest('[data-path]')!
        expect([...foot.querySelectorAll('button')]).toEqual([finish()])
        expect(foot.textContent).toBe('7 generatedLength 14 mPlant the row')
      })

      it('gives a finger 44 px targets and the touch hint in place of the keys', async () => {
        await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, touch: true } })
        expect(card()!.hasAttribute('data-touch')).toBe(true)
        expect(lines().slice(1, 3)).toEqual(['Apple', 'tap to add points, double tap plants'])
        expect(lines().at(-1)).toBe('Drag a point to move it · drag a dot to add one · long press a point for more')

        await choose('plant-spacing', { gesture: true, plantRow: PATH })
        expect(card()!.hasAttribute('data-touch')).toBe(false)
      })

      it('on phones shows the check button as an icon, named and with its tooltip; elsewhere with its name', async () => {
        const shown = (button: HTMLButtonElement) => button.textContent
        try {
          phoneLayout.value = 'portrait'
          await choose('plant-spacing', { gesture: true, plantRow: PATH })
          expect(finish()!.getAttribute('aria-label')).toBe('Plant the row')
          expect(hoveredTooltip(finish()!)?.textContent).toBe('Plant the row')
          expect(shown(finish()!)).toBe('')
          expect(finish()!.querySelector('svg')).not.toBeNull()
        } finally {
          await act(() => { phoneLayout.value = null })
        }
        expect(shown(finish()!)).toBe('Plant the row')
        expect(hoveredTooltip(finish()!)).toBeNull()
      })
    })

    it('keeps the field, its text, focus and selection when the language changes', async () => {
      await choose('plant-spacing', { gesture: true, plantRow: { ...ROW, interval: '2 m', count: 3 } })
      const input = field()!
      input.focus()
      input.setSelectionRange(1, 3)

      await act(() => { locale.value = 'fr' })

      expect(field()).toBe(input)
      expect(input.value).toBe('2 m')
      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(1)
      expect(input.selectionEnd).toBe(3)
      expect(lines()[0]).toBe(t('canvas.tools.plantSpacing'))
      expect(lines()[0]).not.toBe('Plant a row')
      expect(count()!.textContent).toBe(t('canvas.plantSpacing.generatedCount', { count: 3 }))
    })
  })

  it('hides while "Where is your site?" shows and in overview', async () => {
    await choose('polygon')
    await act(() => { locating.open!.value = true })
    expect(card()).toBeNull()

    await act(() => {
      locating.open!.value = false
      setCurrentCanvasSession({
        commands: createTestCanvasCommandSurface(),
        queries: createTestCanvasQuerySurface({ placement: { x: 0, y: 0, scale: 0.01 } }),
        documents: createTestCanvasDocumentSurface(),
        keyboard: createTestCanvasKeyboardPort(),
      })
    })
    expect(card()).toBeNull()
  })
})
