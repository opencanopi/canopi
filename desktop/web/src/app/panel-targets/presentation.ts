import { effect } from '@preact/signals'
import { isSpeciesTarget, targetIdentity, speciesTarget } from '../../target'
import type { PanelTarget } from '../../generated/contracts'
import { storyPresentationOverrides } from '../story-presentation/overrides'
import {
  hoveredCanvasTargets,
  hoveredPanelTargets,
  matchedPanelTargets,
  selectedPanelTargetOrigin,
  selectedPanelTargets,
} from './state'
import type { PanelTargetPresentationOrigin } from './state'

export type { PanelTargetPresentationOrigin } from './state'

interface PanelTargetSelectionSnapshot {
  readonly origin: PanelTargetPresentationOrigin | null
  readonly targets: readonly PanelTarget[]
  readonly ownsOrigin: boolean
}

export interface PanelTargetPresentationController {
  readonly origin: PanelTargetPresentationOrigin
  readSelection(): PanelTargetSelectionSnapshot
  selectionMatches(
    selection: PanelTargetSelectionSnapshot,
    targetList: readonly PanelTarget[],
  ): boolean
  setHoveredTargets(targetList: readonly PanelTarget[]): void
  setHoveredSpecies(canonicalName: string): void
  clearHoveredTargets(): void
  setSelectedTargets(targetList: readonly PanelTarget[]): void
  clearSelectedTargets(): void
  pruneSelection(visibleTargetLists: readonly (readonly PanelTarget[])[]): void
  readCanvasHoveredSpeciesCanonical(): string | null
  dispose(): void
}

export interface PanelTargetOverlaySnapshot {
  readonly hoveredTargets: readonly PanelTarget[]
  readonly selectedTargets: readonly PanelTarget[]
}

function readPanelTargetSelection(
  origin: PanelTargetPresentationOrigin,
): PanelTargetSelectionSnapshot {
  const currentOrigin = selectedPanelTargetOrigin.value
  const targets = selectedPanelTargets.value
  return {
    origin: currentOrigin,
    targets,
    ownsOrigin: currentOrigin === origin && targets.length > 0,
  }
}

function panelTargetSelectionMatches(
  selection: PanelTargetSelectionSnapshot,
  targetList: readonly PanelTarget[],
): boolean {
  return selection.ownsOrigin && targetIdentity.listEquals(selection.targets, targetList)
}

export function createPanelTargetPresentationController(
  origin: PanelTargetPresentationOrigin,
): PanelTargetPresentationController {
  return {
    origin,

    readSelection() {
      return readPanelTargetSelection(origin)
    },

    selectionMatches(selection, targetList) {
      return panelTargetSelectionMatches(selection, targetList)
    },

    setHoveredTargets(targetList) {
      setHoveredPanelTargets(targetList)
    },

    setHoveredSpecies(canonicalName) {
      setHoveredPanelSpecies(canonicalName)
    },

    clearHoveredTargets() {
      clearHoveredPanelTargets()
    },

    setSelectedTargets(targetList) {
      setSelectedPanelTargets(origin, targetList)
    },

    clearSelectedTargets() {
      clearSelectedPanelTargetsForOrigin(origin)
    },

    pruneSelection(visibleTargetLists) {
      prunePanelTargetSelectionForOrigin(origin, visibleTargetLists)
    },

    readCanvasHoveredSpeciesCanonical() {
      return getCanvasHoveredSpeciesCanonical()
    },

    dispose() {
      clearHoveredPanelTargets()
      clearSelectedPanelTargetsForOrigin(origin)
    },
  }
}

export function setHoveredPanelTargets(targetList: readonly PanelTarget[]): void {
  if (!targetIdentity.listEquals(hoveredPanelTargets.peek(), targetList)) {
    hoveredPanelTargets.value = targetList
  }
}

function setHoveredPanelSpecies(canonicalName: string): void {
  setHoveredPanelTargets([speciesTarget(canonicalName)])
}

export function clearHoveredPanelTargets(): void {
  if (hoveredPanelTargets.peek().length > 0) {
    hoveredPanelTargets.value = []
  }
}

export function setSelectedPanelTargets(
  origin: PanelTargetPresentationOrigin,
  targetList: readonly PanelTarget[],
): void {
  if (!targetIdentity.listEquals(selectedPanelTargets.peek(), targetList)) {
    selectedPanelTargets.value = targetList
  }
  selectedPanelTargetOrigin.value = targetList.length > 0 ? origin : null
}

export function clearSelectedPanelTargetsForOrigin(
  origin: PanelTargetPresentationOrigin,
): void {
  if (selectedPanelTargetOrigin.peek() !== origin) return
  if (selectedPanelTargets.peek().length > 0) {
    selectedPanelTargets.value = []
  }
  selectedPanelTargetOrigin.value = null
}

export function setMatchedPanelTargets(targetList: readonly PanelTarget[]): void {
  if (!targetIdentity.listEquals(matchedPanelTargets.peek(), targetList)) {
    matchedPanelTargets.value = targetList
  }
}

export function clearPanelOriginTargets(): void {
  clearHoveredPanelTargets()
  setMatchedPanelTargets([])
  if (selectedPanelTargets.peek().length > 0) {
    selectedPanelTargets.value = []
  }
  if (selectedPanelTargetOrigin.peek() !== null) {
    selectedPanelTargetOrigin.value = null
  }
}

function prunePanelTargetSelectionForOrigin(
  origin: PanelTargetPresentationOrigin,
  visibleTargetLists: readonly (readonly PanelTarget[])[],
): void {
  if (selectedPanelTargetOrigin.peek() !== origin) return
  const selected = selectedPanelTargets.peek()
  if (selected.length === 0) {
    selectedPanelTargetOrigin.value = null
    return
  }
  if (visibleTargetLists.some((targetList) => targetIdentity.listEquals(selected, targetList))) return
  clearSelectedPanelTargetsForOrigin(origin)
}

export function getSpeciesCanonicalFromTargets(
  targets: readonly PanelTarget[],
): string | null {
  for (const target of targets) {
    if (isSpeciesTarget(target)) return target.canonical_name
  }
  return null
}

export function getCanvasHoveredSpeciesCanonical(): string | null {
  return getSpeciesCanonicalFromTargets(hoveredCanvasTargets.value)
}

export function setCanvasHoveredTargets(targetList: readonly PanelTarget[]): void {
  if (!targetIdentity.listEquals(hoveredCanvasTargets.peek(), targetList)) {
    hoveredCanvasTargets.value = targetList
  }
}

/** What the canvas rings: a presented story step's targets alone, else the panels' selection, hover and matches. */
export function readPanelOriginTargets(): readonly PanelTarget[] {
  const presented = storyPresentationOverrides.value
  if (presented) return presented.targets
  return [
    ...selectedPanelTargets.value,
    ...hoveredPanelTargets.value,
    ...matchedPanelTargets.value,
  ]
}

export function readPanelTargetOverlaySnapshot(): PanelTargetOverlaySnapshot {
  // A presented story step rings what its view highlights, and nothing else.
  const presented = storyPresentationOverrides.value
  if (presented) return { hoveredTargets: [], selectedTargets: presented.targets }
  return {
    hoveredTargets: hoveredPanelTargets.value,
    selectedTargets: selectedPanelTargets.value,
  }
}

export function subscribePanelOriginTargetChanges(
  onChange: () => void,
): () => void {
  return effect(() => {
    void hoveredPanelTargets.value
    void selectedPanelTargets.value
    void matchedPanelTargets.value
    void storyPresentationOverrides.value
    onChange()
  })
}
