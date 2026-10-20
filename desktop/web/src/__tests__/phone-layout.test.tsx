// @vitest-environment jsdom

import { render } from 'preact'
import { useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyPhoneLayout,
  cyclePhoneSheet,
  installPhoneLayout,
  phoneLayout,
  phoneSheetOpenHeight,
  phoneToolOptions,
  snapPhoneSheet,
  stepPhoneSheet,
  type PhoneLayout,
} from '../app/shell/phone-layout'
import {
  measureVisibleMapFrame,
  registerMapArea,
  registerMapOccluder,
  registerRail,
  toolRailRoom,
  visibleMapFrame,
} from '../app/shell/visible-map-area'
import { activePanel, navigateTo, selectPanel, sidePanel, type SidePanel } from '../app/shell/state'
import { locale } from '../app/settings/state'
import type { PanelRailCommand } from '../components/shared/PanelRail'
import { PHONE_SHEET_TABS, PhoneSheet } from '../components/shared/PhoneSheet'
import { browserPhoneSheetTabs } from '../web/browser-shell-commands'
import {
  WorkspaceComposition,
  type WorkspacePanelProjection,
  type WorkspaceSurfaces,
} from '../components/workspace/WorkspaceComposition'

const PANELS: readonly SidePanel[] = ['layers', 'species-key', 'plant-db', 'calendar', 'budget', 'stories']

function tabs(): PanelRailCommand[] {
  return PANELS.map((panel) => ({
    panel,
    id: `panel.${panel}`,
    label: panel,
    disabled: false,
    active: sidePanel.value === panel,
    action: () => navigateTo(panel),
  }))
}

function Sheet({ layout }: { readonly layout: PhoneLayout }) {
  const open = sidePanel.value
  return (
    <PhoneSheet layout={layout} tabs={tabs()}>
      {open ? <div data-panel-content={open} /> : null}
    </PhoneSheet>
  )
}

type Box = { left: number; top: number; width: number; height: number }

function rect({ left, top, width, height }: Box): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect
}

