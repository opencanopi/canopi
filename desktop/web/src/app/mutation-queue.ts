/**
 * Serialises a workbench's mutations behind one admission tail so a later
 * command never overtakes an earlier one, and fences each against the
 * lifetime that admitted it: a mutation admitted before `dispose()` (or a
 * lifetime bump) resolves to its `disposedResult` instead of running.
 */
export interface MutationQueue {
  /** The lifetime a mutation is admitted into; bump it to fence older work. */
  readonly lifetime: number
  /** Counts admissions so snapshot readers can tell a stale read from a live one. */
  readonly epoch: number
  /** The pending tail, for readers that must wait behind in-flight mutations. */
  readonly tail: Promise<void> | null
  readonly disposed: boolean
  isCurrent(admittedLifetime: number): boolean
  enqueue<T>(disposedResult: T, operation: (admittedLifetime: number) => Promise<T>): Promise<T>
  bumpLifetime(): void
  bumpEpoch(): void
  dispose(): void
}

export function createMutationQueue(): MutationQueue {
  let disposed = false
  let lifetime = 0
  let epoch = 0
  let tail: Promise<void> | null = null

  function isCurrent(admittedLifetime: number): boolean {
    return !disposed && admittedLifetime === lifetime
  }

  function enqueue<T>(disposedResult: T, operation: (admittedLifetime: number) => Promise<T>): Promise<T> {
    if (disposed) return Promise.resolve(disposedResult)
    epoch += 1
    const admittedLifetime = lifetime
    const run = () => isCurrent(admittedLifetime) ? operation(admittedLifetime) : disposedResult
    const precedingTail = tail
    if (precedingTail) {
      const result = precedingTail.then(run, run)
      const settle = () => {
        if (tail === settledTail) tail = null
      }
      const settledTail: Promise<void> = result.then(settle, settle)
      tail = settledTail
      return result
    }

    let releaseAdmission!: () => void
    const admissionTail = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    tail = admissionTail
    let result: Promise<T>
    try {
      result = Promise.resolve(run())
    } catch (error) {
      result = Promise.reject(error)
    }
    const settleAdmission = () => {
      releaseAdmission()
      if (tail === admissionTail) tail = null
    }
    void result.then(settleAdmission, settleAdmission)
    return result
  }

  return {
    get lifetime() { return lifetime },
    get epoch() { return epoch },
    get tail() { return tail },
    get disposed() { return disposed },
    isCurrent,
    enqueue,
    bumpLifetime: () => { lifetime += 1 },
    bumpEpoch: () => { epoch += 1 },
    dispose: () => {
      if (disposed) return
      disposed = true
      lifetime += 1
      epoch += 1
    },
  }
}
