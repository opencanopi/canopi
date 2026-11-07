// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locale } from '../../app/settings/state'
import { civilWeekStartDay } from '../../app/timeline/civil-date'
import { unmount } from '../../__tests__/support/unmount'
import { DatePicker } from './DatePicker'

describe('DatePicker week start', () => {
  let root: HTMLDivElement
  const previousLocale = locale.value

  beforeEach(() => {
    root = document.createElement('div')
    document.body.append(root)
  })

  afterEach(() => {
    unmount(root)
    root.remove()
    locale.value = previousLocale
  })

  it.fails('[1b-c7 canopi-f47t.52.82] DatePicker: a zh picker starts its week on Monday, like the Calendar grid', async () => {
    locale.value = 'zh'
    await act(() => {
      render(<DatePicker value="2026-07-04" onChange={() => undefined} />, root)
    })
    const toggle = root.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(toggle).not.toBeNull()
    await act(() => toggle!.click())

    const headers = [...root.querySelectorAll('[role="columnheader"]')].map((header) => header.textContent)
    // The Calendar panel's grid starts where civil-date says the zh week starts (Monday).
    expect(civilWeekStartDay('zh')).toBe(1)
    const monday = new Intl.DateTimeFormat('zh', { weekday: 'short' }).format(new Date(2024, 0, 8))
    expect(headers[0]).toBe(monday)
  })
})
