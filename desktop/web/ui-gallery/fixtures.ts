import type { SpeciesDetail, SpeciesListItem } from '../src/types/species'
import type { CanopiFile, RichTextBlock, SavedView, Story } from '../src/types/design'
import { createDefaultScenePersistedState,PLANT_SYMBOL_IDS,serializeScenePersistedState } from '../src/canvas/runtime/scene'
import { createSessionPlane } from '../src/canvas/session-plane'
import { PLANT_COLOR_PALETTE } from '../src/canvas/plant-colors'
import { mapZoomToStageScale } from '../src/canvas/projection'
import reliefFixture from '../src/maplibre/raster-display/fixtures/rust-display-relief.json'

export const detail: SpeciesDetail = {
  "canonical_name": "Malus domestica",
  "common_name": "Apple",
  "family": "Rosaceae",
  "genus": null,
  "taxonomic_order": null,
  "taxonomic_class": null,
  "is_hybrid": null,
  "match_confidence": null,
  "tnrs_taxonomic_status": null,
  "match_score": null,
  "enriched_at": null,
  "height_min_m": null,
  "height_max_m": 8,
  "width_max_m": 6,
  "hardiness_zone_min": null,
  "hardiness_zone_max": null,
  "age_of_maturity_years": null,
  "growth_rate": null,
  "is_annual": null,
  "is_biennial": null,
  "is_perennial": true,
  "lifespan": null,
  "deciduous_evergreen": null,
  "leaf_retention": null,
  "active_growth_period": null,
  "habit": null,
  "growth_form_type": null,
  "growth_form_shape": null,
  "growth_habit": null,
  "woody": null,
  "canopy_position": null,
  "resprout_ability": null,
  "coppice_potential": null,
  "bloom_period": null,
  "flower_color": "white",
  "pollinators": null,
  "tolerates_full_sun": null,
  "tolerates_semi_shade": null,
  "tolerates_full_shade": null,
  "frost_tender": null,
  "frost_free_days_min": null,
  "drought_tolerance": null,
  "precip_min_inches": null,
  "precip_max_inches": null,
  "soil_ph_min": null,
  "soil_ph_max": null,
  "well_drained": null,
  "heavy_clay": null,
  "tolerates_light_soil": null,
  "tolerates_medium_soil": null,
  "tolerates_heavy_soil": null,
  "tolerates_acid": null,
  "tolerates_alkaline": null,
  "tolerates_saline": null,
  "tolerates_wind": null,
  "tolerates_pollution": null,
  "tolerates_nutritionally_poor": null,
  "fertility_requirement": null,
  "moisture_use": null,
  "anaerobic_tolerance": null,
  "root_depth_min_cm": null,
  "salinity_tolerance": null,
  "stratum": "high",
  "succession_stage": null,
  "stratum_confidence": null,
  "succession_confidence": null,
  "nitrogen_fixer": null,
  "ecological_system": null,
  "mycorrhizal_type": null,
  "grime_strategy": null,
  "raunkiaer_life_form": null,
  "cn_ratio": null,
  "allelopathic": null,
  "root_system_type": null,
  "taproot_persistent": null,
  "edibility_rating": 5,
  "medicinal_rating": null,
  "other_uses_rating": null,
  "attracts_wildlife": null,
  "scented": null,
  "uses": [],
  "propagated_by_seed": null,
  "propagated_by_cuttings": null,
  "propagated_by_bare_root": null,
  "propagated_by_container": null,
  "propagated_by_sprigs": null,
  "propagated_by_bulb": null,
  "propagated_by_sod": null,
  "propagated_by_tubers": null,
  "propagated_by_corm": null,
  "cold_stratification_required": null,
  "vegetative_spread_rate": null,
  "seed_spread_rate": null,
  "propagation_method": null,
  "sowing_period": null,
  "harvest_period": null,
  "dormancy_conditions": null,
  "management_types": null,
  "fruit_type": null,
  "fruit_seed_color": null,
  "fruit_seed_period_begin": null,
  "fruit_seed_period_end": null,
  "fruit_seed_abundance": null,
  "fruit_seed_persistence": null,
  "seed_mass_mg": null,
  "seed_length_mm": null,
  "seed_germination_rate": null,
  "seed_dispersal_mechanism": null,
  "seed_storage_behaviour": null,
  "seed_dormancy_type": null,
  "seed_dormancy_depth": null,
  "serotinous": null,
  "seedbank_type": null,
  "leaf_type": null,
  "leaf_compoundness": null,
  "leaf_shape": null,
  "sla_mm2_mg": null,
  "ldmc_g_g": null,
  "leaf_nitrogen_mg_g": null,
  "leaf_carbon_mg_g": null,
  "leaf_phosphorus_mg_g": null,
  "leaf_dry_mass_mg": null,
  "pollination_syndrome": null,
  "sexual_system": null,
  "mating_system": null,
  "self_fertile": null,
  "reproductive_type": null,
  "clonal_growth_form": null,
  "storage_organ": null,
  "toxicity": null,
  "invasive_potential": null,
  "biogeographic_status": null,
  "noxious_status": null,
  "invasive_usda": null,
  "weed_potential": null,
  "fire_resistant": null,
  "fire_tolerance": null,
  "hedge_tolerance": null,
  "native_distribution": null,
  "introduced_distribution": null,
  "climate_zones": "temperate",
  "conservation_status": null,
  "image_urls": null,
  "ellenberg_light": null,
  "ellenberg_temperature": null,
  "ellenberg_moisture": null,
  "ellenberg_reaction": null,
  "ellenberg_nitrogen": null,
  "ellenberg_salt": null,
  "overall_confidence": null,
  "data_quality_tier": null,
  "wood_density_g_cm3": null,
  "photosynthesis_pathway": null,

}
const baseSpecies: SpeciesListItem = {
  "canonical_name": "Malus domestica",
  "slug": "",
  "common_name": "Apple",
  "common_name_2": null,
  "matched_common_name": null,
  "is_name_fallback": false,
  "family": "Rosaceae",
  "genus": null,
  "height_max_m": 8,
  "hardiness_zone_min": null,
  "hardiness_zone_max": null,
  "growth_rate": null,
  "stratum": "high",
  "habit": null,
  "climate_zones": [
    "temperate"
  ],
  "life_cycles": [
    "perennial"
  ],
  "edibility_rating": null,
  "medicinal_rating": null,
  "width_max_m": 6,
  "is_favorite": true
}
export const specimens = [
  ['Malus domestica', 'Apple', 'canopy', '#C8A51E'],
  ['Lavandula angustifolia', 'English lavender', 'shrub', '#8856A7'],
  ['Mentha spicata', 'Spearmint', 'herb', '#4E8A57'],
  ['Achillea millefolium', 'Common yarrow', 'herb', '#E9D28B'],
  ['Corylus avellana', 'Hazel', 'shrub', '#A9845A'],
  ['Fragaria vesca', 'Wild strawberry', 'groundcover', '#C44230'],
] as const
export const species: SpeciesListItem[] = specimens.map(([canonical_name, common_name]) => ({ ...baseSpecies, canonical_name, common_name }))
/** Every symbol in close orchard rows (8 of each), neighbours always different, in the palette colours. */
function symbolPlanting() {
  const designed = PLANT_SYMBOL_IDS.slice(0, 29)
  const columns = 16
  return Array.from({ length: 8 * designed.length }, (_, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const [canonicalName, commonName] = specimens[index % specimens.length]!
    return {
      kind: 'plant' as const, id: `planting-${index}`, canonicalName, commonName,
      position: { x: column * .42 + (row % 2) * .21, y: row * .36 },
      color: PLANT_COLOR_PALETTE[(index * 5) % PLANT_COLOR_PALETTE.length]!.hex,
      symbol: designed[(index * 7) % designed.length]!,
      canopySpreadM: .5, rotationDeg: null, scale: .5,
      notes: null, plantedDate: null, quantity: null, locked: false,
    }
  })
}

