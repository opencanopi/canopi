// Planted violation of no-private-field-cast-in-tests (ADR 0028, 2.1-M20): a test reaching a private field through a
// cast to a hand-written shape.
class Counter {
  private _count = 0
  increment(): void { this._count += 1 }
}

export const plantedCount = (counter: Counter): number => (counter as unknown as { _count: number })._count
