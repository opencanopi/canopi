import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LidarImportRefusal, LidarImportRefusalReason } from '../generated/contracts'
import { lidarFailureMessage } from '../app/lidar/lidar-failures'
import { lidarListLibrary } from '../ipc/lidar'

// Only Tauri's invoke is stubbed: a rejected command goes through the real transport, sink and ring.
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }))
import { recentFrontendDiagnostics } from '../app/problem-report/diagnostics'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../failures/ring'
import { locale } from '../app/settings/state'
import { SUPPORTED_LOCALES, t } from '../i18n'

const REPROJECT = 'Reproject it to Lambert-93 (EPSG:2154), a UTM zone or WGS 84, then import it again.'
const DETAIL = 'engine detail: /home/someone/tiles/x.tif: strip 3 is truncated'

/** One refusal of every kind, so a kind added to the contract fails here until it is worded. */
const EVERY_KIND: { [K in LidarImportRefusalReason['kind']]: Extract<LidarImportRefusalReason, { kind: K }> } = {
  TooManyFiles: { kind: 'TooManyFiles', limit: 24 },
  SourceTooLarge: { kind: 'SourceTooLarge', file: 'big.tif', limit_mib: 2048 },
  ImportTooLarge: { kind: 'ImportTooLarge', limit_mib: 2048 },
  SourceMissing: { kind: 'SourceMissing', file: 'gone.tif' },
  Unreadable: { kind: 'Unreadable', file: 'locked.tif' },
  NotGeotiff: { kind: 'NotGeotiff', file: 'dem.asc' },
  NoCrs: { kind: 'NoCrs', file: 'bare.tif' },
  UnsupportedCrs: { kind: 'UnsupportedCrs', file: 'nyc.tif', crs: 'EPSG:2263' },
  JobRunning: { kind: 'JobRunning' },
  LibraryUnavailable: { kind: 'LibraryUnavailable' },
  Internal: { kind: 'Internal' },
}

const refusal = (reason: LidarImportRefusalReason): LidarImportRefusal => ({ reason, detail: DETAIL })

afterEach(() => {
  locale.value = 'en'
  resetFrontendDiagnosticsForTests()
})

describe('lidarFailureMessage', () => {
  it('words every refusal kind in every locale, naming its file and never the detail', () => {
    for (const code of SUPPORTED_LOCALES) {
      locale.value = code
      for (const reason of Object.values(EVERY_KIND)) {
        const message = lidarFailureMessage(refusal(reason))
        expect(message, `${code} ${reason.kind}`).not.toMatch(/canvas\.lidar|\{\{|engine detail|strip 3/)
        if ('file' in reason) expect(message, `${code} ${reason.kind}`).toContain(reason.file)
      }
    }
  })

  it('names the coordinate system the file uses, and words one it spells out without a code', () => {
    expect(lidarFailureMessage(refusal(EVERY_KIND.UnsupportedCrs))).toBe(`nyc.tif uses EPSG:2263, a coordinate system Canopi can’t place. ${REPROJECT}`)
    expect(lidarFailureMessage(refusal({ kind: 'UnsupportedCrs', file: 'custom.tif', crs: '' })))
      .toBe(`custom.tif uses a coordinate system Canopi can’t place. ${REPROJECT}`)
  })

  it('names systems Canopi places, in every locale, so an unsupported system has a way forward (U31)', () => {
    for (const code of SUPPORTED_LOCALES) {
      locale.value = code
      for (const crs of ['EPSG:2263', '']) {
        const message = lidarFailureMessage(refusal({ kind: 'UnsupportedCrs', file: 'nyc.tif', crs }))
        expect(message, `${code} ${crs || 'unnamed'}`).toContain('EPSG:2154')
        expect(message, `${code} ${crs || 'unnamed'}`).toMatch(/UTM/)
      }
    }
  })

  it('writes limits with the interface language’s numbers and units', () => {
    expect(lidarFailureMessage(refusal(EVERY_KIND.SourceTooLarge))).toBe('big.tif is too large: one file can be at most 2 GB.')
    locale.value = 'fr'
    expect(lidarFailureMessage(refusal({ kind: 'TooManyFiles', limit: 1200 })))
      .toBe('Un import peut contenir au plus 1 200 fichiers. Choisissez moins de fichiers.')
    expect(lidarFailureMessage(refusal({ kind: 'ImportTooLarge', limit_mib: 512 }))).toMatch(/512\sMo/)
  })

  it('words an Internal refusal, a plain error, text or an unknown kind as the generic message', () => {
    const generic = lidarFailureMessage(refusal(EVERY_KIND.Internal))
    expect(generic).toBe('Canopi couldn’t finish this. Try again, and report a problem if it keeps failing.')
    expect(lidarFailureMessage(new Error('engine stopped'))).toBe(generic)
    expect(lidarFailureMessage('sqlite: database is locked')).toBe(generic)
    expect(lidarFailureMessage({ reason: { kind: 'Unheard' }, detail: 'later reason' })).toBe(generic)
    expect(lidarFailureMessage(null)).toBe(generic)
  })

  it('keeps each failure’s detail for diagnostics only, without the folder it names', () => {
    lidarFailureMessage(refusal(EVERY_KIND.NotGeotiff))
    lidarFailureMessage(new Error('engine stopped'))
    const kept = recentFrontendDiagnostics().map((entry) => entry.message)
    expect(kept).toHaveLength(2)
    expect(kept[0]).toContain('NotGeotiff')
    expect(kept[0]).toContain('strip 3 is truncated')
    expect(kept[0]).not.toContain('/home/someone')
    expect(kept[1]).toBe('engine stopped')
  })

  it('keeps one ring entry for a failed library command the transport recorded, marked surfaced (canopi-f47t.52.36)', async () => {
    const failure = { code: { kind: 'internal' }, op: 'lidar.list', operation: null, detail: null, user_may_retry: true }
    invoke.mockRejectedValueOnce(failure)
    const error = await lidarListLibrary().then(() => null, (rejection: unknown) => rejection)
    expect(lidarFailureMessage(error)).toBe(t('canvas.lidar.failure.generic'))
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'native', source: 'lidar.list', surfaced: true })
  })

  it('marks each recorded failure surfaced, since the caller shows its message inline (canopi-f47t.52.36)', () => {
    lidarFailureMessage(refusal(EVERY_KIND.NotGeotiff))
    lidarFailureMessage(new Error('engine stopped'))
    expect(ringEntries().map((entry) => entry.surfaced)).toEqual([true, true])
  })
})
