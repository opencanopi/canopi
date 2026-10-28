// maplibre/site-overlay.ts
//
// The Site data pin and profile line on the map (canopi-f47t.42, spec §1.10; plan §4 "Map overlay route"; stream C
// builds it): a pure contract from the overlay snapshot's `site` (lon/lat) to one GeoJSON source and its layers in the
// interaction-overlay band, drawn by the generalised overlay sync with its own skip key. The pin is a two-tone dot (ink
// core, white ring) in fixed colours; the line, a light line on the draft casing with vertex dots, takes
// scene-visuals.ts's guide colours. The chart hover never rides the snapshot: it is one setData on its own source
// (WorkspaceMapContributions.setSiteHover). No setters.

import {
  getGuideLineVisual,
  getMapBackdropInk,
  OVERLAY_CASING_EXTRA_PX,
  SITE_PIN_VISUAL,
} from '../canvas/runtime/scene-visuals'

/** The overlay snapshot's Site data part, in [lon, lat]; null on Web and in overview. */
export interface SiteMapOverlay {
  readonly pin: readonly [number, number] | null
  readonly profileLine: readonly (readonly [number, number])[] | null
}

interface SiteMapOverlayFeature {
  readonly type: 'Feature'
  readonly geometry:
    | { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
    | { readonly type: 'LineString'; readonly coordinates: readonly (readonly [number, number])[] }
  readonly properties: { readonly role: 'pin' | 'profile-line' | 'profile-vertex' }
}

interface SiteMapOverlayLayer {
  readonly id: string
  readonly source: string
  readonly type: 'circle' | 'line'
  readonly filter: readonly unknown[]
  readonly paint: Readonly<Record<string, string | number>>
}

export interface SiteMapOverlayContract {
  readonly source: {
    readonly id: string
    readonly type: 'geojson'
    readonly data: { readonly type: 'FeatureCollection'; readonly features: readonly SiteMapOverlayFeature[] }
  }
  readonly layers: readonly SiteMapOverlayLayer[]
  readonly hasRenderableFeatures: boolean
}

/**
 * The ids the map seam registers in the interaction-overlay band, back to front: the pin and line's source and layers, then
 * the chart hover's own source and ring (one setData per scrub, never the snapshot).
 */
export function siteMapOverlayIds() {
  return {
    sourceId: 'site-overlay-source',
    layerIds: [
      'site-profile-casing',
      'site-profile-line',
      'site-profile-vertices',
      'site-pin-ring',
      'site-pin-core',
    ] as const,
    hover: {
      sourceId: 'site-hover-source',
      layerIds: ['site-hover-ring'] as const,
    },
  }
}

/** The profile line's width in CSS px; its casing is `OVERLAY_CASING_EXTRA_PX` wider, as guides and drafts. */
const PROFILE_LINE_WIDTH_PX = 2
const PROFILE_VERTEX_RADIUS_PX = 3
const PIN_CORE_RADIUS_PX = 4
const PIN_RING_RADIUS_PX = 7
const HOVER_RING_RADIUS_PX = 6
const HOVER_RING_WIDTH_PX = 2.5

/** Whether a GeoJSON position, [lon, lat] in degrees (the wire form, no point type), is finite. */
function finite(point: readonly [number, number]): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1])
}

function roleFilter(role: SiteMapOverlayFeature['properties']['role']): readonly unknown[] {
  return ['==', ['get', 'role'], role]
}

export function siteMapOverlayContract(site: SiteMapOverlay | null): SiteMapOverlayContract {
  const ids = siteMapOverlayIds()
  const features: SiteMapOverlayFeature[] = []
  const line = site?.profileLine
  if (line && line.length >= 2 && line.every(finite)) {
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { role: 'profile-line' } })
    for (const vertex of line) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: vertex }, properties: { role: 'profile-vertex' } })
    }
  }
  const pin = site?.pin
  if (pin && finite(pin)) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pin }, properties: { role: 'pin' } })
  }
  const guide = getGuideLineVisual()
  const [casing, profile, vertices, ring, core] = ids.layerIds
  return {
    source: { id: ids.sourceId, type: 'geojson', data: { type: 'FeatureCollection', features } },
    layers: [
      {
        id: casing,
        source: ids.sourceId,
        type: 'line',
        filter: roleFilter('profile-line'),
        paint: { 'line-color': guide.casing, 'line-width': PROFILE_LINE_WIDTH_PX + OVERLAY_CASING_EXTRA_PX },
      },
      {
        id: profile,
        source: ids.sourceId,
        type: 'line',
        filter: roleFilter('profile-line'),
        paint: { 'line-color': guide.color, 'line-width': PROFILE_LINE_WIDTH_PX },
      },
      {
        id: vertices,
        source: ids.sourceId,
        type: 'circle',
        filter: roleFilter('profile-vertex'),
        paint: {
          'circle-radius': PROFILE_VERTEX_RADIUS_PX,
          'circle-color': guide.color,
          'circle-stroke-color': guide.casing,
          'circle-stroke-width': OVERLAY_CASING_EXTRA_PX / 2,
        },
      },
      {
        id: ring,
        source: ids.sourceId,
        type: 'circle',
        filter: roleFilter('pin'),
        paint: { 'circle-radius': PIN_RING_RADIUS_PX, 'circle-color': SITE_PIN_VISUAL.ring },
      },
      {
        id: core,
        source: ids.sourceId,
        type: 'circle',
        filter: roleFilter('pin'),
        paint: { 'circle-radius': PIN_CORE_RADIUS_PX, 'circle-color': SITE_PIN_VISUAL.core },
      },
    ],
    hasRenderableFeatures: features.length > 0,
  }
}

export interface SiteHoverOverlayContract {
  readonly source: {
    readonly id: string
    readonly type: 'geojson'
    readonly data: { readonly type: 'FeatureCollection'; readonly features: readonly SiteMapOverlayFeature[] }
  }
  readonly layers: readonly SiteMapOverlayLayer[]
  readonly hasRenderableFeatures: boolean
}

/**
 * The profile chart's hover point ([lon, lat]) as a hollow ring in the backdrop ink on its own source, so a scrub is one setData
 * (GeoLibre `NativeProfileMap.setHover`); null draws nothing.
 */
export function siteHoverOverlayContract(hover: readonly [number, number] | null): SiteHoverOverlayContract {
  const ids = siteMapOverlayIds().hover
  const features: SiteMapOverlayFeature[] = hover && finite(hover)
    ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: hover }, properties: { role: 'pin' } }]
    : []
  const ink = getMapBackdropInk()
  return {
    source: { id: ids.sourceId, type: 'geojson', data: { type: 'FeatureCollection', features } },
    layers: [{
      id: ids.layerIds[0],
      source: ids.sourceId,
      type: 'circle',
      filter: roleFilter('pin'),
      paint: {
        'circle-radius': HOVER_RING_RADIUS_PX,
        'circle-color': ink.halo,
        'circle-opacity': 0,
        'circle-stroke-color': ink.text,
        'circle-stroke-width': HOVER_RING_WIDTH_PX,
      },
    }],
    hasRenderableFeatures: features.length > 0,
  }
}
