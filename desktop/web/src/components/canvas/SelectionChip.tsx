import { canvasCommandDefinitions } from '../../app/canvas-commands'
import { useMapSelectionSummary, type MapSelectionSummary } from '../../app/map-selection/summary'
import { describeMapSelection } from '../../app/map-selection/summary-text'
import { ariaKeyShortcuts } from '../../app/shell-commands/shortcut-text'
import { openInspector } from '../../app/planning-view/state'
import { loneEditableZoneId, openRenameZoneDialog } from '../../app/rename-zone/state'
import { currentCanvasQuerySurface, currentCanvasSceneEditCommandSurface } from '../../canvas/session'
import { locale, unitSystem } from '../../app/settings/state'
import { t } from '../../i18n'
import { SpeciesCommonName } from '../shared/SpeciesIdentity'
import styles from './SelectionChip.module.css'

/**
 * The bottom status chip that names the map selection ("Apricot", "12 plants ·
 * 3 species · 0.52 m apart", "Zone · Z04 · 118 m² · 46 m", "Rectangle zone ·
 * 120 m² · 44 m") in the visible map area, above the view chip and
 * the zoom group, so it never meets the top finder chip. It reads the
 * selection through read-only runtime queries and offers Select all of this
 * species, Rename… for a lone zone and Clear selection; the rest lives in the
 * right-click menu. On a phone it is the context bar's (`placement="bar"`,
 * PhoneContextBar): one line, its text ellipsised and its buttons' labels short.
 */
const SELECT_SAME_SPECIES = canvasCommandDefinitions.find((definition) =>
  definition.kind === 'edit' && definition.id === 'select-same-species')!

export function SelectionChip({ placement = 'map' }: {
  /** At the bottom of the visible map, or in the phone's context bar. */
  readonly placement?: 'map' | 'bar'
} = {}) {
  const summary = useMapSelectionSummary()
  const queries = currentCanvasQuerySurface.value
  const overview = queries?.view.mode.value === 'overview'
  if (!summary || overview) return null
  const { head, headEnglishFallback, details } = describeMapSelection(summary, locale.value, unitSystem.value)
  const [only] = summary.species
  const wholeSpecies = summary.species.length === 1 && isOnlyPlants(summary) && only!.selectedCount < only!.designCount
  // The summary hook re-renders the chip on selection and scene changes (locks included).
  const selectionModel = queries?.getDesignObjectSelection() ?? null
  const renameZoneId = loneEditableZoneId(selectionModel)
  const canInspect = canInspectSelection(selectionModel)
  const bar = placement === 'bar'
  return (
    <div className={styles.chip} role="group" aria-label={t('canvas.selectionChip.label')} data-selection-chip={bar ? 'bar' : 'bottom'}>
      <span className={styles.text} role="status" aria-live="polite">
        <b><SpeciesCommonName name={head} englishFallback={headEnglishFallback} /></b>
        {details.map((detail, index) => (
          <span key={index} className={detail.measure ? `${styles.muted} ${styles.measure}` : styles.muted}>
            {' · '}<SpeciesCommonName name={detail.text} englishFallback={detail.englishFallback} />
          </span>
        ))}
      </span>
      {wholeSpecies && (
        <button
          type="button"
          className={styles.button}
          aria-keyshortcuts={SELECT_SAME_SPECIES.shortcuts?.[0] ? ariaKeyShortcuts(SELECT_SAME_SPECIES.shortcuts[0]) : undefined}
          onClick={() => currentCanvasSceneEditCommandSurface.value?.selectSpecies([only!.canonicalName])}
        >
          {t(bar ? 'canvas.selectionChip.sameSpeciesShort' : SELECT_SAME_SPECIES.labelKey)}
        </button>
      )}
      {canInspect && (
        <button
          type="button"
          className={styles.button}
          data-open-inspector
          onClick={() => openInspector()}
        >
          {t(bar ? 'canvas.selectionChip.dimensionsShort' : 'canvas.selectionChip.dimensions')}
        </button>
      )}
      {renameZoneId !== null && (
        <button
          type="button"
          className={styles.button}
          aria-haspopup="dialog"
          onClick={() => openRenameZoneDialog({
            zoneId: renameZoneId,
            name: summary.zones[0]?.name ?? null,
            rename: (zoneId, name) => currentCanvasSceneEditCommandSurface.value?.renameZone(zoneId, name),
          })}
        >
          {t('canvas.selectionChip.rename')}
        </button>
      )}
      <button
        type="button"
        className={styles.quiet}
        onClick={() => currentCanvasSceneEditCommandSurface.value?.clearSelection()}
      >
        {t(bar ? 'canvas.selectionChip.clearShort' : 'canvas.selectionChip.clear')}
      </button>
    </div>
  )
}

function canInspectSelection(
  selectionModel: ReturnType<NonNullable<typeof currentCanvasQuerySurface.value>['getDesignObjectSelection']> | null,
): boolean {
  const targets = selectionModel?.editableTargets ?? []
  if (targets.length === 1) return targets[0]?.kind !== 'group'
  return targets.length > 1 && targets.every((target) => target.kind === 'plant')
}

function isOnlyPlants(summary: MapSelectionSummary): boolean {
  return summary.zones.length === 0 && summary.noteCount === 0 && summary.measurementCount === 0
}
