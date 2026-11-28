import { afterEach, describe, expect, it } from 'vitest'
import {
  createPanelTargetPresentationController,
} from '../app/panel-targets/presentation'
import {
  hoveredPanelTargets,
  selectedPanelTargetOrigin,
  selectedPanelTargets,
} from '../app/panel-targets/state'
import { speciesTarget } from '../target'

describe('Target Presentation', () => {
  afterEach(() => {
    hoveredPanelTargets.value = []
    selectedPanelTargetOrigin.value = null
    selectedPanelTargets.value = []
  })

  it('cleans up only the selected targets owned by its origin', () => {
    const budgetPresentation = createPanelTargetPresentationController('budget')
    const timelinePresentation = createPanelTargetPresentationController('timeline')

    budgetPresentation.setHoveredTargets([speciesTarget('Hovered')])
    timelinePresentation.setSelectedTargets([speciesTarget('Timeline selected')])

    budgetPresentation.dispose()

    expect(hoveredPanelTargets.value).toEqual([])
    expect(selectedPanelTargets.value).toEqual([speciesTarget('Timeline selected')])
    expect(selectedPanelTargetOrigin.value).toBe('timeline')

    timelinePresentation.dispose()

    expect(selectedPanelTargets.value).toEqual([])
    expect(selectedPanelTargetOrigin.value).toBeNull()
  })
})
