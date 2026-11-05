// policy/gate/main.ts: the gate's command line (2.1-M198, 2.1-Q267; design check AR11, AR18), run by the entry
// policy/gate/cli.mjs on the engines Node, whose header lists the modes; `commit-gate` is commit-gate.ts's. `--print` writes the plan as JSON (each check's
// stable id and command, the CI-only lanes, every area with its patterns, the e2e run) and runs nothing; a malformed
// table refuses naming policy/gate/table.ts before any plan is made. Exit codes: 0 green, 1 red or refused, 2 usage,
// 130 interrupted.
import { readFileSync } from 'node:fs'

const USAGE = `usage: node policy/gate/cli.mjs affected (--base <rev> | --staged) [--only <id>]... [--log-dir <dir>] [--print]
       node policy/gate/cli.mjs push --base <rev> [--only <id>]... [--log-dir <dir>] [--print]
       node policy/gate/cli.mjs full [--area <area>]... [--only <id>]... [--log-dir <dir>] [--print]
       node policy/gate/cli.mjs check <id>... [--log-dir <dir>] [--print]
       node policy/gate/cli.mjs areas --base <rev>
       node policy/gate/cli.mjs verify-push [<remote> <url>]   (the pre-push hook; ref lines on stdin)
       node policy/gate/cli.mjs actionlint
       node policy/gate/cli.mjs oldest-engine
       node policy/gate/cli.mjs bundle-summary <row log>
       node policy/gate/cli.mjs agents-rows [--check]
       node policy/gate/cli.mjs commit-gate <mode> ...
       node policy/gate/cli.mjs agent-hook pre-tool-use|session-start|planted <command.json>...`

const refuse = (why: string) => {
  process.stderr.write(`gate: ${why}; refusing\n`)
  return 1
}

/** `--name value` pairs and bare flags from `args`, or undefined when an argument is not one `allowed` names. */
function parse(args: readonly string[], flags: readonly string[], options: readonly string[]) {
  const seen = new Set<string>()
  const values = new Map<string, string[]>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (flags.includes(arg)) seen.add(arg)
    else if (options.includes(arg) && index + 1 < args.length) values.set(arg, [...values.get(arg) ?? [], args[++index] ?? ''])
    else return undefined
  }
  return { seen, values }
}

