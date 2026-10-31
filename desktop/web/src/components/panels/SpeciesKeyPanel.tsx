import type { ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  currentCanvasPlantPresentationCommandSurface,
  currentCanvasQuerySurface,
  currentCanvasSceneEditCommandSurface,
  currentCanvasSpeciesFocusCommands,
} from '../../canvas/session'
import { buildSpeciesKey, type SpeciesKeyEntry } from '../../canvas/runtime/species-key'
import { DEFAULT_PLANT_SYMBOL_ID } from '../../canvas/runtime/scene'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { formatCount } from '../../utils/format-count'
import { speciesCatalogWorkbench } from '../../app/plant-browser'
import { navigateTo } from '../../app/shell/state'
import { usePlanningViewState } from '../../app/planning-view/state'
import { findPlants, type PlantFinderResult } from '../../app/plant-finder/matcher'
import { plantFinderRecord } from '../../app/plant-finder/records'
import { useMapSelectionSpecies } from '../../app/plant-finder/selection'
import { useSpeciesQuickFilters } from '../../app/plant-finder/quick-filters'
import { usePlantFinder } from '../../app/plant-finder/use-plant-finder'
import {
  clearPlantFinderMatchesOnMap,
  showPlantFinderMatchesOnMap,
} from '../../app/plant-finder/map-matches'
import type { SpeciesListItem } from '../../types/species'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import { DockPanelHeader } from '../shared/DockPanelHeader'
import { EmptyState } from '../shared/EmptyState'
import { PanelIcon } from '../shared/PanelIcon'
import { PlantFinder, StratumFormFilters, finderHighlight, finderSummary } from '../shared/PlantFinder'
import { SegmentedControl } from '../shared/SegmentedControl'
import { Switch } from '../shared/Switch'
import { Slider } from '../shared/Slider'
import {
  PLANT_SYMBOL_SCALE_MAX,
  PLANT_SYMBOL_SCALE_MIN,
  STRATUM_COLOR_KEYS,
  stratumDisplayColor,
  type PlantColorMode,
  type PlantDisplay,
  type PlantLabelMode,
} from '../../canvas/runtime/plant-display'
import {
  resetStratumDisplayColors,
  setPlantDisplayOptions,
  setPlantLabels,
  setStratumDisplayColor,
} from '../../app/plant-display/actions'
import { plantLabelCoverage, zoomInForPlantLabels } from '../../app/plant-display/coverage'
import { currentPlantDisplay, displayedPlantColor } from '../../app/plant-display/state'
import { setSoftenBackground } from '../../app/map-layers/actions'
import { mapLayers } from '../../app/map-layers/state'
import { currentDesign } from '../../app/document-session/store'
import { SpeciesIdentity } from '../shared/SpeciesIdentity'
import row from '../shared/species-row.module.css'
import styles from './SpeciesKeyPanel.module.css'

const CLOSE_MATCH_LIMIT = 4
const CLOSE_MATCH_DEBOUNCE_MS = 250

/** "Plants in this Design": the Design's species, found, highlighted and recoloured. */
export function SpeciesKeyPanel({ renderDetail }: { renderDetail?: (canonicalName: string) => ComponentChildren }) {
  const [openedDetail, setOpenedDetail] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const wasShowingDetail = useRef(false)
  const selected = speciesCatalogWorkbench.selectedCanonicalName.value
  const showingDetail = Boolean(selected && selected === openedDetail && renderDetail)
  useLayoutEffect(() => {
    if (wasShowingDetail.current && !showingDetail) {
      const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-species-detail]') ?? []
      Array.from(buttons).find(button => button.dataset.speciesDetail === openedDetail)?.focus()
    }
    wasShowingDetail.current = showingDetail
  }, [showingDetail, openedDetail])
  return (
    <section ref={panelRef} className={styles.panel} aria-label={t('speciesKey.title')}>
      {showingDetail
        ? renderDetail!(selected!)
        : <PlantsInDesign renderDetail={renderDetail} onOpenDetail={(canonicalName) => {
          setOpenedDetail(canonicalName)
          speciesCatalogWorkbench.selectSpecies(canonicalName)
        }} />}
    </section>
  )
}