describe('phone layout', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    activePanel.value = 'canvas'
    sidePanel.value = null
    phoneLayout.value = null
    phoneSheetOpenHeight.value = 'half'
    phoneToolOptions.value = null
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    phoneLayout.value = null
    sidePanel.value = null
    phoneToolOptions.value = null
    vi.restoreAllMocks()
  })

  it('switches at phone sizes only: upright below 640 px, on its side when short and not wide', () => {
    expect(classifyPhoneLayout(390, 844)).toBe('portrait')
    expect(classifyPhoneLayout(639, 900)).toBe('portrait')
    expect(classifyPhoneLayout(844, 390)).toBe('landscape')
    expect(classifyPhoneLayout(600, 360)).toBe('landscape')
    expect(classifyPhoneLayout(640, 900)).toBeNull()
    expect(classifyPhoneLayout(768, 1024)).toBeNull()
    expect(classifyPhoneLayout(1024, 768)).toBeNull()
    expect(classifyPhoneLayout(1400, 450)).toBeNull()
    expect(classifyPhoneLayout(0, 0)).toBeNull()
  })

  it('follows the window across the breakpoint until its owner releases it', () => {
    const size = { innerWidth: 1280, innerHeight: 800 }
    const target = new EventTarget() as Window
    Object.defineProperties(target, {
      innerWidth: { get: () => size.innerWidth },
      innerHeight: { get: () => size.innerHeight },
    })
    const release = installPhoneLayout(target)
    expect(phoneLayout.value).toBeNull()

    size.innerWidth = 390
    size.innerHeight = 844
    target.dispatchEvent(new Event('resize'))
    expect(phoneLayout.value).toBe('portrait')

    size.innerWidth = 844
    size.innerHeight = 390
    target.dispatchEvent(new Event('orientationchange'))
    expect(phoneLayout.value).toBe('landscape')

    size.innerWidth = 1024
    size.innerHeight = 768
    target.dispatchEvent(new Event('resize'))
    expect(phoneLayout.value).toBeNull()

    size.innerWidth = 390
    size.innerHeight = 844
    target.dispatchEvent(new Event('resize'))
    release()
    expect(phoneLayout.value).toBeNull()
    target.dispatchEvent(new Event('resize'))
    expect(phoneLayout.value).toBeNull()
  })

  it('steps, cycles and snaps between peek, half and full', () => {
    expect(stepPhoneSheet('peek', 'ArrowUp')).toBe('half')
    expect(stepPhoneSheet('half', 'PageUp')).toBe('full')
    expect(stepPhoneSheet('full', 'ArrowUp')).toBe('full')
    expect(stepPhoneSheet('full', 'ArrowDown')).toBe('half')
    expect(stepPhoneSheet('half', 'PageDown')).toBe('peek')
    expect(stepPhoneSheet('peek', 'ArrowDown')).toBe('peek')
    expect(stepPhoneSheet('half', 'Home')).toBe('peek')
    expect(stepPhoneSheet('peek', 'End')).toBe('full')
    expect(stepPhoneSheet('half', 'Enter')).toBeNull()

    expect(cyclePhoneSheet('peek')).toBe('half')
    expect(cyclePhoneSheet('half')).toBe('full')
    expect(cyclePhoneSheet('full')).toBe('peek')

    const stops = { peek: 100, half: 422, full: 772 }
    expect(snapPhoneSheet(150, stops)).toBe('peek')
    expect(snapPhoneSheet(380, stops)).toBe('half')
    expect(snapPhoneSheet(640, stops)).toBe('full')
    // A flick carries on to the next stop past where it was let go.
    expect(snapPhoneSheet(460, stops, 1.2)).toBe('full')
    expect(snapPhoneSheet(400, stops, -1.2)).toBe('peek')
    expect(snapPhoneSheet(150, stops, 1.2)).toBe('half')
    expect(snapPhoneSheet(790, stops, 1.2)).toBe('full')
    expect(snapPhoneSheet(90, stops, -1.2)).toBe('peek')
  })

  it('rests at peek with its panel tabs and More, and opens a panel at half from a tab', async () => {
    await act(async () => { render(<Sheet layout="portrait" />, container) })
    const sheet = container.querySelector<HTMLElement>('[data-phone-sheet]')!
    expect(sheet.dataset.phoneSheet).toBe('peek')
    expect(sheet.dataset.orientation).toBe('portrait')
    const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabButtons.map((tab) => tab.textContent)).toEqual(['Layers', 'Plants', 'Catalog'])
    expect(tabButtons).toHaveLength(PHONE_SHEET_TABS)
    expect(container.querySelector('[data-sheet-more]')?.getAttribute('aria-label')).toBe('More panels')
    const handle = container.querySelector<HTMLButtonElement>('[data-sheet-handle]')!
    expect(handle.getAttribute('aria-label')).toBe('Show panels')
    expect(handle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="tabpanel"]')).toBeNull()

    await act(async () => { tabButtons[2]!.click() })
    expect(sidePanel.value).toBe('plant-db')
    expect(sheet.dataset.phoneSheet).toBe('half')
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Catalog')
    expect(container.querySelector('[role="tabpanel"] [data-panel-content="plant-db"]')).not.toBeNull()
    expect(handle.getAttribute('aria-label')).toBe('Expand panels')

    // A second press on the open tab rests the sheet, as the rail closes the dock.
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!.click() })
    expect(sidePanel.value).toBeNull()
    expect(sheet.dataset.phoneSheet).toBe('peek')
  })

  it('moves between heights with the 44 px handle: presses cycle, keys step, and peek closes the panel', async () => {
    await act(async () => { render(<Sheet layout="portrait" />, container) })
    const sheet = container.querySelector<HTMLElement>('[data-phone-sheet]')!
    const handle = container.querySelector<HTMLButtonElement>('[data-sheet-handle]')!

    // Raising the sheet with no panel opens the first tab.
    await act(async () => { handle.click() })
    expect(sidePanel.value).toBe('layers')
    expect(sheet.dataset.phoneSheet).toBe('half')
    await act(async () => { handle.click() })
    expect(sheet.dataset.phoneSheet).toBe('full')
    expect(handle.getAttribute('aria-label')).toBe('Hide panels')
    expect(handle.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { handle.click() })
    expect(sheet.dataset.phoneSheet).toBe('peek')
    expect(sidePanel.value).toBeNull()

    const key = async (name: string) => {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
      await act(async () => { handle.dispatchEvent(event) })
      return event
    }
    expect((await key('ArrowUp')).defaultPrevented).toBe(true)
    expect(sheet.dataset.phoneSheet).toBe('half')
    await key('ArrowUp')
    expect(sheet.dataset.phoneSheet).toBe('full')
    await key('ArrowDown')
    expect(sheet.dataset.phoneSheet).toBe('half')
    await key('End')
    expect(sheet.dataset.phoneSheet).toBe('full')
    // A panel reopened later keeps the height it was last given.
    await key('Home')
    expect(sheet.dataset.phoneSheet).toBe('peek')
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="tab"]')!.click() })
    expect(sheet.dataset.phoneSheet).toBe('full')
    expect((await key('Tab')).defaultPrevented).toBe(false)
  })

  it('shows a panel opened by any route in front of the tool\'s options: a tab, More, or a request from elsewhere', async () => {
    function WithOptions() {
      const open = sidePanel.value
      return (
        <PhoneSheet layout="portrait" tabs={tabs()} options={<p data-tool-options-content />}>
          {open ? <div data-panel-content={open} /> : null}
        </PhoneSheet>
      )
    }
    await act(async () => { render(<WithOptions />, container) })
    const sheet = container.querySelector<HTMLElement>('[data-phone-sheet]')!
    const optionsShown = () => container.querySelector('[data-sheet-panel="options"] [data-tool-options-content]') !== null
    const panelShown = (panel: SidePanel) => container.querySelector(`[role="tabpanel"]:not([hidden]) [data-panel-content="${panel}"]`) !== null
    const more = async (label: string) => {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-sheet-more]')!.click() })
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find((node) => node.textContent === label)!
      await act(async () => { item.click() })
    }

    await act(async () => { phoneToolOptions.value = 'half' })
    expect(optionsShown()).toBe(true)
    // A request from outside the sheet, as Place plants' chooser opens the catalog.
    await act(async () => { selectPanel('plant-db') })
    expect(optionsShown(), 'the catalog link closes the options').toBe(false)
    expect(panelShown('plant-db'), 'and shows the catalog').toBe(true)
    expect(sheet.dataset.phoneSheet).toBe('half')
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Catalog')

    // The same request with the catalog already open under the options, as when Place plants is armed from the catalog.
    await act(async () => { phoneToolOptions.value = 'half' })
    expect(optionsShown()).toBe(true)
    expect(panelShown('plant-db'), 'the catalog waits hidden under them').toBe(false)
    await act(async () => { selectPanel('plant-db') })
    expect(optionsShown(), 'the catalog link closes the options over the open catalog').toBe(false)
    expect(panelShown('plant-db'), 'and shows it').toBe(true)

    // A folded panel from More.
    await act(async () => { phoneToolOptions.value = 'half' })
    await more('budget')
    expect(optionsShown(), 'More closes the options').toBe(false)
    expect(panelShown('budget'), 'and shows its panel').toBe(true)

    // More on the panel already open, over the options, shows it, as its tab would, rather than closing it.
    await act(async () => { phoneToolOptions.value = 'half' })
    await more('budget')
    expect(sidePanel.value).toBe('budget')
    expect(optionsShown()).toBe(false)
    expect(panelShown('budget')).toBe(true)
  })

  it('gives the sheet back its panel as it was, its own state included, once the tool\'s options close', async () => {
    function Searchable() {
      const [search, setSearch] = useState('')
      return <input data-panel-search value={search} onInput={(event) => setSearch(event.currentTarget.value)} />
    }
    function WithOptions() {
      return (
        <PhoneSheet layout="portrait" tabs={tabs()} options={<p data-tool-options-content />}>
          {sidePanel.value ? <Searchable /> : null}
        </PhoneSheet>
      )
    }
    await act(async () => { render(<WithOptions />, container) })
    await act(async () => { selectPanel('plant-db') })
    const search = container.querySelector<HTMLInputElement>('[data-panel-search]')!
    await act(async () => {
      search.value = 'pear'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => { phoneToolOptions.value = 'half' })
    const panel = container.querySelector<HTMLElement>('[role="tabpanel"]')
    expect(container.querySelector('[data-sheet-panel="options"] [data-tool-options-content]'), 'the options show').not.toBeNull()
    expect(panel?.hidden ?? true, 'the panel is out of sight under them').toBe(true)

    await act(async () => { phoneToolOptions.value = null })
    expect(container.querySelector('[data-sheet-panel="options"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)
    expect(container.querySelector<HTMLInputElement>('[data-panel-search]')?.value, 'the panel kept its search').toBe('pear')
  })

  it('moves focus between the tabs with the arrow keys', async () => {
    await act(async () => { render(<Sheet layout="portrait" />, container) })
    const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabButtons.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
    tabButtons[0]!.focus()
    const press = async (key: string) => {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
    await press('ArrowRight')
    expect(document.activeElement).toBe(tabButtons[1])
    await press('End')
    expect(document.activeElement).toBe(tabButtons[2])
    await press('ArrowRight')
    expect(document.activeElement).toBe(tabButtons[0])
    await press('ArrowLeft')
    expect(document.activeElement).toBe(tabButtons[2])
    await press('Home')
    expect(document.activeElement).toBe(tabButtons[0])
  })

  it('snaps a drag on the handle to the nearest height in portrait', async () => {
    const host = document.createElement('div')
    container.appendChild(host)
    host.style.position = 'relative'
    await act(async () => { render(<Sheet layout="portrait" />, host) })
    const sheet = host.querySelector<HTMLElement>('[data-phone-sheet]')!
    const handle = host.querySelector<HTMLButtonElement>('[data-sheet-handle]')!
    Object.defineProperty(sheet, 'offsetParent', { get: () => host })
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, top: 0, width: 390, height: 844 }))
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, top: 744, width: 390, height: 100 }))

    const pointer = (type: string, clientY: number, timeStamp: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }) as MouseEvent & { pointerId: number }
      Object.defineProperty(event, 'pointerId', { value: 1 })
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      return event
    }
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 780, 0))
      document.dispatchEvent(pointer('pointermove', 600, 400))
    })
    expect(sheet.style.height).toBe('280px')
    expect(sheet.dataset.dragging).toBe('true')
    await act(async () => {
      document.dispatchEvent(pointer('pointerup', 460, 800))
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Let go at 420 px, nearest half: the first tab opens there, and the click ending the drag is no press.
    expect(sheet.style.height).toBe('')
    expect(sheet.dataset.dragging).toBeUndefined()
    expect(sidePanel.value).toBe('layers')
    expect(sheet.dataset.phoneSheet).toBe('half')
    render(null, host)
  })

  it('drags to full just below the top bar, whatever top status chrome (the lock toast, frames: false) shows', async () => {
    const host = document.createElement('div')
    container.appendChild(host)
    host.style.position = 'relative'
    const bar = document.createElement('div')
    const toast = document.createElement('div')
    document.body.append(bar, toast)
    await act(async () => { render(<Sheet layout="portrait" />, host) })
    const sheet = host.querySelector<HTMLElement>('[data-phone-sheet]')!
    const handle = host.querySelector<HTMLButtonElement>('[data-sheet-handle]')!
    Object.defineProperty(sheet, 'offsetParent', { get: () => host })
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, top: 0, width: 390, height: 844 }))
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, top: 744, width: 390, height: 100 }))
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, top: 0, width: 390, height: 60 }))
    vi.spyOn(toast, 'getBoundingClientRect').mockReturnValue(rect({ left: 95, top: 68, width: 200, height: 42 }))
    const releases = [registerMapArea(host), registerMapOccluder(bar, 'top'), registerMapOccluder(toast, 'top', { frames: false })]
    try {
      expect(visibleMapFrame.value.top).toBe(110)
      const pointer = (type: string, clientY: number, timeStamp: number) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }) as MouseEvent & { pointerId: number }
        Object.defineProperty(event, 'pointerId', { value: 1 })
        Object.defineProperty(event, 'timeStamp', { value: timeStamp })
        return event
      }
      await act(async () => {
        handle.dispatchEvent(pointer('pointerdown', 780, 0))
        document.dispatchEvent(pointer('pointermove', 0, 400))
      })
      // Full is the sheet's bottom less the top bar's 60 px and the 8 px gap; the toast takes none of it.
      expect(sheet.style.height).toBe(`${844 - 60 - 8}px`)
      await act(async () => { document.dispatchEvent(pointer('pointerup', 0, 800)) })
    } finally {
      for (const release of releases.reverse()) release()
      bar.remove()
      toast.remove()
      render(null, host)
    }
  })

  it('covers the bottom edge of the visible map in portrait, the right edge on its side (its corner at peek too), and ends the tool strip above it', async () => {
    const boxes = new Map<Element, Box>()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = boxes.get(this)
        ?? (this.dataset.phoneSheet
          ? this.dataset.orientation === 'portrait'
            ? { left: 0, top: this.dataset.phoneSheet === 'peek' ? 744 : 422, width: 390, height: this.dataset.phoneSheet === 'peek' ? 100 : 422 }
            : this.dataset.phoneSheet === 'peek'
              ? { left: 476, top: 278, width: 360, height: 104 }
              : { left: 476, top: 60, width: 360, height: 322 }
          : { left: 0, top: 0, width: 0, height: 0 })
      return rect(box)
    })
    const area = document.createElement('div')
    const strip = document.createElement('div')
    document.body.append(area, strip)
    boxes.set(area, { left: 0, top: 0, width: 390, height: 844 })
    boxes.set(strip, { left: 8, top: 68, width: 54, height: 250 })
    const releaseArea = registerMapArea(area)
    const releaseStrip = registerRail('tool', strip)

    await act(async () => { render(<Sheet layout="portrait" />, container) })
    expect(visibleMapFrame.value).toMatchObject({ bottom: 100, right: 0, left: 62 })
    expect(area.style.getPropertyValue('--map-inset-bottom')).toBe('100px')
    expect(toolRailRoom.value).toBe(744 - 8 - 68)

    await act(async () => { container.querySelector<HTMLButtonElement>('[role="tab"]')!.click() })
    // The sheet resizing is what the observer reports; measure again as it would.
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(visibleMapFrame.value.bottom).toBe(422)
    expect(toolRailRoom.value).toBe(422 - 8 - 68)

    boxes.set(area, { left: 0, top: 0, width: 844, height: 390 })
    await act(async () => { render(<Sheet layout="landscape" />, container) })
    expect(visibleMapFrame.value).toMatchObject({ bottom: 0, right: 844 - 476 })
    expect(toolRailRoom.value).toBeNull()

    // At peek it rests in the bottom right corner, still over the right edge: its context bar can stand taller than a
    // bottom band, and the zoom column keeps the window's height beside it.
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!.click() })
    expect(visibleMapFrame.value).toMatchObject({ bottom: 0, right: 844 - 476 })

    releaseStrip()
    releaseArea()
    area.remove()
    strip.remove()
  })

  it('keeps the primary views (the Design map and Templates) in More, where they switch the map without opening the sheet', async () => {
    const switchView = vi.fn()
    expect(browserPhoneSheetTabs({ primary: ['canvas'], design: ['layers'], planning: ['calendar'] })).toEqual(['layers', 'calendar'])
    expect(browserPhoneSheetTabs({ primary: ['canvas', 'templates'], design: ['layers'], planning: ['calendar'] }))
      .toEqual(['layers', 'calendar', 'canvas', 'templates'])
    function WithViews() {
      const views: PanelRailCommand[] = [
        { panel: 'canvas', id: 'nav.canvas', label: 'Design canvas', disabled: false, active: true, action: switchView },
        { panel: 'templates', id: 'nav.templates', label: 'Templates', disabled: false, active: false, action: switchView },
      ]
      return <PhoneSheet layout="portrait" tabs={[...tabs(), ...views]}>{sidePanel.value ? <div /> : null}</PhoneSheet>
    }
    await act(async () => { render(<WithViews />, container) })
    const sheet = container.querySelector<HTMLElement>('[data-phone-sheet]')!
    // The active Design map is no open panel: the sheet rests, and raising it opens the first panel.
    expect(sheet.dataset.phoneSheet).toBe('peek')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-sheet-handle]')!.click() })
    expect(sidePanel.value).toBe('layers')
    expect(switchView).not.toHaveBeenCalled()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-sheet-more]')!.click() })
    const items = Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], [role="menuitemradio"]')).map((item) => item.textContent)
    expect(items.slice(-2)).toEqual(['Design canvas', 'Templates'])
  })

  it('measures a side sheet as the right edge even when it is narrow', () => {
    const frame = measureVisibleMapFrame(rect({ left: 0, top: 0, width: 844, height: 390 }), [
      { rect: rect({ left: 476, top: 60, width: 360, height: 104 }), side: 'right' },
    ])
    expect(frame).toMatchObject({ right: 368, bottom: 0 })
  })

  it('puts the panels in the phone sheet in place of the dock while the phone layout holds', async () => {
    function Canvas() { return <div data-canvas /> }
    function Layers() { return <div data-layers-panel /> }
    function Calendar() { return <div data-calendar-panel /> }
    const surfaces: WorkspaceSurfaces = { primary: { canvas: Canvas }, side: { layers: Layers, calendar: Calendar } }
    const projection: WorkspacePanelProjection = {
      primary: [{ panel: 'canvas' }],
      design: [{ panel: 'layers' }],
      planning: [{ panel: 'calendar' }],
    }
    const phoneTabs = () => tabs().filter((command) => command.panel === 'layers' || command.panel === 'calendar')
    function Workspace() {
      return <WorkspaceComposition panelProjection={projection} surfaces={surfaces} responsive phoneTabs={phoneTabs()} />
    }
    sidePanel.value = 'layers'
    await act(async () => { render(<Workspace />, container) })
    expect(container.querySelector('[data-phone-sheet]')).toBeNull()
    expect(container.querySelector('[role="separator"][aria-orientation="vertical"]')).not.toBeNull()
    expect(container.querySelector('[data-layers-panel]')).not.toBeNull()
    // The dock and the sheet are the key router's dock region: a press there leaves Ctrl+C and Ctrl+A to the page.
    expect(container.querySelector('[data-layers-panel]')?.closest('[data-key-region="dock"]')).not.toBeNull()

    await act(async () => { phoneLayout.value = 'portrait' })
    expect(container.querySelector('[role="separator"][aria-orientation="vertical"]')).toBeNull()
    expect(container.querySelector('[data-phone-sheet="half"] [role="tabpanel"] [data-layers-panel]')).not.toBeNull()
    // In the sheet the dock region holds the handle, the tabs and the panel; the context bar above them is not in it.
    expect(container.querySelector('[data-phone-sheet] [role="tabpanel"]')?.closest('[data-key-region="dock"]')).not.toBeNull()
    expect(container.querySelector('[data-phone-sheet] [data-sheet-handle]')?.closest('[data-key-region="dock"]')).not.toBeNull()
    expect(container.querySelector('[data-phone-sheet] [data-phone-context-bar]')?.closest('[data-key-region="dock"]')).toBeNull()

    await act(async () => { phoneLayout.value = 'landscape' })
    expect(container.querySelector('[data-phone-sheet]')?.getAttribute('data-orientation')).toBe('landscape')

    // With no phone tabs (Desktop), the phone layout never applies.
    await act(async () => {
      render(<WorkspaceComposition panelProjection={projection} surfaces={surfaces} />, container)
    })
    expect(container.querySelector('[data-phone-sheet]')).toBeNull()
    expect(container.querySelector('[data-layers-panel]')).not.toBeNull()
  })
})
