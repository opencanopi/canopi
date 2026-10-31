// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'

vi.mock('../app/saved-views/thumbnails', async (importOriginal) => {
  const actual = await importOriginal<typeof SavedViewsThumbnailsModule>()
  // Thumbnails have their own tests; here they stay empty frames.
  return { ...actual, useSavedViewThumbnail: () => ({ url: null, status: 'loading' as const }) }
})

import { StoriesPanel } from '../components/panels/StoriesPanel'
import { dismissStoryUndo, selectStep, selectStory, storyUndo } from '../app/stories'
import { leaveStoryPresentation, presentedStep, storyPresentationActive } from '../app/story-presentation'
import { StoryPresenter } from '../components/stories/StoryPresenter'
import type { KeyRouterHandle } from '../app/keyboard/key-router'
import { installWebKeyRouter } from '../web/browser-shell-commands'
import { installDesktopKeys } from './support/desktop-key-router'
import { pressKey } from './support/key-router'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { mapZoomToStageScale } from '../canvas/projection'
import { createSessionPlane } from '../canvas/session-plane'
import { setCurrentCanvasSession } from '../canvas/session'
import { locale } from '../app/settings/state'
import type { CanopiFile, SavedView, Story, StoryStep } from '../types/design'
import type { ViewCamera } from '../canvas/runtime/view/types'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import { TEST_GEO_ORIGIN } from './support/geo-design'
import type * as SavedViewsThumbnailsModule from '../app/saved-views/thumbnails'

function view(id: string, name: string): SavedView {
  return {
    id,
    name,
    camera: { lon: TEST_GEO_ORIGIN.lon, lat: TEST_GEO_ORIGIN.lat, zoom: 19, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: {
      background: { kind: 'satellite' },
      terrain: { contours: true, hillshade: false },
      scene_layers: ['plants'],
      site_data: [],
    },
    highlighted: { species: ['Lycium barbarum'], objects: [{ kind: 'plant', id: 'p1' }, { kind: 'zone', id: 'z1' }] },
    title: null,
    text: [],
  }
}

function step(id: string, viewId: string, title: string, text = ''): StoryStep {
  return {
    id, view_id: viewId, title,
    text: text ? [{ kind: 'paragraph', spans: [{ text, bold: false, italic: false, link: null }] }] : [],
    images: [],
  }
}

const VISIT: Story = {
  id: 'visit',
  name: 'Client visit',
  steps: [
    step('s1', 'site', 'The site', 'Where water moves'),
    step('s2', 'hedges', 'Berry hedges', 'Two hedges of goji'),
    step('s3', 'site', 'Back to the site'),
  ],
}
const OPEN_DAY: Story = { id: 'open-day', name: 'Open day', steps: [] }

function design(stories: Story[] = [VISIT, OPEN_DAY]): CanopiFile {
  return {
    version: 9, name: 'Stories', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR',
    views: [view('site', 'The site'), view('hedges', 'Berry hedges')],
    stories, created_at: '', updated_at: '', extra: {},
  }
}

let container: HTMLDivElement
let showCamera: ReturnType<typeof vi.fn<(camera: ViewCamera, options?: { readonly motion?: 'fly' | 'jump' }) => void>>

function mountMap(): void {
  const scale = mapZoomToStageScale(18, TEST_GEO_ORIGIN.lat)
  const queries = createTestCanvasQuerySurface({
    placement: { x: 200, y: 150, scale },
    sessionPlane: createSessionPlane(TEST_GEO_ORIGIN),
  })
  queries.getLocalizedCommonNames = () => new Map([['Lycium barbarum', 'Goji']])
  const commands = createTestCanvasCommandSurface()
  showCamera = vi.fn()
  commands.viewport.showCamera = showCamera
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands, queries }))
}

/**
 * Polls until `done` (asynchronous work such as jsdom's FileReader finishing and rendering).
 * The 2.5 MB image below takes jsdom a few seconds to base64-encode under load.
 */
async function until(done: () => boolean): Promise<void> {
  await vi.waitFor(async () => {
    // act() holds Preact's renders until it returns; an empty one flushes what arrived.
    await act(async () => {})
    expect(done()).toBe(true)
  }, { timeout: 10_000, interval: 10 })
}

