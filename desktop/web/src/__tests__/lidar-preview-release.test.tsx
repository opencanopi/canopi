// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const display = await import('../app/data-library/display')
const { libraryItems } = await import('../app/data-library/library-items')
const { librarySnapshot, sourceItem } = await import('./support/library-fixtures')
const { LibraryPreview } = await import('../components/panels/lidar/LibraryPreview')

describe('Data library preview', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    render(null, container)
    container.remove()
    display.disposeLidarDisplayDescriptors()
    vi.useRealTimers()
  })

  it('an unmounted preview whose display call fails is never asked again', async () => {
    invoke.mockRejectedValue(new Error('catalogue: database disk image is malformed'))
    const [item] = libraryItems(librarySnapshot([sourceItem('lyr-1', 'Orchard terrain')]))
    await act(async () => { render(<LibraryPreview item={item!} client={null} width={64} height={48} />, container) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(invoke).toHaveBeenCalled()
    await act(async () => { render(null, container) })
    invoke.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(invoke).not.toHaveBeenCalled()
  })
})
