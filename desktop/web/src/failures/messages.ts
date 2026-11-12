/**
 * failures/messages.ts: the one code-to-message map (contracts §2, 2.1-M413). Invariant: every generated
 * failure kind has one rule, silent or a locale key, so a new catalogue code fails typecheck until it has one; a rule
 * may refine by the code's own sub-kind, the dotted op and the edition's capabilities (ADR 0030: never the edition). Wording says what happened and what to do,
 * never a code (2.1-Q299); an unexpected fault reads the generic message (2.1-Q289).
 */
import type { FailureCode, IoFailureKind, NetworkFailureKind, UpdaterFailure, UpdateOs } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'

/** What a message may depend on in the running edition, set by its platform adapter. */
export interface FailureCapabilities {
  /** Where user data lives: a disk the user can free, or storage the browser holds on the device. */
  readonly storage: 'disk' | 'device'
}

type Kind = FailureCode['kind']
type CodeOf<K extends Kind> = Extract<FailureCode, { kind: K }>

/**
 * Recorded in the ring and the report, never told (a cancel, a map failure until 2d's map status, a write a
 * newer-read-only store refused).
 */
const SILENT = { silent: true } as const

type MessageRule<K extends Kind> =
  | typeof SILENT
  | LocaleKey
  | ((code: CodeOf<K>, op: string, capabilities: FailureCapabilities) => LocaleKey)

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

type UpdateKind = Extract<Kind, `update_${string}`>

/**
 * Each updater code's wording (contracts §2 updater row): the link-only line for an installer Canopi cannot replace,
 * or the reason About gives after "Update not installed" on Linux (2.1-Q239, Q244). A notice reads the plain line.
 */
const UPDATE_REASONS = {
  update_no_channel_entry: 'linkOnly',
  update_admin_prompt_unavailable: 'linkOnly',
  update_admin_prompt_dismissed: 'update.failure.reason.promptClosed',
  update_admin_prompt_refused: 'update.failure.reason.permissionRefused',
  update_location_not_writable: 'update.failure.reason.folderNotWritable',
  update_install_failed: 'update.failure.reason.installerError',
  update_signature_refused: 'update.failure.reason.notVerified',
} as const satisfies Record<UpdateKind, 'linkOnly' | LocaleKey>

const UPDATE_MESSAGES = Object.fromEntries(Object.entries(UPDATE_REASONS).map(([kind, reason]) => (
  [kind, reason === 'linkOnly' ? 'update.linkOnly' : 'update.failure.notInstalledPlain']
))) as { readonly [K in UpdateKind]: LocaleKey }

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
  // Browser storage is freed on the device, not on a disk.
  io: (code, _op, { storage }) => code.io === 'no_space' && storage === 'device' ? 'failure.storageFull' : IO_MESSAGES[code.io],
  network: (code) => NETWORK_MESSAGES[code.network],
  invalid: 'failure.internal',
  internal: 'failure.internal',
  // Recorded only until 2d's map status (2.1-Q300).
  style_failed: SILENT,
  tile_source_failed: SILENT,
  ...UPDATE_MESSAGES,
  // The format core's worker (ADR 0025): its notice names the part that opens Designs, never a file.
  format_core_unavailable: 'failure.formatCoreUnavailable',
  format_core_trapped: 'failure.formatCoreTrapped',
  // The store's one newer-read-only notice already says changes are not saved (2.1-M487, 2.1-Q319).
  store_read_only: SILENT,
}

// Any one rule, its code widened: the mapped type above already tied each rule to its own kind.
type WidenedRule = typeof SILENT | LocaleKey | ((code: FailureCode, op: string, capabilities: FailureCapabilities) => LocaleKey)

/** The locale key that tells a failure with these capabilities, or null when its code is silent. */
export function failureMessage(code: FailureCode, op: string, capabilities: FailureCapabilities): LocaleKey | null {
  const rule = MESSAGE_BY_CODE[code.kind] as WidenedRule
  if (typeof rule === 'object') return null
  return typeof rule === 'string' ? rule : rule(code, op, capabilities)
}

/**
 * A failed update's message as locale keys: `key` alone, or "Update not installed: {reason}" (2.1-Q237) with `reason`
 * one of the six reason keys (2.1-Q244). About translates it (`t(key, { reason: t(reason) })`).
 */
export type UpdateFailureMessage =
  | { readonly key: LocaleKey, readonly reason?: undefined }
  | { readonly key: 'update.failure.notInstalled', readonly reason: LocaleKey }

function isUpdateKind(kind: Kind): kind is UpdateKind {
  return Object.hasOwn(UPDATE_REASONS, kind)
}

/**
 * What About shows for a failed update, from the same rules as every other failure. A silent code (a cancel) is null;
 * a check failure is its own line; a failed download or install is "Update not installed" with its reason; an
 * installer Canopi cannot replace gets the link-only line. The reasons are Linux's (2.1-Q244): a Windows install
 * failure is plain "Update not installed", the line its next-launch marker shows (2.1-Q234).
 */
export function updateFailureMessage(failure: UpdaterFailure, platform: UpdateOs): UpdateFailureMessage | null {
  const { code, op } = failure
  if (typeof MESSAGE_BY_CODE[code.kind] === 'object') return null
  const reason = isUpdateKind(code.kind) ? UPDATE_REASONS[code.kind] : null
  if (reason === 'linkOnly') return { key: 'update.linkOnly' }
  if (platform === 'windows' && op === 'updater.install') return { key: 'update.failure.notInstalledPlain' }
  if (reason !== null) return { key: 'update.failure.notInstalled', reason }
  if (op === 'updater.check') {
    return { key: code.kind === 'network' && code.network === 'offline' ? 'update.failure.offline' : 'update.failure.checkFailed' }
  }
  const byOp = op === 'updater.download' ? 'update.failure.reason.downloadFailed' : 'update.failure.reason.installerError'
  return { key: 'update.failure.notInstalled', reason: byOp }
}
