// surface-or-map-state-only-in-host-and-lifetime: a planted site the rule counts.
type CanvasSurfaceState = { readonly kind: 'idle' }
declare function signal<T>(initial: T): { value: T }
export const planted = signal<CanvasSurfaceState>({ kind: 'idle' })
