import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import { lidarLibraryStatus } from '../health/state'
import { readCurrentLidarPresentation, refreshLidarLibrary, resetLidarLibraryForTests } from './library-store'

describe('one library status', () => {
  afterEach(() => {
    resetLidarLibraryForTests()
    lidarLibraryStatus.value = { kind: 'ready' }
  })

  it.fails('[1b-c4 canopi-f47t.52.142] canopi-f47t.52.142: library rows, banner and report read one status', async () => {
    // The library opened (the banner and the report read ready), but its first list read failed: the store is busy.
    lidarLibraryStatus.value = { kind: 'ready' }
    mocks.listLibrary.mockRejectedValue(new Error('Native library operations are busy; try again'))
    await refreshLidarLibrary()

    const [row] = readCurrentLidarPresentation()
    // A row says what the one status says: not "not opened" while the banner says ready.
    expect(row?.availability).not.toBe('library-unopened')
  })
})
