// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../app/settings/state'
import { createDesktopFileDelivery } from '../editions/desktop/file-delivery'
import { createFakeFileDelivery } from '../editions/gallery/fakes/file-delivery.fake'
import { resetFailureNoticesForTests } from '../failures/report'
import { t } from '../i18n'
import { installCommandTransport } from '../types/command-transport'
import {
  buildDeliveryFileName,
  createBrowserFileDelivery,
  FILE_DELIVERY_ROWS,
  FILE_KINDS,
  type FileDeliveryKind,
} from './file-delivery'

describe('FileDelivery suite (contracts §16, 2.1-M422, 2.1-M522, 2.1-Q359, canopi-f47t.52.47)', () => {
  afterEach(() => {
    resetFailureNoticesForTests()
    locale.value = 'en'
    vi.restoreAllMocks()
  })

  it('2.1-Q359: sanitizes forbidden characters to spaces, collapses spaces, and falls back to localised Untitled', () => {
    expect(buildDeliveryFileName('canopi-copy', 'North:Garden/2026*Plan?')).toBe('North Garden 2026 Plan.canopi')
    expect(buildDeliveryFileName('canopi-copy', '  My   <Oak> | "Orchard"  ')).toBe('My Oak Orchard.canopi')
    expect(buildDeliveryFileName('canopi-copy', ':::/*?', t('titleBar.untitledDesign'))).toBe('Untitled Design.canopi')
    locale.value = 'fr'
    expect(buildDeliveryFileName('canopi-copy', '   ', t('titleBar.untitledDesign'))).not.toBe('.canopi')
  })

  it('covers all 9 FileDelivery rows and suffixes including -budget.csv and library GeoTIFF', () => {
    const rowIds = Object.keys(FILE_DELIVERY_ROWS) as FileDeliveryKind[]
    expect(rowIds).toHaveLength(9)
    expect(buildDeliveryFileName('canopi-copy', 'Orchard: 2026')).toBe('Orchard 2026.canopi')
    expect(buildDeliveryFileName('canopi-draft', 'Draft/1')).toBe('Draft 1.canopi')
    expect(buildDeliveryFileName('stamp', 'Guild*A')).toBe('Guild A.canopi')
    expect(buildDeliveryFileName('geojson', 'Site:North')).toBe('Site North.geojson')
    expect(buildDeliveryFileName('pdf', 'Garden: Plan')).toBe('Garden Plan.pdf')
    expect(buildDeliveryFileName('budget-csv', 'Orchard')).toBe('Orchard-budget.csv')
    expect(buildDeliveryFileName('budget-csv', 'Orchard-budget.csv')).toBe('Orchard-budget.csv')
    expect(buildDeliveryFileName('geotiff', 'Slope/DEM')).toBe('Slope DEM.tif')
    expect(buildDeliveryFileName('analysis-geotiff', 'Aspect')).toBe('Aspect.tif')
    expect(buildDeliveryFileName('problem-report', 'canopi-report-2026.zip')).toBe('canopi-report-2026.zip')
    expect(FILE_KINDS.geotiff.extensions).toEqual(['tif', 'tiff'])
    expect(FILE_KINDS.geotiff.mimeType).toBe('image/tiff')
    expect(FILE_KINDS.zip.extensions).toEqual(['zip'])
    expect(FILE_KINDS.zip.mimeType).toBe('application/zip')
  })

  it('Desktop adapter delivers raw binary body with kind/path headers, handles cancel, abort mid-dialog, and refused wrong extension', async () => {
    const calls: Array<{ command: string; args: unknown }> = []
    let resolvePick: ((value: unknown) => void) | null = null
    const disposeTransport = installCommandTransport(async (command, args) => {
      calls.push({ command, args })
      if (command === 'pick_save') {
        if (resolvePick) {
          return await new Promise((resolve) => { resolvePick = resolve })
        }
        return { kind: 'picked', path: '/chosen/Café Plan.pdf' }
      }
      if (command === 'deliver_file') {
        const payload = args as { bytes: Uint8Array; headers: Record<string, string> }
        if (decodeURIComponent(payload.headers['x-canopi-delivery-path'] ?? '').endsWith('.txt')) {
          throw new Error('Export destination for pdf must have a .pdf extension')
        }
        return decodeURIComponent(payload.headers['x-canopi-delivery-path'] ?? '')
      }
      return null
    })

    try {
      const desktop = createDesktopFileDelivery()
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
      expect(await desktop.deliverFile('pdf', 'Garden: plan', { bytes: pdfBytes })).toBe('saved')
      expect(calls[0]).toEqual({
        command: 'pick_save',
        args: { kind: 'pdf-export', stem: 'Garden plan.pdf' },
      })
      const wire = calls[1]!
      expect(wire.command).toBe('deliver_file')
      const wireArgs = wire.args as { bytes: Uint8Array; headers: Record<string, string> }
      expect(wireArgs.bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(wireArgs.bytes)).toEqual([0x25, 0x50, 0x44, 0x46])
      expect(wireArgs.headers['x-canopi-delivery-kind']).toBe('pdf')
      expect(decodeURIComponent(wireArgs.headers['x-canopi-delivery-path']!)).toBe('/chosen/Café Plan.pdf')

      // Pre-aborted signal returns cancelled without opening a dialog.
      const beforeCount = calls.length
      expect(await desktop.deliverFile('pdf', 'Garden', { bytes: pdfBytes }, AbortSignal.abort())).toBe('cancelled')
      expect(calls).toHaveLength(beforeCount)

      // Abort mid-dialog returns cancelled without calling deliver_file.
      const abort = new AbortController()
      let releaseDialog!: (value: unknown) => void
      resolvePick = (v) => releaseDialog(v)
      const pending = desktop.deliverFile('geojson', 'Site', { text: '{}' }, abort.signal)
      await Promise.resolve()
      abort.abort()
      resolvePick({ kind: 'picked', path: '/chosen/site.geojson' })
      resolvePick = null
      expect(await pending).toBe('cancelled')
    } finally {
      disposeTransport()
    }

    // Dialog cancel returns 'cancelled' (never throws) and wrong extension rejects.
    const disposeCancel = installCommandTransport(async (command) => {
      if (command === 'pick_save') return { kind: 'cancelled' }
      return null
    })
    try {
      const desktop = createDesktopFileDelivery()
      expect(await desktop.deliverFile('budget-csv', 'Orchard', { text: 'a,b' })).toBe('cancelled')
    } finally {
      disposeCancel()
    }

    const disposeWrongExt = installCommandTransport(async (command) => {
      if (command === 'pick_save') return { kind: 'picked', path: '/chosen/wrong.txt' }
      if (command === 'deliver_file') throw new Error('Export destination for pdf must have a .pdf extension')
      return null
    })
    try {
      const desktop = createDesktopFileDelivery()
      await expect(desktop.deliverFile('pdf', 'Garden', { bytes: new Uint8Array([1]) })).rejects.toThrow(/extension/)
    } finally {
      disposeWrongExt()
    }
  })

  it('Web adapter triggers Blob downloads for every content row, respects cancel, and refuses native-only rows', async () => {
    const downloads: Array<{ download: string; type: string }> = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    let lastBlobType = ''
    URL.createObjectURL = vi.fn((blob: Blob) => {
      lastBlobType = blob.type
      return `blob:mock-${downloads.length}`
    })
    URL.revokeObjectURL = vi.fn()
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function clickMock(this: HTMLAnchorElement) {
      downloads.push({ download: this.download, type: lastBlobType })
    }

    try {
      const web = createBrowserFileDelivery({ revokeAfterMs: 0 })
      expect(await web.deliverFile('budget-csv', 'Orchard: 1', { text: 'Species,Qty\nOak,1' })).toBe('downloaded')
      expect(await web.deliverFile('problem-report', 'canopi-report-2026.zip', { bytes: new Uint8Array([80, 75, 5, 6]) })).toBe('downloaded')
      expect(await web.deliverFile('canopi-copy', 'North/Plot', { text: '{}' })).toBe('downloaded')
      expect(await web.deliverFile('pdf', 'Sheet', { bytes: new Uint8Array([1]), }, AbortSignal.abort())).toBe('cancelled')

      expect(downloads).toEqual([
        { download: 'Orchard 1-budget.csv', type: 'text/csv;charset=utf-8' },
        { download: 'canopi-report-2026.zip', type: 'application/zip' },
        { download: 'North Plot.canopi', type: 'application/json' },
      ])

      await expect(web.deliverFile('geotiff', 'Slope', { native: 'item-1' })).rejects.toThrow(/native-only/)
      web.dispose?.()
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      HTMLAnchorElement.prototype.click = origClick
    }
  })

  it('Gallery fake records deliveries and honours AbortSignal cancellation', async () => {
    const fake = createFakeFileDelivery('downloaded')
    expect(await fake.deliverFile('pdf', 'Gallery Plan', { bytes: new Uint8Array([1, 2]) })).toBe('downloaded')
    expect(await fake.deliverFile('geojson', 'Site', { text: '{}' }, AbortSignal.abort())).toBe('cancelled')
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.kind).toBe('pdf')
  })
})
