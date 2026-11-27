// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { RichTextEditor, insertAtCaret } from '../components/stories/RichTextEditor'
import { setShortcutPlatform } from '../app/shell-commands/shortcut-text'
import { RichTextView } from '../components/stories/RichTextView'
import {
  addCurrentViewAsStep,
  createStory,
  designEmbeddedImageBytes,
  dismissStoryUndo,
  duplicateStep,
  formatImageBytes,
  goToStepView,
  moveStepBy,
  readStoryImageFile,
  renameStory,
  type StoryImageDecoder,
  requestDeleteStep,
  requestDeleteStory,
  selectedStep,
  selectStep,
  stepsShowingView,
  storyUndo,
  undoStoryDelete,
  useCurrentViewForStep,
} from '../app/stories'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from '../app/document-session/live-core'
import { currentDesign } from '../app/document-session/store'
import type { CanopiFile, RichTextBlock, SavedView, Story } from '../types/design'
import { clearCurrentDesignState, replaceCurrentDesignState } from './support/design-session-state'
import { createTestEditionPorts } from './support/test-edition-ports'
import { hoveredTooltip } from './support/tooltip'

const span = (text: string, marks: { bold?: boolean; italic?: boolean; link?: string | null } = {}) => ({
  text, bold: marks.bold ?? false, italic: marks.italic ?? false, link: marks.link ?? null,
})
const CARET = ''

function view(id: string): SavedView {
  return {
    id, name: id,
    camera: { lon: 13, lat: 23, zoom: 18, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: { background: { kind: 'none' }, terrain: { contours: false, hillshade: false }, scene_layers: [], site_data: [] },
    highlighted: { species: [], objects: [] },
    title: null, text: [],
  }
}

const STORY: Story = {
  id: 'visit',
  name: 'Visit',
  steps: [
    { id: 'a', view_id: 'v1', title: 'A', text: [], images: [{ src: 'data:image/png;base64,AAAA', alt: 'x' }, { src: 'https://example.org/a.png', alt: 'y' }] },
    { id: 'b', view_id: 'v1', title: '', text: [], images: [] },
    { id: 'c', view_id: 'v2', title: 'C', text: [], images: [] },
  ],
}

function open(stories: Story[] = [STORY]): void {
  const file: CanopiFile = {
    version: 9, name: 'Stories', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR', views: [view('v1'), view('v2')], stories,
    created_at: '', updated_at: '', extra: {},
  }
  replaceCurrentDesignState(file, null, file.name)
}

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  open()
})

afterEach(() => {
  render(null, container)
  container.remove()
  dismissStoryUndo()
  vi.unstubAllGlobals()
})

describe('pasting into rich text at the caret', () => {
  it('joins one pasted paragraph to the line it lands in', () => {
    const blocks: RichTextBlock[] = [{ kind: 'paragraph', spans: [span(`Before ${CARET}after`)] }]
    expect(insertAtCaret(blocks, [{ kind: 'paragraph', spans: [span('pasted', { bold: true })] }])).toEqual([
      { kind: 'paragraph', spans: [span('Before '), span('pasted', { bold: true }), span(CARET), span('after')] },
    ])
  })

  it('splits the line around several pasted blocks and ends on the last one', () => {
    const blocks: RichTextBlock[] = [
      { kind: 'paragraph', spans: [span('Keep')] },
      { kind: 'paragraph', spans: [span(`One ${CARET}two`)] },
    ]
    const pasted: RichTextBlock[] = [
      { kind: 'paragraph', spans: [span('First')] },
      { kind: 'bullets', items: [{ spans: [span('x')] }, { spans: [span('y')] }] },
    ]
    expect(insertAtCaret(blocks, pasted)).toEqual([
      { kind: 'paragraph', spans: [span('Keep')] },
      { kind: 'paragraph', spans: [span('One ')] },
      { kind: 'paragraph', spans: [span('First')] },
      { kind: 'bullets', items: [{ spans: [span('x')] }, { spans: [span('y'), span(CARET)] }] },
      { kind: 'paragraph', spans: [span('two')] },
    ])
  })

  it('turns pasted lines into items inside a bullet list', () => {
    const blocks: RichTextBlock[] = [{ kind: 'bullets', items: [{ spans: [span('first')] }, { spans: [span(`sec${CARET}ond`)] }] }]
    expect(insertAtCaret(blocks, [
      { kind: 'paragraph', spans: [span('A')] },
      { kind: 'paragraph', spans: [span('B')] },
      { kind: 'paragraph', spans: [span('C')] },
    ])).toEqual([{ kind: 'bullets', items: [
      { spans: [span('first')] },
      { spans: [span('sec'), span('A')] },
      { spans: [span('B')] },
      { spans: [span('C'), span(CARET), span('ond')] },
    ] }])
    expect(insertAtCaret([{ kind: 'bullets', items: [{ spans: [span(`x${CARET}`)] }] }], [{ kind: 'paragraph', spans: [span('y')] }]))
      .toEqual([{ kind: 'bullets', items: [{ spans: [span('x'), span('y'), span(CARET)] }] }])
  })

  it('adds pasted blocks at the end when there is no caret', () => {
    const pasted: RichTextBlock[] = [{ kind: 'paragraph', spans: [span('new')] }]
    expect(insertAtCaret([{ kind: 'paragraph', spans: [span('old')] }], pasted)).toEqual([
      { kind: 'paragraph', spans: [span('old')] },
      { kind: 'paragraph', spans: [span('new')] },
    ])
  })
})

