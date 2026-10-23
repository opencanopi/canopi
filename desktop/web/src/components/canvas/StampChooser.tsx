import { useEffect, useRef, useState } from 'preact/hooks'
import type { TargetedKeyboardEvent } from 'preact'
import { savedObjectStampWorkbench } from '../../app/saved-object-stamps'
import {
  isSavedObjectStampPayloadFromBefore2_0,
  parseSavedObjectStampPayload,
} from '../../canvas/saved-object-stamp-payload'
import { armCanvasTool } from '../../app/keyboard/arming'
import { t } from '../../i18n'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import type { StampChooserProps } from './ToolCard'
import { ToolIcon } from './toolbar-icons'
import styles from './ToolCard.module.css'

/**
 * Place a stamp's chooser in the tool card (Change stamp), Desktop only since
 * saved stamps are (the Desktop canvas hands it to `CanvasChrome`): the saved stamps,
 * each with its plant and species counts, and a way back to copying an object
 * from the map. Choosing arms the stamp and gives the map focus back; Esc
 * closes the chooser. Stamps saved before 2.0 are left out: Canopi 2.0 cannot
 * place them, and Favorites offers to delete them.
 */
export function StampChooser({ onChosen, onEscape }: StampChooserProps) {
  const library = savedObjectStampWorkbench.library.value
  const stamps = library.items.filter((stamp) => !isSavedObjectStampPayloadFromBefore2_0(stamp.payload_json))
  const root = useRef<HTMLDivElement | null>(null)
  const listId = 'tool-card-stamp-options'

  const [loaded, setLoaded] = useState(false)

  // Read the list afresh each time: stamps may have been saved or imported since.
  useEffect(() => {
    let live = true
    void savedObjectStampWorkbench.loadLibrary().finally(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [])
  // Once read, focus the first stamp (or Copy an object on the map when there is none).
  useEffect(() => {
    if (loaded) root.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [loaded])

  function choose(stamp: SavedObjectStamp): void {
    if (savedObjectStampWorkbench.placeStamp(stamp, 'card')) onChosen()
  }

  function copyFromMap(): void {
    // Leaving and re-arming Place a stamp drops what it held, so the next click picks an object.
    armCanvasTool('select', { from: 'card' })
    armCanvasTool('object-stamp', { from: 'card' })
    onChosen()
  }

  function handleKeyDown(event: TargetedKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onEscape()
  }

  return (
    <div ref={root} className={styles.chooser} data-stamp-chooser onKeyDown={handleKeyDown}>
      <section id={listId} className={styles.options} aria-label={t('savedObjectStamps.title')}>
        <h3 className={styles.section}>{t('savedObjectStamps.title')}</h3>
        {library.loading && stamps.length === 0
          ? <p className={styles.empty}>{t('savedObjectStamps.loading')}</p>
          : stamps.length === 0
            ? <p className={styles.empty}>{t('canvas.toolCard.noSavedStamps')}</p>
            : (
              <ul className={styles.optionList}>
                {stamps.map((stamp) => (
                  <li key={stamp.id}>
                    <button type="button" className={`${styles.option} ${styles.stampOption}`} data-stamp-option={stamp.id} onClick={() => choose(stamp)}>
                      <span className={styles.stampGlyph} aria-hidden="true"><ToolIcon name="object-stamp" /></span>
                      <span className={styles.optionNames}>
                        <span className={styles.optionName}>{stamp.name.trim() || t('canvas.toolCard.untitledStamp')}</span>
                        <span className={styles.optionLatin}>{stampSummary(stamp)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </section>
      <button type="button" className={styles.catalogLink} onClick={copyFromMap}>
        {t('canvas.toolCard.copyFromMap')}
      </button>
    </div>
  )
}

/** "10 plants · 4 species", or what else the stamp holds when it has no plants. */
function stampSummary(stamp: SavedObjectStamp): string {
  const payload = parseSavedObjectStampPayload(stamp.payload_json)
  if (!payload) return t('savedObjectStamps.summaryUnavailable')
  const plants = payload.plants.length
  if (plants === 0) {
    const parts = [
      payload.zones.length > 0 ? t('canvas.toolCard.zones', { count: payload.zones.length }) : null,
      payload.annotations.length > 0 ? t('canvas.toolCard.notes', { count: payload.annotations.length }) : null,
    ].filter(Boolean)
    return parts.length > 0 ? parts.join(' · ') : t('savedObjectStamps.summaryEmpty')
  }
  const plantText = t('canvas.toolCard.plants', { count: plants })
  if (plants === 1) return plantText
  const species = new Set(payload.plants.map((plant) => plant.canonicalName)).size
  return `${plantText} · ${t('canvas.toolCard.species', { count: species })}`
}
