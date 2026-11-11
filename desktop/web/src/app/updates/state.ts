import type { UpdaterFailure, UpdateOffer, UpdateProgress } from '../../generated/contracts'

/**
 * The Desktop updater's state, owned by the frontend (contracts §3, 2.1-M208): the host runs one op at a time and
 * reports each op's result; this machine says what the user sees. Each state carries only its contract payload; the
 * offer a download, install or restart works on is the controller's (app/updates/controller.ts). `installed` is
 * Linux only: the update is on disk and a restart is pending (2.1-Q233).
 */
export type UpdateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'available', readonly offer: UpdateOffer }
  | { readonly kind: 'downloading', readonly progress: UpdateProgress }
  | { readonly kind: 'verified' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'installed' }
  | { readonly kind: 'close_requested' }
  | { readonly kind: 'failed', readonly failure: UpdaterFailure }
  | { readonly kind: 'link_only', readonly url: string }

export type UpdateStateKind = UpdateState['kind']

/**
 * The allowed edges, contracts §3 (2.1-M208), as docs/architecture/states.md's Updater diagram draws them: the
 * link_only probe runs at the start of `update_download`, so link_only follows downloading, never checking; a Windows
 * installer that cannot launch after the close dialog's proceed settles failed with the Design open; 2.1-Q252's Retry
 * downloads the same offer again. Held by the exhaustive transition-table test in ./state.test.ts.
 */
const EDGES: { readonly [From in UpdateStateKind]: readonly UpdateStateKind[] } = {
  idle: ['checking'],
  checking: ['idle', 'failed', 'available'],
  available: ['downloading'],
  downloading: ['downloading', 'idle', 'failed', 'verified', 'link_only'],
  failed: ['idle', 'downloading'],
  verified: ['installing', 'close_requested'],
  installing: ['installed', 'failed'],
  installed: ['close_requested'],
  close_requested: ['installed', 'verified', 'failed'],
  link_only: [],
}

export function canTransition(from: UpdateStateKind, to: UpdateStateKind): boolean {
  return EDGES[from].includes(to)
}

/**
 * Whether About offers Retry: a failed download whose failure allows it (`user_may_retry`, contracts §2), on Linux
 * and Windows alike (2.1-Q252). Retry downloads the same offer again; any other failure offers Check for updates.
 */
export function offersRetry(state: UpdateState): boolean {
  return state.kind === 'failed' && state.failure.op === 'updater.download' && state.failure.user_may_retry
}
