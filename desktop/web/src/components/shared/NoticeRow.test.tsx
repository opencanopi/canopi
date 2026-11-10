// @vitest-environment jsdom
// The one notice row (contracts §18 F3, 2.1-Q290): one notice at a time with its place in the count, oldest first,
// each kept until dismissed, worded in the current locale.
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locale } from '../../app/settings/state'
import { raiseNotice, resetNoticesForTests } from '../../failures/notices'
import { reportFailure, resetFailureNoticesForTests } from '../../failures/report'
import { resetFrontendDiagnosticsForTests } from '../../failures/ring'
import { t } from '../../i18n'
import { NoticeRow } from './NoticeRow'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  locale.value = 'en'
  resetNoticesForTests()
  resetFailureNoticesForTests()
  resetFrontendDiagnosticsForTests()
})

function dismiss(): Promise<void> {
  return act(async () => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="${t('notice.dismiss')}"]`)!.click()
  })
}

describe('NoticeRow', () => {
  it('shows nothing while no notice waits', async () => {
    await act(async () => render(<NoticeRow />, container))
    expect(container.querySelector('[data-notice-row]')).toBeNull()
  })

  it('a boot notice then an action notice: both kept, the oldest shown first with "1 of 2", the next once it is dismissed', async () => {
    await act(async () => render(<NoticeRow />, container))
    await act(async () => {
      raiseNotice({ key: 'health.localDataNotOpened', title: 'health.localDataNotOpenedTitle', message: 'health.localDataNotOpened' })
      reportFailure(new Error('disk full'), { shown: 'notice', source: 'export', code: { kind: 'io', io: 'no_space' } })
    })
    const row = container.querySelector('[data-notice-row]')!
    expect(row.textContent).toContain(t('health.localDataNotOpened'))
    expect(row.querySelector('[data-notice-count]')?.textContent).toBe('1 of 2')
    await dismiss()
    expect(container.textContent).toContain(t('failure.diskFull'))
    expect(container.querySelector('[data-notice-count]')).toBeNull()
    await dismiss()
    expect(container.querySelector('[data-notice-row]')).toBeNull()
  })

  it('re-renders a shown notice when the locale changes', async () => {
    await act(async () => render(<NoticeRow />, container))
    await act(async () => {
      raiseNotice({ key: 'busy', message: 'failure.busy', tone: 'error' })
    })
    const english = container.textContent
    await act(async () => {
      locale.value = 'fr'
    })
    expect(container.textContent).toBe(t('failure.busy'))
    expect(container.textContent).not.toBe(english)
  })

  it('runs a notice action without dismissing it', async () => {
    let runs = 0
    await act(async () => render(<NoticeRow />, container))
    await act(async () => {
      raiseNotice({ key: 'retry', message: 'failure.connection', action: { label: 'boundary.tryAgain', run: () => { runs += 1 } } })
    })
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === t('boundary.tryAgain'))!.click()
    })
    expect(runs).toBe(1)
    expect(container.querySelector('[data-notice-row]')).not.toBeNull()
  })

  it('[canopi-f47t.52.36] a notice reads its live words and a second sentence in the current locale', async () => {
    const designOpen = signal(true)
    await act(async () => render(<NoticeRow />, container))
    await act(async () => {
      raiseNotice({
        key: 'import',
        message: 'geojson.importNothing',
        detail: { message: 'geojson.importSkipped', params: { count: 2 } },
        messageNow: () => (designOpen.value ? 'webRelease.message' : 'webRelease.messageNoDesign'),
      })
    })
    expect(container.textContent).toContain(t('webRelease.message'))
    expect(container.textContent).toContain(t('geojson.importSkipped', { count: 2 }))
    await act(async () => { designOpen.value = false })
    expect(container.textContent).toContain(t('webRelease.messageNoDesign'))
  })

  it('[canopi-f47t.52.36] while its action is busy the action reads its busy words, and neither it nor Dismiss takes a click', async () => {
    const busy = signal(false)
    let runs = 0
    let dismissed = 0
    await act(async () => render(<NoticeRow />, container))
    await act(async () => {
      raiseNotice({
        key: 'web.release',
        message: 'webRelease.message',
        action: { label: 'notice.reload', run: () => { runs += 1 }, busy: { label: 'saveStatus.saving', now: () => busy.value } },
        onDismiss: () => { dismissed += 1 },
      })
    })
    const action = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => !button.hasAttribute('aria-label'))!
    const dismissButton = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${t('notice.dismiss')}"]`)!
    expect(action().textContent).toBe(t('notice.reload'))
    await act(async () => { busy.value = true })
    expect(action().textContent).toBe(t('saveStatus.saving'))
    expect(action().disabled).toBe(true)
    expect(dismissButton().disabled).toBe(true)
    await act(async () => { action().click(); dismissButton().click() })
    expect(runs).toBe(0)
    expect(dismissed).toBe(0)
    await act(async () => { busy.value = false })
    expect(dismissButton().disabled).toBe(false)
  })
})
