// @ts-check
// policy/gate/cli.mjs: the gate's entry, every caller's (2.1-M198, 2.1-Q267; design check AR11, AR18, AR24, A9). Plain
// JavaScript with nothing from node_modules, so any Node loads it and `areas` serves CI's changes job and a fresh worktree:
//
//   node policy/gate/cli.mjs affected --base <rev> [--print]  the checks for what changed since merge-base(rev, HEAD)
//   node policy/gate/cli.mjs affected --staged [--print]      the commit lane: the checks for the staged change
//   node policy/gate/cli.mjs push --base <rev> [--print]      the pre-push lane: CI's Linux mirror for what changed, each
//                                                             selected and every-change area's full row; green on a
//                                                             clean tracked tree, it stamps HEAD (stamp.ts)
//   node policy/gate/cli.mjs full [--area <a>]... [--print]   AGENTS.md's Quality gates rows, every area or the named ones
//   node policy/gate/cli.mjs areas --base <rev>               the areas a change selects, the vitest files its lane adds
//                                                             and every area's patterns, as JSON, running no tool
//   node policy/gate/cli.mjs actionlint                       the pinned actionlint over .github/workflows
//   node policy/gate/cli.mjs oldest-engine                    both builds' chunks parsed by Debian 12's JavaScriptCore
//   node policy/gate/cli.mjs agents-rows [--check]            AGENTS.md's rows rendered from the table, or their check
//   node policy/gate/cli.mjs commit-gate pre-commit|pre-merge-commit|commit-msg <file>
//                                                             the tracked hooks' commit gate (commit-gate.ts)
//   node policy/gate/cli.mjs commit-gate pr <base> <head>     every commit of base..head, as quiet-gates and CI run it
//
// affected, push and full also take --only <id>... (the plan cut to those check ids, `e2e` its e2e run with the build it
// serves) and --log-dir <dir>
// (durations.json: each check's outcome and seconds, a stopped one `not run`); CANOPI_E2E_RUNNER wraps the e2e command
// (A14).
//
// A Node below the engines major, including one that cannot strip types, runs the entry again on nvm's install of that
// major: this is the gate's one nvm lookup, so hooks and scripts call plain `node`. With none it refuses in one line
// before any TypeScript loads, as it does when that Node cannot start or is killed. The engines Node runs main.ts.
import { spawn } from 'node:child_process'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enginesNode, engineRefusal } from './engines.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** The exit code of the gate run again on nvm's engines Node, or of the refusal when there is none or it fails. */
async function again(/** @type {string} */ refusal) {
  const node = enginesNode(ROOT, process.env)
  if (node === undefined) {
    process.stderr.write(`gate: ${refusal}\n`)
    return 1
  }
  // nvm's install of the engines major leads PATH, so the checks' own node and npm are that Node too. A SIGINT sent to
  // this process alone goes on to that run, which ends as its own handler says; it is never left running orphaned.
  const child = spawn(node, process.argv.slice(1), {
    stdio: 'inherit', env: { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env['PATH'] ?? ''}` },
  })
  const forward = () => { child.kill('SIGINT') }
  process.on('SIGINT', forward)
  /** @type {{ status: number | null, signal: NodeJS.Signals | null, error?: NodeJS.ErrnoException }} */
  const run = await new Promise((done) => {
    child.once('error', (error) => done({ status: null, signal: null, error }))
    child.once('close', (status, signal) => done({ status, signal }))
  }).finally(() => process.removeListener('SIGINT', forward))
  if (run.status !== null) return run.status
  if (run.signal === 'SIGINT') return 130
  const why = run.error ? `failed to run (${run.error.code ?? run.error.message})` : `was stopped by ${run.signal ?? 'an unknown cause'}`
  process.stderr.write(`gate: ${refusal}; ${node} ${why}\n`)
  return 1
}

const refusal = engineRefusal(process.version, ROOT)
process.exitCode = refusal ? await again(refusal) : await (await import('./main.ts')).main(ROOT, process.argv.slice(2))
