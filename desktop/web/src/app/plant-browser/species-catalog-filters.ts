import {
  PLANT_FILTER_FIELDS,
  SPECIES_FILTER_FIXED_BEHAVIORS,
  type PlantFilterFieldDef,
  type PlantFilterUiPlacement,
  type SpeciesFilterFixedBehavior,
} from '../../generated/plant-filter-fields'
import type { LocaleKey, LocaleKeyFamily } from '../../generated/locale-keys'
import type { FilterOptions, SpeciesFilter } from '../../types/species'

export type SpeciesFilterKey = Exclude<keyof SpeciesFilter, 'extra'>

type SpeciesFilterValue = SpeciesFilter[SpeciesFilterKey]
type FilterActivityKind = 'array' | 'boolean' | 'numeric' | 'string'

type FilterOptionsKey = keyof Pick<
  FilterOptions,
  'climate_zones' | 'habits' | 'life_cycles' | 'sun_tolerances'
>

const FIXED_FILTER_BEHAVIORS: readonly SpeciesFilterFixedBehavior[] = SPECIES_FILTER_FIXED_BEHAVIORS
const FIXED_FILTER_KEYS = FIXED_FILTER_BEHAVIORS.map((behavior) => behavior.key as SpeciesFilterKey)

interface FilterActivityStrategy {
  readonly key: SpeciesFilterKey
  readonly kind: FilterActivityKind
  readonly countable: boolean
  readonly source: 'schema' | 'adapter'
}

export interface StripOptionSource {
  readonly filterOptionsKey: FilterOptionsKey
  readonly valueI18nPrefix: LocaleKeyFamily
}

export interface StripChoiceField {
  readonly kind: 'choice'
  readonly field?: PlantFilterFieldDef
  readonly filterKey: SpeciesFilterKey
  readonly labelI18nKey: LocaleKey
  readonly optionsKey: FilterOptionsKey
  readonly valueI18nPrefix: LocaleKeyFamily
  readonly color: string
  readonly source: 'schema' | 'adapter'
}

export interface StripBooleanField {
  readonly kind: 'boolean'
  readonly field?: PlantFilterFieldDef
  readonly filterKey: SpeciesFilterKey
  readonly labelI18nKey: LocaleKey
  readonly color: string
  readonly activeValue: boolean
  readonly source: 'schema' | 'adapter'
}

export interface StripThresholdField {
  readonly kind: 'threshold'
  readonly filterKey: SpeciesFilterKey
  readonly labelI18nKey: LocaleKey
  readonly color: string
  readonly min: number
  readonly max: number
  readonly source: 'adapter'
}

export type StripControlField = StripChoiceField | StripBooleanField | StripThresholdField

export interface ActiveArrayChipField {
  readonly kind: 'array'
  readonly filterKey: SpeciesFilterKey
  readonly keyPrefix: string
  readonly valueI18nPrefix: LocaleKeyFamily
  readonly color: string
  readonly source: 'schema' | 'adapter'
}

export interface ActiveBooleanChipField {
  readonly kind: 'boolean'
  readonly filterKey: SpeciesFilterKey
  readonly labelI18nKey: LocaleKey
  readonly color: string
  readonly source: 'schema' | 'adapter'
}

export interface ActiveNumericChipField {
  readonly kind: 'numeric-threshold'
  readonly filterKey: SpeciesFilterKey
  readonly labelI18nKey: LocaleKey
  readonly color: string
  readonly suffix: string
  readonly source: 'adapter'
}

export type ActiveChipField = ActiveArrayChipField | ActiveBooleanChipField | ActiveNumericChipField

const SPECIES_FILTER_KEYS = new Set<string>([
  ...FIXED_FILTER_BEHAVIORS.map((behavior) => behavior.key),
  ...PLANT_FILTER_FIELDS
    .filter((field) => field.uiPlacement === 'strip')
    .map((field) => field.key),
])

const SCHEMA_STRIP_FILTER_KEYS = new Set<string>(
  PLANT_FILTER_FIELDS
    .filter((field) => field.uiPlacement === 'strip')
    .map((field) => field.key),
)

const ADAPTER_FILTER_BEHAVIORS: readonly SpeciesFilterFixedBehavior[] = FIXED_FILTER_BEHAVIORS
  .filter((behavior) => !SCHEMA_STRIP_FILTER_KEYS.has(behavior.key))

function isSpeciesFilterKey(key: string): key is SpeciesFilterKey {
  return SPECIES_FILTER_KEYS.has(key)
}

function activityKindForSchemaField(field: PlantFilterFieldDef): FilterActivityKind {
  switch (field.kind) {
    case 'boolean':
      return 'boolean'
    case 'numeric':
      return 'numeric'
    case 'categorical':
      return 'array'
  }
}