async function renderPanel(): Promise<void> {
  await act(async () => { render(<StoriesPanel />, container) })
}

function stepIds(storyIndex = 0): string[] {
  return currentDesign.value!.stories![storyIndex]!.steps.map((entry) => entry.id)
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-story-step]')]
}

function button(name: string | RegExp, root: ParentNode = container): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => {
    const label = candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''
    return typeof name === 'string' ? label.trim() === name : name.test(label)
  })
  if (!found) throw new Error(`No button ${String(name)}`)
  return found
}

async function openMenuItem(trigger: HTMLButtonElement, itemId: string): Promise<void> {
  await act(async () => { trigger.click() })
  const item = document.querySelector<HTMLButtonElement>(`[data-command="${itemId}"]`)
  if (!item) throw new Error(`No menu item ${itemId}`)
  await act(async () => { item.click() })
}

let keys: KeyRouterHandle | null = null

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.append(container)
  replaceCurrentDesignState(design(), null, 'Stories')
  designSessionStore.resetDirtyBaselines()
})

afterEach(() => {
  keys?.dispose()
  keys = null
  leaveStoryPresentation()
  render(null, container)
  container.remove()
  dismissStoryUndo()
  setCurrentCanvasSession(null)
  document.body.replaceChildren()
})

describe('Stories panel', () => {
  it('offers New story when the Design has none, and selects the new story', async () => {
    replaceCurrentDesignState(design([]), null, 'Stories')
    await renderPanel()
    expect(container.textContent).toContain('No stories yet')

    await act(async () => { button('New story').click() })

    expect(currentDesign.value?.stories?.map((story) => story.name)).toEqual(['Story 1'])
    expect(container.textContent).toContain('Story 1')
    expect(container.textContent).not.toContain('No stories yet')
    expect(designSessionStore.designDirty.value).toBe(true)
  })

  it('lists the steps with their number, title and first line of text, and a step count', async () => {
    await renderPanel()
    expect(rows().map((row) => row.querySelector('[aria-current], button:nth-of-type(2)')?.textContent)).toEqual([
      '1Step 1: The siteWhere water moves',
      '2Step 2: Berry hedgesTwo hedges of goji',
      '3Step 3: Back to the site',
    ])
    expect(container.querySelector('footer')?.textContent).toContain('3 steps · saved with the Design')
  })

  it('switches stories with the selector', async () => {
    await renderPanel()
    await act(async () => { selectStory('open-day') })
    expect(rows()).toHaveLength(0)
    expect(container.textContent).toContain('This story has no steps yet')
  })

  it('adds the current map view as a step: a new saved view, a step showing it, selected for editing', async () => {
    mountMap()
    await renderPanel()

    await act(async () => { button('Add the current view as a step').click() })

    const story = currentDesign.value!.stories![0]!
    const added = story.steps.at(-1)!
    expect(added.title).toBe('Step 4')
    const saved = currentDesign.value!.views!.find((entry) => entry.id === added.view_id)!
    expect(saved.name).toBe('Client visit · step 4')
    // A step's view records the ground it frames, so the step keeps its frame on any screen.
    expect(saved.camera.ground_size_m).toEqual({ width: expect.any(Number), height: expect.any(Number) })
    expect(container.querySelector(`[data-step-editor="${added.id}"]`)).not.toBeNull()
  })

  it('cannot add a step without the Design on a map', async () => {
    await renderPanel()
    expect(button('Add the current view as a step').disabled).toBe(true)
    expect(container.textContent).toContain('Open the Design on the map to add steps.')
  })

  it('reorders steps with Alt ↑ and Alt ↓ on the handle', async () => {
    await renderPanel()
    const handle = button('Reorder step 1')
    expect(handle.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    })
    expect(stepIds()).toEqual(['s2', 's1', 's3'])
    await act(async () => {
      button('Reorder step 1').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
    })
    expect(stepIds()).toEqual(['s2', 's1', 's3'])
    await act(async () => {
      button('Reorder step 1').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(stepIds()).toEqual(['s2', 's1', 's3'])
  })

  it('presents the story from the selected step, and only once it has steps and a map', async () => {
    await renderPanel()
    expect(button('Present').disabled).toBe(true)
    mountMap()
    await act(async () => { selectStep('s2') })
    expect(button('Present').disabled).toBe(false)
    await act(async () => { button('Present').click() })
    expect(presentedStep.value?.step.id).toBe('s2')
    await act(async () => { leaveStoryPresentation() })

    await act(async () => { selectStory('open-day') })
    expect(button('Present').disabled).toBe(true)
    expect(button('Present').getAttribute('aria-describedby')).not.toBeNull()
  })

  it('gives focus back to the Present button after leaving, though the panel stepped aside meanwhile', async () => {
    mountMap()
    function Workspace() {
      // As the workspace does: the dock (and so this panel) steps aside while presenting.
      return (
        <>
          {storyPresentationActive.value ? null : <StoriesPanel />}
          <StoryPresenter />
        </>
      )
    }
    await act(async () => { render(<Workspace />, container) })
    const present = button('Present')
    present.focus()
    await act(async () => { present.click() })
    expect(present.isConnected).toBe(false)
    expect(document.activeElement?.textContent).toContain('Next')

    await act(async () => {
      container.querySelector('[data-story-presenter]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(storyPresentationActive.value).toBe(false)
    // Focus returns to Present once the presenter has unmounted and the panel re-rendered.
    await vi.waitFor(() => expect(document.activeElement).toBe(button('Present')))
  })

  it('reorders steps by dragging the handle', async () => {
    await renderPanel()
    for (const [index, row] of rows().entries()) {
      row.getBoundingClientRect = () => ({ top: index * 60, height: 60, bottom: index * 60 + 60, left: 0, right: 300, width: 300, x: 0, y: index * 60, toJSON: () => ({}) })
    }
    const handle = button('Reorder step 1')
    const pointer = (type: string, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }) as MouseEvent & { pointerId: number }
      Object.defineProperty(event, 'pointerId', { value: 1 })
      return event
    }
    handle.setPointerCapture = () => undefined
    handle.releasePointerCapture = () => undefined
    await act(async () => { handle.dispatchEvent(pointer('pointerdown', 10)) })
    await act(async () => { document.dispatchEvent(pointer('pointermove', 150)) })
    expect(rows().map((row) => row.dataset.storyStep)).toEqual(['s2', 's3', 's1'])
    expect(stepIds()).toEqual(['s1', 's2', 's3'])
    await act(async () => { document.dispatchEvent(pointer('pointerup', 150)) })
    expect(stepIds()).toEqual(['s2', 's3', 's1'])
  })

  it('duplicates, moves and deletes a step from its More menu; Undo brings a deleted step back', async () => {
    await renderPanel()
    await openMenuItem(button('More actions for step 1'), 'duplicate')
    expect(stepIds()).toHaveLength(4)
    expect(currentDesign.value!.stories![0]!.steps[1]).toMatchObject({ view_id: 'site', title: 'The site' })

    await openMenuItem(button('More actions for step 4'), 'move-up')
    expect(stepIds()[2]).toBe('s3')
    expect(stepIds()[3]).toBe('s2')

    await act(async () => { button('More actions for step 2').click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-command="move-to"]')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-command="move-to:open-day"]')!.click() })
    expect(stepIds(1)).toHaveLength(1)
    expect(stepIds()).toEqual(['s1', 's3', 's2'])

    await openMenuItem(button('More actions for step 1'), 'delete')
    expect(stepIds()).toEqual(['s3', 's2'])
    expect(storyUndo.value?.message).toBe('Deleted step “The site”')
    await act(async () => { button('Undo').click() })
    expect(stepIds()).toEqual(['s1', 's3', 's2'])
  })

  it('answers Ctrl Z with the Undo toast’s undo while it shows, but not in a text field', async () => {
    await renderPanel()
    await openMenuItem(button('More actions for step 1'), 'delete')
    expect(stepIds()).toEqual(['s2', 's3'])

    keys = installDesktopKeys()

    const field = document.createElement('input')
    document.body.append(field)
    expect(pressKey({ key: 'z', code: 'KeyZ', ctrlKey: true }, field).defaultPrevented).toBe(false)
    expect(stepIds()).toEqual(['s2', 's3'])

    expect(pressKey({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    expect(stepIds()).toEqual(['s2', 's3'])

    let undo: KeyboardEvent | null = null
    await act(async () => { undo = pressKey({ key: 'z', code: 'KeyZ', ctrlKey: true }) })
    expect(undo!.defaultPrevented).toBe(true)
    expect(stepIds()).toEqual(['s1', 's2', 's3'])
    expect(storyUndo.value).toBeNull()
    // Nothing left to undo: Ctrl Z goes on to the map's history (no canvas here, so nothing takes it).
    expect(pressKey({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(false)
  })

  it('leaves Ctrl Z to the map when the Undo toast is not on screen', async () => {
    await renderPanel()
    await openMenuItem(button('More actions for this story'), 'delete-story')
    expect(storyUndo.value).not.toBeNull()
    await act(async () => { render(null, container) })
    keys = installDesktopKeys()
    expect(pressKey({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(currentDesign.value!.stories!.map((story) => story.id)).toEqual(['open-day'])
  })

  it('undoes a story delete with Ctrl Z through both editions’ key routing', async () => {
    await renderPanel()
    await openMenuItem(button('More actions for this story'), 'delete-story')
    const web = installWebKeyRouter({
      catalog: [],
      readState: () => ({ hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: 'stories' }),
    })
    try {
      await act(async () => { pressKey({ key: 'z', code: 'KeyZ', ctrlKey: true }) })
      expect(currentDesign.value!.stories!.map((story) => story.id)).toEqual(['visit', 'open-day'])
    } finally {
      web.dispose()
    }
    await openMenuItem(button('More actions for this story'), 'delete-story')
    keys = installDesktopKeys()
    await act(async () => { pressKey({ key: 'z', code: 'KeyZ', ctrlKey: true }) })
    expect(currentDesign.value!.stories!.map((story) => story.id)).toEqual(['visit', 'open-day'])
  })

  it('renames and deletes a story from its menu, with Undo', async () => {
    await renderPanel()
    await openMenuItem(button('More actions for this story'), 'rename-story')
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Story name"]')!
    await act(async () => {
      field.value = 'Visit in June'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { field.form!.requestSubmit() })
    expect(currentDesign.value!.stories![0]!.name).toBe('Visit in June')

    await openMenuItem(button('More actions for this story'), 'delete-story')
    expect(currentDesign.value!.stories!.map((story) => story.id)).toEqual(['open-day'])
    await act(async () => { button('Undo').click() })
    expect(currentDesign.value!.stories!.map((story) => story.id)).toEqual(['visit', 'open-day'])
  })
})

describe('step editor', () => {
  async function openStep(stepId: string): Promise<HTMLElement> {
    await renderPanel()
    await act(async () => { selectStep(stepId) })
    return container.querySelector<HTMLElement>(`[data-step-editor="${stepId}"]`)!
  }

  it('opens on the selected step and edits its title as Design Edit data', async () => {
    const editor = await openStep('s2')
    expect(editor.querySelector('h3')?.textContent).toBe('Step 2')
    expect(rows()[1]!.querySelector('[aria-current="step"]')).not.toBeNull()
    const title = editor.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      title.value = 'Goji hedges'
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(currentDesign.value!.stories![0]!.steps[1]!.title).toBe('Goji hedges')
  })

  it('says what the step shows: its view, background, terrain, highlights and labels', async () => {
    mountMap()
    const editor = await openStep('s2')
    expect([...editor.querySelectorAll('[data-tag-kind]')].map((tag) => tag.textContent)).toEqual([
      'View: Berry hedges', 'Satellite', 'Contour lines', 'Goji highlighted', '2 objects highlighted', 'Labels: names',
    ])
  })

  it('warns that other steps share the view, uses the current map view for it and goes to it', async () => {
    mountMap()
    const editor = await openStep('s1')
    expect(editor.textContent).toContain('Another step shows this view too; it changes with it.')

    await act(async () => { button('Use the current map view', editor).click() })
    const site = currentDesign.value!.views!.find((entry) => entry.id === 'site')!
    expect(site.name).toBe('The site')
    expect(site.camera.zoom).toBeCloseTo(18, 5)
    expect(site.visible_layers.background).toEqual({ kind: 'basemap', style: 'liberty' })

    await act(async () => { button('Go to this view', editor).click() })
    expect(showCamera).toHaveBeenCalledTimes(1)
  })

  it('keeps pasted text to the block model: no raw HTML is stored', async () => {
    const editor = await openStep('s3')
    const surface = editor.querySelector<HTMLElement>('[data-rich-text-editor]')!
    surface.focus()
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) => type === 'text/html'
          ? '<p>Water <b>first</b><script>alert(1)</script><img src=x onerror=alert(1)></p><ul><li><a href="javascript:x">bad</a></li><li><a href="https://example.org">good</a></li></ul>'
          : 'Water first',
      },
    })
    await act(async () => { surface.dispatchEvent(paste) })

    expect(paste.defaultPrevented).toBe(true)
    const text = currentDesign.value!.stories![0]!.steps[2]!.text
    expect(text).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Water ', bold: false, italic: false, link: null }, { text: 'first', bold: true, italic: false, link: null }] },
      { kind: 'bullets', items: [
        { spans: [{ text: 'bad', bold: false, italic: false, link: null }] },
        { spans: [{ text: 'good', bold: false, italic: false, link: 'https://example.org' }] },
      ] },
    ])
    expect(surface.querySelector('script, img')).toBeNull()
    expect(JSON.stringify(text)).not.toMatch(/<|script|javascript/)
  })

  it('reads typing back into blocks', async () => {
    const editor = await openStep('s3')
    const surface = editor.querySelector<HTMLElement>('[data-rich-text-editor]')!
    await act(async () => {
      surface.innerHTML = '<p>Mulch <strong>in</strong> <em>autumn</em></p>'
      surface.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(currentDesign.value!.stories![0]!.steps[2]!.text).toEqual([
      { kind: 'paragraph', spans: [
        { text: 'Mulch ', bold: false, italic: false, link: null },
        { text: 'in', bold: true, italic: false, link: null },
        { text: ' ', bold: false, italic: false, link: null },
        { text: 'autumn', bold: false, italic: true, link: null },
      ] },
    ])
  })

  it('adds a link to the selected text, refusing addresses that are not web or e-mail', async () => {
    const editor = await openStep('s1')
    const surface = editor.querySelector<HTMLElement>('[data-rich-text-editor]')!
    const text = surface.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)

    await act(async () => { button('Add link', editor).click() })
    const field = editor.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!
    await act(async () => {
      field.value = 'javascript:alert(1)'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { field.form!.requestSubmit() })
    expect(editor.textContent).toContain('Use a web address')

    await act(async () => {
      field.value = 'example.org/water'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { field.form!.requestSubmit() })
    expect(currentDesign.value!.stories![0]!.steps[0]!.text).toEqual([
      { kind: 'paragraph', spans: [
        { text: 'Where ', bold: false, italic: false, link: null },
        { text: 'water', bold: false, italic: false, link: 'https://example.org/water' },
        { text: ' moves', bold: false, italic: false, link: null },
      ] },
    ])
  })

  it('edits and removes an embedded image, never storing a blank description, and cancels a new one', async () => {
    replaceCurrentDesignState(design([{ ...VISIT, steps: [{ ...VISIT.steps[0]!, images: [{ src: 'data:image/png;base64,iVBORw==', alt: 'Hedge' }] }] }]), null, 'Stories')
    const editor = await openStep('s1')
    const alt = editor.querySelector<HTMLInputElement>('input[aria-invalid], li input')!
    const type = async (value: string) => {
      await act(async () => {
        alt.value = value
        alt.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await type('Hedge in June')
    expect(currentDesign.value!.stories![0]!.steps[0]!.images).toEqual([{ src: 'data:image/png;base64,iVBORw==', alt: 'Hedge in June' }])
    await type('   ')
    expect(editor.textContent).toContain('Add a description to keep this image.')
    expect(currentDesign.value!.stories![0]!.steps[0]!.images![0]!.alt).toBe('Hedge in June')

    await act(async () => { button('Remove image 1', editor).click() })
    expect(currentDesign.value!.stories![0]!.steps[0]!.images).toEqual([])

    const input = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1, 2, 3])], 'a.webp', { type: 'image/webp' })], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await until(() => editor.querySelector('input[required]') !== null)
    const pendingAlt = editor.querySelector<HTMLInputElement>('input[required]')!
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { pendingAlt.dispatchEvent(escape) })
    expect(editor.querySelector('input[required]')).toBeNull()
    expect(currentDesign.value!.stories![0]!.steps[0]!.images).toEqual([])
  })

  it('makes an image over 1 MB smaller before embedding it, and says so', async () => {
    const editor = await openStep('s1')
    const input = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3000, height: 2000, close: vi.fn() })))
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', imageSmoothingQuality: 'low' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done, type) {
      done(new Blob([new Uint8Array(this.width * 100)], { type: type ?? 'image/png' }))
    })
    try {
      Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(2.5 * 1024 * 1024)], 'orchard.jpg', { type: 'image/jpeg' })], configurable: true })
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
      await until(() => editor.querySelector('input[required]') !== null)
      expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2560, 1707)
      expect(editor.textContent).toContain('Canopi made this image smaller to fit: 2.5 MB to 0.2 MB.')
      const alt = editor.querySelector<HTMLInputElement>('input[required]')!
      await act(async () => {
        alt.value = 'The orchard in May'
        alt.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { alt.form!.requestSubmit() })
      const images = currentDesign.value!.stories![0]!.steps[0]!.images!
      expect(images).toHaveLength(1)
      expect(images[0]!.alt).toBe('The orchard in May')
      expect(images[0]!.src.startsWith('data:image/webp;base64,')).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  // jsdom base64-encodes the 2.5 MB file on the main thread; slow under a loaded runner.
  }, 15_000)

  it('keeps the latest chosen image when an earlier, larger one finishes shrinking after it', async () => {
    const editor = await openStep('s1')
    const input = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    let decode!: () => void
    const decoded = new Promise<void>((resolve) => { decode = resolve })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      await decoded
      return { width: 3000, height: 2000, close: vi.fn() }
    }))
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', imageSmoothingQuality: 'low' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (done, type) {
      done(new Blob([new Uint8Array(64)], { type: type ?? 'image/png' }))
    })
    const reads = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    const choose = async (file: File) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    }
    try {
      await choose(new File([new Uint8Array(1024 * 1024 + 1)], 'orchard.jpg', { type: 'image/jpeg' }))
      expect(editor.textContent).toContain('Making this image smaller')
      await choose(new File([new Uint8Array([137, 80, 78, 71])], 'diagram.png', { type: 'image/png' }))
      await until(() => editor.querySelector('input[required]') !== null)
      const alt = editor.querySelector<HTMLInputElement>('input[required]')!
      await act(async () => {
        alt.value = 'The diagram'
        alt.dispatchEvent(new Event('input', { bubbles: true }))
      })

      decode()
      await until(() => reads.mock.calls.length === 2)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await act(async () => {})

      const preview = editor.querySelector<HTMLImageElement>('form img')!
      expect(preview.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
      expect(editor.textContent).not.toContain('Making this image smaller')
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it('embeds a chosen image once it has a description, and refuses images of another type or that cannot be made small enough', async () => {
    const editor = await openStep('s1')
    const input = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    // Reading a file is asynchronous: wait for what it shows.
    const choose = async (file: File, shows: () => boolean) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
      await until(shows)
    }
    const alertText = () => editor.querySelector('[role="alert"]')?.textContent

    await choose(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }), () => !!alertText())
    expect(alertText()).toBe('Choose a PNG, JPEG, WebP or GIF image.')

    // No decoder in this DOM: an image over 1 MB cannot be made smaller.
    await choose(new File([new Uint8Array(1024 * 1024 + 1)], 'big.png', { type: 'image/png' }), () => alertText() !== 'Choose a PNG, JPEG, WebP or GIF image.' && !!alertText())
    expect(alertText()).toBe('Canopi couldn\'t read this image. Try another file.')

    await choose(new File([new Uint8Array([137, 80, 78, 71])], 'hedge.png', { type: 'image/png' }), () => !!editor.querySelector('input[required]'))
    const keep = [...editor.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((entry) => entry.textContent === 'Add image')!
    expect(keep.disabled).toBe(true)
    const alt = editor.querySelector<HTMLInputElement>('input[required]')!
    await act(async () => {
      alt.value = 'The hedge in June'
      alt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { keep.form!.requestSubmit() })

    expect(currentDesign.value!.stories![0]!.steps[0]!.images).toEqual([
      { src: 'data:image/png;base64,iVBORw==', alt: 'The hedge in June' },
    ])
  })
})
