import type { ComponentChildren } from 'preact'
import { isLocaleKey, t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { speciesCatalogWorkbench } from '../../app/plant-browser'
import {
  writePlantStampDragData,
} from '../../canvas/plant-stamp-source'
import type { SpeciesListItem } from '../../types/species'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { ControlIcon } from '../shared/ControlIcon'
import { SpeciesCommonName } from '../shared/SpeciesIdentity'
import row from '../shared/species-row.module.css'
import { secondaryCommonNameForDisplay } from './common-name-display'
import type { CatalogDesignSpecies } from './design-species'
import { catalogHabitSymbol } from './habit-symbol'
import styles from './PlantDb.module.css'
import { placeSpeciesOnMap } from './place-species'

interface Props {
  plant: SpeciesListItem
  /** The species' plants in the open Design, when it has some: glyph, colour and code. */
  inDesign?: CatalogDesignSpecies
  /** The English catalog name, shown marked "(en)" when the species has none in the interface language. */
  englishName?: string
  /** Renders a name with the search matches marked. */
  highlight?: (text: string) => ComponentChildren
}

/**
 * One catalog species row: glyph · common name over italic scientific name over a quiet
 * facts line · code when the species is in this Design · Place · favourite star. The row
 * body opens details and drags onto the map.
 */
export function PlantRow({ plant, inDesign, englishName, highlight }: Props) {
  const show = highlight ?? ((text: string) => text)
  const english = plant.common_name ? undefined : englishName
  const commonName = plant.common_name || english
  const name = commonName || plant.canonical_name
  const showMatchedCommonName = speciesCatalogWorkbench.isActiveSearchText(speciesCatalogWorkbench.intent.value.text)
  const matchedName = showMatchedCommonName ? secondaryCommonNameForDisplay(plant, true) : null
  const facts = catalogFacts(plant, locale.value)

  const handleDragStart = (e: DragEvent) => {
    writePlantStampDragData(e.dataTransfer, plant)

    const preview = document.createElement('div')
    preview.textContent = name
    Object.assign(preview.style, {
      position: 'absolute', top: '-1000px', left: '-1000px',
      padding: '3px 8px', background: 'var(--color-accent, #A06B1F)',
      color: '#fff', fontSize: '11px', fontFamily: 'Inter, sans-serif',
      borderRadius: '3px', whiteSpace: 'nowrap', pointerEvents: 'none',
    })
    document.body.appendChild(preview)
    e.dataTransfer?.setDragImage?.(preview, -12, -12)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => preview.remove())
    else preview.remove()
  }

  return (
    <div
      className={`${row.row} ${styles.catalogRow}`}
      role="listitem"
      draggable={true}
      onDragStart={handleDragStart}
      data-testid="catalog-species-row"
    >
      <button
        type="button"
        className={`${row.main} ${styles.catalogRowMain}`}
        aria-label={t('plantDb.details', { name })}
        data-species-detail={plant.canonical_name}
        onClick={() => speciesCatalogWorkbench.selectSpecies(plant.canonical_name)}
      >
        <span className={`${row.glyph} ${inDesign ? '' : styles.catalogGlyph}`} style={inDesign ? { color: inDesign.color } : undefined} aria-hidden="true">
          <PlantSymbolGlyph symbol={inDesign?.symbol ?? catalogHabitSymbol(plant.habit)} size={22} />
        </span>
        <span className={styles.rowNames}>
          <strong className={plant.is_name_fallback && !commonName ? styles.nameFallback : undefined}>
            {english ? <SpeciesCommonName name={show(english)} englishFallback /> : show(name)}
            {matchedName && <span className={styles.matchedName}> · {show(matchedName)}</span>}
          </strong>
          {name !== plant.canonical_name && <em lang="la">{show(plant.canonical_name)}</em>}
          {facts && <span className={styles.facts}>{facts}</span>}
        </span>
        <span className={row.code}>{inDesign?.code ?? ''}</span>
      </button>
      <button
        type="button"
        className={styles.placeBtn}
        onClick={() => placeSpeciesOnMap(plant)}
        aria-label={t('plantDb.placeSpecies', { name })}
      >
        {t('plantDb.place')}
      </button>
      <button
        type="button"
        className={`${styles.favBtn} ${plant.is_favorite ? styles.favBtnActive : ''}`}
        onClick={() => { void speciesCatalogWorkbench.toggleFavorite(plant.canonical_name) }}
        aria-label={plant.is_favorite
          ? t('plantDb.removeFavoriteNamed', { name })
          : t('plantDb.addFavoriteNamed', { name })}
        aria-pressed={plant.is_favorite}
      >
        <ControlIcon name={plant.is_favorite ? 'star' : 'star-outline'} />
      </button>
    </div>
  )
}

/** "Tree · 8 m · USDA 5–9 · Edible 4/5": form, height, hardiness and edibility when known. */
function catalogFacts(plant: SpeciesListItem, currentLocale: string): string {
  const facts: string[] = []
  if (plant.habit) {
    const key = `filters.habit_${plant.habit}`
    facts.push(isLocaleKey(key) ? t(key) : plant.habit)
  }
  if (plant.height_max_m !== null) {
    const height = new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 1 }).format(plant.height_max_m)
    facts.push(t('plantDb.factHeight', { height }))
  }
  const min = plant.hardiness_zone_min
  const max = plant.hardiness_zone_max
  if (min !== null) {
    facts.push(t('plantDb.factHardiness', { zones: max !== null && max !== min ? `${min}–${max}` : `${min}` }))
  }
  if (plant.edibility_rating !== null && plant.edibility_rating > 0) {
    facts.push(t('plantDb.factEdible', { rating: plant.edibility_rating }))
  }
  return facts.join(' · ')
}