describe('the rich text editor', () => {
  async function mount(value: RichTextBlock[] = [{ kind: 'paragraph', spans: [span('Hello world')] }]) {
    const onChange = vi.fn()
    await act(async () => {
      render(<RichTextEditor value={value} onChange={onChange} label="Text" placeholder="Say something" />, container)
    })
    return { onChange, surface: container.querySelector<HTMLElement>('[data-rich-text-editor]')! }
  }

  function tool(label: string): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  }

  it('runs bold, italic and bullets through the browser’s editing commands and reads the result back', async () => {
    const execCommand = vi.fn((command: string) => {
      const paragraph = container.querySelector('[data-rich-text-editor] p')!
      if (command === 'bold') paragraph.innerHTML = '<b>Hello</b> world'
      if (command === 'italic') paragraph.innerHTML = '<b>Hello</b> <i>world</i>'
      return true
    })
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    const { onChange } = await mount()

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    tool('Bold').dispatchEvent(mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
    await act(async () => { tool('Bold').click() })
    await act(async () => { tool('Italic').click() })
    await act(async () => { tool('Bulleted list').click() })

    expect(execCommand.mock.calls.map((call) => call[0])).toEqual(['bold', 'italic', 'insertUnorderedList'])
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'paragraph', spans: [span('Hello', { bold: true }), span(' '), span('world', { italic: true })] },
    ])
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('names the platform’s mod key in the Bold and Italic tooltips: Cmd on macOS (U13)', async () => {
    setShortcutPlatform({ os: 'mac' })
    try {
      await mount()
      expect(hoveredTooltip(tool('Bold')!)!.textContent).toBe('BoldCmd B')
      expect(hoveredTooltip(tool('Italic')!)!.textContent).toBe('ItalicCmd I')
      expect(tool('Bold').getAttribute('aria-keyshortcuts')).toBe('Control+B Meta+B')
      expect(tool('Italic').getAttribute('aria-keyshortcuts')).toBe('Control+I Meta+I')
    } finally {
      setShortcutPlatform({ os: 'linux' })
    }
  })

  it('links the typed address at the caret, removes links, and cancels with Esc', async () => {
    const { onChange, surface } = await mount()
    const text = surface.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 5)
    range.collapse(true)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)

    await act(async () => { tool('Add link').click() })
    expect(tool('Add link').getAttribute('aria-pressed')).toBe('true')
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!
    await act(async () => {
      field.value = 'jp@example.org'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { field.form!.requestSubmit() })
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'paragraph', spans: [
      span('Hello'), span('jp@example.org', { link: 'mailto:jp@example.org' }), span(' world'),
    ] }])

    const link = surface.querySelector('a')!
    const linkRange = document.createRange()
    linkRange.selectNodeContents(link)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(linkRange)
    await act(async () => { tool('Add link').click() })
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Remove link')!.click()
    })
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'paragraph', spans: [span('Hellojp@example.org world')] }])

    await act(async () => { tool('Add link').click() })
    const again = container.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { again.dispatchEvent(escape) })
    expect(escape.defaultPrevented).toBe(true)
    expect(container.querySelector('input[aria-label="Link address"]')).toBeNull()
  })

  it('reads dropped text as blocks and ignores a drop without data', async () => {
    const { onChange, surface } = await mount([])
    expect(surface.getAttribute('data-empty')).toBe('true')
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: (type: string) => type === 'text/plain' ? 'One\n- two' : '' } })
    await act(async () => { surface.dispatchEvent(drop) })
    expect(drop.defaultPrevented).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'paragraph', spans: [span('One')] },
      { kind: 'bullets', items: [{ spans: [span('two')] }] },
    ])
    const empty = new Event('drop', { bubbles: true, cancelable: true })
    surface.dispatchEvent(empty)
    expect(empty.defaultPrevented).toBe(false)
  })

  function dropAt(surface: HTMLElement, node: Node, offset: number, text: string): DragEvent {
    const point = document.createRange()
    point.setStart(node, offset)
    point.collapse(true)
    Object.defineProperty(document, 'caretRangeFromPoint', { value: () => point.cloneRange(), configurable: true })
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: (type: string) => type === 'text/plain' ? text : '' } })
    surface.dispatchEvent(drop)
    return drop
  }

  function select(node: Text, start: number, end: number): void {
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
  }

  it('drops outside text at the drop point and keeps the selected text', async () => {
    const { onChange, surface } = await mount([
      { kind: 'paragraph', spans: [span('An orchard here')] },
      { kind: 'paragraph', spans: [span('Last line')] },
    ])
    const [first, second] = [...surface.querySelectorAll('p')].map((p) => p.firstChild as Text)
    select(first!, 3, 10)
    let drop!: DragEvent
    await act(async () => { drop = dropAt(surface, second!, 9, ' snippet') })
    expect(drop.defaultPrevented).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'paragraph', spans: [span('An orchard here')] },
      { kind: 'paragraph', spans: [span('Last line snippet')] },
    ])
    delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint
  })

  it('moves text dragged within the editor to the drop point', async () => {
    const { onChange, surface } = await mount([
      { kind: 'paragraph', spans: [span('An orchard here')] },
      { kind: 'paragraph', spans: [span('Last line')] },
    ])
    const [first, second] = [...surface.querySelectorAll('p')].map((p) => p.firstChild as Text)
    select(first!, 2, 10)
    surface.dispatchEvent(new Event('dragstart', { bubbles: true }))
    await act(async () => { dropAt(surface, second!, 9, ' orchard') })
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'paragraph', spans: [span('An here')] },
      { kind: 'paragraph', spans: [span('Last line orchard')] },
    ])
    delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint
  })

  it('shows new text given from outside, but not its own report back', async () => {
    const { surface } = await mount()
    await act(async () => {
      surface.querySelector('p')!.textContent = 'Typed'
      surface.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const typedNode = surface.querySelector('p')
    await act(async () => {
      render(<RichTextEditor value={[{ kind: 'paragraph', spans: [span('Typed')] }]} onChange={() => undefined} label="Text" />, container)
    })
    expect(surface.querySelector('p')).toBe(typedNode)
    await act(async () => {
      render(<RichTextEditor value={[{ kind: 'paragraph', spans: [span('From elsewhere')] }]} onChange={() => undefined} label="Text" />, container)
    })
    expect(surface.textContent).toBe('From elsewhere')
  })

  it('renders read-only text with safe links only', async () => {
    await act(async () => {
      render(<RichTextView blocks={[
        { kind: 'paragraph', spans: [span('Go', { bold: true, italic: true, link: 'https://example.org' }), span('bad', { link: 'javascript:x' })] },
        { kind: 'bullets', items: [{ spans: [span('item')] }] },
      ]} />, container)
    })
    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://example.org')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('li')?.textContent).toBe('item')
    await act(async () => { render(<RichTextView blocks={[]} />, container) })
    expect(container.innerHTML).toBe('')
  })
})