/** A small drawn hedge (PNG) so a story step shows an embedded image offline. */
const HEDGE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAABnklEQVR42u2avQ3CMBCFiZUBGAAxAjNQUVCwAS0lygjUVIiSlg0oqZiAggEoECUFI1BEQlFCQuz4fuy8J4ooSOD78i7ns51c768BVC8DBAAEQAAEQHqVio9gs1vUfpWdxIeXSJX5Bi6qSAkAskIjjokVkDMaQUwmLDoef0eXg7xEtXxO8ovj6MbmIxMcnfyazUfkDipFUnSBG52veHxkROjUxazwfWRE6ATEKIxWo5qPVhmqEZD3B1skUqJDaqKU0wWlnLJ1AZtrxFKswQU/K1f+ibBZ7e55B68RlXyNL2miehdzFRMUAAUISHDWE4yDrOodqVK13pblQt7Nt6/0bv09T42XTzHv/X1UgFTNd9ibVcalddL/wjxIDtDfB+tlvkNtVSNr/o7zHYZE5tj2IVrQ4nnNsWz7EEQS1b6Y93g4SyTj1rOnqJj35nG6Qx8gB0z9Oh/UnlSvT5gVtV9NqzfXh0vfm9W+txpxKMm2c/FBvM+P6s3hbAwHIcXCl4pFeyXZBAcBEAABEAABEAABEARAAARAAARAAARAAAQNPj3bsVHRU8u5AAAAAElFTkSuQmCC'

