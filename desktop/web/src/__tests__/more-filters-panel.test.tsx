// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import { createTestSpeciesCatalogWorkbench } from './support/species-catalog-workbench'
import type * as MoreFiltersPanelModule from '../components/plant-db/MoreFiltersPanel'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantBrowserModule from '../app/plant-browser'

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('MoreFiltersPanel outside-click behavior', () => {
  let container: HTMLDivElement
  let MoreFiltersPanel: typeof MoreFiltersPanelModule.MoreFiltersPanel
  let locale: typeof SettingsStateModule.locale
  let workbench: SpeciesCatalogWorkbench
  let dynamicOptionsFailure: Error | null

  beforeEach(async () => {
    vi.resetModules()
    const settings = await import('../app/settings/state')
    locale = settings.locale
    locale.value = 'en'
    dynamicOptionsFailure = null
    workbench = await createTestSpeciesCatalogWorkbench({
      locale,
      loadDynamicFilterOptions: async (fields) => {
        if (dynamicOptionsFailure) throw dynamicOptionsFailure
        return fields.map((field) => ({
        field,
        field_type: 'numeric',
        values: null,
        range: [1, 13],
        }))
      },
    })
    vi.doMock('../app/plant-browser', async () => {
      const actual = await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser')
      return {
        ...actual,
        speciesCatalogWorkbench: workbench,
      }
    })
    ;({ MoreFiltersPanel } = await import('../components/plant-db/MoreFiltersPanel'))

    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    workbench.clearFilters()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    workbench.dispose()
    vi.doUnmock('../app/plant-browser')
  })

  it('stays open when interacting with an overlay-preserving control outside the panel', async () => {
    const onClose = vi.fn()
    const preserveTarget = document.createElement('button')
    preserveTarget.setAttribute('data-preserve-overlays', 'true')
    document.body.appendChild(preserveTarget)

    await act(async () => {
      render(<MoreFiltersPanel open onClose={onClose} />, container)
      await flushEffects()
    })

    await act(async () => {
      preserveTarget.dispatchEvent(new Event('pointerup', { bubbles: true }))
      await flushEffects()
    })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on ordinary outside clicks', async () => {
    const onClose = vi.fn()

    await act(async () => {
      render(<MoreFiltersPanel open onClose={onClose} />, container)
      await flushEffects()
    })

    await act(async () => {
      document.dispatchEvent(new Event('pointerup'))
      await flushEffects()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses integer slider steps for hardiness filters', async () => {
    await workbench.loadDynamicOptions(['hardiness_zone_min'])

    await act(async () => {
      render(<MoreFiltersPanel open onClose={vi.fn()} />, container)
      await flushEffects()
    })

    const climateButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Climate & soil'))
    expect(climateButton).toBeTruthy()

    await act(async () => {
      climateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    const hardinessButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Hardiness zone min'))
    expect(hardinessButton).toBeTruthy()

    await act(async () => {
      hardinessButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })

    const rangeInputs = Array.from(container.querySelectorAll('input[type="range"]'))
    expect(rangeInputs).toHaveLength(2)
    expect(rangeInputs.every((input) => (input as HTMLInputElement).step === '1')).toBe(true)
  })

  it('a filter whose options cannot load says the plant catalog could not load, with Retry, never the raw error (canopi-etzh)', async () => {
    const diagnostics = await import('../app/problem-report/diagnostics')
    diagnostics.resetFrontendDiagnosticsForTests()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    dynamicOptionsFailure = new SyntaxError('JSON.parse: unexpected character at line 1 column 1 of the JSON data')
    try {
      await act(async () => {
        render(<MoreFiltersPanel open onClose={vi.fn()} />, container)
        await flushEffects()
      })
      const button = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!
      await act(async () => {
        button('Climate & soil').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await flushEffects()
      })
      await act(async () => {
        button('Hardiness zone min').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await flushEffects()
        await flushEffects()
      })

      await vi.waitFor(async () => {
        await act(flushEffects)
        expect(container.textContent).toContain('The plant catalog couldn’t load.')
      })
      expect(container.textContent).not.toContain('JSON.parse')
      expect(diagnostics.recentFrontendDiagnostics().map((entry) => [entry.source, entry.message]))
        .toEqual([['plant-catalog', expect.stringContaining('JSON.parse')]])
      expect(consoleError).not.toHaveBeenCalled()

      dynamicOptionsFailure = null
      await act(async () => {
        button('Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await flushEffects()
        await flushEffects()
      })
      await vi.waitFor(async () => {
        await act(flushEffects)
        expect(container.querySelectorAll('input[type="range"]')).toHaveLength(2)
      })
      expect(container.textContent).not.toContain('The plant catalog couldn’t load.')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('leaves Esc to the tool while it waits hidden under a phone tool\'s options, and takes it again once they close', async () => {
    const { PhoneSheet } = await import('../components/shared/PhoneSheet')
    const { phoneToolOptions } = await import('../app/shell/phone-layout')
    const { navigateTo, sidePanel } = await import('../app/shell/state')
    const { ESCAPE_PRIORITY, registerEscapeLayer, runEscape } = await import('../app/keyboard/escape-chain')
    const onClose = vi.fn()
    const leaveTool = vi.fn(() => true)
    const disposeTool = registerEscapeLayer({ priority: ESCAPE_PRIORITY.tool, isActive: () => true, escape: leaveTool })
    const escape = () => runEscape({ event: { key: 'Escape', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, focus: 'map' } as Parameters<typeof runEscape>[0])
    sidePanel.value = 'plant-db'
    phoneToolOptions.value = null
    function Catalog() {
      return (
        <PhoneSheet
          layout="portrait"
          tabs={[{ panel: 'plant-db', id: 'panel.plant-db', label: 'Catalog', disabled: false, active: sidePanel.value === 'plant-db', action: () => navigateTo('plant-db') }]}
          options={<p data-tool-options-content />}
        >
          <MoreFiltersPanel open onClose={onClose} />
        </PhoneSheet>
      )
    }

    try {
      await act(async () => {
        render(<Catalog />, container)
        await flushEffects()
      })
      // A tool armed from the keyboard: its options show in front of the catalog, whose More filters stays open under them.
      await act(async () => { phoneToolOptions.value = 'half' })
      expect(container.querySelector<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true)
      escape()
      expect(onClose, 'the hidden More filters does not take the Esc').not.toHaveBeenCalled()
      expect(leaveTool, 'the Esc leaves the tool').toHaveBeenCalledTimes(1)

      await act(async () => { phoneToolOptions.value = null })
      escape()
      expect(onClose, 'shown again, More filters takes the Esc').toHaveBeenCalledTimes(1)
      expect(leaveTool).toHaveBeenCalledTimes(1)
    } finally {
      disposeTool()
      sidePanel.value = null
      phoneToolOptions.value = null
    }
  })
})
