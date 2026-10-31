import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pickOpen, pickSave } from './dialogs'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('the host dialog wire (canopi-f47t.52.228.14, 2.1-M81)', () => {
  beforeEach(() => invoke.mockReset())

  it('asks pick_open for the kind alone, with no title or filter, and returns its outcome', async () => {
    invoke.mockResolvedValueOnce({ kind: 'picked', paths: ['/data/a.tif', '/data/b.tiff'] })

    await expect(pickOpen('lidar-geotiff-import')).resolves.toEqual({
      kind: 'picked',
      paths: ['/data/a.tif', '/data/b.tiff'],
    })
    expect(invoke).toHaveBeenCalledWith('pick_open', { kind: 'lidar-geotiff-import' })
  })

  it('asks pick_save for the kind and the stem, and returns a cancel as an outcome', async () => {
    invoke.mockResolvedValueOnce({ kind: 'cancelled' })

    await expect(pickSave('pdf-export', 'Garden')).resolves.toEqual({ kind: 'cancelled' })
    expect(invoke).toHaveBeenCalledWith('pick_save', { kind: 'pdf-export', stem: 'Garden' })
  })

  it('passes the host refusal of a second dialog on as a rejection', async () => {
    invoke.mockRejectedValueOnce('file-dialog-already-open')

    await expect(pickOpen('design-open')).rejects.toBe('file-dialog-already-open')
  })
})
