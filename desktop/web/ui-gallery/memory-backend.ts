import { signal } from '@preact/signals'
import type { SavedObjectStamp } from '../src/types/saved-object-stamps'
import {
  LIDAR_SAMPLE_MAX_POINTS,
  LIDAR_SAMPLE_MAX_TARGETS,
  type AnalysisOffer,
  type AnalysisRequest,
  type LibraryItemSummary,
  type LidarImportJob,
  type LidarSamplePointsRequest,
  type LidarSampleSeries,
  type ProcessingRun,
  type RasterQuantity,
  type DesignSketch,
  type RecentDesignPreview,
  type SpeciesListItem,
  type SpeciesSearchRequest,
} from '../src/generated/contracts'
import rasterDisplayCogUrl from '../src/maplibre/raster-display/fixtures/rust-display-cog.tif?url'
import rasterDisplayReliefUrl from '../src/maplibre/raster-display/fixtures/rust-display-relief.tif?url'
import {
  appleDetail,
  applePhotos,
  detail,
  designFixture,
  drawnPhoto,
  frenchNames,
  galleryLongSiteDataNames,
  galleryRasterSite,
  species,
  specimens,
} from './fixtures'

const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'populated'
/** `sampleDelay=<ms>`: each lidar_sample_points answer waits this long, so a superseded answer can be seen never to land. */
const sampleDelayMs = Math.max(0, Number(params.get('sampleDelay')) || 0)
const favoriteNames = new Set(state === 'empty' ? [] : species.map(plant => plant.canonical_name))
const file = designFixture()
let sequence = 3
/** The failed import each running Retry replaced, restored if that Retry is cancelled. */
const retriedImports = new Map<string, LidarImportJob>()
let stamps: SavedObjectStamp[] = state === 'empty' ? [] : ['Orchard guild', 'Pollinator border'].map((name, index) => ({
  id: `stamp-${index}`, name: state === 'long' ? name + ' — a reusable arrangement with a particularly long descriptive name' : name, sort_order: index,
  // A current (v2) payload in metres about its anchor: three plants in a bed, so a turned stamp shows its angle.
  payload_json: JSON.stringify({
    version: 2,
    anchor: { x: 0, y: 0 },
    plants: file.plants.slice(index * 3, index * 3 + 3).map((plant, slot) => ({ id: plant.id, canonicalName: plant.canonical_name, commonName: plant.common_name, position: { x: slot * 1.2 - 1.2, y: (slot % 2) * 0.8 }, color: null, rotationDeg: null, scale: null })),
    zones: [{ id: `stamp-${index}-bed`, name: null, zoneType: 'rect', points: [{ x: -2, y: -0.8 }, { x: 2, y: -0.8 }, { x: 2, y: 1.6 }, { x: -2, y: 1.6 }], rotationDeg: 0, fillColor: null }],
    annotations: [],
    groups: [],
  }),
  created_at: file.created_at, updated_at: file.updated_at,
}))
// The data covers the west of the fixture Design's site (fixtures.ts, origin 13° E, 23° N): its plants run about 20 m east,
// so a pointer over the east of the planting reads no data.
const lidarBounds: [number, number, number, number] = state !== 'lidar-raster'
  ? [12.9998, 22.9998, 13.0001, 23.0002]
  : galleryRasterSite.bounds
const galleryTool = { engine: 'geolibre', version: 'geolibre-cli 1.5.3 (gallery)', revision: 'aac2b7439786aac2b7439786', tools: ['slope'] }
const galleryCreatedAt = String(Date.UTC(2026, 8, 12, 9, 30))

/** Offers as native computes them for slope: ground elevation that is ready. */
function galleryOffers(item: Pick<LibraryItemSummary, 'role' | 'item_type' | 'state'>): AnalysisOffer[] {
  const unavailable: AnalysisOffer['unavailable'] = item.item_type.quantity !== 'GroundElevation'
    ? { reason: 'WrongInput', expected: [{ kind: 'Raster', quantity: 'GroundElevation' }] }
    : item.state !== 'Ready' ? { reason: 'NotReady' } : null
  return [{ analysis_id: 'terrain.slope', unavailable }]
}

