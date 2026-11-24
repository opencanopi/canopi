// editions/desktop/open-failure.ts
//
// Desktop open-failure dialog adapter over @tauri-apps/* (tauri-only-in-native-host, ADR 0022; §18 F2).
// Invariant: Tauri is reached only through ipc/ and editions/desktop/.

import { message } from '@tauri-apps/plugin-dialog'
import type { DesignOpenFailureNotice } from '../../app/document-session/open-failure'
import { t } from '../../i18n'

/** Desktop presents a Design that cannot be opened as a native error dialog. */
export async function presentDesktopDesignOpenFailure(notice: DesignOpenFailureNotice): Promise<void> {
  await message(t(notice.message), { title: t(notice.title), kind: 'error' })
}
