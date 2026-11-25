// canvas-host-lifecycle-only-in-canvas-host: a planted site the rule counts.
declare function acquireCanvasRuntimeLifecycle(release: () => Promise<void>): Promise<void>
export const planted = () => acquireCanvasRuntimeLifecycle(async () => {})
