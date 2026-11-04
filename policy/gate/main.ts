// policy/gate/main.ts: the gate's command line (2.1-M198, 2.1-Q267; design check AR11, AR18), run by the entry
// policy/gate/cli.mjs on the engines Node, whose header lists the modes; `commit-gate` is commit-gate.ts's. `--print` writes the plan as JSON (each check's
// stable id and command, the CI-only lanes, every area with its patterns, the e2e run) and runs nothing; a malformed
// table refuses naming policy/gate/table.ts before any plan is made. Exit codes: 0 green, 1 red or refused, 2 usage,
// 130 interrupted.
const USAGE = `usage: node policy/gate/cli.mjs affected (--base <rev> | --staged) [--only <id>]... [--log-dir <dir>] [--print]
       node policy/gate/cli.mjs full [--area <area>]... [--only <id>]... [--log-dir <dir>] [--print]
       node policy/gate/cli.mjs areas --base <rev>
       node policy/gate/cli.mjs actionlint
       node policy/gate/cli.mjs oldest-engine
       node policy/gate/cli.mjs agents-rows [--check]
       node policy/gate/cli.mjs commit-gate <mode> ...`

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
    if (mode === 'oldest-engine' && !rest.length) return (await import('./oldest-engine.ts')).runOldestEngine(ROOT)
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
    } else if (mode === 'full') {
      parsed = parse(rest, ['--print'], ['--area', '--only', '--log-dir'])
      if (!parsed) return usage()
      made = plan.planFull(parsed.values.get('--area') ?? [])
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
    return await run.execute(ROOT, made.checks, made.e2e, made.notes, staged, process.env, logDir?.[0])
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
