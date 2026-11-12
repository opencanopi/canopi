// @ts-check
// policy/gate/cli.mjs: the gate's entry, every caller's (2.1-M198, 2.1-Q267; design check AR11, AR18, AR24, A9). Plain
// JavaScript with nothing from node_modules, so any Node loads it and `areas` serves CI's changes job and a fresh worktree:
//
//   node policy/gate/cli.mjs affected --base <rev> [--print]  the checks for what changed since merge-base(rev, HEAD)
//   node policy/gate/cli.mjs affected --staged [--print]      the commit lane: the checks for the staged change
//   node policy/gate/cli.mjs push --base <rev> [--print]      the pre-push lane: CI's Linux mirror for what changed, each
//                                                             selected and every-change area's full row; green on a
//                                                             tree exactly HEAD, it stamps HEAD (stamp.ts); red only
//                                                             by markers added since the base, it stamps HEAD for
//                                                             refs under scratch/ only (2.1-Q328)
//   node policy/gate/cli.mjs full [--area <a>]... [--print]   AGENTS.md's Quality gates rows, every area or the named ones
//   node policy/gate/cli.mjs check <id>... [--print]          table checks by id, outside any area's row (a CI step)
//   node policy/gate/cli.mjs areas --base <rev>               the areas a change selects, the vitest files its lane adds
//                                                             and every area's patterns, as JSON, running no tool
//   node policy/gate/cli.mjs verify-push [<remote> <url>]     the pre-push hook: each pushed ref on stdin needs a stamp,
//                                                             a scratch-only one a ref under scratch/ (verify-push.ts)
//   node policy/gate/cli.mjs actionlint                       the pinned actionlint over .github/workflows
//   node policy/gate/cli.mjs oldest-engine                    both builds' chunks parsed by Debian 12's JavaScriptCore
//   node policy/gate/cli.mjs cov                              cargo llvm-cov with policy/ratchets/coverage.json's floors
//   node policy/gate/cli.mjs gate-cov                         the policy-gate Vitest project's coverage, its child CLIs
//                                                             included, held to policy/ratchets/coverage.json's floors
//   node policy/gate/cli.mjs bundle-summary <row log>         a red Frontend row's bundle refusals to the step summary
//   node policy/gate/cli.mjs rollback-refs                    the rollback lane's reader and writer refs from the tag
//                                                             names on stdin (rollback-refs.ts)
//   node policy/gate/cli.mjs agents-rows [--check]            AGENTS.md's rows rendered from the table, or their check
//   node policy/gate/cli.mjs commit-gate pre-commit|pre-merge-commit|commit-msg <file>
//                                                             the tracked hooks' commit gate (commit-gate.ts)
//   node policy/gate/cli.mjs commit-gate pr <base> <head>     every commit of base..head, as quiet-gates and CI run it
//   node policy/gate/cli.mjs agent-hook pre-tool-use|session-start|planted <command.json>...
//                                                             the Claude Code hooks (agent-hooks.ts)
//
// affected, push and full also take --only <id>... (the plan cut to those check ids, `e2e` its e2e run with the build it
// serves) and --log-dir <dir>
// (durations.json: each check's outcome and seconds, a stopped one `not run`); CANOPI_E2E_RUNNER wraps the e2e command
// (A14).
//
// A Node below the engines major, including one that cannot strip types, runs the entry again on nvm's install of that
// major: this is the gate's one nvm lookup, so hooks and scripts call plain `node`. With none it refuses in one line
// before any TypeScript loads, as it does when that Node cannot start or is killed. The engines Node runs main.ts. The
// agent hooks never refuse by exit 1, which Claude Code reads as a hook error and lets the tool call through: a gate
// that cannot run there, or a module that cannot load, makes PreToolUse ask and SessionStart warn.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enginesNode, engineRefusal } from './engines.mjs'

/** The signals that stop a run: SIGINT (Ctrl-C) and SIGTERM (`timeout`), as run.ts's. */
const STOPS = /** @type {const} */ (['SIGINT', 'SIGTERM'])
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const HOOK = process.argv[2] === 'agent-hook' && ['pre-tool-use', 'session-start'].includes(process.argv[3] ?? '')
  ? process.argv[3] : undefined

/** The exit code for a gate that cannot run, `why` said where its caller acts on it. */
function cannotRun(/** @type {string} */ why) {
  const line = why.replace(/\s+/g, ' ').trim()
  if (HOOK === undefined) {
    process.stderr.write(`gate: ${line}\n`)
    return 1
  }
  process.stdout.write(HOOK === 'pre-tool-use'
    ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `[agent-hooks] the agent hooks cannot run (${line}); ask the user` } })}\n`
    : `Canopi hooks warning: the agent hooks cannot run (${line})\n`)
  return 0
}

/** The exit code of the gate run again on nvm's engines Node, or of the refusal when there is none or it fails. */
async function again(/** @type {string} */ refusal) {
  const node = enginesNode(ROOT, process.env)
  if (node === undefined) return cannotRun(refusal)
  // nvm's install of the engines major leads PATH, so the checks' own node and npm are that Node too. A SIGINT or SIGTERM
  // (`timeout`'s) sent to this process alone goes on to that run, which ends as its own handler says; it is never left
  // running orphaned, and this process exits with the run's status, or 128 plus the signal that ended it, as run.ts
  // does (M402). The handlers are in place before the run starts: a signal landing between the two would otherwise kill
  // this process by default and orphan the run (canopi-f47t.52.228.54). They run on the event loop, so after `running`
  // is set.
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let running
  /** @type {NodeJS.Signals | undefined} */
  let stopped
  const forward = (/** @type {NodeJS.Signals} */ signal) => {
    stopped = signal
    running?.kill(signal)
  }
  for (const signal of STOPS) process.on(signal, forward)
  const child = running = spawn(node, process.argv.slice(1), {
    stdio: 'inherit', env: { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env['PATH'] ?? ''}` },
  })
  /** @type {{ status: number | null, signal: NodeJS.Signals | null, error?: NodeJS.ErrnoException }} */
  const run = await new Promise((done) => {
    child.once('error', (error) => done({ status: null, signal: null, error }))
    child.once('close', (status, signal) => done({ status, signal }))
  }).finally(() => { for (const signal of STOPS) process.removeListener(signal, forward) })
  if (run.status !== null) return run.status
  if (run.signal !== null && (stopped !== undefined || run.signal === 'SIGINT')) return 128 + constants.signals[run.signal]
  const why = run.error ? `failed to run (${run.error.code ?? run.error.message})` : `was stopped by ${run.signal ?? 'an unknown cause'}`
  return cannotRun(`${refusal}; ${node} ${why}`)
}

/** main.ts's exit code; in the agent hooks, a module that cannot load or a throw is a gate that cannot run. */
async function run() {
  try {
    return await (await import('./main.ts')).main(ROOT, process.argv.slice(2))
  } catch (error) {
    if (HOOK === undefined) throw error
    return cannotRun(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

const refusal = engineRefusal(process.version, ROOT)
process.exitCode = refusal ? await again(refusal) : await run()
