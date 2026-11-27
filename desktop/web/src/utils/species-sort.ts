// utils/species-sort.ts  (pure)
//
// Shared species collation rule for Design species lists and legends across
// the Species key panel, canvas pinned-name legend, and PDF export
// (2.1-Q94, contracts §17): alphabetical by shown name, collated in the
// interface language, with the Latin canonical name breaking ties.

export interface SpeciesShownNameRow {
  readonly shownName: string
  readonly canonicalName: string
}

/**
 * Compares two species entries by their shown name in `locale`, breaking ties
 * by Latin `canonicalName` (2.1-Q94, contracts §17).
 */
export function compareSpeciesByShownName(
  left: SpeciesShownNameRow,
  right: SpeciesShownNameRow,
  locale: string,
): number {
  const collator = new Intl.Collator(locale, { sensitivity: 'base' })
  return (
    collator.compare(left.shownName, right.shownName)
    || left.canonicalName.localeCompare(right.canonicalName, 'en')
  )
}
