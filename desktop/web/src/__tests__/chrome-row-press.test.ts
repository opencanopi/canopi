// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { useRef } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installKeyRouter, type KeyRouterHandle } from '../app/keyboard/key-router'
import { useChromeRow } from '../components/shared/useMapChrome'

// A notice row below the title bar lowers `--chrome-rail-top`, which the rails, dock and start screen are placed from.
// No chrome row moves controls under a held primary press: a row that comes or goes mid-press waits for the press to
// end, or the press's pointerup lands on another control (phone-chrome.spec.ts:1018 in Firefox: the start screen's
// Open moved 62-84 px between pointerdown and pointerup when the New version row mounted). The held press is the key
// router's document press record (policy P6), so the real router is installed.

const shown = signal(false)

function Row() {
  const ref = useRef<HTMLDivElement>(null)
  useChromeRow(ref)
  return h('div', { ref, 'data-row': '' }, 'New version')
}

function Shell() {
  return h('div', { 'data-host': '' }, shown.value ? h(Row, null) : null, h('button', { type: 'button' }, 'Open'))
}

let container: HTMLDivElement
let router: KeyRouterHandle

function host(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-host]')!
}

function railTop(): string {
  return host().style.getPropertyValue('--chrome-rail-top')
}

function press(type: 'pointerdown' | 'pointerup' | 'pointercancel', init: PointerEventInit = {}): void {
  container.querySelector('button')!.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, ...init }))
}

/** The release's deferred work runs after the press's own click, in a later task. */
async function afterRelease(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  shown.value = false
  router = installKeyRouter({
    target: window,
    keymap: [],
    commands: { run: () => false },
    canvas: () => null,
    singleKeys: signal(true),
    focus: { cycleRegion: () => false },
    isModalOpen: () => false,
    platform: { os: 'linux', gestureEvents: false },
    document,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { render(h(Shell, null), container) })
})

afterEach(async () => {
  press('pointerup')
  await afterRelease()
  await act(async () => { render(null, container) })
  container.remove()
  router.dispose()
})

describe('a chrome row and a held press', () => {
  it('a row that mounts with no press held lowers the rail line at once', async () => {
    await act(async () => { shown.value = true })
    expect(railTop()).toBe('calc(0px + var(--space-2))')
  })

  it('a row that mounts during a held primary press moves nothing until pointerup', async () => {
    press('pointerdown')
    await act(async () => { shown.value = true })
    expect(railTop(), 'the controls under the press stay put').toBe('')
    press('pointerup')
    await afterRelease()
    expect(railTop()).toBe('calc(0px + var(--space-2))')
  })

  it('a cancelled press releases the row too', async () => {
    press('pointerdown')
    await act(async () => { shown.value = true })
    expect(railTop()).toBe('')
    press('pointercancel')
    await afterRelease()
    expect(railTop()).toBe('calc(0px + var(--space-2))')
  })

  it('a row that leaves during a held press keeps its room until pointerup', async () => {
    await act(async () => { shown.value = true })
    press('pointerdown')
    await act(async () => { shown.value = false })
    expect(railTop(), 'the controls under the press stay put').toBe('calc(0px + var(--space-2))')
    press('pointerup')
    await afterRelease()
    expect(railTop()).toBe('')
  })

  it('a row that comes and goes within one press leaves the rail line as it was', async () => {
    press('pointerdown')
    await act(async () => { shown.value = true })
    await act(async () => { shown.value = false })
    press('pointerup')
    await afterRelease()
    expect(railTop()).toBe('')
  })

  it('a press whose end the page cannot see releases the row when the window or the page is left', async () => {
    press('pointerdown')
    await act(async () => { shown.value = true })
    window.dispatchEvent(new Event('blur'))
    await afterRelease()
    expect(railTop(), 'after a window blur').toBe('calc(0px + var(--space-2))')

    press('pointerdown')
    await act(async () => { shown.value = false })
    document.dispatchEvent(new Event('visibilitychange'))
    await afterRelease()
    expect(railTop(), 'after the page hides').toBe('')
  })

  it('a press held when the key router goes moves the row at once', async () => {
    press('pointerdown')
    await act(async () => { shown.value = true })
    router.dispose()
    await afterRelease()
    expect(railTop()).toBe('calc(0px + var(--space-2))')
  })

  it('a secondary pointer or button holds nothing', async () => {
    press('pointerdown', { pointerId: 2, isPrimary: false })
    press('pointerdown', { pointerId: 3, button: 2 })
    await act(async () => { shown.value = true })
    expect(railTop()).toBe('calc(0px + var(--space-2))')
    press('pointerup', { pointerId: 2, isPrimary: false })
    press('pointerup', { pointerId: 3, button: 2 })
  })
})
