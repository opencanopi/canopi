/**
 * failures/health-presentation.ts: the one store health presentation (contracts §2 and §11, design check F3):
 * each `StoreOpenStatus` kind and each `StoreNotice` maps to one rule, silent or a tone, a locale key and its actions,
 * so a new kind fails typecheck until it has one (`every_health_status_has_one_message`). Invariant: a store's notice on
 * the row is keyed by its StoreId and whole state (code and file included), so it is raised once per state, a store read
 * as newer-read-only naming itself (2.1-Q319); a file name is the set-aside file's name only, never
 * a path (2.1-Q285); an action an edition lacks (Report a problem, Update) is left out, never drawn dead.
 */
import type { FailureCode, StoreHealth, StoreId, StoreNotice, StoreOpenStatus } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'
import type { NoticeSpec } from './notices'
import type { ReportOrigin } from './report'

type Kind = StoreOpenStatus['kind']
type StatusOf<K extends Kind> = Extract<StoreOpenStatus, { kind: K }>

/** An action a store notice may offer beside Dismiss. */
type HealthAction = 'retry' | 'report' | 'update'

/** What one store state tells the user on the notice row. */
interface StoreMessage {
  readonly tone: 'info' | 'warning' | 'error'
  readonly message: LocaleKey
  readonly params?: Readonly<Record<string, string>>
  readonly title?: LocaleKey
  readonly actions: readonly HealthAction[]
}

/** Shown where the store is used, or not at all (opening, migrating, ready; a rebuilt library is told in the library). */
const SILENT = { silent: true } as const

type StatusRule<K extends Kind> = typeof SILENT | ((store: StoreId, status: StatusOf<K>) => StoreMessage | typeof SILENT)

const SET_ASIDE: { readonly [S in StoreId]?: LocaleKey } = {
  user_db: 'health.setAside.userDb',
  web_drafts: 'health.setAside.webDrafts',
  web_species_lists: 'health.setAside.webSpeciesLists',
}

const WRITES_REFUSED: { readonly [S in StoreId]?: LocaleKey } = {
  web_drafts: 'health.writesRefused.webDrafts',
  web_species_lists: 'health.writesRefused.webSpeciesLists',
}

/**
 * Each store read as newer-read-only names itself in its one notice (2.1-Q319); the plant catalog and Web Drafts never
 * read so (Web Drafts stay ready, their IndexedDB rows read-only, 2.1-M486) and keep the plain sentence.
 */
const NEWER_READ_ONLY: { readonly [S in StoreId]?: LocaleKey } = {
  user_db: 'health.newerReadOnlyStore.userDb',
  settings: 'health.newerReadOnlyStore.settings',
  library_catalogue: 'health.newerReadOnlyStore.libraryCatalogue',
  web_species_lists: 'health.newerReadOnlyStore.webSpeciesLists',
}

const error = (message: LocaleKey, actions: readonly HealthAction[] = []): StoreMessage => ({ tone: 'error', message, actions })

function unavailableMessage(store: StoreId, status: StatusOf<'unavailable'>): StoreMessage {
  const { code } = status
  if (code.kind === 'plant_db_unavailable') {
    return error(code.cause === 'missing' ? 'health.plantDbMissing' : 'health.plantDbCorrupt')
  }
  if (store === 'library_catalogue') return error('canvas.lidar.library.unavailable')
  // Settings could not be read: defaults for the session, the saved record left untouched (2.1-Q295).
  if (store === 'settings') return error('health.settingsUnavailable', ['retry', 'report'])
  const refused = WRITES_REFUSED[store]
  if (refused) return error(refused, ['report'])
  return error('health.storeUnavailable', ['report'])
}

const MESSAGE_BY_STATUS: { readonly [K in Kind]: StatusRule<K> } = {
  opening: SILENT,
  migrating: SILENT,
  ready: SILENT,
  // The Data library says it was rebuilt itself, beside the items Retry prepares again.
  recovered: SILENT,
  newer_read_only: (store) => ({ tone: 'warning', message: NEWER_READ_ONLY[store] ?? 'health.newerReadOnly', actions: ['update'] }),
  refused_newer: (store) => error(store === 'library_catalogue' ? 'canvas.lidar.library.refusedNewer' : 'health.refusedNewer', ['update']),
  set_aside_damaged: (store, status) => ({
    tone: 'warning',
    message: SET_ASIDE[store] ?? 'health.setAside.userDb',
    params: { file: fileName(status.file) },
    actions: ['report'],
  }),
  unavailable: unavailableMessage,
}

const MESSAGE_BY_NOTICE: { readonly [N in StoreNotice]: StoreMessage } = {
  moved_aside_pre_2_0: {
    tone: 'info',
    title: 'health.localDataNotOpenedTitle',
    message: 'health.localDataNotOpened',
    actions: [],
  },
  fields_reset: { tone: 'info', message: 'health.fieldsReset', actions: [] },
  write_failed: { tone: 'error', message: 'health.writeFailed', actions: ['report'] },
}

