import { useCallback, useEffect, useMemo, useRef } from 'preact/hooks'
import { batch, useSignal } from '@preact/signals'
import { currentCanvasQuerySurface, currentCanvasSpeciesFocusCommands } from '../../canvas/session'
import { consortiumTarget } from '../../target'
import { moveConsortiumEntry } from '../design-edit'
import { designSessionStore } from '../document-session/store'
import { createPanelTargetPresentationController } from '../panel-targets/presentation'
import {
  buildConsortiumListProjection,
  useConsortiumPlanningSurface,
  type ConsortiumListProjection,
  type ConsortiumPlanningProjection,
  type ConsortiumPlanningRow,
} from '../planning-projection'
import { usePlanningViewState, type ConsortiumListFilter } from '../planning-view/state'
import type { PlantFinderResult } from '../plant-finder/matcher'
import {
  NO_SPECIES_QUICK_FILTERS,
  useSpeciesQuickFilters,
  type SpeciesQuickFilters,
  type SpeciesQuickFilterValue,
} from '../plant-finder/quick-filters'
import { useMapSelectionSpecies } from '../plant-finder/selection'
import { usePlantFinder } from '../plant-finder/use-plant-finder'
import { CONSORTIUM_STRATA, SUCCESSION_PHASE_COUNT } from './time-model'

const consortiumTargetPresentation = createPanelTargetPresentationController('consortium')

interface ConsortiumEditDraft {
  readonly stratum: string
  readonly startPhase: number
  readonly endPhase: number
}

interface ConsortiumEditorState {
  readonly canonicalName: string
  readonly sessionIdentity: object
  readonly draft: ConsortiumEditDraft
}

export interface ConsortiumDockWorkbench {
  readonly projection: ConsortiumPlanningProjection
  readonly list: ConsortiumListProjection
  readonly activeLocale: string
  readonly search: string
  readonly finder: PlantFinderResult<string>
  readonly selectedOnMap: boolean
  readonly mapSelectionPlantCount: number
  /** Stratum and Form, with their counts. */
  readonly quickFilters: SpeciesQuickFilters
  /** Species the finder, the quick filters or the map selection narrow to; null when none is on. */
  readonly highlightedSpecies: ReadonlySet<string> | null
  readonly filter: ConsortiumListFilter | null
  readonly expandedStrata: ReadonlySet<string>
  readonly editor: ConsortiumEditorState | null
  readonly editorInvalid: boolean
  readonly movedOutsideFilter: boolean
  readonly focusedCanonical: string | null
  readonly scrollTop: number
  readonly setSearch: (value: string) => void
  readonly setSelectedOnMap: (value: boolean) => void
  readonly setQuickFilters: (value: SpeciesQuickFilterValue) => void
  readonly clearFilters: () => void
  readonly setFilter: (filter: ConsortiumListFilter | null) => void
  readonly toggleStratum: (stratum: string) => void
  readonly setScrollTop: (value: number) => void
  readonly openEditor: (row: ConsortiumPlanningRow) => void
  readonly updateDraft: (patch: Partial<ConsortiumEditDraft>) => void
  readonly saveEditor: () => boolean
  readonly cancelEditor: () => void
  readonly dismissMovedConfirmation: () => void
  readonly hoverRows: (rows: readonly ConsortiumPlanningRow[]) => void
  readonly hoverRow: (row: ConsortiumPlanningRow) => void
  readonly clearHover: () => void
  readonly toggleSpeciesFocus: (canonicalName: string) => void
}

