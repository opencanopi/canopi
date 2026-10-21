import { preparePdf, type PdfJob } from './prepare'
import { PdfTextError } from './text'
self.onmessage = async (event: MessageEvent<PdfJob>) => {
  try {
    const result = await preparePdf(event.data, progress => self.postMessage({ progress }))
    self.postMessage({ result }, { transfer: result.bytes ? [result.bytes.buffer] : [] })
  } catch (error) {
    self.postMessage({ error: error instanceof PdfTextError ? error.kind
      : error instanceof Error && error.message === 'coverage-too-large' ? error.message : 'prepare-failed' })
  }
}
