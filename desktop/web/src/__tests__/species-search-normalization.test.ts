import { describe, expect, it } from 'vitest'
import {
  SPECIES_SEARCH_NORMALIZATION_CORPUS,
  SPECIES_SEARCH_NORMALIZATION_VERSION,
} from '../generated/species-search-normalization'
import {
  normalizeSpeciesSearch,
  speciesSearchAdmission,
  speciesSearchQueryTokens,
} from '../utils/species-search-normalization'

describe('Species Search normalization', () => {
  it('matches the authored cross-runtime corpus', () => {
    expect(SPECIES_SEARCH_NORMALIZATION_VERSION).toBe(2)

    for (const testCase of SPECIES_SEARCH_NORMALIZATION_CORPUS) {
      const normalized = normalizeSpeciesSearch(testCase.input)
      expect(normalized.text, `${testCase.name} text`).toBe(testCase.normalizedText)
      expect(normalized.tokens, `${testCase.name} tokens`).toEqual(testCase.tokens)
      expect(speciesSearchQueryTokens(testCase.input), `${testCase.name} query tokens`)
        .toEqual(testCase.queryTokens)
      expect(speciesSearchAdmission(testCase.input), `${testCase.name} admission`)
        .toBe(testCase.admission)
    }
  })

  it('admits one Han or kana character and keeps every other script at two', () => {
    for (const query of ['栗', '桃', 'か', 'カ', 'ｶ', '々', '﨎']) {
      expect(speciesSearchAdmission(query), query).toBe('active-text')
    }
    for (const query of ['É', 'Ω', 'я', 'ー', '1', '_']) {
      expect(speciesSearchAdmission(query), query).toBe('too-short')
    }
    expect(speciesSearchQueryTokens('栗 a')).toEqual(['栗'])
    expect(speciesSearchQueryTokens('a b')).toEqual(['a', 'b'])
  })
})
