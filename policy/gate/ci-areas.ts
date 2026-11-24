// policy/gate/ci-areas.ts: the one changed-area output table both build.yml and ci-parity read (canopi-tazgx).
import { spawnSync } from 'node:child_process'
import { areasJson, changed, gitEnv } from './plan.ts'
import { TABLE, type Table } from './table.ts'

/** build.yml `changes` outputs whose area jobs follow `code` on pushes and their own area on PRs. */
export const CI_CODE_AREAS: Readonly<Record<string, string>> = {
  rust: 'rust',
  frontend: 'frontend',
  policy: 'policy-tooling',
  tauri: 'tauri-command',
  contracts: 'shared-contracts',
  species: 'species-catalog',
  packaging: 'packaging',
  workflows: 'workflows',
}

/** build.yml `changes` outputs for called lanes that always follow their own area when the base is known. */
export const CI_CALLED_AREAS: Readonly<Record<string, string>> = {
  real_app: 'real-app',
  web_browsers: 'web-browsers',
  updater: 'updater',
  rollback: 'rollback',
  release_build: 'release-build',
}

/**
 * The exact `GITHUB_OUTPUT` key=value map for build.yml's `changes` job (canopi-tazgx):
 * - Unknown base (empty or not a commit in the checkout): every area is `true`, `supply_chain` is `true` only on PR,
 *   and `tests` is empty.
 * - Known base on PR: every flag follows its own area (`CI_CODE_AREAS`, `CI_CALLED_AREAS`, `supply-chain`).
 * - Known base on push: `CI_CODE_AREAS` follow `code`; `CI_CALLED_AREAS` follow their own area; `supply_chain` is
 *   `false` (`advisories.yml` scans every push to main).
 * - `tests` is populated only when `frontend` is `false`.
 */
export function ciAreasOutputs(
  root: string, base: string | undefined, event: string, paths?: readonly string[], given: Table = TABLE,
): Record<string, string> {
  const isPr = event === 'pull_request'
  const known = paths !== undefined || (Boolean(base) && spawnSync('git', ['cat-file', '-e', `${base}^{commit}`],
    { cwd: root, encoding: 'utf8', env: gitEnv(process.env) }).status === 0)
  const out: Record<string, string> = {}
  if (!known) {
    out['code'] = 'true'
    for (const flag of [...Object.keys(CI_CODE_AREAS), ...Object.keys(CI_CALLED_AREAS)]) out[flag] = 'true'
    out['supply_chain'] = String(isPr)
    out['tests'] = ''
    return out
  }
  const sel = areasJson(root, paths ?? changed(root, base, false), given)
  const has = (area: string) => sel.selected.includes(area)
  const code = String(sel.code)
  out['code'] = code
  for (const [flag, area] of Object.entries(CI_CODE_AREAS)) out[flag] = isPr ? String(has(area)) : code
  for (const [flag, area] of Object.entries(CI_CALLED_AREAS)) out[flag] = String(has(area))
  out['supply_chain'] = isPr ? String(has('supply-chain')) : 'false'
  out['tests'] = out['frontend'] === 'false' ? sel.tests.join(' ') : ''
  return out
}
