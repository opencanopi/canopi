import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from './clipboard'

describe('writeClipboardText', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('delegates to navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await writeClipboardText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('returns a rejected promise when navigator.clipboard.writeText throws synchronously', async () => {
    const writeText = vi.fn(() => {
      throw new Error('denied')
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await expect(writeClipboardText('hello')).rejects.toThrow('denied')
  })
})
