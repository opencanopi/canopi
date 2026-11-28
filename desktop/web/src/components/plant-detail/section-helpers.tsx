import { t } from '../../i18n';
import { locale, unitSystem } from '../../app/settings/state';
import { CONVERSION_CONSTANTS, formatRainfall } from '../../utils/format';
import { ControlIcon } from '../shared/ControlIcon';
import row from '../shared/species-row.module.css';
import { formatNumber } from '../species-detail/species-facts';
import styles from './PlantDetail.module.css';

/** A recorded yes/no trait; unrecorded traits do not render. */
export function BoolChip({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) return null;
  return (
    <li className={`${styles.boolChip} ${value ? styles.boolChipTrue : ''}`}>
      <ControlIcon name={value ? 'check' : 'close'} size={16} />
      <span>{label}<span className={row.srOnly}> {value ? t('plantDetail.yes') : t('plantDetail.no')}</span></span>
    </li>
  );
}

export function TextBlock({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className={styles.textItem}>
      <span className={styles.attrLabel}>{label}</span>
      <p className={styles.textContent}>{text}</p>
    </div>
  );
}

export function Attr({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className={styles.attrItem}>
      <dt className={styles.attrLabel}>{label}</dt>
      <dd className={styles.attrValue}>{value}</dd>
    </div>
  );
}

/** A number as recorded (up to two decimals, grouped for the interface language) with its unit. */
export function NumAttr({ label, value, unit }: { label: string; value: number | null; unit?: string }) {
  if (value === null) return null;
  return <Attr label={label} value={`${formatNumber(value, locale.value, 2)}${unit ?? ''}`} />;
}

/** Format a min/max precipitation range (stored in inches) in the active unit system. */
export function formatPrecipRange(min: number | null, max: number | null): string | null {
  const fmt = (inches: number) => formatRainfall(
    inches * CONVERSION_CONSTANTS.mmPerInch,
    unitSystem.value,
    locale.value,
    { trimTrailingZeros: true },
  );
  if (min !== null && max !== null) return `${fmt(min)}–${fmt(max)}`;
  if (min !== null) return `${fmt(min)}+`;
  if (max !== null) return `≤${fmt(max)}`;
  return null;
}
