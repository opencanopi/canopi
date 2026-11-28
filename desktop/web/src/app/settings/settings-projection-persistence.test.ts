import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../types/settings'
import type { SettingsProjectionInstallation } from './projection'
import { locale, theme } from './state'
import {
  flushSettingsProjection, hydrateSettingsProjectionForTests, installSettingsProjection,
  mutateSettingsProjection, resetSettingsProjectionForTests,
} from './projection'
import { baseSettings, setupSettingsProjectionTest } from '../../__tests__/support/settings-projection-harness'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

/** A failed load is read again after the projection's bounded pauses (SET-05): run them out, then the load settles. */
async function settleLoadFailure(target: SettingsProjectionInstallation, error: Error): Promise<void> {
  await Promise.all([expect(target.ready).rejects.toBe(error), vi.runAllTimersAsync()])
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

const harness = setupSettingsProjectionTest()
const { saveSettings } = harness

describe('settings projection', () => {
  it('persists immediate mutations against the latest normalized snapshot', async () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => {
      settings.locale = 'es'
      settings.sidePanel.width = 480
    }, { persist: 'immediate' })
    await Promise.resolve()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'es',
      side_panel_width: 480,
    }))
  })

  it('debounces queued persistence and writes the latest projection', async () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'queued', delayMs: 250 })
    mutateSettingsProjection((settings) => {
      settings.theme = 'dark'
      settings.mapLayers = { ...settings.mapLayers, basemap: { ...settings.mapLayers.basemap, opacity: 0.4 } }
    }, { persist: 'queued', delayMs: 250 })

    vi.advanceTimersByTime(249)
    expect(saveSettings).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await Promise.resolve()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
      basemap_opacity: 0.4,
    }))
  })

  it('flushes queued persistence immediately and waits for durable settlement', async () => {
    const pendingSave = deferred<void>()
    saveSettings.mockImplementationOnce(() => pendingSave.promise)
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => {
      settings.mapLayers = { ...settings.mapLayers, contours: { ...settings.mapLayers.contours, intervalMeters: 24 } }
    }, { persist: 'queued', delayMs: 250 })

    let settled = false
    const flush = flushSettingsProjection().then(() => {
      settled = true
    })
    await Promise.resolve()
    vi.runAllTimers()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      contour_interval: 24,
    }))
    expect(settled).toBe(false)

    pendingSave.resolve()
    await flush

    expect(settled).toBe(true)
  })

  it('updates projection state but does not persist before settings bootstrap', () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()

    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'it' }, { persist: 'queued', delayMs: 10 })
    vi.runAllTimers()

    expect(theme.value).toBe('dark')
    expect(locale.value).toBe('it')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('avoids persistence when a mutation leaves the settings snapshot unchanged', () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => { settings.locale = 'en' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'queued', delayMs: 250 })
    mutateSettingsProjection((settings) => { settings.locale = 'en' }, { persist: 'queued', delayMs: 250 })
    vi.runAllTimers()

    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('hydrates a synchronous adapter before installation returns', () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()

    harness.installation = installSettingsProjection({
      load: () => baseSettings({ locale: 'fr', theme: 'dark' }),
      save: saveSettings,
    })

    expect(locale.value).toBe('fr')
    expect(theme.value).toBe('dark')
  })

  it('ignores an asynchronous load after its installation is replaced', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    let resolveSlowLoad!: (settings: Settings) => void
    const slowLoad = new Promise<Settings>((resolve) => {
      resolveSlowLoad = resolve
    })

    const staleInstallation = installSettingsProjection({
      load: () => slowLoad,
      save: saveSettings,
    })
    harness.installation = installSettingsProjection({
      load: () => baseSettings({ locale: 'de' }),
      save: saveSettings,
    })

    resolveSlowLoad(baseSettings({ locale: 'fr' }))
    await staleInstallation.ready

    expect(locale.value).toBe('de')
  })

  it('replays and persists a mutation made while asynchronous settings load', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const pendingLoad = deferred<Settings>()
    harness.installation = installSettingsProjection({
      load: () => pendingLoad.promise,
      save: saveSettings,
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    expect(locale.value).toBe('fr')
    expect(saveSettings).not.toHaveBeenCalled()

    pendingLoad.resolve(baseSettings({ locale: 'de', theme: 'dark' }))
    await harness.installation.ready
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())

    expect(locale.value).toBe('fr')
    expect(theme.value).toBe('dark')
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
    }))
  })

  it('makes flush wait for bootstrap before settling an early mutation', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const pendingLoad = deferred<Settings>()
    harness.installation = installSettingsProjection({
      load: () => pendingLoad.promise,
      save: saveSettings,
    })
    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })
    await Promise.resolve()

    expect(flushed).toBe(false)
    expect(saveSettings).not.toHaveBeenCalled()

    pendingLoad.resolve(baseSettings({ locale: 'de' }))
    await flush

    expect(flushed).toBe(true)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }))
  })

  it('2.1-Q67: a settings mutation after the adapter load fails stays in memory and is never written', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const loadError = new Error('settings unavailable')
    harness.installation = installSettingsProjection({
      load: () => Promise.reject(loadError),
      save: saveSettings,
    })

    await settleLoadFailure(harness.installation, loadError)
    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'immediate' })
    await flushSettingsProjection()

    expect(theme.value).toBe('dark')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('does not persist an unchanged fallback after an ordinary load failure', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const loadError = new Error('settings unavailable')
    harness.installation = installSettingsProjection({
      load: () => Promise.reject(loadError),
      save: saveSettings,
    })

    await settleLoadFailure(harness.installation, loadError)
    await flushSettingsProjection()

    const replacement = installSettingsProjection({
      load: () => baseSettings({ locale: 'de' }),
      save: saveSettings,
    })
    harness.installation = replacement
    await replacement.ready

    expect(locale.value).toBe('de')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('does not turn a pre-bootstrap no-op into persistence intent', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const pendingLoad = deferred<Settings>()
    const loadError = new Error('settings unavailable')
    harness.installation = installSettingsProjection({
      load: () => pendingLoad.promise,
      save: saveSettings,
    })

    mutateSettingsProjection(() => {}, { persist: 'immediate' })
    pendingLoad.reject(loadError)

    await settleLoadFailure(harness.installation, loadError)
    await flushSettingsProjection()

    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('ignores a synchronous load that reentrantly replaces its installation', () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    let replacementInstallation: SettingsProjectionInstallation | null = null

    const staleInstallation = installSettingsProjection({
      load: () => {
        replacementInstallation = installSettingsProjection({
          load: () => baseSettings({ locale: 'de' }),
          save: saveSettings,
        })
        return baseSettings({ locale: 'fr' })
      },
      save: saveSettings,
    })
    harness.installation = replacementInstallation ?? staleInstallation

    expect(locale.value).toBe('de')
  })

  it('uses the normalized hydrated snapshot as the durable no-op baseline', () => {
    hydrateSettingsProjectionForTests(baseSettings({
      basemap_opacity: 4,
      contour_interval: 12.7,
      saved_stamps_frame_height: 80,
    }))

    mutateSettingsProjection(() => {}, { persist: 'immediate' })

    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('serializes writes and coalesces overlapping mutations to the latest snapshot', async () => {
    let resolveFirstSave!: () => void
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve
    })
    saveSettings
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'es' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'de' }, { persist: 'immediate' })

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'fr' }))

    resolveFirstSave()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }))
  })

  it('guards serialization when an adapter save synchronously reenters mutation', async () => {
    const firstSave = deferred<void>()
    let activeSaves = 0
    let maximumActiveSaves = 0
    saveSettings.mockImplementation((settings) => {
      activeSaves += 1
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves)
      if (settings.locale === 'fr') {
        mutateSettingsProjection((next) => {
          next.locale = 'de'
        }, { persist: 'immediate' })
      }
      const settlement = settings.locale === 'fr'
        ? firstSave.promise
        : Promise.resolve()
      return settlement.finally(() => {
        activeSaves -= 1
      })
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    expect(maximumActiveSaves).toBe(1)
    expect(saveSettings).toHaveBeenCalledTimes(1)

    firstSave.resolve()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(maximumActiveSaves).toBe(1)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }))
  })

  it('canopi-f47t.52.13: HMR flush-and-drop fires a best-effort flush and drops the old projection without blocking or handing off to a replacement', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const stored = baseSettings()
    const oldSave = vi.fn(async (_settings: Settings) => {})
    harness.installation = installSettingsProjection({
      load: () => stored,
      save: oldSave,
    })

    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'queued', delayMs: 250 })
    expect(oldSave).not.toHaveBeenCalled()

    const replacementLoad = vi.fn(() => baseSettings({ locale: 'de' }))
    const replacementSave = vi.fn(async (_settings: Settings) => {})
    const replacement = installSettingsProjection({
      load: replacementLoad,
      save: replacementSave,
    })
    harness.installation = replacement
    await replacement.ready

    // The retiring projection flushed its queued change once, and the replacement loaded immediately with no hand-off.
    expect(oldSave).toHaveBeenCalledOnce()
    expect(oldSave).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
    expect(replacementLoad).toHaveBeenCalledOnce()
    expect(replacementSave).not.toHaveBeenCalled()
    expect(locale.value).toBe('de')
    expect(theme.value).toBe('light')
  })

  it('extends an in-flight flush to include a newer queued mutation', async () => {
    const firstSave = deferred<void>()
    const secondSave = deferred<void>()
    saveSettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })

    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'queued', delayMs: 250 })

    firstSave.resolve()
    await flushMicrotasks()

    expect(saveSettings).toHaveBeenCalledTimes(2)
    expect(flushed).toBe(false)

    secondSave.resolve()
    await flush
    vi.advanceTimersByTime(250)

    expect(flushed).toBe(true)
    expect(saveSettings).toHaveBeenCalledTimes(2)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
    }))
  })

  it('stops waiting for an obsolete bootstrap after adapter replacement', async () => {
    harness.installation.dispose()
    resetSettingsProjectionForTests()
    const obsoleteLoad = deferred<Settings>()
    harness.installation = installSettingsProjection({
      load: () => obsoleteLoad.promise,
      save: saveSettings,
    })

    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })

    const replacement = installSettingsProjection({
      load: () => baseSettings({ locale: 'de' }),
      save: saveSettings,
    })
    harness.installation = replacement
    await replacement.ready

    await vi.waitFor(() => expect(flushed).toBe(true))
    await flush

    expect(locale.value).toBe('de')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('persists a return to the durable value when an older write is still in flight', async () => {
    let resolveFirstSave!: () => void
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve
    })
    saveSettings
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'en' }, { persist: 'immediate' })

    resolveFirstSave()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }))
  })

  it('retries the latest snapshot after a failed write', async () => {
    const error = new Error('storage unavailable')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveSettings
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
      'Failed to persist settings:',
      error,
    ))

    await flushSettingsProjection()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'fr' }))
    logError.mockRestore()
  })
})