/** The gate's exit code for the command line `args` in the repository at `ROOT`. */
export async function main(ROOT: string, args: readonly string[]): Promise<number> {
  if (args[0] === 'commit-gate') {
    // The hooks' pre-commit and pre-merge-commit are the commit lane over the staged change (2.1-M198, 2.1-M230).
    const [, hook, ...extra] = args
    if ((hook === 'pre-commit' || hook === 'pre-merge-commit') && !extra.length) return main(ROOT, ['affected', '--staged'])
    let gate
    try {
      gate = await import('./commit-gate.ts')
    } catch (error) {
      return refuse(`policy/gate/commit-gate.ts or a module it imports cannot be loaded: ${(error as Error).message}`)
    }
    return gate.commitGate(ROOT, args.slice(1))
  }
  // The Claude Code hooks (agent-hooks.ts), which need no gate table.
  if (args[0] === 'agent-hook') return (await import('./agent-hooks.ts')).agentHook(ROOT, args.slice(1))
  let modules
  try {
    modules = await Promise.all([import('./table.ts'), import('./plan.ts'), import('./run.ts'), import('./agents-rows.ts')])
  } catch (error) {
    return refuse(`policy/gate/table.ts or a module beside it cannot be loaded: ${(error as Error).message}`)
  }
  const [{ TableError, validTable }, plan, run, rows] = modules
  const [mode, ...rest] = args
  try {
    validTable()
    if (mode === 'actionlint' && !rest.length) return run.runActionlint(ROOT)
    // git runs the pre-push hook with the remote's name and URL, and the pushed refs on stdin (2.1-Q266).
    if (mode === 'verify-push' && rest.length <= 2) {
      return (await import('./verify-push.ts')).verifyPush(ROOT, readFileSync(0, 'utf8'))
    }
    if (mode === 'oldest-engine' && !rest.length) return (await import('./oldest-engine.ts')).runOldestEngine(ROOT)
    if (mode === 'bundle-summary' && rest.length === 1) return (await import('./bundle-summary.ts')).runBundleSummary(rest[0] ?? '')
    if (mode === 'agents-rows') {
      const parsed = parse(rest, ['--check'], [])
      if (!parsed) return usage()
      if (!parsed.seen.has('--check')) {
        process.stdout.write(`${rows.rowsText()}\n`)
        return 0
      }
      const faults = rows.agentsRowFaults(ROOT)
      for (const fault of faults) process.stdout.write(`${fault}\n`)
      return faults.length ? 1 : 0
    }
    if (mode === 'areas') {
      const base = parse(rest, [], ['--base'])?.values.get('--base')
      if (base?.length !== 1) return usage()
      process.stdout.write(`${JSON.stringify(plan.areasJson(ROOT, plan.changed(ROOT, base[0], false)), null, 2)}\n`)
      return 0
    }
    let made
    let parsed
    let staged = false
    if (mode === 'affected') {
      parsed = parse(rest, ['--staged', '--print'], ['--base', '--only', '--log-dir'])
      const base = parsed?.values.get('--base')
      staged = parsed?.seen.has('--staged') ?? false
      if (!parsed || staged === (base !== undefined) || (base?.length ?? 1) !== 1) return usage()
      made = plan.planAffected(ROOT, plan.changed(ROOT, base?.[0], staged), staged, base?.[0])
    } else if (mode === 'push') {
      parsed = parse(rest, ['--print'], ['--base', '--only', '--log-dir'])
      const base = parsed?.values.get('--base')
      if (!parsed || base?.length !== 1) return usage()
      made = plan.planPush(ROOT, plan.changed(ROOT, base[0], false), base[0])
    } else if (mode === 'full') {
      parsed = parse(rest, ['--print'], ['--area', '--only', '--log-dir'])
      if (!parsed) return usage()
      made = plan.planFull(parsed.values.get('--area') ?? [])
    } else if (mode === 'check') {
      const ids = rest.filter((arg, index) => !arg.startsWith('--') && rest[index - 1] !== '--log-dir')
      parsed = parse(rest.filter((arg) => !ids.includes(arg)), ['--print'], ['--log-dir'])
      if (!parsed || !ids.length) return usage()
      made = plan.planChecks(ids)
    } else {
      return usage()
    }
    const only = parsed.values.get('--only')
    if (only) made = plan.onlyChecks(made, only)
    const logDir = parsed.values.get('--log-dir')
    if ((logDir?.length ?? 0) > 1) return usage()
    plan.refuseSharedTarget(ROOT, made.checks)
    if (rest.includes('--print')) {
      process.stdout.write(`${JSON.stringify(plan.planJson(made), null, 2)}\n`)
      return 0
    }
    const execute = () => run.execute(ROOT, made.checks, made.e2e, made.notes, staged, process.env, logDir?.[0])
    // Only the whole pre-push lane stamps its commit: `--only` runs part of it (2.1-Q266; design check AR1).
    const pushed = mode === 'push' && !only ? parsed.values.get('--base')?.[0] : undefined
    if (pushed !== undefined) return await (await import('./stamp.ts')).pushAndStamp(ROOT, pushed, made, execute)
    return await execute()
  } catch (error) {
    if (error instanceof TableError) {
      for (const fault of error.message.split('\n')) process.stderr.write(`gate: ${fault}\n`)
      return refuse('the gate table is malformed: no plan was made')
    }
    if (error instanceof plan.GateError) return refuse(error.message)
    throw error
  }
}

function usage() {
  process.stderr.write(`${USAGE}\n`)
  return 2
}
