import type { KeyRouterDeps, KeyRouterHandle } from '../app/keyboard/key-router'
import { saveProblem } from '../app/document-session/save-problem'
import { savedViewDialogOpen } from '../app/saved-views'
import { commandPaletteOpen } from '../app/shell/dialogs'
import { modalLayerOpen } from '../app/shell/modal-layer'
import { createDesktopCommandSink, DESKTOP_KEYMAP } from './graph'

export {
  appCommandGraphChromeProjection,
  appCommandGraphPanelProjection,
  appCommandGraphToolbarProjection,
  DESKTOP_SHELL_COMMAND_CATALOG,
} from './graph'
export type {
  MenuAction,
  MenuDefinition,
  MenuEntry,
} from './graph'

export { commandPaletteOpen }

/** Modal dialogs: while one asks, no command may change the Design under it (the open palette holds the layer too). */
function isModalOpen(): boolean {
  return commandPaletteOpen.peek() || saveProblem.peek() !== null || savedViewDialogOpen.peek() || modalLayerOpen.peek()
}

const sink = createDesktopCommandSink(isModalOpen)

/**
 * The Desktop key router: platform/desktop.ts passes app/keyboard's installKeyRouter and the live deps; the registry
 * adds the Desktop keymap and keeps its command sink to itself.
 */
export function installDesktopKeyRouter(
  install: (deps: KeyRouterDeps) => KeyRouterHandle,
  deps: Omit<KeyRouterDeps, 'keymap' | 'commands' | 'isModalOpen'>,
): KeyRouterHandle {
  return install({ ...deps, keymap: DESKTOP_KEYMAP, commands: sink, isModalOpen })
}
