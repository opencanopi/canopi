/**
 * editions/desktop/design-home.ts: Desktop `DesktopHomePort` adapter over `ipc/design-home.ts`
 * (2b-4; contracts §4, ADR 0027). Never branches on key kind — the Desktop host resolves both
 * `FileGrantId` and `DraftId` behind `home_read` / `home_write`.
 */
import { homeRead, homeWrite } from '../../ipc/design-home'
import type { DesktopHomePort } from '../../platform/design-home'

export const desktopHomePort: DesktopHomePort = {
  read: (key) => homeRead(key),
  write: (key, bytes, expected, options) => homeWrite(key, bytes, expected, options?.keepPrevious ?? false),
}
