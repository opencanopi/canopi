// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibrarySnapshot } from '../generated/contracts'
import { librarySnapshot } from './support/library-fixtures'

vi.mock('../app/shell/modal-layer', () => ({
  holdModalLayer: () => () => {},
  registerModalInertRegion: () => () => {},
}))

vi.mock('../app/lidar/actions', () => ({
  addToDesign: vi.fn(),
  cancelAnalysisJob: vi.fn(),
  cancelLibraryImport: vi.fn(),
  deleteLibraryItem: vi.fn(),
  dismissLibraryImport: vi.fn(),
  fetchDeleteImpact: vi.fn(),
  fetchLibraryDiskUsage: vi.fn().mockResolvedValue(0),
  renameLibraryItem: vi.fn(),
  rerunAnalysis: vi.fn(),
  retryLibraryImport: vi.fn(),
  showDataLibraryFolder: vi.fn(),
}))

vi.mock('../app/lidar/library-store', async () => {
  const { signal } = await import('@preact/signals')
  return {
    ...(await vi.importActual<typeof LibraryStoreModule>('../app/lidar/library-store')),
    installLidarLibraryObserver: () => () => {},
    lidarLibrary: signal<LibrarySnapshot | null>(null),
    lidarStatusMessage: signal<string | null>(null),
  }
})

vi.mock('../app/document-session/store', async () => {
  const { signal } = await import('@preact/signals')
  return { currentDesign: signal<unknown>(null) }
})

vi.mock('../components/panels/lidar/LibraryPreview', () => ({
  usePreviewClient: () => null,
  LibraryPreview: () => <span data-preview="true" />,
}))

import { lidarLibraryStatus, plantDbStatus } from '../app/health/state'
import { lidarLibrary } from '../app/lidar/library-store'
import { locale } from '../app/settings/state'
import { DataLibraryView } from '../components/panels/lidar/DataLibraryView'
import { DegradedBanner } from '../components/shared/DegradedBanner'
import type * as LibraryStoreModule from '../app/lidar/library-store'

const RECOVERED = 'Canopi rebuilt its Data library from the files it keeps. Items marked failed can be prepared again with Retry.'
const REFUSED_NEWER = 'The Data library was saved by a newer version of Canopi. Install the latest Canopi to use it; this version will not change it.'
const UNAVAILABLE = 'The Data library could not be opened. Imports and changes are off until Canopi restarts.'

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  plantDbStatus.value = 'available'
  lidarLibraryStatus.value = { kind: 'ready' }
  lidarLibrary.value = librarySnapshot([])
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  lidarLibraryStatus.value = { kind: 'ready' }
})

/**
 * The library's open state reaches the user in two places: the degraded banner
 * only when the library is read-only for the session, the Data library itself
 * for every state that is not simply ready.
 */
describe('Data library health', () => {
  describe('degraded banner', () => {
    it('stays hidden while the library is ready or merely recovered', async () => {
      await act(async () => { render(<DegradedBanner />, container) })
      expect(container.querySelector('[role="alert"]')).toBeNull()

      await act(async () => { lidarLibraryStatus.value = { kind: 'recovered', items: 3, generated: 1 } })
      expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it('names a library saved by a newer Canopi as an alert', async () => {
      lidarLibraryStatus.value = { kind: 'refused_newer' }
      await act(async () => { render(<DegradedBanner />, container) })
      const alerts = container.querySelectorAll('[role="alert"]')
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.textContent).toContain(REFUSED_NEWER)
    })

    it('names a library that could not be opened as an alert', async () => {
      lidarLibraryStatus.value = { kind: 'unavailable' }
      await act(async () => { render(<DegradedBanner />, container) })
      const alerts = container.querySelectorAll('[role="alert"]')
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.textContent).toContain(UNAVAILABLE)
    })

    it('stacks the plant catalog line and the Data library line in one row', async () => {
      plantDbStatus.value = 'missing'
      lidarLibraryStatus.value = { kind: 'unavailable' }
      await act(async () => { render(<DegradedBanner />, container) })
      const alerts = Array.from(container.querySelectorAll('[role="alert"]'), (alert) => alert.textContent)
      expect(alerts).toHaveLength(2)
      expect(alerts[0]).toContain("The plant catalog's database file is missing")
      expect(alerts[1]).toContain(UNAVAILABLE)
      expect(container.querySelectorAll('[role="alert"]')[0]!.parentElement)
        .toBe(container.querySelectorAll('[role="alert"]')[1]!.parentElement)
    })
  })

  describe('Data library dialog', () => {
    function notice(): Element | null {
      return container.querySelector('[data-notice-tone]')
    }

    it('shows no notice when the library opened ready', async () => {
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      expect(notice()).toBeNull()
    })

    it('explains a rebuilt library as a warning that names Retry', async () => {
      lidarLibraryStatus.value = { kind: 'recovered', items: 3, generated: 1 }
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      expect(notice()?.getAttribute('data-notice-tone')).toBe('warning')
      expect(notice()?.getAttribute('role')).toBe('status')
      expect(notice()?.textContent).toContain(RECOVERED)
    })

    it('explains a library saved by a newer Canopi as an error', async () => {
      lidarLibraryStatus.value = { kind: 'refused_newer' }
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      expect(notice()?.getAttribute('data-notice-tone')).toBe('error')
      expect(notice()?.getAttribute('role')).toBe('alert')
      expect(notice()?.textContent).toContain(REFUSED_NEWER)
    })

    it('explains a library that could not be opened as an error', async () => {
      lidarLibraryStatus.value = { kind: 'unavailable' }
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      expect(notice()?.getAttribute('data-notice-tone')).toBe('error')
      expect(notice()?.textContent).toContain(UNAVAILABLE)
    })

    it('follows the locale', async () => {
      lidarLibraryStatus.value = { kind: 'recovered', items: 1, generated: 0 }
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      await act(async () => { locale.value = 'fr' })
      expect(notice()?.textContent).toContain('Canopi a reconstruit sa Bibliothèque de données')
    })
  })
})
