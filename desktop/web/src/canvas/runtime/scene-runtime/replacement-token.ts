/**
 * Leaf replacement token and authority error types shared by `canvas/runtime/runtime.ts`
 * and `canvas/runtime/scene-runtime/transactions.ts` without introducing a type cycle.
 */
export class CanvasDocumentReplacementNotAdmittedError extends Error {
  constructor(readonly reason: unknown) {
    super(
      reason instanceof Error
        ? reason.message
        : 'Canvas rejected document replacement before hydration',
    )
    this.name = 'CanvasDocumentReplacementNotAdmittedError'
  }
}

export class CanvasAuthorityBusyError extends Error {
  constructor(
    readonly activeType: string,
    message = `Canvas authority ${activeType} is busy`,
  ) {
    super(message)
    this.name = 'CanvasAuthorityBusyError'
  }
}

const canvasDocumentReplacementTokenBrand = Symbol('canvas-document-replacement-token')

export interface CanvasDocumentReplacementToken {
  readonly [canvasDocumentReplacementTokenBrand]: true
}

export function createCanvasDocumentReplacementToken(): CanvasDocumentReplacementToken {
  return Object.freeze({
    [canvasDocumentReplacementTokenBrand]: true as const,
  })
}
