import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTINUOUS_SAVE_DELAY_MS,
  createContinuousSave,
  type ContinuousSave,
  type DesignHome,
  type HomeWriteOutcome,
} from '../app/document-session/continuous-save'
import {
  createDesignSessionStoreTestFixture,
  createDesignSessionStore,
  type DesignSessionStoreTestFixture,
  type PersistenceCapableDesignSessionStore,
} from '../app/document-session/store'
import { editDesignSessionForTest } from './support/design-session-edit'
import type { CanopiFile } from '../types/design'

let store: PersistenceCapableDesignSessionStore
let fixture: DesignSessionStoreTestFixture
let writes: DesignHome[]
let writeHome: ReturnType<typeof vi.fn<(home: DesignHome) => Promise<HomeWriteOutcome>>>
let save: ContinuousSave
let uninstall: () => void

function makeFile(name = 'Garden'): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    extra: {},
  }
}

function openSession({
  path = null,
  draftId = 'draft-1',
  fingerprint = null,
  writePending = false,
}: {
  path?: string | null
  draftId?: string | null
  fingerprint?: string | null
  writePending?: boolean
} = {}): void {
  store.resetDirtyBaselines()
  store.replaceCurrentDesignState(makeFile(), path, 'Garden')
  save.beginSession({ draftId, fingerprint, writePending })
}

/** A Design saved to a file reports Saving… and Saved; a Draft reports Draft. */
const FILE_HOME = { path: '/designs/garden.canopi', draftId: null }

function edit(description: string): void {
  editDesignSessionForTest(store, (design) => ({ ...design, description }))
}

function acknowledgingWrite(): Promise<HomeWriteOutcome> {
  fixture.markSaved()
  return Promise.resolve({ kind: 'written' })
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  store = createDesignSessionStore()
  fixture = createDesignSessionStoreTestFixture(store)
  writes = []
  writeHome = vi.fn((home: DesignHome) => {
    writes.push(home)
    return acknowledgingWrite()
  })
  save = createContinuousSave({ store, writeHome, logError: () => {} })
  uninstall = save.install()
})

afterEach(() => {
  uninstall()
  save.dispose()
  vi.useRealTimers()
})

