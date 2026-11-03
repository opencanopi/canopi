// policy/gate/cli.ts: the gate's command line (2.1-M198, 2.1-Q267; design check AR11, AR18, A9). Run by Node's type
// stripping, with nothing from node_modules, so `areas` serves CI's changes job and a fresh worktree:
//
//   node policy/gate/cli.ts affected --base <rev> [--print]  the checks for what changed since merge-base(rev, HEAD)
//   node policy/gate/cli.ts affected --staged [--print]      the commit lane: the checks for the staged change
//   node policy/gate/cli.ts full [--area <a>]... [--print]   AGENTS.md's Quality gates rows, every area or the named ones
//   node policy/gate/cli.ts areas --base <rev>               the areas a change selects, the vitest files its lane adds
//                                                            and every area's patterns, as JSON, running no tool
//   node policy/gate/cli.ts actionlint                       the pinned actionlint over .github/workflows
//   node policy/gate/cli.ts agents-rows [--check]            AGENTS.md's rows rendered from the table, or their check
//
// `--print` writes the plan as JSON (each check's stable id and command, the CI-only lanes, every area with its patterns,
// the e2e run) and runs nothing. A Node below the engines major runs the gate again on nvm's install of that major, or
// with none refuses in one line before anything else loads, as it does when that Node cannot start or is killed; a
// malformed table refuses naming policy/gate/table.ts before any plan is made. Exit codes: 0 green, 1 red or refused, 2 usage, 130 interrupted.
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enginesNode, engineRefusal } from './engines.ts'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const USAGE = `usage: node policy/gate/cli.ts affected (--base <rev> | --staged) [--print]
       node policy/gate/cli.ts full [--area <area>]... [--print]
       node policy/gate/cli.ts areas --base <rev>
       node policy/gate/cli.ts actionlint
       node policy/gate/cli.ts agents-rows [--check]`

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

async function main(args: readonly string[]): Promise<number> {
  const refusal = engineRefusal(process.version, ROOT)
  if (refusal) {
    const node = enginesNode(ROOT, process.env)
    if (node === undefined) {
      process.stderr.write(`gate: ${refusal}\n`)
      return 1
    }
    // nvm's install of the engines major leads PATH, so the checks' own node and npm are that Node too.
    const again = spawnSync(node, process.argv.slice(1), {
      stdio: 'inherit', env: { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env['PATH'] ?? ''}` },
    })
    if (again.status !== null) return again.status
    if (again.signal === 'SIGINT') return 130
    const why = again.error ? `failed to run (${(again.error as NodeJS.ErrnoException).code ?? again.error.message})`
      : `was stopped by ${again.signal ?? 'an unknown cause'}`
    process.stderr.write(`gate: ${refusal}; ${node} ${why}\n`)
    return 1
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
    let staged = false
    if (mode === 'affected') {
      const parsed = parse(rest, ['--staged', '--print'], ['--base'])
      const base = parsed?.values.get('--base')
      staged = parsed?.seen.has('--staged') ?? false
      if (!parsed || staged === (base !== undefined) || (base?.length ?? 1) !== 1) return usage()
      made = plan.planAffected(ROOT, plan.changed(ROOT, base?.[0], staged), staged, base?.[0])
    } else if (mode === 'full') {
      const parsed = parse(rest, ['--print'], ['--area'])
      if (!parsed) return usage()
      made = plan.planFull(parsed.values.get('--area') ?? [])
    } else {
      return usage()
    }
    plan.refuseSharedTarget(ROOT, made.checks)
    if (rest.includes('--print')) {
      process.stdout.write(`${JSON.stringify(plan.planJson(made), null, 2)}\n`)
      return 0
    }
    return await run.execute(ROOT, made.checks, made.e2e, made.notes, staged)
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

process.exitCode = await main(process.argv.slice(2))
