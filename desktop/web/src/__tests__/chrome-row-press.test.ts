// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { useRef } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useChromeRow } from '../components/shared/useMapChrome'

// A notice row below the title bar lowers `--chrome-rail-top`, which the rails, dock and start screen are placed from.
// No chrome row moves controls under a held primary press: a row that comes or goes mid-press waits for the press to
// end, or the press's pointerup lands on another control (phone-chrome.spec.ts:1018 in Firefox: the start screen's
// Open moved 62-84 px between pointerdown and pointerup when the New version row mounted).

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
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { render(h(Shell, null), container) })
})

afterEach(async () => {
  press('pointerup')
  await afterRelease()
  await act(async () => { render(null, container) })
  container.remove()
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

  it('a secondary pointer or button holds nothing', async () => {
    press('pointerdown', { pointerId: 2, isPrimary: false })
    press('pointerdown', { pointerId: 3, button: 2 })
    await act(async () => { shown.value = true })
    expect(railTop()).toBe('calc(0px + var(--space-2))')
    press('pointerup', { pointerId: 2, isPrimary: false })
    press('pointerup', { pointerId: 3, button: 2 })
  })
})
