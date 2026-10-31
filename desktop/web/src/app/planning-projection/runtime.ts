import { useMemo } from 'preact/hooks'
import { currentCanvasQuerySurface, currentCanvasSelection } from '../../canvas/session'
import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { buildSpeciesKey, speciesDisplayNames, type SpeciesKeyEntry } from '../../canvas/runtime/species-key'
import { locale } from '../settings/state'
import { DEFAULT_BUDGET_CURRENCY } from '../contracts/document'
import { currentDesign, designName } from '../document-session/store'
import type { BudgetItem, Consortium, PlacedPlant, TimelineAction } from '../../types/design'
import { buildBudgetPlanningProjection, type BudgetPlanningProjection } from './budget'
import { buildConsortiumPlanningProjection, type ConsortiumPlanningProjection } from './consortium'
import { buildTimelineSpeciesOptions, type TimelineSpeciesOption } from './timeline'
import { buildCalendarPlanningProjection, type CalendarPlanningProjection, type PlanningZoneOption } from './calendar'
import { zoneLabel } from '../map-selection/zone-label'
import type { CalendarCompletionFilter } from '../planning-view/state'

const EMPTY_PLANTS: readonly PlacedPlant[] = []
const EMPTY_NAMES: ReadonlyMap<string, string | null> = new Map()
const EMPTY_ENGLISH_NAMES: ReadonlyMap<string, string> = new Map()
const EMPTY_BUDGET: readonly BudgetItem[] = []
const EMPTY_TIMELINE: readonly TimelineAction[] = []
const EMPTY_CONSORTIUMS: readonly Consortium[] = []

interface PlanningProjectionCanvasSnapshot {
  readonly plants: readonly PlacedPlant[]
  /** Names in the UI language, with English fallbacks filled in. */
  readonly localizedNames: ReadonlyMap<string, string | null>
  /** The English catalog names shown for species with no name in the UI language. */
  readonly englishFallbackNames: ReadonlyMap<string, string>
  readonly speciesKey: readonly SpeciesKeyEntry[]
  readonly zones: readonly PlanningZoneOption[]
  readonly selectedPlantIds: readonly string[]
}

export interface BudgetPlanningSurface {
  readonly projection: BudgetPlanningProjection
  readonly currency: string
  readonly designName: string
  readonly activeLocale: string
}

export interface CalendarPlanningSurface {
  readonly actions: readonly TimelineAction[]
  readonly projection: CalendarPlanningProjection
  readonly activeLocale: string
  readonly selectedPlantIds: readonly string[]
  readonly readSelectedPlantIds: () => readonly string[]
  readonly zones: readonly PlanningZoneOption[]
  readonly speciesList: readonly TimelineSpeciesOption[]
}

export interface ConsortiumPlanningSurface {
  readonly consortiums: readonly Consortium[]
  readonly projection: ConsortiumPlanningProjection
  readonly activeLocale: string
}

function readPlanningProjectionCanvasSnapshot(
  session: CanvasQuerySurface | null,
  activeLocale: string,
): PlanningProjectionCanvasSnapshot {
  const localizedNames = session?.getLocalizedCommonNames() ?? EMPTY_NAMES
  const englishFallbackNames = session?.getEnglishFallbackNames() ?? EMPTY_ENGLISH_NAMES
  return {
    plants: session?.getPlacedPlants() ?? EMPTY_PLANTS,
    localizedNames: speciesDisplayNames(localizedNames, englishFallbackNames),
    englishFallbackNames,
    speciesKey: session
      ? buildSpeciesKey(session.getSceneSnapshot(), session.getSpeciesCache(), localizedNames, englishFallbackNames)
      : [],
    zones: session?.getSceneSnapshot().zones.map((zone) => ({ id: zone.id, label: zoneLabel(zone, activeLocale) })) ?? [],
    selectedPlantIds: session?.getSelectedPlantColorContext().plantIds ?? [],
  }
}

function usePlanningProjectionCanvasSnapshot(): PlanningProjectionCanvasSnapshot {
  const session = currentCanvasQuerySurface.value
  const sceneRevision = session?.revision.scene.value ?? 0
  const plantNamesRevision = session?.revision.plantNames.value ?? 0
  const selection = currentCanvasSelection.value
  const activeLocale = locale.value

  return useMemo(
    () => readPlanningProjectionCanvasSnapshot(session, activeLocale),
    [session, sceneRevision, plantNamesRevision, selection, activeLocale],
  )
}

