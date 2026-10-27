import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { t } from '../../i18n';
import { ControlIcon } from '../shared/ControlIcon';
import styles from './PlantDetail.module.css';
import type { LocaleKey } from '../../generated/locale-keys';

interface Props {
  id: string;
  titleKey: LocaleKey;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  children: ComponentChildren;
}

/** One catalog section: a disclosure with a chevron; closed until the reader opens it. */
export function CollapsibleSection({ id, titleKey, expanded, onToggle, children }: Props) {
  const open = expanded.has(id);
  const bodyId = useId();
  return (
    <section className={styles.section} aria-label={t(titleKey)} data-section={id}>
      <h3 className={styles.sectionHeading}>
        <button
          type="button"
          className={styles.sectionToggle}
          onClick={() => onToggle(id)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <span className={styles.sectionTitle}>{t(titleKey)}</span>
          <ControlIcon name="chevron-down" className={styles.sectionChevron} />
        </button>
      </h3>
      <div id={bodyId} className={styles.sectionBody} hidden={!open}>{open && children}</div>
    </section>
  );
}