// Any one rule, its status widened: the mapped type above already tied each rule to its own kind.
type WidenedRule = typeof SILENT | ((store: StoreId, status: StoreOpenStatus) => StoreMessage | typeof SILENT)

/** What a store's status tells the user on the notice row, or null when it is silent there. */
function storeMessage(store: StoreId, status: StoreOpenStatus): StoreMessage | null {
  const rule = MESSAGE_BY_STATUS[status.kind] as WidenedRule
  if (typeof rule === 'object') return null
  const message = rule(store, status)
  return 'silent' in message ? null : message
}

/** A store's Try again: its run, and whether one runs, while which the action reads busy and takes no click. */
export interface StoreRetry {
  run(): void
  running(): boolean
}

/** The handlers an edition offers for a store notice's actions; one it lacks is null and its button is left out. */
export interface HealthActions {
  readonly retry?: StoreRetry | null
  /** Opens the problem report from the store's state, which the report lists first. */
  readonly report: ((origin: ReportOrigin) => void) | null
  readonly update: (() => void) | null
  /** Called when the user dismisses the store's one-time notice. */
  readonly dismissNotice: () => void
}

const ACTION_LABEL: Record<HealthAction, LocaleKey> = {
  retry: 'boundary.tryAgain',
  report: 'boundary.reportProblem',
  update: 'health.update',
}

/** The row notices one store's entry raises: its status's, then its one-time notice's, each keyed by store and state. */
export function noticeForStore(store: StoreId, entry: StoreHealth, actions: HealthActions): NoticeSpec[] {
  const out: NoticeSpec[] = []
  const status = storeMessage(store, entry.status)
  if (status) {
    const code = entry.status.kind === 'unavailable' ? entry.status.code : null
    out.push(spec(statusNoticeKey(store, entry.status), status, actions, origin(store, code, entry.status.kind)))
  }
  if (entry.notice !== null) {
    const told = spec(`${oneTimeNoticePrefix(store)}${entry.notice}`, MESSAGE_BY_NOTICE[entry.notice], actions, origin(store, null, entry.notice))
    out.push({ ...told, onDismiss: actions.dismissNotice })
  }
  return out
}

/**
 * A status notice's key: its whole status, so a new code or set-aside file under the same kind replaces the notice and
 * its Report names the new code (notices.ts keys a failure by its code plus its StoreId).
 */
function statusNoticeKey(store: StoreId, status: StoreOpenStatus): string {
  return `health:${store}:status:${JSON.stringify(status)}`
}

/** The key prefix of a store's one-time notices, which stay on the row until dismissed. */
export function oneTimeNoticePrefix(store: StoreId): string {
  return `health:${store}:notice:`
}

/** The store's state as a problem report opened from its notice names it: its code when it has one. */
function origin(store: StoreId, code: FailureCode | null, state: string): ReportOrigin {
  return { source: `health.${store}`, code, operation: null, detail: `${store}: ${state}` }
}

function spec(key: string, message: StoreMessage, actions: HealthActions, from: ReportOrigin): NoticeSpec {
  const { report, retry } = actions
  const handlers: Record<HealthAction, (() => void) | null> = {
    retry: retry ? () => retry.run() : null,
    report: report ? () => report(from) : null,
    update: actions.update,
  }
  const runs = message.actions.flatMap((action): NonNullable<NoticeSpec['action']>[] => {
    const run = handlers[action]
    if (!run) return []
    // Try again reads busy while its read runs, so a press that fails again still shows it ran.
    const busy: LocaleKey = 'notice.tryingAgain'
    return [{ label: ACTION_LABEL[action], run, ...(action === 'retry' && retry ? { busy: { label: busy, now: () => retry.running() } } : {}) }]
  })
  return {
    key,
    message: message.message,
    ...(message.params ? { params: message.params } : {}),
    ...(message.title ? { title: message.title } : {}),
    tone: message.tone,
    ...(runs[0] ? { action: runs[0] } : {}),
    ...(runs[1] ? { secondaryAction: runs[1] } : {}),
    source: 'health',
  }
}

/** The last path segment: a host that sent a path still shows a file name only (2.1-Q285). */
function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

/** What a store says when its Try again fails again, where it has a Try again. */
const RETRY_FAILED: { readonly [S in StoreId]?: LocaleKey } = {
  settings: 'health.settingsStillUnavailable',
}

/**
 * The outcome notice of a Try again that failed again, or null for a store without one: the store's status notice is
 * told once per state and stays, so this short-lived outcome is what tells the user the press ran (2.1-Q295).
 */
export function retryFailedNotice(store: StoreId): NoticeSpec | null {
  const message = RETRY_FAILED[store]
  return message ? { key: retryFailedKey(store), message, tone: 'error', kind: 'outcome', source: 'health' } : null
}

/** The key of a store's retry-failed outcome notice, withdrawn once a Try again opens the store. */
export function retryFailedKey(store: StoreId): string {
  return `health:${store}:retry-failed`
}
