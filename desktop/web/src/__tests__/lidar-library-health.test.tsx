// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibrarySnapshot, StoreOpenStatus } from '../generated/contracts'
import { librarySnapshot, sourceItem } from './support/library-fixtures'

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

import { lidarLibrary } from '../app/lidar/library-store'
import { locale } from '../app/settings/state'
import { DataLibraryView } from '../components/panels/lidar/DataLibraryView'
import { NoticeRow } from '../components/shared/NoticeRow'
import { applyHealthSnapshot, resetStoreHealthForTests } from '../failures/health'
import { installHealthNotices } from '../failures/health-notices'
import { resetNoticesForTests } from '../failures/notices'
import type * as LibraryStoreModule from '../app/lidar/library-store'

const RECOVERED = 'Canopi rebuilt its Data library from the files it keeps. Items marked failed can be prepared again with Retry.'
const NEWER_READ_ONLY = 'The Data library was saved by a newer Canopi. Its items are listed, but changes won’t be saved. Update Canopi to use them.'
const UNAVAILABLE = 'The Data library could not be opened. Imports and changes are off until Canopi restarts.'
const LIBRARY_UNOPENED: StoreOpenStatus = { kind: 'unavailable', code: { kind: 'library_read_only', reason: 'unavailable' } }

let container: HTMLDivElement
let disposeNotices: () => void

function libraryStatus(status: StoreOpenStatus): void {
  applyHealthSnapshot({ library_catalogue: { status, notice: null } })
}

beforeEach(() => {
  locale.value = 'en'
  resetStoreHealthForTests()
  resetNoticesForTests()
  libraryStatus({ kind: 'ready' })
  lidarLibrary.value = librarySnapshot([])
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
 * The library's open state reaches the user in two places (canopi-f47t.52.142): the one notice row only when the
 * library is read-only for the session, the Data library itself for every state that is not simply ready.
 */
describe('Data library health', () => {
  describe('notice row', () => {
    it('stays empty while the library is ready or merely recovered', async () => {
      await act(async () => { render(<NoticeRow />, container) })
      expect(container.querySelector('[data-notice-row]')).toBeNull()

      await act(async () => { libraryStatus({ kind: 'recovered', items: 3, generated: 1 }) })
      expect(container.querySelector('[data-notice-row]')).toBeNull()
    })

    it('canopi-f47t.52.271: names a library saved by a newer Canopi once, as a warning that offers Update', async () => {
      libraryStatus({ kind: 'newer_read_only' })
      await act(async () => { render(<NoticeRow />, container) })
      const row = container.querySelector('[data-notice-row]')
      expect(container.querySelectorAll('[data-notice-row]')).toHaveLength(1)
      expect(row?.textContent).toContain(NEWER_READ_ONLY)
      expect(row?.querySelector('[role="alert"]')).toBeNull()
    })

    it('names a library that could not be opened as an alert', async () => {
      libraryStatus(LIBRARY_UNOPENED)
      await act(async () => { render(<NoticeRow />, container) })
      const alerts = container.querySelectorAll('[role="alert"]')
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.textContent).toContain(UNAVAILABLE)
    })

    it('queues the plant catalog notice and the Data library notice on the one row', async () => {
      applyHealthSnapshot({
        plant_catalog: { status: { kind: 'unavailable', code: { kind: 'plant_db_unavailable', cause: 'missing' } }, notice: null },
        library_catalogue: { status: LIBRARY_UNOPENED, notice: null },
      })
      await act(async () => { render(<NoticeRow />, container) })
      expect(container.querySelectorAll('[data-notice-row]')).toHaveLength(1)
      expect(container.querySelector('[data-notice-count]')?.textContent).toContain('2')
      expect(container.querySelector('[data-notice-row]')?.textContent).toContain(UNAVAILABLE)
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
      libraryStatus({ kind: 'recovered', items: 3, generated: 1 })
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      expect(notice()?.getAttribute('data-notice-tone')).toBe('warning')
      expect(notice()?.getAttribute('role')).toBe('status')
      expect(notice()?.textContent).toContain(RECOVERED)
    })

    it('canopi-f47t.52.271: lists a library saved by a newer Canopi by name and type with a note to update, every action off', async () => {
      libraryStatus({ kind: 'newer_read_only' })
      const newer = { state: 'NeedsNewer' as const, generation_id: null, bounds: null, value_range: null, offers: [] }
      lidarLibrary.value = librarySnapshot([
        sourceItem('lyr-1', 'Orchard terrain', { ...newer, newer_kind: 'raster' }),
        sourceItem('vec-1', 'Hedge lines', { ...newer, newer_kind: 'vector' }),
        sourceItem('pc-1', 'Hedge scan', newer),
      ])
      await act(async () => { render(<DataLibraryView focusId="vec-1" />, container) })

      // The one notice is the notice row's (health presentation): the sheet adds none of its own.
      expect(notice()).toBeNull()
      const rows = [...container.querySelectorAll('[role="option"]')].map((row) => row.textContent)
      expect(rows).toHaveLength(3)
      expect(rows.find((row) => row?.includes('Orchard terrain'))).toContain('Raster data')
      expect(rows.find((row) => row?.includes('Hedge lines'))).toContain('Vector data')
      expect(rows.find((row) => row?.includes('Hedge scan'))).toContain('Data of a type this Canopi doesn’t know')
      expect(rows.every((row) => row?.includes('Update Canopi to use this item.'))).toBe(true)
      expect(rows.some((row) => row?.includes('Import failed'))).toBe(false)
      const details = container.querySelector('section[aria-labelledby="library-details-heading"]')!
      expect(details.querySelector('h3')?.textContent).toBe('Hedge lines')
      expect(details.textContent).toContain('Update Canopi to use this item.')
      // No Add, Rename, Delete everywhere, Retry or Dismiss: only Back.
      expect([...details.querySelectorAll('button')].map((button) => button.getAttribute('data-focus-target'))).toEqual(['back'])
    })

    it('canopi-f47t.52.271: a search lists only the newer Canopi items whose name matches, none kept as failed', async () => {
      libraryStatus({ kind: 'newer_read_only' })
      const newer = { state: 'NeedsNewer' as const, generation_id: null, bounds: null, value_range: null, offers: [] }
      lidarLibrary.value = librarySnapshot([
        sourceItem('lyr-1', 'Orchard terrain', { ...newer, newer_kind: 'raster' }),
        sourceItem('vec-1', 'Hedge lines', { ...newer, newer_kind: 'vector' }),
      ])
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
      await act(async () => {
        search.value = 'hedge'
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect([...container.querySelectorAll('[role="option"] strong')].map((name) => name.textContent)).toEqual(['Hedge lines'])
    })

    it('explains a library that could not be opened as an error', async () => {
      libraryStatus(LIBRARY_UNOPENED)
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      expect(notice()?.getAttribute('data-notice-tone')).toBe('error')
      expect(notice()?.textContent).toContain(UNAVAILABLE)
    })

    it('follows the locale', async () => {
      libraryStatus({ kind: 'recovered', items: 1, generated: 0 })
      await act(async () => { render(<DataLibraryView focusId={null} />, container) })
      await act(async () => { locale.value = 'fr' })
      expect(notice()?.textContent).toContain('Canopi a reconstruit sa Bibliothèque de données')
    })
  })
})
