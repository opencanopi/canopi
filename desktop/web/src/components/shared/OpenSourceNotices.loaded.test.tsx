// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { locale } from '../../app/settings/state'
import { OpenSourceNotices } from './OpenSourceNotices'

// The notices file both editions bundle (2.1-Q221), as the page's lazy chunk hands it over.
const NOTICES = '# Third-party notices\n\nmaplibre-gl BSD-3-Clause\n'
vi.mock('../../../../../THIRD_PARTY_NOTICES.md?raw', () => ({ default: NOTICES }))
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => tauri)

let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  locale.value = 'en'
})
afterEach(() => {
  render(null, container)
  container.remove()
  vi.restoreAllMocks()
})

// One code path on Desktop and Web (2.1-Q221): the page bundle's lazy chunk, never a request, a command or a window.
it('shows the bundled notices from its lazy chunk, with no request, command or window', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  const open = vi.spyOn(window, 'open')
  void act(() => { render(<OpenSourceNotices onClose={() => undefined} />, container) })
  await vi.waitFor(() => expect(container.querySelector('pre')?.textContent).toBe(NOTICES))
  expect(container.querySelector('[role="region"]')?.getAttribute('aria-busy')).toBe('false')
  expect(fetch).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(tauri.invoke).not.toHaveBeenCalled()
})
