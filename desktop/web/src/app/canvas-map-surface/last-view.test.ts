import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { CanopiFile } from '../../types/design'
import type { Settings } from '../../types/settings'
import { createDesignSessionStoreTestFixture, designSessionStore } from '../document-session/store'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
} from '../settings/projection'
import { lastView } from '../settings/state'
import { persistLastView } from './last-view'

const SHOWN = { name: 'Orchard 2.1' } as unknown as CanopiFile
const VIEW = { lon: 2.3522, lat: 48.8566, zoom: 18.25, bearing: 30 }
const fixture = createDesignSessionStoreTestFixture(designSessionStore)

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
    fixture.reset()
  })

  it('an edited Design\'s settled view is written as the device\'s last view', async () => {
    persistLastView(VIEW)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ last_view: { lon: 2.3522, lat: 48.8566, zoom: 18.25 } }))
  })

  // Design check 5c, 2.1-M478: a valid v>=10 Design writes no byte, the device settings record included.
  it('canopi-f47t.52.270: a read-only Design\'s camera move writes no last view to the settings record', async () => {
    designSessionStore.replaceCurrentDesignState(SHOWN, null, SHOWN.name, {
      kind: 'read-only',
      origin: 'newer-version',
      savedByVersion: 10,
    })
    persistLastView(VIEW)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(save).not.toHaveBeenCalled()
    expect(lastView.value).toBeNull()
  })
})
