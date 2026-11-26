import { t } from '../../i18n'
import type { SavedView } from '../../types/design'
import { createUuid } from '../../utils/ids'
import { addSavedView } from '../design-edit'
import { captureCurrentView, currentSavedViews } from './current-view'

export function defaultSavedViewName(): string {
  return t('savedViews.defaultName', { number: currentSavedViews().length + 1 })
}

interface SaveCurrentViewInput {
  readonly name: string
  /** Shown with the view when it is presented; blank means none. */
  readonly title?: string
}

/**
 * Saves what the map shows now as Design Edit data (see `captureCurrentView`),
 * with a name and an optional title.
 */
export function saveCurrentView({ name, title = '' }: SaveCurrentViewInput): SavedView | null {
  const capture = captureCurrentView({ id: createUuid(), name, title })
  if (!capture) return null
  addSavedView(capture)
  return capture
}
