// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserFileDelivery } from '../platform/file-delivery'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
it('dispatches a browser download in the initiating gesture and releases every temporary URL', async () => {
  vi.useFakeTimers()
  const create = vi.fn(() => 'blob:pdf-output'), revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  let observed: HTMLAnchorElement | undefined
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { observed = this })
  const delivery = createBrowserFileDelivery()
  const pending = delivery.deliverFile('pdf', 'Garden', { bytes: new Uint8Array([1, 2]) }, new AbortController().signal)
  expect(observed?.download).toBe('Garden.pdf')
  expect(observed?.isConnected).toBe(false)
  expect(await pending).toBe('downloaded')
  expect(revoke).not.toHaveBeenCalled()
  delivery.dispose?.()
  expect(revoke).toHaveBeenCalledWith('blob:pdf-output')
  expect(vi.getTimerCount()).toBe(0)
})
it('releases the URL and detached anchor when browser download dispatch fails', async () => {
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:failed-output', revokeObjectURL: revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('denied') })
  const delivery = createBrowserFileDelivery()
  await expect(delivery.deliverFile('pdf', 'Garden', { bytes: new Uint8Array([1]) }, new AbortController().signal)).rejects.toThrow('denied')
  expect(revoke).toHaveBeenCalledWith('blob:failed-output')
  expect(document.querySelector('a[download]')).toBeNull()
  delivery.dispose?.()
})
