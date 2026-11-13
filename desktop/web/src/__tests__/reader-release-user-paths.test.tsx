// @vitest-environment jsdom
// The reader release's user paths that a DOM test reaches (Step 2.0.4; plan "Tests by behaviour"). Written failing
// in commit 0, each marked expected-fail (`it.fails`) with its owner stream and bead in the title; the stream that
// builds it removes the marker in the commit that makes it pass (each stream flips its own case through the main
// agent at merge). Cross-module: each case crosses an edition's store adapter or welcome screen and a shared seam.
//
// - R3 (canopi-f47t.52.272): the Web twin of settings record 2 and the species-list record read from their 2.1 keys
//   (contracts §11 "Web Drafts move to IndexedDB": `canopi:web-app-data:v4:settings`, `canopi:web-app-data:v4:species`,
//   2.1-Q320, 2.1-M486). The record field names here are the contract's; R3 confirms them when it freezes the forms.
// - U (canopi-pqxl): the Trackpad default on macOS at Web's first-run seam (2.1-Q309, 2.1-Q324) and the welcome
//   screen's "Moving around" line to Help's gestures section (2.1-Q311).
// - U (canopi-4j6l): the favourites note in Settings › Files and data (2.1-Q312).

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/design', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcDesignModule>()),
  getRecentFiles: vi.fn(async () => []),
  getRecentDesignPreviews: vi.fn(async () => []),
  listDesignDrafts: vi.fn(async () => []),
}))

import { locale } from '../app/settings/state'
import { closeKeyboardShortcutsDialog, closeSettingsDialog, keyboardShortcutsDialogOpen, openSettingsDialog } from '../app/shell/dialogs'
import { KeyboardShortcutsDialog } from '../components/shared/KeyboardShortcutsDialog'
import { SettingsDialog, type SettingsFoldersAdapter } from '../components/shared/SettingsDialog'
import { WelcomeScreen } from '../components/shared/WelcomeScreen'
import { StoreRefusedError } from '../failures/store-read'
import type * as IpcDesignModule from '../ipc/design'
import { browserSettingsPlatformAdapter } from '../platform/settings.browser'
import type { SpeciesListItem } from '../types/species'
import { browserAppDataStore } from '../web/browser-app-data'
import { createReducedSpeciesCatalogAdapters, type ReducedSpeciesCatalogReader } from '../web/reduced-species-catalog'

const V3_SETTINGS_KEY = 'canopi:web-app-data:v3:settings'
const V4_SETTINGS_KEY = 'canopi:web-app-data:v4:settings'
const V3_SPECIES_KEY = 'canopi:web-app-data:v3:species'
const V4_SPECIES_KEY = 'canopi:web-app-data:v4:species'

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  closeSettingsDialog()
  closeKeyboardShortcutsDialog()
  localStorage.clear()
  vi.restoreAllMocks()
})

/** Every localStorage entry, key and value, in key order: what "never written" compares. */
function storageDump(): [string, string][] {
  return Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)!])
}

/** The browser this test reports: its user agent and, where the engine still has it, `navigator.platform`. */
function browserIs(userAgent: string, platform: string): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
}

