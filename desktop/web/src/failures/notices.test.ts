// The one notice row is an ordered queue (contracts §13; design check A17, F16; 2.1-Q290): notices are kept oldest
// first until dismissed, so a notice raised during boot is not replaced by the next, and a key already queued adds none.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissNotice, notices, raiseNotice, resetNoticesForTests } from './notices'
import { failureNoticesForTests, reportFailure, resetFailureNoticesForTests } from './report'
import { resetFrontendDiagnosticsForTests } from './ring'

afterEach(() => {
  resetNoticesForTests()
  resetFailureNoticesForTests()
  resetFrontendDiagnosticsForTests()
})

describe('notice queue', () => {
  it('canopi-f47t.52.107: a notice raised during boot survives the next notice', () => {
    raiseNotice({ key: 'health.localDataNotOpened', message: 'health.localDataNotOpened' })
    reportFailure(new Error('export failed'), { shown: 'notice', source: 'export' })
    expect(notices.value.map((notice) => notice.key)).toEqual([
      'health.localDataNotOpened',
      expect.stringContaining('@export'),
    ])
  })

  it('the same notice raised twice is one entry: the key is the code plus its StoreId or op', () => {
    const first = raiseNotice({ key: 'library_read_only@library', message: 'failure.libraryUnavailable' })
    const second = raiseNotice({ key: 'library_read_only@library', message: 'failure.libraryUnavailable' })
    expect(second).toBe(first)
    reportFailure(new Error('one'), { shown: 'notice', source: 'drafts.write' })
    reportFailure(new Error('two'), { shown: 'notice', source: 'drafts.write' })
    expect(notices.value).toHaveLength(2)
    expect(failureNoticesForTests().notices).toHaveLength(1)
  })

  it('[canopi-f47t.52.36] an undismissable status queues ahead of every notice the user can dismiss, oldest status first', () => {
    raiseNotice({ key: 'older', message: 'failure.internal' })
    raiseNotice({ key: 'status.one', message: 'update.installing', undismissable: true })
    raiseNotice({ key: 'newer', message: 'failure.internal' })
    raiseNotice({ key: 'status.two', message: 'update.finishing', undismissable: true })
    expect(notices.value.map((notice) => notice.key)).toEqual(['status.one', 'status.two', 'older', 'newer'])
  })

  it('a dismissed notice leaves the queue and tells its raiser once', () => {
    const onDismiss = vi.fn()
    const id = raiseNotice({ key: 'update', message: 'update.available', onDismiss })
    raiseNotice({ key: 'later', message: 'failure.internal' })
    dismissNotice(id)
    dismissNotice(id)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(notices.value.map((notice) => notice.key)).toEqual(['later'])
  })

  it('[canopi-f47t.52.36] a standing offer (a waiting release) yields: every notice raised after it queues ahead (2.1-M182)', () => {
    raiseNotice({ key: 'earlier', message: 'health.localDataNotOpened' })
    raiseNotice({ key: 'web.release', message: 'webRelease.message', yields: true })
    raiseNotice({ key: 'import', message: 'geojson.importNothing' })
    raiseNotice({ key: 'status', message: 'update.installing', undismissable: true })
    expect(notices.value.map((notice) => notice.key)).toEqual(['status', 'earlier', 'import', 'web.release'])
  })
})
