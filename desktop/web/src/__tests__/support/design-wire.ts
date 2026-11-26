/**
 * __tests__/support/design-wire.ts: Test-only decode/encode helpers after deleting
 * the 4 TS format mirrors (`canopi-f47t.52.49`). Production code decodes through
 * `DesignCore` (native Rust on Desktop, `canopi-format-wasm` worker on Web).
 */
import {
  CURRENT_CANOPI_FILE_VERSION,
  MISSING_CANOPI_FILE_VERSION,
} from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import {
  asCanopiDesignIngestionError,
  CanopiDesignIngestionError,
} from '../../app/contracts/canopi-design-errors'
import {
  flattenDocumentForJson,
  isCurrentCanopiDocument,
  isSavedByNewerCanopi,
  normalizeLoadedDocument,
  parseCanopiJsonText,
} from '../../app/contracts/document'

export {
  CanopiDesignIngestionError,
  flattenDocumentForJson as encodeCanopiDesign,
  isSavedByNewerCanopi,
  parseCanopiJsonText as parseCanopiText,
}

export function decodeCanopiDesign(value: unknown): CanopiFile {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new CanopiDesignIngestionError('invalid_document', '$: expected a Canopi Design object')
    }
    const record = value as Record<string, unknown>
    const version = Object.prototype.hasOwnProperty.call(record, 'version')
      ? record.version
      : MISSING_CANOPI_FILE_VERSION
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new CanopiDesignIngestionError('invalid_version', '$.version: expected a positive integer')
    }
    if (version !== CURRENT_CANOPI_FILE_VERSION) {
      throw new CanopiDesignIngestionError(
        'unsupported_version',
        `$.version: unsupported Canopi Design version ${version}; Canopi 2.0 and later open only version ${CURRENT_CANOPI_FILE_VERSION}`,
        version,
      )
    }
    if (Object.prototype.hasOwnProperty.call(record, 'extra')) {
      throw new CanopiDesignIngestionError(
        'invalid_document',
        '$.extra: unknown fields belong at the document root',
      )
    }
    if (!isCurrentCanopiDocument(record)) {
      throw new CanopiDesignIngestionError('invalid_document', '$: expected a valid Canopi Design')
    }
    return normalizeLoadedDocument(record)
  } catch (error) {
    throw asCanopiDesignIngestionError(error)
  }
}
