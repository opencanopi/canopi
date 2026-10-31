// no-hand-rolled-projection: a scale ending the left operand of a nested binary.
declare const p: { x: number }
declare const viewport: { scale: number }
export const x = p.x * viewport.scale + 4
