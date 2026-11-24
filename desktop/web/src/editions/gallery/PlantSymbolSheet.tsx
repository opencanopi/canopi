import { PlantSymbolGlyph } from '../../components/canvas/PlantSymbolGlyph'
import { PLANT_SYMBOL_FAMILIES, type PlantSymbolFamily } from '../../canvas/runtime/plant-symbol-recipes'
import { PLANT_COLOR_PALETTE } from '../../canvas/plant-colors'
import type { PlantSymbolId } from '../../canvas/runtime/scene'
import { t } from '../../i18n'
import styles from './gallery.module.css'

const MAP_CUTOUT = '#FBF8F2'

/** Review sheet for the shared plant symbol recipes: every symbol, family, size and a spread of colours. */
export function PlantSymbolSheet() {
  let colorIndex = 0
  const nextColor = () => PLANT_COLOR_PALETTE[colorIndex++ % PLANT_COLOR_PALETTE.length]!.hex
  return (
    <section className={styles.symbolSheet} data-plant-symbol-sheet aria-label={t('canvas.plantSymbol.label')}>
      {(Object.entries(PLANT_SYMBOL_FAMILIES) as [PlantSymbolFamily, readonly PlantSymbolId[]][]).map(([family, symbols]) => (
        <div key={family} className={styles.symbolFamily} data-symbol-family={family}>
          <h2>{t(`canvas.plantSymbol.families.${family}`)}</h2>
          <div className={styles.symbolRow}>
            {symbols.map((symbol) => {
              const color = nextColor()
              return (
                <figure key={symbol} className={styles.symbolCell} data-symbol={symbol}>
                  <span className={styles.symbolLarge}><PlantSymbolGlyph symbol={symbol} size={48} /></span>
                  <span className={styles.symbolLadder} style={{ color }}>
                    {[24, 16, 12].map((size) => <PlantSymbolGlyph key={size} symbol={symbol} size={size} />)}
                  </span>
                  <span className={styles.symbolMap} style={{ color }}>
                    {[16, 12].map((size) => <PlantSymbolGlyph key={size} symbol={symbol} size={size} cutoutColor={MAP_CUTOUT} />)}
                  </span>
                  <figcaption>{t(`canvas.plantSymbol.names.${symbol}`)}</figcaption>
                </figure>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}
