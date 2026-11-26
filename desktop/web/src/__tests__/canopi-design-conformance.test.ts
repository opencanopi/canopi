import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CanopiDesignIngestionError } from '../app/contracts/canopi-design-errors'
import { flattenDocumentForJson, normalizeLoadedDocument } from '../app/contracts/document'
import {
  CANOPI_DESIGN_INGESTION_ERROR_KINDS,
  CURRENT_CANOPI_FILE_VERSION,
  FUTURE_CANOPI_FILE_VERSION_POLICY,
  MISSING_CANOPI_FILE_VERSION,
} from '../generated/canopi-design-format'
import { decodeCanopiDesign } from './support/design-wire'

interface ConformanceCase {
  readonly id: string
  readonly input: unknown
  readonly accepted?: string
  readonly error_kind?: string
  readonly error_path?: string
}

interface ConformanceCorpus {
  readonly contract_version: number
  readonly facts: {
    readonly current_version: number
    readonly missing_version: number
    readonly future_version_policy: string
    readonly error_kinds: readonly string[]
  }
  readonly accepted_documents: Readonly<Record<string, unknown>>
  readonly cases: readonly ConformanceCase[]
}

const corpus = JSON.parse(readFileSync(
  '../../canopi-types/canopi-design-conformance.json',
  'utf8',
)) as ConformanceCorpus

describe('shared Canopi Design conformance corpus', () => {
  it('matches generated compatibility facts', () => {
    expect(corpus.contract_version).toBe(1)
    expect(corpus.facts).toEqual({
      current_version: CURRENT_CANOPI_FILE_VERSION,
      missing_version: MISSING_CANOPI_FILE_VERSION,
      future_version_policy: FUTURE_CANOPI_FILE_VERSION_POLICY,
      error_kinds: CANOPI_DESIGN_INGESTION_ERROR_KINDS,
    })
  })

  it('round-trips every accepted corpus document through wire flattening and normalization', () => {
    for (const c of corpus.cases) {
      if (!c.accepted) continue
      const decoded = normalizeLoadedDocument(decodeCanopiDesign(c.input))
      const roundTripped = decodeCanopiDesign(flattenDocumentForJson(decoded))
      expect(roundTripped.version, c.id).toBe(CURRENT_CANOPI_FILE_VERSION)
      expect(roundTripped.name, c.id).toBe(decoded.name)
    }
    expect(() => decodeCanopiDesign({ version: 1 })).toThrow(CanopiDesignIngestionError)
  })
})