function schemaStripFields(): readonly PlantFilterFieldDef[] {
  return PLANT_FILTER_FIELDS.filter((field) => field.uiPlacement === 'strip')
}

const SCHEMA_STRIP_FILTER_STRATEGIES: readonly FilterActivityStrategy[] = PLANT_FILTER_FIELDS
  .flatMap((field): FilterActivityStrategy[] => {
    if (field.uiPlacement !== 'strip' || !isSpeciesFilterKey(field.key)) return []
    return [{
      key: field.key,
      kind: activityKindForSchemaField(field),
      countable: true,
      source: 'schema',
    }]
  })

const ADAPTER_FILTER_STRATEGIES: readonly FilterActivityStrategy[] = ADAPTER_FILTER_BEHAVIORS
  .map((behavior) => ({
    key: behavior.key as SpeciesFilterKey,
    kind: behavior.kind,
    countable: behavior.countable,
    source: 'adapter' as const,
  }))

export const FILTER_ACTIVITY_STRATEGIES: readonly FilterActivityStrategy[] = [
  ...SCHEMA_STRIP_FILTER_STRATEGIES,
  ...ADAPTER_FILTER_STRATEGIES,
]

export function isActiveValue(kind: FilterActivityKind, value: SpeciesFilterValue): boolean {
  switch (kind) {
    case 'array':
      return Array.isArray(value) && value.length > 0
    case 'boolean':
    case 'numeric':
      return value !== null
    case 'string':
      return typeof value === 'string' && value.length > 0
  }
}

export function fixedFilterKeys(): readonly SpeciesFilterKey[] {
  return FIXED_FILTER_KEYS
}

export function createEmptyFixedFilterState(): Pick<SpeciesFilter, SpeciesFilterKey> {
  return Object.fromEntries(
    FIXED_FILTER_KEYS.map((key) => [key, null]),
  ) as Pick<SpeciesFilter, SpeciesFilterKey>
}

export function fields(options: { placement?: PlantFilterUiPlacement } = {}): readonly PlantFilterFieldDef[] {
  const { placement } = options
  return placement
    ? PLANT_FILTER_FIELDS.filter((field) => field.uiPlacement === placement)
    : PLANT_FILTER_FIELDS
}

export function stripFields(): readonly PlantFilterFieldDef[] {
  return schemaStripFields()
}

export function stripChoiceFields(): readonly StripChoiceField[] {
  const schemaFields = schemaStripFields().flatMap((field): StripChoiceField[] => {
    if (!isSpeciesFilterKey(field.key) || field.kind !== 'categorical') return []
    if (!field.stripChoice) return []
    return [{
      kind: 'choice',
      field,
      filterKey: field.key,
      labelI18nKey: field.i18nKey,
      optionsKey: field.stripChoice.optionsKey as FilterOptionsKey,
      valueI18nPrefix: field.stripChoice.valueI18nPrefix,
      color: field.colorToken,
      source: 'schema',
    }]
  })

  const adapterFields = ADAPTER_FILTER_BEHAVIORS.flatMap((behavior): StripChoiceField[] => {
    if (!behavior.stripChoice) return []
    return [{
      kind: 'choice',
      filterKey: behavior.key as SpeciesFilterKey,
      labelI18nKey: behavior.stripChoice.labelI18nKey,
      optionsKey: behavior.stripChoice.optionsKey as FilterOptionsKey,
      valueI18nPrefix: behavior.stripChoice.valueI18nPrefix,
      color: behavior.stripChoice.colorToken,
      source: 'adapter',
    }]
  })

  return [...schemaFields, ...adapterFields]
}

export function stripThresholdFields(): readonly StripThresholdField[] {
  return ADAPTER_FILTER_BEHAVIORS.flatMap((behavior): StripThresholdField[] => {
    if (!behavior.stripThreshold) return []
    return [{
      kind: 'threshold',
      filterKey: behavior.key as SpeciesFilterKey,
      labelI18nKey: behavior.stripThreshold.labelI18nKey,
      min: behavior.stripThreshold.min,
      max: behavior.stripThreshold.max,
      color: behavior.stripThreshold.colorToken,
      source: 'adapter',
    }]
  })
}

