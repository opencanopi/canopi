// @vitest-environment jsdom

// canopi-etzh: a Web catalog that cannot load (the SPA's HTML in place of the manifest, a 404, a network failure)
// shows the translated "The plant catalog couldn't load." with Retry in the results and the species panel, never the
// raw error; the raw error goes to the frontend diagnostics only, never the console. Through the real reader, runtime,
// Workbench and panel, with only `fetch` stubbed.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DiagnosticsModule from '../app/problem-report/diagnostics'
import type * as PlantBrowserModule from '../app/plant-browser'
import type { createBrowserSpeciesCatalogRuntime } from '../app/plant-browser/browser-runtime'

const LOAD_FAILED = 'The plant catalog couldn’t load.'

type Answer = 'html' | 'not-found' | 'network'

/** What the dev server or the network gives for the catalog's manifest. */
function failingFetch(answer: Answer) {
  return vi.fn(async () => {
    if (answer === 'network') throw new TypeError('NetworkError when attempting to fetch resource.')
    if (answer === 'not-found') return { ok: false, status: 404, json: async () => ({}) }
    // The SPA's index.html, answered 200 for any path.
    return { ok: true, status: 200, json: async () => JSON.parse('<!doctype html><html></html>') as unknown }
  })
}

/** The raw text each answer's error carries, which must never be shown. */
const RAW: Record<Answer, RegExp> = {
  html: /JSON|Unexpected token|<!doctype/i,
  'not-found': /404|Failed to fetch|manifest/i,
  network: /NetworkError/,
}

