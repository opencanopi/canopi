// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { act } from 'preact/test-utils'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createViewReadSurface } from '../geo/view/frame-source'
import type { ViewReadSurface } from '../geo/view/read-surface'
import type { ScreenPoint } from '../geo/view/types'
import { createSessionPlane } from '../geo/session-plane'
import { currentCanvasDesignPinHovered, setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface, createTestViewReadSurface } from './support/canvas-query-surface'
import { createTestView, type TestView } from './support/test-view'

import { focusOwner } from '../app/keyboard/focus-owner'
import { CanvasOverview, OverviewNotice } from '../components/canvas/CanvasOverview'

describe('CanvasOverview', () => {
  let container: HTMLDivElement
  let testView: TestView | null = null

  /** The view of a 400 x 300 map placed as today's viewport { x, y, scale }. */
  function overviewView(viewport: { x?: number; y?: number } = {}): ViewReadSurface {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    testView = createTestView({ plane, viewport: { x: 200, y: 150, scale: 0.01, ...viewport } })
    return createViewReadSurface(testView.frames)
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    testView?.dispose()
    testView = null
  })

  it('shows the Design as a named pin button and offers Return to Design, both fitting the Design', async () => {
    const returnToDesign = vi.fn()
    const focusMap = vi.spyOn(focusOwner, 'focusMap').mockImplementation(() => {})
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: overviewView() },
      commands: createTestCanvasCommandSurface({ viewport: { returnToDesign } }),
    }))

    await act(async () => render(<><OverviewNotice /><CanvasOverview /></>, container))
    const notice = container.querySelector('[data-overview-notice]')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('Zoom in to edit. Plants are hidden at this scale.')
    const returnButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Return to Design')!
    returnButton.click()
    expect(returnToDesign).toHaveBeenCalledOnce()
    // The button leaves with the overview, so the map takes focus and its keys work at once.
    expect(focusMap).toHaveBeenCalledOnce()

    // The pin is a button that fits the Design, named for it, with a tooltip saying so (canopi-n2cg).
    const pin = container.querySelector<HTMLButtonElement>('[data-overview-pin]')!
    expect(pin.tagName).toBe('BUTTON')
    expect(pin.type).toBe('button')
    expect(pin.getAttribute('aria-label')).toMatch(/^Go to Design: /)
    expect(pin.style.left).toBe('200px')
    pin.click()
    expect(returnToDesign).toHaveBeenCalledTimes(2)
    expect(focusMap, 'the pin leaves with the overview: the map takes focus').toHaveBeenCalledTimes(2)
    focusMap.mockRestore()
  })

  it('registers its box about its point with the view, shows its tooltip while the map says it is hovered, and fits the Design from the keyboard', async () => {
    const setDesignPinExtent = vi.fn()
    const returnToDesign = vi.fn()
    vi.spyOn(focusOwner, 'focusMap').mockImplementation(() => {})
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: overviewView() },
      commands: createTestCanvasCommandSurface({ viewport: { returnToDesign, setDesignPinExtent } }),
    }))
    // The map area the pin is placed in starts at (10, 20) in the window; the pin is laid out 18 px left and 16 px up of
    // its point (200, 150), 140 px wide and 32 px high.
    const area = document.createElement('div')
    container.append(area)
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(area)
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 400, 300))
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(192, 154, 140, 32))
    await act(async () => render(<CanvasOverview />, area))
    expect(setDesignPinExtent).toHaveBeenLastCalledWith({ left: -18, top: -16, right: 122, bottom: 16 })

    const pin = area.querySelector<HTMLElement>('[data-overview-pin]')!
    const tooltip = () => document.querySelector('[data-tooltip-layer] [role="tooltip"]')
    // The pointer passes through it to the map, whose hover sets the signal.
    expect(tooltip()).toBeNull()
    await act(async () => { currentCanvasDesignPinHovered.value = true })
    expect(tooltip()?.textContent).toBe('Fit the whole Design on screen')
    await act(async () => { currentCanvasDesignPinHovered.value = false })
    expect(tooltip()).toBeNull()

    // The keyboard's Enter or Space clicks it: the Design fits.
    pin.click()
    expect(returnToDesign).toHaveBeenCalledOnce()

    // Gone with the overview, it registers no box.
    await act(async () => render(null, area))
    expect(setDesignPinExtent).toHaveBeenLastCalledWith(null)
    vi.restoreAllMocks()
  })

  it('omits an offscreen marker while retaining the notice action', async () => {
    const returnToDesign = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: overviewView({ x: -100 }) },
      commands: createTestCanvasCommandSurface({ viewport: { returnToDesign } }),
    }))

    await act(async () => render(<><OverviewNotice /><CanvasOverview /></>, container))
    expect(container.textContent).toContain('Zoom in to edit')
    expect(container.querySelector('[data-overview-pin]')).toBeNull()
    const returnButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Return to Design')
    returnButton?.click()
    expect(returnToDesign).toHaveBeenCalledOnce()
  })

  it('places the pin at ViewReadSurface.designPin', async () => {
    const designPin = signal<ScreenPoint | null>({ x: 123, y: 45 })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: {
        ...createTestCanvasQuerySurface(),
        view: { ...createTestViewReadSurface(), mode: signal('overview'), designPin },
      },
    }))

    await act(async () => render(<><OverviewNotice /><CanvasOverview /></>, container))
    const pin = container.querySelector<HTMLElement>('[data-overview-pin]')!
    expect([pin.style.left, pin.style.top]).toEqual(['123px', '45px'])

    await act(async () => { designPin.value = { x: 300, y: 200 } })
    expect([pin.style.left, pin.style.top]).toEqual(['300px', '200px'])

    // Within 24 px of an edge the surface publishes no pin; the notice stays.
    await act(async () => { designPin.value = null })
    expect(container.querySelector('[data-overview-pin]')).toBeNull()
    expect(container.querySelector('[data-overview-notice]')).not.toBeNull()
  })
})
