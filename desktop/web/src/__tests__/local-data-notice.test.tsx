// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../app/shell/modal-layer', () => ({
  holdModalLayer: () => () => {},
  registerModalInertRegion: () => () => {},
}))

import { applyHealthSnapshot, resetStoreHealthForTests, storeHealth } from '../failures/health'
import { installHealthNotices } from '../failures/health-notices'
import { resetNoticesForTests } from '../failures/notices'
import { locale } from '../app/settings/state'
import { NoticeRow } from '../components/shared/NoticeRow'

const NOT_OPENED = 'Canopi 2.0 can’t open data saved by earlier versions. It was left unchanged, and Canopi started fresh.'

let container: HTMLDivElement
let disposeNotices: () => void

beforeEach(() => {
  locale.value = 'en'
  resetStoreHealthForTests()
  resetNoticesForTests()
  disposeNotices = installHealthNotices({ report: null, update: null })
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  disposeNotices()
  resetStoreHealthForTests()
  resetNoticesForTests()
})

/**
 * Canopi 2.0 does not open local data from before 2.0 (ADR 0021). The native
 * side reports it on the start that renamed the 1.x user database only; the
 * notice row says so until the user dismisses it (canopi-f47t.52.36).
 */
describe('local data from before Canopi 2.0', () => {
  it('says nothing when the local data is current', async () => {
    applyHealthSnapshot({ user_db: { status: { kind: 'ready' }, notice: null } })
    await act(async () => { render(<NoticeRow />, container) })
    expect(container.querySelector('[data-notice-row]')).toBeNull()
  })

  it('tells the user once that earlier data was not opened, until dismissed', async () => {
    applyHealthSnapshot({ user_db: { status: { kind: 'ready' }, notice: 'moved_aside_pre_2_0' } })
    await act(async () => { render(<NoticeRow />, container) })

    const row = container.querySelector('[data-notice-row]')
    expect(row?.textContent).toContain(NOT_OPENED)
    // Info is announced politely, never as an alert.
    expect(container.querySelector('[role="alert"]')).toBeNull()

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')
    expect(dismiss).not.toBeNull()
    await act(async () => { dismiss!.click() })

    expect(container.querySelector('[data-notice-row]')).toBeNull()
    expect(storeHealth.value.user_db?.notice).toBeNull()
  })

  it('queues with a degraded subsystem in the same row', async () => {
    applyHealthSnapshot({
      user_db: { status: { kind: 'ready' }, notice: 'moved_aside_pre_2_0' },
      plant_catalog: { status: { kind: 'unavailable', code: { kind: 'plant_db_unavailable', cause: 'missing' } }, notice: null },
    })
    await act(async () => { render(<NoticeRow />, container) })

    expect(container.querySelectorAll('[data-notice-row]')).toHaveLength(1)
    expect(container.querySelector('[data-notice-count]')?.textContent).toContain('2')
  })
})
