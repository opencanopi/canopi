// Planted for the seed lane's `planted` job (.github/workflows/seed-lane.yml): two tests sharing module state, so
// the first passes only when it runs first. Written order passes; CANOPI_TEST_SEED=3 shuffles them into the failing
// order. The normal suite never reads policy/fixtures/ (Vitest's root is desktop/web).
import { expect, it } from 'vitest'

let touched = false

it('finds the shared state untouched', () => {
  expect(touched).toBe(false)
})

it('touches the shared state', () => {
  touched = true
  expect(touched).toBe(true)
})
