// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { options, render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../app/settings/state'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import { setCurrentCanvasSession } from '../canvas/session'
import type { ViewReadSurface } from '../canvas/runtime/view/read-surface'
import { createViewReadSurface } from '../canvas/runtime/view/frame-source'
import { createSessionPlane } from '../canvas/session-plane'
import { InspectionLens } from '../components/canvas/InspectionLens'
import { ZoomControls } from '../components/canvas/ZoomControls'
import { MyLocationButton, MyLocationButtonView } from '../components/canvas/MyLocationButton'
import { myLocation, type MyLocationMode } from '../app/my-location/session'
import { phoneLayout } from '../app/shell/phone-layout'
import { registerMapArea, registerMapOccluder, visibleMapFrame } from '../app/shell/visible-map-area'
import { createTestCanvasQuerySurface, createTestViewReadSurface } from './support/canvas-query-surface'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { createTestView } from './support/test-view'
import { hoveredTooltip, tooltipOf } from './support/tooltip'

/** The view at the Design default, 20 CSS px per metre, unless the test overrides its signals. */
function view(overrides: Partial<ViewReadSurface> = {}): ViewReadSurface {
  return { ...createTestViewReadSurface(), groundMetresPerPixel: signal(1 / 20), ...overrides }
}

describe('ZoomControls', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    locale.value = 'en'
    phoneLayout.value = null
  })

  it('stands as a column of the inspection lens, zoom in, zoom out, Fit and the compass on a phone, with no ratio, covering no edge of the map', async () => {
    const zoomToFit = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: view() },
      commands: createTestCanvasCommandSurface({ viewport: { zoomToFit } }),
    }))
    const area = document.createElement('div')
    document.body.appendChild(area)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this === area ? { left: 0, top: 0, width: 390, height: 844 } : this.dataset.zoomGroup ? { left: 330, top: 500, width: 52, height: 150 } : { left: 0, top: 0, width: 0, height: 0 }
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) } as DOMRect
    })
    const release = registerMapArea(area)
    phoneLayout.value = 'portrait'
    await mount()
    const group = container.querySelector<HTMLElement>('[data-zoom-group]')!
    expect(group.dataset.zoomGroup).toBe('phone')
    expect([...group.querySelectorAll('button')].map((element) => element.getAttribute('aria-label'))).toEqual([
      'Inspection lens', 'Zoom in', 'Zoom out', 'Fit to Design', 'Reset north',
    ])
    expect(container.querySelector('[role="img"]')).toBeNull()
    // Fit is the desktop group's Fit to Design (and Home): the same command.
    button('Fit to Design').click()
    expect(zoomToFit).toHaveBeenCalledOnce()
    expect(visibleMapFrame.value).toMatchObject({ right: 0, bottom: 0 })

    await act(async () => { phoneLayout.value = null })
    expect(visibleMapFrame.value.bottom).toBeGreaterThan(0)
    release()
    area.remove()
    vi.restoreAllMocks()
  })

  it('on a phone opens the inspection lens from its column, hiding the button while the lens is open and focusing it after', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: { ...createTestCanvasQuerySurface(), view: view() } }))
    phoneLayout.value = 'portrait'
    const host = document.createElement('div')
    await act(async () => {
      render(<>
        <ZoomControls viewActions={workspaceCanvasCommandProjection.value.viewActions} />
        <InspectionLens canvasRef={{ current: host }} />
      </>, container)
    })
    // The lens floats no launcher of its own on a phone: the column's is the one.
    const launchers = container.querySelectorAll<HTMLButtonElement>('[data-inspection-launcher]')
    expect(launchers).toHaveLength(1)
    const launcher = launchers[0]!
    expect(launcher.closest('[data-zoom-group="phone"]')).not.toBeNull()
    await act(async () => launcher.click())
    expect(launcher.hidden).toBe(true)
    expect(launcher.getAttribute('aria-expanded')).toBe('true')
    const panel = container.querySelector<HTMLElement>(`#${launcher.getAttribute('aria-controls')}`)
    expect(panel).not.toBeNull()
    await act(async () => panel!.querySelector<HTMLButtonElement>('button[aria-label="Close inspection lens"]')!.click())
    expect(launcher.hidden).toBe(false)
    expect(document.activeElement).toBe(launcher)
  })

  it('on a phone hides the column where the visible map frame is shorter or narrower than it, and shows it with room', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: { ...createTestCanvasQuerySurface(), view: view() } }))
    const area = document.createElement('div')
    const sheet = document.createElement('div')
    document.body.append(area, sheet)
    let sheetTop = 600
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this === area ? { left: 0, top: 0, width: 360, height: 560 }
        : this === sheet ? { left: 0, top: sheetTop, width: 360, height: 560 - sheetTop } : { left: 0, top: 0, width: 0, height: 0 }
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.zoomGroup ? 238 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.zoomGroup ? 52 : 0
    })
    const releases = [registerMapArea(area), registerMapOccluder(sheet, 'bottom')]
    phoneLayout.value = 'portrait'
    try {
      sheetTop = 400
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      await mount()
      const group = () => container.querySelector<HTMLElement>('[data-zoom-group="phone"]')!
      expect(group().hasAttribute('data-roomless'), 'a 400 px frame holds the 238 px column').toBe(false)
      // The sheet at half on a 360x560 phone: 280 px of map, less than the column needs below the top bar's gap.
      sheetTop = 240
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      expect(group().hasAttribute('data-roomless'), 'a 240 px frame hides it').toBe(true)
      sheetTop = 400
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      expect(group().hasAttribute('data-roomless')).toBe(false)
    } finally {
      for (const release of releases.reverse()) release()
      area.remove()
      sheet.remove()
      vi.restoreAllMocks()
    }
  })

  it('on a phone keeps the column shown while top status chrome (the lock toast, frames: false) stands over the map: it never stands in the column', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: { ...createTestCanvasQuerySurface(), view: view() } }))
    const area = document.createElement('div')
    const sheet = document.createElement('div')
    const toast = document.createElement('div')
    document.body.append(area, sheet, toast)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this === area ? { left: 0, top: 0, width: 360, height: 560 }
        : this === sheet ? { left: 0, top: 400, width: 360, height: 160 }
          : this === toast ? { left: 80, top: 60, width: 200, height: 140 } : { left: 0, top: 0, width: 0, height: 0 }
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.zoomGroup ? 238 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.zoomGroup ? 52 : 0
    })
    const releases = [registerMapArea(area), registerMapOccluder(sheet, 'bottom'), registerMapOccluder(toast, 'top', { frames: false })]
    phoneLayout.value = 'portrait'
    try {
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      await mount()
      expect(visibleMapFrame.value.top, 'chips avoid the toast').toBe(200)
      const group = container.querySelector<HTMLElement>('[data-zoom-group="phone"]')!
      expect(group.hasAttribute('data-roomless'), 'the column stands from the framing frame, 400 px tall').toBe(false)
    } finally {
      for (const release of releases.reverse()) release()
      area.remove()
      sheet.remove()
      toast.remove()
      vi.restoreAllMocks()
    }
  })

  const mount = async () => {
    await act(async () => {
      render(<ZoomControls viewActions={workspaceCanvasCommandProjection.value.viewActions} />, container)
      await Promise.resolve()
    })
  }
  const ratio = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

  it('the compass is the last button of the registered zoom group', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: { ...createTestCanvasQuerySurface(), view: view() } }))
    const area = document.createElement('div')
    document.body.appendChild(area)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this === area ? { left: 0, top: 0, width: 1200, height: 800 } : this.dataset.zoomGroup !== undefined ? { left: 700, top: 748, width: 488, height: 40 } : { left: 0, top: 0, width: 0, height: 0 }
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) } as DOMRect
    })
    const release = registerMapArea(area)
    await mount()
    const group = container.querySelector<HTMLElement>('[data-zoom-group]')!
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((element) => element.getAttribute('aria-label'))).toEqual([
      'Zoom out', 'Map scale 1:190. Choose a scale', 'Zoom in', 'Fit to Design', 'Reset north',
    ])
    expect(buttons.at(-1)!.hasAttribute('data-compass')).toBe(true)
    // It is a button of the group, which keeps the map's bottom edge clear; it registers nothing of its own.
    expect(visibleMapFrame.value.bottom).toBe(800 - 748)
    expect(buttons.at(-1)!.getAttribute('aria-keyshortcuts')).toBe('N Shift+N Shift+ArrowUp')
    release()
    area.remove()
    vi.restoreAllMocks()
  })

  it('shows the map scale as a ratio and a scale bar, the same whatever the window size', async () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    for (const screen of [{ width: 1000, height: 800 }, { width: 600, height: 400 }]) {
      const camera = createTestView({ plane, screen, viewport: { x: 0, y: 0, scale: 20 } })
      setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
        queries: { ...createTestCanvasQuerySurface(), view: createViewReadSurface(camera.frames) },
      }))
      await mount()
      expect(ratio().textContent).toBe('1:190')
      expect(ratio().getAttribute('aria-label')).toBe('Map scale 1:190. Choose a scale')
      expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Scale bar: 5 m')
      await act(async () => {
        camera.host.current().setScreen({ width: 1200, height: 900, devicePixelRatio: 1 })
        camera.setViewport({ x: 0, y: 0, scale: 10 })
      })
      expect(ratio().textContent).toBe('1:380')
      camera.dispose()
    }
  })

  it('an east-west pan at a constant zoom does not re-render the zoom group', async () => {
    // A17: groundMetresPerPixel reads the camera centre's latitude, so a north-south pan may re-render the group; an east-west one
    // keeps the ratio, the scale bar and the button tooltips still.
    const camera = createTestView({ plane: createSessionPlane({ lon: 2.35, lat: 48.85 }), screen: { width: 1000, height: 800 } })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: createViewReadSurface(camera.frames) },
    }))
    let renders = 0
    const previous = options.diffed
    options.diffed = (vnode: VNode) => {
      if (typeof vnode.type === 'function') renders++
      previous?.(vnode)
    }
    try {
      await mount()
      const label = ratio().textContent
      const lon = camera.view().camera.center.lon
      renders = 0
      for (const deltaX of [40, 120, -300, 75]) {
        await act(async () => { camera.navigation.panByPx({ x: deltaX, y: 0 }) })
      }
      expect(camera.view().camera.center.lon).not.toBeCloseTo(lon, 6)
      expect(renders).toBe(0)
      expect(ratio().textContent).toBe(label)
      // The count is live: a zoom re-renders the group.
      await act(async () => { camera.navigation.zoomAroundPx({ x: 500, y: 400 }, 2) })
      expect(renders).toBeGreaterThan(0)
    } finally {
      options.diffed = previous
      camera.dispose()
    }
  })

  it('formats the ratio and distance for the interface language', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: view({ groundMetresPerPixel: signal(400) }) },
    }))
    locale.value = 'de'
    await mount()
    expect(ratio().textContent).toBe('1:1.500.000')
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('50 km')
  })

  it('offers common scales as a menu and zooms about the centre to the chosen one', async () => {
    const zoomBy = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: view() },
      commands: createTestCanvasCommandSurface({ viewport: { zoomBy } }),
    }))
    await mount()

    await act(async () => { ratio().click() })
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((item) => item.textContent)).toEqual([
      '1:100', '1:200', '1:500', '1:1,000', '1:2,000', '1:5,000', '1:10,000', '1:25,000',
    ])
    expect(document.activeElement).toBe(items[0])

    await act(async () => { items[3]!.click() })
    expect(zoomBy).toHaveBeenCalledOnce()
    expect(zoomBy.mock.calls[0]![0]).toBeCloseTo(0.189, 3)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(ratio())
  })

  it('keeps zoom writes on the focused command surface', async () => {
    const zoomIn = vi.fn()
    const zoomOut = vi.fn()
    const zoomToFit = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: { ...createTestCanvasQuerySurface(), view: view() },
      commands: createTestCanvasCommandSurface({ viewport: { zoomIn, zoomOut, zoomToFit } }),
    }))
    await mount()

    button('Zoom in').click()
    button('Zoom out').click()
    button('Fit to Design').click()

    expect(zoomIn).toHaveBeenCalledOnce()
    expect(zoomOut).toHaveBeenCalledOnce()
    expect(zoomToFit).toHaveBeenCalledOnce()
    // Home fits too, with the map focused.
    expect(button('Fit to Design').getAttribute('aria-keyshortcuts')).toBe('Shift+F Control+0 Meta+0 Home')
  })

  it('shows the world scale in overview and disables exhausted navigation', async () => {
    const zoomOut = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: {
        ...createTestCanvasQuerySurface(),
        view: view({ mode: signal('overview'), groundMetresPerPixel: signal(50_000), zoomLimit: signal('min') }),
      },
      commands: createTestCanvasCommandSurface({ viewport: { zoomOut } }),
    }))
    await mount()

    expect(ratio().textContent).toBe('1:190,000,000')
    expect(button('Zoom out').getAttribute('aria-disabled')).toBe('true')
    button('Zoom out').click()
    expect(zoomOut).not.toHaveBeenCalled()
    expect(button('Zoom in').getAttribute('aria-disabled')).toBeNull()
  })

  describe('Show my location (the Web Edition\'s slot, canopi-f47t.53)', () => {
    const descriptors = {
      geolocation: Object.getOwnPropertyDescriptor(navigator, 'geolocation'),
      permissions: Object.getOwnPropertyDescriptor(navigator, 'permissions'),
      isSecureContext: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
    }
    let success: PositionCallback | null = null
    let failure: PositionErrorCallback | null = null
    let permission: EventTarget & { state: PermissionState }

    beforeEach(() => {
      permission = Object.assign(new EventTarget(), { state: 'prompt' as PermissionState })
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          watchPosition: (onFix: PositionCallback, onError: PositionErrorCallback) => { success = onFix; failure = onError; return 1 },
          clearWatch: () => { success = null; failure = null },
        },
      })
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => permission } })
      setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: { ...createTestCanvasQuerySurface(), view: view() } }))
    })

    afterEach(() => {
      if (myLocation.mode.peek() === 'following') myLocation.press()
      if (myLocation.mode.peek() === 'moved-away') { myLocation.press(); myLocation.press() }
      if (myLocation.mode.peek() === 'blocked') {
        permission.state = 'prompt'
        permission.dispatchEvent(new Event('change'))
      }
      for (const [name, descriptor] of Object.entries(descriptors)) {
        const target = name === 'isSecureContext' ? window : navigator
        if (descriptor) Object.defineProperty(target, name, descriptor)
        else delete (target as unknown as Record<string, unknown>)[name]
      }
    })

    const mountWithLocation = async () => {
      await act(async () => {
        render(<ZoomControls viewActions={workspaceCanvasCommandProjection.value.viewActions} myLocation={MyLocationButton} />, container)
        await Promise.resolve()
      })
    }
    const labels = () => [...container.querySelectorAll('[data-zoom-group] button')].map((element) => element.getAttribute('aria-label'))
    const location = () => button('Show my location')
    const tooltip = () => hoveredTooltip(location())!.textContent

    it('stands just before the compass on the desktop group and in the phone column', async () => {
      await mountWithLocation()
      expect(labels()).toEqual(['Zoom out', 'Map scale 1:190. Choose a scale', 'Zoom in', 'Fit to Design', 'Show my location', 'Reset north'])
      await act(async () => { phoneLayout.value = 'landscape' })
      expect(labels()).toEqual(['Inspection lens', 'Zoom in', 'Zoom out', 'Fit to Design', 'Show my location', 'Reset north'])
    })

    it.each([
      ['without a secure context', () => Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })],
      ['without navigator.geolocation', () => Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined })],
    ])('is hidden %s (design check A1)', async (_name, take) => {
      take()
      await mountWithLocation()
      expect(labels()).toEqual(['Zoom out', 'Map scale 1:190. Choose a scale', 'Zoom in', 'Fit to Design', 'Reset north'])
    })

    it('is pressed only while Following, says when location is unavailable, and a click while Following turns it off', async () => {
      await mountWithLocation()
      expect(location().hasAttribute('aria-pressed')).toBe(false)
      expect(location().hasAttribute('aria-disabled')).toBe(false)
      expect(tooltip()).toBe('Show my location')

      await act(async () => { location().click() })
      expect(location().getAttribute('aria-pressed')).toBe('true')
      await act(async () => { success!({ coords: { longitude: 2.35, latitude: 48.85, accuracy: 12 }, timestamp: 1 } as GeolocationPosition) })
      await act(async () => { failure!({ code: 2, message: '' } as GeolocationPositionError) })
      expect(location().getAttribute('aria-pressed')).toBe('true')
      expect(tooltip()).toContain('Your location is unavailable right now')
      expect(document.getElementById(location().getAttribute('aria-describedby')!)!.textContent).toContain('unavailable')

      await act(async () => { location().click() })
      expect(location().hasAttribute('aria-pressed')).toBe(false)
      expect(tooltip()).toBe('Show my location')
      expect(success).toBeNull()
    })

    it('is disabled with the reason in its tooltip while Blocked, and enabled again when the permission changes (A4)', async () => {
      permission.state = 'denied'
      await mountWithLocation()
      await act(async () => { location().click() })
      await act(async () => {
        failure!({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError)
        for (let i = 0; i < 5; i += 1) await Promise.resolve()
      })
      expect(location().getAttribute('aria-disabled')).toBe('true')
      expect(location().hasAttribute('aria-pressed')).toBe(false)
      expect(tooltip()).toContain('Location is blocked')
      await act(async () => { location().click() })
      expect(success).toBeNull()

      await act(async () => {
        permission.state = 'prompt'
        permission.dispatchEvent(new Event('change'))
      })
      expect(location().hasAttribute('aria-disabled')).toBe(false)
      expect(myLocation.mode.peek()).toBe('off')
    })

    /** A finger's tap: the pointer press the browser sends before the click. */
    const tap = async (target: HTMLElement) => {
      await act(async () => {
        target.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'touch' }))
        target.click()
      })
    }
    /** Its tooltip shows with no hover or focus: the reason a tap asked for. */
    const tooltipShown = () => tooltipOf(location()) !== null

    it('a tap while Blocked shows the tooltip with its reason for a few seconds, since touch screens have no hover (A4, Q16)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        permission.state = 'denied'
        await mountWithLocation()
        await act(async () => { location().click() })
        await act(async () => {
          failure!({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError)
          for (let i = 0; i < 5; i += 1) await Promise.resolve()
        })
        expect(tooltipShown()).toBe(false)
        await tap(location())
        expect(tooltipShown()).toBe(true)
        expect(tooltip()).toContain('Location is blocked')
        expect(success).toBeNull()
        await act(async () => { vi.advanceTimersByTime(4000) })
        expect(tooltipShown()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a mouse click while Blocked leaves the tooltip to hover', async () => {
      permission.state = 'denied'
      await mountWithLocation()
      await act(async () => { location().click() })
      await act(async () => {
        failure!({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError)
        for (let i = 0; i < 5; i += 1) await Promise.resolve()
      })
      await act(async () => {
        location().dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'mouse' }))
        location().click()
      })
      expect(tooltipShown()).toBe(false)
    })

    it('a tap while the reading is stale re-centres and shows that location is unavailable; a tap with nothing to say shows no tooltip', async () => {
      const onPress = vi.fn()
      const mount = async (mode: MyLocationMode, unavailable: boolean) => {
        await act(async () => { render(<MyLocationButtonView className={undefined} mode={mode} unavailable={unavailable} onPress={onPress} />, container) })
      }
      await mount('moved-away', true)
      await tap(location())
      expect(onPress).toHaveBeenCalledTimes(1)
      expect(tooltipShown()).toBe(true)
      expect(tooltip()).toContain('Your location is unavailable right now')

      render(null, container)
      await mount('moved-away', false)
      await tap(location())
      expect(onPress).toHaveBeenCalledTimes(2)
      expect(tooltipShown()).toBe(false)
    })
  })
})
