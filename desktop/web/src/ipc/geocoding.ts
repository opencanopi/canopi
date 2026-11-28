import { invokeTyped, mintOperationId } from './transport'

export async function geocoderFetch(url: string): Promise<string> {
  return invokeTyped('geocoder_fetch', { url }, mintOperationId('u'))
}
