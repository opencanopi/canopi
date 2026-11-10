// @vitest-environment jsdom
// The Web problem report writer (contracts §22, 2.1-M422, Q277, Q281, Q282): one stored zip named
// canopi-report-YYYYMMDD-HHMMSS.zip whose manifest lists every other entry, downloaded with a delayed revoke the
// writer frees on dispose; the browser section names the browser, its major version and OS family, or unknown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPORT_MANIFEST_FILE, REPORT_SECTIONS, type ReportManifest } from '../generated/contracts'
import { buildProblemReport } from '../app/problem-report/builder'

const READERS = { build: () => ({ app: 'Canopi', version: '2.1.0' }), health: () => ({}), settings: () => ({ locale: 'en' }), currentDesign: () => null }
import { createBrowserProblemReportWriter } from './problem-report.browser'

/** Reads a stored (method 0) zip's entries by its central directory, checking each local header and CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.byteLength - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const files = new Map<string, string>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    expect(view.getUint16(at + 10, true)).toBe(0)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    expect(view.getUint32(local, true)).toBe(0x04034b50)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + size)
    expect(crc32(data), name).toBe(crc)
    files.set(name, decoder.decode(data))
    at += 46 + nameLength
  }
  return files
}

function crc32(data: Uint8Array): number {
  let crc = ~0
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

const WEB_INPUT = {
  createdAt: new Date('2026-11-08T09:05:03Z'),
  description: 'The canvas froze',
  ring: [],
  origin: null,
  design: null,
  sections: {
    build: () => ({ app: 'Canopi' }),
    health: () => ({ stores: {} }),
    queues: 'not_on_this_edition',
    native_settlements: 'not_on_this_edition',
    jobs: 'not_on_this_edition',
    library_disk: 'not_on_this_edition',
    log_tail: 'not_on_this_edition',
    settings_summary: () => ({ locale: 'en' }),
  },
} as const

let blobs: Blob[]

beforeEach(() => {
  vi.useFakeTimers()
  blobs = []
  let next = 0
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob)
    next += 1
    return `blob:report-${next}`
  })
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Web problem report writer', () => {
  it('writes a stored zip of every entry and its manifest, its UTF-8 text intact', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const writer = createBrowserProblemReportWriter(READERS)
    await writer.write(buildProblemReport({ ...WEB_INPUT, description: 'Café ☕\n' }))
    const files = unzip(new Uint8Array(await blobs[0]!.arrayBuffer()))
    expect(files.get('description.txt')).toBe('Café ☕\n')
    expect([...files.keys()].at(-1)).toBe(REPORT_MANIFEST_FILE)
    writer.dispose()
  })

  it('downloads one canopi-report-YYYYMMDD-HHMMSS.zip with the entries and manifest, in both consent states', async () => {
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    })
    const writer = createBrowserProblemReportWriter(READERS)
    for (const design of [null, '{"name":"Orchard"}\n']) {
      const report = buildProblemReport({ ...WEB_INPUT, design })
      // A download: the writer has no folder to show (2.1-Q283).
      await expect(writer.write(report)).resolves.toEqual({ file_name: 'canopi-report-20261108-090503.zip' })
      const files = unzip(new Uint8Array(await blobs.at(-1)!.arrayBuffer()))
      const manifest = JSON.parse(files.get(REPORT_MANIFEST_FILE)!) as ReportManifest
      expect(manifest.entries.map((entry) => entry.file)).toEqual([...files.keys()].filter((name) => name !== REPORT_MANIFEST_FILE))
      expect(files.has('design.canopi')).toBe(design !== null)
      expect(manifest.entries).toHaveLength(REPORT_SECTIONS.length - (design === null ? 1 : 0))
    }
    expect(clicked).toEqual(['canopi-report-20261108-090503.zip', 'canopi-report-20261108-090503.zip'])
    expect(writer.reveal).toBeUndefined()
    writer.dispose()
  })

  it('revokes the download URL after a delay, and frees any still pending on dispose', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const writer = createBrowserProblemReportWriter(READERS)
    await writer.write(buildProblemReport(WEB_INPUT))
    // Revoked at once, a download the browser has not started yet would fail.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report-1')

    await writer.write(buildProblemReport(WEB_INPUT))
    writer.dispose()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report-2')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('refuses a report with native sections, which only Desktop\'s command can fill', async () => {
    const writer = createBrowserProblemReportWriter(READERS)
    const native = buildProblemReport({ ...WEB_INPUT, sections: { ...WEB_INPUT.sections, build: 'native' } })
    await expect(writer.write(native)).rejects.toThrow()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('names the browser, its major version and OS family, or unknown when the user agent is unparsable (2.1-Q282)', () => {
    const writer = createBrowserProblemReportWriter(READERS)
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get')
    /** The build section's browser for a user agent, as the report writes it. */
    const browserFor = (agent: string) => {
      userAgent.mockReturnValue(agent)
      return ((writer.sections.build as () => { browser: unknown })()).browser
    }
    expect(browserFor('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'))
      .toEqual({ name: 'Firefox', major: 140, os: 'Linux' })
    expect(browserFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'))
      .toEqual({ name: 'Edge', major: 141, os: 'Windows' })
    expect(browserFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15'))
      .toEqual({ name: 'Safari', major: 18, os: 'macOS' })
    expect(browserFor('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'))
      .toEqual({ name: 'Chrome', major: 141, os: 'Android' })
    expect(browserFor('')).toEqual({ name: 'unknown', major: null, os: 'unknown' })
    expect(browserFor('\u0000garbage/((')).toEqual({ name: 'unknown', major: null, os: 'unknown' })
    // The build section keeps the app's own fields beside the browser.
    expect((writer.sections.build as () => Record<string, unknown>)()).toMatchObject({ app: 'Canopi', version: '2.1.0' })
  })
})
