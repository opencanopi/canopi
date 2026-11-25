import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftId, LastOpenHome } from '../../generated/contracts'
import {
  dismissMultiOpenNotice,
  installLaunchFile,
  multiOpenNotice,
} from './launch-file'

interface LaunchedFile {
  readonly path: string
  readonly several: boolean
  readonly grant?: string
  readonly display_name?: string
  readonly recent_id?: string
}

const openDesignFromPath = vi.hoisted(() => vi.fn(async (_grant: string, _options?: Record<string, unknown>): Promise<void> => undefined))
const openDesignDraft = vi.hoisted(() => vi.fn(async (_id: string): Promise<void> => undefined))
const presentDesignOpenFailure = vi.hoisted(() => vi.fn((_error: unknown): void => undefined))

vi.mock('./actions', () => ({ openDesignFromPath, openDesignDraft }))
vi.mock('./open-failure', () => ({ presentDesignOpenFailure }))

/** A launch source the test fills: each pull takes what the next launch left, as the host's slot does. */
function fakeSource() {
  const pending: (LaunchedFile | null)[] = []
  let onPending: (() => void) | null = null
  const take = vi.fn(async () => pending.shift() ?? null)
  return {
    source: {
      take,
      subscribe: vi.fn((next: () => void) => {
        onPending = next
        return () => {
          onPending = null
        }
      }),
    },
    take,
    leave(file: LaunchedFile | null) {
      pending.push(file)
    },
    launch(file: LaunchedFile) {
      pending.push(file)
      onPending?.()
    },
    get subscribed() {
      return onPending !== null
    },
  }
}

