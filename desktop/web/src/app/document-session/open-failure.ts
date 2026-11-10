import { designLoadFailureMessageKey, designLoadFailureOf } from '../contracts/canopi-design-errors'
import type { LocaleKey } from '../../generated/locale-keys'

/**
 * What the user sees when a Design cannot be opened: the typed load failure
 * turned into the Start screen's wording (older version, newer version,
 * missing, damaged), never a path or the raw error, as locale keys. The
 * presenter is the edition's notice surface (a native dialog on Desktop, the
 * one notice row on the Web); without one the failure is only logged by the caller.
 */
export interface DesignOpenFailureNotice {
  readonly tone: 'error'
  readonly title: LocaleKey
  readonly message: LocaleKey
}

export type DesignOpenFailurePresenter = (notice: DesignOpenFailureNotice) => void | Promise<void>

let presenter: DesignOpenFailurePresenter | null = null

export function registerDesignOpenFailurePresenter(next: DesignOpenFailurePresenter | null): void {
  presenter = next
}

export function designOpenFailureNoticeOf(error: unknown): DesignOpenFailureNotice {
  const failure = designLoadFailureOf(error)
  const key = failure ? designLoadFailureMessageKey(failure.kind) : 'start.cantRead'
  return { tone: 'error', title: 'start.cantOpenTitle', message: key }
}

/** Show the failure to the user through the registered presenter, if any. */
export function presentDesignOpenFailure(error: unknown): void {
  if (!presenter) return
  void Promise.resolve(presenter(designOpenFailureNoticeOf(error))).catch((cause) => {
    console.error('Design open failure could not be presented:', cause)
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    presenter = null
  })
}
