import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Failure } from '../generated/contracts'
import { pickOpen, pickSave } from './dialogs'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

/** The host's refusal of a second dialog in a window, as the wire carries it (2.1-Q284). */
function alreadyOpen(op: string): Failure {
  return { code: { kind: 'dialog_already_open' }, user_may_retry: false, op, operation: null, detail: null }
}

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
    const refusal = alreadyOpen('dialog.pick_open')
    invoke.mockRejectedValueOnce(refusal)

    await expect(pickOpen('design-open')).rejects.toBe(refusal)
  })
})

// The typed rejection reaches each 2.0 caller unchanged, never turned into text, so the surface
// behind it keeps its wording; the 1b transport and sink take it from there (canopi-f47t.52.35).
describe('a typed dialog rejection reaching a 2.0 caller (canopi-f47t.52.35)', () => {
  beforeEach(() => invoke.mockReset())

  it('reaches every Open and Save caller as the same Failure', async () => {
    const { openDesignDialog, selectDesignSavePath } = await import('./design')
    const { exportFile } = await import('./export')
    const { desktopGeoJsonFiles } = await import('./geojson')
    const stamps = await import('./saved-object-stamps')
    const { chooseImportFiles } = await import('../app/lidar/actions')
    const { createPdfDelivery } = await import('../app/canvas-pdf/platform.desktop')
    const callers: [string, () => Promise<unknown>][] = [
      ['dialog.pick_open', () => openDesignDialog()],
      ['dialog.pick_save', () => selectDesignSavePath({ currentPath: null, suggestedName: 'Orchard' })],
      ['dialog.pick_save', () => exportFile('a,b', 'budget', 'budget-csv-export')],
      ['dialog.pick_save', () => desktopGeoJsonFiles.writeGeoJsonFile('{}', 'plan.geojson')],
      ['dialog.pick_save', () => stamps.exportSavedObjectStampCanopiFile({}, 'Hedge')],
      ['dialog.pick_open', () => stamps.importSavedObjectStampCanopiFile()],
      ['dialog.pick_open', () => chooseImportFiles()],
      ['dialog.pick_save', () => createPdfDelivery().save(new Uint8Array(), 'Garden', new AbortController().signal)],
    ]
    for (const [op, call] of callers) {
      const refusal = alreadyOpen(op)
      invoke.mockRejectedValueOnce(refusal)
      await expect(call()).rejects.toBe(refusal)
    }
    expect(invoke).toHaveBeenCalledTimes(callers.length)
  })

  it('keeps the Design open notice in its own words, never [object Object]', async () => {
    const { designOpenFailureNoticeOf } = await import('../app/document-session/open-failure')
    const { t } = await import('../i18n')

    const notice = designOpenFailureNoticeOf(alreadyOpen('dialog.pick_open'))

    expect(notice).toEqual({ tone: 'error', title: t('start.cantOpenTitle'), message: t('start.cantRead') })
    expect(`${notice.title} ${notice.message}`).not.toContain('[object Object]')
  })
})
