// @vitest-environment jsdom
// store_read_only is never recorded (2.1-M487): a write a newer-read-only store refused leaves the failure ring, and so
// the problem report, empty however its caller handles the settlement. One real caller per pattern that reports it,
// through the real IPC transport and failure sink with only Tauri's invoke stubbed: the Data library's actions report
// it inline (app/lidar/lidar-failures.ts), and an unawaited stamp workbench write leaves it to the window's
// unhandledrejection hook. canopi-f47t.52.271.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFailureHooks } from '../failures/report'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../failures/ring'
import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'
import { renameLibraryItem } from '../app/data-library/actions'
import { createSavedObjectStampWorkbench } from '../app/saved-object-stamps/workbench'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }))

let dispose: () => void = () => undefined
let disposePorts: () => void = () => undefined

beforeEach(() => {
  invoke.mockReset().mockRejectedValue('store_read_only')
  resetFrontendDiagnosticsForTests()
  disposePorts = installEditionPorts(createTestEditionPorts())
  dispose = installFailureHooks({ storage: 'disk' }, window)
})

afterEach(() => {
  dispose()
  disposePorts()
})

describe('a write refused by a read-only store', () => {
  it('canopi-f47t.52.271: a Data library rename refused on a newer catalogue, told inline, is never recorded', async () => {
    await expect(renameLibraryItem('item-1', 'Renamed')).rejects.toThrow()

    expect(invoke).toHaveBeenCalledWith('lidar_rename_item', {
      itemId: 'item-1',
      name: 'Renamed',
      operation: expect.stringMatching(/^u-/),
    })
    expect(ringEntries()).toEqual([])
  })

  it('canopi-f47t.52.271: a stamp rename refused on a newer user DB, never awaited, is never recorded', async () => {
    const workbench = createSavedObjectStampWorkbench()
    const reason = await workbench.renameStamp('stamp-1', 'Renamed').then(() => null, (error: unknown) => error)
    // An unawaited stamp workbench rejection reaches the window's unhandledrejection hook.
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }))

    expect(reason).not.toBeNull()
    expect(ringEntries()).toEqual([])
    workbench.dispose()
  })
})
