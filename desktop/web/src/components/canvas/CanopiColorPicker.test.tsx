// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanopiColorSwatchPicker } from './CanopiColorPicker'
import { PLANT_COLOR_PALETTE } from '../../canvas/plant-colors'
import { ESCAPE_PRIORITY, registerEscapeLayer } from '../../app/keyboard/escape-chain'
import { installKeyRouter } from '../../app/keyboard/key-router'
import { TEST_KEY_PLATFORM } from '../../__tests__/support/key-router'

describe('CanopiColorSwatchPicker accessibility (2.1-Q105)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.replaceChildren(container)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    render(null, container)
    document.body.replaceChildren()
  })

  it('moves focus to the active swatch on open and returns focus to the trigger on Escape', async () => {
    const initial = PLANT_COLOR_PALETTE[2]!.hex
    const onChange = vi.fn()
    await act(async () => {
      render(<CanopiColorSwatchPicker value={initial} ariaLabel="Color of High" onChange={onChange} />, container)
    })

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Color of High"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { trigger.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    const swatches = dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')
    expect(swatches).toHaveLength(PLANT_COLOR_PALETTE.length)
    expect(document.activeElement).toBe(swatches[2])

    // Selecting another swatch updates the color while keeping focus in the palette; Escape closes and returns focus.
    await act(async () => { swatches[4]!.click() })
    expect(onChange).toHaveBeenCalledWith(PLANT_COLOR_PALETTE[4]!.hex)

    await act(async () => {
      swatches[4]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('closes through the Escape-chain layer when focus is outside the popover without leaking to lower layers', async () => {
    const outside = document.createElement('button')
    outside.textContent = 'Outside'
    document.body.append(outside)

    const lowerLayerEscape = vi.fn(() => true)
    const releaseLower = registerEscapeLayer({
      priority: ESCAPE_PRIORITY.tool,
      isActive: () => true,
      escape: lowerLayerEscape,
    })
    const router = installKeyRouter({
      target: window,
      keymap: [],
      commands: { run: () => false },
      canvas: () => null,
      singleKeys: signal(true),
      focus: { cycleRegion: () => false },
      isModalOpen: () => false,
      platform: TEST_KEY_PLATFORM,
      document,
    })

    try {
      await act(async () => {
        render(<CanopiColorSwatchPicker value={PLANT_COLOR_PALETTE[0]!.hex} ariaLabel="Color for every plant" onChange={vi.fn()} />, container)
      })
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Color for every plant"]')!
      await act(async () => { trigger.click() })
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

      // Move focus outside the popover so Escape must be handled by the Escape-chain popover layer.
      outside.focus()
      expect(document.activeElement).toBe(outside)

      let event!: KeyboardEvent
      await act(async () => {
        event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
        outside.dispatchEvent(event)
      })

      expect(event.defaultPrevented).toBe(true)
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(lowerLayerEscape).not.toHaveBeenCalled()

      // A second Escape now falls through to the lower layer.
      await act(async () => {
        outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(lowerLayerEscape).toHaveBeenCalledOnce()
    } finally {
      router.dispose()
      releaseLower()
    }
  })

  it('navigates across the 6-column swatch grid with Arrow keys, Home, and End', async () => {
    const onChange = vi.fn()
    await act(async () => {
      render(<CanopiColorSwatchPicker value={PLANT_COLOR_PALETTE[0]!.hex} ariaLabel="Color of Apple" onChange={onChange} />, container)
    })

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Color of Apple"]')!
    await act(async () => { trigger.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const swatches = dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')

    const press = async (key: string) => {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }

    expect(document.activeElement).toBe(swatches[0])

    await press('ArrowRight')
    expect(document.activeElement).toBe(swatches[1])
    expect(onChange).toHaveBeenLastCalledWith(PLANT_COLOR_PALETTE[1]!.hex)

    await press('ArrowDown')
    expect(document.activeElement).toBe(swatches[7])
    expect(onChange).toHaveBeenLastCalledWith(PLANT_COLOR_PALETTE[7]!.hex)

    await press('ArrowLeft')
    expect(document.activeElement).toBe(swatches[6])
    expect(onChange).toHaveBeenLastCalledWith(PLANT_COLOR_PALETTE[6]!.hex)

    await press('ArrowUp')
    expect(document.activeElement).toBe(swatches[0])
    expect(onChange).toHaveBeenLastCalledWith(PLANT_COLOR_PALETTE[0]!.hex)

    await press('End')
    expect(document.activeElement).toBe(swatches[PLANT_COLOR_PALETTE.length - 1])
    expect(onChange).toHaveBeenLastCalledWith(PLANT_COLOR_PALETTE[PLANT_COLOR_PALETTE.length - 1]!.hex)

    await press('Home')
    expect(document.activeElement).toBe(swatches[0])
    expect(onChange).toHaveBeenLastCalledWith(PLANT_COLOR_PALETTE[0]!.hex)
  })

  it('closes on an outside pointerdown without stealing focus back to the trigger', async () => {
    const outside = document.createElement('div')
    outside.tabIndex = 0
    document.body.append(outside)

    await act(async () => {
      render(<CanopiColorSwatchPicker value={PLANT_COLOR_PALETTE[0]!.hex} ariaLabel="Color of Mint" onChange={vi.fn()} />, container)
    })
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Color of Mint"]')!
    await act(async () => { trigger.click() })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).not.toBe(trigger)
  })

  it('does not close-and-reopen when clicking a wrapping label while open', async () => {
    await act(async () => {
      render(
        <label>
          <CanopiColorSwatchPicker value={PLANT_COLOR_PALETTE[0]!.hex} ariaLabel="Color of High" onChange={vi.fn()} />
          <span>High</span>
        </label>,
        container,
      )
    })

    const label = container.querySelector('label')!
    const labelText = label.querySelector('span')!
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Color of High"]')!

    await act(async () => { trigger.click() })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    // Simulate a real click on the label text: pointerdown on the label, followed by click which activates the button.
    await act(async () => {
      labelText.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      labelText.click()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
