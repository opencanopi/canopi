/**
 * failures/health.ts: Owner of the one store health model (contracts §11, ADR 0025, ADR 0026, 2.1-M417): each store's
 * `StoreOpenStatus` and one-time `StoreNotice`, keyed by `StoreId`. Invariant: it is fed only by the host's boot snapshot
 * (`applyHealthSnapshot`) and by `writeStoreHealth`, the one write entry the TS store adapters use today and a native
 * push will use later (2.1-M431); a store nothing reported is `opening`, never `ready`; readers (the library rows, the
 * plant browser, the notice row, the problem report) read this one signal, so they cannot disagree.
 */
import { signal, type ReadonlySignal } from '@preact/signals'
import type {
  PlantCatalogCause,
  StoreHealth,
  StoreId,
  StoreOpenStatus,
  SubsystemHealth,
} from '../generated/contracts'

const health = signal<SubsystemHealth>({})

const OPENING: StoreOpenStatus = { kind: 'opening' }

/** Every store's entry the host or an adapter reported; a store with no entry is still opening. */
export const storeHealth: ReadonlySignal<SubsystemHealth> = health

/** The boot snapshot (Desktop's `get_health`): each reported store's entry replaces its earlier one. */
export function applyHealthSnapshot(snapshot: SubsystemHealth): void {
  health.value = { ...health.peek(), ...snapshot }
}

/** One store's entry, written by the store's own adapter (a Web record, the settings projection) or a native push. */
export function writeStoreHealth(store: StoreId, entry: StoreHealth): void {
  const current = health.peek()[store]
  if (current && sameEntry(current, entry)) return
  health.value = { ...health.peek(), [store]: entry }
}

/** Clears a store's one-time notice once the user dismissed it; its status stays. */
export function dismissStoreNotice(store: StoreId): void {
  const current = health.peek()[store]
  if (!current || current.notice === null) return
  health.value = { ...health.peek(), [store]: { ...current, notice: null } }
}

/** A store's status as the model holds it: `opening` until its owner reports. Reading it subscribes. */
export function storeStatus(store: StoreId): StoreOpenStatus {
  return health.value[store]?.status ?? OPENING
}

/** Why the plant catalog cannot be read, or null while it opens or once it is ready. Reading it subscribes. */
export function plantCatalogCause(): PlantCatalogCause | null {
  const status = storeStatus('plant_catalog')
  return status.kind === 'unavailable' && status.code.kind === 'plant_db_unavailable' ? status.code.cause : null
}

function sameEntry(left: StoreHealth, right: StoreHealth): boolean {
  return left.notice === right.notice && JSON.stringify(left.status) === JSON.stringify(right.status)
}

/** @testonly */
export function resetStoreHealthForTests(): void {
  health.value = {}
}
