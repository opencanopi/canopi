/**
 * platform/file-delivery.ts: Owner of FileDelivery, its 9 delivery rows, and the file-kind table
 * (file-delivery-rows, no-cancelled-literal, no-inline-dialog-filters, ADR 0022 and 0025, contracts §16,
 * 2.1-M422, 2.1-M522, 2.1-Q359). Invariant: all 9 delivery kinds are data rows backed by generated
 * FILE_KINDS, `{ kind: 'cancelled' }` is returned only on user cancel or AbortSignal, and every download
 * filename passes through `buildDeliveryFileName`.
 */
import { reportFailure } from '../failures/report'
import type { DialogKind, FileKind } from '../generated/contracts'
import { FILE_KINDS as GENERATED_FILE_KINDS } from '../generated/file-kinds'

export type { FileKind }

export interface FileKindSpec {
  readonly kind: FileKind
  readonly extensions: readonly string[]
  readonly mimeType: string
  readonly label: string
  readonly accept: string
}

function buildFileKindSpec(kind: FileKind): FileKindSpec {
  const meta = GENERATED_FILE_KINDS[kind]
  const dotExts = meta.extensions.map((ext) => `.${ext}`)
  const baseMime = meta.mimeType.split(';')[0]!.trim()
  const acceptParts = [...dotExts, baseMime]
  if (kind === 'geojson') acceptParts.push('application/json')
  return {
    kind,
    extensions: meta.extensions,
    mimeType: meta.mimeType,
    label: meta.filterLabel,
    accept: acceptParts.join(','),
  }
}

/** Single file-kind table feeding FileDelivery rows, Desktop dialog filters, and Web `accept` strings. */
export const FILE_KINDS: Readonly<Record<FileKind, FileKindSpec>> = {
  canopi: buildFileKindSpec('canopi'),
  geojson: buildFileKindSpec('geojson'),
  pdf: buildFileKindSpec('pdf'),
  csv: buildFileKindSpec('csv'),
  geotiff: buildFileKindSpec('geotiff'),
  zip: buildFileKindSpec('zip'),
}

type SaveFileDialogKind = Extract<
  DialogKind,
  'design-save' | 'stamp-export' | 'geojson-export' | 'pdf-export' | 'budget-csv-export' | 'lidar-geotiff-export'
>

export interface FileDeliveryRow {
  readonly id: FileDeliveryKind
  readonly fileKind: FileKind
  readonly dialogKind: SaveFileDialogKind | null
  readonly stemSuffix?: string
  readonly fallbackStem?: string
}

/** Nine delivery rows as data (contracts §16, 2.1-M422, 2.1-M522). */
export type FileDeliveryKind =
  | 'canopi-copy'
  | 'canopi-draft'
  | 'stamp'
  | 'geojson'
  | 'pdf'
  | 'budget-csv'
  | 'geotiff'
  | 'analysis-geotiff'
  | 'problem-report'

export const FILE_DELIVERY_ROWS: Readonly<Record<FileDeliveryKind, FileDeliveryRow>> = {
  'canopi-copy': {
    id: 'canopi-copy',
    fileKind: 'canopi',
    dialogKind: 'design-save',
  },
  'canopi-draft': {
    id: 'canopi-draft',
    fileKind: 'canopi',
    dialogKind: 'design-save',
  },
  stamp: {
    id: 'stamp',
    fileKind: 'canopi',
    dialogKind: 'stamp-export',
  },
  geojson: {
    id: 'geojson',
    fileKind: 'geojson',
    dialogKind: 'geojson-export',
  },
  pdf: {
    id: 'pdf',
    fileKind: 'pdf',
    dialogKind: 'pdf-export',
  },
  'budget-csv': {
    id: 'budget-csv',
    fileKind: 'csv',
    dialogKind: 'budget-csv-export',
    stemSuffix: '-budget',
  },
  geotiff: {
    id: 'geotiff',
    fileKind: 'geotiff',
    dialogKind: 'lidar-geotiff-export',
  },
  'analysis-geotiff': {
    id: 'analysis-geotiff',
    fileKind: 'geotiff',
    dialogKind: 'lidar-geotiff-export',
  },
  'problem-report': {
    id: 'problem-report',
    fileKind: 'zip',
    dialogKind: null,
  },
}

