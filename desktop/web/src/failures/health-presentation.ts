/**
 * failures/health-presentation.ts: the one store health presentation (contracts §2 and §11, design check F3):
 * each `StoreOpenStatus` kind and each `StoreNotice` maps to one rule, silent or a tone, a locale key and its actions,
 * so a new kind fails typecheck until it has one (`every_health_status_has_one_message`). Invariant: a store's notice on
 * the row is keyed by its StoreId and state, so it is raised once; a file name is the set-aside file's name only, never
 * a path (2.1-Q285); an action an edition lacks (Report a problem, Update) is left out, never drawn dead.
 */
import type { StoreHealth, StoreId, StoreNotice, StoreOpenStatus } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'
import type { NoticeSpec } from './notices'

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
  newer_read_only: () => ({ tone: 'warning', message: 'health.newerReadOnly', actions: ['update'] }),
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

/** The handlers an edition offers for a store notice's actions; one it lacks is null and its button is left out. */
export interface HealthActions {
  readonly retry?: (() => void) | null
  readonly report: (() => void) | null
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
  if (status) out.push(spec(`health:${store}:${entry.status.kind}`, status, actions))
  if (entry.notice !== null) {
    out.push({ ...spec(`health:${store}:notice:${entry.notice}`, MESSAGE_BY_NOTICE[entry.notice], actions), onDismiss: actions.dismissNotice })
  }
  return out
}

function spec(key: string, message: StoreMessage, actions: HealthActions): NoticeSpec {
  const runs = message.actions
    .map((action) => ({ label: ACTION_LABEL[action], run: actions[action] ?? null }))
    .filter((action): action is { label: LocaleKey; run: () => void } => action.run !== null)
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
