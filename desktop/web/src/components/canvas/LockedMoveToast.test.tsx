// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../../app/settings/state'
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
})
