import { designEditAuthorityCapabilityForTests } from '../../app/design-edit/authority-capability'
import type { DesignSessionStore } from '../../app/document-session/store'
import type { CanopiFile } from '../../types/design'

// Test-only access to the private Design Edit role of an isolated session store.
// Production callers must use the intent-shaped app/design-edit surface.
export function editDesignSessionForTest(
  store: DesignSessionStore,
  projector: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return designEditAuthorityCapabilityForTests(store).editCommitted(projector)
}

export function reconcileDesignSessionForTest(
  store: DesignSessionStore,
  projector: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return designEditAuthorityCapabilityForTests(store).reconcileCommitted(projector)
}

export function markDesignSessionDirtyForTest(store: DesignSessionStore): void {
  designEditAuthorityCapabilityForTests(store).markCommittedDirty()
}