describe('the launch file (canopi-f47t.52.228.14)', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    openDesignFromPath.mockReset()
    openDesignFromPath.mockResolvedValue(undefined)
    openDesignDraft.mockReset()
    openDesignDraft.mockResolvedValue(undefined)
    presentDesignOpenFailure.mockReset()
    multiOpenNotice.value = null
  })

  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it('pulls once at boot and opens a .canopi file with its host grant, displayName, and recentId', async () => {
    const launch = fakeSource()
    launch.leave({
      path: '/designs/Garden.CANOPI',
      several: false,
      grant: 'grant:1',
      display_name: 'Garden.CANOPI',
      recent_id: 'rid-garden',
    })

    dispose = installLaunchFile(launch.source)

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('grant:1', {
      grant: 'grant:1',
      displayName: 'Garden.CANOPI',
      recentId: 'rid-garden',
    }))
    expect(launch.take).toHaveBeenCalledTimes(1)
    expect(multiOpenNotice.value).toBeNull()
  })

  it('pulls again on each second-instance launch with grant and recentId, and an empty slot opens nothing', async () => {
    const launch = fakeSource()
    dispose = installLaunchFile(launch.source)
    await vi.waitFor(() => expect(launch.take).toHaveBeenCalledTimes(1))
    expect(openDesignFromPath).not.toHaveBeenCalled()

    launch.launch({
      path: '/designs/orchard.canopi',
      several: false,
      grant: 'grant:2',
      display_name: 'orchard.canopi',
      recent_id: 'rid-orchard',
    })

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('grant:2', {
      grant: 'grant:2',
      displayName: 'orchard.canopi',
      recentId: 'rid-orchard',
    }))
    expect(launch.take).toHaveBeenCalledTimes(2)
  })

  it('a file that is not a .canopi Design shows the open failure and opens nothing', async () => {
    const launch = fakeSource()
    launch.leave({ path: '/photos/garden.png', several: false, grant: 'grant:99' })

    dispose = installLaunchFile(launch.source)

    await vi.waitFor(() => expect(presentDesignOpenFailure).toHaveBeenCalledTimes(1))
    expect(openDesignFromPath).not.toHaveBeenCalled()
  })

  it('a launch with several files opens the first and shows the one-at-a-time notice once', async () => {
    const launch = fakeSource()
    let finishOpen: () => void = () => undefined
    openDesignFromPath.mockImplementation(() => new Promise<void>((done) => { finishOpen = done }))
    launch.leave({ path: '/designs/first.canopi', several: true, grant: 'grant:3', display_name: 'first.canopi' })

    dispose = installLaunchFile(launch.source)

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('grant:3', {
      grant: 'grant:3',
      displayName: 'first.canopi',
    }))
    const shown = multiOpenNotice.value
    expect(shown).not.toBeNull()
    finishOpen()
    await vi.waitFor(() => expect(launch.take).toHaveBeenCalledTimes(1))
    expect(multiOpenNotice.value).toBe(shown)

    dismissMultiOpenNotice(shown!)
    expect(multiOpenNotice.value).toBeNull()
  })

  it('a failed open, already shown by the open path, leaves the next launch working', async () => {
    const launch = fakeSource()
    openDesignFromPath.mockRejectedValueOnce(new Error('missing'))
    launch.leave({ path: '/designs/gone.canopi', several: false, grant: 'grant:4' })
    dispose = installLaunchFile(launch.source)
    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledTimes(1))

    launch.launch({ path: '/designs/here.canopi', several: false, grant: 'grant:5' })

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenLastCalledWith('grant:5', { grant: 'grant:5' }))
    expect(presentDesignOpenFailure).not.toHaveBeenCalled()
  })

  it('stops listening when disposed', async () => {
    const launch = fakeSource()
    dispose = installLaunchFile(launch.source)
    expect(launch.subscribed).toBe(true)

    dispose()
    dispose = null

    expect(launch.subscribed).toBe(false)
  })

  it('a Design open at quit reopens at launch via resolveFileHome (2.1-Q127, 2b-4)', async () => {
    const launch = fakeSource()
    const lastHome: LastOpenHome = { kind: 'file', recent_id: 'recent-42' }
    const lastOpenHome = {
      read: vi.fn(async () => lastHome),
      clear: vi.fn(async () => undefined),
      resolveFileHome: vi.fn(async (id: string) =>
        id === 'recent-42' ? { grant: 'grant:42', displayName: 'reopened.canopi', recentId: 'recent-42' } : null,
      ),
    }

    dispose = installLaunchFile({ ...launch.source, lastOpenHome })

    await vi.waitFor(() =>
      expect(openDesignFromPath).toHaveBeenCalledWith('grant:42', {
        presentFailure: false,
        grant: 'grant:42',
        displayName: 'reopened.canopi',
        recentId: 'recent-42',
      }),
    )
    expect(lastOpenHome.clear).not.toHaveBeenCalled()
  })

  it('a deleted last Design shows the start screen and clears last_open_home (2.1-Q127, 2b-4)', async () => {
    const launch = fakeSource()
    openDesignFromPath.mockRejectedValueOnce(new Error('not found'))
    const clear = vi.fn(async () => undefined)
    const lastOpenHome = {
      read: vi.fn(async (): Promise<LastOpenHome | null> => ({ kind: 'file', recent_id: 'recent-deleted' })),
      clear,
      resolveFileHome: vi.fn(async () => ({ grant: 'grant:del', displayName: 'deleted.canopi', recentId: 'recent-deleted' })),
    }

    dispose = installLaunchFile({ ...launch.source, lastOpenHome })

    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
    expect(presentDesignOpenFailure).not.toHaveBeenCalled()
  })

  it('a launch with a file opens it, not the last Design (2.1-M85, 2b-4)', async () => {
    const launch = fakeSource()
    launch.leave({ path: '/designs/arg.canopi', several: false, grant: 'grant:7', display_name: 'arg.canopi' })
    const read = vi.fn(async (): Promise<LastOpenHome | null> => ({ kind: 'draft', id: 'draft-last' as DraftId }))
    const lastOpenHome = { read, clear: vi.fn(async () => undefined), resolveFileHome: vi.fn(async () => null) }

    dispose = installLaunchFile({ ...launch.source, lastOpenHome })

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('grant:7', {
      grant: 'grant:7',
      displayName: 'arg.canopi',
    }))
    expect(read).not.toHaveBeenCalled()
    expect(openDesignDraft).not.toHaveBeenCalled()
  })

  it('closing a Design and then quitting shows the start screen at launch (2.1-Q127, 2b-4)', async () => {
    const launch = fakeSource()
    const read = vi.fn(async (): Promise<LastOpenHome | null> => null)
    const lastOpenHome = { read, clear: vi.fn(async () => undefined), resolveFileHome: vi.fn(async () => null) }

    dispose = installLaunchFile({ ...launch.source, lastOpenHome })

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(openDesignFromPath).not.toHaveBeenCalled()
    expect(openDesignDraft).not.toHaveBeenCalled()
  })

  it('opening a file during an unsaved edit saves it first and opens without asking (2.1-Q166, 2b-4)', async () => {
    const launch = fakeSource()
    const order: string[] = []
    openDesignFromPath.mockImplementationOnce(async (grant: string) => {
      order.push('flush-unsaved-edit')
      order.push(`open:${grant}`)
    })
    dispose = installLaunchFile(launch.source)
    await vi.waitFor(() => expect(launch.take).toHaveBeenCalledTimes(1))

    launch.launch({ path: '/designs/second.canopi', several: false, grant: 'grant:8' })

    await vi.waitFor(() => expect(order).toEqual(['flush-unsaved-edit', 'open:grant:8']))
  })
})
