// The one TS report builder over REPORT_SECTIONS (contracts §13 Failure report, 2.1-M421, 2.1-M422): Desktop and Web
// build the same sections, every catalogue code reaches the report, and a report opened from a failure leads with it.
import { describe, expect, it, vi } from 'vitest'
import {
  FAILURE_CATALOGUE,
  REPORT_SECTIONS,
  type Failure,
  type FailureCode,
  type ReportSectionId,
} from '../../generated/contracts'
import { reportFailure, type ReportOrigin } from '../../failures/report'
import { resetFrontendDiagnosticsForTests } from '../../failures/ring'
import type { EditionSections, ProblemReport } from '../../platform/problem-report'
import { desktopProblemReport } from '../../platform/problem-report.desktop'
import { createProblemReport } from '../../ipc/problem-report'
import { buildProblemReport, type ProblemReportInput } from './builder'
import { recentFrontendDiagnostics } from './diagnostics'

vi.mock('../../ipc/problem-report', () => ({
  createProblemReport: vi.fn().mockResolvedValue({ file_name: 'canopi-report-20261108-090503.zip' }),
  showProblemReportFolder: vi.fn(),
}))

/** What Desktop's adapter sends the native command for a report, through the real adapter. */
async function nativeRequest(report: ProblemReport) {
  await desktopProblemReport.write(report)
  return vi.mocked(createProblemReport).mock.calls.at(-1)![0]
}

const FIXTURES = import.meta.glob<{ default: Failure }>('../../../../../canopi-types/fixtures/failures/*.json', { eager: true })

const CREATED_AT = new Date('2026-11-08T09:05:03.250Z')

/** Desktop: the native command fills every edition section. */
const DESKTOP = desktopProblemReport.sections

/** Web: the browser fills what it has and lacks the rest (F13). */
const WEB: EditionSections = {
  build: () => ({ app: 'Canopi', browser: { name: 'Firefox', major: 140, os: 'Linux' } }),
  health: () => ({ stores: { settings: { status: { kind: 'ready' }, notice: null } } }),
  queues: 'not_on_this_edition',
  native_settlements: 'not_on_this_edition',
  jobs: 'not_on_this_edition',
  library_disk: 'not_on_this_edition',
  log_tail: 'not_on_this_edition',
  settings_summary: () => ({ locale: 'fr', theme: 'dark' }),
}

function input(overrides: Partial<ProblemReportInput> = {}): ProblemReportInput {
  return {
    createdAt: CREATED_AT,
    description: 'The canvas froze',
    ring: [],
    origin: null,
    design: null,
    sections: WEB,
    ...overrides,
  }
}

function text(report: ReturnType<typeof buildProblemReport>, section: ReportSectionId): string {
  const entry = report.entries.find((candidate) => candidate.section === section)
  expect(entry, section).toBeDefined()
  return entry!.text ?? ''
}

function originOf(failure: Failure): ReportOrigin {
  return { source: failure.op, code: failure.code, operation: failure.operation, detail: failure.detail }
}

