import { invoke } from '@tauri-apps/api/core'
import type { SubsystemHealth } from '../types/health'

/** The plant database, LiDAR library and local data status the host reports at start. */
export async function getHealth(): Promise<SubsystemHealth> {
  return invoke('get_health')
}
