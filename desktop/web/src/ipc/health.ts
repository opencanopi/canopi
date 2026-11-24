import { invokeTyped, mintOperationId } from './transport'
import type { StoreId, SubsystemHealth } from '../generated/contracts'

/** Each store's open status the host reports at start, keyed by store id. */
export async function getHealth(): Promise<SubsystemHealth> {
  return invokeTyped('get_health', undefined, mintOperationId('s'))
}

/** Tells the host the user dismissed `store`'s one-time notice, so a reload in this app run is not told again. */
export async function dismissStoreNoticeOnHost(store: StoreId): Promise<void> {
  await invokeTyped('dismiss_store_notice', { store }, mintOperationId('u'))
}
