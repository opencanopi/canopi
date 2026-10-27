import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { TargetedKeyboardEvent } from 'preact'
import { speciesCatalogWorkbench } from '../../app/plant-browser'
import { useEnglishFallbackNames } from '../../app/plant-finder/catalog-names'
import {
  NO_SPECIES_QUICK_FILTERS,
  useSpeciesQuickFilters,
  type SpeciesQuickFilterValue,
} from '../../app/plant-finder/quick-filters'
import { usePlantFinder } from '../../app/plant-finder/use-plant-finder'
import type { PlantFinderHit } from '../../app/plant-finder/matcher'
import { selectPanel } from '../../app/shell/state'
import {
  recentPlantStampSources,
  selectPlantStampSource,
  type PlantStampSource,
} from '../../canvas/plant-stamp-source'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { t } from '../../i18n'
import { MatchText, PlantFinder, StratumFormFilters } from '../shared/PlantFinder'
import { SpeciesCommonName } from '../shared/SpeciesIdentity'
import { clearHoveredPanelTargets, setHoveredPanelTargets } from '../../app/panel-targets/presentation'
import { speciesPlacementAppearance } from '../../canvas/runtime/species-key'
import { cachedStratum, cachedWidth } from '../../canvas/runtime/plant-presentation'
import { speciesTarget } from '../../target'
import { PlantSymbolGlyph } from './PlantSymbolGlyph'
import row from '../shared/species-row.module.css'
import { displayedPlantColor } from '../../app/plant-display/state'
import styles from './ToolCard.module.css'

type SectionId = 'design' | 'favorites' | 'recent'

interface ChooserSpecies {
  readonly source: PlantStampSource
  readonly section: SectionId
  /** The name shown: the stamp source's name, or the English catalog name for a Design species with none in the UI language. */
  readonly shownName: string | null
  readonly englishFallback: boolean
}

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  design: 'canvas.toolCard.inDesign',
  favorites: 'canvas.toolCard.favorites',
  recent: 'canvas.toolCard.recent',
}

/**
 * Place plants' compact species chooser in the tool card: the species in this
 * Design first, then Favorites, then recent picks, narrowed by the shared plant
 * finder, with the full catalog one link away. Choosing sets the plant stamp
 * source; the card then says what a click places.
 */
