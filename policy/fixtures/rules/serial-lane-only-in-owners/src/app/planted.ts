let tail: Promise<void> = Promise.resolve()
export const enqueue = (run: () => Promise<void>) => { tail = tail.then(run, run) }
