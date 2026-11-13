// @vitest-environment jsdom

// "Check for updates at launch" under settings a newer Canopi saved (Step 2.0.4 R3, canopi-f47t.52.272; 2.1-Q164,
// Q320, M487): the refused write keeps the switch where the user put it, for the session, as the store's notice says;
// any other failed write puts it back.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locale } from '../../app/settings/state'
import { StoreRefusedError } from '../../failures/store-read'
import { LaunchCheckSwitch } from './SettingsDialog'

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

async function toggleWith(refusal: unknown): Promise<boolean> {
  const port = { get: () => Promise.resolve(true), set: () => Promise.reject(refusal) }
  await act(async () => { render(<LaunchCheckSwitch port={port} />, container) })
  await act(async () => { await Promise.resolve() })
  const toggle = container.querySelector<HTMLInputElement>('[data-launch-check] input[role="switch"]')!
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

  it('a write that fails for another reason puts the switch back', async () => {
    expect(await toggleWith(new Error('disk I/O error'))).toBe(true)
  })
})
