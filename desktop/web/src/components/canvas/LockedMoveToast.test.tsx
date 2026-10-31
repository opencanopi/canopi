// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../../app/settings/state'
import { registerMapArea, registerMapOccluder } from '../../app/shell/visible-map-area'
import { currentCanvasLockedMoveNotice, noteCanvasLockedMoveRefused } from '../../canvas/session-state'
import { LockedMoveToast } from './LockedMoveToast'

describe('LockedMoveToast (2.1-Q177)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    locale.value = 'en'
    currentCanvasLockedMoveNotice.value = null
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.useFakeTimers()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    currentCanvasLockedMoveNotice.value = null
    vi.useRealTimers()
  })

  const toast = () => container.querySelector('[role="status"]')

  it('a refused drag shows "Locked: unlock to move" until it times out; the next refusal shows it again', async () => {
    await act(async () => render(<LockedMoveToast />, container))
    expect(toast()).toBeNull()

    await act(async () => noteCanvasLockedMoveRefused())
    expect(toast()?.textContent).toBe('Locked: unlock to move')

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(toast()).toBeNull()
    expect(currentCanvasLockedMoveNotice.value).toBeNull()

    await act(async () => noteCanvasLockedMoveRefused())
    expect(toast()?.textContent).toBe('Locked: unlock to move')
  })

  it('canopi-eon8.14.3: a notice belongs to the mounted canvas; the next canvas never replays it', async () => {
    await act(async () => render(<LockedMoveToast />, container))
    await act(async () => noteCanvasLockedMoveRefused())
    expect(toast()?.textContent).toBe('Locked: unlock to move')

    // The Design closes within the toast's time: the canvas chrome unmounts before the timer dismisses the notice.
    await act(async () => render(null, container))
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(currentCanvasLockedMoveNotice.value).toBeNull()

    // The next Design's canvas mounts with no lock notice.
    await act(async () => render(<LockedMoveToast />, container))
    expect(toast()).toBeNull()
  })

  it('a refusal while it shows restarts its time', async () => {
    await act(async () => render(<LockedMoveToast />, container))
    await act(async () => noteCanvasLockedMoveRefused())
    await act(async () => { vi.advanceTimersByTime(3000) })
    await act(async () => noteCanvasLockedMoveRefused())
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(toast()?.textContent).toBe('Locked: unlock to move')
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(toast()).toBeNull()
  })

  it('canopi-eon8.14.3: stands at the top of the visible map, clear of the bottom selection chip, as status chrome on the visible-map-area seam', async () => {
    const TITLE_BAR = { left: 12, top: 10, width: 1256, height: 50 }
    const TOAST = { left: 400, top: 68, width: 480, height: 40 }
    const area = document.createElement('div')
    const titleBar = document.createElement('div')
    document.body.append(area, titleBar)
    const box = (b: { left: number, top: number, width: number, height: number }) =>
      ({ ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === area) return box({ left: 0, top: 0, width: 1280, height: 800 })
      if (this === titleBar) return box(TITLE_BAR)
      if (this.hasAttribute('data-locked-move-toast')) return box(TOAST)
      return box({ left: 0, top: 0, width: 0, height: 0 })
    })
    const releaseArea = registerMapArea(area)
    const releaseTitle = registerMapOccluder(titleBar, 'top')
    try {
      await act(async () => render(<LockedMoveToast />, container))
      expect(area.style.getPropertyValue('--map-inset-top')).toBe('60px')
      await act(async () => noteCanvasLockedMoveRefused())
      // Chips avoid it; the camera's framing, which it stands in, does not move.
      expect(area.style.getPropertyValue('--map-inset-top')).toBe('108px')
      expect(area.style.getPropertyValue('--map-framing-inset-top')).toBe('60px')
      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(area.style.getPropertyValue('--map-inset-top')).toBe('60px')
    } finally {
      render(null, container)
      releaseTitle()
      releaseArea()
      area.remove()
      titleBar.remove()
      vi.restoreAllMocks()
    }
  })
})
