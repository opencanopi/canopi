// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createTestView, type TestView } from '../../../__tests__/support/test-view'
import { CANVAS_CHROME_FONT_FAMILY } from '../../chrome-fonts'
import type { CanvasFocusPort } from '../app-adapter'
import type { TextEntryRequest } from '../tools/tool'
import { createTextEntryHost, type TextEntryHost } from './text-entry-host'
import { expectScreenPx } from '../../../__tests__/support/camera-tolerance'

const NOTE: TextEntryRequest = {
  anchor: { x: 10, y: 20 },
  rotationDeg: 30,
  initialText: 'Pond edge\nwet',
  placeholderKey: 'canvas.textNote.placeholder',
  fontSizePx: 20,
}
const NEW_NOTE: TextEntryRequest = {
  anchor: { x: 30, y: 40 },
  rotationDeg: 0,
  initialText: '',
  placeholderKey: 'canvas.textNote.placeholder',
}

let container: HTMLDivElement
let view: TestView
let focusMap: Mock<CanvasFocusPort['focusMap']>
let host: TextEntryHost | null = null

function mount(fromTouch = false): TextEntryHost {
  container = document.createElement('div')
  document.body.appendChild(container)
  view = createTestView({ viewport: { x: 5, y: 7, scale: 2 } })
  focusMap = vi.fn<CanvasFocusPort['focusMap']>(() => container.focus())
  container.tabIndex = 0
  host = createTextEntryHost({
    container,
    frames: view.frames,
    translate: (key) => `t:${key}`,
    focus: { focusMap },
    openedByTouch: () => fromTouch,
  })
  return host
}

function entry(): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>('textarea')
}

