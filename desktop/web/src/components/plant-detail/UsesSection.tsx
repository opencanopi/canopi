import { t } from '../../i18n';
import { locale } from '../../app/settings/state';
import type { SpeciesUse } from '../../types/species';
import { formatRating } from '../species-detail/species-facts';
import styles from './PlantDetail.module.css';
import type { LocaleKey } from '../../generated/locale-keys';

interface Props {
  uses: SpeciesUse[];
  edibilityRating: number | null;
  medicinalRating: number | null;
  otherUsesRating?: number | null;
}

interface CategoryGroup {
  labelKey: LocaleKey;
  rating: number | null;
  items: SpeciesUse[];
}

/** Every recorded use, grouped as edible, medicinal and other, each with its rating. */
export function UsesSection({ uses, edibilityRating, medicinalRating, otherUsesRating }: Props) {
  const isEdible = (u: SpeciesUse) => u.use_category.toLowerCase().includes('edible');
  const isMedicinal = (u: SpeciesUse) => u.use_category.toLowerCase().includes('medicin');
  const categories: CategoryGroup[] = [
    { labelKey: 'plantDetail.edible', rating: edibilityRating, items: uses.filter(isEdible) },
    { labelKey: 'plantDetail.medicinal', rating: medicinalRating, items: uses.filter(isMedicinal) },
    { labelKey: 'plantDetail.otherUses', rating: otherUsesRating ?? null, items: uses.filter((u) => !isEdible(u) && !isMedicinal(u)) },
  ];

  return (
    <>
      {categories.map(({ labelKey, rating, items }) => {
        if (items.length === 0 && rating === null) return null;
        return (
          <div key={labelKey} className={styles.usesCategory}>
            <div className={styles.usesCategoryHeader}>
              <span className={styles.usesCategoryName}>{t(labelKey)}</span>
              {rating !== null && <span className={styles.usesRating}>{formatRating(rating, locale.value)}</span>}
            </div>
            {items.map((use, idx) => (
              <p key={idx} className={styles.usesDescription}>
                {use.use_description ?? use.use_category}
              </p>
            ))}
          </div>
        );
      })}
    </>
  );
}
