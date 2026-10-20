import { computed, signal, type ReadonlySignal } from '@preact/signals'

/**
 * The one in-app dialog continuous save raises. `flush-failed` asks what to
 * do when a replacement or close could not write the current Design first;
 * `conflict` asks how to resolve a file that changed outside Canopi;
 * `revert` confirms replacing the Design with the version it was opened at,
 * which continuous save then writes over its home; `settings-failed` asks
 * what to do when close could not write the settings, answering with the
 * `flush-failed` ids (Escape is `cancel`).
 */
export type SaveProblemRequest =
  | {
    readonly kind: 'flush-failed'
    readonly purpose: 'replace' | 'close'
    /** The failure is a pending conflict, so Retry cannot succeed. */
    readonly conflict: boolean
    /** Where the conflicting change came from; omitted: outside Canopi. */
    readonly where?: SaveConflictSource
  }
  | { readonly kind: 'conflict'; readonly fileGone: boolean; readonly where?: SaveConflictSource }
  | { readonly kind: 'revert' }
  | {
    readonly kind: 'settings-failed'
    /** Close wrote the Design; false when the user closed it without saving. */
    readonly designSaved: boolean
  }

/** A browser Draft written by another tab of the Web Edition. */
export type SaveConflictSource = 'another-tab'

type FlushFailedChoice = 'retry' | 'discard' | 'cancel'
type ConflictChoice = 'keep-mine' | 'use-file' | 'save-copy' | 'cancel'
type RevertChoice = 'revert' | 'cancel'
export type SaveProblemChoice = FlushFailedChoice | ConflictChoice | RevertChoice

type ChoiceFor<R extends SaveProblemRequest> = R extends { readonly kind: 'conflict' }
  ? ConflictChoice
  : R extends { readonly kind: 'revert' }
    ? RevertChoice
    : FlushFailedChoice

interface ActiveSaveProblem {
  readonly request: SaveProblemRequest
  readonly answer: (choice: SaveProblemChoice) => void
}

const activeSaveProblem = signal<ActiveSaveProblem | null>(null)

export const saveProblem: ReadonlySignal<SaveProblemRequest | null> = computed(
  () => activeSaveProblem.value?.request ?? null,
)

/** Show the dialog and resolve with the user's choice. A newer request cancels an older one. */
export function requestSaveProblemDecision<R extends SaveProblemRequest>(
  request: R,
): Promise<ChoiceFor<R>> {
  activeSaveProblem.peek()?.answer('cancel')
  return new Promise((resolve) => {
    const active: ActiveSaveProblem = {
      request,
      answer: (choice) => {
        if (activeSaveProblem.peek() === active) activeSaveProblem.value = null
        resolve(choice as ChoiceFor<R>)
      },
    }
    activeSaveProblem.value = active
  })
}

export function answerSaveProblem(choice: SaveProblemChoice): void {
  activeSaveProblem.peek()?.answer(choice)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    answerSaveProblem('cancel')
  })
}
