/**
 * Read-only view of the settings-owned map-layers slice so `app/story-presentation/`
 * reads through the existing `story-presentation -> map-layers` area edge rather
 * than adding a cross-area edge to `app/settings/` (2.1-M137).
 */
export { mapLayers, type MapLayersState } from '../settings/state'
