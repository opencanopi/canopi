import { describe, expect, it, vi } from 'vitest'

const invokeTypedMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => []))
const pickOpenMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'picked' as const, paths: ['/tmp/a.canopi'] })))
const pickSaveMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'picked' as const, path: '/tmp/b.canopi' })))

vi.mock('./transport', () => ({
  invokeTyped: invokeTypedMock,
  mintOperationId: () => 'u:test-op',
}))
vi.mock('./dialogs', () => ({
  pickOpen: pickOpenMock,
  pickSave: pickSaveMock,
  pickCancelled: (op: string) => new Error(`cancelled:${op}`),
}))

import {
  createSavedObjectStamp,
  deleteSavedObjectStamp,
  exportSavedObjectStampCanopiFile,
  getSavedObjectStamps,
  importSavedObjectStampCanopiFile,
  renameSavedObjectStamp,
  reorderSavedObjectStamps,
} from './saved-object-stamps'

describe('ipc/saved-object-stamps', () => {
  it('routes all 7 saved-object-stamp IPC wrappers', async () => {
    await getSavedObjectStamps()
    await createSavedObjectStamp('Guild', '{"version":3}')
    await renameSavedObjectStamp('id-1', 'Renamed')
    await deleteSavedObjectStamp('id-1')
    await reorderSavedObjectStamps(['id-1'])
    await exportSavedObjectStampCanopiFile({ version: 10 }, 'Guild.canopi')
    await importSavedObjectStampCanopiFile()

    expect(invokeTypedMock.mock.calls.map(([cmd]) => cmd)).toEqual([
      'get_saved_object_stamps',
      'create_saved_object_stamp',
      'rename_saved_object_stamp',
      'delete_saved_object_stamp',
      'reorder_saved_object_stamps',
      'export_saved_object_stamp_canopi_file',
      'load_saved_object_stamp_canopi_file',
    ])
  })
})
