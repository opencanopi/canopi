import type { ComponentChildren, Ref, TargetedKeyboardEvent } from 'preact'
import { useEffect, useImperativeHandle, useRef } from 'preact/hooks'
import { registerPlantFinder } from '../../app/plant-finder/focus'
import {
  plantFinderRangesIn,
  type PlantFinderHit,
  type PlantFinderRange,
} from '../../app/plant-finder/matcher'
import type {
  SpeciesFormChoice,
  SpeciesQuickFilters,
  SpeciesQuickFilterValue,
  SpeciesStratumChoice,
} from '../../app/plant-finder/quick-filters'
import { locale } from '../../app/settings/state'
import { ariaKeyShortcuts, formatShortcut } from '../../app/shell-commands/shortcut-text'
import { t } from '../../i18n'
import { formatCount } from '../../utils/format-count'
import { ControlIcon } from './ControlIcon'
import { Dropdown } from './Dropdown'
import { SurfaceSearch } from './SurfaceSearch'
import styles from './PlantFinder.module.css'
import type { LocaleKey } from '../../generated/locale-keys'

export interface SelectedOnMapFilter {
  readonly pressed: boolean
  /** Plants selected on the map right now. */
  readonly plantCount: number
  onChange(pressed: boolean): void
}

/**
 * The one way to find plants in a list: a search field (Ctrl F, Cmd F on macOS), quick filters starting
 * with "Selected on map", and a live count that says what was searched. Callers own the
 * query, the filters and the list; the matcher is `app/plant-finder/matcher.ts`.
 */
export function PlantFinder({
  value,
  onChange,
  label,
  placeholder,
  selectedOnMap,
  filters,
  summary,
  summaryActions,
  children,
  correction,
  inputRef,
  onKeyDown,
  controls,
}: {
  readonly value: string
  onChange(value: string): void
  /** Accessible name; defaults to "Find plants". */
  readonly label?: string
  readonly placeholder?: string
  readonly selectedOnMap?: SelectedOnMapFilter
  /** List-specific quick filters after "Selected on map". */
  readonly filters?: ComponentChildren
  /** The live count line, e.g. "2 species · 7 plants". */
  readonly summary?: ComponentChildren
  /** Controls on the count line after the count, e.g. the catalog's Sort and Clear filters. */
  readonly summaryActions?: ComponentChildren
  /** Between the quick filters and the count line, e.g. the catalog's filter rows and active filters. */
  readonly children?: ComponentChildren
  /** The words searched instead of a typo, from the matcher. */
  readonly correction?: string | null
  readonly inputRef?: Ref<HTMLInputElement | null>
  readonly onKeyDown?: (event: TargetedKeyboardEvent<HTMLInputElement>) => void
  readonly controls?: string
}) {
  const input = useRef<HTMLInputElement | null>(null)
  useImperativeHandle(inputRef ?? null, () => input.current, [])
  useEffect(() => registerPlantFinder(() => {
    input.current?.focus()
    input.current?.select()
  }), [])
  const hasFilters = Boolean(selectedOnMap) || Boolean(filters)
  const status = (
    <p className={styles.status} role="status">
      {correction && <>{renderWithTerm(t('plantFinder.showingResultsFor', { term: TERM }), correction)}{summary ? ' · ' : ''}</>}
      {summary}
    </p>
  )
  return (
    <div className={styles.finder}>
      <SurfaceSearch
        value={value}
        onChange={onChange}
        label={label ?? t('plantFinder.label')}
        placeholder={placeholder ?? t('plantFinder.placeholder')}
        shortcutHint={formatShortcut('Ctrl+F', t)}
        keyShortcuts={ariaKeyShortcuts('Ctrl+F')}
        inputRef={input}
        onKeyDown={onKeyDown}
        controls={controls}
      />
      {hasFilters && (
        <div className={styles.filters} role="group" aria-label={t('plantFinder.quickFilters')}>
          {selectedOnMap && (
            <QuickFilterChip
              pressed={selectedOnMap.pressed}
              onChange={selectedOnMap.onChange}
              label={selectedOnMap.pressed && selectedOnMap.plantCount > 0
                ? t('plantFinder.selectedOnMapCount', { count: selectedOnMap.plantCount })
                : t('plantFinder.selectedOnMap')}
            />
          )}
          {filters}
        </div>
      )}
      {children}
      {summaryActions
        ? <div className={styles.statusRow}>{status}{summaryActions}</div>
        : status}
    </div>
  )
}

/** A pressed-toggle quick filter: soft fill, accent border and ink, and a check. */
export function QuickFilterChip({ pressed, onChange, label, accessibleLabel }: {
  readonly pressed: boolean
  onChange(pressed: boolean): void
  readonly label: ComponentChildren
  readonly accessibleLabel?: string
}) {
  return (
    <button
      type="button"
      className={styles.chip}
      aria-pressed={pressed}
      aria-label={accessibleLabel}
      onClick={() => onChange(!pressed)}
    >
      {pressed && <ControlIcon name="check" />}
      {label}
    </button>
  )
}

