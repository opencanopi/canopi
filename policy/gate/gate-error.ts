// policy/gate/gate-error.ts: the gate's refusal (2.1-M198), apart so every planning module throws the one class main.ts
// reads as "refuse", never as a crash.

/** The gate cannot judge the change: it refuses, never reads it as passing. */
export class GateError extends Error {}