function useBudgetPlanningProjection({
  budget,
  currency,
  locale,
}: {
  readonly budget: readonly BudgetItem[]
  readonly currency: string
  readonly locale: string
}): BudgetPlanningProjection {
  const snapshot = usePlanningProjectionCanvasSnapshot()

  return useMemo(() => buildBudgetPlanningProjection({
    plants: snapshot.plants,
    localizedNames: snapshot.localizedNames,
    englishFallbackNames: snapshot.englishFallbackNames,
    budget,
    currency,
    locale,
    speciesKey: snapshot.speciesKey,
  }), [snapshot, budget, currency, locale])
}

/**
 * The Budget as it stands now, outside any component (File › Export › Budget
 * as CSV…): the same projection the Budget panel shows.
 */
export function readBudgetPlanningSurface(): BudgetPlanningSurface {
  const design = currentDesign.peek()
  const currency = design?.budget_currency ?? DEFAULT_BUDGET_CURRENCY
  const activeLocale = locale.peek()
  const snapshot = readPlanningProjectionCanvasSnapshot(currentCanvasQuerySurface.peek(), activeLocale)
  return {
    projection: buildBudgetPlanningProjection({
      plants: snapshot.plants,
      localizedNames: snapshot.localizedNames,
      englishFallbackNames: snapshot.englishFallbackNames,
      budget: design?.budget ?? EMPTY_BUDGET,
      currency,
      locale: activeLocale,
      speciesKey: snapshot.speciesKey,
    }),
    currency,
    designName: designName.peek(),
    activeLocale,
  }
}

export function useBudgetPlanningSurface(): BudgetPlanningSurface {
  const design = currentDesign.value
  const budget = design?.budget ?? EMPTY_BUDGET
  const currency = design?.budget_currency ?? DEFAULT_BUDGET_CURRENCY
  const activeLocale = locale.value
  const projection = useBudgetPlanningProjection({
    budget,
    currency,
    locale: activeLocale,
  })

  return {
    projection,
    currency,
    designName: designName.value,
    activeLocale,
  }
}

export function useCalendarPlanningSurface(options: {
  readonly month: string
  readonly search: string
  readonly actionType: string
  readonly completion: CalendarCompletionFilter
}): CalendarPlanningSurface {
  const actions = currentDesign.value?.timeline ?? EMPTY_TIMELINE
  const activeLocale = locale.value
  const snapshot = usePlanningProjectionCanvasSnapshot()
  const projection = useMemo(() => buildCalendarPlanningProjection({
    actions,
    plants: snapshot.plants,
    localizedNames: snapshot.localizedNames,
    englishFallbackNames: snapshot.englishFallbackNames,
    zones: snapshot.zones,
    month: options.month,
    search: options.search,
    actionType: options.actionType,
    completion: options.completion,
    locale: activeLocale,
  }), [
    actions,
    activeLocale,
    options.actionType,
    options.completion,
    options.month,
    options.search,
    snapshot.englishFallbackNames,
    snapshot.localizedNames,
    snapshot.plants,
    snapshot.zones,
  ])
  return {
    actions,
    projection,
    activeLocale,
    selectedPlantIds: snapshot.selectedPlantIds,
    readSelectedPlantIds: () => (
      currentCanvasQuerySurface.peek()?.getSelectedPlantColorContext().plantIds ?? []
    ),
    zones: snapshot.zones,
    speciesList: buildTimelineSpeciesOptions(
      snapshot.plants, snapshot.localizedNames, activeLocale, snapshot.speciesKey, snapshot.englishFallbackNames,
    ),
  }
}

function useConsortiumPlanningProjection({
  consortiums,
}: {
  readonly consortiums: readonly Consortium[]
}): ConsortiumPlanningProjection {
  const snapshot = usePlanningProjectionCanvasSnapshot()

  return useMemo(() => buildConsortiumPlanningProjection({
    consortiums,
    plants: snapshot.plants,
    localizedNames: snapshot.localizedNames,
    englishFallbackNames: snapshot.englishFallbackNames,
    speciesKey: snapshot.speciesKey,
  }), [snapshot, consortiums])
}

export function useConsortiumPlanningSurface(): ConsortiumPlanningSurface {
  const consortiums = currentDesign.value?.consortiums ?? EMPTY_CONSORTIUMS
  const activeLocale = locale.value
  const projection = useConsortiumPlanningProjection({ consortiums })

  return {
    consortiums,
    projection,
    activeLocale,
  }
}
