import type { TargetedKeyboardEvent } from 'preact'
import { useId, useMemo, useRef, useState } from 'preact/hooks'
import type { TimelineSpeciesOption } from '../../app/planning-projection'
import { useMapSelectionSpecies } from '../../app/plant-finder/selection'
import { usePlantFinder } from '../../app/plant-finder/use-plant-finder'
import { t } from '../../i18n'
import { ControlIcon } from '../shared/ControlIcon'
import { PlantFinder, finderHighlight } from '../shared/PlantFinder'
import { SpeciesIdentity } from '../shared/SpeciesIdentity'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { displayedPlantColor } from '../../app/plant-display/state'
import row from '../shared/species-row.module.css'
import styles from './CalendarSpeciesPicker.module.css'

/**
 * The species targets of an action: the plant finder over a multi-select listbox with
 * checkboxes and "Add all N". Arrow keys move from the field into the list; Space or
 * Enter toggles the focused species.
 */
export function CalendarSpeciesPicker({ species, chosen, unavailable, onToggle, onAddAll }: {
  readonly species: readonly TimelineSpeciesOption[]
  readonly chosen: ReadonlySet<string>
  /** Chosen species no longer in the Design, with their saved labels. */
  readonly unavailable: readonly { readonly canonicalName: string; readonly label: string }[]
  onToggle(canonicalName: string): void
  onAddAll(canonicalNames: readonly string[]): void
}) {
  const [query, setQuery] = useState('')
  const [selectedOnMap, setSelectedOnMap] = useState(false)
  const [showChosen, setShowChosen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const options = useRef<(HTMLElement | null)[]>([])
  const listId = useId()
  const headId = useId()
  const mapSelection = useMapSelectionSpecies()
  const finderSpecies = useMemo(() => species.map((option) => ({
    canonicalName: option.canonical_name,
    commonName: option.common_name,
    code: option.code,
  })), [species])
  const finder = usePlantFinder(finderSpecies, query)
  const visible = useMemo(() => {
    const shown = species.filter((option) => (
      (!showChosen || chosen.has(option.canonical_name))
      && (!selectedOnMap || mapSelection.plantCountBySpecies.has(option.canonical_name))
      && (!finder.active || finder.byKey.has(option.canonical_name))
    ))
    if (!finder.active) return shown
    const rank = new Map(finder.hits.map((hit, index) => [hit.key, index]))
    return shown.sort((left, right) => rank.get(left.canonical_name)! - rank.get(right.canonical_name)!)
  }, [chosen, finder, mapSelection, selectedOnMap, showChosen, species])
  const addable = visible.filter((option) => !chosen.has(option.canonical_name))
  const chosenPlants = species.reduce((sum, option) => sum + (chosen.has(option.canonical_name) ? option.plant_count : 0), 0)
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0))

  function focusOption(index: number): void {
    const next = Math.max(0, Math.min(index, visible.length - 1))
    setActive(next)
    options.current[next]?.focus()
  }

  function onOptionKeyDown(event: TargetedKeyboardEvent<HTMLElement>, index: number, name: string): void {
    if (event.key === 'ArrowDown') focusOption(index + 1)
    else if (event.key === 'ArrowUp') {
      if (index === 0) input.current?.focus()
      else focusOption(index - 1)
    } else if (event.key === 'Home') focusOption(0)
    else if (event.key === 'End') focusOption(visible.length - 1)
    else if (event.key === ' ' || event.key === 'Enter') onToggle(name)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className={styles.picker} data-species-picker>
      <div className={styles.chosenLine}>
        <span role="status">
          <b>{t('canvas.calendar.speciesChosen', { count: chosen.size })}</b>
          {chosen.size > 0 && <span className={styles.muted}> · {t('plantFinder.plants', { count: chosenPlants })}</span>}
        </span>
        {chosen.size > 0 && (
          <button type="button" className={styles.link} aria-pressed={showChosen} onClick={() => setShowChosen(!showChosen)}>
            {t('canvas.calendar.showChosen')}
          </button>
        )}
      </div>
      {unavailable.length > 0 && (
        <div className={styles.unavailable}>
          {unavailable.map((target) => (
            <button
              key={target.canonicalName}
              type="button"
              className={styles.token}
              data-calendar-selected-target={target.canonicalName}
              aria-label={t('canvas.calendar.removeSpecies', { name: target.label })}
              onClick={() => onToggle(target.canonicalName)}
            >
              <span>{target.label}</span>
              <small>{t('canvas.calendar.unavailable')}</small>
              <ControlIcon name="close" />
            </button>
          ))}
        </div>
      )}
      <PlantFinder
        value={query}
        onChange={(value) => { setQuery(value); setActive(0) }}
        label={t('canvas.calendar.searchSpecies')}
        placeholder={t('canvas.calendar.addSpeciesPlaceholder')}
        correction={finder.correction}
        selectedOnMap={{
          pressed: selectedOnMap,
          plantCount: mapSelection.plantCount,
          onChange: setSelectedOnMap,
        }}
        inputRef={input}
        controls={listId}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || visible.length === 0) return
          event.preventDefault()
          focusOption(activeIndex)
        }}
      />
      <div className={styles.menu}>
        <div className={styles.menuHead}>
          <span id={headId}>{finder.active
            ? t('canvas.calendar.speciesMatch', { count: visible.length, query: query.trim() })
            : t('canvas.calendar.speciesInList', { count: visible.length })}</span>
          {addable.length > 1 && (
            <button type="button" className={styles.link} onClick={() => onAddAll(addable.map((option) => option.canonical_name))}>
              {t('canvas.calendar.addAll', { count: addable.length })}
            </button>
          )}
        </div>
        {visible.length > 0 ? <div
          id={listId}
          className={styles.options}
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={headId}
        >
          {visible.map((option, index) => {
            const selected = chosen.has(option.canonical_name)
            return (
              <div
                key={option.canonical_name}
                ref={(element) => { options.current[index] = element }}
                role="option"
                aria-selected={selected}
                tabIndex={index === activeIndex ? 0 : -1}
                className={row.row}
                data-calendar-species-option={option.canonical_name}
                onClick={() => { setActive(index); onToggle(option.canonical_name) }}
                onKeyDown={(event) => onOptionKeyDown(event, index, option.canonical_name)}
              >
                <span className={styles.checkbox} data-checked={selected} aria-hidden="true">
                  {selected && <ControlIcon name="check" />}
                </span>
                <span className={row.glyph} aria-hidden="true">
                  {option.appearance && (
                    <span style={{ color: displayedPlantColor(option.appearance.color, option.canonical_name) }}>
                      <PlantSymbolGlyph symbol={option.appearance.symbol} size={20} />
                    </span>
                  )}
                </span>
                <SpeciesIdentity
                  commonName={option.common_name}
                  canonicalName={option.canonical_name}
                  englishFallback={option.english_fallback}
                  highlight={finderHighlight(finder.byKey.get(option.canonical_name))}
                />
                <span className={row.code}>{option.code}</span>
              </div>
            )
          })}
        </div> : <p id={listId} className={styles.empty} role="status">{t('canvas.calendar.noSpeciesMatches')}</p>}
      </div>
    </div>
  )
}
