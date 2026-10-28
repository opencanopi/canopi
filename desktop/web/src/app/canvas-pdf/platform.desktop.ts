// app/canvas-pdf/platform.desktop.ts
// Owner of the desktop PDF delivery outcome (no-cancelled-literal, ADR 0025; §18 R14). Invariant: 'cancelled' is
// a PdfDeliveryResult value, returned only for an aborted delivery signal or a dismissed save dialog; ast-grep
// skips this file, so a hand-written cancel guard added here goes uncounted and belongs to the catalogue's
// CancelToken instead.

import { invoke } from '@tauri-apps/api/core'
import { pickSave } from '../../ipc/dialogs'
import type { PdfDelivery } from './workflow'
export function createPdfDelivery(): PdfDelivery {
  return {
    async save(bytes, name, signal) {
      if (signal.aborted) return 'cancelled'
      const outcome = await pickSave('pdf-export', safeName(name))
      if (outcome.kind === 'cancelled' || signal.aborted) return 'cancelled'
      await invoke('save_canvas_pdf', { data: Array.from(bytes), path: outcome.path })
      return 'saved'
    },
    dispose() {},
  }
}
function safeName(name: string): string { return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'Canopi' }
