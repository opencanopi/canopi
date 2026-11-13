// @vitest-environment jsdom

// The tool card's stamp chooser lists a saved stamp a newer Canopi wrote with its note, its option off, and focus starts
// on the first stamp it can place (Step 2.0.4 R2-5, canopi-f47t.52.271; 2.1-M88), over the real stamp workbench.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as WorkbenchModule from '../../app/saved-object-stamps/workbench'
import type * as StampChooserModule from './StampChooser'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'

const V2 = { version: 2, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }
const stamp = (id: string, payload: Record<string, unknown>, sortOrder: number, needsNewer = false): SavedObjectStamp => ({
  id,
  name: id,
  payload_json: JSON.stringify(payload),
  sort_order: sortOrder,
  created_at: `2026-11-0${sortOrder + 1}T00:00:00Z`,
  updated_at: `2026-11-0${sortOrder + 1}T00:00:00Z`,
  needs_newer: needsNewer,
})

describe('the stamp chooser with a saved stamp a newer Canopi wrote (canopi-f47t.52.271)', () => {
  let container: HTMLDivElement
  let arm: Mock<() => boolean>
  let StampChooser: typeof StampChooserModule.StampChooser

  beforeEach(async () => {
    vi.resetModules()
    ;(await import('../../app/settings/state')).locale.value = 'en'
    arm = vi.fn(() => true)
    const listed = [
      stamp('v3', { ...V2, version: 3, guides: [] }, 0, true),
      stamp('v2', V2, 1),
      stamp('v1', { version: 1, plants: [] }, 2),
    ]
    vi.doMock('../../app/saved-object-stamps', async () => {
      const { createSavedObjectStampWorkbench } = await vi.importActual<typeof WorkbenchModule>('../../app/saved-object-stamps/workbench')
      return { savedObjectStampWorkbench: createSavedObjectStampWorkbench({ getSavedObjectStamps: async () => listed, arm }) }
    })
    ;({ StampChooser } = await import('./StampChooser'))
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    vi.doUnmock('../../app/saved-object-stamps')
  })

  it('stamps with a payload newer than v2 list as needing a newer Canopi, never placed', async () => {
    const onChosen = vi.fn()
    await act(async () => { render(<StampChooser onChosen={onChosen} onEscape={() => {}} />, container) })
    await vi.waitFor(() => expect(container.querySelector('[data-stamp-option="v3"]')).not.toBeNull())

    const options = [...container.querySelectorAll<HTMLButtonElement>('[data-stamp-option]')]
    expect(options.map((option) => [option.dataset.stampOption, option.disabled])).toEqual([['v2', false], ['v3', true]])
    expect(options[1]!.textContent).toContain('Saved with a newer Canopi; update Canopi to place it.')
    await act(async () => { options[1]!.click() })
    expect(arm).not.toHaveBeenCalled()
    expect(onChosen).not.toHaveBeenCalled()
  })

  it('canopi-f47t.52.271: focus starts on Copy an object while loading, never on the v3 option once listed', async () => {
    await act(async () => { render(<StampChooser onChosen={() => {}} onEscape={() => {}} />, container) })
    await vi.waitFor(() => expect(container.querySelector('[data-stamp-option="v3"]')).not.toBeNull())

    expect(document.activeElement).not.toBe(container.querySelector('[data-stamp-option="v3"]'))
    expect(document.activeElement?.tagName).toBe('BUTTON')
  })
})
