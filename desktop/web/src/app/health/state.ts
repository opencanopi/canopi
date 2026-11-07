import { signal } from '@preact/signals'
import type { LidarLibraryStatus, LocalDataStatus, PlantDbStatus } from '../../types/health'

/** Plant DB subsystem health — queried from Rust on startup. */
export const plantDbStatus = signal<PlantDbStatus>('available')

/**
 * How the Data library opened — queried with the plant DB. `refused_newer` and
 * `unavailable` mean the library is empty and read-only for this session.
 */
export const lidarLibraryStatus = signal<LidarLibraryStatus>({ kind: 'ready' })

/**
 * Whether this start found local data from before Canopi 2.0 (ADR 0021): the
 * native side reports `moved_aside` on the start that renamed the 1.x user
 * database only; dismissing the notice sets it back to `current` for the
 * session.
 */
export const localDataStatus = signal<LocalDataStatus>({ kind: 'current' })