function key(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

afterEach(() => {
  host?.dispose()
  host = null
  view?.dispose()
  container?.remove()
})

describe('the text-entry host', () => {
  it('a new note\'s field draws at the note\'s font size and line height, where the note will draw, focused on the next frame', async () => {
    const entries = mount()

    entries.open(NEW_NOTE, () => 'close')

    const textarea = entry()!
    expect(entries.isOpen()).toBe(true)
    expect(textarea.hasAttribute('data-canvas-text-entry')).toBe(true)
    expect(textarea.placeholder).toBe('t:canvas.textNote.placeholder')
    expect(textarea.getAttribute('aria-label')).toBe('t:canvas.tools.text')
    const at = view.view().worldToScreen(NEW_NOTE.anchor)
    expectScreenPx(textarea.style.left, at.x)
    expectScreenPx(textarea.style.top, at.y)
    // A new note's default 16 px, at 1.25 em, as the note is drawn: one empty line, at the 120 px minimum until the text
    // grows past it.
    expect(textarea.style.fontSize).toBe('16px')
    expect(textarea.style.lineHeight).toBe('1.25')
    expect(textarea.style.width).toBe('120px')
    expect(textarea.style.minHeight).toBe('24px')
    expect(textarea.style.transform).toBe('')
    expect(textarea.style.fontFamily.replace(/"/g, "'")).toBe(CANVAS_CHROME_FONT_FAMILY)
    expect(document.activeElement).not.toBe(textarea)

    await nextAnimationFrame()
    expect(document.activeElement).toBe(textarea)
  })

  it('an entry opened from a touch takes focus at once, inside the tap\'s user activation, so iOS shows its keyboard (A15)', () => {
    const entries = mount(true)

    entries.open(NEW_NOTE, () => 'close')

    expect(document.activeElement).toBe(entry())
    expect(entry()!.selectionStart).toBe(0)
  })

  it('the entry keeps the native callout the map host turns off, so a long press selects its text (A13)', () => {
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    const entries = mount()

    entries.open(NEW_NOTE, () => 'close')

    expect(setProperty.mock.contexts.some((style, index) => style === entry()!.style
      && setProperty.mock.calls[index]![0] === '-webkit-touch-callout' && setProperty.mock.calls[index]![1] === 'default')).toBe(true)
    setProperty.mockRestore()
  })

  it('a new note\'s field widens to its measured text as the user types, never narrower than 120 px', () => {
    const entries = mount()
    entries.open(NEW_NOTE, () => 'close')
    const textarea = entry()!
    // The browser's measure of the typed text: 1 px borders outside the content box (the field is border-box), and the
    // content's scroll width with its 8 px of padding, never less than the box itself.
    let textPx = 0
    Object.defineProperty(textarea, 'offsetWidth', { get: () => parseFloat(textarea.style.width) })
    Object.defineProperty(textarea, 'clientWidth', { get: () => textarea.offsetWidth - 2 })
    Object.defineProperty(textarea, 'scrollWidth', { get: () => Math.max(textPx + 8, textarea.clientWidth) })

    // Eleven full-width glyphs at 1 em of 16 px: far wider than 0.6 em a character, and all of it stays in view.
    textarea.value = '池の縁に植える低木です'
    textPx = 176
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.width).toBe(`${176 + 8 + 2}px`)

    textarea.value = 'Bed'
    textPx = 27
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.width).toBe('120px')
  })

  it('an empty or one-line note field is one line tall', () => {
    const entries = mount()
    entries.open(NEW_NOTE, () => 'close')
    const textarea = entry()!
    // The browser's measure at 16 px and 1.25 em: an auto-height field holds at least its rows, each a 20 px line, with
    // 4 px of padding; 1 px borders sit outside the content box (the field is border-box).
    const lines = () => Math.max(textarea.rows, textarea.value.split('\n').length)
    Object.defineProperty(textarea, 'scrollHeight', { get: () => lines() * 20 + 4 })
    Object.defineProperty(textarea, 'offsetHeight', { get: () => parseFloat(textarea.style.height) || lines() * 20 + 6 })
    Object.defineProperty(textarea, 'clientHeight', { get: () => textarea.offsetHeight - 2 })

    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.height).toBe(`${20 + 4 + 2}px`)

    textarea.value = 'Bed'
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.height).toBe(`${20 + 4 + 2}px`)

    textarea.value = 'Pond edge\nwet'
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.height).toBe(`${2 * 20 + 4 + 2}px`)
  })

  it('a long placeholder widens the empty field, measured as its text would be without writing the field, never narrower than 120 px', () => {
    const entries = mount()
    entries.open(NEW_NOTE, () => 'close')
    const textarea = entry()!
    // The browser's measure: 10 px a character, 8 px of padding, 1 px borders outside; the placeholder is measured in a
    // hidden mirror of the field's font and padding.
    Object.defineProperty(textarea, 'offsetWidth', { get: () => parseFloat(textarea.style.width) })
    Object.defineProperty(textarea, 'clientWidth', { get: () => textarea.offsetWidth - 2 })
    Object.defineProperty(textarea, 'scrollWidth', {
      get: () => Math.max(textarea.value.length * 10 + 8, textarea.clientWidth),
    })
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return (this.textContent ?? '').length * 10 + 8
    })
    // Writing the field's value would reset its native undo history: the measure never does.
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const writes: string[] = []
    Object.defineProperty(textarea, 'value', {
      get: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.get,
      set(next: string) {
        writes.push(next)
        valueSetter.call(this, next)
      },
    })
    // A placeholder as long as Russian's 'Введите заметку' at a wide glyph measure: wider than 120 px.
    textarea.placeholder = 'Введите заметку'

    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.width).toBe(`${15 * 10 + 8 + 2}px`)
    expect(writes).toEqual([])

    textarea.value = 'Bed'
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.width).toBe('120px')

    textarea.value = ''
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.width).toBe(`${15 * 10 + 8 + 2}px`)

    textarea.placeholder = 'Note'
    textarea.dispatchEvent(new Event('input'))
    expect(textarea.style.width).toBe('120px')
    expect(writes).toEqual(['Bed', ''])
    expect(document.querySelectorAll('body > span')).toHaveLength(0)
    offsetWidth.mockRestore()
  })

  it('opens a note\'s in-place editor at the note, sized by its text, turned by its rotation, all selected', async () => {
    const entries = mount()
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select')

    entries.open(NOTE, () => 'close')

    const textarea = entry()!
    expect(textarea.value).toBe('Pond edge\nwet')
    expect(textarea.dataset.preserveOverlays).toBe('true')
    expect(textarea.hasAttribute('data-canvas-text-entry')).toBe(true)
    const at = view.view().worldToScreen(NOTE.anchor)
    expectScreenPx(textarea.style.left, at.x)
    expectScreenPx(textarea.style.top, at.y)
    expect(textarea.style.fontSize).toBe('20px')
    expect(textarea.style.lineHeight).toBe('1.25')
    // The width is the browser's measure, at least 120 px.
    expect(textarea.style.width).toBe('120px')
    expect(textarea.style.transform).toBe('rotate(30deg)')
    expect(textarea.style.transformOrigin).toBe('top left')

    await nextAnimationFrame()
    expect(document.activeElement).toBe(textarea)
    expect(select).toHaveBeenCalled()
    select.mockRestore()
  })

  it('follows the camera frame', () => {
    const entries = mount()
    entries.open(NEW_NOTE, () => 'close')

    view.setViewport({ x: 100, y: 50, scale: 1 })

    const at = view.view().worldToScreen(NEW_NOTE.anchor)
    expectScreenPx(entry()!.style.left, at.x)
    expectScreenPx(entry()!.style.top, at.y)
  })

  it('Enter submits the text: a closed entry returns focus to the map, a kept one stays the same field', async () => {
    const entries = mount()
    const submit = vi.fn<(text: string) => 'close' | 'keep'>(() => 'keep')
    entries.open(NEW_NOTE, submit)
    const textarea = entry()!
    await nextAnimationFrame()
    textarea.value = 'Willow'

    const shiftEnter = key(textarea, { key: 'Enter', shiftKey: true })
    expect(shiftEnter.defaultPrevented).toBe(false)
    expect(submit).not.toHaveBeenCalled()

    const refused = key(textarea, { key: 'Enter' })
    expect(refused.defaultPrevented).toBe(true)
    expect(submit).toHaveBeenLastCalledWith('Willow')
    expect(entry()).toBe(textarea)
    expect(entries.isOpen()).toBe(true)

    submit.mockReturnValue('close')
    key(textarea, { key: 'Enter' })
    expect(entry()).toBeNull()
    expect(entries.isOpen()).toBe(false)
    expect(focusMap).toHaveBeenCalledWith()
  })

  it('a blur submits at once, so a press on the map finds the entry already committed', async () => {
    const entries = mount()
    const submit = vi.fn<(text: string) => 'close' | 'keep'>(() => 'keep')
    entries.open(NEW_NOTE, submit)
    const textarea = entry()!
    await nextAnimationFrame()
    textarea.value = 'Hazel'

    container.focus()
    expect(submit).toHaveBeenCalledWith('Hazel')
    expect(entries.isOpen()).toBe(true)

    textarea.focus()
    submit.mockReturnValue('close')
    container.focus()
    expect(entries.isOpen()).toBe(false)
    expect(entry()).toBeNull()
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('submitUnfocused submits an entry whose blur commit was refused; one that holds focus is left to its blur', async () => {
    const entries = mount()
    const submit = vi.fn<(text: string) => 'close' | 'keep'>(() => 'keep')
    entries.open(NEW_NOTE, submit)
    const textarea = entry()!
    await nextAnimationFrame()
    textarea.value = 'Rowan'

    entries.submitUnfocused()
    expect(submit).not.toHaveBeenCalled()

    // Focus leaves for somewhere off the map while the commit is refused: the entry stays, without focus, and the map
    // taking focus later cannot blur it again.
    textarea.blur()
    expect(submit).toHaveBeenCalledTimes(1)
    container.focus()
    expect(submit).toHaveBeenCalledTimes(1)

    submit.mockReturnValue('close')
    entries.submitUnfocused()
    expect(submit).toHaveBeenLastCalledWith('Rowan')
    expect(entries.isOpen()).toBe(false)
    expect(entry()).toBeNull()
    // The entry did not hold focus: closing it moves none.
    expect(focusMap).not.toHaveBeenCalled()
    entries.submitUnfocused()
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('Esc is the entry\'s own: it closes without submitting and never reaches the map', async () => {
    const entries = mount()
    const submit = vi.fn(() => 'close' as const)
    const mapKeys = vi.fn()
    container.addEventListener('keydown', mapKeys)
    entries.open(NOTE, submit)
    const textarea = entry()!
    await nextAnimationFrame()

    const escape = key(textarea, { key: 'Escape' })

    expect(escape.defaultPrevented).toBe(true)
    expect(mapKeys).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(entries.isOpen()).toBe(false)
    expect(focusMap).toHaveBeenCalledWith()
  })

  it('Enter and Esc while composing do nothing', async () => {
    const entries = mount()
    const submit = vi.fn(() => 'close' as const)
    const onCancel = vi.fn()
    entries.open(NEW_NOTE, submit, onCancel)
    const textarea = entry()!
    await nextAnimationFrame()

    // Chromium and Firefox mark keys inside a composition isComposing; WebKit
    // sends the Enter that ends one with keyCode 229 (fixture H11). Either way
    // the key belongs to the IME, so the entry neither commits nor cancels and
    // leaves its default to the IME.
    const pressed = [
      key(textarea, { key: 'Enter', isComposing: true }),
      key(textarea, { key: 'Escape', isComposing: true }),
      key(textarea, { key: 'Enter', keyCode: 229 }),
      key(textarea, { key: 'Escape', keyCode: 229 }),
    ]

    expect(pressed.map((event) => event.defaultPrevented)).toEqual([false, false, false, false])
    expect(submit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(entries.isOpen()).toBe(true)
    expect(entry()).toBe(textarea)

    key(textarea, { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('Enter and Esc while composing stay in the entry: no document listener acts on the IME\'s key', async () => {
    const entries = mount()
    entries.open(NEW_NOTE, vi.fn(() => 'close' as const))
    const textarea = entry()!
    await nextAnimationFrame()
    // Document-level Esc listeners (the inspection readout, open menus) check
    // only key and defaultPrevented, so a composing key that bubbles out would
    // end inspection or close a menu while the user is still typing.
    const documentKeys = vi.fn()
    document.addEventListener('keydown', documentKeys)
    try {
      const pressed = [
        key(textarea, { key: 'Escape', isComposing: true }),
        key(textarea, { key: 'Escape', keyCode: 229 }),
        key(textarea, { key: 'Enter', isComposing: true }),
        key(textarea, { key: 'Enter', keyCode: 229 }),
      ]

      expect(documentKeys).not.toHaveBeenCalled()
      expect(pressed.map((event) => event.defaultPrevented)).toEqual([false, false, false, false])
      expect(entries.isOpen()).toBe(true)
    } finally {
      document.removeEventListener('keydown', documentKeys)
    }
  })

  it('Esc tells the opener through onCancel, once the entry is gone; a submit, close() or dispose does not', async () => {
    const entries = mount()
    const cancelled: boolean[] = []
    const onCancel = vi.fn(() => {
      cancelled.push(entries.isOpen())
    })
    entries.open(NEW_NOTE, () => 'close', onCancel)
    await nextAnimationFrame()

    key(entry()!, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(cancelled).toEqual([false])

    entries.open(NEW_NOTE, () => 'close', onCancel)
    await nextAnimationFrame()
    key(entry()!, { key: 'Enter' })
    entries.open(NEW_NOTE, () => 'close', onCancel)
    entries.close()
    entries.open(NEW_NOTE, () => 'close', onCancel)
    entries.dispose()
    host = null
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('close() discards the entry without submitting, and moves focus only when the entry held it', () => {
    const entries = mount()
    const submit = vi.fn(() => 'close' as const)
    entries.open(NEW_NOTE, submit)

    entries.close()

    expect(submit).not.toHaveBeenCalled()
    expect(entry()).toBeNull()
    expect(focusMap).not.toHaveBeenCalled()
  })

  it('a new request submits the open entry first, and a refused one keeps it open', async () => {
    const entries = mount()
    const first = vi.fn<(text: string) => 'close' | 'keep'>(() => 'keep')
    const second = vi.fn<(text: string) => 'close' | 'keep'>(() => 'close')
    entries.open(NOTE, first)
    const kept = entry()!

    entries.open(NEW_NOTE, second)
    expect(first).toHaveBeenCalledWith('Pond edge\nwet')
    expect(entry()).toBe(kept)

    first.mockReturnValue('close')
    entries.open(NEW_NOTE, second)
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
    expect(entry()).not.toBe(kept)
    expect(entry()!.value).toBe('')
  })

  it('the same note asked again keeps its field and selects its text', async () => {
    const entries = mount()
    const submit = vi.fn(() => 'close' as const)
    entries.open(NOTE, submit)
    const textarea = entry()!
    const select = vi.spyOn(textarea, 'select')

    entries.open({ ...NOTE }, submit)

    expect(submit).not.toHaveBeenCalled()
    expect(entry()).toBe(textarea)
    expect(document.activeElement).toBe(textarea)
    expect(select).toHaveBeenCalled()
  })

  it('dispose discards the entry and stops following the camera', () => {
    const entries = mount()
    const submit = vi.fn(() => 'close' as const)
    entries.open(NEW_NOTE, submit)
    const textarea = entry()!

    const beforeLeft = view.view().worldToScreen(NEW_NOTE.anchor).x
    entries.dispose()
    host = null
    view.setViewport({ x: 100, y: 50, scale: 1 })

    expect(submit).not.toHaveBeenCalled()
    expect(textarea.isConnected).toBe(false)
    expectScreenPx(textarea.style.left, beforeLeft)
  })
})
