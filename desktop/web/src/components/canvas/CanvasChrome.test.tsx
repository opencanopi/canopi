// @vitest-environment jsdom

// canopi-23p2: the top-centre chips share one slot, which registers with the visible-map-area seam, so they stack
// instead of covering each other; on a phone they are the context bar's (PhoneContextBar). jsdom has no layout, so this
// checks the structure: no browser spec reads the slot's rects yet.
import { render, createRef } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onboarding = vi.hoisted(() => ({
  cardOpen: null as unknown as { value: boolean },
}))

vi.mock('../../app/site-onboarding/state', async () => {
  const { signal } = await import('@preact/signals')
  onboarding.cardOpen = signal(false)
  return {
    siteLocateOpen: signal(false),
    startDesignCardOpen: onboarding.cardOpen,
    foundSiteLabel: signal(null),
    finishSiteLocate: () => {},
    closeStartDesignCard: () => {},
    searchSiteAgain: () => {},
  }
})

import { phoneLayout } from '../../app/shell/phone-layout'
import { registerMapArea, visibleMapFrame } from '../../app/shell/visible-map-area'
import { workspaceCanvasCommandProjection } from '../../app/workspace-commands/canvas-actions'
import { setCurrentCanvasSession } from '../../canvas/session'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import { CanvasChrome } from './CanvasChrome'

describe('the top-centre chip slot', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    // Below 0.1 px/m the map is in overview.
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ placement: { x: 0, y: 0, scale: 0.01 } }),
    }))
  })

  afterEach(async () => {
    await act(async () => { render(null, container) })
    setCurrentCanvasSession(null)
    onboarding.cardOpen.value = false
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  async function renderChrome(): Promise<void> {
    const canvasRef = createRef<HTMLDivElement>()
    await act(async () => {
      render(<div ref={canvasRef}><CanvasChrome projection={workspaceCanvasCommandProjection.value} canvasRef={canvasRef} /></div>, container)
    })
  }

  it('the overview notice renders in the top-centre slot, and the overview pin stays where the Design is', async () => {
    await renderChrome()

    const slot = container.querySelector<HTMLElement>('[data-top-chip-slot]')!
    expect(slot.querySelector('[data-overview-notice]')?.parentElement).toBe(slot)
    expect(container.querySelector('[data-overview-pin]')?.closest('[data-top-chip-slot]') ?? null).toBeNull()
  })

  it('while the Start card shows, the slot follows the card and its found-place chip in their row', async () => {
    // A fixed-width offset beside the card would leave the slot off a narrow map; in the row it wraps below the card.
    onboarding.cardOpen.value = true
    await renderChrome()

    const row = container.querySelector<HTMLElement>('[data-start-row]')!
    const slot = container.querySelector<HTMLElement>('[data-top-chip-slot]')!
    expect([...row.children].map((child) => child.hasAttribute('data-start-design') ? 'card'
      : child.hasAttribute('data-found-site') ? 'found' : child === slot ? 'slot' : 'other')).toEqual(['card', 'found', 'slot'])
    expect(slot.querySelector('[data-overview-notice]')?.parentElement).toBe(slot)
    expect(container.querySelectorAll('[data-top-chip-slot]')).toHaveLength(1)
  })

  it('registers the slot as chrome over the top edge of the map', async () => {
    const area = document.createElement('div')
    document.body.append(area)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this === area ? { left: 0, top: 0, width: 1280, height: 800 }
        : this.hasAttribute('data-top-chip-slot') ? { left: 460, top: 72, width: 360, height: 92 }
          : { left: 0, top: 0, width: 0, height: 0 }
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) } as DOMRect
    })
    const release = registerMapArea(area)
    try {
      await renderChrome()
      expect(visibleMapFrame.value.top).toBe(164)
    } finally {
      release()
    }
  })

  it('on a phone the canvas mounts no top chip slot, tool card or selection chip: they are the context bar\'s', async () => {
    phoneLayout.value = 'portrait'
    try {
      await renderChrome()
      expect(container.querySelector('[data-top-chip-slot]')).toBeNull()
      expect(container.querySelector('[data-overview-notice]')).toBeNull()
      expect(container.querySelector('[data-tool-card], [role="status"][aria-live="polite"]')).toBeNull()
      expect(container.querySelector('[data-selection-chip]')).toBeNull()
    } finally {
      phoneLayout.value = null
    }
  })
})
