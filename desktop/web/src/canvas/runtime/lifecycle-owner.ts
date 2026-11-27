export interface CanvasRuntimeLifecycleLease {
  release(): Promise<void>
}

interface CanvasRuntimeLifecycleOwner {
  readonly releaseRuntime: () => Promise<void>
  releaseRequested: boolean
  releasePromise: Promise<void> | null
}

let currentOwner: CanvasRuntimeLifecycleOwner | null = null

export class CanvasRuntimeLifecycleBusyError extends Error {
  constructor(message = 'Another Canvas runtime lifecycle is still active') {
    super(message)
    this.name = 'CanvasRuntimeLifecycleBusyError'
  }
}

/**
 * Atomically reserves the Canvas runtime lifecycle for one host. A successor
 * joins an already-requested release before it may reserve the lifecycle.
 */
export async function acquireCanvasRuntimeLifecycle(
  releaseRuntime: () => Promise<void>,
): Promise<CanvasRuntimeLifecycleLease> {
  const previousOwner = currentOwner
  if (previousOwner) {
    if (!previousOwner.releaseRequested) throw new CanvasRuntimeLifecycleBusyError()
    await releaseOwner(previousOwner)
    // Another continuation may reserve the lifecycle while this one is
    // suspended. Re-check rather than allowing two successors to claim it.
    if (currentOwner) throw new CanvasRuntimeLifecycleBusyError()
  }

  const owner: CanvasRuntimeLifecycleOwner = {
    releaseRuntime,
    releaseRequested: false,
    releasePromise: null,
  }
  currentOwner = owner

  return Object.freeze({
    release: () => {
      if (currentOwner !== owner) return Promise.resolve()
      owner.releaseRequested = true
      return releaseOwner(owner)
    },
  })
}

function releaseOwner(owner: CanvasRuntimeLifecycleOwner): Promise<void> {
  if (owner.releasePromise) return owner.releasePromise

  let resolveRelease!: () => void
  let rejectRelease!: (error: unknown) => void
  const releaseResult = new Promise<void>((resolve, reject) => {
    resolveRelease = resolve
    rejectRelease = reject
  })
  // Publish the shared attempt before invoking external cleanup. Its
  // synchronous handoff may reenter acquisition or release.
  owner.releasePromise = releaseResult.then(
    () => {
      if (currentOwner === owner) currentOwner = null
    },
    (error: unknown) => {
      // Keep the requested owner so a later acquire/release can retry it.
      owner.releasePromise = null
      throw error
    },
  )

  try {
    // Invoke the callback now: its handoff/cancellation work must happen
    // before this owner yields to asynchronous teardown.
    void Promise.resolve(owner.releaseRuntime()).then(resolveRelease, rejectRelease)
  } catch (error) {
    rejectRelease(error)
  }
  return owner.releasePromise
}
