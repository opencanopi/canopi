import { signal, type Signal } from '@preact/signals'
import { designSessionStore } from '../document-session/store'
import type { SpeciesQuickFilterValue } from '../plant-finder/quick-filters'

export type BudgetSort = 'name' | 'highest-total' | 'most-plants'
export type CalendarCompletionFilter = 'open' | 'completed' | 'all'
export type CalendarDisplay = 'month' | 'agenda'

export interface ConsortiumListFilter {
  readonly stratum: string
  readonly phase: number | null
}

export interface PlanningViewState {
  readonly sessionIdentity: object
  readonly plantsSearch: Signal<string>
  readonly plantsSelectedOnMap: Signal<boolean>
  readonly plantsQuickFilters: Signal<SpeciesQuickFilterValue>
  readonly plantsDisplayOpen: Signal<boolean>
  readonly budgetSearch: Signal<string>
  readonly budgetSelectedOnMap: Signal<boolean>
  readonly budgetQuickFilters: Signal<SpeciesQuickFilterValue>
  readonly budgetSort: Signal<BudgetSort>
  readonly budgetMissingPriceOnly: Signal<boolean>
  budgetScrollTop: number
  readonly calendarSearch: Signal<string>
  readonly calendarActionType: Signal<string>
  readonly calendarCompletion: Signal<CalendarCompletionFilter>
  readonly calendarMonth: Signal<string>
  readonly calendarSelectedDate: Signal<string | null>
  readonly calendarDisplay: Signal<CalendarDisplay>
  readonly calendarExpanded: Signal<boolean>
  readonly calendarUnscheduledExpanded: Signal<boolean>
  calendarScrollTop: number
  readonly consortiumSearch: Signal<string>
  readonly consortiumSelectedOnMap: Signal<boolean>
  readonly consortiumQuickFilters: Signal<SpeciesQuickFilterValue>
  readonly consortiumFilter: Signal<ConsortiumListFilter | null>
  readonly consortiumExpandedStrata: Signal<ReadonlySet<string>>
  readonly consortiumExpansionInitialized: Signal<boolean>
  consortiumScrollTop: number
}

let owner: PlanningViewState | null = null

export function usePlanningViewState(): PlanningViewState {
  return planningViewStateFor(designSessionStore.sessionIdentity.value)
}

export function readPlanningViewState(): PlanningViewState {
  return planningViewStateFor(designSessionStore.sessionIdentity.peek())
}

export const inspectorOpen = signal(false)

export function openInspector(): void {
  inspectorOpen.value = true
}

export function closeInspector(): void {
  inspectorOpen.value = false
}

export function disposePlanningViewState(): void {
  owner = null
  inspectorOpen.value = false
}

function planningViewStateFor(sessionIdentity: object): PlanningViewState {
  if (owner?.sessionIdentity === sessionIdentity) return owner
  owner = createPlanningViewState(sessionIdentity)
  return owner
}

function createPlanningViewState(sessionIdentity: object): PlanningViewState {
  const today = new Date()
  const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
  return {
    sessionIdentity,
    plantsSearch: signal(''),
    plantsSelectedOnMap: signal(false),
    plantsQuickFilters: signal<SpeciesQuickFilterValue>({ stratum: null, form: null }),
    plantsDisplayOpen: signal(false),
    budgetSearch: signal(''),
    budgetSelectedOnMap: signal(false),
    budgetQuickFilters: signal<SpeciesQuickFilterValue>({ stratum: null, form: null }),
    budgetSort: signal<BudgetSort>('name'),
    budgetMissingPriceOnly: signal(false),
    budgetScrollTop: 0,
    calendarSearch: signal(''),
    calendarActionType: signal('all'),
    calendarCompletion: signal<CalendarCompletionFilter>('open'),
    calendarMonth: signal(month),
    calendarSelectedDate: signal<string | null>(null),
    calendarDisplay: signal<CalendarDisplay>('month'),
    calendarExpanded: signal(false),
    calendarUnscheduledExpanded: signal(true),
    calendarScrollTop: 0,
    consortiumSearch: signal(''),
    consortiumSelectedOnMap: signal(false),
    consortiumQuickFilters: signal<SpeciesQuickFilterValue>({ stratum: null, form: null }),
    consortiumFilter: signal<ConsortiumListFilter | null>(null),
    consortiumExpandedStrata: signal<ReadonlySet<string>>(new Set()),
    consortiumExpansionInitialized: signal(false),
    consortiumScrollTop: 0,
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposePlanningViewState)
}
