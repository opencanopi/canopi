/**
 * fast-check's global settings for every test file (ADR 0028 Fixed seeds, 2.1-M67): a pinned seed, or the one
 * CANOPI_FC_SEED names (the seed lane's; vite.config.ts prints it once per run), a fixed number of runs and a
 * per-run time limit. A model-based suite (`__tests__/support/model-based.ts`) takes these unless it overrides them.
 */
import fc from 'fast-check'

const PINNED_FC_SEED = 20_261_027
const FC_RUNS = 20
const FC_RUN_TIMEOUT_MS = 5_000

export function fastCheckSettings(seed: string | undefined): { seed: number; numRuns: number; timeout: number } {
  return { seed: seed === undefined ? PINNED_FC_SEED : wholeNumber('CANOPI_FC_SEED', seed), numRuns: FC_RUNS, timeout: FC_RUN_TIMEOUT_MS }
}

function wholeNumber(name: string, value: string): number {
  const parsed = Number(value)
  if (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(parsed)) throw new Error(`${name} must be a whole number, got "${value}"`)
  return parsed
}

fc.configureGlobal(fastCheckSettings(process.env.CANOPI_FC_SEED || undefined))
