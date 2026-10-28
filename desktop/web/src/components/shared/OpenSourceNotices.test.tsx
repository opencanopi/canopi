// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { locale } from '../../app/settings/state'
import { OpenSourceNotices } from './OpenSourceNotices'

// A Web tab whose release moved on can no longer load the notices chunk (the release watch offers the reload).
vi.mock('../../../../../THIRD_PARTY_NOTICES.md?raw', () => { throw new Error('chunk gone') })

let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  locale.value = 'en'
})
afterEach(() => {
  render(null, container)
  container.remove()
})

it('says the notices could not load, keeping focus where the view put it', async () => {
  const onClose = vi.fn()
  act(() => { render(<OpenSourceNotices onClose={onClose} />, container) })
  const focused = document.activeElement
  expect(focused?.getAttribute('role')).toBe('region')
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('The notices couldn’t load.'))
  expect(document.activeElement).toBe(focused)
  expect(focused?.getAttribute('aria-busy')).toBe('false')
})

// One code path on Desktop and Web (2.1-Q221): the page bundle's lazy chunk, never a request, a command or a window.
it('reads the notices only from its lazy chunk', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/shared/OpenSourceNotices.tsx'), 'utf8')
  expect(source).toContain("import('../../../../../THIRD_PARTY_NOTICES.md?raw')")
  expect(source).not.toMatch(/\bfetch\(|#platform|@tauri-apps|window\.open|invoke\(/)
})
