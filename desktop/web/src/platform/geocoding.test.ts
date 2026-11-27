import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageFetchJson } from './geocoding'

describe('pageFetchJson', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns parsed JSON for a 2xx response and undefined for an empty body', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([{ display_name: 'Lisbon' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response('   ', { status: 200 }))

    await expect(pageFetchJson('https://nominatim.openstreetmap.org/search?q=lisbon', undefined)).resolves.toEqual([
      { display_name: 'Lisbon' },
    ])
    await expect(pageFetchJson('https://nominatim.openstreetmap.org/search?q=empty', undefined)).resolves.toBeUndefined()
  })

  it('throws on non-2xx HTTP responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('rate limited', { status: 429 }))

    await expect(pageFetchJson('https://nominatim.openstreetmap.org/search?q=test', undefined)).rejects.toThrow(
      'Geocoder returned HTTP 429',
    )
  })

  it('aborts with a timeout error when the request exceeds 5 s', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    const pending = pageFetchJson('https://nominatim.openstreetmap.org/search?q=slow', undefined)
    const expectation = expect(pending).rejects.toThrow('Geocoder request timed out after 5000 ms')
    await vi.advanceTimersByTimeAsync(5000)
    await expectation
  })

  it('propagates in-flight caller abort without reporting a timeout and removes the abort listener on settle', async () => {
    const caller = new AbortController()
    const removeSpy = vi.spyOn(caller.signal, 'removeEventListener')
    let observedSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Caller aborted', 'AbortError')), { once: true })
    }))

    const pending = pageFetchJson('https://nominatim.openstreetmap.org/search?q=cancel', caller.signal)
    caller.abort(new Error('cancelled by user'))

    await expect(pending).rejects.toThrow('Caller aborted')
    expect(observedSignal?.aborted).toBe(true)
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('propagates an already-aborted caller signal immediately', async () => {
    const caller = new AbortController()
    caller.abort(new Error('pre-aborted'))
    let observedAborted = false
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_input, init) => {
      observedAborted = Boolean(init?.signal?.aborted)
      return Promise.reject(new DOMException('Pre-aborted', 'AbortError'))
    })

    await expect(pageFetchJson('https://nominatim.openstreetmap.org/search?q=pre', caller.signal)).rejects.toThrow(
      'Pre-aborted',
    )
    expect(observedAborted).toBe(true)
  })
})
