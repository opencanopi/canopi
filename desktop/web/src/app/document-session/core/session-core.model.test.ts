/**
 * app/document-session/core/session-core.model.test.ts: Model-based property test for
 * the Session Core state union, dirty invariant (rev > ackRev), and Undo/Redo stack (ADR 0028, 2b-3).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { DesignHomeStore, DraftId, HomeVersion } from '../../../platform/design-home'
import type { CanopiFile } from '../../../types/design'
import { createSessionCore } from './session-core'

function makeFile(name: string): CanopiFile {
  return {
    version: 10,
    name,
    description: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    plants: [],
    zones: [],
    layers: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
  } as unknown as CanopiFile
}

type Op =
  | { readonly kind: 'edit'; readonly name: string }
  | { readonly kind: 'flush' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'close' }
  | { readonly kind: 'createNew' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('edit' as const), name: fc.string({ minLength: 1, maxLength: 12 }) }),
  fc.constant({ kind: 'flush' as const }),
  fc.constant({ kind: 'undo' as const }),
  fc.constant({ kind: 'redo' as const }),
  fc.constant({ kind: 'close' as const }),
  fc.constant({ kind: 'createNew' as const }),
)

describe('SessionCore model-based state invariants (ADR 0024, ADR 0028)', () => {
  it('maintains rev >= ackRev, dirty === (rev > ackRev), and valid state union across arbitrary operation sequences', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const store = new Map<string, { bytes: Uint8Array; version: HomeVersion }>()
        let seq = 0
        const designHome: DesignHomeStore = {
          async read(key) {
            const entry = store.get(key)
            return entry ? { kind: 'present', bytes: Array.from(entry.bytes), version: entry.version } : { kind: 'absent' }
          },
          async write(key, bytes, expected) {
            const existing = store.get(key)
            if (expected === null ? existing : !existing || existing.version !== expected) {
              return { kind: 'conflict', current: existing?.version ?? null }
            }
            const version = `v-${++seq}`
            store.set(key, { bytes: new Uint8Array(bytes), version })
            return { kind: 'written', version }
          },
          async listDrafts() { return [] },
          async deleteDraft(id: DraftId) { store.delete(id); return { ok: true } },
          onVersionChange() { return () => {} },
        }

        const core = createSessionCore({
          designHome,
          fileAccess: {
            pickOpen: async () => ({ kind: 'cancelled' }),
            pickHomeTarget: async () => ({ kind: 'cancelled' }),
          },
          lifecycle: { subscribe: () => () => {} },
          codec: {
            decode: async (bytes) => ({ file: JSON.parse(new TextDecoder().decode(bytes)) as CanopiFile }),
            encode: async (file) => ({
              bytes: new TextEncoder().encode(JSON.stringify(file)),
              version: `v-${seq + 1}`,
            }),
          },
          settings: {
            readLastOpenHome: async () => null,
            writeLastOpenHome: async () => {},
          },
          newDesignFactory: () => makeFile('Untitled'),
          flushDelayMs: 60_000,
        })

        try {
          for (const op of ops) {
            if (op.kind === 'createNew') await core.createNew()
            else if (op.kind === 'edit') core.document('rename', () => ({ name: op.name }))
            else if (op.kind === 'flush') await core.flushNow()
            else if (op.kind === 'undo') core.undo()
            else if (op.kind === 'redo') core.redo()
            else if (op.kind === 'close') await core.close('close')

            const design = core.currentDesign.value
            if (design) {
              expect(design.rev).toBeGreaterThanOrEqual(design.ackRev)
              expect(core.dirty.value).toBe(design.rev > design.ackRev)
            } else {
              expect(core.dirty.value).toBe(false)
              expect(core.canUndo.value).toBe(false)
              expect(core.canRedo.value).toBe(false)
            }
          }
        } finally {
          core.dispose()
        }
        expect(core.state.value.kind).toBe('disposed')
      }),
      { numRuns: 30 },
    )
  })
})
