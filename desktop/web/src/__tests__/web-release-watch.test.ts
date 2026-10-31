import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserReleaseWatch,
  RELEASE_READ_INTERVAL_MS,
  type BrowserReleaseWatchTarget,
} from '../web/browser-release-watch'

// The Web release watch (2.1-Q83, Q186, Q187, M179; Step 2.0.3 serving chunk 2): the edition manifest read on focus, on
// becoming visible and after a failed lazy import; any release other than the tab's own shows the one Reload notice.
const OWN = '2.0.3'
const MANIFEST_URL = '/canopi-web-edition-manifest.json'

type Answer = { readonly ok: boolean; readonly body: unknown } | Error | 'pending'

function manifest(version: unknown, name: unknown = 'Canopi Web Edition') {
  return { ok: true, body: { name, version, commit: 'abc1234', files: [] } }
}

function harness(answers: Answer[] = []) {
  let clock = 1_000_000
  const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void; signal: AbortSignal }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(MANIFEST_URL)
    expect(init.cache).toBe('no-store')
    const answer = answers.length > 1 ? answers.shift()! : answers[0] ?? manifest(OWN)
    if (answer === 'pending') {
      return await new Promise((resolve, reject) => pending.push({ resolve, reject, signal: init.signal! }))
    }
    if (answer instanceof Error) throw answer
    return {
      ok: answer.ok,
      json: async () => {
        if (typeof answer.body === 'string') return JSON.parse(answer.body)
        return answer.body
      },
    }
  })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
  const target: BrowserReleaseWatchTarget & { document: typeof document; window: EventTarget } = { document, window: new EventTarget() }
  const watch = createBrowserReleaseWatch({
    ownVersion: OWN,
    manifestUrl: MANIFEST_URL,
    fetch: fetch as never,
    now: () => clock,
  })
  const stop = watch.start(target)
  return {
    watch,
    fetch,
    target,
    pending,
    stop,
    answers,
    advance(ms: number) { clock += ms },
    focus() { target.window.dispatchEvent(new Event('focus')) },
    visible() {
      document.visibilityState = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    },
    hidden() {
      document.visibilityState = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    },
    failedImport() {
      const event = new Event('vite:preloadError', { cancelable: true })
      target.window.dispatchEvent(event)
      return event
    },
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Web release watch (2.1-Q83, Q186, Q187, M179)', () => {
  const errors = vi.spyOn(console, 'error')
  const warnings = vi.spyOn(console, 'warn')
  afterEach(() => {
    errors.mockClear()
    warnings.mockClear()
  })

  it('reads nothing until a trigger', async () => {
    const run = harness()
    await settle()
    expect(run.fetch).not.toHaveBeenCalled()
    expect(run.watch.notice.value).toBeNull()
    run.stop()
  })

  it('an offline or missing manifest shows no notice and logs no error', async () => {
    const run = harness([new TypeError('Failed to fetch'), { ok: false, body: 'Not Found' }, { ok: false, body: '' }])
    run.focus()
    await settle()
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    await settle()
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(3)
    expect(run.watch.notice.value).toBeNull()
    expect(errors).not.toHaveBeenCalled()
    expect(warnings).not.toHaveBeenCalled()
    run.stop()
  })

  it('a malformed manifest or the shell HTML is ignored', async () => {
    const bodies: Answer[] = [
      { ok: true, body: '<!doctype html><html></html>' },
      { ok: true, body: 'not json' },
      { ok: true, body: { name: 'Canopi Web Edition' } },
      manifest(203),
      manifest(''),
      manifest('2.0.4', 'Another app'),
      { ok: true, body: ['2.0.4'] },
      { ok: true, body: null },
    ]
    const run = harness([...bodies, manifest(OWN)])
    for (let index = 0; index < bodies.length; index += 1) {
      run.failedImport()
      await settle()
      expect(run.watch.notice.value, `answer ${index}`).toBeNull()
    }
    expect(run.fetch).toHaveBeenCalledTimes(bodies.length)
    expect(errors).not.toHaveBeenCalled()
    run.stop()
  })

  it('the same release shows no notice', async () => {
    const run = harness([manifest(OWN)])
    run.focus()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(1)
    expect(run.watch.notice.value).toBeNull()
    run.stop()
  })

  it('a newer release shows one New version: Reload notice', async () => {
    const run = harness([manifest('2.0.4')])
    run.visible()
    await settle()
    expect(run.watch.notice.value).toEqual({ source: 'manifest', version: '2.0.4' })
    run.stop()
  })

  it('Q186: a rollback to an older release shows the notice', async () => {
    const run = harness([manifest('2.0.2')])
    run.focus()
    await settle()
    expect(run.watch.notice.value).toEqual({ source: 'manifest', version: '2.0.2' })
    run.stop()
  })

  it('focus and visibility bursts read the manifest once', async () => {
    const run = harness(['pending'])
    run.focus()
    run.visible()
    run.focus()
    run.visible()
    run.failedImport()
    run.hidden()
    expect(run.fetch).toHaveBeenCalledTimes(1)
    run.pending[0]!.resolve({ ok: true, json: async () => manifest(OWN).body })
    await settle()
    // Within the minute each of focus and visible stays quiet; a failed import always reads.
    run.advance(RELEASE_READ_INTERVAL_MS - 1)
    run.focus()
    run.visible()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(1)
    run.answers.splice(0, run.answers.length, manifest(OWN))
    run.failedImport()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(2)
    run.advance(1)
    run.focus()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(3)
    run.visible()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(4)
    // Becoming hidden never reads.
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.hidden()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(4)
    // Once a release waits on screen, nothing reads again.
    run.answers.splice(0, run.answers.length, manifest('2.0.4'))
    run.focus()
    await settle()
    expect(run.watch.notice.value?.version).toBe('2.0.4')
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    run.visible()
    run.failedImport()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(5)
    run.stop()
  })

  it('a failed lazy import reads the manifest and shows the notice', async () => {
    const run = harness([manifest('2.0.4')])
    const event = run.failedImport()
    expect(event.defaultPrevented, 'the import error proceeds as before').toBe(false)
    await settle()
    expect(run.watch.notice.value).toEqual({ source: 'manifest', version: '2.0.4' })
    run.stop()

    // The same release or no answer: no notice, and the failed import is left to its caller.
    for (const answer of [manifest(OWN), new TypeError('Failed to fetch')]) {
      const quiet = harness([answer])
      expect(quiet.failedImport().defaultPrevented).toBe(false)
      await settle()
      expect(quiet.watch.notice.value).toBeNull()
      quiet.stop()
    }
    expect(errors).not.toHaveBeenCalled()
  })

  it('Q187: a dismissed notice returns only for another release or a failed import', async () => {
    const run = harness([manifest('2.0.4')])
    run.focus()
    await settle()
    expect(run.watch.notice.value?.version).toBe('2.0.4')
    run.watch.dismiss()
    expect(run.watch.notice.value).toBeNull()

    // Reads continue after a dismissal and compare against the dismissed release.
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(2)
    expect(run.watch.notice.value, 'the dismissed release stays dismissed').toBeNull()

    run.failedImport()
    await settle()
    expect(run.watch.notice.value, 'a failed import shows it again').toEqual({ source: 'manifest', version: '2.0.4' })
    run.watch.dismiss()

    run.answers.splice(0, run.answers.length, manifest('2.0.5'))
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.visible()
    await settle()
    expect(run.watch.notice.value, 'a further release shows it again').toEqual({ source: 'manifest', version: '2.0.5' })
    run.watch.dismiss()

    // Back on the tab's own release, nothing waits; the next release that differs shows again.
    run.answers.splice(0, run.answers.length, manifest(OWN))
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    await settle()
    expect(run.watch.notice.value).toBeNull()
    run.answers.splice(0, run.answers.length, manifest('2.0.5'))
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    await settle()
    expect(run.watch.notice.value?.version).toBe('2.0.5')
    run.stop()
  })

  it('a failed import during a read in flight counts for that read', async () => {
    const run = harness([manifest('2.0.4')])
    run.focus()
    await settle()
    run.watch.dismiss()
    run.answers.splice(0, run.answers.length, 'pending')
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    run.failedImport()
    expect(run.fetch).toHaveBeenCalledTimes(2)
    run.pending[0]!.resolve({ ok: true, json: async () => manifest('2.0.4').body })
    await settle()
    expect(run.watch.notice.value?.version).toBe('2.0.4')
    run.stop()
  })

  it('disposing the watch removes its listeners and ignores a late answer', async () => {
    const run = harness(['pending'])
    run.focus()
    expect(run.pending).toHaveLength(1)
    run.stop()
    expect(run.pending[0]!.signal.aborted, 'the read in flight is aborted').toBe(true)
    run.pending[0]!.resolve({ ok: true, json: async () => manifest('2.0.4').body })
    await settle()
    expect(run.watch.notice.value).toBeNull()
    run.advance(RELEASE_READ_INTERVAL_MS)
    run.focus()
    run.visible()
    run.failedImport()
    await settle()
    expect(run.fetch).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })
})
