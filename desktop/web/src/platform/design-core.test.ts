import { describe, expect, it, vi } from 'vitest'
import { createDesignCore } from './design-core'
import type { FormatCoreRequest } from './design-core.worker'
import type { NewDesignInputContract, SavedObjectStampPayload } from '../generated/contracts'

interface FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: Event) => void) | null
  postMessage: ReturnType<typeof vi.fn<(msg: FormatCoreRequest) => void>>
  terminate: ReturnType<typeof vi.fn<() => void>>
  reply: (data: unknown) => void
  fail: () => void
}

function makeFakeWorker(): FakeWorker {
  const fake: FakeWorker = {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    reply(data) {
      fake.onmessage?.({ data } as MessageEvent<unknown>)
    },
    fail() {
      fake.onerror?.({ preventDefault: vi.fn() } as unknown as Event)
    },
  }
  return fake
}

describe('platform/design-core adapter', () => {
  it('routes all DesignCore calls, recycles worker after >4 MiB decode, and handles refusals', async () => {
    const workers: FakeWorker[] = []
    const core = createDesignCore({
      createWorker: () => {
        const w = makeFakeWorker()
        workers.push(w)
        return w
      },
    })

    const v = core.version()
    workers[0]!.reply({ id: 1, ok: true, value: '2.1.0' })
    expect(await v).toBe('2.1.0')

    const encOk = core.encode({ version: 10 })
    workers[0]!.reply({ id: 2, ok: true, value: JSON.stringify({ ok: '{"version":10}' }) })
    const encRes = await encOk
    expect('ok' in encRes).toBe(true)

    const encErr = core.encode({ version: 0 })
    workers[0]!.reply({ id: 3, ok: true, value: JSON.stringify({ err: { kind: 'invalid_document', message: 'bad' } }) })
    expect(await encErr).toEqual({ err: { kind: 'invalid_document', message: 'bad' } })

    const encMalformed = core.encode({})
    workers[0]!.reply({ id: 4, ok: true, value: '{}' })
    expect(await encMalformed).toMatchObject({ err: { kind: 'invalid_document' } })

    const ndInput: NewDesignInputContract = { name: 'Orchard', created_at: '2026-11-26T00:00:00Z' }
    const nd = core.newDesign(ndInput)
    workers[0]!.reply({ id: 5, ok: true, value: JSON.stringify({ version: 10, name: 'Orchard' }) })
    expect(await nd).toMatchObject({ version: 10, name: 'Orchard' })

    const summary = core.draftSummary(new Uint8Array([123, 125]), '2026-11-26T00:00:00Z')
    workers[0]!.reply({ id: 6, ok: true, value: JSON.stringify({ kind: 'current', name: 'A', updated_at: '2026-11-26T00:00:00Z' }) })
    expect(await summary).toMatchObject({ kind: 'current' })

    const stamp: SavedObjectStampPayload = {
      version: 3,
      anchor: { x: 0, y: 0 },
      plants: [],
      zones: [],
      annotations: [],
      measurement_guides: [],
      groups: [],
    }
    const decStamp = core.decodeStamp(JSON.stringify(stamp))
    workers[0]!.reply({ id: 7, ok: true, value: JSON.stringify({ ok: stamp }) })
    expect(await decStamp).toEqual({ ok: stamp })

    const encStamp = core.encodeStamp(stamp)
    workers[0]!.reply({ id: 8, ok: true, value: JSON.stringify({ ok: '{"version":3}' }) })
    expect(await encStamp).toEqual({ ok: '{"version":3}' })

    // Large decode (>4 MiB) triggers idle recycle.
    const bigBytes = new Uint8Array(4 * 1024 * 1024 + 1)
    const decBig = core.decode(bigBytes)
    workers[0]!.reply({ id: 9, ok: true, value: JSON.stringify({ ok: { design: { version: 10 } } }) })
    await decBig
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)

    // Next call spawns a fresh worker.
    const nextVersion = core.version()
    expect(workers).toHaveLength(2)
    workers[1]!.reply({ id: 10, ok: true, value: '2.1.0' })
    expect(await nextVersion).toBe('2.1.0')

    // Invalid UTF-8 bytes are refused as invalid_json before posting to worker (Minor 3).
    const badUtf8 = new Uint8Array([0xff, 0xfe])
    expect(await core.decode(badUtf8)).toMatchObject({ err: { kind: 'invalid_json' } })
    expect(await core.draftSummary(badUtf8, '2026-11-26T00:00:00Z')).toMatchObject({
      readable: false,
      refusal_kind: { kind: 'invalid_json' },
    })
  })

  it('settles unavailable, trapped, start-throw, and onerror cleanly', async () => {
    const failing = createDesignCore({
      createWorker: () => { throw new Error('no worker') },
    })
    await expect(failing.version()).rejects.toMatchObject({ code: { kind: 'format_core_unavailable' } })

    const workers: FakeWorker[] = []
    const core = createDesignCore({
      createWorker: () => {
        const w = makeFakeWorker()
        workers.push(w)
        return w
      },
    })

    const unavail = core.version()
    workers[0]!.reply({ id: 1, ok: false, error: 'unavailable', detail: 'offline' })
    await expect(unavail).rejects.toMatchObject({ code: { kind: 'format_core_unavailable' } })

    const trapped = core.version()
    workers[0]!.reply({ id: 2, ok: false, error: 'trapped', detail: 'trap' })
    await expect(trapped).rejects.toMatchObject({ code: { kind: 'format_core_trapped' } })
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)

    const onErr = core.version()
    workers[1]!.fail()
    await expect(onErr).rejects.toMatchObject({ code: { kind: 'format_core_unavailable' } })
  })
})
