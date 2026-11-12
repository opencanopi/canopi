// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { aboutCanopiDialogOpen } from '../app/about/state'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { recentFrontendDiagnostics } from '../app/problem-report/diagnostics'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import {
  googleMapsApiKey,
  locale,
  newDesignDefaults,
  satelliteSource,
  activeGoogleMapsApiKey,
  scrollWheel,
  singleKeyShortcuts,
} from '../app/settings/state'
import {
  closeKeyboardShortcutsDialog,
  closeSettingsDialog,
  keyboardShortcutsDialogOpen,
  openSettingsDialog,
} from '../app/shell/dialogs'
import { SettingsDialog, type SettingsFoldersAdapter } from '../components/shared/SettingsDialog'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
  type SettingsProjectionInstallation,
} from '../app/settings/projection'
import { resetStoreHealthForTests, storeStatus } from '../failures/health'
import { createBrowserSettingsPlatformAdapter } from '../platform/settings.browser'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'

const FAKE_KEY = 'FAKE-GOOGLE-KEY-never-log-me-42'
const DEFAULT_NEW_DESIGNS = { satellite: false, symbolScale: 1, labels: 'names' } as const

let container: HTMLDivElement
let consoleSpies: MockInstance[]

function dialog(): HTMLElement {
  return container.querySelector<HTMLElement>('[role="dialog"]')!
}

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}

function radio(label: string): HTMLButtonElement {
  return [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((candidate) => candidate.textContent === label)!
}

function keyInput(): HTMLInputElement | null {
  return dialog().querySelector<HTMLInputElement>('[data-google-key-input]')
}

async function openSection(section: string, folders?: SettingsFoldersAdapter): Promise<void> {
  await act(async () => { render(<SettingsDialog folders={folders} />, container) })
  await act(async () => { openSettingsDialog() })
  await act(async () => {
    dialog().querySelector<HTMLButtonElement>(`[data-settings-section="${section}"]`)!.click()
  })
}

/** Everything the page, the console and the diagnostics buffer could leak. */
function everywhereTheKeyCouldLeak(): string {
  const consoleText = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n')
  return [
    document.documentElement.outerHTML,
    consoleText,
    JSON.stringify(recentFrontendDiagnostics()),
  ].join('\n')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  locale.value = 'en'
  googleMapsApiKey.value = null
  satelliteSource.value = 'free'
  mapLayers.value = createDefaultMapLayers()
  newDesignDefaults.value = DEFAULT_NEW_DESIGNS
  singleKeyShortcuts.value = true
  scrollWheel.value = 'zoom'
  resetFrontendDiagnosticsForTests()
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method))
})

afterEach(() => {
  closeSettingsDialog()
  closeKeyboardShortcutsDialog()
  aboutCanopiDialogOpen.value = false
  render(null, container)
  container.remove()
  googleMapsApiKey.value = null
  newDesignDefaults.value = DEFAULT_NEW_DESIGNS
  singleKeyShortcuts.value = true
  vi.restoreAllMocks()
})

describe('Settings sections', () => {
  it('lists every section and shows one at a time', async () => {
    await openSection('appearance')
    const nav = dialog().querySelector('nav')!
    expect([...nav.querySelectorAll('button')].map((item) => item.textContent)).toEqual([
      'Appearance', 'Map and imagery', 'Canvas', 'New Designs', 'Keyboard', 'Files and data', 'About',
    ])
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Appearance')
    await act(async () => { button('Keyboard').click() })
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Keyboard')
    expect(dialog().querySelector('h3')!.textContent).toBe('Keyboard')
  })
})

