import { describe, expect, it } from 'vitest'
import {
  addStory,
  addStoryStep,
  deleteStory,
  deleteStoryStep,
  duplicateStoryStep,
  editWithinImageLimit,
  moveStoryStep,
  moveStoryStepToStory,
  recaptureSavedView,
  renameStory,
  reorderStorySteps,
  updateStoryStep,
} from '../app/design-edit'
import { viewsAndStoriesProblem } from '../app/contracts/views-admission'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { replaceCurrentDesignState, resetDirtyBaselines } from './support/design-session-state'
import type { CanopiFile, SavedView, Story, StoryStep } from '../types/design'

function view(id: string): SavedView {
  return {
    id,
    name: `View ${id}`,
    camera: { lon: 2.2945, lat: 48.8584, zoom: 18, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: {
      background: { kind: 'basemap', style: 'liberty' },
      terrain: { contours: false, hillshade: false },
      scene_layers: ['plants'],
      site_data: [],
    },
    highlighted: { species: [], objects: [] },
    title: 'Title',
    text: [],
  }
}

function step(id: string, viewId = 'a'): StoryStep {
  return { id, view_id: viewId, title: `Step ${id}`, text: [], images: [] }
}

function story(id: string, steps: StoryStep[] = []): Story {
  return { id, name: `Story ${id}`, steps }
}

function open(stories: Story[] = [], views: SavedView[] = [view('a'), view('b')]): void {
  const file: CanopiFile = {
    version: 9, name: 'Stories', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR', views, stories,
    created_at: '', updated_at: '', extra: {},
  }
  replaceCurrentDesignState(file, null, file.name)
  resetDirtyBaselines()
}

const steps = (storyIndex = 0) => currentDesign.value!.stories![storyIndex]!.steps.map((entry) => entry.id)

describe('story Design Edit commands', () => {
  it('adds, renames and deletes stories as Design edits', () => {
    open([story('s1')])
    addStory(story('s2', [step('x')]))
    renameStory('s2', '  Client visit ')
    renameStory('s2', '   ')
    expect(currentDesign.value?.stories?.map((entry) => entry.name)).toEqual(['Story s1', 'Client visit'])
    expect(designSessionStore.designDirty.value).toBe(true)

    const deleted = deleteStory('s1')
    expect(deleted).toEqual({ name: 'Story s1' })
    expect(currentDesign.value?.stories?.map((entry) => entry.id)).toEqual(['s2'])
  })

  it('changes nothing for unknown ids or a repeated value', () => {
    open([story('s1', [step('x')])])
    const before = currentDesign.value
    renameStory('s1', 'Story s1')
    renameStory('missing', 'Name')
    updateStoryStep('s1', 'x', { title: 'Step x' })
    updateStoryStep('s1', 'missing', { title: 'New' })
    moveStoryStep('s1', 'x', 0)
    expect(deleteStory('missing')).toBeNull()
    expect(deleteStoryStep('s1', 'missing')).toBeNull()
    expect(currentDesign.value).toBe(before)
    expect(designSessionStore.designDirty.value).toBe(false)
  })

  it('adds steps only for views that exist, at the end or at an index', () => {
    open([story('s1', [step('x')])])
    addStoryStep('s1', step('y'))
    addStoryStep('s1', step('w'), 0)
    addStoryStep('s1', step('z', 'missing'))
    addStoryStep('s1', step('x'))
    expect(steps()).toEqual(['w', 'x', 'y'])
  })

  it('edits a step’s title, text, images and view, refusing a view that does not exist', () => {
    open([story('s1', [step('x')])])
    const text = [{ kind: 'paragraph' as const, spans: [{ text: 'Hi', bold: true, italic: false, link: null }] }]
    updateStoryStep('s1', 'x', { title: 'Hedges', text, images: [{ src: 'https://example.org/a.png', alt: 'Hedge' }], view_id: 'b' })
    expect(currentDesign.value?.stories?.[0]?.steps[0]).toEqual({
      id: 'x', view_id: 'b', title: 'Hedges', text, images: [{ src: 'https://example.org/a.png', alt: 'Hedge' }],
    })
    updateStoryStep('s1', 'x', { view_id: 'missing' })
    expect(currentDesign.value?.stories?.[0]?.steps[0]?.view_id).toBe('b')
  })

  it('moves, reorders and duplicates steps', () => {
    open([story('s1', [step('x'), step('y'), step('z')])])
    moveStoryStep('s1', 'x', 2)
    expect(steps()).toEqual(['y', 'z', 'x'])
    moveStoryStep('s1', 'x', -5)
    expect(steps()).toEqual(['x', 'y', 'z'])
    reorderStorySteps('s1', ['z', 'x', 'y'])
    expect(steps()).toEqual(['z', 'x', 'y'])
    reorderStorySteps('s1', ['z', 'x'])
    reorderStorySteps('s1', ['z', 'z', 'y'])
    expect(steps()).toEqual(['z', 'x', 'y'])
    duplicateStoryStep('s1', 'x', 'x2')
    expect(steps()).toEqual(['z', 'x', 'x2', 'y'])
    expect(currentDesign.value?.stories?.[0]?.steps[2]).toMatchObject({ view_id: 'a', title: 'Step x' })
  })

  it('moves a step to the end of another story, with a new id only when the id is taken there', () => {
    open([story('s1', [step('x'), step('y')]), story('s2', [step('x')])])
    moveStoryStepToStory('s1', 'y', 's2', 'new-y')
    moveStoryStepToStory('s1', 'x', 's2', 'new-x')
    expect(steps(0)).toEqual([])
    expect(steps(1)).toEqual(['x', 'y', 'new-x'])
  })

  it('deletes a step and returns its title', () => {
    open([story('s1', [step('x'), step('y', 'b')])])
    const deleted = deleteStoryStep('s1', 'x')
    expect(deleted).toEqual({ title: 'Step x' })
    expect(steps()).toEqual(['y'])
  })
})

describe('the 10 MiB of images a Design embeds', () => {
  // 1 MiB less 1 byte of PNG data: the picker's limit per image.
  const image = { src: `data:image/png;base64,${'A'.repeat(1398100)}`, alt: 'photo' }
  const withImages = (id: string, count: number, viewId = 'a'): StoryStep => ({
    ...step(id, viewId),
    images: Array.from({ length: count }, () => image),
  })
  const admitted = () => viewsAndStoriesProblem(currentDesign.value!.views ?? [], currentDesign.value!.stories ?? [])

  it('refuses to duplicate a step whose images would not fit', () => {
    open([story('s1', [withImages('x', 6)])])
    expect(duplicateStoryStep('s1', 'x', 'x2')).toBe('images-do-not-fit')
    expect(steps()).toEqual(['x'])
    expect(admitted()).toBeNull()
    expect(designSessionStore.isDesignDirty()).toBe(false)

    open([story('s1', [withImages('x', 3)])])
    expect(duplicateStoryStep('s1', 'x', 'x2')).toBe('applied')
    expect(steps()).toEqual(['x', 'x2'])
    expect(admitted()).toBeNull()
  })

  it('refuses a snapshot edit that would bring back more images than fit', () => {
    open([story('s1', [withImages('x', 4), withImages('y', 5)])])
    const before = currentDesign.value!.stories
    deleteStoryStep('s1', 'x')
    updateStoryStep('s1', 'y', { images: withImages('y', 9).images })
    expect(editWithinImageLimit((design) => ({ ...design, stories: before }))).toBe('applied')
    expect(admitted()).toBeNull()

    open([story('s1', [withImages('y', 9)])])
    expect(editWithinImageLimit((design) => ({
      ...design,
      stories: [story('s1', [withImages('x', 4), withImages('y', 9)])],
    }))).toBe('images-do-not-fit')
    expect(steps()).toEqual(['y'])
    expect(admitted()).toBeNull()
  })

  it('refuses images added to a step beyond the Design limit', () => {
    open([story('s1', [withImages('x', 6), withImages('y', 0)])])
    updateStoryStep('s1', 'y', { images: withImages('y', 5).images })
    expect(currentDesign.value?.stories?.[0]?.steps[1]?.images).toEqual([])
    expect(admitted()).toBeNull()
  })
})

describe('recapturing a saved view', () => {
  it('replaces what the view shows and keeps its name, title and text', () => {
    open()
    const capture: SavedView = {
      ...view('fresh'),
      name: 'ignored',
      camera: { lon: 3, lat: 45, zoom: 17, bearing: 0, ground_size_m: { width: 340, height: 210 } },
      visible_layers: { ...view('a').visible_layers, background: { kind: 'satellite' } },
      highlighted: { species: ['Lycium barbarum'], objects: [] },
      labels: 'codes',
    }
    recaptureSavedView('a', capture)
    expect(currentDesign.value?.views?.[0]).toEqual({
      ...view('a'),
      camera: capture.camera,
      visible_layers: capture.visible_layers,
      highlighted: capture.highlighted,
      labels: 'codes',
    })

    const before = currentDesign.value
    recaptureSavedView('a', capture)
    recaptureSavedView('missing', capture)
    expect(currentDesign.value).toBe(before)
  })

  it('writes back only the fields a saved view has, never a field the view carried from elsewhere', () => {
    // A view object holding a stray field (the deleted `extent`, say): recapturing builds the view from its named fields.
    const stray = { ...view('a'), extent: { west: 2.9, south: 44.9, east: 3.1, north: 45.1 } } as SavedView
    open([], [stray])
    recaptureSavedView('a', { ...view('fresh'), camera: { lon: 3, lat: 45, zoom: 17, bearing: 0, ground_size_m: { width: 20, height: 15 } } })
    expect(currentDesign.value?.views?.[0]).not.toHaveProperty('extent')
    expect(currentDesign.value?.views?.[0]).toEqual({ ...view('a'), camera: { lon: 3, lat: 45, zoom: 17, bearing: 0, ground_size_m: { width: 20, height: 15 } } })
  })
})
