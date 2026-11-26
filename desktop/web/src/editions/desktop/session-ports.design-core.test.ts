import { describe, expect, it, vi } from 'vitest'

const designCoreMocks = vi.hoisted(() => ({
  designCoreVersion: vi.fn(async () => '2.1.0'),
  designCoreDecode: vi.fn(async () => ({ err: { kind: 'invalid_document' as const, message: 'bad' } })),
  designCoreEncode: vi.fn(async () => ({ ok: [123, 125] })),
  designCoreNewDesign: vi.fn(async () => ({ version: 10, name: 'New' })),
  designCoreDraftSummary: vi.fn(async () => ({ kind: 'unreadable' as const, updated_at: '2026-11-26T00:00:00Z' })),
  designCoreDecodeStamp: vi.fn(async () => ({ err: 'bad' })),
  designCoreEncodeStamp: vi.fn(async () => ({ ok: '{"version":3}' })),
  designCoreStampToCanopi: vi.fn(async () => ({ ok: [123, 125] })),
  designCoreCanopiToStamp: vi.fn(async () => ({ err: 'bad' })),
}))

const readNewerMock = vi.hoisted(() => vi.fn(async () => ({ saved_by_version: 11, view: {} })))
const listDraftsMock = vi.hoisted(() => vi.fn(async () => [{ id: 'd1', updated_at: '2026-11-26T00:00:00Z' }]))
const deleteDraftMock = vi.hoisted(() => vi.fn(async () => undefined))
const pickOpenMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'cancelled' as const })))
const pickSaveMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'cancelled' as const })))
const homeReadMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'absent' as const })))
const homeWriteMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'written' as const, version: 'v1' })))

vi.mock('../../ipc/design-core', () => designCoreMocks)
vi.mock('../../ipc/design', () => ({
  readNewerDesign: readNewerMock,
  listDesignDrafts: listDraftsMock,
  deleteDesignDraft: deleteDraftMock,
}))
vi.mock('../../ipc/dialogs', () => ({ pickOpen: pickOpenMock, pickSave: pickSaveMock }))
vi.mock('./design-home', () => ({
  desktopHomePort: { read: homeReadMock, write: homeWriteMock },
}))

import {
  createDesktopSessionHomeStore,
  desktopDesignCorePort,
  desktopFileAccessPort,
} from './session-ports'
import type { GeoPoint, NewDesignInputContract, SavedObjectStampPayload } from '../../generated/contracts'
import type { DraftId } from '../../platform/design-home'

describe('desktopDesignCorePort', () => {
  it('delegates every DesignCore method to its Desktop IPC wrapper', async () => {
    const bytes = new Uint8Array([123, 125])
    const origin: GeoPoint = { lon: 1, lat: 2 }
    const stamp: SavedObjectStampPayload = {
      version: 3,
      anchor: { x: 0, y: 0 },
      plants: [],
      zones: [],
      annotations: [],
      measurement_guides: [],
      groups: [],
    }
    const input: NewDesignInputContract = { name: 'New', created_at: '2026-11-26T00:00:00Z' }

    expect(await desktopDesignCorePort.version()).toBe('2.1.0')
    await desktopDesignCorePort.decode(bytes)
    const encoded = await desktopDesignCorePort.encode({ version: 10 })
    expect('ok' in encoded && encoded.ok instanceof Uint8Array).toBe(true)
    await desktopDesignCorePort.newDesign(input)
    await desktopDesignCorePort.draftSummary(bytes, '2026-11-26T00:00:00Z')
    await desktopDesignCorePort.decodeStamp('{"version":3}')
    await desktopDesignCorePort.encodeStamp(stamp)
    const stampCanopi = await desktopDesignCorePort.stampToCanopi?.(stamp, 'Guild', origin)
    expect(stampCanopi && 'ok' in stampCanopi && stampCanopi.ok instanceof Uint8Array).toBe(true)
    await desktopDesignCorePort.canopiToStamp?.(bytes, origin)
    await desktopDesignCorePort.readNewerDesign('{}')

    expect(designCoreMocks.designCoreVersion).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreDecode).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreEncode).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreNewDesign).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreDraftSummary).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreDecodeStamp).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreEncodeStamp).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreStampToCanopi).toHaveBeenCalledTimes(1)
    expect(designCoreMocks.designCoreCanopiToStamp).toHaveBeenCalledTimes(1)
    expect(readNewerMock).toHaveBeenCalledTimes(1)
  })

  it('delegates Desktop session home store and file access ports', async () => {
    const store = createDesktopSessionHomeStore()
    expect(await store.read('draft:d1')).toEqual({ kind: 'absent' })
    expect(await store.write('draft:d1', new Uint8Array(), null)).toEqual({
      kind: 'written',
      version: 'v1',
    })
    expect(await store.listDrafts()).toEqual([{ id: 'd1', updatedAt: '2026-11-26T00:00:00Z', bytes: null }])
    expect(await store.deleteDraft('d1' as DraftId)).toEqual({ ok: true })
    deleteDraftMock.mockRejectedValueOnce(new Error('fail'))
    expect((await store.deleteDraft('d1' as DraftId)).ok).toBe(false)
    store.onVersionChange(() => {})()

    expect(await desktopFileAccessPort.pickOpen('canopi')).toEqual({ kind: 'cancelled' })
    expect(await desktopFileAccessPort.pickHomeTarget('plan.canopi')).toEqual({ kind: 'cancelled' })
  })
})
