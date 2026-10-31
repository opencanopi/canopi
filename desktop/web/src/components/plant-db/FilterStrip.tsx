import { t } from '../../i18n'
import { filterText } from './filter-text'
import { locale } from '../../app/settings/state'
import { formatCount } from '../../utils/format-count'
import { speciesCatalogWorkbench } from '../../app/plant-browser'
import type { FilterOptions, SpeciesFilter } from '../../types/species'
import type { StripControlField } from '../../app/plant-browser'
import { ControlIcon } from '../shared/ControlIcon'
import { FilterChip } from './FilterChip'
import { ThresholdSlider } from './ThresholdSlider'
import { toggleArrayValue } from './filter-utils'
import styles from './PlantDb.module.css'

/** Every filter the edition's catalog serves, one row each; "More filters" opens the rest (Desktop). */
export function FilterStrip({ onMoreFilters }: { onMoreFilters?: () => void }) {
  const filterStrip = speciesCatalogWorkbench.filterStrip.value;
  const extraCount = speciesCatalogWorkbench.intent.value.extraFilters.length;

  return (
    <div className={styles.filterStrip}>
      {filterStrip.controls.map((control) => (
        <FilterControlRow
          key={control.filterKey}
          control={control}
          filters={filterStrip.filters}
          options={filterStrip.options}
        />
      ))}

      {onMoreFilters && (
        <div className={styles.filterActions}>
          <button type="button" className={styles.moreFiltersBtn} onClick={onMoreFilters} data-preserve-overlays="true">
            {t('filters.moreFilters')}
            {extraCount > 0 && <span className={styles.filterBadge}>{formatCount(extraCount, locale.value)}</span>}
            <ControlIcon name="chevron-right" />
          </button>
        </div>
      )}
    </div>
  );
}

function FilterControlRow({
  control,
  filters,
  options,
}: {
  control: StripControlField
  filters: SpeciesFilter
  options: FilterOptions | null
}) {
  const label = filterText(control.labelI18nKey, control.fallbackLabel)
  const controlClassName = control.kind === 'choice'
    ? `${styles.filterControl} ${styles.filterChoiceControl}`
    : styles.filterControl

  return (
    <div className={styles.filterRow}>
      <span className={styles.filterLabel}>{label}</span>
      <div className={controlClassName}>
        {control.kind === 'choice' && (options?.[control.optionsKey] ?? []).map((val) => (
          <FilterChip
            key={val}
            label={filterText(`${control.valueI18nPrefix}${val}`, val)}
            color={control.color}
            active={(filters[control.filterKey] as string[] | null)?.includes(val) ?? false}
            onClick={() => speciesCatalogWorkbench.patchFilters({
              [control.filterKey]: toggleArrayValue(filters[control.filterKey] as string[] | null, val),
            })}
          />
        ))}
        {control.kind === 'threshold' && (
          <ThresholdSlider
            min={control.min}
            max={control.max}
            value={filters[control.filterKey] as number | null}
            onChange={(v) => speciesCatalogWorkbench.patchFilters({ [control.filterKey]: v })}
            ariaLabel={label}
          />
        )}
        {control.kind === 'boolean' && (
          <label className={styles.toggleSwitch}>
            <input
              type="checkbox"
              checked={filters[control.filterKey] === control.activeValue}
              onChange={(e) => speciesCatalogWorkbench.patchFilters({
                [control.filterKey]: (e.target as HTMLInputElement).checked ? control.activeValue : null,
              })}
            />
            <span className={styles.toggleTrack} />
          </label>
        )}
      </div>
    </div>
  )
}