const plain = (text: string, marks: { bold?: boolean; italic?: boolean; link?: string } = {}) => ({
  text, bold: marks.bold ?? false, italic: marks.italic ?? false, link: marks.link ?? null,
})

/** The map a gallery story view was framed in: what a 1280 × 800 window shows at its zoom. */
const STORY_VIEW_SCREEN = { width: 1280, height: 800 }

function storyView(id: string, name: string, origin: { lon: number; lat: number }, offset: [number, number], zoom: number, species: string[], background: SavedView['visible_layers']['background'] = { kind: 'none' }, bearing = 0): SavedView {
  const lat = origin.lat + offset[1]
  const pixelsPerMetre = mapZoomToStageScale(zoom, lat)
  return {
    id, name,
    camera: {
      lon: origin.lon + offset[0], lat, zoom, bearing,
      ground_size_m: { width: STORY_VIEW_SCREEN.width / pixelsPerMetre, height: STORY_VIEW_SCREEN.height / pixelsPerMetre },
    },
    visible_layers: {
      background,
      terrain: { contours: false, hillshade: false },
      scene_layers: ['zones', 'water', 'plants', 'measurement-guides', 'annotations'],
      site_data: [],
    },
    highlighted: { species, objects: [] },
    title: null,
    text: [],
  }
}

/** Saved views and a four-step story over the fixture planting (StoryAuthor board). */
function storyFixture(origin: { lon: number; lat: number }, long: boolean): { views: SavedView[]; stories: Story[] } {
  const views = [
    storyView('view-site', 'The site', origin, [0.00008, -0.00003], 21.2, []),
    // Turned 30° clockwise from north: the story presented at a bearing (plan section 4, phase 1's gallery entries).
    storyView('view-rows', 'Rows and strata', origin, [0.00005, -0.00002], 22, [], { kind: 'none' }, 30),
    // Satellite shows as "Satellite" in the step's tags; offline, its snapshot waits and reads without tiles.
    storyView('view-hedges', 'Berry hedges', origin, [0.00013, -0.00004], 23, ['Fragaria vesca'], { kind: 'satellite' }),
    storyView('view-year-one', 'Year one planting', origin, [0.00002, -0.00002], 22.5, ['Malus domestica']),
  ]
  const text = (first: string, rest: RichTextBlock[] = []): RichTextBlock[] => [{ kind: 'paragraph', spans: [plain(first)] }, ...rest]
  const hedgesText: RichTextBlock[] = [
    { kind: 'paragraph', spans: [
      plain('Two hedges of '), plain('strawberry and hazel', { bold: true }),
      plain(' run along the drip line of the fruit trees. They crop from '), plain('year two', { italic: true }),
      plain(' and shelter the young trees from the west wind.'),
    ] },
    { kind: 'bullets', items: [
      { spans: [plain('Mulch in autumn')] },
      { spans: [plain('See the '), plain('planting notes', { link: 'https://example.org/hedges' })] },
    ] },
  ]
  const steps = [
    { id: 'step-site', view_id: 'view-site', title: 'The site', text: text('Where the orchard sits and how water moves across it.'), images: [] },
    { id: 'step-rows', view_id: 'view-rows', title: 'Rows and strata', text: text('Six rows, from the apple canopy down to groundcover.'), images: [] },
    {
      id: 'step-hedges', view_id: 'view-hedges',
      title: long ? 'Berry hedges along the northern drip line, with a particularly long title' : 'Berry hedges',
      text: hedgesText,
      images: [{ src: HEDGE_PNG, alt: 'The hedge in June, heavy with berries' }],
    },
    { id: 'step-year-one', view_id: 'view-year-one', title: 'Year one planting', text: text('What goes in this winter, and in what order.'), images: [] },
  ]
  return {
    views,
    stories: [
      { id: 'story-visit', name: 'Orchard · client visit', steps },
      { id: 'story-open-day', name: 'Open day', steps: [{ ...steps[0]!, id: 'step-open-site' }] },
    ],
  }
}

