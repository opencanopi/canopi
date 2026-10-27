import { signal } from '@preact/signals'
import { openDesignFromPath } from './actions'
import { presentDesignOpenFailure } from './open-failure'

/**
 * The Design file a launch asked Canopi to open (2.1-M214, M85, Q145): the host keeps it in one pending-open slot; this
 * module pulls the slot once at boot and again whenever a later launch says it left a file, and opens it through
 * Recent Designs' path (`openDesignFromPath`), behind the replacement guard that flushes the current Design first and
 * asks Retry, Discard changes or Cancel only when that fails (2.1-Q166). The source comes from the Desktop bootstrap
 * (`platform/desktop.ts`), so this module reaches no native API; the Web has no launch arguments. 2b moves the pull
 * onto `launchIntent()` and `openFrom(source)`.
 */
export interface LaunchedFile {
  readonly path: string
  /** The launch named several files; only this first one opens (2.1-Q228). */
  readonly several: boolean
}

export interface LaunchFileSource {
  /** Takes the pending launch file, once. */
  take(): Promise<LaunchedFile | null>
  /** Calls `onPending` when a later launch leaves a file; returns the unsubscribe. */
  subscribe(onPending: () => void): () => void
}

/** The one-at-a-time notice (2.1-Q228): the id of the launch it answers, null when hidden. */
export const multiOpenNotice = signal<number | null>(null)

let nextNoticeId = 1

export function dismissMultiOpenNotice(id: number): void {
  if (multiOpenNotice.value === id) multiOpenNotice.value = null
}

const DESIGN_FILE = /\.canopi$/i

/** Starts pulling launch files from `source`; returns the dispose. */
export function installLaunchFile(source: LaunchFileSource): () => void {
  let disposed = false
  let pulls: Promise<void> = Promise.resolve()
  const pull = () => {
    pulls = pulls.then(async () => {
      if (disposed) return
      const launched = await source.take()
      if (!disposed && launched) await openLaunchedFile(launched)
    }).catch((error: unknown) => {
      console.error('The launch file could not be taken:', error)
    })
  }
  const unsubscribe = source.subscribe(pull)
  pull()
  return () => {
    disposed = true
    unsubscribe()
  }
}

async function openLaunchedFile({ path, several }: LaunchedFile): Promise<void> {
  if (several) multiOpenNotice.value = nextNoticeId++
  if (!DESIGN_FILE.test(path)) {
    presentDesignOpenFailure(new Error('a launch file that is not a .canopi Design'))
    return
  }
  try {
    await openDesignFromPath(path)
  } catch {
    // The open path has already shown the failure to the user.
  }
}
