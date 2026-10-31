// A planted violation of no-cancelled-literal: a hand-written cancellation string instead of the catalogue's Cancelled.
export type PlantedOutcome = { kind: 'done' } | { kind: 'cancelled' }
export const plantedCancel = (): PlantedOutcome => ({ kind: 'cancelled' })
