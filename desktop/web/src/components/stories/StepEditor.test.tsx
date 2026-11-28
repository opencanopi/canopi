// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { StepEditor } from './StepEditor'
import { replaceCurrentDesignState } from '../../__tests__/support/design-session-state'
import type { CanopiFile, StoryStep } from '../../types/design'

const BASE_STEP: StoryStep = {
  id: 's1',
  view_id: 'v1',
  title: 'First step',
  text: [],
  images: [],
}

function makeDesign(images: StoryStep['images']): CanopiFile {
  return {
    version: 9,
    name: 'Meadow',
    site: { center: [0, 0], zoom: 17 },
    plants: [],
    zones: [],
    stories: [{ id: 'story-1', name: 'Walk', steps: [{ ...BASE_STEP, images }] }],
  } as unknown as CanopiFile
}

async function until(predicate: () => boolean, limitMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > limitMs) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('StepEditor image limit copy (#921)', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    render(null, host)
    host.remove()
    replaceCurrentDesignState(makeDesign([]), null, 'Stories')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('formats 1 MiB and 10 MiB limits through formatByteSize in tooLarge and designFull notices', async () => {
    replaceCurrentDesignState(makeDesign([]), null, 'Stories')
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2000, height: 1500, close: vi.fn() })))
    const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', imageSmoothingQuality: 'low' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (done, type) {
      done({ size: 2 * 1024 * 1024, type: type ?? 'image/png' } as Blob)
    })

    await act(async () => {
      render(<StepEditor storyId="story-1" step={BASE_STEP} number={1} view={null} />, host)
    })

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(2 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' })], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await until(() => !!host.querySelector('[role="alert"]')?.textContent)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This image is 2.1 MB. An image can be at most 1 MB; choose a smaller one.',
    )

    // Design already holding ~10.4 MB of images: limit formats as 10.5 MB (10 MiB), not 10 MB.
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    const tenPointFourMb = Array.from({ length: 10 }, () => ({ src: `data:image/png;base64,${'A'.repeat(1_386_668)}`, alt: 'x' }))
    replaceCurrentDesignState(makeDesign(tenPointFourMb), null, 'Stories')
    await act(async () => {
      render(<StepEditor storyId="story-1" step={{ ...BASE_STEP, images: tenPointFourMb }} number={1} view={null} />, host)
    })
    const fullInput = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(fullInput, 'files', { value: [new File([new Uint8Array(200_000)], 'extra.png', { type: 'image/png' })], configurable: true })
    await act(async () => { fullInput.dispatchEvent(new Event('change', { bubbles: true })) })
    await until(() => host.querySelector('[role="alert"]')?.textContent?.includes('10.5 MB') ?? false)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This Design already holds 10.4 MB of images, and a Design can hold 10.5 MB. Remove an image or choose a smaller one.',
    )
  })
})
