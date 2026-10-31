import { describe, expect, it } from 'vitest'
import { canTransition, type UpdateStateKind } from './state'

// The updater state machine's transition table (contracts §3, 2.1-M208), beside the module it holds; the user paths
// through it are __tests__/updater-flow.test.ts.

/** The contract's UpdateState kinds (contracts §3, 2.1-M208), spelled here so the table below is exhaustive over them. */
const CONTRACT_KINDS = [
  'idle', 'checking', 'available', 'downloading', 'verified', 'installing', 'installed', 'close_requested', 'failed',
  'link_only',
] as const satisfies readonly UpdateStateKind[]

/**
 * UpdateState names no kind the contract lacks: `satisfies` above refuses a contract kind UpdateState lacks, and this
 * refuses the reverse, so the two sets are equal at typecheck; the transition table's mapped type has a row for
 * exactly UpdateState's kinds.
 */
const NO_KIND_OUTSIDE_THE_CONTRACT: [Exclude<UpdateStateKind, (typeof CONTRACT_KINDS)[number]>] extends [never] ? true : never = true

/**
 * states.md's Updater diagram, edge for edge, as contracts §3 gives it: link_only follows downloading (the probe runs
 * in update_download), progress is downloading to downloading, a Windows installer that fails to launch after proceed
 * settles failed (close_requested to failed), and About's Retry is failed to downloading (2.1-Q252).
 */
const EDGES: readonly (readonly [UpdateStateKind, UpdateStateKind])[] = [
  ['idle', 'checking'],
  ['checking', 'idle'],
  ['checking', 'failed'],
  ['checking', 'available'],
  ['available', 'downloading'],
  ['downloading', 'downloading'],
  ['downloading', 'idle'],
  ['downloading', 'failed'],
  ['downloading', 'verified'],
  ['downloading', 'link_only'],
  ['failed', 'idle'],
  ['failed', 'downloading'],
  ['verified', 'installing'],
  ['verified', 'close_requested'],
  ['installing', 'installed'],
  ['installing', 'failed'],
  ['installed', 'close_requested'],
  ['close_requested', 'installed'],
  ['close_requested', 'verified'],
  ['close_requested', 'failed'],
]

describe('UpdateState transition table (2.1-M208, ADR 0028)', () => {
  it('every contract UpdateState kind has a transition-table row, and UpdateState names no other kind', () => {
    // A kind with no row throws in canTransition, which reads the row of `from`.
    expect({ rows: CONTRACT_KINDS.map((kind) => typeof canTransition(kind, kind)), typed: NO_KIND_OUTSIDE_THE_CONTRACT })
      .toEqual({ rows: CONTRACT_KINDS.map(() => 'boolean'), typed: true })
  })

  it('allows every diagram edge and refuses every other pair of kinds', () => {
    const allowed = CONTRACT_KINDS.flatMap((from) => CONTRACT_KINDS.filter((to) => canTransition(from, to)).map((to) => `${from} -> ${to}`))
    expect(allowed.sort()).toEqual(EDGES.map(([from, to]) => `${from} -> ${to}`).sort())
  })
})