/**
 * A quick filter that picks one choice from a menu: its name until a choice is made,
 * then "Stratum: High" in the pressed look. Each choice carries how many species it
 * holds; "All …" clears it.
 */
function QuickFilterMenu<T extends string>({ label, allLabel, value, choices, onChange }: {
  readonly label: string
  readonly allLabel: string
  readonly value: T | null
  readonly choices: readonly { readonly value: T; readonly label: string; readonly count: number }[]
  onChange(value: T | null): void
}) {
  const chosen = choices.find((choice) => choice.value === value)
  const currentLocale = locale.value
  return (
    <Dropdown<T | ''>
      trigger={chosen
        ? <><span aria-hidden="true">{t('plantFinder.filterChoice', { filter: label, choice: chosen.label })}</span><span className={styles.srOnly}>{chosen.label}</span></>
        : <><span aria-hidden="true">{label}</span><span className={styles.srOnly}>{allLabel}</span></>}
      ariaLabel={label}
      value={chosen ? chosen.value : ''}
      items={[
        { value: '', label: allLabel },
        ...choices.map((choice) => ({ value: choice.value, label: `${choice.label} · ${formatCount(choice.count, currentLocale)}` })),
      ]}
      onChange={(next) => onChange(next === '' ? null : next)}
      triggerClassName={chosen ? `${styles.menuChip} ${styles.menuChipActive}` : styles.menuChip}
      floating
    />
  )
}

const STRATUM_LABEL_KEYS: Readonly<Record<SpeciesStratumChoice, LocaleKey>> = {
  emergent: 'filters.stratum_emergent',
  high: 'filters.stratum_high',
  medium: 'filters.stratum_medium',
  low: 'filters.stratum_low',
  none: 'speciesKey.noStratumYet',
}

const FORM_LABEL_KEYS: Readonly<Record<SpeciesFormChoice, LocaleKey>> = {
  tree: 'filters.habit_Tree',
  shrub: 'filters.habit_Shrub',
  herbaceous: 'filters.habit_Herbaceous',
  climber: 'filters.habit_Climber',
  none: 'plantFinder.formNotRecorded',
}

/** The Stratum and Form quick filters (`app/plant-finder/quick-filters.ts`) as two menus. */
export function StratumFormFilters({ filters, onChange }: {
  readonly filters: SpeciesQuickFilters
  onChange(value: SpeciesQuickFilterValue): void
}) {
  const { value } = filters
  return <>
    <QuickFilterMenu<SpeciesStratumChoice>
      label={t('plantFinder.stratum')}
      allLabel={t('plantFinder.allStrata')}
      value={value.stratum}
      choices={withChosen(filters.stratumCounts, value.stratum).map(([choice, count]) => ({ value: choice, label: t(STRATUM_LABEL_KEYS[choice]), count }))}
      onChange={(stratum) => onChange({ ...value, stratum })}
    />
    <QuickFilterMenu<SpeciesFormChoice>
      label={t('plantFinder.form')}
      allLabel={t('plantFinder.allForms')}
      value={value.form}
      choices={withChosen(filters.formCounts, value.form).map(([choice, count]) => ({ value: choice, label: t(FORM_LABEL_KEYS[choice]), count }))}
      onChange={(form) => onChange({ ...value, form })}
    />
  </>
}

/** The counted choices, plus the chosen one when the list no longer holds it, so it still shows and can be cleared. */
function withChosen<T>(counts: ReadonlyMap<T, number>, chosen: T | null): [T, number][] {
  const choices = [...counts]
  if (chosen !== null && !counts.has(chosen)) choices.push([chosen, 0])
  return choices
}

/** A name with its finder matches marked. */
export function MatchText({ text, ranges }: {
  readonly text: string
  readonly ranges: readonly PlantFinderRange[]
}) {
  if (ranges.length === 0) return <>{text}</>
  const parts: ComponentChildren[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(<mark key={range.start} className={styles.mark}>{text.slice(range.start, range.end)}</mark>)
    cursor = range.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

/** Marks a row's names with its finder hit; plain names when the row did not match. */
export function finderHighlight(hit: PlantFinderHit<string> | undefined): ((text: string) => ComponentChildren) | undefined {
  if (!hit) return undefined
  return (text) => <MatchText text={text} ranges={plantFinderRangesIn(hit, text)} />
}

/** "2 species · 7 plants", or "… selected on the map" under the selection filter. */
export function finderSummary(species: number, plants: number, selectedOnMap = false): string {
  return t(selectedOnMap ? 'plantFinder.summarySelected' : 'plantFinder.summary', {
    species: t('plantFinder.species', { count: species }),
    plants: t('plantFinder.plants', { count: plants }),
  })
}

const TERM = '\u2063term\u2063'

/** Puts the term in bold inside a translated sentence, wherever the language puts it. */
function renderWithTerm(sentence: string, term: string): ComponentChildren {
  const [before, after = ''] = sentence.split(TERM)
  return <>{before}<b className={styles.term}>{term}</b>{after}</>
}
