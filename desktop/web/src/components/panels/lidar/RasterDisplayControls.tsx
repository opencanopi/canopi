import { useEffect, useRef, useState } from 'preact/hooks'
import { setLidarEntryDisplay } from '../../../app/lidar/actions'
import { parseLocaleNumber } from '../../../app/analyses/model'
import { lidarDisplayStyle } from '../../../app/lidar/display'
import { formatLegendValue, legendGradient } from '../../../app/lidar/display-legend'
import { kindDisplayDefaults, kindRamps, unitSuffix } from '../../../app/lidar/item-types'
import type { LidarPresentationItem } from '../../../app/lidar/library-store'
import { locale } from '../../../app/settings/state'
import type { LidarColourRange, LidarRamp } from '../../../generated/contracts'
import { t } from '../../../i18n'
import { SegmentedControl } from '../../shared/SegmentedControl'
import { Slider } from '../../shared/Slider'
import styles from './raster-display-controls.module.css'

type RangeMode = LidarColourRange['mode']

/**
 * An open Site data item's display settings (canopi-f47t.42, spec §1.10
 * "Open item"; U49 Q32–Q38): Colors (the kind's ramps as swatches, Reverse,
 * Reset while the display differs from the kind's, the legend with ≤/≥ where
 * the range cuts the data), Range (Data range, Cut outliers, Custom, with
 * Minimum and Maximum always showing the values in use), then the live
 * opacity. Relief (canopi-2add) draws stored greys, so it hides Reverse, the
 * legend and Range, keeping the entry's Reverse and range for Colours. Colors
 * and range commit on a click, Enter or leaving a field, never while
 * dragging, since each restyle re-tiles; only opacity is live. Every write
 * goes through `setLidarEntryDisplay`, which stores a kind's default as null,
 * so "differs from the default" is a null check.
 */
export function RasterDisplayControls({ item }: { readonly item: LidarPresentationItem }) {
  const style = lidarDisplayStyle(item)
  const percent = new Intl.NumberFormat(locale.value, { style: 'percent' })
  const relief = style?.ramp === 'Relief'
  return (
    <div className={styles.controls}>
      {style && item.itemType && (
        <>
          <Colors item={item} ramps={kindRamps(item.itemType)} chosen={style.ramp} />
          {!relief && <Legend ramp={style.ramp} reversed={style.reversed} range={style.rescale} data={item.displayRange} units={style.units} />}
          {!relief && <Range item={item} mode={(item.range ?? kindDisplayDefaults(item.itemType, item.units).range).mode} values={style.rescale} />}
        </>
      )}
      <Slider
        label={t('canvas.lidar.layers.opacity')}
        ariaLabel={`${t('canvas.lidar.layers.opacity')}: ${item.name}`}
        min={0}
        max={100}
        value={Math.round(item.opacity * 100)}
        format={(value) => percent.format(value / 100)}
        onInput={(value) => setLidarEntryDisplay(item.id, { opacity: value / 100 })}
      />
    </div>
  )
}

function Colors({ item, ramps, chosen }: {
  readonly item: LidarPresentationItem
  readonly ramps: readonly LidarRamp[]
  readonly chosen: LidarRamp
}) {
  const label = t('siteData.display.colors')
  const swatches = useRef<HTMLDivElement>(null)
  const differs = item.ramp !== null || item.reversed || item.range !== null
  return (
    <div className={styles.section}>
      <span className={styles.heading} aria-hidden="true">{label}</span>
      <div className={styles.colors}>
        <div ref={swatches} className={styles.swatches} role="radiogroup" aria-label={label}>
          {ramps.map((ramp) => {
            const name = t(`siteData.display.ramp.${ramp}`)
            return (
              <button
                key={ramp}
                type="button"
                role="radio"
                className={styles.swatchButton}
                aria-checked={ramp === chosen}
                aria-label={name}
                title={name}
                onClick={() => { if (ramp !== chosen) setLidarEntryDisplay(item.id, { ramp }) }}
              >
                <span className={styles.swatch} data-swatch style={{ backgroundImage: legendGradient(ramp, item.reversed) }} />
              </button>
            )
          })}
        </div>
        {chosen !== 'Relief' && (
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={item.reversed}
            onClick={() => setLidarEntryDisplay(item.id, { reversed: !item.reversed })}
          >
            {t('siteData.display.reverse')}
          </button>
        )}
        {differs && (
          <button type="button" className={styles.reset}
            onClick={() => {
              setLidarEntryDisplay(item.id, { ramp: null, reversed: false, range: null })
              // Reset leaves once the display is the kind's, which may hide Range: keep the keyboard on the ramp it
              // checks, the kind's default and so the first swatch (keyed, so it stays mounted).
              swatches.current?.querySelector<HTMLElement>('[role="radio"]')?.focus()
            }}>
            {t('siteData.display.reset')}
          </button>
        )}
      </div>
    </div>
  )
}