/**
 * `state=lidar-raster`: the Design sits on the 34 × 24 cell display COG the Rust engine wrote
 * (src/maplibre/raster-display/fixtures/rust-display-cog.{tif,json}, near Delft), inside the relief it wrote around
 * the same source (rust-display-relief.{tif,json}), so the canvas draws the ground elevation through Desktop's raster
 * renderer as it opens, on Relief, and in place once a Colours ramp is picked.
 */
export const galleryRasterSite = {
  origin: { lon: 4.36759, lat: 52.011435 },
  bounds: [4.367580413818352, 52.011365324340304, 4.367762804031366, 52.01144456811651] as [number, number, number, number],
  reliefBounds: reliefFixture.bounds as [number, number, number, number],
  valueRange: [19.75, 90.25] as [number, number],
}

/** The Design's site, as the gallery states place it. */
function designOrigin(state: string): { lon: number; lat: number } {
  if (state === 'located') return { lon: 0.033854, lat: 48.220272 }
  if (state === 'lidar-raster') return galleryRasterSite.origin
  return { lon: 13, lat: 23 }
}

/** Site data entries: the three of every state, the nine more `lidar-long` lists, the two `lidar-missing` names. */
function lidarEntries(state: string): NonNullable<CanopiFile['lidar']>['entries'] {
  const entry = (kind: 'Source' | 'Derived', id: string, name: string, order: number, visible = true, opacity = 0.82) =>
    ({ kind, id, name, visible, opacity, order, ramp: null, reversed: false, range: null })
  const entries = [
    entry('Source', 'lidar-ground', 'IGN LiDAR HD MNT', 0),
    entry('Derived', 'lidar-slope', 'IGN LiDAR HD MNT · Slope', 1, true, 0.66),
    entry('Derived', 'lidar-slope-percent', 'IGN LiDAR HD MNT · Slope (%)', 2, false, 0.66),
  ]
  if (state === 'lidar-long') {
    entries.push(...galleryLongSiteDataNames.map((name, index) => entry('Source', `lidar-block-${index + 1}`, name, 3 + index)))
  }
  if (state === 'lidar-missing') {
    // Two ids no library on this computer has, as a Design opened on another computer shows them.
    entries.push(
      entry('Source', 'lidar-gone-2021', 'IGN LiDAR HD MNT 2021', 3),
      entry('Derived', 'lidar-gone-2021-slope', 'IGN LiDAR HD MNT 2021 · Slope', 4, true, 0.66),
    )
  }
  return entries
}

/** `state=lidar-long`: nine more sources, so Site data lists twelve entries and shows its filter (above 8). */
export const galleryLongSiteDataNames = [
  'Survey block 1 · north meadow', 'Survey block 2 · orchard terraces', 'Survey block 3 · pond margin',
  'Survey block 4 · hedge line', 'Survey block 5 · lower field', 'Survey block 6 · woodland edge',
  'Canopy height 2024', 'Surface model 2024', 'Survey block 7 · access track',
] as const

