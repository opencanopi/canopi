// @vitest-environment jsdom
// The Desktop boundary's Reload (canopi-f47t.52.36): the exit flush runs first, as a window close runs it, and a failed
// write asks the save question in reload words, not close words. Through the real SessionCore, close guard,
// save-problem request and SaveProblemDialog.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestSessionCore, type TestSessionCoreHandle } from '../../__tests__/support/session-core-fixture'
import { SaveProblemDialog } from '../../components/shared/SaveProblemDialog'
import type { Failure } from '../../generated/contracts'
import { t } from '../../i18n'
import type { CanopiFile } from '../../types/design'
import { answerSaveProblem, saveProblem } from '../document-session/save-problem'
import { registerCloseGuard, reloadAfterExitFlush, type CloseGuardLifetime } from './close-guard'

const WRITE_FAILURE: Failure = {
  code: { kind: 'io', detail: 'other' },
  user_may_retry: true,
  op: 'design.write',
  operation: null,
  detail: null,
} as unknown as Failure

function sampleDesign(): CanopiFile {
  return {
    version: 10,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    extra: {},
  }
}

let container: HTMLDivElement
let session: TestSessionCoreHandle | null = null
let guard: CloseGuardLifetime | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  guard?.dispose()
  guard = null
  if (saveProblem.peek()) answerSaveProblem('cancel')
  session?.dispose()
  session = null
  render(null, container)
  container.remove()
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button, [role="dialog"] button')]
  .map((button) => button.textContent)
const press = (label: string) => act(async () => {
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!.click()
})

describe('the Desktop boundary Reload', () => {
  it('canopi-f47t.52.36: reload with a failed flush: reload wording, Cancel keeps the app', async () => {
    const flushSettings = vi.fn(async () => {})
    session = createTestSessionCore({ file: sampleDesign(), path: '/orchard.canopi', flushSettings })
    guard = registerCloseGuard()
    session.core.document('rename', () => ({ name: 'Unsaveable' }))
    session.home.setWriteResult({ kind: 'failed', failure: WRITE_FAILURE })

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
    expect(flushSettings).not.toHaveBeenCalled()
  })

  it('canopi-f47t.52.36: a failed settings write before a reload offers Reload anyway, which reloads', async () => {
    const flushSettings = vi.fn().mockRejectedValue(new Error('settings unavailable'))
    session = createTestSessionCore({ file: sampleDesign(), path: '/orchard.canopi', flushSettings })
    guard = registerCloseGuard()

    const reload = vi.fn()
    await act(async () => render(<SaveProblemDialog />, container))
    reloadAfterExitFlush(reload)
    await settle()

    expect(buttons()).toEqual([t('saveProblem.retry'), t('saveProblem.settingsReloadAnyway'), t('canvas.file.cancel')])

    await press(t('saveProblem.settingsReloadAnyway'))
    await settle()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads without asking once the Design and the settings are written', async () => {
    const flushSettings = vi.fn(async () => {})
    session = createTestSessionCore({ file: sampleDesign(), path: '/orchard.canopi', flushSettings })
    guard = registerCloseGuard()
    session.core.document('rename', () => ({ name: 'Saved' }))

    const reload = vi.fn()
    await act(async () => render(<SaveProblemDialog />, container))
    reloadAfterExitFlush(reload)
    await settle()
    expect(reload).toHaveBeenCalledOnce()
    expect(flushSettings).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull()
  })
})
