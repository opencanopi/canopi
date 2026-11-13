import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { Settings } from '../../types/settings'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
} from '../settings/projection'
import { lastView } from '../settings/state'
import { persistLastView } from './last-view'

const VIEW = { lon: 2.3522, lat: 48.8566, zoom: 18.25, bearing: 30 }

// The read-only rule (no settled view reported over a read-only Design) is the workspace composition's:
// workspace-runtime-composition.test.ts.
describe('last view', () => {
  const save = vi.fn<(settings: Settings) => Promise<void>>()

  beforeEach(() => {
    vi.useFakeTimers()
    save.mockReset().mockResolvedValue(undefined)
    installSettingsProjection({ load: () => ({ ...DEFAULT_SETTINGS }), save })
  })

  afterEach(() => {
    resetSettingsProjectionForTests()
    vi.useRealTimers()
    lastView.value = null
  })

  it('an edited Design\'s settled view is written as the device\'s last view', async () => {
    persistLastView(VIEW)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ last_view: { lon: 2.3522, lat: 48.8566, zoom: 18.25 } }))
  })
})
