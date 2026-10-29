import type { UpdateFailure, UpdateOffer, UpdateOs, UpdateProgress } from '../../generated/contracts'
import type { LocaleKey } from '../../generated/locale-keys'

/**
 * The Desktop updater's state, owned by the frontend (contracts §3, 2.1-M208): the host runs one op at a time and
 * reports each op's result; this machine says what the user sees. Each state carries only its contract payload; the
 * offer a download, install or restart works on is the controller's (app/updates/controller.ts). `installed` is
 * Linux only: the update is on disk and a restart is pending (2.1-Q233).
 */
export type UpdateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'available', readonly offer: UpdateOffer }
  | { readonly kind: 'downloading', readonly progress: UpdateProgress }
  | { readonly kind: 'verified' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'installed' }
  | { readonly kind: 'close_requested' }
  | { readonly kind: 'failed', readonly failure: UpdateFailure }
  | { readonly kind: 'link_only', readonly url: string }

export type UpdateStateKind = UpdateState['kind']

/**
 * The allowed edges, contracts §3 (2.1-M208). Three differ from docs/architecture/states.md's Updater diagram, whose
 * corrected text is handed to main: the link_only probe runs at the start of `update_download`, before any transfer,
 * so link_only follows downloading, never checking; progress moves downloading to downloading; a Windows installer
 * that cannot launch after the close dialog's proceed settles failed with the Design open. Held by the exhaustive
 * transition-table test in __tests__/updater-flow.test.ts.
 */
const EDGES: { readonly [From in UpdateStateKind]: readonly UpdateStateKind[] } = {
  idle: ['checking'],
  checking: ['idle', 'failed', 'available'],
  available: ['downloading'],
  downloading: ['downloading', 'idle', 'failed', 'verified', 'link_only'],
  failed: ['idle'],
  verified: ['installing', 'close_requested'],
  installing: ['installed', 'failed'],
  installed: ['close_requested'],
  close_requested: ['installed', 'verified', 'failed'],
  link_only: [],
}

export const UPDATE_STATE_KINDS = Object.keys(EDGES) as readonly UpdateStateKind[]

export function canTransition(from: UpdateStateKind, to: UpdateStateKind): boolean {
  return EDGES[from].includes(to)
}

/**
 * A failed update's message as locale keys: `key` alone, or "Update not installed: {reason}" (2.1-Q237) with `reason`
 * one of the six reason keys (2.1-Q244). About translates it (`t(key, { reason: t(reason) })`), so app/updates names
 * keys only and adds no cross-area edge to i18n (2.1-M200).
 */
export type UpdateFailureMessage =
  | { readonly key: LocaleKey, readonly reason?: undefined }
  | { readonly key: 'update.failure.notInstalled', readonly reason: LocaleKey }

function notInstalled(reason: LocaleKey): UpdateFailureMessage {
  return { key: 'update.failure.notInstalled', reason }
}

/**
 * What About shows for a failed update, by code: the updater's interim code-to-message map until 1b's one map
 * absorbs it (2.1-Q239, canopi-f47t.52.35). A cancel is silent (null); a check failure is its own line; a failed
 * download or install is "Update not installed" with its reason; an installer Canopi cannot replace gets the
 * link-only line. The six reasons are Linux's (2.1-Q244): a Windows install failure is plain "Update not installed",
 * the same line its next-launch marker shows (2.1-Q234).
 */
export function updateFailureMessage(failure: UpdateFailure, platform: UpdateOs): UpdateFailureMessage | null {
  const { code } = failure
  if (platform === 'windows' && failure.op === 'updater.install' && code.kind !== 'cancelled') {
    return { key: 'update.failure.notInstalledPlain' }
  }
  switch (code.kind) {
    case 'cancelled':
      return null
    case 'update_no_channel_entry':
    case 'update_admin_prompt_unavailable':
      return { key: 'update.linkOnly' }
    case 'update_admin_prompt_dismissed':
      return notInstalled('update.failure.reason.promptClosed')
    case 'update_admin_prompt_refused':
      return notInstalled('update.failure.reason.permissionRefused')
    case 'update_location_not_writable':
      return notInstalled('update.failure.reason.folderNotWritable')
    case 'update_install_failed':
      return notInstalled('update.failure.reason.installerError')
    case 'update_signature_refused':
      return notInstalled('update.failure.reason.notVerified')
    case 'network':
    case 'io':
    case 'invalid':
    case 'busy':
    case 'internal':
      if (failure.op === 'updater.check') {
        return { key: code.kind === 'network' && code.network === 'offline' ? 'update.failure.offline' : 'update.failure.checkFailed' }
      }
      return notInstalled(failure.op === 'updater.download' ? 'update.failure.reason.downloadFailed' : 'update.failure.reason.installerError')
  }
}
