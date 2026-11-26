/**
 * __tests__/support/design-wire.ts: Test-only decode/encode helpers backed by the REAL
 * `canopi-format-wasm` Format Core (`canopi-f47t.52.49`, M1). Production code decodes
 * through `DesignCore` (native Rust IPC on Desktop, `design-core.worker.ts` on Web).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decode_design,
  encode_design,
  initSync,
} from '../../../../../canopi-format-wasm/dist/canopi_format_wasm.js'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { FormatDecodeAnswer, FormatRefusal } from '../../generated/contracts'
import type { CanopiFile } from '../../types/design'
import {
  asCanopiDesignIngestionError,
  CanopiDesignIngestionError,
} from '../../app/contracts/canopi-design-errors'
import {
  isSavedByNewerCanopi,
  parseCanopiJsonText,
  sessionCanopiFileToV10,
  v10ToSessionCanopiFile,
} from '../../app/contracts/document'

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
  isSavedByNewerCanopi,
  parseCanopiJsonText as parseCanopiText,
}

function throwRefusal(refusal: FormatRefusal, raw: unknown): never {
  const version = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { readonly version?: unknown }).version
    : undefined
  if (refusal.kind === 'older_version') {
    throw new CanopiDesignIngestionError(
      'unsupported_version',
      refusal.message,
      typeof version === 'number' ? version : CURRENT_CANOPI_FILE_VERSION - 1,
      'older_version',
      refusal.field_path ?? '$.version',
    )
  }
  if (refusal.kind === 'newer_version') {
    throw new CanopiDesignIngestionError(
      'unsupported_version',
      refusal.message,
      typeof version === 'number' ? version : CURRENT_CANOPI_FILE_VERSION + 1,
      'newer_version',
      refusal.field_path ?? '$.version',
    )
  }
  const kind = refusal.field_path === '$.version' ? 'invalid_version' : 'invalid_document'
  const loadKind = refusal.kind === 'too_large'
    ? 'too_large'
    : refusal.kind === 'invalid_json'
      ? 'invalid_json'
      : 'invalid_document'
  throw new CanopiDesignIngestionError(kind, refusal.message, null, loadKind, refusal.field_path ?? null)
}

/** Decode a `.canopi` value (v9 or v10) through the real `canopi-format-wasm` Format Core. */
export function decodeCanopiDesign(value: unknown): CanopiFile {
  ensureWasm()
  try {
    const text = JSON.stringify(value)
    const answer = JSON.parse(decode_design(text)) as FormatDecodeAnswer
    if ('ok' in answer) {
      return v10ToSessionCanopiFile(answer.ok.design)
    }
    throwRefusal(answer.err, value)
  } catch (error) {
    throw asCanopiDesignIngestionError(error)
  }
}

/** Encode an in-memory `CanopiFile` through the real `canopi-format-wasm` canonical v10 encoder. */
export function encodeCanopiDesign(file: CanopiFile): Record<string, unknown> {
  ensureWasm()
  const v10 = sessionCanopiFileToV10(file)
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