export function SpeciesChooser({ autoFocus, focusRequest, onChosen, onEscape }: {
  /** Focus the search field on mount (Change species). */
  readonly autoFocus: boolean
  /** Changes when the card should point the user here again (a click with no species). */
  readonly focusRequest: number
  onChosen(): void
  onEscape(): void
}) {
  const [query, setQuery] = useState('')
  const [quickFilterValue, setQuickFilterValue] = useState<SpeciesQuickFilterValue>(NO_SPECIES_QUICK_FILTERS)
  const input = useRef<HTMLInputElement | null>(null)
  const species = useChooserSpecies()
  const finder = usePlantFinder(species.map(toFinderSpecies), query)
  const canonicalNames = useMemo(() => species.map((entry) => entry.source.canonical_name), [species])
  const quickFilters = useSpeciesQuickFilters(canonicalNames, quickFilterValue)
  const listId = 'tool-card-species-options'

  useEffect(() => {
    const view = speciesCatalogWorkbench.favorites.peek()
    if (view.items.length === 0 && !view.loading) void speciesCatalogWorkbench.loadFavorites()
  }, [])
  // Focus goes in as the chooser commits, so its Esc handler hears the key from the first painted frame, not the
  // canvas's tool layer (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])
  useLayoutEffect(() => {
    if (focusRequest > 0) input.current?.focus()
  }, [focusRequest])

  function choose(entry: ChooserSpecies): void {
    selectPlantStampSource(entry.source)
    onChosen()
  }

  /** Esc anywhere in the chooser closes it, as in the stamp chooser; in the search field it first clears the query. */
  function handleKeyDown(event: TargetedKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    // An Esc inside an IME composition is the IME's (WebKit sends the key that ends one with keyCode 229).
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    event.stopPropagation()
    if (query && event.target === input.current) setQuery('')
    else onEscape()
  }

  const bySpecies = new Map(species.map((entry) => [entry.source.canonical_name, entry]))
  const allowed = quickFilters.allowed
  const matches: readonly { entry: ChooserSpecies, hit: PlantFinderHit<string> | null }[] = (finder.active
    ? finder.hits.flatMap((hit) => {
        const entry = bySpecies.get(hit.key)
        return entry ? [{ entry, hit }] : []
      })
    : species.map((entry) => ({ entry, hit: null }))
  ).filter(({ entry }) => !allowed || allowed.has(entry.source.canonical_name))

  return (
    <div className={styles.chooser} onKeyDown={handleKeyDown}>
      <PlantFinder
        value={query}
        onChange={setQuery}
        inputRef={input}
        controls={listId}
        correction={finder.correction}
        filters={species.length > 0 && <StratumFormFilters filters={quickFilters} onChange={setQuickFilterValue} />}
      />
      <div id={listId} className={styles.options}>
        {finder.active
          ? <OptionList entries={matches} onChoose={choose} />
          : (['design', 'favorites', 'recent'] as const).map((section) => {
              const entries = matches.filter(({ entry }) => entry.section === section)
              if (entries.length === 0) return null
              return (
                <section key={section} data-species-section={section} aria-label={t(SECTION_LABELS[section])}>
                  <h3 className={styles.section}>{t(SECTION_LABELS[section])}</h3>
                  <OptionList entries={entries} onChoose={choose} />
                </section>
              )
            })}
        {matches.length === 0 && (
          <p className={styles.empty}>
            {finder.active
              ? t('canvas.toolCard.noMatch', { query: query.trim() })
              : allowed ? t('plantFinder.noFilterMatches') : t('canvas.toolCard.noSpecies')}
          </p>
        )}
      </div>
      <button type="button" className={styles.catalogLink} onClick={() => selectPanel('plant-db')}>
        {t('canvas.toolCard.openCatalog')}
      </button>
    </div>
  )
}