describe('continuous save', () => {
  it('reports a Draft while it lives in a Design Draft, whether writing or written', async () => {
    openSession()
    expect(save.status.value).toBe('draft')
    edit('a')
    expect(save.status.value).toBe('draft')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)
    expect(writes).toEqual([{ kind: 'draft', id: 'draft-1' }])
    expect(save.status.value).toBe('draft')
  })

  it('keeps the writer\'s reason for a failure until a write succeeds', async () => {
    openSession()
    writeHome.mockRejectedValueOnce(new Error('No space left on device'))
    edit('a')
    await expect(save.flush()).resolves.toBe(false)
    expect(save.status.value).toBe('error')
    expect(save.failureReason.value).toBe('No space left on device')

    await expect(save.flush()).resolves.toBe(true)
    expect(save.status.value).toBe('draft')
    expect(save.failureReason.value).toBeNull()
  })

  it('writes to the home once, 1500 ms after the last committed change', async () => {
    openSession(FILE_HOME)
    edit('a')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS - 100)
    edit('b')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS - 100)
    expect(writeHome).not.toHaveBeenCalled()
    expect(save.status.value).toBe('saving')

    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual([{ kind: 'file', path: '/designs/garden.canopi', fingerprint: null }])
    expect(store.designDirty.value).toBe(false)
    expect(save.status.value).toBe('saved')
  })

  it('restarts the delay on every Scene history report while the Design stays dirty', async () => {
    openSession()
    store.setCanvasClean(false)
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS - 1)
    store.setCanvasClean(false)
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS - 1)
    expect(writeHome).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(writeHome).toHaveBeenCalledTimes(1)
  })

  it('writes a file home with its current fingerprint', async () => {
    openSession({ path: '/designs/garden.canopi', draftId: null, fingerprint: 'fp-1' })
    expect(save.readHome()).toEqual({
      kind: 'file',
      path: '/designs/garden.canopi',
      fingerprint: 'fp-1',
    })
    const token = save.sessionToken()
    save.recordFileFingerprint(token, '/designs/garden.canopi', 'fp-2')
    edit('a')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)
    expect(writes).toEqual([{ kind: 'file', path: '/designs/garden.canopi', fingerprint: 'fp-2' }])
  })

  it('keeps one write in flight and writes again for a change made during it', async () => {
    openSession(FILE_HOME)
    let finishFirst!: () => void
    writeHome.mockImplementationOnce((home) => {
      writes.push(home)
      fixture.markSaved()
      return new Promise((resolve) => {
        finishFirst = () => resolve({ kind: 'written' })
      })
    })
    edit('a')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)
    expect(writeHome).toHaveBeenCalledTimes(1)

    edit('b')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)
    expect(writeHome).toHaveBeenCalledTimes(1)

    finishFirst()
    await settle()
    expect(writeHome).toHaveBeenCalledTimes(2)
    await settle()
    expect(save.status.value).toBe('saved')
  })

  it('flushes immediately and reports whether the home holds every change', async () => {
    openSession()
    await expect(save.flush()).resolves.toBe(true)
    expect(writeHome).not.toHaveBeenCalled()

    edit('a')
    await expect(save.flush()).resolves.toBe(true)
    expect(writeHome).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS * 2)
    expect(writeHome).toHaveBeenCalledTimes(1)
  })

  it('writes a pending home without an edit', async () => {
    openSession({ ...FILE_HOME, writePending: true })
    expect(save.status.value).toBe('saving')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)
    expect(writeHome).toHaveBeenCalledTimes(1)
    expect(save.status.value).toBe('saved')
    await expect(save.flush()).resolves.toBe(true)
    expect(writeHome).toHaveBeenCalledTimes(1)
  })

  it('reports a failed write, keeps the change pending and recovers on retry', async () => {
    openSession(FILE_HOME)
    writeHome.mockRejectedValueOnce(new Error('disk full'))
    edit('a')
    await expect(save.flush()).resolves.toBe(false)
    expect(save.status.value).toBe('error')
    expect(store.designDirty.value).toBe(true)

    await expect(save.flush()).resolves.toBe(true)
    expect(save.status.value).toBe('saved')
  })

  it('pauses on a conflict until the user keeps their version', async () => {
    openSession({ path: '/designs/garden.canopi', draftId: null, fingerprint: 'fp-1' })
    writeHome.mockResolvedValueOnce({ kind: 'conflict', fileGone: false })
    edit('a')
    await expect(save.flush()).resolves.toBe(false)
    expect(save.status.value).toBe('conflict')
    expect(save.conflict.value).toEqual({ fileGone: false })

    edit('b')
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS * 2)
    await expect(save.flush()).resolves.toBe(false)
    expect(writeHome).toHaveBeenCalledTimes(1)

    await expect(save.overwriteHome({})).resolves.toBe(false)
    expect(writeHome).toHaveBeenCalledTimes(1)
    await expect(save.overwriteHome(save.sessionToken())).resolves.toBe(true)
    expect(writes.at(-1)).toEqual({
      kind: 'file',
      path: '/designs/garden.canopi',
      fingerprint: null,
    })
    expect(save.conflict.value).toBeNull()
    expect(save.status.value).toBe('saved')
  })

  it('does not keep a Save refused by a conflict for a later write', async () => {
    openSession({ path: '/designs/garden.canopi', draftId: null, fingerprint: 'fp-1' })
    writeHome.mockResolvedValueOnce({ kind: 'conflict', fileGone: false })
    edit('a')
    await expect(save.flush()).resolves.toBe(false)
    await expect(save.save()).resolves.toBe(false)

    // Save As resolves the conflict: the copy holds every change and the session moves to it.
    const token = save.sessionToken()
    fixture.markSaved()
    save.rehome(token, { draftId: 'draft-copy' })
    fixture.setState({ path: null })
    await expect(save.flush()).resolves.toBe(true)
    expect(writeHome).toHaveBeenCalledTimes(1)
  })

  it('drops the previous session schedule, failure and conflict on replacement', async () => {
    openSession({ path: '/designs/a.canopi', draftId: null, fingerprint: 'fp' })
    writeHome.mockResolvedValueOnce({ kind: 'conflict', fileGone: true })
    edit('a')
    await save.flush()
    expect(save.status.value).toBe('conflict')

    openSession({ draftId: 'draft-2' })
    expect(save.conflict.value).toBeNull()
    expect(save.status.value).toBe('draft')
    expect(save.readHome()).toEqual({ kind: 'draft', id: 'draft-2' })
  })

  it('ignores the outcome of a write that belonged to a replaced session', async () => {
    openSession(FILE_HOME)
    let rejectFirst!: (error: Error) => void
    writeHome.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirst = reject
    }))
    edit('a')
    const flushed = save.flush()
    openSession({ path: '/designs/other.canopi', draftId: null })
    rejectFirst(new Error('late failure'))
    await expect(flushed).resolves.toBe(false)
    expect(save.status.value).toBe('saved')
  })

  it("does not show a replaced session's write in flight as saving the new Design", async () => {
    openSession(FILE_HOME)
    let resolveFirst!: (outcome: HomeWriteOutcome) => void
    writeHome.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve
    }))
    edit('a')
    const flushed = save.flush()
    expect(save.status.value).toBe('saving')

    openSession({ path: '/designs/other.canopi', draftId: null })

    expect(save.status.value).toBe('saved')
    resolveFirst({ kind: 'written' })
    await flushed
    expect(save.status.value).toBe('saved')
  })

  it('ignores a fingerprint recorded for a replaced session', () => {
    openSession({ path: '/designs/a.canopi', draftId: null, fingerprint: 'fp-1' })
    const token = save.sessionToken()
    openSession({ path: '/designs/a.canopi', draftId: null, fingerprint: 'fp-2' })
    save.recordFileFingerprint(token, '/designs/a.canopi', 'stale')
    expect(save.readHome()).toMatchObject({ fingerprint: 'fp-2' })
  })

  it('rehomes a draft to a file and forgets the draft', () => {
    openSession({ draftId: 'draft-1' })
    const token = save.sessionToken()
    save.recordFileFingerprint(token, '/designs/new.canopi', 'fp-new')
    fixture.setState({ path: '/designs/new.canopi' })
    save.rehome(token, { draftId: null })
    expect(save.readHome()).toEqual({
      kind: 'file',
      path: '/designs/new.canopi',
      fingerprint: 'fp-new',
    })
  })

  it('offers revert once the session has changed and keeps the opened snapshot', () => {
    openSession()
    expect(save.revertAvailable.value).toBe(false)
    expect(save.readSnapshot()?.description).toBeNull()
    edit('a')
    expect(save.revertAvailable.value).toBe(true)
    expect(save.readSnapshot()?.description).toBeNull()
  })

  it('treats changes to a Design without a home as unsaved', async () => {
    store.replaceCurrentDesignState(makeFile(), null, 'Garden')
    expect(save.status.value).toBe('saved')
    edit('a')
    expect(save.status.value).toBe('error')
    await expect(save.flush()).resolves.toBe(false)
    expect(writeHome).not.toHaveBeenCalled()
  })

  it('reports saved and never writes when no Design is open', async () => {
    expect(save.status.value).toBe('saved')
    await expect(save.flush()).resolves.toBe(true)
    expect(writeHome).not.toHaveBeenCalled()
  })

  it('waits for the write in flight before reporting idle', async () => {
    openSession()
    let finish!: () => void
    writeHome.mockImplementationOnce(() => {
      fixture.markSaved()
      return new Promise((resolve) => {
        finish = () => resolve({ kind: 'written' })
      })
    })
    edit('a')
    void save.flush()
    let idle = false
    void save.idle().then(() => {
      idle = true
    })
    await settle()
    expect(idle).toBe(false)
    finish()
    await settle()
    expect(idle).toBe(true)
  })
})

