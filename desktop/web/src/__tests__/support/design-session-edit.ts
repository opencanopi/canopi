import { defaultDesignEditAuthority } from '../../app/design-edit/authority-capability'
import type { CanopiFile } from '../../types/design'
import { markTestDesignDirty } from './design-session-state'

export function editDesignSessionForTest(
  _store: unknown,
  projector: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return defaultDesignEditAuthority().editCommitted(projector)
}

export function reconcileDesignSessionForTest(
  _store: unknown,
  projector: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return defaultDesignEditAuthority().reconcileCommitted(projector)
}

export function markDesignSessionDirtyForTest(_store?: unknown): void {
  markTestDesignDirty()
}
