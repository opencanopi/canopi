import { designLoadFailureMessageKey, designLoadFailureOf } from '../contracts/canopi-design-errors'
import type { LocaleKey } from '../../generated/locale-keys'
import type { FailureCode } from '../../generated/contracts'
import type { DesignLoadFailureKind } from '../../types/design'
import { reportFailure } from '../../failures/report'
import { failureOf } from '../../failures/ipc-failure'

/** The ring source of a Design that could not be opened. */
const DESIGN_LOAD_SOURCE = 'design.load'

/**
 * What the user sees when a Design cannot be opened: the typed load failure
 * turned into the Start screen's wording (older version, newer version,
 * missing, damaged), never a path or the raw error, as locale keys. The
 * presenter is the edition's notice surface (a native dialog on Desktop, the
 * one notice row on the Web); with or without one the failure is recorded for the
 * problem report, its refused field there only (2.1-Q286).
 *
 * On the Web a newer Design is read by the format core (platform/design-core.ts, 2.1-M477): a core that failed to load
 * or trapped says so in its own words, which name the part that opens Designs, never the file (ADR 0025).
 */
export interface DesignOpenFailureNotice {
  readonly tone: 'error'
  readonly title: LocaleKey
  readonly message: LocaleKey
}

export type DesignOpenFailurePresenter = (notice: DesignOpenFailureNotice) => void | Promise<void>

let presenter: DesignOpenFailurePresenter | null = null

export function registerDesignOpenFailurePresenter(next: DesignOpenFailurePresenter | null): void {
  presenter = next
}

/** The format core's own messages (ADR 0025); its other settlements carry a load failure. */
const FORMAT_CORE_MESSAGES: Readonly<Partial<Record<FailureCode['kind'], LocaleKey>>> = {
  format_core_unavailable: 'failure.formatCoreUnavailable',
  format_core_trapped: 'failure.formatCoreTrapped',
}

export function designOpenFailureNoticeOf(error: unknown): DesignOpenFailureNotice {
  const formatCore = FORMAT_CORE_MESSAGES[failureOf(error)?.code.kind ?? 'internal']
  if (formatCore) return { tone: 'error', title: 'start.cantOpenTitle', message: formatCore }
  const failure = designLoadFailureOf(error)
  const key = failure ? designLoadFailureMessageKey(failure.kind) : 'start.cantRead'
  return { tone: 'error', title: 'start.cantOpenTitle', message: key }
}

/** The catalogue code a load failure is recorded under until `design_load` joins the catalogue (2b, 2.1-M419). */
function failureCodeOf(kind: DesignLoadFailureKind): FailureCode {
  switch (kind) {
    case 'missing':
      return { kind: 'io', io: 'not_found' }
    case 'unreadable':
      return { kind: 'io', io: 'other' }
    case 'too_large':
      return { kind: 'io', io: 'too_large' }
    case 'invalid_json':
    case 'older_version':
    case 'newer_version':
    case 'invalid_document':
      return { kind: 'invalid' }
    case 'internal':
      return { kind: 'internal' }
  }
}

/**
 * Records the failure in the ring against the rejected object, told when a presenter shows it, so the command graph
 * reporting the rethrown object, or a transport that recorded it first, keeps its one entry: a typed load failure as
 * its kind, message and refused field (the report's, never the screen's, 2.1-Q286); anything else as itself.
 */
function recordDesignOpenFailure(error: unknown, shown: 'inline' | 'none'): void {
  const failure = designLoadFailureOf(error)
  const field = failure?.field_path ? ` at ${failure.field_path}` : ''
  reportFailure(error, {
    shown,
    source: DESIGN_LOAD_SOURCE,
    ...(failure && { code: failureCodeOf(failure.kind), text: `${failure.kind}${field}: ${failure.message}` }),
  })
}

/** Show the failure to the user through the registered presenter, if any, and record it for the problem report. */
export function presentDesignOpenFailure(error: unknown): void {
  recordDesignOpenFailure(error, presenter ? 'inline' : 'none')
  if (!presenter) return
  void Promise.resolve(presenter(designOpenFailureNoticeOf(error))).catch((cause) => {
    console.error('Design open failure could not be presented:', cause)
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    presenter = null
  })
}
