// @vitest-environment jsdom
// The Desktop boundary's Reload (canopi-f47t.52.36): the exit flush runs first, as a window close runs it, and a failed
// write asks the save question in reload words, not close words. Through the real close guard, save-problem request and
// SaveProblemDialog; continuous save, the settings flush and the reload are the fakes.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveProblemDialog } from '../../components/shared/SaveProblemDialog'
import { t } from '../../i18n'

const mocks = vi.hoisted(() => ({
  flushDesign: vi.fn<() => Promise<boolean>>(),
  flushSettings: vi.fn<() => Promise<void>>(),
}))

vi.mock('../document-session/transition', () => ({
  designContinuousSave: { flush: mocks.flushDesign, conflict: signal(null) },
}))
vi.mock('../settings/projection', () => ({ flushSettingsProjection: mocks.flushSettings }))

import { reloadAfterExitFlush } from './close-guard'

let container: HTMLDivElement

beforeEach(() => {
  mocks.flushDesign.mockReset().mockResolvedValue(true)
  mocks.flushSettings.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve() })
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button, [role="dialog"] button')]
  .map((button) => button.textContent)
const press = (label: string) => act(async () => {
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!.click()
})

describe('the Desktop boundary Reload', () => {
  it('canopi-f47t.52.36: reload with a failed flush: reload wording, Cancel keeps the app', async () => {
    mocks.flushDesign.mockResolvedValue(false)
    const reload = vi.fn()
    await act(async () => render(<SaveProblemDialog />, container))
    reloadAfterExitFlush(reload)
    await settle()

    expect(container.textContent).toContain(t('saveProblem.flushFailedAppReloadMessage'))
    expect(buttons()).toEqual([t('saveProblem.retry'), t('saveProblem.discardAndReload'), t('canvas.file.cancel')])
    expect(container.textContent).not.toContain(t('saveProblem.closeWithoutSaving'))

    await press(t('canvas.file.cancel'))
    await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(mocks.flushSettings).not.toHaveBeenCalled()
  })

  it('canopi-f47t.52.36: a failed settings write before a reload offers Reload anyway, which reloads', async () => {
    mocks.flushSettings.mockRejectedValue(new Error('settings unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    await act(async () => render(<SaveProblemDialog />, container))
    reloadAfterExitFlush(reload)
    await settle()

    // No Design is open, so none is called saved.
    expect(container.textContent).toContain(t('saveProblem.settingsFailedDesignUnsavedReloadMessage'))
    expect(buttons()).toEqual([t('saveProblem.retry'), t('saveProblem.settingsReloadAnyway'), t('canvas.file.cancel')])

    await press(t('saveProblem.settingsReloadAnyway'))
    await settle()
    expect(reload).toHaveBeenCalledOnce()
    vi.mocked(console.error).mockRestore()
  })

  it('reloads without asking once the Design and the settings are written', async () => {
    const reload = vi.fn()
    await act(async () => render(<SaveProblemDialog />, container))
    reloadAfterExitFlush(reload)
    await settle()
    expect(reload).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull()
  })
})
