/**
 * failures/messages.ts: Owner of the one code-to-message map (contracts §2, 2.1-M413). Invariant: every generated
 * failure kind has one rule, silent or a locale key, so a new catalogue code fails typecheck until it has one; a rule
 * may refine by the code's own sub-kind, the dotted op and the edition. Wording says what happened and what to do,
 * never a code (2.1-Q299); an unexpected fault reads the generic message (2.1-Q289).
 */
import type { FailureCode, IoFailureKind, NetworkFailureKind } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'

export type FailurePlatform = 'desktop' | 'web'

type Kind = FailureCode['kind']
type CodeOf<K extends Kind> = Extract<FailureCode, { kind: K }>

/** Recorded in the ring and the report, never told (a cancel, or a map failure until 2d's map status). */
const SILENT = { silent: true } as const

type MessageRule<K extends Kind> =
  | typeof SILENT
  | LocaleKey
  | ((code: CodeOf<K>, op: string, platform: FailurePlatform) => LocaleKey)

const IO_MESSAGES = {
  not_found: 'failure.fileNotFound',
  permission_denied: 'failure.permissionDenied',
  read_only: 'failure.readOnly',
  no_space: 'failure.diskFull',
  too_large: 'failure.fileTooLarge',
  other: 'failure.fileError',
} as const satisfies Record<IoFailureKind, LocaleKey>

const NETWORK_MESSAGES = {
  timeout: 'failure.connection',
  offline: 'failure.connection',
  status: 'failure.serverError',
  host_not_allowed: 'failure.addressRefused',
  too_large: 'failure.downloadTooLarge',
} as const satisfies Record<NetworkFailureKind, LocaleKey>

const MESSAGE_BY_CODE: { readonly [K in Kind]: MessageRule<K> } = {
  busy: 'failure.busy',
  cancelled: SILENT,
  unavailable: 'failure.internal',
  panicked: 'failure.internal',
  join_failed: 'failure.internal',
  // A second file dialog brings the open one forward (2.1-Q284).
  dialog_already_open: SILENT,
  plant_db_unavailable: 'failure.plantCatalogUnavailable',
  library_read_only: (code) => code.reason === 'refused_newer' ? 'failure.libraryNewer' : 'failure.libraryUnavailable',
  // A browser has no disk of its own to free: its storage is the device's.
  io: (code, _op, platform) => code.io === 'no_space' && platform === 'web' ? 'failure.storageFull' : IO_MESSAGES[code.io],
  network: (code) => NETWORK_MESSAGES[code.network],
  invalid: 'failure.internal',
  internal: 'failure.internal',
  // Recorded only until 2d's map status (2.1-Q300).
  style_failed: SILENT,
  tile_source_failed: SILENT,
}

// Any one rule, its code widened: the mapped type above already tied each rule to its own kind.
type WidenedRule = typeof SILENT | LocaleKey | ((code: FailureCode, op: string, platform: FailurePlatform) => LocaleKey)

/** The locale key that tells a failure on this edition, or null when its code is silent. */
export function failureMessage(code: FailureCode, op: string, platform: FailurePlatform): LocaleKey | null {
  const rule = MESSAGE_BY_CODE[code.kind] as WidenedRule
  if (typeof rule === 'object') return null
  return typeof rule === 'string' ? rule : rule(code, op, platform)
}
