import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The Design file a launch asked Canopi to open (`host::launch::PendingOpen`, 2.1-M214): an absolute path, and whether
 * the launch named several files, of which only this first one opens (2.1-Q228).
 */
export interface PendingOpen {
  readonly path: string
  readonly several: boolean
}

/** The event a later launch with a file emits; it carries nothing, the slot is pulled. */
const PENDING_OPEN_EVENT = 'launch:pending-open'

/** Takes the pending launch file, once: the pull empties the slot. */
export async function takePendingOpen(): Promise<PendingOpen | null> {
  return invoke('take_pending_open')
}

/** Calls `onPending` each time a later launch leaves a file in the slot; returns the unsubscribe. */
export function subscribePendingOpen(onPending: () => void): () => void {
  const listening = listen(PENDING_OPEN_EVENT, () => onPending())
  return () => {
    void listening.then((unlisten) => unlisten())
  }
}
