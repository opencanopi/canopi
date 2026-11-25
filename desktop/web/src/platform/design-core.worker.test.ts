// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const initMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const readMock = vi.hoisted(() => vi.fn((text: string) => text))

vi.mock('../../../../canopi-format-wasm/glue.js', () => ({
  default: initMock,
  moduleUrl: '/canopi-format.wasm',
  read_newer_design: readMock,
}))

describe('design-core.worker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('compiles wasm, answers read calls, and reports unavailable/trapped errors', async () => {
    const replies: unknown[] = []
    const workerSelf = self as unknown as {
      onmessage: ((e: { data: { id: number; call: 'read'; text: string } }) => void) | null
      postMessage: (msg: unknown) => void
    }
    const origPost = workerSelf.postMessage
    workerSelf.postMessage = (msg: unknown) => { replies.push(msg) }

    // First call: HTTP error -> unavailable, clears loading cache.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await import('./design-core.worker')
    workerSelf.onmessage?.({ data: { id: 1, call: 'read', text: '{}' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(replies[0]).toMatchObject({ id: 1, ok: false, error: 'unavailable' })

    // Second call: arrayBuffer compile path + ok reply.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({})
    workerSelf.onmessage?.({ data: { id: 2, call: 'read', text: '{"v":11}' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(2) })
    expect(replies[1]).toEqual({ id: 2, ok: true, value: '{"v":11}', compiledBy: 'arrayBuffer' })

    // Third call: read_newer_design throws -> trapped.
    readMock.mockImplementationOnce(() => { throw new Error('wasm trap') })
    workerSelf.onmessage?.({ data: { id: 3, call: 'read', text: '{}' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(3) })
    expect(replies[2]).toEqual({ id: 3, ok: false, error: 'trapped', detail: 'trapped' })

    workerSelf.postMessage = origPost
  })
})
