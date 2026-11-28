import { effect } from '@preact/signals'
import { targetIdentity } from '../../target'
import type { PanelTarget } from '../../types/design'
import { storyPresentationOverrides } from '../story-presentation/overrides'
import {
  hoveredPanelTargets,
  matchedPanelTargets,
  selectedPanelTargetOrigin,
  selectedPanelTargets,
} from './state'
import type { PanelTargetPresentationOrigin } from './state'

export type { PanelTargetPresentationOrigin } from './state'

export interface PanelTargetPresentationController {
  readonly origin: PanelTargetPresentationOrigin
  setHoveredTargets(targetList: readonly PanelTarget[]): void
  clearHoveredTargets(): void
  setSelectedTargets(targetList: readonly PanelTarget[]): void
  clearSelectedTargets(): void
  dispose(): void
}

export function createPanelTargetPresentationController(
  origin: PanelTargetPresentationOrigin,
): PanelTargetPresentationController {
  return {
    origin,

    setHoveredTargets(targetList) {
      setHoveredPanelTargets(targetList)
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