function gallerySource(id: string, name: string, quantity: RasterQuantity, overrides: Partial<LibraryItemSummary> = {}): LibraryItemSummary {
  const [low, high] = state === 'lidar-raster' ? galleryRasterSite.valueRange : [131.2, 287.8]
  const item: LibraryItemSummary = {
    id, name, role: 'Source', item_type: { kind: 'Raster', quantity }, units: 'm', state: 'Ready',
    generation_id: `${id}-g1`, bounds: lidarBounds, value_range: [low, high],
    display_range: { min: low, max: high, basis: 'Exact' }, resolution_m: 0.5, coverage_cells: '4000000',
    import_job: null, provenance: null, freshness: { state: 'Current' }, run: null, offers: [], dependents: 0,
    created_at: galleryCreatedAt,
    ...overrides,
  }
  return { ...item, offers: galleryOffers(item) }
}

function gallerySlope(id: string, input: string, unit: 'degrees' | 'percent', overrides: Partial<LibraryItemSummary> = {}): LibraryItemSummary {
  const item: LibraryItemSummary = {
    id, name: null, role: 'Derived', item_type: { kind: 'Raster', quantity: 'Slope' }, units: unit === 'percent' ? '%' : '°',
    state: 'Ready', generation_id: `${id}-g1`, bounds: lidarBounds, value_range: unit === 'percent' ? [0, 89.4] : [0, 41.6],
    display_range: null, resolution_m: 0.5, coverage_cells: '3996004', import_job: null,
    provenance: {
      definition_id: `${id}-def`, analysis_id: 'terrain.slope', recipe_version: 1, output_key: 'slope',
      inputs: [{ key: 'dem', item_id: input, generation_id: `${input}-g1` }],
      parameters: [{ key: 'unit', value: { Choice: unit } }],
      tool: galleryTool, job_id: `${id}-job`, created_at: galleryCreatedAt,
    },
    freshness: { state: 'Current' }, run: { job_id: `${id}-job`, state: 'Complete', message: null }, offers: [], dependents: 0,
    created_at: galleryCreatedAt,
    ...overrides,
  }
  return { ...item, offers: galleryOffers(item) }
}

