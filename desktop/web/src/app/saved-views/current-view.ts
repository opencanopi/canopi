// The current-view seam shared by saved views and stories: whether views can
// be shown, what the map shows now as a view, and going to a view (camera only).

import { geographicViewOfCamera } from '../../geo/session-plane'
import {
  currentCanvasQuerySurface,
  getCurrentCanvasCommandSurface,
} from '../../canvas/session'
import type { CanopiFile, SavedView } from '../../types/design'
import { currentDesign } from '../document-session/store'
import { mapLayers } from '../map-layers/state'
import { currentPlantDisplay } from '../plant-display/state'
import { savedViewZoom } from '../../canvas/saved-view-framing'
import { composeSavedView } from './model'

/** The views of the open Design, in saved order. */
export function currentSavedViews(): readonly SavedView[] {
  return currentDesign.value?.views ?? []
}

/** A view can be saved or shown while a Design is open on a map with a settled frame. */
export function canShowSavedViews(): boolean {
  const queries = currentCanvasQuerySurface.value
  return currentDesign.value !== null && queries?.sessionPlane.value != null
}

/**
 * Captures what the map shows now as a view (not yet saved): camera and the
 * ground the whole map shows, map background and terrain, visible Design
 * layers and site data, the focused species, the selection and the plant label
 * choice.
 */
export function captureCurrentView({ id, name, title = '' }: {
  readonly id: string
  readonly name: string
  readonly title?: string
}): SavedView | null {
  const queries = currentCanvasQuerySurface.value
  const plane = queries?.sessionPlane.value
  const design = currentDesign.value
  const trimmed = name.trim()
  if (!queries || !plane || !design || trimmed.length === 0) return null
  // What is on screen now: the live frame, not the settled camera.
  const capture = queries.view.captureView()
  return composeSavedView({
    id,
    name: trimmed,
    title: title.trim() || null,
    view: geographicViewOfCamera(capture.camera),
    screen: capture.screen,
    mapLayers: mapLayers.value,
    sceneLayers: queries.getSceneSnapshot().layers,
    siteData: shownSiteData(design.lidar),
    focusedSpecies: queries.getSpeciesFocus().canonicalName,
    selection: queries.getSelection(),
    labels: currentPlantDisplay.peek().labels,
  })
}

/**
 * Site data entries with their effective visibility: the stored own eye and
 * Site data eye folded as the presentation join folds them
 * (`readLidarPresentation`'s `shown`), which shared Web code may not import.
 */
function shownSiteData(section: CanopiFile['lidar']): { id: string; visible: boolean }[] {
  return section ? section.entries.map((entry) => ({ id: entry.id, visible: entry.visible && section.visible })) : []
}

/**
 * Goes to a saved view: session state only, never a Design edit. The camera
 * flies there (the camera driver jumps under reduced motion; a refit asks for a
 * jump) to the view's centre and bearing, never snapped, at the zoom that fits
 * its framed ground into the whole map: the same window gives the exact saved
 * camera, a smaller one zooms out until nothing framed is cut off, a larger
 * one never zooms in past the saved zoom (spec §4.10, one framing rule with
 * its thumbnails); objects never move. Background, layer and highlight
 * overrides belong to presenting a story, which applies them on top of this
 * and restores the user's state when it ends.
 */
export function goToSavedView(id: string, motion: 'fly' | 'jump' = 'fly'): boolean {
  const view = currentSavedViews().find((entry) => entry.id === id)
  const commands = getCurrentCanvasCommandSurface()
  const queries = currentCanvasQuerySurface.peek()
  if (!view || !commands || !queries || !canShowSavedViews()) return false
  const { lon, lat, zoom, bearing } = view.camera
  if (![lon, lat, zoom, bearing].every(Number.isFinite)) return false
  commands.viewport.showCamera(
    {
      center: { lon, lat },
      zoom: savedViewZoom(view.camera, queries.view.captureView().screen),
      bearingDeg: bearing,
      pitchDeg: 0,
    },
    { motion },
  )
  return true
}
