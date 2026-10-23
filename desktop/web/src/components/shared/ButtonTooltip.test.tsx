// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tooltipOf } from '../../__tests__/support/tooltip'
import { unmount } from '../../__tests__/support/unmount'
import { ButtonTooltip } from './ButtonTooltip'
import styles from './ButtonTooltip.module.css'

describe('ButtonTooltip', () => {
  let root: HTMLDivElement
  let frames: FrameRequestCallback[]
  const nextFrame = () => act(() => {
    const due = frames
    frames = []
    for (const frame of due) frame(0)
  })

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
    vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  afterEach(() => {
    unmount(root)
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('follows its button and hides with it while open, when only layout or CSS moves or hides the button', () => {
    act(() => { render(<button type="button"><ButtonTooltip label="My location" side="top" shown /></button>, root) })
    const button = root.querySelector('button')!
    let box = new DOMRect(300, 500, 44, 44)
    button.getBoundingClientRect = () => box
    nextFrame()
    const tooltip = tooltipOf(button)!
    const placedAt = tooltip.style.top
    expect(tooltip.style.visibility).not.toBe('hidden')

    // The phone sheet is dragged up: the zoom column moves through its CSS top, with no render.
    box = new DOMRect(300, 300, 44, 44)
    nextFrame()
    expect(tooltip.style.top).not.toBe(placedAt)

    // The column has no room and turns visibility: hidden.
    button.style.visibility = 'hidden'
    nextFrame()
    expect(tooltip.style.visibility).toBe('hidden')

    // It is shown again, then laid out with no box (display: none above it).
    button.style.visibility = ''
    nextFrame()
    expect(tooltip.style.visibility).not.toBe('hidden')
    box = new DOMRect(0, 0, 0, 0)
    nextFrame()
    expect(tooltip.style.visibility).toBe('hidden')
  })

  it('shows a hover found elsewhere after the hover delay, and a shown reason at once (canopi-n2cg)', () => {
    act(() => { render(<button type="button"><ButtonTooltip label="Fit" hovered /></button>, root) })
    const button = root.querySelector('button')!
    expect(tooltipOf(button)?.classList.contains(styles.tooltip!)).toBe(true)
    expect(tooltipOf(button)?.classList.contains(styles.tooltipShown!), 'a hover waits for the delay').toBe(false)
    act(() => { render(<button type="button"><ButtonTooltip label="Fit" shown /></button>, root) })
    expect(tooltipOf(button)?.classList.contains(styles.tooltipShown!)).toBe(true)
    act(() => { render(<button type="button"><ButtonTooltip label="Fit" /></button>, root) })
    expect(tooltipOf(button)).toBeNull()
  })

  it('stops following once closed', () => {
    act(() => { render(<button type="button"><ButtonTooltip label="Zoom in" shown /></button>, root) })
    act(() => { render(<button type="button"><ButtonTooltip label="Zoom in" /></button>, root) })
    nextFrame()
    expect(frames).toEqual([])
  })

  /** What assistive tech reads as the button's description: the text of the nodes its aria-describedby names. */
  const descriptionOf = (button: Element) => (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ')

  it('describes its button with what the tooltip adds to the name, shown or not', () => {
    // A disabled button's reason: named by its text, described by the reason.
    act(() => { render(<button type="button" aria-disabled>Analyze<ButtonTooltip label="Import data first" side="bottom" /></button>, root) })
    const analyze = root.querySelector('button')!
    expect(tooltipOf(analyze)).toBeNull()
    expect(analyze.textContent).toBe('Analyze')
    expect(descriptionOf(analyze)).toBe('Import data first')
    // Data arrives: the reason goes, and so does the description.
    act(() => { render(<button type="button">Analyze</button>, root) })
    expect(analyze.hasAttribute('aria-describedby')).toBe(false)

    // A tool rail button names its tool and shortcut: the tooltip adds nothing, so it describes nothing.
    act(() => { render(<button type="button" aria-label="Select (V)" aria-keyshortcuts="v"><ButtonTooltip label="Select" shortcut="V" /></button>, root) })
    expect(root.querySelector('button')!.hasAttribute('aria-describedby')).toBe(false)

    // A hint beyond the name is described, beside the button's own description.
    act(() => {
      render(<><button type="button" aria-label="Reset north" aria-keyshortcuts="Shift+N" aria-describedby="bearing">
        <ButtonTooltip label="Reset north" shortcut="Shift+N" description="Drag to turn the map" />
      </button><span id="bearing">North up</span></>, root)
    })
    expect(descriptionOf(root.querySelector('button')!)).toBe('North up Drag to turn the map')

    // A tooltip its caller hid from assistive tech stays hidden.
    act(() => { render(<button type="button">Site data<span aria-hidden="true"><ButtonTooltip label="Site data" shortcut="Ctrl+L" /></span></button>, root) })
    expect(root.querySelector('button')!.hasAttribute('aria-describedby')).toBe(false)
  })
})
