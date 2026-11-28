import { describe, expect, it } from 'vitest'
import { createBrowserCanvasRuntimeAppAdapter } from '../editions/web/browser-canvas-runtime'

describe('browser Canvas Runtime composition', () => {
  it('exposes browser-safe presentation without a no-op Saved Object Stamp capability', () => {
    const adapter = createBrowserCanvasRuntimeAppAdapter()

    expect(adapter.presentationData?.plantLabels).toBeDefined()
    expect(adapter.presentationData?.speciesCache).toBeDefined()
    expect(adapter.savedObjectStamps).toBeUndefined()
  })
})
