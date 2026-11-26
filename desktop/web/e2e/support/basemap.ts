import type { Page, Route } from '@playwright/test'

/** OpenFreeMap style URL pattern routed by offline canvas e2e specs. */
export const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/**'

/** Inline credits matching OpenFreeMap's real style attribution. */
export const BASEMAP_CREDITS =
  '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">© OpenMapTiles</a>'
  + ' Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

export interface MinimalBasemapOptions {
  /** Attribution HTML attached to the inline GeoJSON source; defaults to `BASEMAP_CREDITS`. */
  readonly attribution?: string | null
  /** Optional sprite URL (e.g. to trigger an offline resource failure while keeping inline credits). */
  readonly sprite?: string
  /** Optional callback fired for each intercepted style request. */
  readonly onRequest?: () => void
}

/** Minimal valid MapLibre style JSON with no external tiles, for offline e2e tests. */
export function minimalBasemapStyle(options: Pick<MinimalBasemapOptions, 'attribution' | 'sprite'> = {}) {
  const attribution = options.attribution === undefined ? BASEMAP_CREDITS : options.attribution
  return {
    version: 8,
    ...(options.sprite ? { sprite: options.sprite } : {}),
    sources: {
      openmaptiles: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        ...(attribution ? { attribution } : {}),
      },
    },
    layers: [{ id: 'water', type: 'fill', source: 'openmaptiles', paint: { 'fill-color': '#a0c8f0' } }],
  }
}

/** Intercepts OpenFreeMap style requests on `page` and answers with a minimal offline style. */
export async function routeMinimalBasemap(page: Page, options: MinimalBasemapOptions = {}): Promise<void> {
  const body = JSON.stringify(minimalBasemapStyle(options))
  await page.route(BASEMAP_STYLE_URL, (route) => {
    options.onRequest?.()
    return route.fulfill({ contentType: 'application/json', body })
  })
}

/** Holds OpenFreeMap style requests until the caller releases them via `fallback()`. */
export async function holdBasemapStyle(page: Page): Promise<Route[]> {
  const held: Route[] = []
  await page.route(BASEMAP_STYLE_URL, (route) => { held.push(route) })
  return held
}
