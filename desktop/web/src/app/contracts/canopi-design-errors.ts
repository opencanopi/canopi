import {
  CURRENT_CANOPI_FILE_VERSION,
  type CanopiDesignIngestionErrorKind,
} from '../../generated/canopi-design-format'
import type { DesignLoadFailure, DesignLoadFailureKind } from '../../types/design'
import type { LocaleKey } from '../../generated/locale-keys'

export class CanopiDesignIngestionError extends Error {
  constructor(
    readonly kind: CanopiDesignIngestionErrorKind,
    message: string,
    /** The file's version when `kind` is `unsupported_version`. */
    readonly unsupportedVersion: number | null = null,
  ) {
    super(message)
    this.name = 'CanopiDesignIngestionError'
  }
}

export function asCanopiDesignIngestionError(error: unknown): CanopiDesignIngestionError {
  if (error instanceof CanopiDesignIngestionError) return error
  return new CanopiDesignIngestionError(
    'invalid_document',
    error instanceof Error ? error.message : String(error),
  )
}

/** Every kind once: the compiler refuses a kind added to the contract and not here. */
const DESIGN_LOAD_FAILURE_KINDS = {
  missing: true,
  unreadable: true,
  too_large: true,
  invalid_json: true,
  older_version: true,
  newer_version: true,
  invalid_document: true,
  internal: true,
} as const satisfies Record<DesignLoadFailureKind, true>

function isDesignLoadFailureKind(kind: unknown): kind is DesignLoadFailureKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(DESIGN_LOAD_FAILURE_KINDS, kind)
}

/**
 * The typed failure a native `load_design` rejection carries, or the
 * equivalent for a Web ingestion error; null for anything else (a cancelled
 * dialog, an unexpected exception). A refused field's path is kept for the
 * failure ring and Problem Reports only, never for the screen (2.1-Q286); a
 * Web refusal names its field in its message, but for a version, `$.version`
 * as native does.
 */
export function designLoadFailureOf(error: unknown): DesignLoadFailure | null {
  if (error instanceof CanopiDesignIngestionError) {
    const newer = error.unsupportedVersion !== null && error.unsupportedVersion > CURRENT_CANOPI_FILE_VERSION
    if (error.kind === 'unsupported_version') {
      return { kind: newer ? 'newer_version' : 'older_version', message: error.message, field_path: '$.version' }
    }
    return { kind: 'invalid_document', message: error.message }
  }
  if (
    error !== null
    && typeof error === 'object'
    && 'kind' in error
    && 'message' in error
    && typeof error.message === 'string'
    && isDesignLoadFailureKind(error.kind)
  ) {
    const fieldPath = 'field_path' in error && typeof error.field_path === 'string' ? error.field_path : null
    return fieldPath === null
      ? { kind: error.kind, message: error.message }
      : { kind: error.kind, message: error.message, field_path: fieldPath }
  }
  return null
}

/** The Start-screen string that says why a Design could not be opened. */
export function designLoadFailureMessageKey(kind: DesignLoadFailureKind): LocaleKey {
  switch (kind) {
    case 'missing':
      return 'start.cantReadMissing'
    case 'older_version':
      return 'start.cantReadOlderVersion'
    case 'newer_version':
      return 'start.cantReadNewerVersion'
    case 'invalid_json':
    case 'invalid_document':
      return 'start.cantReadDamaged'
    case 'unreadable':
    case 'too_large':
    case 'internal':
      return 'start.cantRead'
  }
}