describe('Settings › Map and imagery: the Google key', () => {
  it('keeps a saved key masked and out of the page until Show, then only inside the input', async () => {
    googleMapsApiKey.value = FAKE_KEY
    satelliteSource.value = 'google_key'
    await openSection('map')

    expect(radio('My Google key').getAttribute('aria-checked')).toBe('true')
    const input = keyInput()!
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(dialog().textContent).toContain('A key is saved.')
    expect(dialog().textContent).toContain('The key stays on this device.')
    expect(everywhereTheKeyCouldLeak()).not.toContain(FAKE_KEY)

    await act(async () => { button('Show').click() })
    expect(button('Show').getAttribute('aria-pressed')).toBe('true')
    expect(keyInput()!.type).toBe('text')
    expect(keyInput()!.value).toBe(FAKE_KEY)
    // The value is the input's own state, never page markup or text.
    expect(dialog().textContent).not.toContain(FAKE_KEY)
    expect(everywhereTheKeyCouldLeak()).not.toContain(FAKE_KEY)

    await act(async () => { button('Show').click() })
    expect(keyInput()!.value).toBe('')
    expect(keyInput()!.type).toBe('password')
  })

  it('saves a typed key trimmed, and Remove key forgets it', async () => {
    await openSection('map')
    expect(radio('Free imagery').getAttribute('aria-checked')).toBe('true')
    expect(keyInput()).toBeNull()

    await act(async () => { radio('My Google key').click() })
    const input = keyInput()!
    expect(button('Show').disabled).toBe(true)
    await act(async () => {
      input.value = `  ${FAKE_KEY}  `
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('Save key').click() })
    expect(googleMapsApiKey.value).toBe(FAKE_KEY)
    expect(keyInput()!.value).toBe('')
    expect(dialog().querySelector('[role="status"]')!.textContent).toBe('Key saved on this device.')

    await act(async () => { button('Remove key').click() })
    expect(googleMapsApiKey.value).toBeNull()
    expect(dialog().querySelector('[role="status"]')!.textContent).toBe('Key removed. The map uses the free imagery.')
    expect(everywhereTheKeyCouldLeak()).not.toContain(FAKE_KEY)
  })

  it('keeps a saved key when switching to Free imagery and back; only Remove key forgets it', async () => {
    googleMapsApiKey.value = FAKE_KEY
    satelliteSource.value = 'google_key'
    await openSection('map')
    expect(activeGoogleMapsApiKey.value).toBe(FAKE_KEY)

    await act(async () => { radio('Free imagery').click() })
    expect(satelliteSource.value).toBe('free')
    expect(googleMapsApiKey.value).toBe(FAKE_KEY)
    // The provider stops using it.
    expect(activeGoogleMapsApiKey.value).toBeNull()
    expect(keyInput()).toBeNull()
    expect(dialog().textContent).toContain('Your Google key stays saved on this device, unused.')
    expect(everywhereTheKeyCouldLeak()).not.toContain(FAKE_KEY)

    await act(async () => { radio('My Google key').click() })
    expect(satelliteSource.value).toBe('google_key')
    expect(googleMapsApiKey.value).toBe(FAKE_KEY)
    expect(activeGoogleMapsApiKey.value).toBe(FAKE_KEY)
    expect(keyInput()!.value).toBe('')
    expect(everywhereTheKeyCouldLeak()).not.toContain(FAKE_KEY)

    await act(async () => { radio('Free imagery').click() })
    await act(async () => { button('Remove key').click() })
    expect(googleMapsApiKey.value).toBeNull()
    expect(satelliteSource.value).toBe('free')
  })

  it('sets the map style and Soften background for this device', async () => {
    await openSection('map')
    await act(async () => { dialog().querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click() })
    const positron = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === 'Positron')!
    await act(async () => { positron.click() })
    expect(mapLayers.value.basemap.style).toBe('positron')

    await act(async () => { dialog().querySelector<HTMLInputElement>('input[role="switch"]')!.click() })
    expect(mapLayers.value.softenBackground).toBe(true)
  })
})

