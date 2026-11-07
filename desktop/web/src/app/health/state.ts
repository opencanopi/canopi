import { signal } from '@preact/signals'
import type { LidarLibraryStatus, LocalDataStatus, PlantDbStatus, StoreOpenStatus, SubsystemHealth } from '../../types/health'

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

/** Map the host's StoreId-keyed health onto the three signals; a store the host did not report keeps its value. */
export function applyHostHealth(health: SubsystemHealth): void {
  const plant = health.plant_catalog?.status
  if (plant) plantDbStatus.value = plantDbStatusOf(plant)
  const library = health.library_catalogue?.status
  if (library) lidarLibraryStatus.value = libraryStatusOf(library)
  localDataStatus.value = { kind: health.user_db?.notice === 'moved_aside_pre_2_0' ? 'moved_aside' : 'current' }
}

function plantDbStatusOf(status: StoreOpenStatus): PlantDbStatus {
  if (status.kind === 'ready') return 'available'
  const missing = status.kind === 'unavailable' && status.code.kind === 'plant_db_unavailable' && status.code.cause === 'missing'
  return missing ? 'missing' : 'corrupt'
}

function libraryStatusOf(status: StoreOpenStatus): LidarLibraryStatus {
  switch (status.kind) {
    case 'ready': return { kind: 'ready' }
    case 'recovered': return { kind: 'recovered', items: status.items, generated: status.generated }
    case 'refused_newer': return { kind: 'refused_newer' }
    case 'opening':
    case 'migrating':
    case 'newer_read_only':
    case 'set_aside_damaged':
    case 'unavailable': return { kind: 'unavailable' }
  }
}