let lidarItems: LibraryItemSummary[] = state === 'empty' || state === 'no-design' ? [] : [
  gallerySource('lidar-ground', state === 'long'
    ? 'IGN bare-earth elevation — La Maignannerie regional survey comparison layer'
    : 'IGN ground elevation', 'GroundElevation', { dependents: 2 }),
  gallerySlope('lidar-slope', 'lidar-ground', 'degrees'),
  gallerySlope('lidar-slope-percent', 'lidar-ground', 'percent', {
    name: 'Orchard gradient',
    freshness: { state: 'Stale', reasons: [{ reason: 'ToolUpdated', from: 'geolibre-cli 1.5.2', to: 'geolibre-cli 1.5.3' }] },
  }),
]
// `state=long`: a 40-item library, one added each day before the three above, for the large library sheet.
if (state === 'long') {
  lidarItems = [...lidarItems, ...Array.from({ length: 37 }, (_, index) => gallerySource(
    `lidar-tile-${index + 1}`,
    `IGN LiDAR HD MNT tile 0470_${6800 + index}`,
    index % 5 === 4 ? 'SurfaceElevation' : 'GroundElevation',
    { created_at: String(Date.UTC(2026, 8, 11 - index, 9, 30)) },
  ))]
}
// `state=lidar-long`: the nine more Site data entries of the Design (fixtures.ts).
if (state === 'lidar-long') {
  lidarItems = [...lidarItems, ...galleryLongSiteDataNames.map((name, index) => gallerySource(
    `lidar-block-${index + 1}`, name,
    name.startsWith('Canopy') ? 'AboveGroundHeight' : name.startsWith('Surface') ? 'SurfaceElevation' : 'GroundElevation',
  ))]
}
function galleryImport(layerId: string, name: string, quantity: RasterQuantity, job: Partial<LidarImportJob>): LibraryItemSummary {
  const failed = job.state === 'Failed'
  return gallerySource(layerId, name, quantity, {
    generation_id: null, state: failed ? 'Failed' : 'Preparing', resolution_m: null, coverage_cells: null,
    bounds: null, value_range: null, display_range: null,
    import_job: { job_id: `job-${layerId}`, layer_id: layerId, state: 'Staging', message: null, progress: { phase: 'PreparingRaster', percent: 42 }, ...job },
  })
}
if (state === 'lidar-progress') {
  lidarItems = [...lidarItems,
    galleryImport('lidar-canopy', 'Canopy height 2024', 'AboveGroundHeight', { state: 'Applying', progress: { phase: 'RenderingMap', percent: 68 } }),
    galleryImport('lidar-broken', 'Survey tile 0712', 'SurfaceElevation', { state: 'Failed', message: 'The file is not a readable raster.', progress: null }),
    gallerySlope('lidar-slope-running', 'lidar-ground', 'percent', {
      name: 'Terrace slope', generation_id: null, state: 'Preparing', value_range: null, coverage_cells: null,
      run: { job_id: 'lidar-slope-running-job', state: 'Preparing', message: null },
    }),
  ]
}
const galleryRuns = new Map<string, ProcessingRun[]>()
function recordRun(item: LibraryItemSummary, at = String(Date.now())): void {
  const provenance = item.provenance!
  galleryRuns.set(provenance.definition_id, [{
    job_id: `job-${sequence++}`, state: 'Complete', message: null, recipe_version: provenance.recipe_version, tool: galleryTool,
    inputs: provenance.inputs, created_at: at, finished_at: at,
    outputs: [{ item_id: item.id, generation_id: item.generation_id ?? '', coverage_cells: item.coverage_cells }],
  }, ...(galleryRuns.get(provenance.definition_id) ?? [])])
}
for (const item of lidarItems) {
  if (item.provenance && item.generation_id) recordRun(item, galleryCreatedAt)
}
function updateItem(id: unknown, change: (item: LibraryItemSummary) => LibraryItemSummary): void {
  lidarItems = lidarItems.map(item => item.id === id ? change(item) : item)
}
export const activity = signal('All changes stay in memory. Reload to reset.')
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
// Start-screen fixtures: dated relative to now so Today and Yesterday read naturally.
const removedRecentPaths = new Set<string>()
function recentDesigns() {
  // First run: no recent Designs and no Drafts.
  if (state === 'empty') return []
  return ([
    { path: '/designs/sanctuaire.canopi', name: "Le Sanctuaire d'Aylin – Verger Syntropique", updated_at: hoursAgo(1) },
    { path: '/designs/haie-nord.canopi', name: 'Haie fruitière nord', updated_at: hoursAgo(26) },
    // An older copy with the same name and file name: the rows name their folders.
    { path: '/designs/2025/haie-nord.canopi', name: 'Haie fruitière nord', updated_at: hoursAgo(24 * 9) },
    { path: '/designs/mare.canopi', name: 'Jardin de la mare', updated_at: hoursAgo(24 * 14) },
    { path: '/designs/ancien-verger.canopi', name: 'Ancien verger (Canopi 1)', updated_at: hoursAgo(24 * 60) },
  ]).filter(design => !removedRecentPaths.has(design.path))
}
/** Deterministic symbolic sketches like the ones native previews derive from a Design's file. */
function gallerySketch(kind: 'orchard' | 'hedge' | 'pond'): DesignSketch {
  const plants: number[] = []
  const zones: DesignSketch['zones'] = []
  if (kind === 'orchard') {
    // 24 beds in a 6 × 4 grid, with plants sampled along their rows.
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        const [x, y] = [20 + column * 162, 20 + row * 150]
        zones.push({ closed: true, points: [x, y, x + 140, y, x + 140, y + 128, x, y + 128] })
        for (let line = 0; line < 4; line += 1) {
          for (let step = 0; step < 20; step += 1) plants.push(x + 6 + step * 6.5, y + 16 + line * 32)
        }
      }
    }
    return { width: 1000, height: 640, plants: plants.map(Math.round), zones }
  }
  if (kind === 'hedge') {
    zones.push({ closed: false, points: [0, 110, 1000, 60] })
    for (let index = 0; index < 64; index += 1) plants.push(Math.round(index * 15.8), Math.round(110 - index * 0.8 + (index % 2) * 12 - 6))
    return { width: 1000, height: 180, plants, zones }
  }
  const pond: number[] = []
  for (let index = 0; index < 16; index += 1) {
    const angle = (index / 16) * Math.PI * 2
    pond.push(Math.round(430 + Math.cos(angle) * 180), Math.round(380 + Math.sin(angle) * 120))
  }
  zones.push({ closed: true, points: pond }, { closed: true, points: [20, 20, 980, 20, 980, 740, 20, 740] })
  for (let index = 0; index < 180; index += 1) {
    const angle = (index / 180) * Math.PI * 2 * 3
    const radius = 240 + (index % 3) * 60
    plants.push(Math.round(430 + Math.cos(angle) * radius * 1.3), Math.round(380 + Math.sin(angle) * radius))
  }
  return { width: 1000, height: 760, plants: plants.map((value, index) => Math.max(0, Math.min(index % 2 ? 760 : 1000, value))), zones }
}
function recentPreview(path: string): RecentDesignPreview {
  const bounds = { west: -0.427, south: 48.305, east: -0.413, north: 48.314 }
  switch (path) {
    case '/designs/sanctuaire.canopi': return { kind: 'read', plant_count: 2201, zone_count: 24, bounds, sketch: gallerySketch('orchard') }
    case '/designs/haie-nord.canopi': return { kind: 'read', plant_count: 64, zone_count: 1, bounds, sketch: gallerySketch('hedge') }
    case '/designs/mare.canopi': return { kind: 'read', plant_count: 180, zone_count: 2, bounds, sketch: gallerySketch('pond') }
    case '/designs/2025/haie-nord.canopi': return { kind: 'unreadable', reason: 'missing' }
    default: return { kind: 'unreadable', reason: 'older_version' }
  }
}
let drafts = state === 'empty' ? [] : [
  { id: 'draft-untitled', name: 'Untitled', updated_at: hoursAgo(24 * 3) },
  { id: 'draft-haie-sud', name: 'Haie sud, essai', updated_at: hoursAgo(24 * 5) },
]
/** The gallery catalog: a few designer species in the Recommended order, then obscure ones. */
const catalogSpecies: SpeciesListItem[] = state === 'empty' ? [] : ([
  ['Malus domestica', 'Apple', 'Tree', 10, 4, 8, 5, 'Temperate'],
  ['Corylus avellana', 'Hazel', 'Shrub', 6, 4, 8, 5, 'Temperate'],
  ['Juglans regia', 'Walnut', 'Tree', 25, 5, 9, 5, 'Temperate'],
  ['Fragaria vesca', 'Wild strawberry', 'Herbaceous', 0.3, 5, 9, 4, 'Temperate'],
  ['Elaeagnus umbellata', 'Autumn olive', 'Shrub', 4.5, 3, 8, 4, 'Continental'],
  ['Mentha spicata', 'Spearmint', 'Herbaceous', 0.9, 3, 7, 3, 'Temperate'],
  ['Robinia pseudoacacia', 'Black locust', 'Tree', 25, 3, 8, 2, 'Temperate'],
  ['Lavandula angustifolia', 'English lavender', 'Shrub', 0.6, 5, 8, 2, 'Mediterranean'],
  ['Actinidia arguta', 'Hardy kiwi', 'Climber', 12, 4, 8, 5, 'Temperate'],
  ['Achillea millefolium', 'Common yarrow', 'Herbaceous', 0.6, 2, 9, null, 'Temperate'],
  ['Aa achalensis', null, null, null, null, null, null, 'Tropical'],
] as const).map(([canonical_name, common_name, habit, height, zoneMin, zoneMax, edibility, zone]) => ({
  ...species[0]!, canonical_name, slug: canonical_name.toLowerCase().replace(/ /g, '-'), common_name, is_name_fallback: false,
  habit, height_max_m: height, hardiness_zone_min: zoneMin, hardiness_zone_max: zoneMax, edibility_rating: edibility,
  climate_zones: [zone], family: null, stratum: null, is_favorite: favoriteNames.has(canonical_name),
}))
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
function searchCatalog(request: SpeciesSearchRequest) {
  const text = fold(request.text.trim())
  const { habit, edibility_min: edibilityMin, climate_zones: zones } = request.filters
  const items = catalogSpecies.filter(plant => (!text || fold(`${plant.common_name ?? ''} ${plant.canonical_name}`).includes(text))
    && (!habit || habit.includes(plant.habit ?? ''))
    && (edibilityMin == null || (plant.edibility_rating ?? -1) >= edibilityMin)
    && (!zones || zones.some(zone => plant.climate_zones.includes(zone))))
  const sorted = request.sort === 'Name' ? [...items].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))
    : request.sort === 'Height' ? [...items].sort((a, b) => (b.height_max_m ?? -1) - (a.height_max_m ?? -1))
      : items
  return { items: sorted.map(plant => localized(plant, request.locale)), total_estimate: request.include_total ? sorted.length : 0, next_cursor: null }
}
/** Rows carry the name in the requested language only, as the catalog does; French has a few. */
function localized(plant: SpeciesListItem, locale: unknown): SpeciesListItem {
  if (locale !== 'fr') return plant
  const common_name = frenchNames[plant.canonical_name] ?? null
  return { ...plant, common_name, is_name_fallback: common_name === null }
}
/**
 * The analytic site the gallery samples (spec §1.10, `lidar_sample_points`): ground elevation 140 + 30·sin over the
 * ground, the surface 6 m above it, a canopy 6 ± 4 m, and slope from the ground's gradient, in each item's units; no data
 * outside an item's bounds. A request over the generated caps throws, so the test that sent it fails; Rust's own refusal
 * is tested in Rust, and no string is shared with it.
 */
