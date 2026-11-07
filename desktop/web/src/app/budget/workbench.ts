import { useCallback, useEffect, useMemo, useRef } from 'preact/hooks'
import { batch, useSignal } from '@preact/signals'
import {
  buildBudgetListProjection,
  useBudgetPlanningSurface,
  type BudgetListProjection,
  type BudgetPlanningProjection,
  type BudgetPlanningRow,
} from '../planning-projection'
import { createPanelTargetPresentationController } from '../panel-targets/presentation'
import { setBudgetCurrency, setPlantBudgetPrice } from '../design-edit'
import { designSessionStore } from '../document-session/store'
import { usePlanningViewState, type BudgetSort } from '../planning-view/state'
import { currentCanvasQuerySurface, currentCanvasSpeciesFocusCommands } from '../../canvas/session'
import type { PlantFinderResult } from '../plant-finder/matcher'
import {
  NO_SPECIES_QUICK_FILTERS,
  useSpeciesQuickFilters,
  type SpeciesQuickFilters,
  type SpeciesQuickFilterValue,
} from '../plant-finder/quick-filters'
import { useMapSelectionSpecies } from '../plant-finder/selection'
import { usePlantFinder } from '../plant-finder/use-plant-finder'
import { isCancelledFailure } from '../../failures/ipc-failure'
import { exportBudgetCsv } from './export'
import { budgetPriceRequest } from './price-request'
import {
  budgetCurrencySymbol,
  formatBudgetCurrency,
  formatBudgetPriceInput,
  parseBudgetPriceInput,
} from './formatting'

const budgetTargetPresentation = createPanelTargetPresentationController('budget')

export interface BudgetItemWorkbench {
  readonly projection: BudgetPlanningProjection
  readonly list: BudgetListProjection
  readonly currency: string
  readonly activeLocale: string
  readonly search: string
  readonly finder: PlantFinderResult<string>
  /** Stratum and Form, with their counts. */
  readonly quickFilters: SpeciesQuickFilters
  readonly sort: BudgetSort
  readonly missingPriceOnly: boolean
  readonly missingPriceCount: number
  readonly selectedOnMap: boolean
  readonly mapSelectionPlantCount: number
  readonly currencySymbol: string
  readonly editingCanonical: string | null
  readonly editPrice: string
  readonly priceInvalid: boolean
  readonly exportPending: boolean
  readonly exportFailed: boolean
  readonly focusedCanonical: string | null
  /** Moves when another surface asked for a price (Set unit cost…): the panel focuses that field. */
  readonly priceFocusRequest: number
  readonly scrollTop: number
  readonly setSearch: (value: string) => void
  readonly setSort: (value: BudgetSort) => void
  readonly setMissingPriceOnly: (value: boolean) => void
  readonly setSelectedOnMap: (value: boolean) => void
  readonly setQuickFilters: (value: SpeciesQuickFilterValue) => void
  readonly clearFilters: () => void
  /** The unit cost as the field shows it: the draft while editing, else locale decimals. */
  readonly priceInputValue: (row: BudgetPlanningRow) => string
  readonly setScrollTop: (value: number) => void
  readonly setEditPrice: (value: string) => void
  readonly clearHover: () => void
  readonly hoverRow: (row: BudgetPlanningRow) => void
  readonly toggleSpeciesFocus: (canonical: string) => void
  readonly setCurrency: (currency: string) => void
  readonly startPriceEdit: (canonical: string) => void
  readonly commitPriceEdit: (canonical: string, advance?: boolean) => boolean
  readonly cancelPriceEdit: () => void
  readonly formatCurrency: (amount: number) => string
  readonly exportCsv: () => Promise<void>
}

export type BudgetPriceDraftResult =
  | { readonly valid: true; readonly value: number }
  | { readonly valid: false }

/** Accepts locale decimals ("3,90" in French) as well as a dot. */
export function validateBudgetPriceDraft(value: string, locale = 'en'): BudgetPriceDraftResult {
  const parsed = parseBudgetPriceInput(value, locale)
  return parsed === null ? { valid: false } : { valid: true, value: parsed }
}