describe('Settings › New Designs', () => {
  it('stores the defaults a new Design starts with', async () => {
    await openSection('new-designs')
    expect(dialog().textContent).toContain('Designs you already have keep their own.')

    await act(async () => { dialog().querySelector<HTMLInputElement>('input[role="switch"]')!.click() })
    expect(newDesignDefaults.value.satellite).toBe(true)

    const slider = dialog().querySelector<HTMLInputElement>('input[type="range"]')!
    await act(async () => {
      slider.value = '150'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(newDesignDefaults.value.symbolScale).toBe(1.5)
    expect(slider.getAttribute('aria-valuetext')).toBe('150%')

    await act(async () => { radio('Codes').click() })
    expect(newDesignDefaults.value.labels).toBe('codes')
  })
})

describe('Settings › Canvas', () => {
  it('chooses the pointing device, Mouse or Trackpad', async () => {
    await openSection('canvas')
    expect(dialog().querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Pointing device')
    expect(radio('Mouse: the wheel zooms').getAttribute('aria-checked')).toBe('true')
    expect(dialog().textContent).toContain('Pinch and Ctrl + wheel always zoom. Shift + wheel pans.')
    expect(dialog().textContent).not.toContain('Scroll wheel')

    // Trackpad is stored as the scroll-wheel choice `pan`, which makes the wheel pan.
    await act(async () => { radio('Trackpad: two fingers pan').click() })
    expect(scrollWheel.value).toBe('pan')
    expect(radio('Trackpad: two fingers pan').getAttribute('aria-checked')).toBe('true')
    await act(async () => { radio('Mouse: the wheel zooms').click() })
    expect(scrollWheel.value).toBe('zoom')
  })
})

// 2.1-Q309, 2.1-Q324: on a Mac a new Web profile starts on Trackpad; a stored choice stays, and reading the record writes
// nothing (2.1-M473). Through the real record store, browser adapter and settings projection.
describe('Settings › Canvas on a Mac (canopi-pqxl)', () => {
  const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'
  let installation: SettingsProjectionInstallation | null = null

  function memoryStorage(initial: Record<string, string> = {}): BrowserStorageAdapter & { readonly items: Map<string, string> } {
    const items = new Map(Object.entries(initial))
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => { items.set(key, value) },
      removeItem: (key) => { items.delete(key) },
    }
  }

  async function launchOnAMac(storage: BrowserStorageAdapter): Promise<void> {
    const adapter = createBrowserSettingsPlatformAdapter(
      createBrowserAppDataStore({ storage, session: memoryStorage() }),
      () => 'mac',
    )
    installation = installSettingsProjection(adapter)
    const ready = installation.ready.catch(() => undefined)
    await vi.runAllTimersAsync()
    await ready
  }

  beforeEach(() => {
    vi.useFakeTimers()
    resetSettingsProjectionForTests()
    resetStoreHealthForTests()
  })

  afterEach(() => {
    installation?.dispose()
    installation = null
    resetSettingsProjectionForTests()
    resetStoreHealthForTests()
    vi.useRealTimers()
  })

  it('U canopi-pqxl: a first launch on a Mac shows Trackpad chosen and writes nothing', async () => {
    const storage = memoryStorage()
    await launchOnAMac(storage)
    await openSection('canvas')

    expect(radio('Trackpad: two fingers pan').getAttribute('aria-checked')).toBe('true')
    expect(scrollWheel.value).toBe('pan')
    expect([...storage.items.keys()].filter((key) => key === SETTINGS_KEY), 'reading writes no record').toEqual([])
  })

  it('U canopi-pqxl: a stored Mouse choice on a Mac stays Mouse and its record is not rewritten', async () => {
    const record = JSON.stringify({ version: 3, settings: { scroll_wheel: 'zoom', theme: 'dark' } })
    const storage = memoryStorage({ [SETTINGS_KEY]: record })
    await launchOnAMac(storage)
    await openSection('canvas')

    expect(radio('Mouse: the wheel zooms').getAttribute('aria-checked')).toBe('true')
    expect(storage.items.get(SETTINGS_KEY)).toBe(record)
  })

  function refusingStorage(setItem: BrowserStorageAdapter['setItem']): BrowserStorageAdapter {
    return {
      getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
      setItem,
      removeItem: () => undefined,
    }
  }

  it('U canopi-pqxl: a Mac browser refusing storage (SecurityError) runs on the in-memory default and writes nothing', async () => {
    const setItem = vi.fn()
    await launchOnAMac(refusingStorage(setItem))

    expect(storeStatus('settings')).toEqual({ kind: 'unavailable', code: { kind: 'io', io: 'permission_denied' } })
    expect(setItem).not.toHaveBeenCalled()
  })

  // Expected to fail until the projection's unavailable branch takes the adapter's host fallback (owner: main agent,
  // app/settings/projection.ts and platform-adapter.ts; tracker canopi-pqxl): the signals keep the host-independent Mouse.
  it.fails('U canopi-pqxl (main agent, projection fallback): a Mac browser refusing storage starts on Trackpad', async () => {
    await launchOnAMac(refusingStorage(vi.fn()))

    expect(storeStatus('settings')).toMatchObject({ kind: 'unavailable' })
    expect(scrollWheel.value).toBe('pan')
  })

  it.fails('U canopi-pqxl (main agent, projection fallback): a Mac with a record the store refuses starts on Trackpad and keeps the record', async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: 'not a record' })
    await launchOnAMac(storage)

    expect(storeStatus('settings')).toEqual({ kind: 'unavailable', code: { kind: 'invalid' } })
    expect(storage.items.get(SETTINGS_KEY)).toBe('not a record')
    expect(scrollWheel.value).toBe('pan')
  })
})