export function designFixture(state = 'populated'): CanopiFile {
  const scene = createDefaultScenePersistedState()
  const plants = state === 'empty' || state === 'zone' ? [] : state === 'planting' ? symbolPlanting() : specimens.flatMap(([canonicalName, commonName], speciesIndex) =>
    Array.from({ length: speciesIndex === 0 ? 3 : 8 }, (_, i) => ({
      kind: 'plant' as const, id: `plant-${speciesIndex}-${i}`, canonicalName,
      commonName: state === 'long' ? `${commonName} — a particularly long local cultivar name` : commonName,
      position: state === 'dense' ? { x: ((speciesIndex === 0 ? i : 3 + (speciesIndex - 1) * 8 + i) % 7) * .32, y: Math.floor((speciesIndex === 0 ? i : 3 + (speciesIndex - 1) * 8 + i) / 7) * .36 } : { x: speciesIndex * 3 + (i % 3) * .7, y: (i % 4) * 2 + (speciesIndex % 2) },
      color: state === 'mixed' && i === 0 ? '#C44230' : specimens[speciesIndex]![3], symbol: state === 'mixed' && i === 0 ? 'conifer' : null,
      canopySpreadM: speciesIndex === 0 ? 2 : .7, rotationDeg: null, scale: speciesIndex === 0 ? 2 : .7,
      notes: null, plantedDate: null, quantity: null, locked: false,
    })))
  const activeSpecies = state === 'empty' ? [] : specimens.map(([canonicalName]) => canonicalName)
  return {
    ...serializeScenePersistedState({ ...scene, plants,
      // `state=zone`: one rectangle drawn and never named.
      zones: state === 'zone' ? [{
        kind: 'zone' as const, id: 'zone-ee08f9f9-634f-4723-bbde-1200610562dc', name: null, locked: false, zoneType: 'rect',
        rotationDeg: 0, fillColor: null, notes: null,
        points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }],
      }] : [],
      plantSpeciesColors: Object.fromEntries(specimens.map(([name, , , color]) => [name, color])),
      plantSpeciesSymbols: Object.fromEntries(specimens.map(([name, , symbol]) => [name, symbol])),
    }, createSessionPlane(designOrigin(state)), { now: new Date('2026-01-01T00:00:00Z') }),
    name: 'Orchard notebook',
    ...(state === 'empty' ? {} : storyFixture(designOrigin(state), state === 'long')),
    lidar: state === 'empty' ? null : {
      visible: true,
      entries: lidarEntries(state),
    },
    budget_currency: 'EUR',
    budget: activeSpecies.slice(0, 5).flatMap((canonicalName, index) => index === 4 ? [] : [{
      target: { kind: 'species' as const, canonical_name: canonicalName },
      category: 'plants',
      description: canonicalName,
      quantity: 0,
      unit_cost: index === 1 ? 0 : 3.5 + index * 1.25,
      currency: 'EUR',
    }]),
    timeline: state === 'empty' ? [] : [
      {
        id: 'gallery-calendar-range', action_type: 'pruning',
        description: state === 'long' ? 'Prune and train the longest named orchard specimens along the northern espalier' : 'Prune orchard trees',
        start_date: '2026-09-08', end_date: '2026-09-11', recurrence: null,
        targets: [{ kind: 'species' as const, canonical_name: 'Malus domestica' }],
        depends_on: null, completed: false, order: 0,
      },
      {
        id: 'gallery-calendar-harvest', action_type: 'harvest', description: 'Harvest apples',
        start_date: '2026-09-16', end_date: null, recurrence: 'FREQ=YEARLY',
        targets: [{ kind: 'species' as const, canonical_name: 'Malus domestica' }],
        depends_on: null, completed: false, order: 1,
      },
      {
        id: 'gallery-calendar-water', action_type: 'watering', description: 'Check irrigation',
        start_date: null, end_date: '2026-09-24', recurrence: null,
        targets: [{ kind: 'manual' as const }], depends_on: null, completed: false, order: 2,
      },
      {
        id: 'gallery-calendar-done', action_type: 'planting', description: 'Plant groundcover',
        start_date: '2026-09-16', end_date: null, recurrence: null,
        targets: [{ kind: 'species' as const, canonical_name: 'Fragaria vesca' }],
        depends_on: null, completed: true, order: 3,
      },
    ],
    consortiums: [
      ...activeSpecies.map((canonicalName, index) => ({
        target: { kind: 'species' as const, canonical_name: canonicalName },
        stratum: ['emergent', 'high', 'medium', 'low', 'unassigned', 'unknown-stratum'][index]!,
        start_phase: Math.min(index, 3),
        end_phase: Math.min(6, index + 2),
      })),
      { target: { kind: 'species' as const, canonical_name: 'Absent retained species' }, stratum: 'high', start_phase: 0, end_phase: 6 },
    ],
  }
}