async function sampleGalleryPoints(request: LidarSamplePointsRequest): Promise<LidarSampleSeries[]> {
  if (request.targets.length > LIDAR_SAMPLE_MAX_TARGETS || request.points.length > LIDAR_SAMPLE_MAX_POINTS) {
    throw new Error('sampler exceeded the generated caps')
  }
  if (sampleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sampleDelayMs))
  return request.targets.map((target): LidarSampleSeries => {
    const item = lidarItems.find((candidate) => candidate.id === target.entity_id && candidate.role === target.kind)
    if (!item?.generation_id || !item.bounds) return { Unavailable: { reason: 'MissingGeneration' } }
    if (item.generation_id !== target.expected_generation_id) return { Unavailable: { reason: 'StaleGeneration' } }
    return { Values: { values: request.points.map(([lon, lat]) => analyticValue(item, lon, lat)) } }
  })
}

function analyticValue(item: LibraryItemSummary, lon: number, lat: number): number | null {
  const [west, south, east, north] = item.bounds!
  if (lon < west || lon > east || lat < south || lat > north) return null
  const x = (lon - west) * 111_320 * Math.cos((lat * Math.PI) / 180)
  const y = (lat - south) * 110_540
  const phase = x / 25 + y / 40
  const elevation = 140 + 30 * Math.sin(phase)
  switch (item.item_type.quantity) {
    case 'SurfaceElevation': return elevation + 6
    case 'AboveGroundHeight': return 6 + 4 * Math.sin(x / 7)
    case 'Slope': {
      const gradient = 30 * Math.abs(Math.cos(phase)) * Math.hypot(1 / 25, 1 / 40)
      return item.units === '%' ? gradient * 100 : (Math.atan(gradient) * 180) / Math.PI
    }
    default: return elevation
  }
}

