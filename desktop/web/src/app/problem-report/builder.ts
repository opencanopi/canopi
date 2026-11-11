/**
 * app/problem-report/builder.ts: the one TS builder of a problem report over `REPORT_SECTIONS` on
 * both editions (contracts §13 Failure report and §22, ADR 0025, 2.1-M412, 2.1-M421, 2.1-M422, 2.1-Q277, 2.1-Q281).
 *
 * - **Entries.** One per `REPORT_SECTIONS` row, in report order; the Design only by consent. The frontend's own
 *   sections (the originating failure, the description, the app-failures ring) are filled here; each other section is
 *   read through the edition's `EditionSections` (the port, platform/problem-report.ts): a reader, `native`
 *   (Desktop's command fills it) or `not_on_this_edition` (F13; no editions column).
 * - **Manifest.** Every entry but itself with its status, in the shape and format Desktop's native writer uses
 *   (`bundle.rs`); null when a section is native, since the native writer then lists it. A frontend section's status
 *   follows the native rule: included when its text holds anything, else empty with the `empty` marker; an empty ring
 *   holds nothing, as an empty native-failures list is empty.
 * - **Privacy.** Every text but the consented Design is redacted by `failures/redact.ts`; a redactor fault stores
 *   `redaction_failed`, never the text (contracts §13). A reader that throws, as a degraded store may, marks its
 *   section unreadable and the report is still built.
 */
import { REPORT_SECTIONS, type ReportSectionId } from '../../generated/contracts'
import { redact } from '../../failures/redact'
import type { ReportOrigin } from '../../failures/report'
import type { EditionSections, ProblemReport, ReportEntry, SectionReader } from '../../platform/problem-report'

/** The manifest's format name, as Desktop's native writer names it (`bundle.rs` MANIFEST_FORMAT). */
const REPORT_MANIFEST_FORMAT = 'canopi-problem-report-2'

/** What a redactor fault stores instead of the text. */
const REDACTION_FAILED = 'redaction_failed'

/** The text a frontend section with nothing to say holds, as the native writer writes it. */
const EMPTY_TEXT = 'empty\n'

export interface ProblemReportInput {
  readonly createdAt: Date
  /** What the user wrote. */
  readonly description: string
  /** The app-failures ring as the section lists it. */
  readonly ring: unknown
  /** The failure the report was opened from, or null. */
  readonly origin: ReportOrigin | null
  /** The current Design's `.canopi` text, only when the user ticked its checkbox. */
  readonly design: string | null
  readonly sections: EditionSections
  /** The redactor; `failures/redact.ts` unless a test plants a fault. */
  readonly redact?: (text: string) => string
}

/** Builds the report's entries and manifest from the edition's sections; never throws on a section's fault. */
export function buildProblemReport(input: ProblemReportInput): ProblemReport {
  const redactor = input.redact ?? redact
  const safe = (text: string): string => {
    try {
      return redactor(text)
    } catch {
      // A redactor fault stores its marker, never the unredacted text, and the report is still built.
      return REDACTION_FAILED
    }
  }
  const createdAt = isoSeconds(input.createdAt)
  const entries: ReportEntry[] = []
  for (const row of REPORT_SECTIONS) {
    const filled = fill(row.id, input, safe)
    if (filled) entries.push({ section: row.id, file: row.file, ...filled })
  }
  const listed = entries.flatMap((entry) =>
    entry.status === 'native' ? [] : [{ section: entry.section, file: entry.file, status: entry.status }],
  )
  const manifest = listed.length === entries.length
    ? { format: REPORT_MANIFEST_FORMAT, created_at: createdAt, entries: listed }
    : null
  return { fileName: reportFileName(createdAt), entries, manifest }
}

type Filled = Pick<ReportEntry, 'status' | 'text'>

function fill(id: ReportSectionId, input: ProblemReportInput, safe: (text: string) => string): Filled | null {
  if (id === 'design') return input.design === null ? null : { status: 'included', text: input.design }
  if (id === 'originating_failure') return frontendText(input.origin ? safe(json(originText(input.origin))) : '')
  if (id === 'description') return frontendText(safe(input.description))
  // An empty ring has nothing to say: empty, as the native writer marks an empty native-failures list.
  if (id === 'frontend_ring') return frontendText(isEmptyList(input.ring) ? '' : safe(JSON.stringify(input.ring, null, 2)))
  return editionSection(input.sections[id], safe)
}

/** The originating failure, its code and operation first. */
function originText(origin: ReportOrigin): Record<string, unknown> {
  return { code: origin.code, operation: origin.operation, op: origin.source, detail: origin.detail }
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

function frontendText(text: string): Filled {
  return text.trim() === '' ? { status: 'empty', text: EMPTY_TEXT } : { status: 'included', text }
}

function editionSection(reader: SectionReader, safe: (text: string) => string): Filled {
  if (reader === 'native') return { status: 'native', text: null }
  if (reader === 'not_on_this_edition') {
    return { status: 'not_on_this_edition', text: json({ status: 'not_on_this_edition' }) }
  }
  let value: unknown
  try {
    value = reader()
  } catch (error) {
    // A source that cannot be read leaves its entry, marked, as the native writer does; the report is still built.
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'unreadable', text: safe(json({ status: 'unreadable', error: message })) }
  }
  return { status: 'included', text: safe(json(value)) }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** ISO 8601 UTC to the second, as the native writer stamps its report. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function reportFileName(createdAt: string): string {
  const digits = createdAt.replace(/\D/g, '')
  return `canopi-report-${digits.slice(0, 8)}-${digits.slice(8, 14)}.zip`
}
