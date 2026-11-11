// @vitest-environment jsdom
// The Web Edition's notices on the one notice row (2.1-Q290, 2.1-Q304): an action's outcome takes the front, older
// notices wait behind it in order and return once it is dismissed.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoticeRow } from '../components/shared/NoticeRow'
import { notices, resetNoticesForTests } from '../failures/notices'
import { reportFailure, resetFailureNoticesForTests } from '../failures/report'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import { t } from '../i18n'
import {
  presentBrowserDesignOpenFailure,
  presentBrowserDraftDownloadFailure,
  presentBrowserGeoJsonNotice,
  raiseEarlierDataNotice,
} from './browser-notices'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  resetNoticesForTests()
  resetFailureNoticesForTests()
  resetFrontendDiagnosticsForTests()
})

function shown(): string | undefined {
  return container.querySelector<HTMLElement>('[data-notice-row]')?.dataset.noticeKey
}

function count(): string | null | undefined {
  return container.querySelector('[data-notice-count]')?.textContent
}

function dismiss(): Promise<void> {
  return act(async () => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="${t('notice.dismiss')}"]`)!.click()
  })
}

describe('Web notices', () => {
  it('canopi-f47t.52.36: an action outcome shows at once over older queued notices, which return in order once it is dismissed (2.1-Q304)', async () => {
    await act(async () => render(<NoticeRow />, container))
    await act(async () => {
      raiseEarlierDataNotice()
      reportFailure(new Error('disk full'), { shown: 'notice', source: 'export', code: { kind: 'io', io: 'no_space' } })
    })
    expect(shown()).toBe('web.earlier-data')

    await act(async () => { presentBrowserGeoJsonNotice({ tone: 'info', title: 'geojson.importTitle', message: 'geojson.importNothing' }) })
    expect(shown(), 'the import summary takes the row').toBe('web.geojson')
    expect(count()).toBe('1 of 3')

    // A second outcome under the same key replaces the first, still at the front.
    await act(async () => { presentBrowserGeoJsonNotice({ tone: 'error', title: 'geojson.importTitle', message: 'geojson.readFailed' }) })
    expect(shown()).toBe('web.geojson')
    expect(container.textContent).toContain(t('geojson.readFailed'))
    expect(container.textContent).not.toContain(t('geojson.importNothing'))
    expect(count()).toBe('1 of 3')

    // What the user did last shows first.
    await act(async () => { presentBrowserDesignOpenFailure({ tone: 'error', title: 'start.cantOpenTitle', message: 'start.cantRead' }) })
    expect(shown()).toBe('web.open-failure')
    await act(async () => { presentBrowserDraftDownloadFailure() })
    expect(shown()).toBe('web.draft-download')
    expect(count()).toBe('1 of 5')

    await dismiss()
    expect(shown()).toBe('web.open-failure')
    await dismiss()
    expect(shown()).toBe('web.geojson')
    await dismiss()
    expect(shown(), 'the launch notice returns').toBe('web.earlier-data')
    await dismiss()
    expect(container.textContent).toContain(t('failure.diskFull'))
    expect(notices.value).toHaveLength(1)
  })
})
