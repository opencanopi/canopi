import { readFailureCode } from '../../failures/store-read'

export interface LaunchCheckPort {
  get(): Promise<boolean>
  set(on: boolean): Promise<void>
}

/**
 * The port over the host's row, holding a write the store refuses under settings a newer Canopi saved (2.1-Q320,
 * M487) until the app closes, so the About tab reads the user's value again when it remounts.
 */
export function createLaunchCheckPort(get: () => Promise<boolean>, set: (on: boolean) => Promise<void>): LaunchCheckPort {
  let session: boolean | null = null
  return {
    get: () => (session === null ? get() : Promise.resolve(session)),
    set: (on) => set(on).then(() => { session = null }, (error: unknown) => {
      if (readFailureCode(error).kind !== 'store_read_only') throw error
      session = on
    }),
  }
}
