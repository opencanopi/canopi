/**
 * A GeoJSON overlay the map draws in the interaction-overlay band: one source and its layers. The Site data
 * pin and profile line, and the profile's hover ring each build one (architecture review, finding 7).
 */
interface MapOverlayContract {
  readonly source: {
    readonly id: string
    readonly type: 'geojson'
    readonly data: { readonly type: 'FeatureCollection'; readonly features: readonly unknown[] }
  }
  readonly layers: readonly { readonly id: string; readonly paint: Readonly<Record<string, unknown>> }[]
  readonly hasRenderableFeatures: boolean
}

/** The ids an overlay owns, removed back to front when it clears. */
interface MapOverlayIds {
  readonly sourceId: string
  readonly layerIds: readonly string[]
}

interface MapLibreGeoJsonSource {
  setData(data: MapOverlayContract['source']['data']): void
}

export interface MapLibreOverlayMap {
  addSource(id: string, source: Record<string, unknown>): void
  getSource(id: string): MapLibreGeoJsonSource | undefined
  removeSource(id: string): void
  addLayer(layer: Record<string, unknown>): void
  getLayer(id: string): unknown
  removeLayer(id: string): void
  setPaintProperty?(layerId: string, name: string, value: unknown): void
}

/**
 * The data each overlay source was last given, by source: a re-sync that projects the same ground (a settled camera, a repaint)
 * leaves the source alone, so an overlay changes only with its contents, the Scene or the plane.
 */
const sourceData = new WeakMap<MapLibreGeoJsonSource, string>()

export function clearMapOverlay(map: MapLibreOverlayMap, ids: MapOverlayIds): void {
  for (const layerId of [...ids.layerIds].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  if (map.getSource(ids.sourceId)) map.removeSource(ids.sourceId)
}

/**
 * Draws one overlay: its source changes with one `setData` when the contents changed, missing layers are added, and present
 * ones take the contract's paint. With nothing to draw it clears by the contract's own ids.
 */
export function syncMapOverlay(map: MapLibreOverlayMap, overlay: MapOverlayContract): void {
  if (!overlay.hasRenderableFeatures) {
    clearMapOverlay(map, { sourceId: overlay.source.id, layerIds: overlay.layers.map((layer) => layer.id) })
    return
  }

  const data = JSON.stringify(overlay.source.data)
  const existingSource = map.getSource(overlay.source.id)
  if (existingSource) {
    if (sourceData.get(existingSource) !== data) {
      existingSource.setData(overlay.source.data)
      sourceData.set(existingSource, data)
    }
  } else {
    // The id names the source; MapLibre rejects it inside the specification.
    const { id, ...specification } = overlay.source
    map.addSource(id, specification as unknown as Record<string, unknown>)
    const added = map.getSource(id)
    if (added) sourceData.set(added, data)
  }

  for (const layer of overlay.layers) {
    if (!map.getLayer(layer.id)) {
      map.addLayer(layer as unknown as Record<string, unknown>)
      continue
    }
    // The contract reads the current canvas colours; a layer added under
    // another theme or backdrop takes them without being re-added. MapLibre
    // ignores a paint value equal to the current one.
    for (const [name, value] of Object.entries(layer.paint)) map.setPaintProperty?.(layer.id, name, value)
  }
}
