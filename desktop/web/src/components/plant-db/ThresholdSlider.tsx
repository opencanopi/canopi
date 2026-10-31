import { useCallback } from 'preact/hooks'
import { t } from '../../i18n'
import styles from './ThresholdSlider.module.css'

interface ThresholdSliderProps {
  min: number;
  max: number;
  value: number | null;
  onChange: (v: number | null) => void;
  formatLabel?: (v: number) => string;
  ariaLabel?: string;
}

export function ThresholdSlider({
  min,
  max,
  value,
  onChange,
  formatLabel,
  ariaLabel,
}: ThresholdSliderProps) {
  const current = value ?? min;
  const range = max - min || 1;
  const pct = ((current - min) / range) * 100;
  const fmt = formatLabel ?? ((v: number) => `${v}+`);
  const isActive = value !== null && value > min;

  const handleInput = useCallback((e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    onChange(v <= min ? null : v);
  }, [min, onChange]);

  return (
    <div className={styles.slider} role="group" aria-label={ariaLabel}>
      <span className={`${styles.value} ${isActive ? styles.valueActive : ''}`}>
        {isActive ? fmt(current) : '\u2014'}
      </span>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${pct}%` }} />
        {/* Tick marks — positioned inside padded track area */}
        <div className={styles.ticks}>
          {Array.from({ length: max - min + 1 }, (_, i) => {
            const v = min + i;
            const tickPct = ((v - min) / range) * 100;
            const filled = isActive && v <= current;
            return (
              <span
                key={v}
                className={`${styles.tick} ${filled ? styles.tickFilled : ''}`}
                style={{ left: `${tickPct}%` }}
                aria-hidden="true"
              />
            );
          })}
        </div>
        <input
          type="range"
          className={styles.input}
          min={min}
          max={max}
          step={1}
          value={current}
          onInput={handleInput}
          aria-label={ariaLabel ?? t('filters.sliderThreshold')}
          aria-valuenow={current}
          aria-valuetext={isActive ? fmt(current) : t('filters.noMinimum')}
        />
      </div>
      <span className={styles.bound}>{max}</span>
    </div>
  );
}
