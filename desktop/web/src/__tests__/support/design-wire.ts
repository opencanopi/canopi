/**
 * __tests__/support/design-wire.ts: Test-only decode/encode helpers backed by the REAL
 * `canopi-format-wasm` Format Core (`canopi-f47t.52.49`, M1). Production code decodes
 * through `DesignCore` (native Rust IPC on Desktop, `design-core.worker.ts` on Web).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decode_design,
  decode_stamp_payload,
  draft_summary,
  encode_design,
  encode_stamp_payload,
  format_core_version,
  initSync,
  new_design,
} from '../../../../../canopi-format-wasm/dist/canopi_format_wasm.js'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFileV10, DraftSummaryOutcome, FormatDecodeAnswer, FormatRefusal, NewDesignInputContract, SavedObjectStampPayload } from '../../generated/contracts'
import type { DesignCore } from '../../platform/design-core'
import type { CanopiFile } from '../../types/design'
import {
  CanopiDesignIngestionError,
  ingestionErrorFromFormatRefusal,
} from '../../app/contracts/canopi-design-errors'

function asCanopiDesignIngestionError(error: unknown): CanopiDesignIngestionError {
  if (error instanceof CanopiDesignIngestionError) return error
  return new CanopiDesignIngestionError(
    'invalid_document',
    error instanceof Error ? error.message : String(error),
  )
}
import {
  flattenDocumentForJson,
  normalizeLoadedDocument,
} from '../../app/contracts/document'

export function parseCanopiJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CanopiDesignIngestionError('invalid_document', `$: invalid JSON (${error.message})`)
    }
    throw asCanopiDesignIngestionError(error)
  }
}

let wasmInitialized = false

function ensureWasm(): void {
  if (wasmInitialized) return
  const wasmPath = resolve(process.cwd(), '../../canopi-format-wasm/dist/canopi_format_wasm_bg.wasm')
  const wasmBytes = readFileSync(wasmPath)
  initSync({ module: wasmBytes })
  wasmInitialized = true
}

export {
  CanopiDesignIngestionError,
  parseCanopiJsonText as parseCanopiText,
}

export function isSavedByNewerCanopi(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const version = (value as Record<string, unknown>).version
  return typeof version === 'number' && Number.isInteger(version) && version > CURRENT_CANOPI_FILE_VERSION
}

function throwRefusal(refusal: FormatRefusal, raw: unknown): never {
  const version = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { readonly version?: unknown }).version
    : undefined
  throw ingestionErrorFromFormatRefusal(refusal, version)
}

/** Decode a `.canopi` value (v9 or v10) through the real `canopi-format-wasm` Format Core. */
export function decodeCanopiDesign(value: unknown): CanopiFile {
  ensureWasm()
  try {
    const text = JSON.stringify(value)
    const answer = JSON.parse(decode_design(text)) as FormatDecodeAnswer
    if ('ok' in answer) {
      return normalizeLoadedDocument(answer.ok.design)
    }
    throwRefusal(answer.err, value)
  } catch (error) {
    throw asCanopiDesignIngestionError(error)
  }
}

/** Encode an in-memory `CanopiFile` through the real `canopi-format-wasm` canonical v10 encoder. */
export function encodeCanopiDesign(file: CanopiFile): Record<string, unknown> {
  ensureWasm()
  const v10 = flattenDocumentForJson(file)
  const answer = JSON.parse(encode_design(JSON.stringify(v10))) as {
    readonly ok?: string
    readonly err?: FormatRefusal
  }
  if (typeof answer.ok === 'string') {
    return JSON.parse(answer.ok) as Record<string, unknown>
  }
  throwRefusal(
    answer.err ?? { kind: 'invalid_document', message: 'encode_design returned no output', field_path: null },
    v10,
  )
}

/** Real `canopi-format-wasm` `DesignCore` adapter for unit tests (no Web Worker required). */
export function createTestDesignCore(): DesignCore {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  return {
    version: async () => {
      ensureWasm()
      return format_core_version()
    },
    decode: async (bytes) => {
      ensureWasm()
      const text = decoder.decode(bytes)
      return JSON.parse(decode_design(text)) as FormatDecodeAnswer
    },
    encode: async (design) => {
      ensureWasm()
      const raw = JSON.parse(encode_design(JSON.stringify(design))) as
        | { readonly ok: string }
        | { readonly err: FormatRefusal }
      if ('ok' in raw) return { ok: encoder.encode(raw.ok) }
      return { err: raw.err }
    },
    newDesign: async (input: NewDesignInputContract) => {
      ensureWasm()
      return JSON.parse(new_design(JSON.stringify(input))) as CanopiFileV10
    },
    draftSummary: async (bytes, updatedAt) => {
      ensureWasm()
      const text = decoder.decode(bytes)
      return JSON.parse(draft_summary(text, updatedAt)) as DraftSummaryOutcome
    },
    decodeStamp: async (payloadJson) => {
      ensureWasm()
      return JSON.parse(decode_stamp_payload(payloadJson)) as { readonly ok: SavedObjectStampPayload } | { readonly err: unknown }
    },
    encodeStamp: async (payload) => {
      ensureWasm()
      return JSON.parse(encode_stamp_payload(JSON.stringify(payload))) as { readonly ok: string } | { readonly err: unknown }
    },
  }
}