describe('reader release on Web: records from their 2.1 keys', () => {
  it('R3 canopi-f47t.52.272: reader release: settings record 2 applies its known fields and is never written (Web)', async () => {
    // A 2.0 tab's record beside the record 2.1 wrote: the 2.1 key is the user's latest choice.
    localStorage.setItem(V3_SETTINGS_KEY, JSON.stringify({ version: 3, settings: { locale: 'fr', theme: 'light' } }))
    localStorage.setItem(V4_SETTINGS_KEY, JSON.stringify({
      version: 2,
      locale: 'de',
      theme: 'dark',
      snap_to_grid: true,
      basemap_style: 'terrain-2-1',
      unit_system: 'us_customary',
    }))
    const before = storageDump()

    // Today only the v3 key is read, so French and the light theme apply.
    const read = await browserSettingsPlatformAdapter.load()
    expect(read.locale, 'a known field applies').toBe('de')
    expect(read.theme, 'a known field applies').toBe('dark')
    expect(read.snap_to_grid, 'a known field applies').toBe(true)
    expect(read.basemap_style, 'an unknown literal takes that field’s default').toBe('liberty')
    expect(storageDump(), 'reading writes no key').toEqual(before)

    await expect(
      browserSettingsPlatformAdapter.save({ ...read, theme: 'light' }),
      'a settings change is refused, applied for the session only (2.1-Q320)',
    ).rejects.toBeInstanceOf(StoreRefusedError)
    expect(storageDump(), 'neither record is written').toEqual(before)
  })

  it.fails('R3 canopi-f47t.52.272: reader release: Web shows favourites and recently viewed from their 2.1 key and writes neither', async () => {
    localStorage.setItem(V3_SPECIES_KEY, JSON.stringify({ version: 3, favoriteSpecies: ['Fragaria vesca'], recentlyViewedSpecies: [] }))
    localStorage.setItem(V4_SPECIES_KEY, JSON.stringify({
      version: 1,
      favorites: [{ canonical_name: 'Malus domestica', at: '2026-12-01T10:00:00.000Z' }],
      recently_viewed: [{ canonical_name: 'Corylus avellana', at: '2026-12-02T10:00:00.000Z' }],
    }))
    const before = storageDump()
    const reader = {
      listSpeciesByCanonicalNames: async (names: readonly string[]) =>
        names.map((canonical_name) => ({ canonical_name }) as SpeciesListItem),
    } as Partial<ReducedSpeciesCatalogReader> as ReducedSpeciesCatalogReader
    const species = createReducedSpeciesCatalogAdapters({ appDataStore: browserAppDataStore, reader })

    // Today the v3 record is read: Fragaria is the favourite and nothing was viewed.
    expect((await species.getFavorites('en')).map((row) => row.canonical_name)).toEqual(['Malus domestica'])
    expect((await species.getRecentlyViewed('en', 50)).map((row) => row.canonical_name)).toEqual(['Corylus avellana'])

    await expect(species.toggleFavorite('Symphytum officinale'), 'the star is refused').rejects.toBeInstanceOf(StoreRefusedError)
    await species.recordRecentlyViewed('Symphytum officinale').catch(() => undefined)
    expect(storageDump(), 'neither record is written, nor the 2.0 key').toEqual(before)
  })
})

describe('first launch on a Mac (canopi-pqxl)', () => {
  it('U canopi-pqxl: macOS first launch defaults the pointing device to Trackpad and leaves a stored choice (Web)', async () => {
    browserIs(MAC_SAFARI, 'MacIntel')
    expect((await browserSettingsPlatformAdapter.load()).scroll_wheel, 'a new Mac profile starts on Trackpad').toBe('pan')

    localStorage.setItem(V3_SETTINGS_KEY, JSON.stringify({ version: 3, settings: { scroll_wheel: 'zoom' } }))
    expect((await browserSettingsPlatformAdapter.load()).scroll_wheel, 'a stored choice stays').toBe('zoom')

    localStorage.clear()
    browserIs(WINDOWS_CHROME, 'Win32')
    expect((await browserSettingsPlatformAdapter.load()).scroll_wheel, 'other systems keep Mouse').toBe('zoom')
  })

  it('U canopi-pqxl: the welcome screen’s Moving around opens Help at the gestures section', async () => {
    await act(async () => {
      render(<><WelcomeScreen /><KeyboardShortcutsDialog menus={[]} /></>, container)
    })
    await act(async () => { await Promise.resolve() })

    // Today the start screen's Help-line slot is empty on Desktop.
    const line = container.querySelector<HTMLButtonElement>('[data-start-help-line]')
    expect(line?.textContent, 'the welcome screen offers Moving around').toBe('Moving around')
    await act(async () => { line!.click() })

    expect(keyboardShortcutsDialogOpen.value, 'Help opens').toBe(true)
    const gestures = container.querySelector('section[aria-labelledby="shortcuts-gestures"]')
    expect(gestures, 'Help lists the gestures').not.toBeNull()
    expect(gestures!.contains(document.activeElement), 'Help opens at the gestures section').toBe(true)
  })
})

describe('the favourites note (canopi-4j6l)', () => {
  async function openFilesSection(folders?: SettingsFoldersAdapter): Promise<HTMLElement> {
    await act(async () => { render(folders ? <SettingsDialog folders={folders} /> : <SettingsDialog />, container) })
    await act(async () => { openSettingsDialog() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-settings-section="files"]')!.click()
    })
    return container.querySelector<HTMLElement>('[role="dialog"] section')!
  }

  it('U canopi-4j6l: Settings shows the favourites note while folders load', async () => {
    // Desktop: the folders never answer, so the section stays loading.
    const loading: SettingsFoldersAdapter = { load: () => new Promise(() => {}), show: async () => {} }
    const desktop = await openFilesSection(loading)
    // Today the section shows only its loading line.
    expect(desktop.textContent, 'Desktop says favourites stay on this device').toMatch(/favorites/i)

    render(null, container)
    closeSettingsDialog()
    const web = await openFilesSection()
    expect(web.textContent, 'Web says favourites stay in this browser').toMatch(/favorites/i)
  })
})
