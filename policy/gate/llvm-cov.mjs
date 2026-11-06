// @ts-check
// policy/gate/llvm-cov.mjs: the Rust row's coverage run (ADR 0028 Coverage; 2.1-M217; A20). policy/ratchets/coverage.json
// is the one home of the cargo-llvm-cov floors and exclusions: the gate's `cov` mode builds the command from it, and the
// coverage family measures what this builder makes (policy/adapters/coverage.mjs), so no config spells them out again.
// The run only reads the family: an interrupted run (SIGINT reaches cargo's whole group) exits 130 and changes nothing.
// Plain JavaScript, so policy/check.mjs's adapter loads it on any Node.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const COVERAGE_FAMILY = 'policy/ratchets/coverage.json'

/**
 * cargo's arguments for the coverage run of the workspace at `root`: every workspace test once, the family's exclusions
 * as one --ignore-filename-regex and each floor as --fail-under-<metric>. Throws when the family holds no floor.
 * @param {string} root
 * @returns {string[]}
 */
export function llvmCovArgs(root) {
  const doc = JSON.parse(readFileSync(join(root, COVERAGE_FAMILY), 'utf8'))
  const held = doc?.floors?.['cargo-llvm-cov']
  const floors = Object.entries(held?.floors ?? {})
  if (!floors.length) throw new Error(`${COVERAGE_FAMILY} holds no cargo-llvm-cov floor`)
  /** @type {string[]} */
  const exclude = held.exclude ?? []
  return ['llvm-cov', '--workspace', '--locked', '--summary-only',
    ...(exclude.length ? ['--ignore-filename-regex', exclude.length === 1 ? String(exclude[0]) : exclude.map((r) => `(?:${r})`).join('|')] : []),
    ...floors.flatMap(([metric, value]) => [`--fail-under-${metric}`, String(value)])]
}

/**
 * Runs cargo llvm-cov at `root`: its exit code, 130 after SIGINT, 1 when the family cannot be read.
 * @param {string} root
 * @returns {Promise<number>}
 */
export async function runCov(root) {
  let args
  try {
    args = llvmCovArgs(root)
  } catch (error) {
    process.stderr.write(`gate: ${/** @type {Error} */ (error).message}; refusing\n`)
    return 1
  }
  const child = spawn('cargo', args, { cwd: root, stdio: 'inherit', detached: true })
  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGINT')
    } catch {
      // the group has ended
    }
  }
  process.on('SIGINT', onInterrupt)
  try {
    const code = await new Promise((resolve) => {
      child.once('error', (error) => {
        process.stderr.write(`gate: cargo could not start: ${error.message}\n`)
        resolve(127)
      })
      child.once('close', (status) => resolve(status ?? 1))
    })
    return interrupted ? 130 : /** @type {number} */ (code)
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}
