// @ts-check
// policy/gate/vitest-workers.mjs: how many Vitest workers the gate's runs use (canopi-hcv2): CANOPI_VITEST_WORKERS,
// else VITEST_WORKERS, from 1 to 16, else the table's 4. One reader for run.ts's table checks and gate-cov.mjs's run,
// which plain node starts. An empty variable counts as unset; a value out of range keeps 4 and says so.

/** The table's own worker count, which its Vitest commands name as `--maxWorkers=4`. */
const TABLE_WORKERS = 4

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ workers: number, warning: string }}
 */
export function vitestWorkers(env = process.env) {
  for (const name of ['CANOPI_VITEST_WORKERS', 'VITEST_WORKERS']) {
    const raw = (env[name] ?? '').trim()
    if (raw === '') continue
    if (/^[1-9]\d*$/.test(raw) && Number(raw) <= 16) return { workers: Number(raw), warning: '' }
    return { workers: TABLE_WORKERS, warning: `${name}=${raw} is not a worker count from 1 to 16: Vitest runs ${TABLE_WORKERS} workers` }
  }
  return { workers: TABLE_WORKERS, warning: '' }
}

/**
 * `words` with the table's `--maxWorkers=4` set to `workers`.
 * @param {readonly string[]} words
 * @param {number} workers
 * @returns {string[]}
 */
export const sizeWorkers = (words, workers) =>
  words.map((word) => (word === `--maxWorkers=${TABLE_WORKERS}` ? `--maxWorkers=${workers}` : word))