export function useBudgetItemWorkbench(): BudgetItemWorkbench {
  const {
    projection,
    currency,
    designName,
    activeLocale,
  } = useBudgetPlanningSurface()
  const view = usePlanningViewState()
  const sessionIdentity = designSessionStore.sessionIdentity.value
  const search = view.budgetSearch.value
  const sort = view.budgetSort.value
  const missingPriceOnly = view.budgetMissingPriceOnly.value
  const selectedOnMap = view.budgetSelectedOnMap.value
  const mapSelection = useMapSelectionSpecies()
  const finderSpecies = useMemo(() => projection.rows.map((row) => ({
    canonicalName: row.canonical,
    commonName: row.commonName,
    code: row.code,
  })), [projection.rows])
  const finder = usePlantFinder(finderSpecies, search)
  const canonicalNames = useMemo(() => projection.rows.map((row) => row.canonical), [projection.rows])
  const quickFilters = useSpeciesQuickFilters(canonicalNames, view.budgetQuickFilters.value)
  const editingCanonical = useSignal<string | null>(null)
  const editPrice = useSignal('')
  const priceInvalid = useSignal(false)
  const exportPending = useSignal(false)
  const exportFailed = useSignal(false)
  const editingIdentityRef = useRef<object | null>(null)
  // The draft a price field showed when editing began; null when it had no price.
  const shownPriceRef = useRef<string | null>(null)
  const exportEpochRef = useRef(0)
  const projectionRef = useRef(projection)
  const list = useMemo(() => buildBudgetListProjection(projection, {
    matches: finder.active ? new Set(finder.byKey.keys()) : null,
    selectedSpecies: selectedOnMap ? new Set(mapSelection.plantCountBySpecies.keys()) : null,
    quickFilterSpecies: quickFilters.allowed,
    missingPriceOnly,
    sort,
    locale: activeLocale,
  }), [activeLocale, finder, mapSelection, missingPriceOnly, projection, quickFilters, selectedOnMap, sort])
  const listRef = useRef(list)
  projectionRef.current = projection
  listRef.current = list

  useEffect(() => () => {
    exportEpochRef.current += 1
    budgetTargetPresentation.dispose()
  }, [])
  useEffect(() => {
    if (
      editingCanonical.value !== null
      && (
        editingIdentityRef.current !== sessionIdentity
        || !projection.rows.some((row) => row.canonical === editingCanonical.value)
      )
    ) {
      editingCanonical.value = null
      editingIdentityRef.current = null
      priceInvalid.value = false
    }
  }, [editingCanonical, priceInvalid, projection.rows, sessionIdentity])

  const clearHover = useCallback(() => {
    budgetTargetPresentation.clearHoveredTargets()
  }, [])

  const hoverRow = useCallback((row: BudgetPlanningRow) => {
    budgetTargetPresentation.setHoveredTargets([row.target])
  }, [])

  const toggleSpeciesFocus = useCallback((canonical: string) => {
    const queries = currentCanvasQuerySurface.peek()
    const commands = currentCanvasSpeciesFocusCommands.peek()
    if (!queries || !commands) return
    commands.focus(queries.getSpeciesFocus().canonicalName === canonical ? null : canonical)
  }, [])

  const startPriceEdit = useCallback((canonical: string) => {
    if (editingCanonical.peek() === canonical) return
    const existing = projectionRef.current.lineItemPriceMap.get(canonical)
    editPrice.value = existing ? formatBudgetPriceInput(existing.unit_cost, activeLocale) : ''
    shownPriceRef.current = existing ? editPrice.value : null
    priceInvalid.value = false
    editingIdentityRef.current = designSessionStore.sessionIdentity.peek()
    editingCanonical.value = canonical
  }, [activeLocale, editPrice, editingCanonical, priceInvalid])

  const commitPriceEdit = useCallback((canonical: string, advance = false): boolean => {
    // A replaced input may emit blur after Enter has already advanced the editor.
    // Ignore that stale event without cancelling the next row's active draft.
    if (editingCanonical.value !== canonical) return false
    if (
      editingIdentityRef.current !== designSessionStore.sessionIdentity.peek()
      || !projectionRef.current.rows.some((row) => row.canonical === canonical)
    ) {
      editingCanonical.value = null
      editingIdentityRef.current = null
      return false
    }
    const parsed = validateBudgetPriceDraft(editPrice.value, activeLocale)
    if (!parsed.valid) {
      priceInvalid.value = true
      return false
    }

    // Leaving an untouched field writes nothing, so the stored price is never
    // replaced by how the field displays it.
    if (editPrice.value !== shownPriceRef.current) setPlantBudgetPrice(canonical, parsed.value)
    priceInvalid.value = false
    if (advance) {
      const rows = listRef.current.rows
      const next = rows[rows.findIndex((row) => row.canonical === canonical) + 1]
      if (next) {
        const existing = projectionRef.current.lineItemPriceMap.get(next.canonical)
        editPrice.value = existing ? formatBudgetPriceInput(existing.unit_cost, activeLocale) : ''
        shownPriceRef.current = existing ? editPrice.value : null
        editingCanonical.value = next.canonical
        return true
      }
    }
    editingCanonical.value = null
    editingIdentityRef.current = null
    return true
  }, [activeLocale, editPrice, editingCanonical, priceInvalid])

  const cancelPriceEdit = useCallback(() => {
    editingCanonical.value = null
    editingIdentityRef.current = null
    priceInvalid.value = false
  }, [editingCanonical, priceInvalid])

  const setEditPrice = useCallback((value: string) => {
    editPrice.value = value
    priceInvalid.value = value.trim() !== '' && !validateBudgetPriceDraft(value, activeLocale).valid
  }, [activeLocale, editPrice, priceInvalid])

  // Set unit cost… from the map: that species' price, its row shown even under filters.
  const priceRequest = budgetPriceRequest.value
  const priceFocusRequest = useSignal(0)
  useEffect(() => {
    if (!priceRequest) return
    budgetPriceRequest.value = null
    const canonical = priceRequest.canonicalName
    if (priceRequest.sessionIdentity !== designSessionStore.sessionIdentity.peek()) return
    if (!projectionRef.current.rows.some((row) => row.canonical === canonical)) return
    batch(() => {
      if (!listRef.current.rows.some((row) => row.canonical === canonical)) {
        view.budgetSearch.value = ''
        view.budgetMissingPriceOnly.value = false
        view.budgetSelectedOnMap.value = false
        view.budgetQuickFilters.value = NO_SPECIES_QUICK_FILTERS
      }
      startPriceEdit(canonical)
      priceFocusRequest.value += 1
    })
  }, [priceRequest, priceFocusRequest, startPriceEdit, view])

  const formatCurrency = useCallback((amount: number) => (
    formatBudgetCurrency(amount, currency, activeLocale)
  ), [activeLocale, currency])

  const exportCsv = useCallback(async () => {
    const request = ++exportEpochRef.current
    const identity = designSessionStore.sessionIdentity.peek()
    exportFailed.value = false
    exportPending.value = true
    try {
      await exportBudgetCsv(projection.rows, {
        currency,
        designName,
        lineItemPriceMap: projection.lineItemPriceMap,
        grandTotal: projection.grandTotal,
      })
      if (
        request === exportEpochRef.current
        && identity === designSessionStore.sessionIdentity.peek()
      ) exportPending.value = false
    } catch (error) {
      if (
        request !== exportEpochRef.current
        || identity !== designSessionStore.sessionIdentity.peek()
      ) return
      exportPending.value = false
      if (isCancelledFailure(error)) return
      exportFailed.value = true
      console.error('Budget export failed:', error)
    }
  }, [currency, designName, exportFailed, exportPending, projection])

  return {
    projection,
    list,
    currency,
    activeLocale,
    search,
    finder,
    quickFilters,
    sort,
    missingPriceOnly,
    missingPriceCount: projection.rows.length - projection.pricedCount,
    selectedOnMap,
    mapSelectionPlantCount: mapSelection.plantCount,
    currencySymbol: budgetCurrencySymbol(currency, activeLocale),
    editingCanonical: editingCanonical.value,
    editPrice: editPrice.value,
    priceInvalid: priceInvalid.value,
    exportPending: exportPending.value,
    exportFailed: exportFailed.value,
    focusedCanonical: currentCanvasQuerySurface.value?.getSpeciesFocus().canonicalName ?? null,
    priceFocusRequest: priceFocusRequest.value,
    scrollTop: view.budgetScrollTop,
    setSearch: (value) => { view.budgetSearch.value = value },
    setSort: (value) => { view.budgetSort.value = value },
    setMissingPriceOnly: (value) => { view.budgetMissingPriceOnly.value = value },
    setSelectedOnMap: (value) => { view.budgetSelectedOnMap.value = value },
    setQuickFilters: (value) => { view.budgetQuickFilters.value = value },
    clearFilters: () => {
      batch(() => {
        view.budgetSearch.value = ''
        view.budgetMissingPriceOnly.value = false
        view.budgetSelectedOnMap.value = false
        view.budgetQuickFilters.value = NO_SPECIES_QUICK_FILTERS
      })
    },
    priceInputValue: (row) => (
      editingCanonical.value === row.canonical
        ? editPrice.value
        : row.hasPrice ? formatBudgetPriceInput(row.unitCost, activeLocale) : ''
    ),
    setScrollTop: (value) => { view.budgetScrollTop = value },
    setEditPrice,
    clearHover,
    hoverRow,
    toggleSpeciesFocus,
    setCurrency: setBudgetCurrency,
    startPriceEdit,
    commitPriceEdit,
    cancelPriceEdit,
    formatCurrency,
    exportCsv,
  }
}
