import { afterEach, describe, expect, it } from 'vitest'
import {
  addSavedView,
  deleteSavedView,
  deleteStory,
  deleteStoryStep,
  renameSavedView,
  restoreSavedView,
  restoreStory,
  restoreStoryStep,
} from '../app/design-edit'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { replaceCurrentDesignState } from './support/design-session-state'
import type { CanopiFile, SavedView, Story, StoryStep } from '../types/design'

function design(): CanopiFile {
  return {
    version: 9,
    name: 'Views',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

function view(id: string, zoom = 18): SavedView {
  return {
    id,
    name: `View ${id}`,
    camera: { lon: 2.2945, lat: 48.8584, zoom, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: {
      background: { kind: 'basemap', style: 'liberty' },
      terrain: { contours: false, hillshade: false },
      scene_layers: ['plants'],
      site_data: [],
    },
    highlighted: { species: [], objects: [] },
    title: null,
    text: [],
  }
}

function step(id: string, viewId: string): StoryStep {
  return { id, view_id: viewId, title: `Step ${id}`, text: [], images: [] }
}

function story(id: string, steps: StoryStep[] = []): Story {
  return { id, name: `Story ${id}`, steps }
}

// An edit dirties the Design; the next test opens its own clean one.
afterEach(() => {
  designSessionStore.clearCurrentDesign()
})

function start(overrides: Partial<CanopiFile> = {}): void {
  replaceCurrentDesignState({ ...design(), ...overrides }, null, 'Views')
}

function views(): string[] {
  return (currentDesign.value?.views ?? []).map((entry) => entry.id)
}

function stepsOf(storyId: string): string[] {
  return currentDesign.value?.stories?.find((entry) => entry.id === storyId)?.steps.map((entry) => entry.id) ?? []
}

describe('saved views through Design Edit', () => {
  it('adds and renames views and dirties the Design', () => {
    start()
    expect(designSessionStore.designDirty.value).toBe(false)

    addSavedView(view('a'))
    addSavedView(view('b'))
    expect(views()).toEqual(['a', 'b'])
    expect(designSessionStore.designDirty.value).toBe(true)

    renameSavedView('b', '  Pond  ')
    expect(currentDesign.value?.views?.[1]?.name).toBe('Pond')
  })

  it('leaves the Design untouched when a command changes nothing', () => {
    start()
    addSavedView(view('a'))
    const before = currentDesign.value

    addSavedView(view('a', 3))
    renameSavedView('a', 'View a')
    renameSavedView('a', '   ')
    renameSavedView('missing', 'Pond')
    expect(deleteSavedView('missing')).toBeNull()

    expect(currentDesign.value).toBe(before)
  })

  it('deleting a view removes the story steps that show it and undo restores both in place', () => {
    start({
      views: [view('a'), view('b'), view('c')],
      stories: [
        story('s', [step('1', 'a'), step('2', 'b'), step('3', 'a')]),
        story('t', [step('4', 'c')]),
      ],
    })

    const deletion = deleteSavedView('a')

    expect(views()).toEqual(['b', 'c'])
    expect(stepsOf('s')).toEqual(['2'])
    expect(stepsOf('t')).toEqual(['4'])
    expect(deletion?.view.id).toBe('a')
    expect(deletion?.index).toBe(0)
    expect(deletion?.steps.map((entry) => [entry.storyId, entry.step.id, entry.index])).toEqual([
      ['s', '1', 0],
      ['s', '3', 2],
    ])

    addSavedView(view('d'))
    restoreSavedView(deletion!)

    expect(views()).toEqual(['a', 'b', 'c', 'd'])
    expect(stepsOf('s')).toEqual(['1', '2', '3'])
  })

  // Delete story A (step S shows V), delete V (no step to confirm), Undo the
  // story (S cannot come back: V is gone), Undo the view: S is back in A.
  it('a step dropped by a story Undo because its view was gone returns with the view\'s Undo', () => {
    start({ views: [view('v'), view('w')], stories: [story('a', [step('1', 'w'), step('s', 'v'), step('3', 'w')])] })
    const storyDeletion = deleteStory('a')!
    const viewDeletion = deleteSavedView('v')!
    expect(viewDeletion.steps).toEqual([])

    restoreStory(storyDeletion)
    expect(stepsOf('a')).toEqual(['1', '3'])

    restoreSavedView(viewDeletion)
    expect(views()).toEqual(['v', 'w'])
    expect(stepsOf('a')).toEqual(['1', 's', '3'])

    const restored = currentDesign.value
    restoreSavedView(viewDeletion)
    expect(currentDesign.value).toBe(restored)
  })

  it('a step whose own Undo met a missing view returns with the view\'s Undo, at its place', () => {
    start({ views: [view('v'), view('w')], stories: [story('a', [step('s', 'v'), step('2', 'w')])] })
    const stepDeletion = deleteStoryStep('a', 's')!
    const viewDeletion = deleteSavedView('v')!

    restoreStoryStep(stepDeletion)
    expect(stepsOf('a')).toEqual(['2'])

    restoreSavedView(viewDeletion)
    expect(stepsOf('a')).toEqual(['s', '2'])
  })

  it('parked steps belong to the Design session that dropped them', () => {
    start({ views: [view('v')], stories: [story('a', [step('s', 'v')])] })
    const storyDeletion = deleteStory('a')!
    const viewDeletion = deleteSavedView('v')!
    restoreStory(storyDeletion)

    start({ views: [], stories: [story('a', [])] })
    restoreSavedView(viewDeletion)
    expect(views()).toEqual(['v'])
    expect(stepsOf('a')).toEqual([])
  })

  it('restoring twice or after the story went away keeps references whole', () => {
    start({ views: [view('a')], stories: [story('s', [step('1', 'a')])] })
    const deletion = deleteSavedView('a')!

    restoreSavedView(deletion)
    const restored = currentDesign.value
    restoreSavedView(deletion)
    expect(currentDesign.value).toBe(restored)

    deleteSavedView('a')
    start({ views: [], stories: [] })
    restoreSavedView(deletion)
    expect(views()).toEqual(['a'])
    expect(currentDesign.value?.stories).toEqual([])
  })
})