export function useConsortiumDockWorkbench(): ConsortiumDockWorkbench {
  const surface = useConsortiumPlanningSurface()
  const view = usePlanningViewState()
  const sessionIdentity = designSessionStore.sessionIdentity.value
  const search = view.consortiumSearch.value
  const selectedOnMap = view.consortiumSelectedOnMap.value
  const filter = view.consortiumFilter.value
  const expandedStrata = view.consortiumExpandedStrata.value
  const editor = useSignal<ConsortiumEditorState | null>(null)
  const editorInvalid = useSignal(false)
  const movedOutsideFilter = useSignal(false)
  const projectionRef = useRef(surface.projection)
  projectionRef.current = surface.projection
  const mapSelection = useMapSelectionSpecies()
  const finderSpecies = useMemo(() => surface.projection.rows.map((row) => ({
    canonicalName: row.canonicalName,
    commonName: row.commonName,
    code: row.code,
  })), [surface.projection.rows])
  const finder = usePlantFinder(finderSpecies, search)
  const matches = useMemo(() => finder.active ? new Set(finder.byKey.keys()) : null, [finder])
  const selectedSpecies = useMemo(
    () => selectedOnMap ? new Set(mapSelection.plantCountBySpecies.keys()) : null,
    [mapSelection, selectedOnMap],
  )
  const canonicalNames = useMemo(() => surface.projection.rows.map((row) => row.canonicalName), [surface.projection.rows])
  const quickFilters = useSpeciesQuickFilters(canonicalNames, view.consortiumQuickFilters.value)
  const highlightedSpecies = useMemo(() => {
    const narrowing = [matches, selectedSpecies, quickFilters.allowed].filter((set): set is ReadonlySet<string> => set !== null)
    if (narrowing.length <= 1) return narrowing[0] ?? null
    return new Set([...narrowing[0]!].filter((name) => narrowing.every((set) => set.has(name))))
  }, [matches, quickFilters, selectedSpecies])
  const list = useMemo(() => buildConsortiumListProjection(surface.projection, {
    matches,
    selectedSpecies,
    quickFilterSpecies: quickFilters.allowed,
    filter,
  }), [filter, matches, quickFilters, selectedSpecies, surface.projection])

  useEffect(() => {
    if (view.consortiumExpansionInitialized.peek()) return
    const first = surface.projection.groups.find((group) => group.rows.length > 0)
    view.consortiumExpandedStrata.value = first ? new Set([first.stratum]) : new Set()
    view.consortiumExpansionInitialized.value = true
  }, [surface.projection.groups, view])

  useEffect(() => () => consortiumTargetPresentation.dispose(), [])
  useEffect(() => {
    const current = editor.value
    if (
      current
      && (
        current.sessionIdentity !== sessionIdentity
        || !surface.projection.rows.some((row) => row.canonicalName === current.canonicalName)
      )
    ) {
      editor.value = null
      editorInvalid.value = false
      consortiumTargetPresentation.clearSelectedTargets()
    }
  }, [editor, editorInvalid, sessionIdentity, surface.projection.rows])

  const cancelEditor = useCallback(() => {
    editor.value = null
    editorInvalid.value = false
    consortiumTargetPresentation.clearSelectedTargets()
  }, [editor, editorInvalid])

  const setFilter = useCallback((next: ConsortiumListFilter | null) => {
    view.consortiumFilter.value = next
    movedOutsideFilter.value = false
    if (next) {
      view.consortiumExpandedStrata.value = new Set([
        ...view.consortiumExpandedStrata.peek(),
        next.stratum,
      ])
    }
  }, [movedOutsideFilter, view])

  const toggleStratum = useCallback((stratum: string) => {
    const next = new Set(view.consortiumExpandedStrata.peek())
    if (next.has(stratum)) next.delete(stratum)
    else next.add(stratum)
    view.consortiumExpandedStrata.value = next
  }, [view])

  const openEditor = useCallback((row: ConsortiumPlanningRow) => {
    editorInvalid.value = false
    movedOutsideFilter.value = false
    editor.value = {
      canonicalName: row.canonicalName,
      sessionIdentity: designSessionStore.sessionIdentity.peek(),
      draft: {
        stratum: row.stratum,
        startPhase: row.startPhase,
        endPhase: row.endPhase,
      },
    }
    consortiumTargetPresentation.setSelectedTargets([consortiumTarget(row.canonicalName)])
  }, [editor, editorInvalid, movedOutsideFilter])

  const updateDraft = useCallback((patch: Partial<ConsortiumEditDraft>) => {
    if (!editor.value) return
    editor.value = { ...editor.value, draft: { ...editor.value.draft, ...patch } }
    editorInvalid.value = false
  }, [editor, editorInvalid])

  const saveEditor = useCallback((): boolean => {
    const current = editor.value
    if (
      !current
      || current.sessionIdentity !== designSessionStore.sessionIdentity.peek()
      || !projectionRef.current.rows.some((row) => row.canonicalName === current.canonicalName)
    ) {
      cancelEditor()
      return false
    }
    const { stratum, startPhase, endPhase } = current.draft
    if (
      stratum.trim() === ''
      || !Number.isInteger(startPhase)
      || !Number.isInteger(endPhase)
      || startPhase < 0
      || endPhase >= SUCCESSION_PHASE_COUNT
      || startPhase > endPhase
    ) {
      editorInvalid.value = true
      return false
    }
    const activeFilter = view.consortiumFilter.peek()
    const willMoveOutside = activeFilter !== null && (
      activeFilter.stratum !== stratum
      || (activeFilter.phase !== null && !(startPhase <= activeFilter.phase && endPhase >= activeFilter.phase))
    )
    moveConsortiumEntry(current.canonicalName, { stratum, startPhase, endPhase })
    editor.value = null
    editorInvalid.value = false
    consortiumTargetPresentation.clearSelectedTargets()
    movedOutsideFilter.value = willMoveOutside
    return true
  }, [cancelEditor, editor, editorInvalid, movedOutsideFilter, view])

  const hoverRows = useCallback((rows: readonly ConsortiumPlanningRow[]) => {
    consortiumTargetPresentation.setHoveredTargets(rows.map((row) => consortiumTarget(row.canonicalName)))
  }, [])
  const hoverRow = useCallback((row: ConsortiumPlanningRow) => {
    consortiumTargetPresentation.setHoveredTargets([consortiumTarget(row.canonicalName)])
  }, [])
  const clearHover = useCallback(() => consortiumTargetPresentation.clearHoveredTargets(), [])
  const toggleSpeciesFocus = useCallback((canonicalName: string) => {
    const queries = currentCanvasQuerySurface.peek()
    const commands = currentCanvasSpeciesFocusCommands.peek()
    if (!queries || !commands) return
    commands.focus(queries.getSpeciesFocus().canonicalName === canonicalName ? null : canonicalName)
  }, [])

  return {
    projection: surface.projection,
    list,
    activeLocale: surface.activeLocale,
    search,
    finder,
    selectedOnMap,
    mapSelectionPlantCount: mapSelection.plantCount,
    quickFilters,
    highlightedSpecies,
    filter,
    expandedStrata,
    editor: editor.value,
    editorInvalid: editorInvalid.value,
    movedOutsideFilter: movedOutsideFilter.value,
    focusedCanonical: currentCanvasQuerySurface.value?.getSpeciesFocus().canonicalName ?? null,
    scrollTop: view.consortiumScrollTop,
    setSearch: (value) => { view.consortiumSearch.value = value },
    setSelectedOnMap: (value) => { view.consortiumSelectedOnMap.value = value },
    setQuickFilters: (value) => { view.consortiumQuickFilters.value = value },
    clearFilters: () => {
      batch(() => {
        view.consortiumSearch.value = ''
        view.consortiumSelectedOnMap.value = false
        view.consortiumQuickFilters.value = NO_SPECIES_QUICK_FILTERS
        view.consortiumFilter.value = null
        movedOutsideFilter.value = false
      })
    },
    setFilter,
    toggleStratum,
    setScrollTop: (value) => { view.consortiumScrollTop = value },
    openEditor,
    updateDraft,
    saveEditor,
    cancelEditor,
    dismissMovedConfirmation: () => { movedOutsideFilter.value = false },
    hoverRows,
    hoverRow,
    clearHover,
    toggleSpeciesFocus,
  }
}

export function supportedConsortiumStratum(stratum: string): stratum is (typeof CONSORTIUM_STRATA)[number] {
  return (CONSORTIUM_STRATA as readonly string[]).includes(stratum)
}
