import { selectPanel, type Panel } from '../../app/shell/state'

export const GALLERY_SURFACES = {
  workspace: 'Workspace',
  start: 'Start',
  color: 'Plant color',
  symbol: 'Plant symbol',
  'menu-plant': 'Menu · plants',
  'menu-mixed': 'Menu · mixed',
  'menu-empty': 'Menu · empty map',
  symbols: 'Symbol sheet',
  key: 'Species key',
  layers: 'Layers',
  'site-data': 'Site data',
  library: 'Data library',
  import: 'Import data',
  analyze: 'Analyze',
  calendar: 'Calendar',
  'calendar-expanded': 'Calendar expanded',
  budget: 'Budget',
  consortium: 'Consortium',
  stories: 'Stories',
  favorites: 'Favorites',
  notebook: 'Design notebook',
  lens: 'Inspection lens',
  snapshots: 'View snapshots',
  location: 'Location button',
} as const

export type GallerySurface = keyof typeof GALLERY_SURFACES

export function parseGallerySurface(value: string | null): GallerySurface {
  if (value && value in GALLERY_SURFACES) return value as GallerySurface
  return 'color'
}

/**
 * `surface=location&location=<state>`: the Web zoom group's Show my location in one state (canopi-f47t.53), drawn from
 * the state alone, with no device location. `stale` is Following with the position unavailable.
 */
export const GALLERY_LOCATION_STATES = ['off', 'following', 'moved-away', 'blocked', 'stale'] as const

export type GalleryLocationState = typeof GALLERY_LOCATION_STATES[number]

export function parseGalleryLocationState(value: string | null): GalleryLocationState {
  return GALLERY_LOCATION_STATES.find((state) => state === value) ?? 'following'
}

export function selectGalleryPanel(surface: GallerySurface): void {
  selectPanel(panelForGallerySurface(surface))
}

function panelForGallerySurface(surface: GallerySurface): Panel {
  switch (surface) {
    case 'key': return 'species-key'
    case 'site-data': return 'site-data'
    case 'layers':
    case 'library':
    case 'import':
    case 'analyze': return 'layers'
    case 'favorites': return 'favorites'
    case 'notebook': return 'design-notebook'
    case 'calendar':
    case 'calendar-expanded': return 'calendar'
    case 'budget': return 'budget'
    case 'consortium': return 'consortium'
    case 'stories': return 'stories'
    default: return 'canvas'
  }
}