function PlantsInDesign({ renderDetail, onOpenDetail }: {
  renderDetail?: (canonicalName: string) => ComponentChildren
  onOpenDetail(canonicalName: string): void
}) {
  const view = usePlanningViewState()
  const query = view.plantsSearch.value
  const selectedOnMap = view.plantsSelectedOnMap.value
  const quickFilterValue = view.plantsQuickFilters.value
  const queries = currentCanvasQuerySurface.value
  const revision = queries?.revision.scene.value
  const namesRevision = queries?.revision.plantNames.value
  const entries = useMemo(
    () => queries
      ? buildSpeciesKey(
        queries.getSceneSnapshot(),
        queries.getSpeciesCache(),
        queries.getLocalizedCommonNames(),
        queries.getEnglishFallbackNames(),
      )
      : [],
    [queries, revision, namesRevision],
  )
  const finderSpecies = useMemo(() => entries.map((entry) => ({
    canonicalName: entry.canonicalName,
    commonName: entry.commonName,
    code: entry.code,
  })), [entries])
  const result = usePlantFinder(finderSpecies, query)
  const canonicalNames = useMemo(() => entries.map((entry) => entry.canonicalName), [entries])
  const quickFilters = useSpeciesQuickFilters(canonicalNames, quickFilterValue)
  const mapSelection = useMapSelectionSpecies()
  const focus = queries?.getSpeciesFocus()
  const visible = useMemo(() => {
    const shown = entries.filter((entry) => (
      (!selectedOnMap || mapSelection.plantCountBySpecies.has(entry.canonicalName))
      && (!quickFilters.allowed || quickFilters.allowed.has(entry.canonicalName))
      && (!result.active || result.byKey.has(entry.canonicalName))
    ))
    if (!result.active) return shown
    const rank = new Map(result.hits.map((hit, index) => [hit.key, index]))
    return shown.sort((left, right) => rank.get(left.canonicalName)! - rank.get(right.canonicalName)!)
  }, [entries, mapSelection, quickFilters, result, selectedOnMap])
  const totalPlants = entries.reduce((total, entry) => total + entry.count, 0)
  const visiblePlants = visible.reduce((total, entry) => total + (
    selectedOnMap ? mapSelection.plantCountBySpecies.get(entry.canonicalName) ?? 0 : entry.count
  ), 0)
  const matchKey = result.active ? visible.map((entry) => entry.canonicalName).join('\n') : ''

  useEffect(() => {
    if (matchKey) showPlantFinderMatchesOnMap(query.trim(), matchKey.split('\n'))
    else clearPlantFinderMatchesOnMap()
  }, [matchKey, query])
  useEffect(() => clearPlantFinderMatchesOnMap, [])

  if (entries.length === 0) {
    return <>
      <DockPanelHeader title={t('speciesKey.title')} />
      <EmptyState icon={<PanelIcon panel="species-key" />} action={{ label: t('speciesKey.openCatalog'), onClick: () => navigateTo('plant-db') }}>
        {t('speciesKey.empty')}
      </EmptyState>
    </>
  }

  const filtered = result.active || selectedOnMap || quickFilters.allowed !== null
  return <>
    <DockPanelHeader title={t('speciesKey.title')} />
    <p className={styles.subtitle}>{t('speciesKey.subtitle', {
      plants: t('plantFinder.plants', { count: totalPlants }),
      species: t('plantFinder.species', { count: entries.length }),
    })}</p>
    <div className={styles.controls}>
      <DisplayOnMap />
      <PlantFinder
        value={query}
        onChange={(value) => { view.plantsSearch.value = value }}
        correction={result.correction}
        selectedOnMap={{
          pressed: selectedOnMap,
          plantCount: mapSelection.plantCount,
          onChange: (pressed) => { view.plantsSelectedOnMap.value = pressed },
        }}
        filters={<StratumFormFilters filters={quickFilters} onChange={(value) => { view.plantsQuickFilters.value = value }} />}
        summary={filtered ? finderSummary(visible.length, visiblePlants, selectedOnMap) : undefined}
      />
    </div>
    <div className={styles.scroll}>
      {visible.length > 0 && <ul className={styles.list} aria-label={t('speciesKey.title')}>
        {visible.map((entry) => (
          <SpeciesRow
            key={entry.canonicalName}
            entry={entry}
            result={result}
            focused={focus?.canonicalName === entry.canonicalName}
            detail={Boolean(renderDetail)}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </ul>}
      {visible.length === 0 && (
        <EmptyState
          status
          action={!query.trim() && quickFilters.allowed !== null && !(selectedOnMap && mapSelection.plantCount === 0)
            ? { label: t('plantDb.clearFilters'), onClick: () => { view.plantsQuickFilters.value = { stratum: null, form: null } } }
            : undefined}
        >
          {selectedOnMap && mapSelection.plantCount === 0
            ? t('plantFinder.noneSelected')
            : query.trim()
              ? t('plantFinder.noMatches', { query: query.trim() })
              : t('plantFinder.noFilterMatches')}
        </EmptyState>
      )}
      {result.active && (
        <CatalogCloseMatches
          query={result.correction ?? query.trim()}
          inDesign={entries}
        />
      )}
      {!filtered && <p className={styles.hint}>{t('plantFinder.searchHint')}</p>}
    </div>
  </>
}

function DisplayOnMap() {
  const view = usePlanningViewState()
  const open = view.plantsDisplayOpen.value
  const bodyId = useId()
  const display = currentPlantDisplay.value
  const hasDesign = currentDesign.value !== null
  const sizePercent = Math.round(display.symbolScale * 100)
  const hint = display.colorBy === 'stratum'
    ? t('speciesKey.stratumHint')
    : display.colorBy === 'one-color' ? t('speciesKey.oneColorHint') : t('speciesKey.swatchHint')
  return (
    <section className={styles.display}>
      <button
        type="button"
        className={styles.displayToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => { view.plantsDisplayOpen.value = !open }}
      >
        {t('speciesKey.displayOnMap')}
        <ControlIcon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      {open && (
        <div id={bodyId} className={styles.displayBody}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('speciesKey.colorBy')}</span>
            <SegmentedControl<PlantColorMode>
              label={t('speciesKey.colorBy')}
              options={[
                { value: 'species', label: t('speciesKey.colorBySpecies'), disabled: !hasDesign },
                { value: 'stratum', label: t('speciesKey.colorByStratum'), disabled: !hasDesign },
                { value: 'one-color', label: t('speciesKey.colorByOneColor'), disabled: !hasDesign },
              ]}
              value={display.colorBy}
              onChange={(colorBy) => setPlantDisplayOptions({ colorBy })}
            />
          </div>
          {display.colorBy === 'one-color' && (
            <label className={styles.inlineField}>
              <span>{t('speciesKey.oneColor')}</span>
              <input
                type="color"
                className={styles.swatch}
                value={display.oneColor.toLowerCase()}
                aria-label={t('speciesKey.oneColorLabel')}
                onInput={(event) => setPlantDisplayOptions({ oneColor: event.currentTarget.value })}
              />
            </label>
          )}
          {display.colorBy === 'stratum' && <StratumLegend display={display} />}
          <Slider
            label={t('speciesKey.symbolSize')}
            min={PLANT_SYMBOL_SCALE_MIN * 100}
            max={PLANT_SYMBOL_SCALE_MAX * 100}
            step={10}
            value={sizePercent}
            disabled={!hasDesign}
            format={formatPercent}
            onInput={(percent) => setPlantDisplayOptions({ symbolScale: percent / 100 })}
          />
          <Switch
            label={t('speciesKey.outline')}
            checked={display.outline}
            disabled={!hasDesign}
            onChange={(outline) => setPlantDisplayOptions({ outline })}
          />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('speciesKey.labels')}</span>
            <SegmentedControl<PlantLabelMode>
              label={t('speciesKey.labels')}
              options={[
                { value: 'none', label: t('speciesKey.labelsNone'), disabled: !hasDesign },
                { value: 'codes', label: t('speciesKey.labelsCodes'), disabled: !hasDesign },
                { value: 'names', label: t('speciesKey.labelsNames'), disabled: !hasDesign },
              ]}
              value={display.labels}
              onChange={setPlantLabels}
            />
            <PlantLabelCoverageLine />
          </div>
          <Switch
            label={t('speciesKey.softenBackground')}
            hint={t('speciesKey.softenBackgroundHint')}
            checked={mapLayers.value.softenBackground}
            onChange={setSoftenBackground}
          />
          <p className={styles.hint}>{hint}</p>
        </div>
      )}
    </section>
  )
}

function formatPercent(percent: number): string {
  return new Intl.NumberFormat(locale.value, { style: 'percent' }).format(percent / 100)
}

/**
 * The stratum colours, so Colour by stratum reads without the Consortium
 * panel. A swatch recolours its whole stratum for this Design's display.
 */
function StratumLegend({ display }: { readonly display: PlantDisplay }) {
  const recoloured = Object.keys(display.stratumColors).length > 0
  return (
    <div className={styles.legendBlock}>
      <ul className={styles.legend} aria-label={t('speciesKey.stratumLegend')}>
        {STRATUM_COLOR_KEYS.map((key) => {
          const label = key === 'none' ? t('speciesKey.noStratumYet') : t(`filters.stratum_${key}`)
          return (
            <li key={key}>
              <label className={styles.legendEntry}>
                <input
                  type="color"
                  className={`${styles.swatch} ${styles.legendSwatch}`}
                  value={stratumDisplayColor(key, display).toLowerCase()}
                  aria-label={t('speciesKey.stratumColorOf', { stratum: label })}
                  onInput={(event) => setStratumDisplayColor(key, event.currentTarget.value)}
                />
                {label}
              </label>
            </li>
          )
        })}
      </ul>
      {recoloured && (
        <button type="button" className={styles.linkButton} onClick={resetStratumDisplayColors}>
          {t('speciesKey.resetStratumColors')}
        </button>
      )}
    </div>
  )
}

/**
 * "Codes shown for 70 of 282 plants in view", with "Zoom in to see codes"
 * when none shows at this zoom: follows the camera, so it re-renders alone.
 */
function PlantLabelCoverageLine() {
  const coverage = plantLabelCoverage()
  if (!coverage) return null
  return (
    <p className={styles.hint}>
      <span role="status">{coverage.text}</span>
      {coverage.zoomIn && <>
        {' · '}
        <button type="button" className={styles.inlineLink} onClick={zoomInForPlantLabels}>{coverage.zoomIn}</button>
      </>}
    </p>
  )
}

function SpeciesRow({ entry, result, focused, detail, onOpenDetail }: {
  entry: SpeciesKeyEntry
  result: PlantFinderResult<string>
  focused: boolean
  detail: boolean
  onOpenDetail(canonicalName: string): void
}) {
  const name = entry.commonName || entry.canonicalName
  const color = entry.appearances[0]?.color
  // The swatch sets the stored species colour, so it shows only while the map colours by species.
  const bySpecies = currentPlantDisplay.value.colorBy === 'species'
  return (
    <li className={row.row} data-selected={focused}>
      {/* While searching, Select takes the swatch's room (FindPlants board). */}
      {bySpecies && !result.active && color && /^#[0-9a-f]{6}$/i.test(color) && (
        <input
          type="color"
          className={styles.swatch}
          value={color}
          aria-label={t('speciesKey.colorOf', { name })}
          onInput={(event) => {
            currentCanvasPlantPresentationCommandSurface.value?.setPlantColorForSpecies(entry.canonicalName, event.currentTarget.value)
          }}
        />
      )}
      <button
        type="button"
        className={row.main}
        aria-pressed={focused}
        onClick={() => currentCanvasSpeciesFocusCommands.value?.focus(focused ? null : entry.canonicalName)}
      >
        <span className={row.srOnly}>{t('speciesKey.highlight')} </span>
        <span className={row.glyph} aria-hidden="true">
          {entry.appearances.slice(0, 1).map((appearance) => (
            <span key={appearance.color + appearance.symbol} style={{ color: displayedPlantColor(appearance.color, entry.canonicalName) }}>
              <PlantSymbolGlyph symbol={appearance.symbol} size={22} />
            </span>
          ))}
        </span>
        <SpeciesIdentity
          commonName={entry.commonName}
          canonicalName={entry.canonicalName}
          englishFallback={entry.englishFallback}
          highlight={finderHighlight(result.byKey.get(entry.canonicalName))}
        />
        <span className={row.code}>{entry.code}</span>
        <span className={row.count}>{formatCount(entry.count, locale.value)}</span>
      </button>
      {result.active && (
        <button
          type="button"
          className={styles.rowAction}
          aria-label={t('speciesKey.selectPlants', { count: entry.count, name })}
          onClick={() => currentCanvasSceneEditCommandSurface.value?.selectSpecies([entry.canonicalName])}
        >{t('speciesKey.select')}</button>
      )}
      {detail && (
        <button
          type="button"
          className={styles.details}
          data-species-detail={entry.canonicalName}
          aria-label={t('speciesKey.details', { name })}
          onClick={() => onOpenDetail(entry.canonicalName)}
        >
          <ControlIcon name="chevron-right" />
          <ButtonTooltip label={t('speciesKey.details', { name })} side="left" />
        </button>
      )}
    </li>
  )
}

