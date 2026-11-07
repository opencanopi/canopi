import { invokeCommand } from './transport'
import type { GeoResult } from '../generated/contracts'

export type { GeoResult }

export async function geocodeAddress(query: string): Promise<GeoResult[]> {
  return invokeCommand('geocode_address', { query })
}
