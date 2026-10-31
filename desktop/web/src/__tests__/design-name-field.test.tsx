// @vitest-environment jsdom

// canopi-f47t.52.228.20: the title bar's Design name field took focus after paint (Preact 11 useEffect) once the button
// it replaced had gone, so an Esc pressed as the field first showed was heard by nobody and the rename stayed open.
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignNameField } from '../components/shared/DesignNameField'
import { t } from '../i18n'
import { beforePaint, holdAfterPaint } from './support/before-paint'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

describe('Design name field', () => {
  it('canopi-f47t.52.228.20: the field has focus as it appears, and an Esc at once cancels the rename', async () => {
    const onRename = vi.fn()
    render(<DesignNameField name="Orchard" onRename={onRename} />, container)
    await beforePaint()
    const release = holdAfterPaint()
    try {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await beforePaint()
      const field = container.querySelector<HTMLInputElement>('input')!
      expect(field.getAttribute('aria-label')).toBe(t('titleBar.designNameInput'))
      expect(document.activeElement, 'the field has focus as it first shows').toBe(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await beforePaint()
      expect(container.querySelector('input'), 'Esc ended the rename').toBeNull()
      expect(onRename).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  // A value set and Enter pressed in the same task (a synthetic commit, as the macOS probe's, or an IME's) reach the
  // field before Preact renders the typed draft, so Enter must commit what the field holds, not the last render's draft.
  it('canopi-f47t.52.228.15: a name typed and Enter pressed in the same task renames the Design', async () => {
    const onRename = vi.fn()
    render(<DesignNameField name="Probe garden" onRename={onRename} />, container)
    await beforePaint()
    container.querySelector<HTMLButtonElement>('button')!.click()
    await beforePaint()
    const field = container.querySelector<HTMLInputElement>('input')!
    field.value = 'Probed garden'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Probed garden')
  })
})
