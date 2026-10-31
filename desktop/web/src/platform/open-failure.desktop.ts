// platform/open-failure.desktop.ts
//
// Owner of the Desktop open-failure dialog: a native host adapter for @tauri-apps/* (tauri-only-in-native-host, ADR 0022;
// §18 F2). Invariant: Tauri is reached only through ipc/ and the platform Desktop adapters.

import { message } from '@tauri-apps/plugin-dialog'
import type { DesignOpenFailureNotice } from '../app/document-session/open-failure'

/** Desktop presents a Design that cannot be opened as a native error dialog. */
export async function presentDesktopDesignOpenFailure(notice: DesignOpenFailureNotice): Promise<void> {
  await message(notice.message, { title: notice.title, kind: 'error' })
}
