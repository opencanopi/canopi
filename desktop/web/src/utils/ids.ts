// utils/ids.ts
// Owner of the generic id minters (ids-only-in-minters, ADR 0024; §18 F17). Invariant: ids
// are minted only by their minters; transport sequence numbers are never exported.

import type { OperationId } from '../generated/contracts'

let fallbackCounter = 0

/** Mints a branded `OperationId` (`u-<uuidv4>` or `s-<uuidv4>`, 2.1-M411, canopi-f47t.52.70). */
export function mintOperationId(origin: 'u' | 's' = 'u'): OperationId {
  return `${origin}-${createUuid()}` as OperationId
}

export function createUuid(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    fillPseudoRandomBytes(bytes)
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return formatUuid(bytes)
}

function fillPseudoRandomBytes(bytes: Uint8Array): void {
  const counter = fallbackCounter++
  const now = Date.now()
  for (let i = 0; i < 16; i += 1) bytes[i] = (Math.random() * 256) | 0
  for (let i = 0; i < 8; i += 1) bytes[i]! ^= Math.floor(now / 256 ** i) & 255
  for (let i = 0; i < 4; i += 1) bytes[8 + i]! ^= Math.floor(counter / 256 ** i) & 255
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
