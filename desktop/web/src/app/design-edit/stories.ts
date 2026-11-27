import { STORY_IMAGES_MAX_TOTAL_BYTES } from '../../generated/canopi-design-format'
import type { CanopiFile, RichTextBlock, Story, StoryImage, StoryStep } from '../../types/design'
import { normaliseObjectName } from './object-name'
import { designEmbeddedImageBytes } from '../contracts/views-admission'
import { editCurrentDesign } from './core'

// Stories are Design Edit data (ADR 0011), like saved views: every command
// dirties the Design for continuous save, none is in the scene history, and a
// command that changes nothing returns the Design untouched. A step shows a
// saved view of the same Design by id; callers pass only ids of views that
// exist, and deleting a view (views.ts) removes the steps that show it.
// A Design embeds at most 10 MiB of images, the limit admission refuses above;
// a command that would take it over (duplicating a step, an Undo) changes
// nothing and says `images-do-not-fit`, so continuous save never writes a
// Design that cannot be opened again.

/** What a story command did. */
export type StoryEditOutcome = 'applied' | 'unchanged' | 'images-do-not-fit'

/** The fields of a step an editor changes. */
type StoryStepPatch = Partial<Pick<StoryStep, 'title' | 'text' | 'images' | 'view_id'>>

function viewExists(design: CanopiFile, viewId: string): boolean {
  return (design.views ?? []).some((view) => view.id === viewId)
}

/** Whether `next` may replace `design`: its images fit, or it embeds no more than before. */
function imagesFit(design: CanopiFile, next: CanopiFile): boolean {
  const bytes = designEmbeddedImageBytes(next)
  return bytes <= STORY_IMAGES_MAX_TOTAL_BYTES || bytes <= designEmbeddedImageBytes(design)
}

/** A Design Edit whose result must keep the Design's images within their limit. */
export function editWithinImageLimit(update: (design: CanopiFile) => CanopiFile, label = 'stories.edit'): StoryEditOutcome {
  let outcome: StoryEditOutcome = 'unchanged'
  editCurrentDesign((design) => {
    const next = update(design)
    if (next === design) {
      outcome = 'unchanged'
      return design
    }
    if (next.stories !== design.stories && !imagesFit(design, next)) {
      outcome = 'images-do-not-fit'
      return design
    }
    outcome = 'applied'
    return next
  }, label)
  return outcome
}

function editStories(update: (stories: readonly Story[], design: CanopiFile) => readonly Story[]): StoryEditOutcome {
  return editWithinImageLimit((design) => {
    const stories = design.stories ?? []
    const next = update(stories, design)
    return next === stories ? design : { ...design, stories: [...next] }
  })
}

function editStory(storyId: string, update: (story: Story) => Story): StoryEditOutcome {
  return editStories((stories) => {
    const index = stories.findIndex((story) => story.id === storyId)
    if (index === -1) return stories
    const next = update(stories[index]!)
    if (next === stories[index]) return stories
    const copy = [...stories]
    copy[index] = next
    return copy
  })
}

/** Adds a story when its id is new, its step ids are unique and every step's view exists. */
export function addStory(story: Story): void {
  editStories((stories, design) => {
    if (stories.some((existing) => existing.id === story.id)) return stories
    const stepIds = new Set(story.steps.map((step) => step.id))
    if (stepIds.size !== story.steps.length) return stories
    if (!story.steps.every((step) => viewExists(design, step.view_id))) return stories
    return [...stories, story]
  })
}

/** Renames a story; a blank name keeps the old one (2.1-Q87). */
export function renameStory(storyId: string, name: string): void {
  const normalised = normaliseObjectName(name)
  if (!normalised.ok) return
  const nextName = normalised.name
  editStory(storyId, (story) => story.name === nextName ? story : { ...story, name: nextName })
}

export function deleteStory(storyId: string): { readonly name: string } | null {
  let deleted: { readonly name: string } | null = null
  editStories((stories) => {
    const target = stories.find((story) => story.id === storyId)
    if (!target) return stories
    deleted = { name: target.name }
    return stories.filter((story) => story.id !== storyId)
  })
  return deleted
}

/** Adds a step at `index` (the end by default) when its view exists. */
export function addStoryStep(storyId: string, step: StoryStep, index?: number): StoryEditOutcome {
  return editWithinImageLimit((design) => {
    if (!(design.views ?? []).some((view) => view.id === step.view_id)) return design
    const stories = design.stories ?? []
    const storyIndex = stories.findIndex((story) => story.id === storyId)
    const story = stories[storyIndex]
    if (!story || story.steps.some((existing) => existing.id === step.id)) return design
    const steps = [...story.steps]
    steps.splice(index === undefined ? steps.length : Math.max(0, Math.min(index, steps.length)), 0, step)
    const next = [...stories]
    next[storyIndex] = { ...story, steps }
    return { ...design, stories: next }
  })
}