describe('story actions', () => {
  it('select, duplicate, move and delete steps within bounds', () => {
    expect(stepsShowingView('v1')).toBe(2)
    selectStep('b')
    expect(selectedStep.value?.id).toBe('b')
    selectStep(null)
    expect(selectedStep.value).toBeNull()

    duplicateStep('visit', 'a')
    expect(selectedStep.value?.title).toBe('A')
    expect(currentDesign.value!.stories![0]!.steps).toHaveLength(4)

    moveStepBy('visit', 'a', -1)
    moveStepBy('visit', 'c', 1)
    moveStepBy('visit', 'missing', 1)
    expect(currentDesign.value!.stories![0]!.steps.map((step) => step.id).at(0)).toBe('a')
    expect(currentDesign.value!.stories![0]!.steps.map((step) => step.id).at(-1)).toBe('c')

    selectStep('b')
    requestDeleteStep('visit', 'b')
    expect(selectedStep.value).toBeNull()
    expect(storyUndo.value?.message).toBe('Deleted step “Untitled step”')
    undoStoryDelete()
    expect(currentDesign.value!.stories![0]!.steps.some((step) => step.id === 'b')).toBe(true)
    requestDeleteStep('visit', 'missing')
    expect(storyUndo.value).toBeNull()
  })

  it('says the images do not fit instead of duplicating a step past the Design limit', () => {
    const photo = { src: `data:image/png;base64,${'A'.repeat(1398100)}`, alt: 'photo' }
    open([{ id: 'visit', name: 'Visit', steps: [{ id: 'a', view_id: 'v1', title: 'A', text: [], images: Array(6).fill(photo) }] }])

    duplicateStep('visit', 'a')

    expect(currentDesign.value!.stories![0]!.steps).toHaveLength(1)
    expect(storyUndo.value).toEqual({ message: 'These images do not fit: a Design holds at most 10 MB of images. Remove an image, then try again.', undo: null })
    undoStoryDelete()
    expect(currentDesign.value!.stories![0]!.steps).toHaveLength(1)
  })

  it('does nothing for unknown stories or steps, or without a map', () => {
    expect(addCurrentViewAsStep('missing')).toBeNull()
    expect(addCurrentViewAsStep('visit')).toBeNull()
    expect(useCurrentViewForStep('visit', 'missing')).toBe(false)
    expect(useCurrentViewForStep('visit', 'a')).toBe(false)
    expect(goToStepView('visit', 'missing')).toBe(false)
    renameStory('visit', 'Tour')
    expect(currentDesign.value!.stories![0]!.name).toBe('Tour')
    clearCurrentDesignState()
    expect(createStory()).toBeNull()
  })

  it('routes story and step delete Undo through unified SessionCore history when a live core is installed', async () => {
    const ports = createTestEditionPorts()
    const core = createSessionCore({
      designHome: {
        read: async () => ({ kind: 'absent' }),
        write: async () => ({ kind: 'written', version: 'v1' }),
        listDrafts: async () => [],
        deleteDraft: async () => ({ ok: true }),
        onVersionChange: () => () => {},
      },
      fileAccess: ports.fileAccess,
      lifecycle: ports.appLifecycle,
      codec: createJsonSessionCodec({ designCore: ports.designCore }),
      settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
      newDesignFactory: () => ({
        version: 10, name: 'Stories', description: null, plant_species_colors: {},
        layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
        timeline: [], budget: [], budget_currency: 'EUR', views: [view('v1'), view('v2')], stories: [STORY],
        created_at: '', updated_at: '', extra: {},
      }),
    })
    const dispose = installLiveSessionCore(core)
    try {
      await core.createNew()

      requestDeleteStep('visit', 'b')
      expect(core.currentDesign.value?.document.stories?.[0]?.steps.map((s) => s.id)).toEqual(['a', 'c'])
      expect(core.newestUndoable.value?.isDelete).toBe(true)
      undoStoryDelete()
      expect(core.currentDesign.value?.document.stories?.[0]?.steps.map((s) => s.id)).toEqual(['a', 'b', 'c'])
      expect(core.canUndo.value).toBe(false)

      requestDeleteStory('visit')
      expect(core.currentDesign.value?.document.stories).toEqual([])
      expect(core.newestUndoable.value?.isDelete).toBe(true)
      undoStoryDelete()
      expect(core.currentDesign.value?.document.stories?.map((s) => s.id)).toEqual(['visit'])
      expect(core.canUndo.value).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe('story images', () => {
  it('counts only embedded bytes and formats sizes for people', () => {
    expect(designEmbeddedImageBytes(currentDesign.value)).toBe(3)
    expect(designEmbeddedImageBytes(null)).toBe(0)
    expect(formatImageBytes(1.5 * 1024 * 1024, 'en')).toBe('1.6 MB')
    expect(formatImageBytes(100, 'fr')).toBe('0,1\u202fko')
  })

  it('refuses an image that would take the Design over 10 MB', async () => {
    const full: Story = {
      ...STORY,
      steps: STORY.steps.map((step, index) => ({
        ...step,
        images: index === 0 ? Array.from({ length: 10 }, () => ({ src: `data:image/png;base64,${'A'.repeat(1_398_100)}`, alt: 'x' })) : [],
      })),
    }
    const read = await readStoryImageFile(new File([new Uint8Array(1024)], 'a.png', { type: 'image/png' }), { stories: [full] })
    expect(read).toEqual({ ok: false, problem: 'designFull', bytes: 1024 })
  })

  describe('an image over 1 MB', () => {
    const MIB = 1024 * 1024
    const big = () => new File([new Uint8Array(3 * MIB)], 'orchard.jpg', { type: 'image/jpeg' })

    /** A decoded 4000 × 3000 photo whose encoded size follows its pixels and quality. */
    function photo(options: { webp?: boolean; bytesPerPixel?: number } = {}) {
      const calls: { width: number; height: number; type: string; quality: number }[] = []
      const close = vi.fn()
      const decoder: StoryImageDecoder = {
        decode: async () => ({
          width: 4000,
          height: 3000,
          close,
          encode: async (width, height, type, quality) => {
            calls.push({ width, height, type, quality })
            const encoded = options.webp === false && type === 'image/webp' ? 'image/png' : type
            const size = Math.round(width * height * quality * (options.bytesPerPixel ?? 0.5))
            // Only a blob that fits is ever read; a larger one needs no bytes behind it.
            return size <= MIB ? new Blob([new Uint8Array(size)], { type: encoded }) : { size, type: encoded } as Blob
          },
        }),
      }
      return { decoder, calls, close }
    }

    it('makes it smaller in the browser, as WebP, until it fits 1 MB', async () => {
      const { decoder, calls, close } = photo()
      const read = await readStoryImageFile(big(), null, decoder)
      expect(read.ok).toBe(true)
      if (!read.ok) return
      expect(read.src.startsWith('data:image/webp;base64,')).toBe(true)
      expect(read.bytes).toBeLessThanOrEqual(MIB)
      expect(read.resizedFrom).toBe(3 * MIB)
      expect(designEmbeddedImageBytes({ stories: [{ id: 's', name: 's', steps: [{ id: 'a', view_id: 'v', title: '', images: [{ src: read.src, alt: 'x' }] }] }] })).toBe(read.bytes)
      // At most 2560 px on the long side, then lower quality before a smaller size.
      expect(calls[0]).toMatchObject({ width: 2560, height: 1920, type: 'image/webp' })
      expect(calls[1]!.width).toBe(2560)
      expect(calls[1]!.quality).toBeLessThan(calls[0]!.quality)
      expect(calls.at(-1)!.width).toBeLessThan(2560)
      expect(close).toHaveBeenCalledTimes(1)
    })

    it('uses JPEG where the browser cannot write WebP', async () => {
      const { decoder, calls } = photo({ webp: false })
      const read = await readStoryImageFile(big(), null, decoder)
      expect(read.ok && read.src.startsWith('data:image/jpeg;base64,')).toBe(true)
      expect(calls.filter((call) => call.type === 'image/webp')).toHaveLength(1)
    })

    it('refuses it when even the smallest size stays over 1 MB, and when it cannot be decoded', async () => {
      const { decoder, close } = photo({ bytesPerPixel: 100 })
      expect(await readStoryImageFile(big(), null, decoder)).toEqual({ ok: false, problem: 'tooLarge', bytes: 3 * MIB })
      expect(close).toHaveBeenCalledTimes(1)
      expect(await readStoryImageFile(big(), null, { decode: async () => null })).toEqual({ ok: false, problem: 'unreadable', bytes: 3 * MIB })
    })

    it('still keeps the Design within 10 MB of images', async () => {
      const nearlyFull: Story = {
        ...STORY,
        steps: STORY.steps.map((step, index) => ({
          ...step,
          images: index === 0 ? Array.from({ length: 10 }, () => ({ src: `data:image/png;base64,${'A'.repeat(1_390_000)}`, alt: 'x' })) : [],
        })),
      }
      const read = await readStoryImageFile(big(), { stories: [nearlyFull] }, photo().decoder)
      expect(read).toMatchObject({ ok: false, problem: 'designFull' })
    })
  })

  it('refuses a file it cannot read', async () => {
    class FailingReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      error = new Error('unreadable')
      result: string | null = null
      readAsDataURL() { queueMicrotask(() => this.onerror?.()) }
    }
    vi.stubGlobal('FileReader', FailingReader)
    const read = await readStoryImageFile(new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }), null)
    expect(read).toEqual({ ok: false, problem: 'unreadable', bytes: 4 })
  })
})
