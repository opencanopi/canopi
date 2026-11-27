import { describe, expect, it } from 'vitest'
import { findPlants } from '../app/plant-finder/matcher'
import { plantFinderRecord } from '../app/plant-finder/records'
import {
  buildFavoriteFinderSpecies,
  rankFavoriteSpecies,
  type FavoriteSpeciesEntry,
} from '../app/plant-finder/use-plant-finder'

const peach: FavoriteSpeciesEntry = {
  canonical_name: 'Prunus persica',
  common_name: 'Pêcher',
}

const apple: FavoriteSpeciesEntry = {
  canonical_name: 'Malus domestica',
  common_name: 'Pommier',
}

const chestnut: FavoriteSpeciesEntry = {
  canonical_name: 'Castanea sativa',
  common_name: 'Châtaignier',
}

const CATALOG_NAMES_BY_SPECIES: Readonly<Record<string, readonly string[]>> = {
  'Prunus persica': ['Peach', 'Pêcher', 'Pfirsich'],
  'Malus domestica': ['Apple', 'Pommier', 'Apfel', 'Manzano'],
  'Castanea sativa': ['Sweet chestnut', 'Châtaignier', 'Edelkastanie'],
}

const catalogNames = (canonicalName: string): readonly string[] => CATALOG_NAMES_BY_SPECIES[canonicalName] ?? []
const searchList = (list: readonly FavoriteSpeciesEntry[], query: string) => (
  rankFavoriteSpecies(
    list,
    findPlants(buildFavoriteFinderSpecies(list, undefined, catalogNames).map(plantFinderRecord), query),
  )
)

describe('favorite species list search parity (contracts §17)', () => {
  it('matches Common, Canonical, and typo/accented names in the interface language through findPlants (contracts §17)', () => {
    const list = [peach, apple, chestnut]

    expect(searchList(list, 'pecher')).toEqual([peach])
    expect(searchList(list, 'MALUS')).toEqual([apple])
    expect(searchList(list, 'Pomier')).toEqual([apple])
  })

  it('returns the same order for a typo query and a query in another locale on Web and Desktop', () => {
    const list = [peach, apple, chestnut]

    // Typo query: 1-edit typo on "Pommier" -> matches Malus domestica in the same order.
    const webTypo = searchList(list, 'Pomier')
    const desktopTypo = searchList(list, 'Pomier')
    expect(webTypo.map((item) => item.canonical_name)).toEqual(['Malus domestica'])
    expect(desktopTypo.map((item) => item.canonical_name)).toEqual(webTypo.map((item) => item.canonical_name))

    // Query in another language ("apple" in a French interface): both editions match Malus domestica.
    const webOtherLang = searchList(list, 'apple')
    const desktopOtherLang = searchList(list, 'apple')
    expect(webOtherLang.map((item) => item.canonical_name)).toEqual(['Malus domestica'])
    expect(desktopOtherLang.map((item) => item.canonical_name)).toEqual(webOtherLang.map((item) => item.canonical_name))

    // German name ("Edelkastanie") in a French interface: both editions match Castanea sativa.
    const webGerman = searchList(list, 'Edelkastanie')
    const desktopGerman = searchList(list, 'Edelkastanie')
    expect(webGerman.map((item) => item.canonical_name)).toEqual(['Castanea sativa'])
    expect(desktopGerman.map((item) => item.canonical_name)).toEqual(webGerman.map((item) => item.canonical_name))
  })
})
