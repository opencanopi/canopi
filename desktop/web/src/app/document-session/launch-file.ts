import { signal } from '@preact/signals'
import type { LastOpenHome } from '../../generated/contracts'
import { openDesignDraft, openDesignFromPath } from './actions'
import { presentDesignOpenFailure } from './open-failure'

/**
 * Launch intent and openFrom coordinator (2b-4; contracts §4, 2.1-Q127, 2.1-Q145, 2.1-Q166,
 * 2.1-M85, 2.1-M214, A27).
 *
 * - Boot resolves `launchIntent()`: a file argument takes precedence over `last_open_home`
 *   (settings row added by 2e-1 per A27); if neither exists, boot stays on the start screen.
 * - A last-open home that was deleted or is unreadable at launch clears `last_open_home` and
 *   returns to the start screen without showing a launch refusal (contracts §4).
 * - A second-instance launch forwards its file through `openFrom`, which flushes any unsaved
 *   edit first and opens without asking (asking Retry / Discard changes / Cancel only if the
 *   flush fails; 2.1-Q166).
 */
interface LaunchedFile {
  readonly path: string
  /** The launch named several files; only this first one opens (2.1-Q228). */
  readonly several: boolean
}

/** Source resolved by `launchIntent()` or forwarded by a second instance. */
type LaunchIntent =
  | { readonly kind: 'file'; readonly path: string; readonly several: boolean }
  | { readonly kind: 'last_open'; readonly home: LastOpenHome }

/** Consumer seam for the `last_open_home` settings row (wired to 2e-1's settings row per A27). */
export interface LastOpenHomePort {
  read(): Promise<LastOpenHome | null>
  clear(): Promise<void>
  resolveFilePath?(recentId: string): Promise<string | null>
}

interface LaunchFileSource {
  /** Takes the pending launch file, once. */
  take(): Promise<LaunchedFile | null>
  /** Calls `onPending` when a later launch leaves a file; returns the unsubscribe. */
  subscribe(onPending: () => void): () => void
  /** Optional `last_open_home` consumer seam (wired once 2e-1 lands the settings row, A27). */
  readonly lastOpenHome?: LastOpenHomePort
}

/** The one-at-a-time notice (2.1-Q228): the id of the launch it answers, null when hidden. */
export const multiOpenNotice = signal<number | null>(null)

let nextNoticeId = 1

export function dismissMultiOpenNotice(id: number): void {
  if (multiOpenNotice.value === id) multiOpenNotice.value = null
}

const DESIGN_FILE = /\.canopi$/i

/**
 * Resolves the boot launch intent (2.1-Q127, 2.1-M85):
 * 1. A pending file argument wins over `last_open_home`.
 * 2. Otherwise `last_open_home` is read from the settings consumer seam.
 * 3. Otherwise `null` (show the start screen).
 */
async function launchIntent(source: Pick<LaunchFileSource, 'take' | 'lastOpenHome'>): Promise<LaunchIntent | null> {
  const launched = await source.take()
  if (launched) {
    return { kind: 'file', path: launched.path, several: launched.several }
  }
  if (!source.lastOpenHome) return null
  const lastHome = await source.lastOpenHome.read()
  return lastHome ? { kind: 'last_open', home: lastHome } : null
}

/**
 * Opens a resolved `LaunchIntent` through the shared replacement path (`openDesignFromPath` /
 * `openDesignDraft`), which flushes any unsaved edit first and opens without asking (2.1-Q166).
 *
 * A `last_open` home that was deleted or cannot be opened clears `last_open_home` and falls
 * back quietly to the start screen (contracts §4).
 */
async function openFrom(
  intent: LaunchIntent,
  lastOpenHome?: LastOpenHomePort,
): Promise<boolean> {
  if (intent.kind === 'file') {
    if (intent.several) multiOpenNotice.value = nextNoticeId++
    if (!DESIGN_FILE.test(intent.path)) {
      presentDesignOpenFailure(new Error('a launch file that is not a .canopi Design'))
      return false
    }
    try {
      await openDesignFromPath(intent.path)
      return true
    } catch {
      // The open path has already shown the failure to the user.
      return false
    }
  }

  // Reopening `last_open_home`: missing or unreadable falls back quietly to the start screen.
  try {
    if (intent.home.kind === 'draft') {
      await openDesignDraft(intent.home.id)
      return true
    }
    const resolvedPath = lastOpenHome?.resolveFilePath
      ? await lastOpenHome.resolveFilePath(intent.home.recent_id)
      : null
    if (!resolvedPath) {
      await lastOpenHome?.clear()
      return false
    }
    await openDesignFromPath(resolvedPath)
    return true
  } catch {
    // Reopening last_open_home falls back quietly to the start screen when missing or unreadable.
    await lastOpenHome?.clear()
    return false
  }
}

/** Starts pulling launch intents at boot and forwarded files from `source`; returns the dispose. */
export function installLaunchFile(source: LaunchFileSource): () => void {
  let disposed = false
  let pulls: Promise<void> = Promise.resolve()

  const enqueue = (run: () => Promise<void>) => {
    pulls = pulls.then(async () => {
      if (!disposed) await run()
    }).catch((error: unknown) => {
      console.error('The launch file could not be taken:', error)
    })
  }

  // Subsequent forwarded launches open only the pending file argument via `openFrom`.
  const pullForwarded = () => {
    enqueue(async () => {
      const launched = await source.take()
      if (!disposed && launched) {
        await openFrom({ kind: 'file', path: launched.path, several: launched.several }, source.lastOpenHome)
      }
    })
  }

  const unsubscribe = source.subscribe(pullForwarded)

  // Initial boot pull resolves full `launchIntent()` (file arg > last_open_home > start screen).
  enqueue(async () => {
    const intent = await launchIntent(source)
    if (!disposed && intent) {
      await openFrom(intent, source.lastOpenHome)
    }
  })

  return () => {
    disposed = true
    unsubscribe()
  }
}
