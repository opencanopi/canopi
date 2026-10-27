// @vitest-environment jsdom

// Probe of F1b c3b (canopi-f47t.52.228.8): with preact/compat loaded, as the app loads it (lazy, Suspense), each core
// event name a compat alias renames to fires on the same DOM event as the alias, and on no other: onInput for an
// input's or a textarea's onChange, onFocusIn and onFocusOut for onFocus and onBlur. onDoubleClick is no core prop
// type, so typecheck already refuses it.
// Deleted with the probe's answers recorded in the commit that lands no-compat-event-alias.
import 'preact/compat'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('compat event aliases and their core names under preact/compat', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('an input of type color, text or none hears onChange and onInput on input, neither on change', async () => {
    const alias = vi.fn()
    const core = vi.fn()
    await act(() => render(
      <div>
        <input data-k="alias" aria-label="color alias" type="color" onChange={alias} />
        <input data-k="core" aria-label="color core" type="color" onInput={core} />
        <input data-k="alias" aria-label="text alias" type="text" onChange={alias} />
        <input data-k="core" aria-label="text core" type="text" onInput={core} />
        <input data-k="alias" aria-label="untyped alias" onChange={alias} />
        <input data-k="core" aria-label="untyped core" onInput={core} />
      </div>,
      container,
    ))
    for (const input of container.querySelectorAll('input')) {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const types = (fn: typeof alias) => fn.mock.calls.map(([event]) => (event as Event).type)
    expect([types(alias), types(core)]).toEqual([['input', 'input', 'input'], ['input', 'input', 'input']])
  })

  it('a textarea hears onChange and onInput on input', async () => {
    const alias = vi.fn()
    const core = vi.fn()
    await act(() => render(<div><textarea data-k="alias" aria-label="alias" onChange={alias} /><textarea data-k="core" aria-label="core" onInput={core} /></div>, container))
    for (const k of ['alias', 'core']) {
      const area = container.querySelector<HTMLTextAreaElement>(`[data-k="${k}"]`)!
      area.dispatchEvent(new Event('change', { bubbles: true }))
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }
    expect([alias.mock.calls.length, core.mock.calls.length]).toEqual([1, 1])
  })

  it('onFocus and onFocusIn, onBlur and onFocusOut hear the bubbling focusin and focusout of a child', async () => {
    const calls: string[] = []
    const log = (name: string) => (event: FocusEvent) => calls.push(`${name} ${event.type}`)
    await act(() => render(
      <div>
        <div data-k="alias" onFocus={log('onFocus')} onBlur={log('onBlur')}><button type="button">a</button></div>
        <div data-k="core" onFocusIn={log('onFocusIn')} onFocusOut={log('onFocusOut')}><button type="button">c</button></div>
      </div>,
      container,
    ))
    for (const k of ['alias', 'core']) {
      const child = container.querySelector(`[data-k="${k}"] button`)!
      child.dispatchEvent(new FocusEvent('focus', { bubbles: false }))
      child.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      child.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
      child.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    }
    expect(calls).toEqual(['onFocus focusin', 'onBlur focusout', 'onFocusIn focusin', 'onFocusOut focusout'])
  })
})
