import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Failure } from '../generated/contracts'
import { isCancelledFailure } from '../failures/ipc-failure'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../failures/ring'
import { pickOpen, pickSave } from './dialogs'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

/** The host's refusal of a second dialog in a window, as the wire carries it (2.1-Q284). */
function alreadyOpen(op: string): Failure {
  return { code: { kind: 'dialog_already_open' }, user_may_retry: false, op, operation: null, detail: null }
}

/** A host failure the page must still hear about: a path that is not valid Unicode. */
function internal(op: string): Failure {
  return { code: { kind: 'internal' }, user_may_retry: false, op, operation: null, detail: null }
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

  it('settles a second dialog the host brought forward as a cancel, so no caller shows a notice (canopi-f47t.52.35, 2.1-Q284)', async () => {
    invoke.mockRejectedValueOnce(alreadyOpen('dialog.pick_open'))
    await expect(pickOpen('design-open')).resolves.toEqual({ kind: 'cancelled' })

    invoke.mockRejectedValueOnce(alreadyOpen('dialog.pick_save'))
    await expect(pickSave('design-save', 'Orchard')).resolves.toEqual({ kind: 'cancelled' })
  })

  it('passes any other host failure on as a rejection', async () => {
    const failure = internal('dialog.pick_open')
    invoke.mockRejectedValueOnce(failure)

    await expect(pickOpen('design-open')).rejects.toHaveProperty('failure', failure)
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
      const failure = internal(op)
      invoke.mockRejectedValueOnce(failure)
      await expect(call()).rejects.toHaveProperty('failure', failure)
    }
    expect(invoke).toHaveBeenCalledTimes(callers.length)
  })

  it('settles a second Design open as the dialog cancel the session reads as no notice (canopi-f47t.52.35, 2.1-Q284)', async () => {
    const { openDesignDialog } = await import('./design')
    invoke.mockRejectedValueOnce(alreadyOpen('dialog.pick_open'))

    await expect(openDesignDialog()).rejects.toSatisfy(isCancelledFailure)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('settles a second GeoJSON import the host brought forward as the pick cancel, so import shows no notice (canopi-f47t.52.35, 2.1-Q284)', async () => {
    const { desktopGeoJsonFiles } = await import('./geojson')
    resetFrontendDiagnosticsForTests()
    // pick_geojson_file still rejects with the refusal's kind as a plain string.
    invoke.mockRejectedValueOnce('dialog_already_open')
    await expect(desktopGeoJsonFiles.pickGeoJsonFile()).resolves.toBeNull()
    // canopi-f47t.52.36: the refused second dialog is a normal UI action, so the diagnostics ring stays empty.
    expect(ringEntries()).toEqual([])

    invoke.mockRejectedValueOnce('cannot read beds.geojson')
    await expect(desktopGeoJsonFiles.pickGeoJsonFile()).rejects.toHaveProperty('message', 'cannot read beds.geojson')
  })

  it('keeps the Design open notice in its own words, never [object Object]', async () => {
    const { designOpenFailureNoticeOf } = await import('../app/document-session/open-failure')
    const { t } = await import('../i18n')

    const notice = designOpenFailureNoticeOf(internal('dialog.pick_open'))

    expect(notice).toEqual({ tone: 'error', title: 'start.cantOpenTitle', message: 'start.cantRead' })
    expect(`${t(notice.title)} ${t(notice.message)}`).not.toContain('[object Object]')
  })
})
