import { invokeCommand } from './transport'
import type { SubsystemHealth } from '../types/health'

/** Each store's open status the host reports at start, keyed by store id. */
export async function getHealth(): Promise<SubsystemHealth> {
  return invokeCommand('get_health')
}
