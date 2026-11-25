// app/document-session/workflows.test.ts
// Verifies workflow registration idempotency on HMR (2a-2 N1).
import { describe, expect, it } from 'vitest'
import { DESIGN_SESSION_WORKFLOWS, registerDesignSessionWorkflow } from './workflows'

describe('design session workflow registration (2a-2)', () => {
  it('registers a workflow once and ignores duplicate registrations on HMR', () => {
    const before = DESIGN_SESSION_WORKFLOWS.length
    const stub = { id: 'test-stub', install: () => () => {} }
    registerDesignSessionWorkflow(stub)
    registerDesignSessionWorkflow(stub)
    expect(DESIGN_SESSION_WORKFLOWS.filter((w) => w === stub)).toHaveLength(1)
    expect(DESIGN_SESSION_WORKFLOWS.length).toBe(before + 1)
    const idx = DESIGN_SESSION_WORKFLOWS.indexOf(stub)
    if (idx >= 0) DESIGN_SESSION_WORKFLOWS.splice(idx, 1)
  })
})
