// A planted violation of signal-write-only-in-owner from app/settings/, which owns its signals (ADR 0024:39): the
// write into ./state is the folder's own, the write into the shell's signal is the site.
import { theme } from './state'
import { sidePanelWidth } from '../shell/state'
export const plantedApply = (): void => {
  theme.value = 'dark'
  sidePanelWidth.value = 320
}