describe('Web plant catalog load failure', () => {
  let container: HTMLDivElement
  let runtime: ReturnType<typeof createBrowserSpeciesCatalogRuntime>
  let diagnostics: typeof DiagnosticsModule
  let consoleError: ReturnType<typeof vi.spyOn>

  async function mountPanel(answer: Answer, mode: 'catalog' | 'favorites' = 'catalog', catalogBaseUrl: URL | null = new URL('http://catalog.test/catalog/')): Promise<ReturnType<typeof failingFetch>> {
    const fetch = failingFetch(answer)
    vi.stubGlobal('fetch', fetch)
    vi.resetModules()
    diagnostics = await import('../app/problem-report/diagnostics')
    diagnostics.resetFrontendDiagnosticsForTests()
    const { createBrowserSpeciesCatalogRuntime } = await import('../app/plant-browser/browser-runtime')
    const { createBrowserAppDataStore } = await import('../web/browser-app-data')
    const { createDuckDbReducedSpeciesCatalogReader } = await import('../web/duckdb-wasm-catalog')
    runtime = createBrowserSpeciesCatalogRuntime({
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      reader: createDuckDbReducedSpeciesCatalogReader(catalogBaseUrl ? { catalogBaseUrl } : {}),
    })
    vi.doMock('../app/plant-browser', async () => ({
      ...await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser'),
      speciesCatalogWorkbench: runtime.workbench,
    }))
    const { WebSpeciesCatalogPanel } = await import('../web/WebSpeciesCatalogPanel')
    await act(async () => { render(<WebSpeciesCatalogPanel mode={mode} />, container) })
    return fetch
  }

  async function alertShown(): Promise<HTMLElement> {
    let alert: HTMLElement | null = null
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve() })
      alert = container.querySelector<HTMLElement>('[role="alert"]')
      expect(alert).not.toBeNull()
    })
    return alert!
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    render(null, container)
    container.remove()
    await runtime?.dispose()
    vi.doUnmock('../app/plant-browser')
    vi.unstubAllGlobals()
    consoleError.mockRestore()
  })

  for (const answer of ['html', 'not-found', 'network'] as const) {
    it(`a ${answer} answer shows the translated message and Retry, and records the raw error as a diagnostic only`, async () => {
      const fetch = await mountPanel(answer)

      const alert = await alertShown()
      expect(alert.textContent).toContain(LOAD_FAILED)
      expect(alert.textContent).not.toMatch(RAW[answer])
      const recorded = diagnostics.recentFrontendDiagnostics()
      expect(recorded.length).toBeGreaterThan(0)
      expect(recorded.every((entry) => entry.source === 'plant-catalog' && entry.level === 'error')).toBe(true)
      expect(recorded[0]!.message).toMatch(RAW[answer])
      expect(consoleError).not.toHaveBeenCalled()

      // Retry asks again.
      const before = fetch.mock.calls.length
      const retry = Array.from(alert.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!
      await act(async () => { retry.click() })
      await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before))
      expect((await alertShown()).textContent).toContain(LOAD_FAILED)
    })
  }

  it('Favorites and Recently viewed show the message and Retry, announced once per failed attempt, with Retry keeping keyboard focus while it waits and after it fails', async () => {
    const fetch = await mountPanel('network', 'favorites')
    const alerts = () => Array.from(container.querySelectorAll<HTMLElement>('[role="alert"]'))
    const failures = () => Array.from(container.querySelectorAll<HTMLElement>('[data-list-load-failed]'))
    const retries = () => failures().map((failure) => Array.from(failure.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!)
    const settle = async () => { await act(async () => { await Promise.resolve() }) }

    // Both lists say the catalog couldn't load, each with Retry; one alert announces the failed attempt.
    await vi.waitFor(async () => {
      await settle()
      expect(failures()).toHaveLength(2)
      expect(alerts().map((alert) => alert.textContent)).toEqual([LOAD_FAILED])
    })
    for (const failure of failures()) {
      expect(failure.textContent).toContain(LOAD_FAILED)
      expect(failure.textContent).not.toMatch(RAW.network)
    }
    expect(retries().map((button) => button.getAttribute('aria-disabled'))).toEqual([null, null])
    expect(container.textContent).not.toContain('No favorites yet')
    expect(container.textContent).not.toContain('No recently viewed plants yet')
    expect(diagnostics.recentFrontendDiagnostics().some((entry) => entry.source === 'plant-catalog' && RAW.network.test(entry.message))).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()

    // The retry is pending: both Retry buttons wait (aria-disabled, never disabled, so the focused one keeps keyboard
    // focus) and ignore clicks, and the alert is quiet.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const failNetwork = fetch.getMockImplementation()!
    fetch.mockImplementation(async (...args: Parameters<typeof failNetwork>) => {
      await held
      return failNetwork(...args)
    })
    const before = fetch.mock.calls.length
    const focused = retries()[1]!
    focused.focus()
    await act(async () => { focused.click() })
    await vi.waitFor(async () => {
      await settle()
      expect(fetch.mock.calls.length).toBeGreaterThan(before)
      expect(retries().map((button) => button.getAttribute('aria-disabled'))).toEqual(['true', 'true'])
      expect(alerts().map((alert) => alert.textContent)).toEqual([''])
    })
    expect(retries().map((button) => button.disabled)).toEqual([false, false])
    expect(document.activeElement).toBe(focused)
    const pendingCalls = fetch.mock.calls.length
    await act(async () => { focused.click() })
    await settle()
    expect(fetch.mock.calls.length).toBe(pendingCalls)

    // The retry fails again: announced again, once, and Retry is offered again.
    release()
    await vi.waitFor(async () => {
      await settle()
      expect(alerts().map((alert) => alert.textContent)).toEqual([LOAD_FAILED])
      expect(retries().map((button) => button.getAttribute('aria-disabled'))).toEqual([null, null])
    })
    expect(document.activeElement).toBe(focused)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('reads the manifest from the content-named catalog directory the build gave the bundle (2.1-M176)', async () => {
    const fetch = await mountPanel('not-found', 'catalog', null)
    await alertShown()
    const requested = new URL(String((fetch.mock.calls[0] as unknown[])[0]))
    expect(requested.origin).toBe(location.origin)
    expect(requested.pathname).toBe(`${import.meta.env.BASE_URL}${__CANOPI_WEB_CATALOG_PATH__}manifest.json`)
    expect(requested.pathname).toMatch(/\/assets\/catalog\/(?:[0-9a-f]{16}|none)\/manifest\.json$/)
  })

  it('the species panel shows the same message and Retry when a species cannot load', async () => {
    const fetch = await mountPanel('network')
    await alertShown()

    await act(async () => { runtime.workbench.selectSpecies('Malus domestica') })
    // The species' detail replaces the hidden results, which keep their own alert.
    const detailAlert = () => container.querySelector<HTMLElement>('[data-species-detail-error]')
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve() })
      expect(detailAlert()?.getAttribute('role')).toBe('alert')
    })
    expect(detailAlert()!.textContent).toContain(LOAD_FAILED)
    expect(detailAlert()!.textContent).not.toMatch(RAW.network)
    const before = fetch.mock.calls.length
    const retry = Array.from(detailAlert()!.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!
    await act(async () => { retry.click() })
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before))
    expect(consoleError).not.toHaveBeenCalled()
  })
})

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