export type FileDeliveryContent =
  | { readonly bytes: Uint8Array }
  | { readonly text: string }
  | { readonly native: string }

export type FileDeliveryOutcome = 'saved' | 'downloaded' | 'cancelled'

export interface FileDeliveryPort {
  deliverFile(
    kind: FileDeliveryKind,
    stem: string,
    content: FileDeliveryContent,
    signal?: AbortSignal,
  ): Promise<FileDeliveryOutcome>
  dispose?(): void
}

const utf8Encoder = new TextEncoder()

/**
 * Sanitise an exported file stem (2.1-Q359): each forbidden character becomes a space,
 * runs of whitespace collapse to one space, and an empty stem falls back to the caller's
 * localised Untitled label (defaulting to `'Untitled'`).
 */
function sanitizeFileStem(stem: string, fallback = 'Untitled'): string {
  const cleaned = stem
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length > 0) return cleaned
  return fallback
}

/** Build the suggested file name (including row suffix and primary extension) for a delivery row. */
export function buildDeliveryFileName(
  kind: FileDeliveryKind,
  stem: string,
  untitledFallback?: string,
): string {
  const row = FILE_DELIVERY_ROWS[kind]
  const spec = FILE_KINDS[row.fileKind]
  const primaryExt = spec.extensions[0] ?? ''
  const dotExt = primaryExt ? `.${primaryExt}` : ''
  let base = stem.trim()
  if (dotExt && base.toLowerCase().endsWith(dotExt.toLowerCase())) {
    base = base.slice(0, -dotExt.length)
  }
  const suffix = row.stemSuffix ?? ''
  if (suffix && base.toLowerCase().endsWith(suffix.toLowerCase())) {
    base = base.slice(0, -suffix.length)
  }
  const sanitized = sanitizeFileStem(base, row.fallbackStem ?? untitledFallback)
  return `${sanitized}${suffix}${dotExt}`
}

/** Encode `{ bytes }` or `{ text }` content to a `Uint8Array`, or return null for `{ native }`. */
export function deliveryContentBytes(content: FileDeliveryContent): Uint8Array | null {
  if ('bytes' in content) return content.bytes
  if ('text' in content) return utf8Encoder.encode(content.text)
  return null
}

const DEFAULT_REVOKE_AFTER_MS = 60_000

/**
 * Web FileDelivery adapter: delivers `{ bytes }` or `{ text }` as a Blob download and refuses
 * `{ native }` rows. Object URLs are revoked after `revokeAfterMs` (or immediately on `dispose()`).
 */
export function createBrowserFileDelivery(options: {
  readonly revokeAfterMs?: number
  readonly untitled?: () => string
} = {}): FileDeliveryPort {
  const revokeAfterMs = options.revokeAfterMs ?? DEFAULT_REVOKE_AFTER_MS
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  const release = (url: string) => {
    const timer = pending.get(url)
    if (timer !== undefined) clearTimeout(timer)
    pending.delete(url)
    URL.revokeObjectURL(url)
  }

  return {
    async deliverFile(
      kind: FileDeliveryKind,
      stem: string,
      content: FileDeliveryContent,
      signal?: AbortSignal,
    ): Promise<FileDeliveryOutcome> {
      if (signal?.aborted) return 'cancelled'
      const bytes = deliveryContentBytes(content)
      if (bytes === null) {
        const error = new Error(`Web edition cannot deliver native-only file row "${kind}"`)
        reportFailure(error, { shown: 'none' })
        throw error
      }
      const row = FILE_DELIVERY_ROWS[kind]
      const spec = FILE_KINDS[row.fileKind]
      const fileName = buildDeliveryFileName(kind, stem, options.untitled?.())
      const blob = new Blob([bytes as BlobPart], { type: spec.mimeType })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.rel = 'noopener'
      link.style.display = 'none'
      try {
        link.click()
      } catch (error) {
        release(url)
        throw error
      }
      if (revokeAfterMs <= 0) {
        release(url)
      } else {
        const timer = setTimeout(() => release(url), revokeAfterMs)
        pending.set(url, timer)
      }
      return 'downloaded'
    },
    dispose() {
      for (const url of [...pending.keys()]) release(url)
    },
  }
}
