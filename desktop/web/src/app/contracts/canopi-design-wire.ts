import { KNOWN_CANOPI_KEYS } from '../../generated/known-canopi-keys'
import type { CanopiFile } from '../../types/design'

const KNOWN_CANOPI_KEY_SET = new Set<string>(KNOWN_CANOPI_KEYS)

/** Encode the normalized in-memory Design shape as canonical `.canopi` JSON. */
export function encodeCanopiDesign(
  file: CanopiFile | { readonly version: number; readonly name: string; readonly extra?: unknown },
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}

  if (file.extra && typeof file.extra === 'object' && !Array.isArray(file.extra)) {
    for (const [key, value] of Object.entries(file.extra)) {
      if (!KNOWN_CANOPI_KEY_SET.has(key)) defineJsonProperty(wire, key, value)
    }
  }

  const record = file as unknown as Record<string, unknown>
  for (const key of KNOWN_CANOPI_KEYS) {
    if (key === 'extra' || !Object.prototype.hasOwnProperty.call(record, key)) continue
    defineJsonProperty(wire, key, record[key])
  }

  return wire
}

function defineJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}
