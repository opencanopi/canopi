import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissMultiOpenNotice, installLaunchFile, multiOpenNotice } from './launch-file'

interface LaunchedFile {
  readonly path: string
  readonly several: boolean
}

const openDesignFromPath = vi.hoisted(() => vi.fn(async (_path: string): Promise<void> => undefined))
const presentDesignOpenFailure = vi.hoisted(() => vi.fn((_error: unknown): void => undefined))

vi.mock('./actions', () => ({ openDesignFromPath }))
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
    presentDesignOpenFailure.mockReset()
    multiOpenNotice.value = null
  })

  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it('pulls once at boot and opens a .canopi file through the replacement path', async () => {
    const launch = fakeSource()
    launch.leave({ path: '/designs/Garden.CANOPI', several: false })

    dispose = installLaunchFile(launch.source)

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('/designs/Garden.CANOPI'))
    expect(launch.take).toHaveBeenCalledTimes(1)
    expect(multiOpenNotice.value).toBeNull()
  })

  it('pulls again on each later launch, and an empty slot opens nothing', async () => {
    const launch = fakeSource()
    dispose = installLaunchFile(launch.source)
    await vi.waitFor(() => expect(launch.take).toHaveBeenCalledTimes(1))
    expect(openDesignFromPath).not.toHaveBeenCalled()

    launch.launch({ path: '/designs/orchard.canopi', several: false })

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('/designs/orchard.canopi'))
    expect(launch.take).toHaveBeenCalledTimes(2)
  })

  it('a file that is not a .canopi Design shows the open failure and opens nothing', async () => {
    const launch = fakeSource()
    launch.leave({ path: '/photos/garden.png', several: false })

    dispose = installLaunchFile(launch.source)

    await vi.waitFor(() => expect(presentDesignOpenFailure).toHaveBeenCalledTimes(1))
    expect(openDesignFromPath).not.toHaveBeenCalled()
  })

  it('a launch with several files opens the first and shows the one-at-a-time notice once', async () => {
    const launch = fakeSource()
    let finishOpen: () => void = () => undefined
    openDesignFromPath.mockImplementation(() => new Promise<void>((done) => { finishOpen = done }))
    launch.leave({ path: '/designs/first.canopi', several: true })

    dispose = installLaunchFile(launch.source)

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledWith('/designs/first.canopi'))
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
    launch.leave({ path: '/designs/gone.canopi', several: false })
    dispose = installLaunchFile(launch.source)
    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenCalledTimes(1))

    launch.launch({ path: '/designs/here.canopi', several: false })

    await vi.waitFor(() => expect(openDesignFromPath).toHaveBeenLastCalledWith('/designs/here.canopi'))
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
})
