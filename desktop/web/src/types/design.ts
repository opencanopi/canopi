import type * as Contracts from '../generated/contracts'

export type Layer = Omit<Contracts.LayerV10, 'locked'> & { locked: boolean }
export type Zone = Omit<Contracts.ZoneV10, 'name' | 'locked' | 'rotation' | 'fill_color' | 'notes'> & {
  name: string | null
  locked: boolean
  rotation: number
  fill_color: string | null
  notes: string | null
}
export type Annotation = Omit<Contracts.AnnotationV10, 'locked' | 'text' | 'font_size' | 'rotation'> & {
  locked: boolean
  text: string
  font_size: number
  rotation: number | null
}
export type MeasurementGuide = Omit<Contracts.MeasurementGuideV10, 'locked'> & { locked: boolean }
export type ObjectGroupMember = Contracts.ObjectGroupMemberV10
export type ObjectGroup = Omit<Contracts.ObjectGroupV10, 'locked' | 'name' | 'members'> & {
  locked: boolean
  name: string | null
  members: ObjectGroupMember[]
}
export type Consortium = Omit<Contracts.ConsortiumV10, 'stratum' | 'start_phase' | 'end_phase'> & {
  stratum: string
  start_phase: number
  end_phase: number
}
export type TimelineAction = Omit<
  Contracts.TimelineActionV10,
  'action_type' | 'description' | 'start_date' | 'end_date' | 'recurrence' | 'targets' | 'depends_on' | 'completed' | 'order'
> & {
  action_type: string
  description: string
  start_date: string | null
  end_date: string | null
  recurrence: string | null
  targets: Contracts.PanelTargetV10[]
  depends_on: string[] | null
  completed: boolean
  order: number
}
type BudgetTarget = Contracts.BudgetTargetV10 & Record<string, unknown>
export type BudgetItem = Omit<Contracts.BudgetLineV10, 'target' | 'unit_cost'> & {
  target: BudgetTarget
  unit_cost: number
  ext?: Record<string, unknown>
}
type BudgetExt = {
  non_plant_lines?: Record<string, unknown>[]
  [key: string]: unknown
}
export type SiteDataEntry = Omit<Contracts.SiteDataEntryV10, 'order' | 'ramp' | 'reversed' | 'range'> & {
  order: number
  ramp: string | null
  reversed: boolean
  range: Contracts.LidarColourRangeV10 | null
}
export type SiteDataSection = {
  visible: boolean
  entries: SiteDataEntry[]
}
export type DesignSummary = Contracts.DesignSummary
export type DesignNotebookEntry = Contracts.DesignNotebookEntry
export type DesignNotebookSection = Contracts.DesignNotebookSection
export type DesignNotebookSnapshot = Contracts.DesignNotebookSnapshot
export type SavedViewBackground = Contracts.SavedViewBackgroundV10
export type SavedViewCamera = Omit<Contracts.SavedViewCameraV10, 'bearing'> & { bearing: number }
type SavedViewTerrain = {
  hillshade: boolean
  contours: boolean
}
type SavedViewLayers = Omit<
  Contracts.SavedViewLayersV10,
  'background' | 'terrain' | 'scene_layers' | 'site_data'
> & {
  background: Contracts.SavedViewBackgroundV10
  terrain: SavedViewTerrain
  scene_layers: string[]
  site_data: string[]
}
type SavedViewHighlight = Omit<Contracts.SavedViewHighlightV10, 'species' | 'objects'> & {
  species: string[]
  objects: SavedViewObject[]
}
export type SavedView = Omit<
  Contracts.SavedViewV10,
  'name' | 'camera' | 'visible_layers' | 'highlighted' | 'title' | 'text' | 'labels'
> & {
  name: string
  camera: SavedViewCamera
  visible_layers: SavedViewLayers
  highlighted: SavedViewHighlight
  title: string | null
  text?: RichTextBlock[]
  labels?: Contracts.PlantLabels | null
}
export type SavedViewObject = Contracts.SavedViewObjectV10
export type RichTextSpan = Omit<Contracts.RichTextSpanV10, 'text' | 'bold' | 'italic' | 'link'> & {
  text: string
  bold?: boolean
  italic?: boolean
  link?: string | null
}
type RichTextListItem = { spans: RichTextSpan[] }
export type RichTextBlock =
  | { kind: 'paragraph'; spans: RichTextSpan[] }
  | { kind: 'bullets'; items: RichTextListItem[] }
export type StoryImage = Contracts.StoryImageV10
export type StoryStep = Omit<Contracts.StoryStepV10, 'title' | 'text' | 'images'> & {
  title: string
  text?: RichTextBlock[]
  images?: StoryImage[]
}
export type Story = Omit<Contracts.StoryV10, 'name' | 'steps'> & {
  name: string
  steps: StoryStep[]
}

export type PlacedPlant = Omit<
  Contracts.PlacedPlantV10,
  'locked' | 'common_name' | 'color' | 'rotation' | 'canopy_spread_m' | 'notes' | 'planted_date' | 'quantity'
> & {
  locked: boolean
  common_name: string | null
  color: string | null
  pinned_name?: boolean
  rotation: number | null
  canopy_spread_m: number | null
  notes: string | null
  planted_date: string | null
  quantity: number | null
}

/** A Design in memory: the v10 file's fields directly, with unknown root fields under `extra`. */
export type CanopiFile = Omit<
  Contracts.CanopiFileV10,
  | 'name'
  | 'description'
  | 'plant_species_colors'
  | 'layers'
  | 'plants'
  | 'zones'
  | 'annotations'
  | 'measurement_guides'
  | 'consortiums'
  | 'groups'
  | 'timeline'
  | 'budget'
  | 'budget_ext'
  | 'site_data'
  | 'views'
  | 'stories'
  | 'map_view'
  | 'created_at'
  | 'updated_at'
> & {
  name: string
  description: string | null
  plant_species_colors: Record<string, string>
  layers: Layer[]
  plants: PlacedPlant[]
  zones: Zone[]
  annotations: Annotation[]
  measurement_guides?: MeasurementGuide[]
  consortiums: Consortium[]
  groups: ObjectGroup[]
  timeline: TimelineAction[]
  budget: BudgetItem[]
  budget_ext?: BudgetExt | null
  site_data?: SiteDataSection | null
  views?: SavedView[]
  stories?: Story[]
  map_view?: SavedViewCamera | null
  created_at: string
  updated_at: string
  extra?: Record<string, unknown>
}
