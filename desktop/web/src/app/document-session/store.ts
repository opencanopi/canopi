/**
 * app/document-session/store.ts: Read-only reactive projection of the active Session Core
 * (C5, ADR 0024, contracts §4, 2b-3). Every writer lives in `app/document-session/core/`.
 */
import { computed, type ReadonlySignal } from '@preact/signals'
import type { CanopiFile } from '../../types/design'
import { activeSessionCore } from './live-core'

/**
 * What the open Design Session may do (2.1-M478, design check F3). `editing` writes every change to its home;
 * `read-only` shows a Design a newer Canopi saved (`origin: 'newer-version'`, its format `savedByVersion`), or a Web
 * Draft opened while 2.1's Draft listing could not be read (`origin: 'storage-unchecked'`, 2.1-Q334).
 */
export type DesignSessionKind =
  | { readonly kind: 'editing' }
  | { readonly kind: 'read-only'; readonly origin: 'newer-version'; readonly savedByVersion: number }
  | { readonly kind: 'read-only'; readonly origin: 'storage-unchecked' }

export const EDITING_DESIGN_SESSION: DesignSessionKind = Object.freeze({ kind: 'editing' })

/** Why a session is read-only, which its save status popover says (2.1-Q336); undefined while editing. */
export type ReadOnlyOrigin = Extract<DesignSessionKind, { kind: 'read-only' }>['origin']
export function readOnlyOrigin(kind: DesignSessionKind): ReadOnlyOrigin | undefined {
  return kind.kind === 'read-only' ? kind.origin : undefined
}

/**
 * Whether a session read-only from `origin` shows a newer Canopi's read view, never the user's file: no save, Draft,
 * export or problem report encodes it (2.1-M479, canopi-v4kj). A storage-unchecked Draft is the user's own, read whole.
 */
function isNewerReadView(origin: ReadOnlyOrigin | undefined): boolean {
  return origin === 'newer-version'
}

export interface DesignSessionIdentity {
  readonly file: Readonly<CanopiFile> | null
  readonly path: string | null
  readonly name: string
}

export interface DesignSessionStore {
  readonly sessionIdentity: ReadonlySignal<object>
  readonly currentDesign: ReadonlySignal<Readonly<CanopiFile> | null>
  readonly designPath: ReadonlySignal<string | null>
  readonly designName: ReadonlySignal<string>
  readonly sessionKind: ReadonlySignal<DesignSessionKind>
  readonly designDirty: ReadonlySignal<boolean>

  readIdentity(): DesignSessionIdentity
  readCurrentDesign(): Readonly<CanopiFile> | null
  readDesignPath(): string | null
  readDesignName(): string
  hasCurrentDesign(): boolean
  isReadOnly(): boolean
  holdsNewerReadView(): boolean
  isDesignDirty(): boolean
}

const IDLE_IDENTITY = Object.freeze({})

const openDesign = computed(() => activeSessionCore.value?.currentDesign.value ?? null)

export const sessionIdentity: ReadonlySignal<object> = computed(
  () => openDesign.value?.scope ?? IDLE_IDENTITY,
)

export const currentDesign: ReadonlySignal<Readonly<CanopiFile> | null> = computed(() => {
  const open = openDesign.value
  if (!open) return null
  const fields = open.scene.fields as Record<string, unknown>
  if (Object.keys(fields).length === 0) return open.document as Readonly<CanopiFile>
  return { ...(open.document as Record<string, unknown>), ...fields } as Readonly<CanopiFile>
})

export const designPath: ReadonlySignal<string | null> = computed(() => {
  const open = openDesign.value
  return open && open.home.kind === 'file' ? open.home.key : null
})

export const designRecentId: ReadonlySignal<string | null> = computed(() => {
  const open = openDesign.value
  return open && open.home.kind === 'file' ? (open.home.recentId ?? null) : null
})

export const designName: ReadonlySignal<string> = computed(() => {
  const open = openDesign.value
  if (!open) return ''
  return open.document.name || (open.home.kind === 'file' ? open.home.displayName : 'Untitled')
})

export const sessionKind: ReadonlySignal<DesignSessionKind> = computed(() => {
  const open = openDesign.value
  if (!open || !open.readOnly) return EDITING_DESIGN_SESSION
  if (open.savedByVersion !== null) {
    return { kind: 'read-only', origin: 'newer-version', savedByVersion: open.savedByVersion }
  }
  return { kind: 'read-only', origin: 'storage-unchecked' }
})

export const designDirty: ReadonlySignal<boolean> = computed(
  () => activeSessionCore.value?.dirty.value ?? false,
)

export const designSessionStore: DesignSessionStore = {
  sessionIdentity,
  currentDesign,
  designPath,
  designName,
  sessionKind,
  designDirty,
  readIdentity() {
    return {
      file: currentDesign.peek(),
      path: designPath.peek(),
      name: designName.peek(),
    }
  },
  readCurrentDesign() {
    return currentDesign.peek()
  },
  readDesignPath() {
    return designPath.peek()
  },
  readDesignName() {
    return designName.peek()
  },
  hasCurrentDesign() {
    return openDesign.peek() !== null
  },
  isReadOnly() {
    return sessionKind.peek().kind === 'read-only'
  },
  holdsNewerReadView() {
    return isNewerReadView(readOnlyOrigin(sessionKind.value))
  },
  isDesignDirty() {
    return designDirty.peek()
  },
}