export function updateStoryStep(storyId: string, stepId: string, patch: StoryStepPatch): StoryEditOutcome {
  return editWithinImageLimit((design) => {
    if (patch.view_id !== undefined && !(design.views ?? []).some((view) => view.id === patch.view_id)) return design
    const stories = design.stories ?? []
    const storyIndex = stories.findIndex((story) => story.id === storyId)
    const story = stories[storyIndex]
    const stepIndex = story?.steps.findIndex((step) => step.id === stepId) ?? -1
    if (!story || stepIndex === -1) return design
    const step = story.steps[stepIndex]!
    const changed = (Object.keys(patch) as (keyof StoryStepPatch)[])
      .some((key) => patch[key] !== undefined && !sameValue(patch[key], step[key]))
    if (!changed) return design
    const steps = [...story.steps]
    steps[stepIndex] = { ...step, ...definedFields(patch) }
    const next = [...stories]
    next[storyIndex] = { ...story, steps }
    return { ...design, stories: next }
  })
}

/** Moves a step to `toIndex` within its story. */
export function moveStoryStep(storyId: string, stepId: string, toIndex: number): void {
  editStory(storyId, (story) => {
    const from = story.steps.findIndex((step) => step.id === stepId)
    const to = Math.max(0, Math.min(toIndex, story.steps.length - 1))
    if (from === -1 || from === to) return story
    const steps = [...story.steps]
    const [step] = steps.splice(from, 1)
    steps.splice(to, 0, step!)
    return { ...story, steps }
  })
}

/** Puts a story's steps in the given order; ids that are not exactly its steps change nothing. */
export function reorderStorySteps(storyId: string, stepIds: readonly string[]): void {
  editStory(storyId, (story) => {
    if (stepIds.length !== story.steps.length) return story
    const byId = new Map(story.steps.map((step) => [step.id, step]))
    const steps = stepIds.map((id) => byId.get(id))
    if (steps.some((step) => !step) || new Set(stepIds).size !== stepIds.length) return story
    if (steps.every((step, index) => step === story.steps[index])) return story
    return { ...story, steps: steps as StoryStep[] }
  })
}

/** Moves a step to the end of another story, as one edit. */
export function moveStoryStepToStory(fromStoryId: string, stepId: string, toStoryId: string, newStepId: string): void {
  if (fromStoryId === toStoryId) return
  editStories((stories) => {
    const from = stories.findIndex((story) => story.id === fromStoryId)
    const to = stories.findIndex((story) => story.id === toStoryId)
    const step = stories[from]?.steps.find((entry) => entry.id === stepId)
    if (from === -1 || to === -1 || !step) return stories
    // Step ids are unique within a story; the moved step keeps its id when it can.
    const id = stories[to]!.steps.some((entry) => entry.id === step.id) ? newStepId : step.id
    const fromStory = stories[from]!
    const toStory = stories[to]!
    const copy = [...stories]
    copy[from] = { ...fromStory, steps: fromStory.steps.filter((entry) => entry.id !== stepId) }
    copy[to] = { ...toStory, steps: [...toStory.steps, { ...step, id }] }
    return copy
  })
}

/** Copies a step right after itself under a new id; the copy shows the same view. */
export function duplicateStoryStep(storyId: string, stepId: string, newStepId: string): StoryEditOutcome {
  return editStory(storyId, (story) => {
    const index = story.steps.findIndex((step) => step.id === stepId)
    if (index === -1 || story.steps.some((step) => step.id === newStepId)) return story
    const steps = [...story.steps]
    steps.splice(index + 1, 0, { ...story.steps[index]!, id: newStepId })
    return { ...story, steps }
  })
}

export function deleteStoryStep(storyId: string, stepId: string): { readonly title: string } | null {
  let deleted: { readonly title: string } | null = null
  editStory(storyId, (story) => {
    const target = story.steps.find((step) => step.id === stepId)
    if (!target) return story
    deleted = { title: target.title }
    return { ...story, steps: story.steps.filter((step) => step.id !== stepId) }
  })
  return deleted
}

function definedFields(patch: StoryStepPatch): StoryStepPatch {
  const fields: { -readonly [Key in keyof StoryStepPatch]: StoryStepPatch[Key] } = {}
  if (patch.title !== undefined) fields.title = patch.title
  if (patch.text !== undefined) fields.text = patch.text as RichTextBlock[]
  if (patch.images !== undefined) fields.images = patch.images as StoryImage[]
  if (patch.view_id !== undefined) fields.view_id = patch.view_id
  return fields
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
