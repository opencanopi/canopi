import {
  CANOPI_FILE_SCHEMA,
  CURRENT_CANOPI_FILE_VERSION,
  MISSING_CANOPI_FILE_VERSION,
} from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import { mapViewProblem, viewsAndStoriesProblem } from './views-admission'
import { normalizeLoadedDocument } from './document'
import { decodeCanopiFileSchema } from './canopi-design-schema-decoder'
import { asCanopiDesignIngestionError, CanopiDesignIngestionError } from './canopi-design-errors'
import { designIdentitiesAndRangesProblem } from './design-admission'

export { CanopiDesignIngestionError }

/**
 * Admit a Design: the Web mirror of `decode_design_value`. Canopi 2.0 breaks
 * stored data (ADR 0021): there is no migration ladder, and any version other
 * than the current one is refused as `unsupported_version`; Open reads a newer
 * one read-only instead (`isSavedByNewerCanopi`).
 */
export function decodeCanopiDesign(value: unknown): CanopiFile {
  try {
    const version = admitDesignVersion(value)
    if (version !== CURRENT_CANOPI_FILE_VERSION) {
      throw new CanopiDesignIngestionError(
        'unsupported_version',
        `$.version: unsupported Canopi Design version ${version}; Canopi 2.0 and later open only version ${CURRENT_CANOPI_FILE_VERSION}`,
        version,
      )
    }
    return admitCurrentDesignValue(value as Record<string, unknown>)
  } catch (error) {
    throw asCanopiDesignIngestionError(error)
  }
}

/** The value a picked `.canopi` file's text holds; text that is no JSON is a damaged Design, as any refused one. */
export function parseCanopiText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw asCanopiDesignIngestionError(error)
  }
}

/**
 * Whether a `.canopi` value was saved by a newer Canopi: its root `version` an integer above this build's. Such a
 * Design opens read-only through the format core's read view (2.1-M478), never through `decodeCanopiDesign`, which
 * refuses it as it refuses it for a stamp or template import. The mirror of `canopi_format::read::saved_by_newer`.
 */
export function isSavedByNewerCanopi(value: unknown): boolean {
  if (!isRecord(value)) return false
  const version = value.version
  return typeof version === 'number' && Number.isInteger(version) && version > CURRENT_CANOPI_FILE_VERSION
}

function admitDesignVersion(value: unknown): number {
  if (!isRecord(value)) throw new Error('$: expected a Canopi Design object')

  const version = Object.prototype.hasOwnProperty.call(value, 'version')
    ? value.version
    : MISSING_CANOPI_FILE_VERSION
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new CanopiDesignIngestionError(
      'invalid_version',
      '$.version: expected a positive integer',
    )
  }
  return version
}

/** Current-format admission. */
function admitCurrentDesignValue(value: Record<string, unknown>): CanopiFile {
  // Unknown fields travel at the root; `extra` is only the in-memory holder
  // and the canonical encoder never writes it, so a root `extra` is refused.
  if (Object.prototype.hasOwnProperty.call(value, 'extra')) {
    throw new CanopiDesignIngestionError(
      'invalid_document',
      '$.extra: unknown fields belong at the document root',
    )
  }
  const decoded = normalizeLoadedDocument(decodeCanopiFileSchema(value, CANOPI_FILE_SCHEMA) as CanopiFile)
  const problem = designIdentitiesAndRangesProblem(decoded)
    ?? viewsAndStoriesProblem(decoded.views ?? [], decoded.stories ?? [])
    ?? mapViewProblem(decoded.map_view)
  if (problem) throw new CanopiDesignIngestionError('invalid_document', problem)
  return decoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
