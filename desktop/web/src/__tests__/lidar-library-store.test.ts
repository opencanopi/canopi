import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibrarySnapshot, LidarImportJob } from '../generated/contracts'
import { librarySnapshot, slopeItem, sourceItem } from './support/library-fixtures'

const listLibraryMock = vi.hoisted(() => vi.fn())

vi.mock('../ipc/lidar', () => ({ lidarListLibrary: listLibraryMock }))

import {
  ensureLidarPolling,
  hasActiveLibraryWork,
  installLidarLibraryObserver,
  isMissing,
  lidarLibrary,
  lidarStatusMessage,
  readLidarPresentation,
  refreshLidarLibrary,
  resetLidarLibraryForTests,
} from '../app/lidar/library-store'
import { locale } from '../app/settings/state'
import { recentFrontendDiagnostics, resetFrontendDiagnosticsForTests } from '../app/problem-report/diagnostics'

const emptyLibrary: LibrarySnapshot = librarySnapshot([])

function importing(state: LidarImportJob['state']): LibrarySnapshot {
  return librarySnapshot([sourceItem('layer-1', 'Ground', {
    generation_id: state === 'Complete' ? 'generation-1' : null,
    state: state === 'Complete' ? 'Ready' : 'Preparing',
    import_job: { job_id: 'job-1', layer_id: 'layer-1', state, message: null, progress: null },
  })])
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('LiDAR library polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listLibraryMock.mockReset().mockResolvedValue(emptyLibrary)
    resetLidarLibraryForTests()
  })

  afterEach(() => {
    resetLidarLibraryForTests()
    vi.useRealTimers()
  })

  it('canopi-f47t.52.228.56: the test reset clears the timer, the read in flight, the failed-read streak and the read counters', async () => {
    // Leave every piece of module state dirty: a failed streak, a read in flight, a running timer, advanced counters.
    listLibraryMock.mockRejectedValueOnce('first failure')
    await refreshLidarLibrary()
    expect(lidarStatusMessage.value).not.toBeNull()
    listLibraryMock.mockReturnValue(new Promise(() => {}))
    ensureLidarPolling()
    void refreshLidarLibrary()

    resetLidarLibraryForTests()

    expect(lidarLibrary.value).toBeNull()
    expect(lidarStatusMessage.value).toBeNull()
    // The failed streak is forgotten: the next failure reaches diagnostics again.
    resetFrontendDiagnosticsForTests()
    listLibraryMock.mockReset().mockRejectedValueOnce('second failure')
    await refreshLidarLibrary()
    expect(recentFrontendDiagnostics().some((entry) => entry.message.includes('second failure'))).toBe(true)
    resetLidarLibraryForTests()
    // The timer is gone.
    listLibraryMock.mockReset().mockResolvedValue(emptyLibrary)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(listLibraryMock).not.toHaveBeenCalled()
    // A new read starts at once instead of joining the abandoned one, and publishes.
    await refreshLidarLibrary()
    expect(listLibraryMock).toHaveBeenCalledTimes(1)
    expect(lidarLibrary.value).toEqual(emptyLibrary)
  })

  it('treats running imports and calculations as active work, settled ones as idle', () => {
    expect(hasActiveLibraryWork(importing('Staging'))).toBe(true)
    expect(hasActiveLibraryWork(importing('Applying'))).toBe(true)
    expect(hasActiveLibraryWork(importing('Failed'))).toBe(false)
    expect(hasActiveLibraryWork(importing('Complete'))).toBe(false)
    expect(hasActiveLibraryWork(null)).toBe(false)
  })

  it('treats a running analysis as active work, including a refresh of a published result', () => {
    const running = { job_id: 'j', state: 'Preparing' as const, message: null }
    expect(hasActiveLibraryWork(librarySnapshot([slopeItem('s', 'a', { generation_id: null, state: 'Preparing', run: running })]))).toBe(true)
    expect(hasActiveLibraryWork(librarySnapshot([slopeItem('s', 'a', { run: running })]))).toBe(true)
    expect(hasActiveLibraryWork(librarySnapshot([slopeItem('s', 'a')]))).toBe(false)
  })

  it('polls a running import until it settles, then stops', async () => {
    listLibraryMock.mockResolvedValue(importing('Staging'))
    ensureLidarPolling()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_500)
    const running = listLibraryMock.mock.calls.length
    expect(running).toBeGreaterThanOrEqual(2)

    listLibraryMock.mockResolvedValue(importing('Complete'))
    await vi.advanceTimersByTimeAsync(1_500)
    const settled = listLibraryMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)

    expect(listLibraryMock).toHaveBeenCalledTimes(settled)
    expect(lidarLibrary.value?.items[0]?.generation_id).toBe('generation-1')
  })

  it('does not poll a failed import forever', async () => {
    listLibraryMock.mockResolvedValue(importing('Failed'))
    ensureLidarPolling()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(listLibraryMock.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('closing the dock does not stop an import from settling', async () => {
    listLibraryMock.mockResolvedValue(importing('Staging'))
    const dispose = installLidarLibraryObserver()
    await flushMicrotasks()
    dispose()

    listLibraryMock.mockResolvedValue(importing('Complete'))
    await vi.advanceTimersByTimeAsync(1_500)
    await flushMicrotasks()
    expect(lidarLibrary.value?.items[0]?.import_job?.state).toBe('Complete')
  })

  it('reopening the dock refreshes at once', async () => {
    installLidarLibraryObserver()
    await flushMicrotasks()
    const before = listLibraryMock.mock.calls.length
    listLibraryMock.mockResolvedValue(importing('Complete'))

    installLidarLibraryObserver()
    await flushMicrotasks()
    expect(listLibraryMock.mock.calls.length).toBeGreaterThan(before)
    expect(lidarLibrary.value?.items).toHaveLength(1)
  })

  it('refuses a malformed snapshot as a failed read in the interface language, keeping the reason for diagnostics, and stops polling', async () => {
    resetFrontendDiagnosticsForTests()
    locale.value = 'fr'
    listLibraryMock.mockResolvedValue({ plant_db: 'missing' })
    ensureLidarPolling()
    await flushMicrotasks()
    await flushMicrotasks()
    locale.value = 'en'
    expect(lidarLibrary.value).toBeNull()
    expect(lidarStatusMessage.value).toMatch(/^Canopi n’a pas pu terminer\./)
    expect(recentFrontendDiagnostics().some((entry) => /malformed/i.test(entry.message))).toBe(true)
    const calls = listLibraryMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(listLibraryMock.mock.calls.length).toBe(calls)
  })

  it('keeps polling running work through failed reads, recording the failure once until a read succeeds', async () => {
    listLibraryMock.mockResolvedValue(importing('Staging'))
    ensureLidarPolling()
    await flushMicrotasks()
    resetFrontendDiagnosticsForTests()
    listLibraryMock.mockRejectedValue('LibraryUnavailable: catalogue is locked')
    await vi.advanceTimersByTimeAsync(1_500 * 10)
    const failures = () => recentFrontendDiagnostics().filter((entry) => entry.message.includes('catalogue is locked')).length
    expect(listLibraryMock.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(failures()).toBe(1)

    listLibraryMock.mockResolvedValueOnce(importing('Staging'))
    await vi.advanceTimersByTimeAsync(1_500 * 3)
    expect(failures()).toBe(2)
  })
})

describe('LiDAR presentation join', () => {
  beforeEach(() => {
    locale.value = 'en'
  })

  it('joins Design entries with their items, typed and in their own units, back to front', () => {
    const library = librarySnapshot([
      sourceItem('ground', 'Ground', { display_range: { min: 100, max: 180, basis: 'Exact' } }),
      slopeItem('slope', 'ground', {
        units: '%',
        freshness: { state: 'Stale', reasons: [{ reason: 'InputUpdated', input_key: 'dem', item_id: 'ground' }] },
      }),
    ])
    const design = { lidar: { visible: true, entries: [
      { kind: 'Derived' as const, id: 'slope', name: 'Ground · Slope', visible: true, opacity: 0.5, order: 1, ramp: 'Magma' as const, reversed: true, range: { mode: 'Custom' as const, min: 0, max: 30 } },
      { kind: 'Source' as const, id: 'ground', name: 'Ground', visible: false, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
      { kind: 'Derived' as const, id: 'gone', name: 'Old terrain', visible: true, opacity: 1, order: 2, ramp: null, reversed: false, range: null },
    ] } }

    const [ground, slope, gone] = readLidarPresentation(design, library)
    expect(ground).toMatchObject({ kind: 'Source', name: 'Ground', units: 'm', displayRange: [100, 180], definitionId: null, availability: 'present' })
    expect(slope).toMatchObject({
      kind: 'Derived',
      name: 'Ground · Slope',
      itemType: { kind: 'Raster', quantity: 'Slope' },
      units: '%',
      definitionId: 'slope-def',
      freshness: { state: 'Stale' },
      ramp: 'Magma',
      reversed: true,
      range: { mode: 'Custom', min: 0, max: 30 },
    })
    // A missing item reads by the name the Design stored, with the reason.
    expect(gone).toMatchObject({ kind: 'Derived', state: null, itemType: null, name: 'Old terrain', availability: 'not-in-library' })
    expect([ground, slope, gone].map((item) => item && isMissing(item))).toEqual([false, false, true])
  })

  it('folds the Site data eye with each own eye into shown, keeping the own eye', () => {
    const library = librarySnapshot([sourceItem('ground', 'Ground')])
    const read = (section: boolean, own: boolean) => readLidarPresentation({ lidar: { visible: section, entries: [
      { kind: 'Source', id: 'ground', name: 'Ground', visible: own, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
    ] } }, library)[0]

    expect(read(true, true)).toMatchObject({ visible: true, shown: true })
    expect(read(true, false)).toMatchObject({ visible: false, shown: false })
    expect(read(false, true)).toMatchObject({ visible: true, shown: false })
    expect(read(false, false)).toMatchObject({ visible: false, shown: false })
  })

  it('never joins an entry to an item of the other role', () => {
    const library = librarySnapshot([sourceItem('same', 'Ground')])
    const [entry] = readLidarPresentation(
      { lidar: { visible: true, entries: [{ kind: 'Derived', id: 'same', name: 'Ground', visible: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null }] } },
      library,
    )
    expect(entry).toMatchObject({ availability: 'not-in-library', state: null })
  })

  it('says why an item is missing, and that nothing is missing while the library loads', () => {
    const design = { lidar: { visible: true, entries: [
      { kind: 'Source' as const, id: 'ground', name: 'Ground', visible: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
    ] } }
    const missing = (library: LibrarySnapshot | null, status: Parameters<typeof readLidarPresentation>[2]) =>
      readLidarPresentation(design, library, status)[0]?.availability

    // A cold start is one fact in one field: loading, no state, not missing.
    const [loading] = readLidarPresentation(design, null)
    expect(loading).toMatchObject({ availability: 'loading', state: null })
    expect(loading && isMissing(loading)).toBe(false)
    expect(missing(null, { kind: 'ready' })).toBe('loading')
    expect(missing(emptyLibrary, { kind: 'ready' })).toBe('not-in-library')
    expect(missing(emptyLibrary, { kind: 'recovered', items: 1, generated: 0 })).toBe('not-in-library')
    expect(missing(null, { kind: 'refused_newer' })).toBe('needs-newer-canopi')
    expect(missing(null, { kind: 'unavailable' })).toBe('library-unopened')
    expect(missing(librarySnapshot([sourceItem('ground', 'Ground')]), { kind: 'ready' })).toBe('present')
  })
})
