export type { PlantDbStatus } from '../generated/contracts'

// The Data library and local data signals keep their earlier shapes over the StoreId-keyed health wire until the one
// health model in failures/ replaces app/health/ (Phase 1 1b-c4, 2.1-M417).

/** How the Data library opened, as the library screens read it. */
export type LidarLibraryStatus =
  | { kind: 'ready' }
  | { kind: 'recovered'; items: number; generated: number }
  | { kind: 'refused_newer' }
  | { kind: 'unavailable' }

/** Whether this start renamed a user database from before Canopi 2.0. */
export type LocalDataStatus = { kind: 'current' } | { kind: 'moved_aside' }
