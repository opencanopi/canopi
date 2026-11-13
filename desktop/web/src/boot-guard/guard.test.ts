// @vitest-environment jsdom
// The start-up guard's decisions in a DOM (canopi-4kfl, 2.1-M489): the e2e spec (e2e/canvas/boot-guard.spec.ts) drives
// the built script in three engines; these run the source once per case, as the plugin's script runs once per page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEXTS = {
  en: { title: 'Canopi couldn’t start', hint: 'Update.' },
  fr: { title: 'Canopi n’a pas pu démarrer', hint: 'Mettez à jour.' },
}

type GuardGlobals = { __CANOPI_BOOT_GUARD_TEXTS__?: typeof TEXTS, __CANOPI_BOOT_ACKNOWLEDGED__?: true }

/** Runs the guard's script in this page, as its classic script runs before the entry module. */
async function runGuard(): Promise<void> {
  vi.resetModules()
  await import('./guard')
}

const guard = () => document.querySelector('[data-boot-guard]')
/** Each run's window listeners, removed after its case: the window outlives every run in this file. */
const listeners: Parameters<Window['addEventListener']>[] = []
const load = () => window.dispatchEvent(new Event('load'))

beforeEach(() => {
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((...args: Parameters<Window['addEventListener']>) => {
    listeners.push(args)
    add(...args)
  })
  ;(globalThis as GuardGlobals).__CANOPI_BOOT_GUARD_TEXTS__ = TEXTS
  // The APIs the guard requires that jsdom lacks; Node gives the rest.
  vi.stubGlobal('ResizeObserver', class {})
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('fetch', async () => new Response())
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [type, listener, options] of listeners.splice(0)) window.removeEventListener(type, listener, options)
  vi.unstubAllGlobals()
  delete (globalThis as GuardGlobals).__CANOPI_BOOT_ACKNOWLEDGED__
  delete (globalThis as GuardGlobals).__CANOPI_BOOT_GUARD_TEXTS__
  document.body.replaceChildren()
})

describe('the start-up guard (canopi-4kfl)', () => {
  it('shows at the load event when the app never acknowledged its boot', async () => {
    await runGuard()
    expect(guard()).toBeNull()
    load()
    expect(guard()?.getAttribute('role')).toBe('alert')
    expect(guard()?.querySelector('h1')?.textContent).toBe('Canopi couldn’t start')
    expect(guard()?.textContent).toContain('Update.')
  })

  it('never shows when the app acknowledged its boot before the load event (a slow normal boot)', async () => {
    await runGuard()
    ;(globalThis as GuardGlobals).__CANOPI_BOOT_ACKNOWLEDGED__ = true
    load()
    window.dispatchEvent(new ErrorEvent('error', { filename: `${location.origin}/assets/web.js` }))
    expect(guard()).toBeNull()
  })

  it('shows at once when a required API is missing, acknowledged or not', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    ;(globalThis as GuardGlobals).__CANOPI_BOOT_ACKNOWLEDGED__ = true
    await runGuard()
    expect(guard()).not.toBeNull()
  })

  it('canopi-4kfl: never shows over a booted app on a floor engine without Intl.Segmenter (Firefox 121 to 124)', async () => {
    // The app never calls Intl.Segmenter (utils/text-graphemes.ts works without it); Firefox ships it only from 125.
    vi.stubGlobal('Intl', { ...Object.fromEntries(Object.getOwnPropertyNames(Intl).map((name) => [name, Reflect.get(Intl, name)])), Segmenter: undefined })
    ;(globalThis as GuardGlobals).__CANOPI_BOOT_ACKNOWLEDGED__ = true
    await runGuard()
    load()
    expect(guard()).toBeNull()
  })

  it('shows at a same-origin script or chunk error before the acknowledgement, without waiting for the load event', async () => {
    await runGuard()
    window.dispatchEvent(new ErrorEvent('error', { filename: 'chrome-extension://abc/inject.js' }))
    expect(guard(), 'another origin\'s script is not the app').toBeNull()
    const chunk = document.createElement('link')
    chunk.rel = 'modulepreload'
    chunk.href = 'https://cdn.example/x.js'
    document.head.appendChild(chunk)
    chunk.dispatchEvent(new Event('error'))
    expect(guard(), 'nor another origin\'s file').toBeNull()
    const styles = document.createElement('link')
    styles.rel = 'stylesheet'
    styles.href = `${location.origin}/assets/web.css`
    document.head.appendChild(styles)
    styles.dispatchEvent(new Event('error'))
    expect(guard(), 'nor a stylesheet, which never stops the boot').toBeNull()
    styles.remove()
    const script = document.createElement('script')
    script.src = `${location.origin}/assets/web-entry.js`
    document.body.appendChild(script)
    script.dispatchEvent(new Event('error'))
    expect(guard()).not.toBeNull()
    chunk.remove()
  })

  it('speaks the system language, and English for one Canopi has no strings in', async () => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-CA')
    await runGuard()
    load()
    expect(guard()?.getAttribute('lang')).toBe('fr')
    document.body.replaceChildren()
    language.mockReturnValue('tlh-Latn')
    await runGuard()
    load()
    expect(guard()?.getAttribute('lang')).toBe('en')
    expect(guard()?.querySelector('h1')?.textContent).toBe('Canopi couldn’t start')
  })
})