/** The ramp over the range in use; an end that cuts the data reads "≤" or "≥", since its colour holds every value beyond. */
function Legend({ ramp, reversed, range, data, units }: {
  readonly ramp: LidarRamp
  readonly reversed: boolean
  readonly range: readonly [number, number]
  readonly data: readonly [number, number] | null
  readonly units: string
}) {
  const [low, high] = range
  const lowText = formatLegendValue(low, units, locale.value)
  const highText = formatLegendValue(high, units, locale.value)
  return (
    <div className={styles.legend} aria-label={t('canvas.lidar.layers.legend')} role="group">
      <div className={styles.ramp} style={{ backgroundImage: legendGradient(ramp, reversed) }} />
      <div className={styles.legendLabels}>
        <span data-legend-end>{data && low > data[0] ? `≤ ${lowText}` : lowText}</span>
        <span data-legend-end>{data && high < data[1] ? `≥ ${highText}` : highText}</span>
      </div>
    </div>
  )
}

function Range({ item, mode, values }: {
  readonly item: LidarPresentationItem
  readonly mode: RangeMode
  readonly values: readonly [number, number]
}) {
  const label = t('siteData.display.range')
  const choose = (next: RangeMode) => {
    setLidarEntryDisplay(item.id, {
      range: next === 'Custom' ? { mode: 'Custom', min: values[0], max: values[1] } : { mode: next },
    })
  }
  const commit = (min: number, max: number): boolean => {
    if (!(min < max)) return false
    if (min !== values[0] || max !== values[1] || mode !== 'Custom') {
      setLidarEntryDisplay(item.id, { range: { mode: 'Custom', min, max } })
    }
    return true
  }
  return (
    <div className={styles.section}>
      <span className={styles.heading} aria-hidden="true">{label}</span>
      <SegmentedControl<RangeMode>
        label={label}
        className={styles.modes}
        value={mode}
        onChange={choose}
        options={[
          { value: 'Data', label: t('siteData.display.dataRange') },
          { value: 'CutOutliers', label: <span title={t('siteData.display.cutOutliersHint')}>{t('siteData.display.cutOutliers')}</span> },
          { value: 'Custom', label: t('siteData.display.custom') },
        ]}
      />
      <div className={styles.fields}>
        <RangeFields values={values} onCommit={commit} />
        <span className={styles.units}>{unitSuffix(item.units).trim()}</span>
      </div>
    </div>
  )
}

/**
 * A range end as its field shows it, with no grouping so an f32 raster's range fits: two decimals (centimetres,
 * hundredths of a degree), or three significant digits where that is finer, since other values take any units and a
 * range of 0.0012–0.0087 would otherwise read 0–0.01.
 */
function fieldNumber(value: number, localeTag: string): string {
  const magnitude = Number.isFinite(value) && value !== 0 ? Math.floor(Math.log10(Math.abs(value))) : 0
  const digits = Math.min(20, Math.max(2, 2 - magnitude))
  return new Intl.NumberFormat(localeTag, { useGrouping: false, maximumFractionDigits: digits }).format(value)
}

/**
 * Minimum and Maximum as one pair: each always shows the value in use and
 * accepts the locale's decimal mark. The pair commits on Enter or leaving a
 * field when both ends parse and minimum stays below maximum. Moving from one
 * end to the other keeps a draft that only the other end's draft makes valid,
 * so a new range above or below the one in use can be typed in either order;
 * leaving the pair, or Enter, with no valid pair reverts both ends. The
 * inputs stay mounted as the values in use change, so focus survives a
 * commit; a new value replaces an end's text unless the user is editing it.
 */
function RangeFields({ values, onCommit }: {
  readonly values: readonly [number, number]
  onCommit(min: number, max: number): boolean
}) {
  const shown: [string, string] = [fieldNumber(values[0], locale.value), fieldNumber(values[1], locale.value)]
  const [drafts, setDrafts] = useState(shown)
  const previous = useRef(shown)
  const minimumRef = useRef<HTMLInputElement>(null)
  const maximumRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const before = previous.current
    previous.current = shown
    setDrafts((current) => [0, 1].map((end) => (current[end] === before[end] ? shown[end] : current[end])) as [string, string])
  }, [shown[0], shown[1]])
  const pending = drafts[0] !== shown[0] || drafts[1] !== shown[1]
  // An untouched end commits the value in use, not its shorter text.
  const parsed = (end: 0 | 1) => (drafts[end] === shown[end] ? values[end] : parseLocaleNumber(drafts[end], locale.value))
  const finish = (staysInPair: boolean) => {
    if (!pending) return
    const min = parsed(0)
    const max = parsed(1)
    if (min !== null && max !== null && onCommit(min, max)) {
      setDrafts([fieldNumber(min, locale.value), fieldNumber(max, locale.value)])
    } else if (!staysInPair) {
      setDrafts(shown)
    }
  }
  const field = (end: 0 | 1, label: string) => (
    <input
      ref={end === 0 ? minimumRef : maximumRef}
      className={styles.field}
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={drafts[end]}
      onInput={(event) => {
        const text = event.currentTarget.value
        setDrafts((current) => (end === 0 ? [text, current[1]] : [current[0], text]))
      }}
      onFocusOut={(event) => finish(event.relatedTarget !== null && event.relatedTarget === (end === 0 ? maximumRef : minimumRef).current)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(false)
        } else if (event.key === 'Escape' && pending) {
          event.preventDefault()
          event.stopPropagation()
          setDrafts(shown)
        }
      }}
    />
  )
  return (
    <>
      {field(0, t('siteData.display.minimum'))}
      <span className={styles.dash} aria-hidden="true">–</span>
      {field(1, t('siteData.display.maximum'))}
    </>
  )
}
