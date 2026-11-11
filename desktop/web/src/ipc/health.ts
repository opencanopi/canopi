import { invokeCommand } from './transport'
import type { StoreId, SubsystemHealth } from '../generated/contracts'

/** Each store's open status the host reports at start, keyed by store id. */
export async function getHealth(): Promise<SubsystemHealth> {
  return invokeCommand('get_health')
}

/** Tells the host the user dismissed `store`'s one-time notice, so a reload in this app run is not told again. */
export async function dismissStoreNoticeOnHost(store: StoreId): Promise<void> {
  await invokeCommand('dismiss_store_notice', { store })
}