/** Close matches from the catalog, so a search that misses the Design still leads somewhere. */
function CatalogCloseMatches({ query, inDesign }: {
  query: string
  inDesign: readonly SpeciesKeyEntry[]
}) {
  const [items, setItems] = useState<readonly SpeciesListItem[]>([])
  const inDesignKey = inDesign.map((entry) => entry.canonicalName).join('\n')
  useEffect(() => {
    let current = true
    setItems([])
    const timer = globalThis.setTimeout(() => {
      speciesCatalogWorkbench.searchCloseMatches(query, CLOSE_MATCH_LIMIT * 3).then((found) => {
        if (!current) return
        const designNames = new Set(inDesignKey.split('\n'))
        setItems(found.filter((item) => !designNames.has(item.canonical_name)).slice(0, CLOSE_MATCH_LIMIT))
      }, () => {
        // The catalog is optional here: without it the section stays hidden.
      })
    }, CLOSE_MATCH_DEBOUNCE_MS)
    return () => {
      current = false
      globalThis.clearTimeout(timer)
    }
  }, [query, inDesignKey])
  const marks = useMemo(() => findPlants(items.map((item) => plantFinderRecord({
    canonicalName: item.canonical_name,
    commonName: item.common_name,
  })), query), [items, query])
  if (items.length === 0) return null
  const open = (item: SpeciesListItem) => {
    speciesCatalogWorkbench.setSearchText(query)
    navigateTo('plant-db')
    speciesCatalogWorkbench.selectSpecies(item.canonical_name)
  }
  return (
    <section aria-labelledby="plants-in-catalog">
      <h3 id="plants-in-catalog" className={row.section}>{t('speciesKey.inCatalog')}</h3>
      <ul className={styles.list}>
        {items.map((item) => {
          const name = item.common_name || item.canonical_name
          return (
            <li key={item.canonical_name} className={row.row}>
              <span className={row.glyph} aria-hidden="true">
                <span className={styles.catalogGlyph}><PlantSymbolGlyph symbol={DEFAULT_PLANT_SYMBOL_ID} size={22} /></span>
              </span>
              <SpeciesIdentity
                commonName={item.common_name}
                canonicalName={item.canonical_name}
                highlight={finderHighlight(marks.byKey.get(item.canonical_name))}
              />
              <button
                type="button"
                className={styles.linkButton}
                aria-label={t('speciesKey.openInCatalogLabel', { name })}
                onClick={() => open(item)}
              >{t('speciesKey.openInCatalog')}</button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
