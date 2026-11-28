/**
 * platform/app-lifecycle.ts: L1 app-lifecycle port feeding the Session core
 * (ADR 0024, contracts §4, §22, 2.1-M63, 2.1-M98, Q40).
 */

type ReleaseWaitingSource = 'manifest' | 'service-worker' | 'kill-switch' | 'store-newer'

export type LifecycleEvent =
  | { readonly kind: 'close-requested'; readonly done?: (promise: Promise<void>) => void }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'focus-lost' }
  | { readonly kind: 'shown'; readonly persisted: boolean }
  | { readonly kind: 'store-version-change' }
  | { readonly kind: 'release-waiting'; readonly source: ReleaseWaitingSource }

export interface AppLifecyclePort {
  /** Subscribes to edition lifecycle events; returns an unsubscribe callback. */
  subscribe(listener: (event: LifecycleEvent) => void): () => void
  /** Destroys the Desktop window on the closing-to-idle edge (no-op on Web/Gallery). */
  destroyWindow?(): Promise<void> | void
  /** Applies a waiting Web release after the Session core finishes flushing (2.1-M98). */
  applyRelease?(): Promise<void> | void
}
