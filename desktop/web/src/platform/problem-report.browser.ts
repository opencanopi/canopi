// platform/problem-report.browser.ts: the Web Edition's problemReport adapter (contracts §22, 2.1-M422; Q277, Q281,
// Q282). Invariant: one stored zip of the builder's entries and a manifest of every other entry, downloaded under the
// report's file name; its object URL is revoked after a delay (an at-once revoke can fail a download not yet started)
// and every pending one is freed on dispose. Sections with no browser source are marked not on this edition (F13).
import type { ProblemReport, ProblemReportPort } from './problem-report'
import { REPORT_MANIFEST_FILE, type ProblemReportResult } from '../generated/contracts'

/** Long enough for any browser to start the download from the URL. */
const REVOKE_AFTER_MS = 60_000

/** The browser as the report names it (2.1-Q282): family, major version and OS family, never the full user agent. */
export interface BrowserFamily {
  readonly name: string
  readonly major: number | null
  readonly os: string
}

// Most specific first: Edge and Opera carry Chrome's token, Chrome carries Safari's.
const BROWSERS: readonly (readonly [string, RegExp])[] = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /\bOPR\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
]

const SYSTEMS: readonly (readonly [string, RegExp])[] = [
  ['Android', /\bAndroid\b/],
  ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
  ['Windows', /\bWindows\b/],
  ['macOS', /\bMac OS X\b/],
  ['ChromeOS', /\bCrOS\b/],
  ['Linux', /\bLinux\b/],
]

/** Reads the browser family from a user agent; unknown parts say unknown, and it never throws. */
export function browserFamily(userAgent: string): BrowserFamily {
  const browser = BROWSERS.map(([name, pattern]) => [name, pattern.exec(userAgent)] as const).find(([, match]) => match)
  const os = SYSTEMS.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? 'unknown'
  const major = browser ? Number(browser[1]![1]) : NaN
  return browser && Number.isFinite(major) ? { name: browser[0], major, os } : { name: 'unknown', major: null, os }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A zip of the files, each stored uncompressed (method 0) with UTF-8 names, as Desktop's `zip.rs` writes them. */
export function storedZip(files: readonly { readonly name: string; readonly text: string }[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.text)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 20, true)
    header.setUint16(8, 0x0800, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, data.length, true)
    header.setUint32(24, data.length, true)
    header.setUint16(28, name.length, true)
    header.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), name, data)
    central.push(new Uint8Array(header.buffer), name)
    offset += 30 + name.length + data.length
  }
  const centralSize = central.reduce((size, part) => size + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const bytes = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const part of all) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

export interface BrowserProblemReportWriter extends ProblemReportPort {
  /** Frees every download URL not yet revoked. */
  dispose(): void
}

/**
 * What the Web shell reads for the sections the browser has (the build, the store health, the settings summary) and
 * for the consent row (the current Design, from the Web Design session).
 */
export interface BrowserReportReaders {
  readonly build: () => Record<string, unknown>
  readonly health: () => unknown
  readonly settings: () => unknown
  readonly currentDesign: () => string | null
}

export function createBrowserProblemReportWriter(readers: BrowserReportReaders): BrowserProblemReportWriter {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const release = (url: string) => {
    clearTimeout(pending.get(url))
    pending.delete(url)
    URL.revokeObjectURL(url)
  }
  return {
    sections: {
      build: () => ({ ...readers.build(), browser: browserFamily(navigator.userAgent) }),
      health: () => ({ stores: readers.health() }),
      queues: 'not_on_this_edition',
      native_settlements: 'not_on_this_edition',
      jobs: 'not_on_this_edition',
      library_disk: 'not_on_this_edition',
      log_tail: 'not_on_this_edition',
      settings_summary: readers.settings,
    },
    currentDesign: readers.currentDesign,
    async write(report: ProblemReport): Promise<ProblemReportResult> {
      const manifest = report.manifest
      if (!manifest) throw new Error('A Web problem report has no native sections')
      const files = report.entries.map((entry) => ({ name: entry.file, text: entry.text ?? '' }))
      files.push({ name: REPORT_MANIFEST_FILE, text: `${JSON.stringify(manifest, null, 2)}\n` })
      const zip = storedZip(files)
      const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = report.fileName
      document.body.appendChild(anchor)
      try {
        anchor.click()
      } catch (error) {
        URL.revokeObjectURL(url)
        throw error
      } finally {
        anchor.remove()
      }
      pending.set(url, setTimeout(() => release(url), REVOKE_AFTER_MS))
      // A download: this writer has no folder to show (no `reveal`).
      return { file_name: report.fileName }
    },
    dispose() {
      for (const url of [...pending.keys()]) release(url)
    },
  }
}
