import { useCallback } from 'preact/hooks'
import { t } from '../../i18n'
import styles from './RangeSlider.module.css'

interface RangeSliderProps {
  min: number;
  max: number;
  valueLow: number | null;
  valueHigh: number | null;
  onChangeLow: (v: number | null) => void;
  onChangeHigh: (v: number | null) => void;
  step?: number;
  formatLabel?: (v: number) => string;
  ariaLabel?: string;
}

export function RangeSlider({
  min,
  max,
  valueLow,
  valueHigh,
  onChangeLow,
  onChangeHigh,
  step = 1,
  formatLabel,
  ariaLabel,
}: RangeSliderProps) {
  const low = valueLow ?? min;
  const high = valueHigh ?? max;
  const range = max - min || 1;
  const lowPct = ((low - min) / range) * 100;
  const highPct = ((high - min) / range) * 100;
  const fmt = formatLabel ?? ((v: number) => String(v));

  const handleLow = useCallback((e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    const clamped = Math.min(v, high);
    onChangeLow(clamped === min ? null : clamped);
  }, [high, min, onChangeLow]);

  const handleHigh = useCallback((e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    const clamped = Math.max(v, low);
    onChangeHigh(clamped === max ? null : clamped);
  }, [low, max, onChangeHigh]);

  return (
    <div className={styles.slider} role="group" aria-label={ariaLabel}>
      <span className={styles.bound}>{fmt(low)}</span>
      <div className={styles.track}>
        <div
          className={styles.fill}
          style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
        />
        <input
          type="range"
          className={`${styles.input} ${styles.inputLow}`}
          min={min}
          max={max}
          step={step}
          value={low}
          onInput={handleLow}
          aria-label={ariaLabel ? `${ariaLabel} ${t('filters.sliderMin')}` : t('filters.sliderMin')}
        />
        <input
          type="range"
          className={`${styles.input} ${styles.inputHigh}`}
          min={min}
          max={max}
          step={step}
          value={high}
          onInput={handleHigh}
          aria-label={ariaLabel ? `${ariaLabel} ${t('filters.sliderMax')}` : t('filters.sliderMax')}
        />
      </div>
      <span className={styles.bound}>{fmt(high)}</span>
    </div>
  );
}
