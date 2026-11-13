// @vitest-environment jsdom

// The Web start screen's old-key Draft rows while 2.1's Draft listing cannot be read (Step 2.0.4 R3,
// canopi-f47t.52.272; 2.1-Q334, design check A18): each row still opens (read-only) and downloads, but offers no Delete
// until one listing completes.
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesignSessionStore } from '../app/document-session/store'
import { locale } from '../app/settings/state'
import type { CanopiFile } from '../types/design'
import { createBrowserAppDataStore } from './browser-app-data'
import { createBrowserDesignSessionController } from './browser-design-session'
import { WebWelcomeScreen } from './WebWelcomeScreen'

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  document.body.innerHTML = ''
})

function design(name: string): CanopiFile {
  return {
    version: 9, name, description: null, plant_species_colors: {}, plant_species_symbols: {}, layers: [], plants: [],
    zones: [], annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [],
    budget_currency: 'EUR', views: [], stories: [], created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', extra: {},
  }
}

async function menuItems(rowName: string): Promise<string[]> {
  await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${rowName}"]`)!.click() })
  const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => item.textContent ?? '')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  return items
}

describe('the Web start screen while 2.1’s Draft listing cannot be read', () => {
  it('R3 canopi-f47t.52.272: an old-key Draft row offers no Delete until a listing completes (2.1-Q334)', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const appDataStore = createBrowserAppDataStore({ storage })
    appDataStore.saveDraft({ id: 'draft-orchard', file: design('Orchard'), now: '2026-01-01T00:00:00.000Z' })
    const controller = createBrowserDesignSessionController({ store: createDesignSessionStore(), appDataStore })
    const listing = { drafts: [], hiddenIds: [], complete: false }
    controller.installNewerDrafts({ list: vi.fn(async () => listing), content: vi.fn(async () => null) })
    await controller.launch()
    const persistence = { view: signal({ state: 'kept' as const, notice: null, warn: false }), keep: vi.fn(), showReason: vi.fn(() => () => {}) }

    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await menuItems('Orchard')).toEqual(['Download a copy'])

    // A listing that completes: the row is editable again, Delete included.
    listing.complete = true
    render(null, container)
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await menuItems('Orchard')).toEqual(['Download a copy', 'Delete draft…'])
  })
})