// WEB-03 (2.1-Q22): what the Web leave prompt reads. A synchronous writer settles inside flushNow; an asynchronous one
// (the IndexedDB Draft store to come) keeps the guard armed until its write settles.
describe('the leave guard', () => {
  function synchronousSave(fail: () => boolean): ContinuousSave {
    uninstall()
    save.dispose()
    save = createContinuousSave({
      store,
      writeHome: (home) => {
        writes.push(home)
        if (fail()) throw new Error('quota exceeded')
        fixture.markSaved()
        return { kind: 'written' }
      },
      logError: () => {},
    })
    uninstall = save.install()
    return save
  }

  it('WEB-03: flushNow writes a pending edit in the calling task and leaves nothing armed', () => {
    const sync = synchronousSave(() => false)
    openSession()
    edit('a')
    expect(sync.flushNow()).toBe(true)
    expect(writes).toEqual([{ kind: 'draft', id: 'draft-1' }])
    expect(sync.leaveGuardArmed.value).toBe(false)
  })

  it('WEB-03: a failed write arms the guard until a later write succeeds', () => {
    let failing = true
    const sync = synchronousSave(() => failing)
    openSession()
    edit('a')
    expect(sync.flushNow()).toBe(false)
    expect(sync.leaveGuardArmed.value).toBe(true)

    failing = false
    expect(sync.flushNow()).toBe(true)
    expect(sync.leaveGuardArmed.value).toBe(false)
  })

  it('WEB-03: an asynchronous write in flight arms the guard, and it disarms when the write settles', async () => {
    openSession()
    let finish!: () => void
    writeHome.mockImplementationOnce(() => {
      fixture.markSaved()
      return new Promise((resolve) => { finish = () => resolve({ kind: 'written' }) })
    })
    edit('a')
    expect(save.flushNow()).toBe(false)
    expect(save.leaveGuardArmed.value).toBe(true)
    // A second close while it is in flight starts no second write.
    expect(save.flushNow()).toBe(false)
    expect(writeHome).toHaveBeenCalledTimes(1)

    finish()
    await settle()
    expect(save.leaveGuardArmed.value).toBe(false)
    expect(save.flushNow()).toBe(true)
  })

  it('WEB-03: no Design and a closed session never arm it', () => {
    const sync = synchronousSave(() => true)
    expect(sync.flushNow()).toBe(true)
    openSession()
    edit('a')
    expect(sync.flushNow()).toBe(false)
    sync.endSession()
    expect(sync.leaveGuardArmed.value).toBe(false)
  })
})