function OptionList({ entries, onChoose }: {
  readonly entries: readonly { entry: ChooserSpecies, hit: PlantFinderHit<string> | null }[]
  onChoose(entry: ChooserSpecies): void
}) {
  const scene = currentCanvasQuerySurface.value?.getSceneSnapshot() ?? NO_SPECIES_APPEARANCE
  // A row pointed at or focused rings its species' plants with the hover stroke, never for the whole placing session.
  const ring = (entry: ChooserSpecies) => setHoveredPanelTargets([speciesTarget(entry.source.canonical_name)])
  useEffect(() => clearHoveredPanelTargets, [])
  return (
    <ul className={styles.optionList}>
      {entries.map(({ entry, hit }) => {
        const common = entry.shownName
        const canonical = entry.source.canonical_name
        const marks = (text: string) => hit?.marks.find((mark) => mark.text === text)?.ranges ?? []
        const placement = speciesPlacementAppearance(scene, { canonicalName: canonical, stratum: entry.source.stratum })
        const appearance = { ...placement, color: displayedPlantColor(placement.color, canonical) }
        return (
          <li key={canonical}>
            <button
              type="button"
              className={`${row.main} ${styles.option}`}
              data-species-option={canonical}
              onClick={() => {
                clearHoveredPanelTargets()
                onChoose(entry)
              }}
              onMouseEnter={() => ring(entry)}
              onMouseLeave={clearHoveredPanelTargets}
              onFocusIn={() => ring(entry)}
              onFocusOut={clearHoveredPanelTargets}
            >
              <span className={row.glyph} aria-hidden="true" data-species-glyph style={{ color: appearance.color }}>
                <PlantSymbolGlyph symbol={appearance.symbol} size={22} />
              </span>
              <span className={styles.optionNames}>
                {common && (
                  <span className={styles.optionName}>
                    <SpeciesCommonName name={<MatchText text={common} ranges={marks(common)} />} englishFallback={entry.englishFallback} />
                  </span>
                )}
                <i lang="la" className={styles.optionLatin}><MatchText text={canonical} ranges={marks(canonical)} /></i>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

const NO_SPECIES_APPEARANCE = { plantSpeciesSymbols: {}, plantSpeciesColors: {} }

function toFinderSpecies(entry: ChooserSpecies) {
  return { canonicalName: entry.source.canonical_name, commonName: entry.shownName }
}

/** Design species (most planted first), then Favorites, then recent picks, each species once. */
function useChooserSpecies(): readonly ChooserSpecies[] {
  const queries = currentCanvasQuerySurface.value
  const sceneRevision = queries?.revision.scene.value
  const namesRevision = queries?.revision.plantNames.value
  const favoriteItems = speciesCatalogWorkbench.favorites.value.items
  const recent = recentPlantStampSources.value
  const design = useMemo(() => designSpecies(), [queries, sceneRevision, namesRevision])
  // Favorites and recent picks with no name in the UI language take their English catalog name.
  const catalogEnglish = useEnglishFallbackNames(useMemo(() => [
    ...favoriteItems.map((item) => ({ canonicalName: item.canonical_name, commonName: item.common_name })),
    ...recent.map((source) => ({ canonicalName: source.canonical_name, commonName: source.common_name })),
  ], [favoriteItems, recent]))
  return useMemo(() => {
    const seen = new Set<string>()
    const entries: ChooserSpecies[] = []
    const add = (source: PlantStampSource, section: SectionId, englishName?: string) => {
      if (seen.has(source.canonical_name)) return
      seen.add(source.canonical_name)
      entries.push({ source, section, shownName: englishName ?? source.common_name, englishFallback: Boolean(englishName) })
    }
    const catalogFallback = (source: PlantStampSource) => (
      source.common_name ? undefined : catalogEnglish.get(source.canonical_name)
    )
    for (const { source, englishName } of design) add(source, 'design', englishName)
    for (const item of favoriteItems) {
      const source = {
        canonical_name: item.canonical_name,
        common_name: item.common_name,
        stratum: item.stratum,
        width_max_m: item.width_max_m,
      }
      add(source, 'favorites', catalogFallback(source))
    }
    for (const source of recent) add(source, 'recent', catalogFallback(source))
    return entries
  }, [catalogEnglish, design, favoriteItems, recent])
}

function designSpecies(): readonly { source: PlantStampSource, englishName?: string }[] {
  const queries = currentCanvasQuerySurface.peek()
  if (!queries) return []
  const names = queries.getLocalizedCommonNames()
  const englishNames = queries.getEnglishFallbackNames()
  const speciesCache = queries.getSpeciesCache()
  const bySpecies = new Map<string, { source: PlantStampSource, englishName?: string, count: number }>()
  for (const plant of queries.getSceneSnapshot().plants) {
    const current = bySpecies.get(plant.canonicalName)
    if (current) {
      current.count += 1
      continue
    }
    const localized = names.get(plant.canonicalName)
    bySpecies.set(plant.canonicalName, {
      count: 1,
      ...!localized && englishNames.has(plant.canonicalName) ? { englishName: englishNames.get(plant.canonicalName)! } : {},
      source: {
        canonical_name: plant.canonicalName,
        common_name: localized ?? plant.commonName,
        stratum: cachedStratum(speciesCache, plant.canonicalName),
        // The width the catalog gave when the species was placed, else the cached catalog width.
        width_max_m: plant.canopySpreadM ?? cachedWidth(speciesCache, plant.canonicalName),
      },
    })
  }
  const shown = (entry: { source: PlantStampSource, englishName?: string }) => (
    entry.englishName ?? entry.source.common_name ?? entry.source.canonical_name
  )
  return [...bySpecies.values()]
    .sort((left, right) => right.count - left.count || shown(left).localeCompare(shown(right)))
    .map(({ source, englishName }) => ({ source, englishName }))
}