describe('Settings › Keyboard', () => {
  it('turns single-key shortcuts off and opens the full list', async () => {
    await openSection('keyboard')
    expect(dialog().textContent).toContain('Shortcuts can’t be changed yet.')
    await act(async () => { dialog().querySelector<HTMLInputElement>('input[role="switch"]')!.click() })
    expect(singleKeyShortcuts.value).toBe(false)

    await act(async () => { button('Show all shortcuts').click() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(keyboardShortcutsDialogOpen.value).toBe(true)
  })
})

describe('Settings › Files and data', () => {
  it('shows where Drafts and the Data library live and opens each folder', async () => {
    const folders: SettingsFoldersAdapter = {
      load: vi.fn().mockResolvedValue({ drafts: '/home/me/.local/share/canopi/drafts', data_library: '/home/me/.local/share/canopi/lidar' }),
      show: vi.fn().mockResolvedValue(undefined),
    }
    await openSection('files', folders)
    const rows = [...dialog().querySelectorAll<HTMLElement>('[data-app-folder]')]
    expect(rows.map((row) => row.dataset.appFolder)).toEqual(['drafts', 'data_library'])
    expect(rows[0]!.textContent).toContain('/home/me/.local/share/canopi/drafts')
    expect(rows[1]!.textContent).toContain('Data library')

    await act(async () => { rows[1]!.querySelector('button')!.click() })
    expect(folders.show).toHaveBeenCalledWith('data_library')
  })

  it('says so when a folder cannot be opened, without logging its path', async () => {
    const folders: SettingsFoldersAdapter = {
      load: vi.fn().mockResolvedValue({ drafts: '/home/me/drafts', data_library: '/home/me/lidar' }),
      show: vi.fn().mockRejectedValue(new Error('Failed to open /home/me/drafts')),
    }
    await openSection('files', folders)
    await act(async () => { dialog().querySelector<HTMLElement>('[data-app-folder="drafts"] button')!.click() })
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('The folder couldn’t be opened.')
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n')).not.toContain('/home/me')
  })

  it('on Web, says Designs stay in the browser', async () => {
    await openSection('files')
    expect(dialog().textContent).toContain('The Web Edition keeps your Designs and Drafts in this browser.')
    expect(dialog().querySelector('[data-app-folder]')).toBeNull()
  })

  // 2.1-Q312: favourites belong to this computer or this browser, never to a Design; the note shows in every state.
  const DESKTOP_NOTE = 'Favorites stay on this computer, not in a Design: a Design you share or open elsewhere doesn’t carry them.'
  const WEB_NOTE = 'Favorites stay in this browser, not in a Design: a Design you share or open elsewhere doesn’t carry them.'

  function favouritesNote(): string | null {
    return dialog().querySelector<HTMLElement>('[data-favourites-note]')?.textContent ?? null
  }

  it('U canopi-4j6l: Desktop shows the favourites note beside its folders', async () => {
    const folders: SettingsFoldersAdapter = {
      load: vi.fn().mockResolvedValue({ drafts: '/home/me/drafts', data_library: '/home/me/lidar' }),
      show: vi.fn().mockResolvedValue(undefined),
    }
    await openSection('files', folders)
    expect(dialog().querySelectorAll('[data-app-folder]')).toHaveLength(2)
    expect(favouritesNote()).toBe(DESKTOP_NOTE)
  })

  it('U canopi-4j6l: Desktop shows the favourites note while its folders load', async () => {
    await openSection('files', { load: () => new Promise(() => {}), show: vi.fn() })
    expect(dialog().textContent).toContain('Finding folders…')
    expect(favouritesNote()).toBe(DESKTOP_NOTE)
  })

  it('U canopi-4j6l: Desktop shows the favourites note when its folders cannot be found', async () => {
    await openSection('files', { load: vi.fn().mockRejectedValue(new Error('no folders')), show: vi.fn() })
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('Canopi couldn’t find its folders. Restart Canopi to try again.')
    expect(favouritesNote()).toBe(DESKTOP_NOTE)
  })

  it('U canopi-4j6l: Web says favourites stay in this browser', async () => {
    await openSection('files')
    expect(favouritesNote()).toBe(WEB_NOTE)
  })
})

describe('Settings › About', () => {
  it('names the version and opens About Canopi', async () => {
    await openSection('about')
    expect(dialog().textContent).toMatch(/Canopi \d+\.\d+\.\d+/)
    await act(async () => { button('About Canopi…').click() })
    expect(aboutCanopiDialogOpen.value).toBe(true)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
