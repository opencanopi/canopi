// app/canvas-pdf/job.ts
// Owner of the PDF worker (worker-only-in-owner, ADR 0028; §18 F16). Invariant: the PDF
// worker is started only here; it is the cancellation boundary for shaping and encoding.

import PdfWorker from './worker?worker&inline'
import type { PdfJob, PdfPreparation } from './prepare'
import type { PdfFontUrls } from './text'
import type { PreparedPdf, PdfPlan } from './types'
/** A worker is the cancellation boundary for synchronous shaping and encoding. */
export function preparePdfJob(input: PdfPreparation, fontUrls: PdfFontUrls, signal: AbortSignal, progress?: (plan: PdfPlan) => void): Promise<PreparedPdf> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const worker = new PdfWorker()
    let settled = false
    const cleanup = () => { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('prepare-timeout')) }, 120_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ result?: PreparedPdf; error?: string; progress?: PdfPlan }>) => {
      if (settled) return
      if (event.data.progress) {
        try { progress?.(event.data.progress) } catch (error) { cleanup(); reject(error) }
        return
      }
      cleanup()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.error ?? 'prepare-failed'))
    }
    worker.onerror = () => { cleanup(); reject(new Error('prepare-failed')) }
    const job: PdfJob = { ...input, fontUrls }
    try { worker.postMessage(job) } catch (error) { cleanup(); reject(error) }
  })
}
