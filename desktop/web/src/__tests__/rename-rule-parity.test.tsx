// @vitest-environment jsdom
//
// 2.1-Q87 & 2.1-Q360: one rename rule and inline rename field across editions.
// Enter and click-away keep the new name, Escape cancels, and a refused rename
// keeps the field open with the error while preserving the typed name.

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignNameField } from '../components/shared/DesignNameField'
import { normaliseObjectName } from '../utils/object-name'

const container = document.createElement('div')

afterEach(() => {
  render(null, container)
  container.remove()
})

describe('shared rename rule and inline field (2.1-Q87, 2.1-Q360)', () => {
  it('normaliseObjectName trims whitespace, collapses line breaks, and rejects empty names', () => {
    expect(normaliseObjectName('  South\nOrchard  ')).toEqual({ ok: true, name: 'South Orchard' })
    expect(normaliseObjectName('   \t\n ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('click-away keeps the new name and Escape cancels without calling onRename (2.1-Q87)', async () => {
    document.body.appendChild(container)
    const onRename = vi.fn()
    await act(async () => {
      render(<DesignNameField name="North field" onRename={onRename} />, container)
    })

    await act(async () => { container.querySelector('button')!.click() })
    const input = container.querySelector('input')!
    input.value = '  South   field '
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(onRename).toHaveBeenCalledWith('South   field')

    onRename.mockClear()
    await act(async () => { container.querySelector('button')!.click() })
    const secondInput = container.querySelector('input')!
    secondInput.value = 'Discarded name'
    await act(async () => { secondInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onRename).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeNull()
  })

  it('reopens/keeps the field open with the error and typed name when a rename is refused (2.1-Q360)', async () => {
    document.body.appendChild(container)
    const onRename = vi.fn(() => ({ error: 'Name is already taken' }))
    await act(async () => {
      render(<DesignNameField name="Orchard" onRename={onRename} />, container)
    })

    await act(async () => { container.querySelector('button')!.click() })
    const input = container.querySelector('input')!
    input.value = 'Duplicate name'
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(onRename).toHaveBeenCalledWith('Duplicate name')
    const reopened = container.querySelector('input')
    expect(reopened).not.toBeNull()
    expect(reopened!.value).toBe('Duplicate name')
    expect(reopened!.getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Name is already taken')
  })
})
