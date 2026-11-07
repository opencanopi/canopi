import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../types/settings'
import { flushSettingsProjection, installSettingsProjection, mutateSettingsProjection } from './projection'

describe('settings projection load failures', () => {
  let dispose: (() => void) | null = null

  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it.fails('[1b-c4 canopi-f47t.52.40] SET-05: a transient load failure never overwrites the stored record', async () => {
    const save = vi.fn(async (_settings: Settings) => undefined)
    const installation = installSettingsProjection({
      load: async () => { throw new Error('database is locked') },
      save,
    })
    dispose = installation.dispose
    await installation.ready.catch(() => undefined)

    // The stored record could not be read: the session's change stays in the session, never written over it.
    mutateSettingsProjection((draft) => { draft.snapToGrid = !draft.snapToGrid })
    await flushSettingsProjection().catch(() => undefined)

    expect(save).not.toHaveBeenCalled()
  })
})
