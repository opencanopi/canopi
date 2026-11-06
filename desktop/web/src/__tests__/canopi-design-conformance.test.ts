import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CanopiDesignIngestionError,
  decodeCanopiDesign,
} from '../app/contracts/design-ingestion'
import { encodeCanopiDesign } from '../app/contracts/canopi-design-wire'
import {
  CANOPI_DESIGN_INGESTION_ERROR_KINDS,
  CURRENT_CANOPI_FILE_VERSION,
  FUTURE_CANOPI_FILE_VERSION_POLICY,
  MISSING_CANOPI_FILE_VERSION,
} from '../generated/canopi-design-format'

interface ConformanceCase {
  readonly id: string
  readonly input: unknown
  readonly accepted?: string
  readonly error_kind?: string
  /** Where the refusal points: the message's path before its first ": ". */
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

  it.each(corpus.cases)('$id', ({ accepted, error_kind: errorKind, error_path: errorPath, input }) => {
    if (accepted) {
      const expected = corpus.accepted_documents[accepted]
      const decoded = decodeCanopiDesign(input)
      expect(decoded).toEqual(expected)
      expect(decodeCanopiDesign(encodeCanopiDesign(decoded))).toEqual(expected)
      return
    }

    try {
      decodeCanopiDesign(input)
      expect.fail('expected Canopi Design ingestion to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(CanopiDesignIngestionError)
      expect((error as CanopiDesignIngestionError).kind).toBe(errorKind)
      expect(errorPath, 'every refusal case names its path').toBeDefined()
      expect(pathOf((error as CanopiDesignIngestionError).message)).toBe(errorPath)
    }
  })
})

/** The path a refusal message starts with ("$.plants[1].id: duplicate id" gives "$.plants[1].id"). */
function pathOf(message: string): string {
  const end = message.indexOf(': ')
  return end === -1 ? message : message.slice(0, end)
}
