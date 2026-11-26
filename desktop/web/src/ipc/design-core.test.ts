import { describe, expect, it, vi } from 'vitest'

const invokeTypedMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => ({ ok: [] })))

vi.mock('./transport', () => ({
  invokeTyped: invokeTypedMock,
  mintOperationId: () => 'u:test-op',
}))

import {
  designCoreCanopiToStamp,
  designCoreDecode,
  designCoreDecodeStamp,
  designCoreDraftSummary,
  designCoreEncode,
  designCoreEncodeStamp,
  designCoreNewDesign,
  designCoreStampToCanopi,
  designCoreVersion,
} from './design-core'
import type { NewDesignInputContract, SavedObjectStampPayload } from '../generated/contracts'
import type { GeoPoint } from '../types/design'

describe('ipc/design-core', () => {
  it('routes all 9 DesignCore IPC commands with typed arguments', async () => {
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
    const newInput: NewDesignInputContract = {
      name: 'Garden',
      created_at: '2026-11-26T00:00:00Z',
    }

    await designCoreVersion()
    await designCoreDecode(bytes)
    await designCoreEncode({ version: 10 })
    await designCoreNewDesign(newInput)
    await designCoreDraftSummary(bytes, '2026-11-26T00:00:00Z')
    await designCoreDecodeStamp('{"version":3}')
    await designCoreEncodeStamp(stamp)
    await designCoreStampToCanopi(stamp, 'Guild', origin)
    await designCoreCanopiToStamp(bytes, origin)

    expect(invokeTypedMock.mock.calls.map(([cmd]) => cmd)).toEqual([
      'design_core_version',
      'design_core_decode',
      'design_core_encode',
      'design_core_new_design',
      'design_core_draft_summary',
      'design_core_decode_stamp',
      'design_core_encode_stamp',
      'design_core_stamp_to_canopi',
      'design_core_canopi_to_stamp',
    ])
  })
})
