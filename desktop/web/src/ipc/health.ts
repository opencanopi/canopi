import { invoke } from '@tauri-apps/api/core'
import type { SubsystemHealth } from '../types/health'

/** Each store's open status the host reports at start, keyed by store id. */
export async function getHealth(): Promise<SubsystemHealth> {
  return invoke('get_health')
}
