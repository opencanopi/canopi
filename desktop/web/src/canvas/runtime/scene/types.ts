import type { SpeciesFocus } from '../species-key'
import type {
  SceneDesignObjectSelection,
  SceneDesignObjectTarget,
} from './design-object-targets'

export interface ScenePoint {
  x: number
  y: number
}

export interface SceneLayerEntity {
  kind: 'layer'
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  unknownFields?: Record<string, unknown>
}

export interface ScenePlantEntity {
  kind: 'plant'
  id: string
  locked: boolean
  canonicalName: string
  commonName: string | null
  color: string | null
  symbol?: string | null
  pinnedName?: boolean
  /** The catalog width when the plant was placed (the file's `canopy_spread_m`); never filled in later. */
  canopySpreadM: number | null
  position: ScenePoint
  rotationDeg: number | null
  notes: string | null
  plantedDate: string | null
  quantity: number | null
  unknownFields?: Record<string, unknown>
}

export interface SceneZoneEntity {
  kind: 'zone'
  /** Stable identity; targets, groups and saved views refer to it. */
  id: string
  /** The name the user gave, or null; labels then use the type and size. */
  name: string | null
  locked: boolean
  zoneType: string
  points: ScenePoint[]
  rotationDeg: number
  fillColor: string | null
  strokeColor?: string | null
  opacity?: number | null
  notes: string | null
  unknownFields?: Record<string, unknown>
}

export interface SceneAnnotationEntity {
  kind: 'annotation'
  id: string
  locked: boolean
  annotationType: string
  position: ScenePoint
  text: string
  fontSize: number
  rotationDeg: number | null
  unknownFields?: Record<string, unknown>
}

export interface SceneMeasurementGuideEntity {
  kind: 'measurement-guide'
  id: string
  locked: boolean
  start: ScenePoint
  end: ScenePoint
  unknownFields?: Record<string, unknown>
}

export type SceneObjectGroupMember =
  | { readonly kind: 'plant'; readonly id: string; readonly unknownFields?: Record<string, unknown> }
  | { readonly kind: 'zone'; readonly id: string; readonly unknownFields?: Record<string, unknown> }
  | { readonly kind: 'annotation'; readonly id: string; readonly unknownFields?: Record<string, unknown> }
  | { readonly kind: 'measurement-guide'; readonly id: string; readonly unknownFields?: Record<string, unknown> }

export interface SceneObjectGroupEntity {
  kind: 'group'
  id: string
  locked: boolean
  name: string | null
  members: SceneObjectGroupMember[]
  unknownFields?: Record<string, unknown>
}

export interface ScenePersistedState {
  plantSpeciesColors: Record<string, string>
  plantSpeciesSymbols: Record<string, string>
  plantSpeciesCodes: Record<string, string>
  layers: SceneLayerEntity[]
  plants: ScenePlantEntity[]
  zones: SceneZoneEntity[]
  annotations: SceneAnnotationEntity[]
  measurementGuides: SceneMeasurementGuideEntity[]
  groups: SceneObjectGroupEntity[]
}

export interface SceneSessionState {
  speciesFocus: SpeciesFocus
  selectedTargets: SceneDesignObjectSelection
  hoveredTarget: SceneDesignObjectTarget | null
}
