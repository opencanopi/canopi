import { invokeTyped, mintOperationId } from './transport'
import type { GeoResult } from '../generated/contracts'

export type { GeoResult }

export async function geocodeAddress(query: string): Promise<GeoResult[]> {
  return invokeTyped('geocode_address', { query }, mintOperationId('u'))
}
