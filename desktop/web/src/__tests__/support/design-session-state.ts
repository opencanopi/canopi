/**
 * __tests__/support/design-session-state.ts: Real SessionCore-backed test helpers for the
 * read-only `designSessionStore` projection (Blueprint §2, 2b-3).
 */
import { computed } from '@preact/signals'
import { encodeCanopiDesign } from '../../app/contracts/canopi-design-wire'
import { getLiveSessionCore } from '../../app/document-session/live-core'
import {
  designSessionStore,
  type DesignSessionKind,
} from '../../app/document-session/store'
import type { CanopiFile } from '../../types/design'
import { createTestSessionCore, makeTestDesign, type TestSessionCoreHandle } from './session-core-fixture'

export const currentDesign = designSessionStore.currentDesign
export const designPath = designSessionStore.designPath
export const designName = designSessionStore.designName
export const designDirty = designSessionStore.designDirty
export const canvasDirty = computed(() => designSessionStore.designDirty.value)

let activeHandle: TestSessionCoreHandle | null = null

function installHandle(options: Parameters<typeof createTestSessionCore>[0]): TestSessionCoreHandle {
  activeHandle?.dispose()
  activeHandle = createTestSessionCore(options)
  return activeHandle
}

export function replaceCurrentDesignState(
  file: CanopiFile,
  path: string | null = null,
  name: string = file.name || 'Untitled',
  kind?: DesignSessionKind,
): void {
  installHandle({ file, path, name, ...(kind ? { kind } : {}) })
}

export function clearCurrentDesignState(): void {
  installHandle({ file: null })
}

export async function openTestDesign(file: CanopiFile): Promise<void> {
  const core = getLiveSessionCore() ?? installHandle({ file: null }).core
  const normalized = { ...makeTestDesign(), ...file }
  const bytes = new TextEncoder().encode(JSON.stringify(encodeCanopiDesign(normalized)))
  await core.openFrom({ kind: 'bytes', name: file.name || 'Untitled', bytes })
}

export function markTestDesignDirty(): void {
  const core = getLiveSessionCore()
  if (!core) return
  core.recordSceneEdit('test-dirty', {
    type: 'test-dirty',
    before: {},
    after: {},
  })
}

export function resetDirtyBaselines(): void {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!open) return
  installHandle({
    file: open.document as CanopiFile,
    path: open.home.kind === 'file' ? open.home.key : null,
    name: open.document.name,
  })
}

export const designSessionFixture = {
  set file(file: CanopiFile | null) {
    if (!file) {
      clearCurrentDesignState()
      return
    }
    const path = designSessionStore.readDesignPath()
    replaceCurrentDesignState(file, path, file.name || 'Untitled')
  },
  set path(path: string | null) {
    const file = designSessionStore.readCurrentDesign()
    if (!file) return
    replaceCurrentDesignState(file, path, file.name || 'Untitled')
  },
  set name(name: string) {
    const core = getLiveSessionCore()
    if (!core?.currentDesign.peek()) return
    core.document('rename', () => ({ name }))
  },
}
