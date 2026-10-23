// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatePicker } from '../components/shared/DatePicker'
import { locale } from '../app/settings/state'
import { beforePaint } from './support/before-paint'

describe('DatePicker', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.textContent = ''
    document.body.appendChild(container)
    locale.value = 'en'
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('renders trigger with formatted date when value is set', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-03-15" onChange={() => {}} />,
        container,
      )
    })
    const trigger = container.querySelector('button[role="combobox"]')
    expect(trigger).toBeTruthy()
    // Intl.DateTimeFormat for en with day:numeric, month:short, year:numeric
    const text = trigger!.textContent!
    expect(text).toContain('Mar')
    expect(text).toContain('15')
    expect(text).toContain('2025')
  })

  it('renders placeholder when value is empty', async () => {
    await act(async () => {
      render(
        <DatePicker value="" onChange={() => {}} placeholder="Pick a date" />,
        container,
      )
    })
    const trigger = container.querySelector('button[role="combobox"]')
    expect(trigger!.textContent).toBe('Pick a date')
  })

  it('click trigger opens calendar panel', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-06-10" onChange={() => {}} />,
        container,
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
  })

  it('click day cell calls onChange with ISO string and closes calendar', async () => {
    let changed = ''
    await act(async () => {
      render(
        <DatePicker value="2025-06-10" onChange={(v) => { changed = v }} />,
        container,
      )
    })

    // Open calendar
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    // Click day 20
    const dayBtn = container.querySelector('[data-day="20"]') as HTMLButtonElement
    expect(dayBtn).toBeTruthy()
    await act(async () => {
      dayBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(changed).toBe('2025-06-20')
    // Calendar should be closed
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('click outside closes calendar', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-06-10" onChange={() => {}} />,
        container,
      )
    })

    // Open
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()

    // Click outside
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes when another control takes focus', async () => {
    await act(async () => {
      render(
        <>
          <DatePicker value="2025-06-10" onChange={() => {}} />
          <button id="after" type="button">After</button>
        </>,
        container,
      )
    })
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()

    const after = container.querySelector<HTMLButtonElement>('#after')!
    await act(async () => { after.focus() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(after)
  })

  it('escape closes calendar and returns focus to trigger', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-06-10" onChange={() => {}} />,
        container,
      )
    })

    // Open
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()

    // Press Escape on the focused element inside the calendar (realistic path)
    const focused = container.querySelector('[role="dialog"] [tabindex="0"]') ?? container.querySelector('[role="dialog"]')!
    await act(async () => {
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('button[role="combobox"]'))
  })

  it('canopi-f47t.52.228.20: the calendar has focus and closes on Esc from its first painted frame', async () => {
    await act(async () => { render(<DatePicker value="2025-03-15" onChange={() => {}} />, container) })
    const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]')!
    // A click as WebKit gives it: the trigger is not focused.
    trigger.click()
    await beforePaint()
    const calendar = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(calendar.contains(document.activeElement), 'focus is in the calendar as it first shows').toBe(true)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await beforePaint()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('min/max constraints disable out-of-range days', async () => {
    await act(async () => {
      render(
        <DatePicker
          value="2025-06-15"
          onChange={() => {}}
          min="2025-06-10"
          max="2025-06-20"
        />,
        container,
      )
    })

    // Open
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    // Day 5 should be disabled
    const day5 = container.querySelector('[data-day="5"]') as HTMLButtonElement
    expect(day5).toBeTruthy()
    expect(day5.disabled).toBe(true)

    // Day 15 should not be disabled
    const day15 = container.querySelector('[data-day="15"]') as HTMLButtonElement
    expect(day15).toBeTruthy()
    expect(day15.disabled).toBe(false)

    // Day 25 should be disabled
    const day25 = container.querySelector('[data-day="25"]') as HTMLButtonElement
    expect(day25).toBeTruthy()
    expect(day25.disabled).toBe(true)
  })

  it('month navigation (prev/next) changes displayed month', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-06-10" onChange={() => {}} />,
        container,
      )
    })

    // Open
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    const label = container.querySelector('[aria-live="polite"]')!
    expect(label.textContent).toContain('June')
    expect(label.textContent).toContain('2025')

    // Click next
    const nextBtn = container.querySelectorAll('button[type="button"]')
    const nextNavBtn = Array.from(nextBtn).find(
      b => b.getAttribute('aria-label') === 'Next month'
    ) as HTMLButtonElement
    expect(nextNavBtn).toBeTruthy()

    await act(async () => {
      nextNavBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(label.textContent).toContain('July')
    expect(label.textContent).toContain('2025')

    // Click prev twice to go to May
    const prevNavBtn = Array.from(container.querySelectorAll('button[type="button"]')).find(
      b => b.getAttribute('aria-label') === 'Previous month'
    ) as HTMLButtonElement
    await act(async () => {
      prevNavBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      prevNavBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(label.textContent).toContain('May')
    expect(label.textContent).toContain('2025')
  })

  it('nav button disabled when adjacent month entirely outside min/max range', async () => {
    // Only June 2025 is selectable
    await act(async () => {
      render(
        <DatePicker
          value="2025-06-15"
          onChange={() => {}}
          min="2025-06-01"
          max="2025-06-30"
        />,
        container,
      )
    })

    // Open
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    const buttons = Array.from(container.querySelectorAll('button[type="button"]'))
    const prevBtn = buttons.find(b => b.getAttribute('aria-label') === 'Previous month') as HTMLButtonElement
    const nextBtn = buttons.find(b => b.getAttribute('aria-label') === 'Next month') as HTMLButtonElement

    expect(prevBtn.disabled).toBe(true)
    expect(nextBtn.disabled).toBe(true)
  })

  it('arrow keys navigate within the grid', async () => {
    let changed = ''
    await act(async () => {
      render(
        <DatePicker value="2025-06-15" onChange={(v) => { changed = v }} />,
        container,
      )
    })

    // Open calendar
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    // Initially focused on day 15 (the selected date)
    const day15 = container.querySelector('[data-day="15"]') as HTMLButtonElement
    expect(day15.tabIndex).toBe(0)

    // Press ArrowRight to move to day 16
    await act(async () => {
      day15.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const day16 = container.querySelector('[data-day="16"]') as HTMLButtonElement
    expect(document.activeElement).toBe(day16)

    // Press Enter to select day 16
    await act(async () => {
      day16.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(changed).toBe('2025-06-16')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('arrow key crossing month boundary navigates to next month', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-06-30" onChange={() => {}} />,
        container,
      )
    })

    // Open calendar
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    const label = container.querySelector('[aria-live="polite"]')!
    expect(label.textContent).toContain('June')

    // Day 30 should be focused
    const day30 = container.querySelector('[data-day="30"]') as HTMLButtonElement
    expect(day30.tabIndex).toBe(0)

    // Press ArrowRight to cross into July
    await act(async () => {
      day30.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })

    // Month should now be July
    expect(label.textContent).toContain('July')
    // Day 1 should exist and be focused
    const day1 = container.querySelector('[data-day="1"]') as HTMLButtonElement
    expect(day1).toBeTruthy()
  })

  it('locale change updates day/month names', async () => {
    await act(async () => {
      render(
        <DatePicker value="2025-06-10" onChange={() => {}} />,
        container,
      )
    })

    // Open
    await act(async () => {
      container.querySelector('button[role="combobox"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    const label = container.querySelector('[aria-live="polite"]')!
    expect(label.textContent).toContain('June')

    // Change locale to French
    await act(async () => {
      locale.value = 'fr'
    })

    // Re-render with new locale -- trigger text should update
    const trigger = container.querySelector('button[role="combobox"]')!
    const triggerText = trigger.textContent!
    // French short month for June is "juin"
    expect(triggerText.toLowerCase()).toContain('juin')
  })
})
