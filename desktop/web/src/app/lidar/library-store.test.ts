// One library status (canopi-f47t.52.142): rows, the notice row and the problem report read how the library opened from
// the one health model; a list that cannot be refreshed keeps its last rows, marked stale, under one notice with Try
// again (2.1-Q297); a cancelled import the library withdrew leaves one short notice and nothing else (2.1-Q298).
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { librarySnapshot, sourceItem } from '../../__tests__/support/library-fixtures'
import type { LibrarySnapshot } from '../../generated/contracts'
import { applyHealthSnapshot, resetStoreHealthForTests } from '../../failures/health'
import { notices, resetNoticesForTests } from '../../failures/notices'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../../failures/ring'

const mocks = vi.hoisted(() => ({
  listLibrary: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('../../ipc/lidar', () => ({ lidarListLibrary: mocks.listLibrary }))
vi.mock('../document-session/store', () => ({
  currentDesign: signal({
    lidar: {
      visible: true,
      entries: [{ kind: 'Source', id: 'item-1', name: 'Orchard', visible: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null }],
    },
  }),
}))

import {
  ensureLidarPolling,
  lidarLibrary,
  lidarLibraryStale,
  noteImportCancel,
  readCurrentLidarPresentation,
  refreshLidarLibrary,
  resetLidarLibraryForTests,
} from './library-store'

const BUSY = new Error('Native library operations are busy; try again')

function running(id: string): LibrarySnapshot {
  return librarySnapshot([sourceItem(id, 'Orchard', {
    generation_id: null,
    state: 'Preparing',
    import_job: { job_id: `job-${id}`, layer_id: id, state: 'Staging', message: null, progress: null },
  })])
}

function cancelledNotices() {
  return notices.value.filter((notice) => notice.message === 'canvas.lidar.library.importCancelled')
}

function staleNotices() {
  return notices.value.filter((notice) => notice.message === 'health.libraryListStale')
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.listLibrary.mockReset()
  resetLidarLibraryForTests()
  resetStoreHealthForTests()
  resetNoticesForTests()
  resetFrontendDiagnosticsForTests()
  applyHealthSnapshot({ library_catalogue: { status: { kind: 'ready' }, notice: null } })
})

afterEach(() => {
  resetLidarLibraryForTests()
  vi.useRealTimers()
})

describe('one library status', () => {
  it('[1b-c4 canopi-f47t.52.142] canopi-f47t.52.142: library rows, banner and report read one status', async () => {
    // The library opened (the banner and the report read ready), but its first list read failed: the store is busy.
    mocks.listLibrary.mockRejectedValue(BUSY)
    await refreshLidarLibrary()

    const [row] = readCurrentLidarPresentation()
    // A row says what the one status says: not "not opened" while the banner says ready.
    expect(row?.availability).toBe('loading')
    // The one status the rows read is the model's: a library that did not open marks its rows unopened.
    applyHealthSnapshot({ library_catalogue: { status: { kind: 'unavailable', code: { kind: 'library_read_only', reason: 'unavailable' } }, notice: null } })
    expect(readCurrentLidarPresentation()[0]?.availability).toBe('library-unopened')
    applyHealthSnapshot({ library_catalogue: { status: { kind: 'refused_newer' }, notice: null } })
    expect(readCurrentLidarPresentation()[0]?.availability).toBe('needs-newer-canopi')
  })

  it('[canopi-f47t.52.142] a list that fails while health is ready keeps its last rows, marked stale, with one notice, and polling continues (2.1-Q297)', async () => {
    mocks.listLibrary.mockResolvedValue(running('item-1'))
    ensureLidarPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(readCurrentLidarPresentation()[0]?.availability).toBe('present')

    mocks.listLibrary.mockRejectedValue(BUSY)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(1500)

    expect(lidarLibrary.value?.items.map((item) => item.id)).toEqual(['item-1'])
    expect(readCurrentLidarPresentation()[0]?.availability).toBe('present')
    expect(lidarLibraryStale.value).toBe(true)
    expect(staleNotices()).toHaveLength(1)
    // The failure reached the sink once for the streak.
    expect(ringEntries().filter((entry) => entry.source === 'library.list')).toHaveLength(1)
    // Polling went on: work was running when the list was last read.
    const calls = mocks.listLibrary.mock.calls.length
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.listLibrary.mock.calls.length).toBeGreaterThan(calls)

    // Try again reads the list; once it reads, the rows are current and the notice leaves the row.
    mocks.listLibrary.mockResolvedValue(librarySnapshot([sourceItem('item-1', 'Orchard')]))
    staleNotices()[0]!.action!.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(lidarLibraryStale.value).toBe(false)
    expect(staleNotices()).toHaveLength(0)
  })

  it('[canopi-f47t.52.142] a list response older than the published one is dropped', async () => {
    let answerOld!: (snapshot: LibrarySnapshot) => void
    mocks.listLibrary.mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve }))
    const older = refreshLidarLibrary()
    resetLidarLibraryForTests()
    applyHealthSnapshot({ library_catalogue: { status: { kind: 'ready' }, notice: null } })
    mocks.listLibrary.mockResolvedValue(librarySnapshot([sourceItem('item-1', 'Orchard')]))
    await refreshLidarLibrary()

    answerOld(librarySnapshot([]))
    await older
    expect(lidarLibrary.value?.items.map((item) => item.id)).toEqual(['item-1'])
  })
})

describe('a cancelled import (2.1-Q298)', () => {
  it('[canopi-f47t.52.38] an import withdrawn after Cancel leaves the list with one short notice and no lasting state', async () => {
    mocks.listLibrary.mockResolvedValue(running('import-1'))
    await refreshLidarLibrary()
    noteImportCancel('import-1')

    // Still staging: no notice yet.
    await refreshLidarLibrary()
    expect(cancelledNotices()).toHaveLength(0)

    mocks.listLibrary.mockResolvedValue(librarySnapshot([]))
    await refreshLidarLibrary()
    expect(cancelledNotices()).toEqual([expect.objectContaining({ tone: 'info' })])
    await refreshLidarLibrary()
    expect(cancelledNotices()).toHaveLength(1)
    // Short (four seconds): it leaves by itself, and nothing brings it back.
    await vi.advanceTimersByTimeAsync(4000)
    expect(cancelledNotices()).toHaveLength(0)
    await refreshLidarLibrary()
    expect(cancelledNotices()).toHaveLength(0)
  })

  it('[canopi-f47t.52.38] a cancelled import that failed first, or published, keeps its row with no notice', async () => {
    mocks.listLibrary.mockResolvedValue(running('import-1'))
    await refreshLidarLibrary()
    noteImportCancel('import-1')
    mocks.listLibrary.mockResolvedValue(librarySnapshot([sourceItem('import-1', 'Orchard', {
      import_job: { job_id: 'job-import-1', layer_id: 'import-1', state: 'Failed', message: null, progress: null },
    })]))
    await refreshLidarLibrary()
    mocks.listLibrary.mockResolvedValue(librarySnapshot([]))
    await refreshLidarLibrary()
    expect(cancelledNotices()).toHaveLength(0)
  })
})
