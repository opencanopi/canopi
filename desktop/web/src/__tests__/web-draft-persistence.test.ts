import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserDraftPersistence } from '../web/browser-draft-persistence'

type BrowserDraftPersistenceNavigator = NonNullable<ReturnType<NonNullable<NonNullable<Parameters<typeof createBrowserDraftPersistence>[0]>['navigator']>>>

// The Web Draft persistence request (2.1-Q82, Q190, Q191, Q194, M180; Step 2.0.3 persist, design check rows L1-L16).

interface FakeStorage {
  persisted: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  persist: ReturnType<typeof vi.fn<() => Promise<boolean>>>
}

function fakeStorage({ kept = false, answer = Promise.resolve(false) }: { kept?: boolean, answer?: Promise<boolean> } = {}): FakeStorage {
  return {
    persisted: vi.fn(async () => kept),
    persist: vi.fn(() => answer),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function permissionsAnswering(state: PermissionState) {
  return { query: vi.fn(async () => ({ state }) as PermissionStatus) }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function launch(navigator: BrowserDraftPersistenceNavigator, hasDrafts = false) {
  const logError = vi.fn()
  const persistence = createBrowserDraftPersistence({ navigator: () => navigator, logError })
  const dispose = persistence.start({ hasDrafts })
  return { persistence, dispose, logError }
}

afterEach(() => vi.restoreAllMocks())

describe('Web Draft persistence (2.1-Q82)', () => {
  it('L1: a browser that already keeps Drafts shows no reason or warning and is never asked', async () => {
    const storage = fakeStorage({ kept: true })
    const { persistence } = launch({ storage, permissions: permissionsAnswering('granted') })
    expect(persistence.view.value).toEqual({ state: 'checking', notice: null, warn: false })
    await settle()
    expect(persistence.view.value).toEqual({ state: 'kept', notice: null, warn: false })
    persistence.requestOnce()
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('L2: not kept on a first visit shows the reason line and no warning before the ask', async () => {
    const { persistence } = launch({ storage: fakeStorage(), permissions: permissionsAnswering('prompt') })
    await settle()
    expect(persistence.view.value).toEqual({ state: 'not-kept', notice: 'reason', warn: false })
  })

  it('L3: the first request of a launch calls persist() once, synchronously, and a second request does not', async () => {
    const storage = fakeStorage({ answer: new Promise(() => undefined) })
    const { persistence } = launch({ storage })
    await settle()
    persistence.requestOnce()
    expect(storage.persist).toHaveBeenCalledOnce()
    persistence.requestOnce()
    await settle()
    persistence.requestOnce()
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  it('L3: a request before the launch read settles asks nothing and leaves the ask for the next one', async () => {
    const read = deferred<boolean>()
    const storage = fakeStorage()
    storage.persisted.mockReturnValue(read.promise)
    const { persistence } = launch({ storage })
    persistence.requestOnce()
    expect(storage.persist).not.toHaveBeenCalled()
    read.resolve(false)
    await settle()
    persistence.requestOnce()
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  it('L4: a granted request clears the reason and any warning', async () => {
    const { persistence } = launch({ storage: fakeStorage({ answer: Promise.resolve(true) }) }, true)
    await settle()
    expect(persistence.view.value.warn).toBe(true)
    persistence.requestOnce()
    await settle()
    expect(persistence.view.value).toEqual({ state: 'kept', notice: null, warn: false })
  })

  it('L5 and L12: a refused request (private windows refuse too) warns on the welcome screen and in the save status', async () => {
    const { persistence } = launch({ storage: fakeStorage({ answer: Promise.resolve(false) }) })
    await settle()
    persistence.requestOnce()
    expect(persistence.view.value).toEqual({ state: 'asking', notice: 'reason', warn: false })
    await settle()
    expect(persistence.view.value).toEqual({ state: 'refused', notice: 'warning', warn: true })
  })

  it('L6: a rejected request counts as refused and logs only the error name', async () => {
    const error = Object.assign(new Error('secret detail /home/user'), { name: 'NotAllowedError' })
    const storage = fakeStorage()
    storage.persist.mockImplementation(() => Promise.reject(error))
    const { persistence, logError } = launch({ storage })
    await settle()
    persistence.requestOnce()
    await settle()
    expect(persistence.view.value).toEqual({ state: 'refused', notice: 'warning', warn: true })
    expect(logError).toHaveBeenCalledOnce()
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret detail')
    expect(JSON.stringify(logError.mock.calls)).toContain('NotAllowedError')
  })

  it('L7: a request that never settles (an unanswered prompt) stays asking with no warning flash', async () => {
    const { persistence } = launch({ storage: fakeStorage({ answer: new Promise(() => undefined) }) })
    await settle()
    persistence.requestOnce()
    await settle()
    expect(persistence.view.value).toEqual({ state: 'asking', notice: 'reason', warn: false })
  })

  it('L7 and L13: with unkept Drafts at launch the warning stays up, with the reason line, while the prompt is unanswered', async () => {
    const { persistence } = launch({ storage: fakeStorage({ answer: new Promise(() => undefined) }) }, true)
    await settle()
    persistence.requestOnce()
    await settle()
    expect(persistence.view.value).toEqual({ state: 'asking', notice: 'reason', warn: true })
  })

  it('L8: persisted() that throws or rejects makes storage unavailable: warn, never ask', async () => {
    const throwing = fakeStorage()
    throwing.persisted.mockImplementation(() => { throw new DOMException('opaque', 'SecurityError') })
    const first = launch({ storage: throwing })
    await settle()
    expect(first.persistence.view.value).toEqual({ state: 'unavailable', notice: 'warning', warn: true })
    first.persistence.requestOnce()
    expect(throwing.persist).not.toHaveBeenCalled()

    const rejecting = fakeStorage()
    rejecting.persisted.mockRejectedValue(new DOMException('sandboxed', 'SecurityError'))
    const second = launch({ storage: rejecting })
    await settle()
    expect(second.persistence.view.value).toEqual({ state: 'unavailable', notice: 'warning', warn: true })
    second.persistence.requestOnce()
    expect(rejecting.persist).not.toHaveBeenCalled()
  })

  it('L9: no navigator.storage, or one without persist (insecure context, old WebKit), is unavailable', async () => {
    const none = launch({})
    expect(none.persistence.view.value).toEqual({ state: 'unavailable', notice: 'warning', warn: true })
    const partial = launch({ storage: { persisted: async () => false } as unknown as FakeStorage })
    await settle()
    expect(partial.persistence.view.value).toEqual({ state: 'unavailable', notice: 'warning', warn: true })
    partial.persistence.requestOnce()
  })

  it('L10: a missing or throwing permissions.query (WebKit) falls back to persisted() and persist()', async () => {
    const missing = launch({ storage: fakeStorage(), permissions: {} as Permissions })
    const throwing = launch({
      storage: fakeStorage(),
      permissions: { query: vi.fn(() => { throw new TypeError('persistent-storage') }) },
    })
    const rejecting = launch({
      storage: fakeStorage(),
      permissions: { query: vi.fn(async () => { throw new TypeError('persistent-storage') }) },
    })
    await settle()
    for (const { persistence } of [missing, throwing, rejecting]) {
      expect(persistence.view.value).toEqual({ state: 'not-kept', notice: 'reason', warn: false })
    }
  })

  it('L11: a denied permission is a refusal without calling persist()', async () => {
    const storage = fakeStorage()
    const { persistence } = launch({ storage, permissions: permissionsAnswering('denied') })
    await settle()
    expect(persistence.view.value).toEqual({ state: 'refused', notice: 'warning', warn: true })
    persistence.requestOnce()
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('L13 (review F1): unkept Drafts at launch warn at once and show the reason line before the next New or Open asks', async () => {
    const storage = fakeStorage({ answer: Promise.resolve(false) })
    const { persistence } = launch({ storage }, true)
    await settle()
    expect(persistence.view.value).toEqual({ state: 'not-kept', notice: 'reason', warn: true })
    persistence.requestOnce()
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  it('L14: a launch read or a request settling after dispose is dropped', async () => {
    const read = deferred<boolean>()
    const storage = fakeStorage()
    storage.persisted.mockReturnValue(read.promise)
    const first = launch({ storage })
    first.dispose()
    read.resolve(true)
    await settle()
    expect(first.persistence.view.value.state).toBe('checking')

    const answer = deferred<boolean>()
    const second = launch({ storage: fakeStorage({ answer: answer.promise }) })
    await settle()
    second.persistence.requestOnce()
    second.dispose()
    answer.resolve(true)
    await settle()
    expect(second.persistence.view.value.state).toBe('checking')
  })

  it('L15 and L16: the state is per origin and re-read at each launch, never stored', async () => {
    const storage = fakeStorage({ answer: new Promise(() => undefined) })
    const persistence = createBrowserDraftPersistence({ navigator: () => ({ storage }), logError: vi.fn() })
    const dispose = persistence.start({ hasDrafts: false })
    await settle()
    persistence.requestOnce()
    dispose()
    // Another tab granted meanwhile: this tab's next launch reads it.
    storage.persisted.mockResolvedValue(true)
    persistence.start({ hasDrafts: true })
    await settle()
    expect(persistence.view.value).toEqual({ state: 'kept', notice: null, warn: false })
    expect(storage.persisted).toHaveBeenCalledTimes(2)
  })

  it('L14: start disposes the previous launch (hot reload) before reading again', async () => {
    const read = deferred<boolean>()
    const storage = fakeStorage()
    storage.persisted.mockReturnValueOnce(read.promise).mockResolvedValue(false)
    const persistence = createBrowserDraftPersistence({ navigator: () => ({ storage }), logError: vi.fn() })
    persistence.start({ hasDrafts: false })
    persistence.start({ hasDrafts: false })
    read.resolve(true)
    await settle()
    expect(persistence.view.value.state).toBe('not-kept')
  })
})