export function convertFileSrc(path: string) { return path }
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const canonicalName = String(args.canonicalName ?? '')
  const plant = species.find(plant => plant.canonical_name === canonicalName) ?? species[0]!
  let result: unknown
  switch (command) {
    case 'get_favorites': result = species.filter(plant => favoriteNames.has(plant.canonical_name)).map(plant => localized({ ...plant, common_name: state === 'long' ? plant.common_name + ' — a particularly long local cultivar name' : plant.common_name }, args.locale)); break
    case 'get_recently_viewed': result = []; break
    case 'get_recent_files': result = recentDesigns(); break
    case 'get_recent_design_previews': result = (args.paths as string[]).map(path => ({ path, preview: recentPreview(path) })); break
    case 'remove_recent_design':
      removedRecentPaths.add(String(args.path))
      activity.value = 'Removed the Design from Recent Designs in memory.'; result = undefined; break
    case 'show_recent_design_in_folder': activity.value = 'Show in folder opens the file manager in Canopi Desktop.'; result = undefined; break
    case 'get_app_folders': result = { drafts: '/home/you/.local/share/canopi/drafts', data_library: '/home/you/.local/share/canopi/lidar' }; break
    case 'show_app_folder': activity.value = `Show in folder opens the ${String(args.folder)} folder in Canopi Desktop.`; result = undefined; break
    case 'list_design_drafts': result = drafts; break
    case 'delete_design_draft':
      drafts = drafts.filter(draft => draft.id !== args.id)
      activity.value = 'Deleted the draft in memory.'; result = undefined; break
    case 'toggle_favorite':
      if (favoriteNames.has(canonicalName)) favoriteNames.delete(canonicalName)
      else favoriteNames.add(canonicalName)
      result = favoriteNames.has(canonicalName); break
    case 'get_species_detail': result = {
      ...(canonicalName === 'Malus domestica' ? appleDetail : detail),
      canonical_name: canonicalName,
      common_name: args.locale === 'fr' ? frenchNames[canonicalName] ?? null : plant.common_name,
    }; break
    case 'get_species_batch': result = species.map(plant => ({ ...detail, ...plant })); break
    // Wild strawberry has no catalog habit, so the PDF key shows the Other group.
    case 'get_species_habits': result = Object.fromEntries(specimens.flatMap(([name, , symbol]): [string, string][] =>
      symbol === 'canopy' ? [[name, 'Tree']] : symbol === 'shrub' ? [[name, 'Shrub']] : symbol === 'herb' ? [[name, 'Herbaceous']] : [])); break
    case 'get_common_names': result = args.locale === 'fr' ? frenchNames : Object.fromEntries([...catalogSpecies, ...species].flatMap(plant => plant.common_name ? [[plant.canonical_name, plant.common_name]] : [])); break
    case 'get_species_images': result = canonicalName === 'Malus domestica'
      ? applePhotos.map((url, sort_order) => ({ id: `photo-${sort_order}`, species_id: 'apple', url, sort_order }))
      : []; break
    case 'get_cached_image_path': result = drawnPhoto(String(args.url)); break
    case 'get_locale_common_names':
    case 'get_dynamic_filter_options': result = []; break
    case 'get_filter_options': result = {
      families: [], growth_rates: [], climate_zones: ['Temperate', 'Mediterranean', 'Continental'], habits: ['Tree', 'Shrub', 'Herbaceous', 'Climber'],
      life_cycles: ['Annual', 'Perennial'], sun_tolerances: ['full_sun', 'semi_shade', 'full_shade'], soil_tolerances: [],
    }; break
    case 'supersede_species_search': result = undefined; break
    case 'search_species': result = searchCatalog(args.request as SpeciesSearchRequest); break
    case 'get_saved_object_stamps': result = stamps; break
    case 'create_saved_object_stamp':
      result = { id: `stamp-${sequence++}`, name: String(args.name), payload_json: String(args.payloadJson), sort_order: stamps.length, created_at: file.created_at, updated_at: file.updated_at }
      stamps = [...stamps, result as SavedObjectStamp]; break
    case 'rename_saved_object_stamp':
      stamps = stamps.map(stamp => stamp.id === args.id ? { ...stamp, name: String(args.name) } : stamp)
      result = stamps.find(stamp => stamp.id === args.id); break
    case 'delete_saved_object_stamp':
      stamps = stamps.filter(stamp => stamp.id !== args.id); result = true; break
    case 'reorder_saved_object_stamps':
      stamps = (args.ids as string[]).map((id, sort_order) => ({ ...stamps.find(stamp => stamp.id === id)!, sort_order }))
      result = stamps; break
    // The host dialogs answer at once, so the real import and export workflows run without OS dialogs.
    case 'pick_open': result = { kind: 'picked', paths: ['gallery-example.canopi'] }; break
    case 'pick_save': result = { kind: 'picked', path: 'gallery-export.canopi' }; break
    case 'export_saved_object_stamp_canopi_file':
      activity.value = 'Export completed in memory.'; result = 'gallery-export.canopi'; break
    case 'load_saved_object_stamp_canopi_file':
      activity.value = 'Imported the sample design in memory.'; result = file; break
    case 'lidar_list_library':
      result = {
        items: lidarItems,
        engines: {
          raster: { available: true, version: 'canopi-raster-engine (wbgeotiff, proj4rs; gallery)', detail: null },
          geolibre: { available: true, version: galleryTool.version, detail: null },
        },
      }; break
    case 'lidar_create_analysis': {
      const request = args.request as AnalysisRequest
      const input = request.inputs[0]?.item_id ?? ''
      const unit = request.parameters.find(parameter => parameter.key === 'unit')?.value
      const id = `lidar-analysis-${sequence++}`
      const item = gallerySlope(id, input, unit && 'Choice' in unit && unit.Choice === 'percent' ? 'percent' : 'degrees', { name: request.name })
      lidarItems = [...lidarItems, item]
      updateItem(input, source => ({ ...source, dependents: source.dependents + 1 }))
      recordRun(item)
      activity.value = 'Calculated a slope result in memory.'
      result = { definition_id: item.provenance!.definition_id, job_id: item.provenance!.job_id, item_ids: [id] }
      break
    }
    case 'lidar_rerun_analysis': {
      const item = lidarItems.find(candidate => candidate.provenance?.definition_id === args.definitionId)
      if (item) {
        const refreshed = { ...item, state: 'Ready' as const, generation_id: `${item.id}-g${sequence++}`, freshness: { state: 'Current' as const } }
        updateItem(item.id, () => refreshed)
        recordRun(refreshed)
      }
      activity.value = 'Refreshed the result in memory.'
      result = { definition_id: String(args.definitionId), job_id: `job-${sequence++}`, item_ids: item ? [item.id] : [] }
      break
    }
    case 'lidar_processing_history':
      result = { definition_id: String(args.definitionId), runs: galleryRuns.get(String(args.definitionId)) ?? [], next_cursor: null }
      break
    case 'lidar_cancel_analysis_job':
      lidarItems = lidarItems.map((item): LibraryItemSummary => item.run && item.run.job_id === args.jobId && item.run.state === 'Preparing'
        ? { ...item, state: item.generation_id ? 'Ready' : 'Failed', run: { ...item.run, state: 'Cancelled' } }
        : item)
      activity.value = 'Cancelled the calculation without publishing.'
      result = undefined
      break
    case 'lidar_import_item': {
      const id = `lidar-layer-${sequence++}`
      lidarItems = [...lidarItems, galleryImport(id, String(args.name), args.quantity as RasterQuantity, {})]
      activity.value = 'Started a library import in memory.'
      result = { layer_id: id, job_id: `job-${id}` }
      break
    }
    case 'lidar_retry_import': {
      const jobId = `job-${sequence++}`
      updateItem(args.layerId, item => {
        if (!item.import_job) return item
        retriedImports.set(jobId, item.import_job)
        return { ...item, state: 'Preparing', import_job: { ...item.import_job, job_id: jobId, state: 'Staging', message: null, progress: { phase: 'PreparingRaster', percent: 5 } } }
      })
      activity.value = 'Retried the import in memory.'
      result = { layer_id: String(args.layerId), job_id: jobId }
      break
    }
    case 'lidar_dismiss_import':
      lidarItems = lidarItems.filter(candidate => candidate.id !== args.layerId)
      activity.value = 'Removed the library item in memory.'
      result = undefined
      break
    case 'lidar_delete_item': {
      const removed = lidarItems.find(candidate => candidate.id === args.itemId)
      if (removed && removed.dependents > 0) throw new Error('Other results were calculated from this data.')
      lidarItems = lidarItems.filter(candidate => candidate !== removed)
      const input = removed?.provenance?.inputs[0]?.item_id
      if (input) updateItem(input, source => ({ ...source, dependents: Math.max(0, source.dependents - 1) }))
      activity.value = 'Deleted the library item in memory.'
      result = undefined
      break
    }
    case 'lidar_cancel_import': {
      // Cancel on a Retry puts the item back to Failed; Cancel on a first
      // import deletes its unpublished item (U51, user 2026-10-09).
      const earlier = retriedImports.get(String(args.jobId))
      retriedImports.delete(String(args.jobId))
      lidarItems = earlier
        ? lidarItems.map(item => item.generation_id || item.import_job?.job_id !== args.jobId
          ? item
          : { ...item, state: 'Failed', import_job: earlier })
        : lidarItems.filter(item => item.generation_id || item.import_job?.job_id !== args.jobId)
      activity.value = earlier ? 'Cancelled the retry; the import is failed again.' : 'Cancelled the import and deleted its item.'
      result = undefined
      break
    }
    case 'lidar_rename_item':
      updateItem(args.itemId, item => ({ ...item, name: String(args.name) }))
      result = undefined
      break
    case 'lidar_import_coverage': {
      // The chosen tiles span a little more than the sample Design.
      const lons = file.plants.map(plant => plant.position.lon)
      const lats = file.plants.map(plant => plant.position.lat)
      result = { bounds: [Math.min(...lons) - 0.01, Math.min(...lats) - 0.004, Math.max(...lons) + 0.01, Math.max(...lats) + 0.004], unreadable_files: 0 }
      break
    }
    case 'lidar_library_disk_usage': result = 1_240_000_000; break
    case 'lidar_delete_impact':
      result = {
        dependent_item_ids: lidarItems
          .filter(candidate => candidate.provenance?.inputs.some(input => input.item_id === args.itemId))
          .map(candidate => candidate.id),
      }
      break
    case 'lidar_layer_collection':
      result = {
        layer_id: String(args.layerId), head_generation_id: 'lidar-ground-g1', member_count: 4,
        sources: ['LHD_FXX_0712_6250', 'LHD_FXX_0712_6251', 'LHD_FXX_0713_6250', 'LHD_FXX_0713_6251']
          .map((stem, index) => ({
            member_id: `source-${index}`, filename: `${stem}.tif`, interpretation_id: `interp-${index}`,
            width: 2000, height: 2000, pixel_size_m: 0.5, coverage_cells: '1000000', value_range: [131.2, 287.8] as [number, number],
          })),
        next_member_cursor: null,
      }
      break
    case 'lidar_display_descriptor': {
      const request = args.request as { kind: string; entity_id: string; expected_generation_id: string | null; relief: boolean }
      const descriptor = {
        kind: request.kind, entity_id: request.entity_id, generation_id: request.expected_generation_id, profile: 'gallery',
        relief: request.relief, message: null,
      }
      // `state=lidar-raster` serves the Rust engine's display COGs for the ground elevation: its relief when asked for
      // Relief, else its elevation; every other derivative stays a placeholder.
      const asset = request.relief
        ? { path: rasterDisplayReliefUrl, bounds: galleryRasterSite.reliefBounds }
        : { path: rasterDisplayCogUrl, bounds: galleryRasterSite.bounds }
      result = state === 'lidar-raster' && request.entity_id === 'lidar-ground'
        ? { ...descriptor, state: 'Ready', assets: [asset], prepared_assets: 1, total_assets: 1 }
        : { ...descriptor, state: 'Unavailable', assets: [], prepared_assets: 0, total_assets: 0 }
      break
    }
    case 'lidar_sample_points': result = await sampleGalleryPoints(args.request as LidarSamplePointsRequest); break
    default: throw new Error(`Gallery backend has no fixture for ${command}.`)
  }
  return structuredClone(result) as T
}
