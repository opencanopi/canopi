import { buildPinnedPlantNameLegendEntries } from '../../canvas/pinned-plant-name-legend'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { t } from '../../i18n'
import { currentPlantDisplay } from '../../app/plant-display/state'
import { locale } from '../../app/settings/state'
import { phoneLayout } from '../../app/shell/phone-layout'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { bottomChromeCoverOver, leftChromeCrowdsMap, visibleMapFrame } from '../../app/shell/visible-map-area'
import { useMapOccluder } from '../shared/useMapChrome'
import { PlantSymbolGlyph } from './PlantSymbolGlyph'
import styles from './DisplayLegend.module.css'

/**
 * The pinned plant names' legend, beside the tool rail at the bottom. Where it leaves the map the labelled tool rail's
 * least width before the right chrome, it covers the map's left edge on the visible-map-area seam, as the open
 * inspection lens does: framing, the chips and the map notice keep right of it (canopi-f47t.60: the notice stood under
 * it beside the open dock). With less (a window beside the open dock) it stays off the seam, or the notice and chips
 * would squeeze into a tower of single words; it then stands above the bottom chrome the seam measures, the notice
 * included. It stays off the seam too where other bottom chrome reaches into its place (the Web edition's bottom sheet
 * under 761 px), or it would cover the left edge unseen under that chrome. Measures on every render, as the lens does:
 * it reads only the frame's width and right edge and the bottom chrome over its column, never its own box's height or
 * place, so its own cover cannot feed back.
 */
export function DisplayLegend() {
  const legend = useRef<HTMLDivElement>(null)
  const querySurface = currentCanvasQuerySurface.value
  void querySurface?.revision.scene.value
  void querySurface?.revision.plantNames.value

  // Phones show the pinned names on the map only: nothing but the zoom column floats there (answer 25).
  const pinnedEntries = !querySurface || phoneLayout.value !== null
    ? []
    : buildPinnedPlantNameLegendEntries(querySurface, currentPlantDisplay.value, locale.value)
  const shown = pinnedEntries.length > 0
  const frame = visibleMapFrame.value
  const [covers, setCovers] = useState(false)
  useLayoutEffect(() => {
    const element = legend.current
    if (!element) {
      setCovers(false)
      return
    }
    const { left, right } = element.getBoundingClientRect()
    // Covering, it stands `--chrome-bottom` above the map's bottom edge (DisplayLegend.module.css).
    const place = parseFloat(getComputedStyle(element).getPropertyValue('--chrome-bottom')) || 0
    setCovers(!leftChromeCrowdsMap(frame, right) && bottomChromeCoverOver(left, right) <= place)
  })
  useMapOccluder(legend, 'left', shown && covers)
  if (!shown) return null

  return (
    <div
      ref={legend}
      className={styles.legend}
      data-pinned-plant-name-legend
      data-covers-map={covers ? '' : undefined}
    >
      <div className={styles.title}>{t('canvas.pinnedPlantNames.legend')}</div>
      <div className={styles.entries}>
        {pinnedEntries.map((entry) => (
          <div
            key={`${entry.label}:${entry.symbol}:${entry.color}`}
            className={styles.entry}
            data-pinned-plant-name-entry
          >
            <span
              className={styles.symbolSwatch}
              style={{ color: entry.color }}
              aria-hidden="true"
            >
              <PlantSymbolGlyph symbol={entry.symbol} size={14} className={styles.symbolGlyph} />
            </span>
            <span className={styles.entryLabel}>{entry.label}</span>
            {entry.count > 1 && (
              <span className={styles.count} data-pinned-plant-name-count>
                {entry.count}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
