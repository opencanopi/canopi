// @vitest-environment jsdom
// Map failures reach the console and the problem report only through the failure sink, whose one redactor removes the
// Google key and session MapLibre copies from request URLs into errors (AGENTS.md Secrets, ADR 0025).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redactError } from '../failures/redact'
import { failureNoticesForTests, installFailureHooks, resetFailureNoticesForTests } from '../failures/report'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../failures/ring'
import { reportMapError, reportMapSourceFailure } from '../maplibre/map-errors'

const KEYED_TILE = 'https://tile.googleapis.com/v1/2dtiles/3/4/5?session=AKz-SESSION_TOKEN&key=AIzaSECRET'

describe('map error credential redaction', () => {
  let quiet: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
    quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    quiet.mockRestore()
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
  })

  it('redacts the Google key wherever it rides in a URL', () => {
    reportMapSourceFailure('Passive MapLibre World map error:', 'https://tile.googleapis.com/v1/2dtiles/3/4/5?key=AIzaSECRET')
    reportMapError('Satellite request failed:', 'a=1&api_key=SECRET&b=2')
    expect(quiet.mock.calls).toEqual([
      ['Passive MapLibre World map error:', 'https://tile.googleapis.com/v1/2dtiles/3/4/5?key=<redacted>'],
      ['Satellite request failed:', 'a=1&api_key=<redacted>&b=2'],
    ])
    expect(JSON.stringify(ringEntries())).not.toMatch(/AIzaSECRET|api_key=SECRET/)
  })

  it('redacts the session token of an official tile URL, not only the key', () => {
    reportMapSourceFailure('Passive MapLibre World map error:', { sourceId: 'satellite', error: { status: 404, message: `AJAXError: Not Found (404): ${KEYED_TILE}` } })
    expect(ringEntries()[0]).toMatchObject({
      text: 'Passive MapLibre World map error: source satellite · status 404 · AJAXError: Not Found (404): https://tile.googleapis.com/v1/2dtiles/3/4/5?session=<redacted>&key=<redacted>',
    })
    const recorded = JSON.stringify([ringEntries(), quiet.mock.calls])
    expect(recorded).not.toContain('SESSION_TOKEN')
    expect(recorded).not.toContain('AIzaSECRET')
    expect(quiet).toHaveBeenCalledWith('Passive MapLibre World map error:', expect.stringContaining('session=<redacted>&key=<redacted>'))
  })

  it('returns the same error when it holds no credential', () => {
    const plain = new Error('Style failed')
    expect(redactError(plain)).toBe(plain)
    const leaky = new Error('GET https://x/tile?session=TOKEN failed')
    const redacted = redactError(leaky)
    expect(redacted).not.toBe(leaky)
    expect(redacted.message).toBe('GET https://x/tile?session=<redacted> failed')
  })

  // S24: one module builds every URL that carries the Google key or a session, so a reviewer reads one file to see
  // where they go; the provider asks it for request URLs.
  it('keeps every Google tile endpoint in basemap-tile-auth.ts', () => {
    const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.tsx?$/.test(path) && !/(^|\/)__tests__\//.test(path) && !/\.test\.tsx?$/.test(path))
    const holders = sources.filter((path) => readFileSync(join('src', path), 'utf8').includes('tile.googleapis.com'))
    expect(holders).toEqual(['maplibre/basemap-tile-auth.ts'])
  })

  it('[1b-c1 canopi-f47t.52.42] WEB-06: a keyed tile URL in a composition failure reaches the ring redacted', () => {
    const failure = new Error(`AJAXError: Forbidden (403): ${KEYED_TILE}`)
    reportMapError('Shared workspace composition failed:', failure)

    // The failure is a ring entry the problem report carries, echoed redacted, never console text alone.
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'frontend', source: 'map', code: { kind: 'internal' }, surfaced: false })
    expect(entries[0]!.origin === 'frontend' && entries[0]!.text).toContain('key=<redacted>')
    expect(JSON.stringify(entries)).not.toMatch(/AIzaSECRET|AKz-SESSION/)
    expect(JSON.stringify(quiet.mock.calls)).not.toMatch(/AIzaSECRET|AKz-SESSION/)
    // The console keeps the logger's shape: the label, then the error, redacted.
    expect(quiet).toHaveBeenCalledExactlyOnceWith('Shared workspace composition failed:', expect.any(Error))
    expect((quiet.mock.calls[0]![1] as Error).message).toContain('key=<redacted>')
  })

  it('[canopi-f47t.52.36] a map error whose stack holds only frames still records its redacted cause', () => {
    const failure = new Error(`AJAXError: Forbidden (403): ${KEYED_TILE}`)
    failure.stack = 'reportFailureFor@tauri://localhost/assets/index.js:12:34'
    reportMapError('Shared workspace map failed:', failure)

    const text = ringEntries()[0]?.origin === 'frontend' ? (ringEntries()[0] as { text: string }).text : ''
    expect(text).toContain('Shared workspace map failed: Error: AJAXError: Forbidden (403):')
    expect(text).toContain('key=<redacted>')
    expect(text).toContain('reportFailureFor@tauri://localhost/assets/index.js:12:34')
    expect(text).not.toMatch(/AIzaSECRET|AKz-SESSION/)
  })

  it('tile source failing before 2d: one redacted entry under its layer counting each occurrence, no notice (2.1-Q300)', () => {
    const dispose = installFailureHooks({ storage: 'disk' }, window)
    const event = { sourceId: 'satellite', error: { status: 403, message: `AJAXError: Forbidden (403): ${KEYED_TILE}` } }
    reportMapSourceFailure('Passive MapLibre World map error:', event)
    reportMapSourceFailure('Passive MapLibre World map error:', event)
    reportMapSourceFailure('MapLibre workspace basemap resource failed to load:', { error: { message: 'sprite failed' } })
    dispose()

    // A repeat counts on the entry it repeats (canopi-vsey, 2.1-Q294).
    expect(ringEntries().map((entry) => [entry.code, entry.count])).toEqual([
      [{ kind: 'tile_source_failed', layer: 'satellite' }, 2],
      [{ kind: 'style_failed' }, 1],
    ])
    expect(JSON.stringify(ringEntries())).not.toMatch(/AIzaSECRET|AKz-SESSION/)
    expect(failureNoticesForTests().notices).toEqual([])
  })

  it('map failure after workspace release: one redacted entry, no notice', () => {
    installFailureHooks({ storage: 'device' }, window)()
    // A late failure from a map whose workspace and app lifetime are gone.
    reportMapError('Failed to release stale MapLibre workspace map:', new Error(`teardown: ${KEYED_TILE}`))

    expect(ringEntries()).toHaveLength(1)
    expect(JSON.stringify(ringEntries())).not.toContain('AIzaSECRET')
    expect(failureNoticesForTests().notices).toEqual([])
  })
})
