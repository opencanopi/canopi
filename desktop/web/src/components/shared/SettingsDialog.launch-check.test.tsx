// @vitest-environment jsdom

// "Check for updates at launch" under settings a newer Canopi saved (Step 2.0.4 R3, canopi-f47t.52.272; 2.1-Q164,
// Q320, M487): the refused write keeps the switch where the user put it, for the session, as the store's notice says;
// any other failed write puts it back.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locale } from '../../app/settings/state'
import { StoreRefusedError } from '../../failures/store-read'
import { createLaunchCheckPort, LaunchCheckSwitch, type LaunchCheckPort } from './SettingsDialog'

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

const refusing = (refusal: unknown) => createLaunchCheckPort(() => Promise.resolve(true), () => Promise.reject(refusal))

async function mount(port: LaunchCheckPort): Promise<HTMLInputElement> {
  await act(async () => { render(<LaunchCheckSwitch port={port} />, container) })
  await act(async () => { await Promise.resolve() })
  return container.querySelector<HTMLInputElement>('[data-launch-check] input[role="switch"]')!
}

async function toggleWith(refusal: unknown, port = refusing(refusal)): Promise<boolean> {
  const toggle = await mount(port)
  await act(async () => {
    toggle.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return toggle.checked
}

describe('Check for updates at launch', () => {
  it('R3 canopi-f47t.52.272: under settings a newer Canopi saved, the switch keeps its new state for the session (2.1-Q320)', async () => {
    expect(await toggleWith(new StoreRefusedError('settings'))).toBe(false)
  })

  it('R3 canopi-f47t.52.272: the session value outlives the About tab, which reads it again when it remounts', async () => {
    const port = refusing(new StoreRefusedError('settings'))
    expect(await toggleWith(null, port)).toBe(false)
    render(null, container)
    expect((await mount(port)).checked).toBe(false)
  })

  it('a write that fails for another reason puts the switch back', async () => {
    expect(await toggleWith(new Error('disk I/O error'))).toBe(true)
  })

  // The updater lane's About Canopi… press landed on the switch when its row answered late and pushed the button down,
  // turning the launch check off: the row's place is held while it is read, so nothing below it moves.
  it('canopi-f47t.52.271: while the row is read, its place is held, so About Canopi… below it never moves', async () => {
    let answer: (on: boolean) => void = () => undefined
    const port = createLaunchCheckPort(() => new Promise<boolean>((resolve) => { answer = resolve }), () => Promise.resolve())
    await act(async () => { render(<><LaunchCheckSwitch port={port} /><button type="button">About Canopi…</button></>, container) })
    const button = container.querySelector('button')!
    const held = button.previousElementSibling
    const pending = {
      held: held !== null,
      hidden: held?.getAttribute('aria-hidden'),
      switch: container.querySelector('[data-launch-check] input[role="switch"]'),
    }
    await act(async () => { answer(true) })

    expect({ pending, sameRow: button.previousElementSibling === held, on: container.querySelector<HTMLInputElement>('[data-launch-check] input[role="switch"]')?.checked })
      .toEqual({ pending: { held: true, hidden: 'true', switch: null }, sameRow: true, on: true })
  })

  it('a row that cannot be read leaves no switch and no held place', async () => {
    await act(async () => { render(<LaunchCheckSwitch port={createLaunchCheckPort(() => Promise.reject(new Error('no row')), () => Promise.resolve())} />, container) })
    await act(async () => { await Promise.resolve() })
    expect(container.innerHTML).toBe('')
  })
})
