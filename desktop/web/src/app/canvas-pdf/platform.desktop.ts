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
