import {
  createSavedObjectStampWorkbench,
  type SavedObjectStampWorkbench,
} from './workbench'

const liveSavedObjectStampWorkbench = createSavedObjectStampWorkbench()

export const savedObjectStampWorkbench: SavedObjectStampWorkbench =
  liveSavedObjectStampWorkbench

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    liveSavedObjectStampWorkbench.dispose()
  })
}

export {
  isSavedObjectStampPayloadFromBefore2_0,
  savedObjectStampIdsNeedsNewerLast,
  savedObjectStampRowState,
} from './row-state'
