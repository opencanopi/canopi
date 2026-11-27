import { describe, expect, it } from 'vitest'
import { findPlants, type PlantFinderName } from '../app/plant-finder/matcher'

interface FavoriteSpeciesStub {
  readonly canonical_name: string
  readonly common_name: string | null
}

const peach: FavoriteSpeciesStub = {
  canonical_name: 'Prunus persica',
  common_name: 'Pêcher',
}

const apple: FavoriteSpeciesStub = {
  canonical_name: 'Malus domestica',
  common_name: 'Pommier',
}

const chestnut: FavoriteSpeciesStub = {
  canonical_name: 'Castanea sativa',
  common_name: 'Châtaignier',
}

function rankFavorites(items: readonly FavoriteSpeciesStub[], query: string): readonly FavoriteSpeciesStub[] {
  const records = items.map((item) => {
    const names: PlantFinderName[] = []
    if (item.common_name) names.push({ text: item.common_name, kind: 'common' })
    names.push({ text: item.canonical_name, kind: 'scientific' })
    return { key: item, names }
  })
  const result = findPlants(records, query)
  return result.active ? result.hits.map((hit) => hit.key) : items
}

describe('favorite species list search parity (contracts §17)', () => {
  it('matches accented common names and scientific names through findPlants', () => {
    expect(rankFavorites([peach, apple], 'pecher')).toEqual([peach])
    expect(rankFavorites([peach, apple], 'MALUS')).toEqual([apple])
  })

  it('returns the same order for a typo query and a query in another locale on Web and Desktop', () => {
    const list = [peach, apple, chestnut]
    // Typo query: 1-edit typo on "Pommier" -> matches Malus domestica.
    expect(rankFavorites(list, 'Pomier').map((item) => item.canonical_name)).toEqual(['Malus domestica'])
    // Another locale / accented query: "chataignier" matches Castanea sativa.
    expect(rankFavorites(list, 'chataignier').map((item) => item.canonical_name)).toEqual(['Castanea sativa'])
  })
})
