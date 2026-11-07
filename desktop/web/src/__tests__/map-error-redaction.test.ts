import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { describeMapErrorEvent, redactCredentials, redactError } from '../maplibre/redact-credentials'

describe('map error credential redaction', () => {
  it('redacts the Google key wherever it rides in a URL', () => {
    expect(redactCredentials('https://tile.googleapis.com/v1/2dtiles/3/4/5?key=AIzaSECRET'))
      .toBe('https://tile.googleapis.com/v1/2dtiles/3/4/5?key=<redacted>')
    expect(redactCredentials('a=1&api_key=SECRET&b=2')).toBe('a=1&api_key=<redacted>&b=2')
  })

  it('redacts the session token of an official tile URL, not only the key', () => {
    const message = 'AJAXError: Not Found (404): https://tile.googleapis.com/v1/2dtiles/3/4/5?session=AKz-SESSION_TOKEN&key=AIzaSECRET'
    const redacted = redactCredentials(message)
    expect(redacted).not.toContain('SESSION_TOKEN')
    expect(redacted).not.toContain('AIzaSECRET')
    expect(redacted).toBe('AJAXError: Not Found (404): https://tile.googleapis.com/v1/2dtiles/3/4/5?session=<redacted>&key=<redacted>')
    expect(describeMapErrorEvent({ sourceId: 'satellite', error: { status: 404, message } }))
      .not.toContain('SESSION_TOKEN')
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
})

describe('map composition failures reach the failure ring', () => {
  it.fails('[1b-c1 canopi-f47t.52.42] WEB-06: a keyed tile URL in a composition failure reaches the ring redacted', async () => {
    const { logMapError } = await import('../maplibre/redact-credentials')
    const { recentFrontendDiagnostics, resetFrontendDiagnosticsForTests } = await import('../app/problem-report/diagnostics')
    resetFrontendDiagnosticsForTests()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      logMapError({
        sourceId: 'satellite',
        error: { status: 403, message: 'AJAXError: Forbidden (403): https://tile.googleapis.com/v1/2dtiles/3/4/5?session=AKz-SESSION&key=AIzaSECRET' },
      })
      const entries = recentFrontendDiagnostics()
      // The failure is a ring entry the problem report carries, never console text alone.
      expect(entries.map((entry) => entry.message).join('\n')).toContain('key=<redacted>')
      expect(JSON.stringify(entries)).not.toContain('AIzaSECRET')
      expect(JSON.stringify(entries)).not.toContain('AKz-SESSION')
    } finally {
      quiet.mockRestore()
      resetFrontendDiagnosticsForTests()
    }
  })
})