describe('problem report builder', () => {
  it('[1b-c5 canopi-f47t.52.37] every_code_reaches_the_report', async () => {
    const fixtures = new Map(Object.values(FIXTURES).map(({ default: failure }) => [failure.code.kind, failure]))
    for (const kind of Object.keys(FAILURE_CATALOGUE) as FailureCode['kind'][]) {
      const failure = fixtures.get(kind)
      expect(fixtures.has(kind), `canopi-types/fixtures/failures/${kind}.json`).toBe(true)
      for (const sections of [DESKTOP, WEB]) {
        const report = buildProblemReport(input({ origin: originOf(failure!), sections }))
        const failureJson = JSON.parse(text(report, 'originating_failure')) as { code: FailureCode }
        expect(failureJson.code, kind).toEqual(failure!.code)
        // Desktop's command receives the code in the section the frontend sends.
        if (sections === DESKTOP) {
          const sent = (await nativeRequest(report)).sections.find((section) => section.id === 'originating_failure')
          expect(JSON.parse(sent!.text).code).toEqual(failure!.code)
        }
      }
    }

    // Each code also reaches the app-failures ring section once, however many surfaces report its settlement.
    resetFrontendDiagnosticsForTests()
    for (const failure of fixtures.values()) {
      const settlement = { ...failure }
      reportFailure(settlement, { shown: 'none' })
      reportFailure(settlement, { shown: 'inline', source: 'surface.example' })
    }
    for (const sections of [DESKTOP, WEB]) {
      const report = buildProblemReport(input({ ring: recentFrontendDiagnostics(), sections }))
      const ring = JSON.parse(text(report, 'frontend_ring')) as { code: FailureCode }[]
      for (const failure of fixtures.values()) {
        expect(ring.filter((entry) => JSON.stringify(entry.code) === JSON.stringify(failure.code)), failure.code.kind).toHaveLength(1)
      }
    }
    resetFrontendDiagnosticsForTests()
  })

  it('[1b-c5 canopi-f47t.52.96] a Web problem report bundle carries Desktop\'s sections', () => {
    const web = buildProblemReport(input({ sections: WEB }))
    const desktop = buildProblemReport(input({ sections: DESKTOP }))
    const rows = REPORT_SECTIONS.filter((row) => row.consent === 'always').map((row) => [row.id, row.file])
    expect(web.entries.map((entry) => [entry.section, entry.file])).toEqual(rows)
    expect(desktop.entries.map((entry) => [entry.section, entry.file])).toEqual(rows)
    // Each section Web lacks is marked so in its entry and the manifest, never dropped (F13).
    const lacking = Object.entries(WEB).filter(([, reader]) => reader === 'not_on_this_edition').map(([id]) => id)
    for (const id of lacking) {
      expect(web.manifest!.entries.find((entry) => entry.section === id)!.status).toBe('not_on_this_edition')
      expect(JSON.parse(text(web, id as ReportSectionId))).toEqual({ status: 'not_on_this_edition' })
    }
    expect(JSON.parse(text(web, 'build')).browser).toEqual({ name: 'Firefox', major: 140, os: 'Linux' })
  })

  it('[1b-c5 canopi-f47t.52.37] a report opened from a failure lists its code and operation first', async () => {
    const origin: ReportOrigin = {
      source: 'library.delete_item',
      code: { kind: 'busy', lane: 'library' },
      operation: 'u-3f2a0c1e-0000-4000-8000-000000000000' as ReportOrigin['operation'],
      detail: 'the library lane was full',
    }
    const report = buildProblemReport(input({ origin }))
    expect(report.entries[0]!.section).toBe('originating_failure')
    expect(report.manifest!.entries[0]).toEqual({ section: 'originating_failure', file: 'failure.json', status: 'included' })
    const failure = text(report, 'originating_failure')
    expect(Object.keys(JSON.parse(failure)).slice(0, 2)).toEqual(['code', 'operation'])
    expect(JSON.parse(failure)).toMatchObject({ code: origin.code, operation: origin.operation, op: origin.source })
    // Opened from no failure, the entry is kept and marked empty, as the native writer marks it.
    const plain = buildProblemReport(input())
    expect(plain.manifest!.entries[0]!.status).toBe('empty')
    expect(text(plain, 'originating_failure')).toBe('empty\n')
    expect((await nativeRequest(buildProblemReport(input({ sections: DESKTOP })))).sections.map((section) => section.id))
      .toEqual(['description', 'frontend_ring'])
  })

  it('lists every entry but itself in the manifest, in both consent states (2.1-Q277, 2.1-M436)', () => {
    for (const design of [null, '{"name":"Orchard"}\n']) {
      const report = buildProblemReport(input({ design }))
      expect(report.manifest!.format).toBe('canopi-problem-report-2')
      expect(report.manifest!.created_at).toBe('2026-11-08T09:05:03Z')
      expect(report.manifest!.entries.map((entry) => entry.file)).toEqual(report.entries.map((entry) => entry.file))
      expect(report.manifest!.entries.some((entry) => entry.file === 'manifest.json')).toBe(false)
      expect(report.entries.some((entry) => entry.section === 'design')).toBe(design !== null)
    }
  })

  it('maps each consent row to its request field: the Design to current_design, unredacted, only when ticked', async () => {
    const design = '{"notes":"/home/ana/secret.canopi"}\n'
    for (const row of REPORT_SECTIONS.filter((candidate) => candidate.consent === 'current_design')) {
      expect(row.id).toBe('design')
      expect((await nativeRequest(buildProblemReport(input({ sections: DESKTOP, design })))).current_design).toBe(design)
      expect((await nativeRequest(buildProblemReport(input({ sections: DESKTOP })))).current_design).toBeNull()
    }
    expect(text(buildProblemReport(input({ design })), 'design')).toBe(design)
  })

  it('leaves the manifest to the native writer when a section is native', () => {
    const report = buildProblemReport(input({ sections: DESKTOP }))
    expect(report.manifest).toBeNull()
    expect(report.entries.filter((entry) => entry.status === 'native').map((entry) => entry.section).sort())
      .toEqual(Object.keys(DESKTOP).sort())
  })

  it('names the report canopi-report-YYYYMMDD-HHMMSS.zip in UTC on both editions (2.1-Q281)', () => {
    expect(buildProblemReport(input({ sections: WEB })).fileName).toBe('canopi-report-20261108-090503.zip')
    expect(buildProblemReport(input({ sections: DESKTOP })).fileName).toBe('canopi-report-20261108-090503.zip')
  })

  it('redacts every text but the consented Design', () => {
    const report = buildProblemReport(input({
      description: 'It failed opening /home/alice/designs/orchard.canopi',
      ring: [{ message: 'GET https://tile.googleapis.com/v1/x?key=AIzaSECRET failed' }],
      sections: { ...WEB, settings_summary: () => ({ folder: 'C:\\Users\\alice\\Canopi' }) },
    }))
    expect(text(report, 'description')).not.toContain('alice')
    expect(text(report, 'frontend_ring')).not.toContain('AIzaSECRET')
    expect(text(report, 'settings_summary')).not.toContain('alice')
  })

  it('stores redaction_failed when the redactor throws, and still builds the report', () => {
    const report = buildProblemReport(input({
      description: 'secret text',
      redact: () => {
        throw new Error('redactor fault')
      },
    }))
    expect(text(report, 'description')).toBe('redaction_failed')
    expect(text(report, 'build')).toBe('redaction_failed')
    expect(report.entries).toHaveLength(REPORT_SECTIONS.length - 1)
    expect(JSON.stringify(report)).not.toContain('secret text')
  })

  it('a degraded store says unavailable in the health section, and a reader that throws marks its section unreadable', () => {
    const degraded = buildProblemReport(input({
      sections: { ...WEB, health: () => ({ stores: { settings: { status: { kind: 'unavailable', code: { kind: 'internal' } }, notice: null } } }) },
    }))
    expect(JSON.parse(text(degraded, 'health')).stores.settings.status.kind).toBe('unavailable')
    const throwing = buildProblemReport(input({
      sections: { ...WEB, health: () => { throw new Error('store at /home/alice/.canopi is locked') } },
    }))
    expect(throwing.manifest!.entries.find((entry) => entry.section === 'health')!.status).toBe('unreadable')
    expect(JSON.parse(text(throwing, 'health'))).toEqual({ status: 'unreadable', error: 'store at <path> is locked' })
  })

  it('a refused .canopi file\'s field path reaches the report (2.1-Q286)', () => {
    const refusal = 'Failed to load Design: $.plants[0].position: invalid value'
    const report = buildProblemReport(input({
      ring: [{ level: 'error', source: 'ipc.load_design', message: refusal, timestamp_ms: 1 }],
      origin: { source: 'ipc.load_design', code: { kind: 'internal' }, operation: null, detail: refusal },
    }))
    expect(text(report, 'frontend_ring')).toContain('$.plants[0].position')
    expect(JSON.parse(text(report, 'originating_failure')).detail).toContain('$.plants[0].position')
  })
})
