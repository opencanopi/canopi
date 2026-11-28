// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const initMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const versionMock = vi.hoisted(() => vi.fn(() => '2.1.0-beta.3'))
const decodeMock = vi.hoisted(() => vi.fn((text: string) => `{"ok":{"design":${text}}}`))
const encodeMock = vi.hoisted(() => vi.fn((text: string) => `{"ok":${JSON.stringify(text)}}`))
const newDesignMock = vi.hoisted(() => vi.fn((input: string) => input))
const draftSummaryMock = vi.hoisted(() => vi.fn((_text: string, updatedAt: string) => JSON.stringify({ name: 'Draft', updated_at: updatedAt, readable: true })))
const decodeStampMock = vi.hoisted(() => vi.fn((text: string) => `{"ok":${text}}`))
const encodeStampMock = vi.hoisted(() => vi.fn((text: string) => `{"ok":${JSON.stringify(text)}}`))

vi.mock('../../../../canopi-format-wasm/glue.js', () => ({
  default: initMock,
  moduleUrl: '/canopi-format.wasm',
  format_core_version: versionMock,
  decode_design: decodeMock,
  encode_design: encodeMock,
  new_design: newDesignMock,
  draft_summary: draftSummaryMock,
  decode_stamp_payload: decodeStampMock,
  encode_stamp_payload: encodeStampMock,
}))

describe('design-core.worker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('compiles wasm, answers v10 Format Core calls, and reports unavailable/trapped errors', async () => {
    const replies: unknown[] = []
    const workerSelf = self as unknown as {
      onmessage: ((e: { data: Record<string, unknown> }) => void) | null
      postMessage: (msg: unknown) => void
    }
    const origPost = workerSelf.postMessage
    workerSelf.postMessage = (msg: unknown) => { replies.push(msg) }

    // First call: HTTP error -> unavailable, clears loading cache.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await import('./design-core.worker')
    workerSelf.onmessage?.({ data: { id: 1, call: 'decode', text: '{}' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(replies[0]).toMatchObject({ id: 1, ok: false, error: 'unavailable' })

    // Second call: arrayBuffer compile path + ok reply.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue({})
    workerSelf.onmessage?.({ data: { id: 2, call: 'version' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(2) })
    expect(replies[1]).toEqual({ id: 2, ok: true, value: '2.1.0-beta.3', compiledBy: 'arrayBuffer' })

    // Format Core v10 calls: version, decode, encode, new_design, draft_summary, decode_stamp, encode_stamp.
    workerSelf.onmessage?.({ data: { id: 3, call: 'version' } })
    workerSelf.onmessage?.({ data: { id: 4, call: 'decode', text: '{"version":10}' } })
    workerSelf.onmessage?.({ data: { id: 5, call: 'encode', designJson: '{"version":10}' } })
    workerSelf.onmessage?.({ data: { id: 6, call: 'new_design', inputJson: '{"name":"A"}' } })
    workerSelf.onmessage?.({ data: { id: 7, call: 'draft_summary', text: '{}', updatedAt: '2026-11-26T00:00:00Z' } })
    workerSelf.onmessage?.({ data: { id: 8, call: 'decode_stamp', text: '{"version":3}' } })
    workerSelf.onmessage?.({ data: { id: 9, call: 'encode_stamp', payloadJson: '{"version":3}' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(9) })
    expect(replies[2]).toMatchObject({ id: 3, ok: true, value: '2.1.0-beta.3' })
    expect(replies[3]).toMatchObject({ id: 4, ok: true, value: '{"ok":{"design":{"version":10}}}' })
    expect(replies[4]).toMatchObject({ id: 5, ok: true, value: '{"ok":"{\\"version\\":10}"}' })
    expect(replies[5]).toMatchObject({ id: 6, ok: true, value: '{"name":"A"}' })
    expect(replies[6]).toMatchObject({ id: 7, ok: true })
    expect(replies[7]).toMatchObject({ id: 8, ok: true, value: '{"ok":{"version":3}}' })
    expect(replies[8]).toMatchObject({ id: 9, ok: true, value: '{"ok":"{\\"version\\":3}"}' })

    // Trap call: decode_design throws -> trapped.
    decodeMock.mockImplementationOnce(() => { throw new Error('wasm trap') })
    workerSelf.onmessage?.({ data: { id: 10, call: 'decode', text: '{}' } })
    await vi.waitFor(() => { expect(replies).toHaveLength(10) })
    expect(replies[9]).toEqual({ id: 10, ok: false, error: 'trapped', detail: 'trapped' })

    workerSelf.postMessage = origPost
  })
})
