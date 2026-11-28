import { useEffect } from 'preact/hooks'
import { TOOL_ROWS } from '../../app/command-table'
import { phoneToolOptions } from '../../app/shell/phone-layout'
import { useMapSelectionSummary } from '../../app/map-selection/summary'
import {
  currentCanvasQuerySurface,
  currentCanvasTool,
  currentCanvasToolGuidance,
  currentCanvasToolState,
} from '../../canvas/session'
import { OverviewNotice } from './CanvasOverview'
import { BarMapNotice } from './MapNotice'
import { PlantLabelsChip } from './PlantLabelsChip'
import { SelectionChip } from './SelectionChip'
import { plantsHighlighted, SpeciesFocusChip } from './SpeciesFocusChip'
import { PhoneToolRow } from './ToolCard'
import styles from './PhoneContextBar.module.css'

/**
 * The phone's context bar (answers 18 and 22-26): what the map's context shows on a phone, as the panel sheet's first
 * row (PhoneSheet `bar`), so it moves with the sheet and the sheet's one registration with the visible-map-area seam
 * covers it; on a phone nothing else floats over the map but the zoom column. The map notice, with its Retry, is a
 * status row on top of the bar, shown with whatever it holds (answer 24). It shows one context, never two, the first
 * that holds: in overview its notice; the armed tool's row (any tool but Select and Pan; one touch row, answer 30); the
 * selection (the selection chip, one line); the highlighted plants (the highlight chip); the labels chip's few seconds
 * after the labels change; else nothing. The tool's row stays mounted under Select and Pan, showing nothing, so its live
 * region announces the next tool, and the labels chip stays mounted, so its window runs while another context shows.
 * Phones are the Web Edition's; the edition renders the bar only while a Design is open, and the sheet steps aside while
 * "Where is your site?" or a story is shown.
 *
 * The bar owns when the tool's options open and close by themselves (answer 30): Place plants with no species chosen
 * is its chooser, so arming it (or coming back to it from the overview), or each tap on the map that asks for a species
 * first, opens them at half; another tool, the overview and the bar going with the Design close them, which gives the
 * sheet back its panel as it was.
 */
export function PhoneContextBar() {
  const tool = currentCanvasTool.value
  const toolSource = currentCanvasToolState.value.source
  const row = TOOL_ROWS[tool]
  const summary = useMapSelectionSummary()
  const overview = currentCanvasQuerySurface.value?.view.mode.value === 'overview'
  const card = !overview && !row.hidePhoneCard
  const selection = !overview && !card && summary !== null
  const highlight = !overview && !card && !selection && plantsHighlighted()
  const speciesPrompts = currentCanvasToolGuidance.value.speciesPrompts
  const hasSpecies = toolSource?.kind === 'species'
  // The overview has no tool's row, so no Options to close them with.
  useEffect(() => {
    phoneToolOptions.value = card && row.requiresSource === 'species' && !hasSpecies ? 'half' : null
  }, [tool, card, row.requiresSource, hasSpecies])
  useEffect(() => {
    if (speciesPrompts > 0) phoneToolOptions.value = 'half'
  }, [speciesPrompts])
  useEffect(() => () => { phoneToolOptions.value = null }, [])
  return (
    <>
      <BarMapNotice />
      {overview && <div className={styles.row}><OverviewNotice /></div>}
      <PhoneToolRow />
      {!card && <SelectionChip placement="bar" />}
      {highlight && <div className={styles.row}><SpeciesFocusChip /></div>}
      <div className={styles.row}><PlantLabelsChip hidden={overview || card || selection || highlight} /></div>
    </>
  )
}