export function stripBooleanFields(): readonly StripBooleanField[] {
  const schemaFields = schemaStripFields().flatMap((field): StripBooleanField[] => {
    if (!isSpeciesFilterKey(field.key) || field.kind !== 'boolean') return []
    return [{
      kind: 'boolean',
      field,
      filterKey: field.key,
      labelI18nKey: field.i18nKey,
      color: field.colorToken,
      activeValue: true,
      source: 'schema',
    }]
  })

  const adapterFields = ADAPTER_FILTER_BEHAVIORS.flatMap((behavior): StripBooleanField[] => {
    if (!behavior.stripBoolean) return []
    return [{
      kind: 'boolean',
      filterKey: behavior.key as SpeciesFilterKey,
      labelI18nKey: behavior.stripBoolean.labelI18nKey,
      color: behavior.stripBoolean.colorToken,
      activeValue: true,
      source: 'adapter',
    }]
  })

  return [...schemaFields, ...adapterFields]
}

export function stripControls(): readonly StripControlField[] {
  return [
    ...stripChoiceFields(),
    ...stripThresholdFields(),
    ...stripBooleanFields(),
  ]
}

export function stripOptionSource(fieldKey: string): StripOptionSource | undefined {
  if (!isSpeciesFilterKey(fieldKey)) return undefined
  const schemaField = fields().find((field) => field.key === fieldKey)
  if (schemaField?.stripChoice) {
    return {
      filterOptionsKey: schemaField.stripChoice.optionsKey as FilterOptionsKey,
      valueI18nPrefix: schemaField.stripChoice.valueI18nPrefix,
    }
  }

  const adapter = ADAPTER_FILTER_BEHAVIORS.find((behavior) => behavior.key === fieldKey)
  return adapter?.stripChoice
    ? {
        filterOptionsKey: adapter.stripChoice.optionsKey as FilterOptionsKey,
        valueI18nPrefix: adapter.stripChoice.valueI18nPrefix,
      }
    : undefined
}

export function hasSpeciesFilterStrategy(fieldKey: string): boolean {
  return FILTER_ACTIVITY_STRATEGIES.some((strategy) => strategy.key === fieldKey)
}

export function activeArrayChipFields(): readonly ActiveArrayChipField[] {
  const schemaFields = schemaStripFields().flatMap((field): ActiveArrayChipField[] => {
    if (!isSpeciesFilterKey(field.key) || field.kind !== 'categorical') return []
    if (!field.activeArrayChip) return []
    return [{
      kind: 'array',
      filterKey: field.key,
      keyPrefix: field.activeArrayChip.keyPrefix,
      valueI18nPrefix: field.activeArrayChip.valueI18nPrefix,
      color: field.colorToken,
      source: 'schema',
    }]
  })

  const adapterFields = ADAPTER_FILTER_BEHAVIORS.flatMap((behavior): ActiveArrayChipField[] => {
    if (!behavior.activeArrayChip) return []
    return [{
      kind: 'array',
      filterKey: behavior.key as SpeciesFilterKey,
      keyPrefix: behavior.activeArrayChip.keyPrefix,
      valueI18nPrefix: behavior.activeArrayChip.valueI18nPrefix,
      color: behavior.activeArrayChip.colorToken,
      source: 'adapter',
    }]
  })

  return [...schemaFields, ...adapterFields]
}

export function activeBooleanChipFields(): readonly ActiveBooleanChipField[] {
  const schemaFields = schemaStripFields().flatMap((field): ActiveBooleanChipField[] => {
    if (!isSpeciesFilterKey(field.key) || field.kind !== 'boolean') return []
    return [{
      kind: 'boolean',
      filterKey: field.key,
      labelI18nKey: field.i18nKey,
      color: field.colorToken,
      source: 'schema',
    }]
  })

  const adapterFields = ADAPTER_FILTER_BEHAVIORS.flatMap((behavior): ActiveBooleanChipField[] => {
    if (!behavior.activeBooleanChip) return []
    return [{
      kind: 'boolean',
      filterKey: behavior.key as SpeciesFilterKey,
      labelI18nKey: behavior.activeBooleanChip.labelI18nKey,
      color: behavior.activeBooleanChip.colorToken,
      source: 'adapter',
    }]
  })

  return [...schemaFields, ...adapterFields]
}

export function activeNumericChipFields(): readonly ActiveNumericChipField[] {
  return ADAPTER_FILTER_BEHAVIORS.flatMap((behavior): ActiveNumericChipField[] => {
    if (!behavior.activeNumericChip) return []
    return [{
      kind: 'numeric-threshold',
      filterKey: behavior.key as SpeciesFilterKey,
      labelI18nKey: behavior.activeNumericChip.labelI18nKey,
      color: behavior.activeNumericChip.colorToken,
      suffix: behavior.activeNumericChip.suffix,
      source: 'adapter',
    }]
  })
}

export function activeChipFields(): readonly ActiveChipField[] {
  return [
    ...activeArrayChipFields(),
    ...activeBooleanChipFields(),
    ...activeNumericChipFields(),
  ]
}
