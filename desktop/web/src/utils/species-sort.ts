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

const collators = new Map<string, Intl.Collator>()

function collatorFor(locale: string): Intl.Collator {
  let collator = collators.get(locale)
  if (!collator) {
    collator = new Intl.Collator(locale, { sensitivity: 'base' })
    collators.set(locale, collator)
  }
  return collator
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
  return (
    collatorFor(locale).compare(left.shownName, right.shownName)
    || left.canonicalName.localeCompare(right.canonicalName, 'en')
  )
}
