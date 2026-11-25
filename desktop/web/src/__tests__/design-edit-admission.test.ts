import { describe, expect, it } from 'vitest'
import {
  addSavedView,
  addStory,
  addStoryStep,
  deleteSavedView,
  deleteStory,
  deleteStoryStep,
  duplicateStoryStep,
  moveStoryStep,
  moveStoryStepToStory,
  recaptureSavedView,
  renameSavedView,
  renameStory,
  reorderStorySteps,
  updateStoryStep,
} from '../app/design-edit'
import { viewsAndStoriesProblem } from '../app/contracts/views-admission'
import { currentDesign } from '../app/document-session/store'
import { replaceCurrentDesignState, resetDirtyBaselines } from './support/design-session-state'
import type { CanopiFile, SavedView, Story, StoryStep } from '../types/design'

// A save never refuses to write (canopi-ut80). Instead, every Design Edit
// command on views and stories must leave a Design that opening admits, even
// when a caller hands it ids that already exist or point at nothing.

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

const step = (id: string, viewId = 'a'): StoryStep => ({ id, view_id: viewId, title: `Step ${id}`, text: [], images: [] })
const story = (id: string, steps: StoryStep[] = []): Story => ({ id, name: `Story ${id}`, steps })

function open(stories: Story[], views: SavedView[]): void {
  const file: CanopiFile = {
    version: 9, name: 'Admission', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR', views, stories,
    created_at: '', updated_at: '', extra: {},
  }
  replaceCurrentDesignState(file, null, file.name)
  resetDirtyBaselines()
}

function problem(): string | null {
  const design = currentDesign.value!
  return viewsAndStoriesProblem(design.views ?? [], design.stories ?? [])
}

describe('every view and story edit keeps the Design openable', () => {
  it('admits the Design after each command, including colliding and dangling ids', () => {
    open([story('s1', [step('x'), step('y', 'b')]), story('s2', [step('z')])], [view('a'), view('b')])
    const edits: Array<[string, () => unknown]> = [
      ['add a view whose id exists', () => addSavedView(view('a'))],
      ['add a new view', () => addSavedView(view('c'))],
      ['recapture a view', () => recaptureSavedView('c', view('other'))],
      ['rename a view', () => renameSavedView('c', 'Renamed')],
      ['add a story whose id exists', () => addStory(story('s1'))],
      ['add a story with a step on a missing view', () => addStory(story('s3', [step('q', 'missing')]))],
      ['add a story with duplicate step ids', () => addStory(story('s4', [step('d'), step('d')]))],
      ['add a step whose id exists in its story', () => addStoryStep('s1', step('x'))],
      ['add a step on a missing view', () => addStoryStep('s1', step('w', 'missing'))],
      ['point a step at a missing view', () => updateStoryStep('s1', 'x', { view_id: 'missing' })],
      ['duplicate a step onto an existing id', () => duplicateStoryStep('s1', 'x', 'y')],
      ['duplicate a step', () => duplicateStoryStep('s1', 'x', 'x2')],
      ['move a step to a story that has its id', () => moveStoryStepToStory('s2', 'z', 's1', 'x')],
      ['reorder with unknown and repeated ids', () => reorderStorySteps('s1', ['y', 'y', 'nope'])],
      ['move a step past the end', () => moveStoryStep('s1', 'x', 99)],
      ['rename a story', () => renameStory('s1', 'Visit')],
    ]
    for (const [label, edit] of edits) {
      edit()
      expect(problem(), label).toBeNull()
    }

    deleteSavedView('b')
    expect(problem(), 'delete a view that steps use').toBeNull()
    deleteStoryStep('s1', 'x')
    deleteStory('s1')
    expect(problem(), 'delete a step and a story').toBeNull()
  })
})
