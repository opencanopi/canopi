// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelRail } from '../components/shared/PanelRail'
import { railVisibleCount } from '../components/shared/rail-fit'
import { panelRailRoom } from '../app/shell/visible-map-area'
import { DesktopPanelRail } from '../components/panels/DesktopPanelRail'
import { activePanel, sidePanel } from '../app/shell/state'
import { locale } from '../app/settings/state'
import { appCommandGraphPanelProjection } from '../commands/registry'
import { designSessionFixture } from './support/design-session-state'
import { hoveredTooltip } from './support/tooltip'

/** The rail over the live projection, rendered even without a Design (DesktopPanelRail hides then). */
function ProjectedRail() {
  const projection = appCommandGraphPanelProjection.value
  return <PanelRail label="Panels" groups={[projection.design, projection.planning]} />
}

describe('Panel rail', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    activePanel.value = 'canvas'
    sidePanel.value = null
    designSessionFixture.file = {
      version: 9,
      name: 'test',
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
      created_at: '',
      updated_at: '',
      extra: {},
    }
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  function panelButton(label: string): HTMLButtonElement {
    const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
    if (!button) throw new Error(`Missing panel button ${label}`)
    return button
  }

  function panelButtonLabels(): string[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Panels"] button'))
      .map((button) => button.getAttribute('aria-label') ?? '')
  }

  it('draws panel icons on the shared 1.6 stroke grid', async () => {
    await act(async () => {
      render(<ProjectedRail />, container)
    })

    const strokes = Array.from(container.querySelectorAll<SVGElement>('nav[aria-label="Panels"] svg'))
      .map((icon) => icon.getAttribute('stroke-width'))
    expect(strokes).toEqual(Array(10).fill('1.6'))
  })

  it('orders panels as the rail groups them, Site data under Layers, with Ctrl 1–9 and none for Stories (U49 Q1)', async () => {
    await act(async () => {
      render(<ProjectedRail />, container)
    })

    expect(panelButtonLabels()).toEqual([
      'Layers',
      'Site data',
      'Plants in this Design',
      'Plant catalog',
      'Favorites and stamps',
      'Calendar',
      'Budget',
      'Consortium',
      'Design notebook',
      'Stories',
    ])
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1)
    expect(panelButton('Layers').getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+1')
    expect(panelButton('Site data').getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+2')
    expect(panelButton('Plants in this Design').getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+3')
    expect(hoveredTooltip(panelButton('Design notebook')!)?.textContent).toContain('Alt Shift 9')
    expect(panelButton('Stories').hasAttribute('aria-keyshortcuts')).toBe(false)
  })

  it('does not render a Design Location or canvas entry point', async () => {
    await act(async () => {
      render(<ProjectedRail />, container)
    })

    expect(container.querySelector('button[aria-label="Design Location"]')).toBeNull()
    expect(container.querySelector('button[data-panel="canvas"]')).toBeNull()
  })

  it('hides the Desktop rail on the start screen', async () => {
    designSessionFixture.file = null
    await act(async () => {
      render(<DesktopPanelRail />, container)
    })
    expect(container.querySelector('nav')).toBeNull()
  })

  it('marks the Desktop rail as the open Design\'s chrome, which waits while the Design is hidden (global.css)', async () => {
    await act(async () => {
      render(<DesktopPanelRail />, container)
    })
    expect(container.querySelector('nav')?.hasAttribute('data-design-chrome')).toBe(true)

    await act(async () => {
      render(<ProjectedRail />, container)
    })
    expect(container.querySelector('nav')?.hasAttribute('data-design-chrome'), 'the Web rail also serves the start screen').toBe(false)
  })

  it('disables design-dependent panel entry points when no design is open', async () => {
    designSessionFixture.file = null

    await act(async () => {
      render(<ProjectedRail />, container)
    })

    expect(panelButton('Plants in this Design').disabled).toBe(true)
    expect(panelButton('Layers').disabled).toBe(true)
    expect(panelButton('Plant catalog').disabled).toBe(true)
    expect(panelButton('Design notebook').disabled).toBe(false)
    expect(panelButton('Favorites and stamps').disabled).toBe(true)
  })

  it('keeps an active no-design Plant catalog panel button enabled so it can close the panel', async () => {
    designSessionFixture.file = null
    const panels = appCommandGraphPanelProjection.value
    const plantDb = [...panels.primary, ...panels.design, ...panels.planning]
      .find((command) => command.commandId === 'nav.plantDb')!
    plantDb.action()

    await act(async () => {
      render(<ProjectedRail />, container)
    })

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
    expect(panelButton('Plant catalog').disabled).toBe(false)
    expect(panelButton('Plant catalog').getAttribute('aria-expanded')).toBe('true')
    expect(panelButton('Design notebook').disabled).toBe(false)
    expect(panelButton('Favorites and stamps').disabled).toBe(true)

    await act(async () => {
      panelButton('Plant catalog').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
    expect(panelButton('Plant catalog').disabled).toBe(true)
    expect(panelButton('Plant catalog').getAttribute('aria-expanded')).toBe('false')
  })

  it('toggles side panels through the command graph projection click path', async () => {
    await act(async () => {
      render(<ProjectedRail />, container)
    })

    expect(panelButton('Plant catalog').disabled).toBe(false)
    expect(panelButton('Plant catalog').getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      panelButton('Plant catalog').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
    expect(panelButton('Plant catalog').getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      panelButton('Plant catalog').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
    expect(panelButton('Plant catalog').getAttribute('aria-expanded')).toBe('false')
  })

  it('updates panel button tooltips immediately when the locale changes', async () => {
    await act(async () => {
      render(<ProjectedRail />, container)
    })

    expect(hoveredTooltip(container.querySelector('button[aria-label="Layers"]')!)?.textContent)
      .toContain('Layers')

    await act(async () => {
      locale.value = 'fr'
      await Promise.resolve()
    })

    const layersButton = container.querySelector('button[aria-label="Calques"]')
    expect(layersButton).not.toBeNull()
    expect(hoveredTooltip(layersButton!)?.textContent)
      .toContain('Calques')
  })

  describe('in a short window', () => {
    // The rail's measured layout: 5 px padding, 40 px buttons 2 px apart, a
    // 13 px rule between the two groups.
    const RAIL_TOP = 72
    function buttonTop(index: number): number {
      return RAIL_TOP + 5 + index * 42 + (index >= 5 ? 13 : 0)
    }
    function box(top: number, height: number): DOMRect {
      return { left: 1216, top, width: 52, height, x: 1216, y: top, right: 1268, bottom: top + height, toJSON: () => ({}) } as DOMRect
    }

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const nav = this.closest('nav')
        if (this === nav) {
          const count = nav.querySelectorAll('[data-panel], [data-panel-rail-more]').length
          const last = buttonTop(count - 1) + 40
          return box(RAIL_TOP, last + 5 - RAIL_TOP)
        }
        const buttons = Array.from(nav?.querySelectorAll('[data-panel], [data-panel-rail-more]') ?? [])
        const index = buttons.indexOf(this)
        return index < 0 ? box(0, 0) : box(buttonTop(index), 40)
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      panelRailRoom.value = null
    })

    it('counts the panels that fit above the chrome with a More button after them', () => {
      const buttons = Array.from({ length: 9 }, (_, index) => ({ top: buttonTop(index) - RAIL_TOP, bottom: buttonTop(index) + 40 - RAIL_TOP }))
      const height = buttons[8]!.bottom + 5
      expect(railVisibleCount(buttons, height, null)).toBeNull()
      expect(railVisibleCount(buttons, height, height)).toBeNull()
      // Five panels and More end at 5 + 6 * 42 - 2 + 5 = 260; a sixth panel sits past the rule.
      expect(railVisibleCount(buttons, height, 260)).toBe(5)
      expect(railVisibleCount(buttons, height, 259)).toBe(4)
      expect(railVisibleCount(buttons, height, 314)).toBe(5)
      expect(railVisibleCount(buttons, height, 315)).toBe(6)
      // More stays even when nothing else fits.
      expect(railVisibleCount(buttons, height, 20)).toBe(0)
    })

    it('folds the panels that do not fit into a More menu, keeping their order', async () => {
      await act(async () => {
        render(<ProjectedRail />, container)
      })
      expect(container.querySelector('[data-panel-rail-more]')).toBeNull()

      await act(async () => {
        panelRailRoom.value = 220
        await Promise.resolve()
      })
      expect(panelButtonLabels()).toEqual([
        'Layers',
        'Site data',
        'Plants in this Design',
        'Plant catalog',
        'More panels',
      ])
      // The rule goes with the group that folded away.
      expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0)

      const more = panelButton('More panels')
      expect(more.getAttribute('aria-haspopup')).toBe('menu')
      await act(async () => {
        more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'))
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('Favorites and stamps'),
        expect.stringContaining('Calendar'),
        expect.stringContaining('Budget'),
        expect.stringContaining('Consortium'),
        expect.stringContaining('Design notebook'),
        expect.stringContaining('Stories'),
      ])
      expect(items[4]!.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+9')

      await act(async () => {
        items[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(sidePanel.value).toBe('budget')
      // More shows that it holds the open panel.
      expect(panelButton('More panels').hasAttribute('data-holds-active')).toBe(true)

      // A taller window gives the panels back.
      await act(async () => {
        panelRailRoom.value = 600
        await Promise.resolve()
      })
      expect(container.querySelector('[data-panel-rail-more]')).toBeNull()
      expect(panelButtonLabels()).toHaveLength(10)
    })
  })
})
