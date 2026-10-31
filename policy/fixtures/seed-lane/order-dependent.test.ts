// Planted for the seed lane's `planted` job (.github/workflows/seed-lane.yml): eight tests share a log of the order
// they ran in, and the one that runs last fails when that order is CANOPI_TEST_SEED=3's. One seed in 40,320 gives a
// given order of eight, so the job goes red when the lane stops shuffling by the seed it prints. The written order
// passes. The normal suite never reads policy/fixtures/ (Vitest's root is desktop/web).
import { expect, it } from 'vitest'

const steps = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']
const seedThreeOrder = ['third', 'first', 'eighth', 'fourth', 'sixth', 'fifth', 'seventh', 'second']
const ran: string[] = []

for (const step of steps) {
  it(`runs the ${step} step`, () => {
    ran.push(step)
    expect(ran, 'the planted failure: seed 3\'s order').not.toEqual(seedThreeOrder)
  })
}