/**
 * Species detail fixtures: a full catalog record for Apple (values as the plant DB serves
 * them), French names for some species (the rest show the English fallback), and three
 * photos for Apple drawn locally so the gallery stays offline.
 */
export const appleDetail: SpeciesDetail = {
  ...detail,
  common_name: 'Apple', family: 'Rosaceae', genus: 'Malus',
  height_max_m: 15, width_max_m: 8, hardiness_zone_min: 3, hardiness_zone_max: 8,
  growth_rate: 'Medium', is_annual: false, is_biennial: false, is_perennial: true,
  deciduous_evergreen: 'Deciduous', habit: 'Tree', growth_form_type: 'Tree', woody: true,
  bloom_period: 'Mid Spring', flower_color: 'White', pollinators: 'Insects',
  tolerates_full_sun: true, tolerates_semi_shade: true, tolerates_full_shade: false, frost_tender: false,
  drought_tolerance: 'Medium', soil_ph_min: 5, soil_ph_max: 7.5, well_drained: true, heavy_clay: true,
  tolerates_light_soil: true, tolerates_medium_soil: true, tolerates_heavy_soil: true,
  fertility_requirement: 'Medium', moisture_use: 'Medium', root_depth_min_cm: 243.84,
  stratum: 'high', succession_stage: 'secondary_ii', nitrogen_fixer: false, attracts_wildlife: true,
  edibility_rating: 5, medicinal_rating: 2, other_uses_rating: 4,
  uses: [
    { use_category: 'Edible fruit', use_description: 'Fruit eaten raw, cooked or dried; juice made into cider.' },
    { use_category: 'Medicinal', use_description: 'The fruit is mildly laxative.' },
    { use_category: 'Wood', use_description: 'Hard, fine-grained wood used for turnery and firewood.' },
  ],
  propagated_by_seed: true, propagated_by_cuttings: false,
  fruit_type: 'Pome', seed_mass_mg: 22.36,
  biogeographic_status: 'Introduced', introduced_distribution: 'Alabama, Arkansas, Armenia, Australia, British Columbia, California, Canada',
  climate_zones: 'Continental, Temperate, Subtropical, Arid, Mediterranean',
}

export const frenchNames: Readonly<Record<string, string>> = {
  'Malus domestica': 'Pommier cultivé',
  'Lavandula angustifolia': 'Lavande vraie',
  'Corylus avellana': 'Noisetier',
}

export const applePhotos = [
  'http://commons.wikimedia.org/wiki/Special:FilePath/Tree%20with%20red%20apples.jpg',
  'https://inaturalist-open-data.s3.amazonaws.com/photos/471845/medium.jpg',
  'https://inaturalist-open-data.s3.amazonaws.com/photos/585657/medium.jpg',
]

/** A drawn stand-in for a cached photo: sky, grass and one tree, tinted per photo. */
export function drawnPhoto(url: string): string {
  const hue = [95, 120, 70][Math.max(0, applePhotos.indexOf(url))] ?? 95
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><defs><linearGradient id="s" x2="0" y2="1"><stop offset="0" stop-color="hsl(205 60% 78%)"/><stop offset="1" stop-color="hsl(45 60% 90%)"/></linearGradient></defs>`
    + `<rect width="600" height="400" fill="url(#s)"/><rect y="290" width="600" height="110" fill="hsl(${hue} 35% 42%)"/>`
    + `<rect x="285" y="200" width="30" height="110" fill="hsl(25 35% 30%)"/><circle cx="300" cy="170" r="110" fill="hsl(${hue} 40% 35%)"/>`
    + `<circle cx="260" cy="150" r="12" fill="hsl(5 70% 48%)"/><circle cx="330" cy="190" r="12" fill="hsl(5 70% 48%)"/><circle cx="300" cy="120" r="12" fill="hsl(5 70% 48%)"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
