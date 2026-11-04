// What a change selects (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q205, 2.1-Q267; canopi-f47t.52.228.10): each case stages a
// change in a planted repository holding a copy of the real gate and reads `affected ... --print`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dialogSpecs, planAffected, reaching } from './plan.ts'
import { git, PLANTED_IMAGE, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

let repo: PlantedRepo
beforeEach(() => { repo = new PlantedRepo() })
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

const POLICY_SELF_TEST = 'cd desktop/web && npm run test:policies:self-test'
/** The policy tooling's commit-lane checks, in the table's order (POLICY_COMMIT). */
const COMMIT_POLICIES = ['check', 'node', 'generate', 'generate:self-test', 'ast-grep']
  .map((script) => `cd desktop/web && npm run test:policies:${script}`)
const POLICIES = [POLICY_SELF_TEST, ...COMMIT_POLICIES]
/** Each lane's planted cases the policy-tooling area runs (design check AR8). */
const PLANTED = ['self-test', 'push:self-test', 'bundle:self-test']
  .map((script) => `cd desktop/web && ${script.startsWith('push') ? 'CANOPI_SKIP_BUNDLED_DB=1 ' : ''}npm run test:policies:${script}`)
const PUSH_CHECK = 'cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push'
const TYPECHECK = 'cd desktop/web && npm run typecheck'
const CHECK_UI = 'cd desktop/web && npm run check:ui'
const ACTIONLINT = 'node policy/gate/cli.mjs actionlint'
const CHECK_TYPES = 'cd desktop/web && npm run check:types'

describe('affected selection (canopi-f47t.52.228.10)', () => {
  it('canopi-f47t.52.228.10: a policy change runs the policy lane', () => {
    expect(repo.checks(['policy/rules.json'])).toEqual(expect.arrayContaining(POLICIES))
    expect(repo.checks(['policy/check.mjs'], true)).toEqual(expect.arrayContaining(COMMIT_POLICIES))
  })

  it('canopi-f47t.52.228.54: only the policy tooling and its adapters\' inputs run the planted cases, every lane\'s (AR8, 4b)', () => {
    // A push-lane adapter under policy/ ran its planted cases only in CI (connections review 4b); a one-line .rs or .ts
    // change ran the commit lane's, and a .rs change the push lane's, though no policy tooling changed.
    for (const path of ['policy/adapters/clippy.mjs', 'policy/check.mjs', 'policy/ratchets/file-size.json', 'sgconfig.yml',
      'clippy.toml', 'deny.toml', 'rust-toolchain.toml', 'desktop/web/package-lock.json', 'scripts/agent_hooks.py',
      // The commit-gate adapter judges the gate-* cases with policy/gate/commit-gate.ts and what it imports.
      'policy/gate/commit-gate.ts', 'policy/gate/deletion-guard.ts']) {
      repo.reset()
      const checks = repo.checks([path])
      expect(checks, path).toEqual(expect.arrayContaining([...PLANTED, PUSH_CHECK]))
    }
    for (const path of ['desktop/src/lib.rs', 'desktop/web/src/app/x.ts', 'scripts/foo.py']) {
      repo.reset()
      const checks = repo.checks([path])
      expect(checks.filter((check) => /test:policies:[a-z:]*self-test/.test(check) && !check.includes('generate')), path).toEqual([])
    }
  })

  it('canopi-f47t.52.228.54: an adapter\'s config change runs every lane\'s planted cases, which catch a silenced rule', () => {
    // Each config oxlint, knip, dependency-cruiser, jscpd and osv-scanner read is an adapter input: an edit that silences
    // a rule there is caught only by the planted cases run against it (planted-silent).
    for (const path of ['desktop/web/.oxlintrc.json', 'desktop/web/knip.json', 'desktop/web/.dependency-cruiser.cjs',
      'desktop/web/.dependency-cruiser.web.cjs', 'desktop/web/.dependency-cruiser.policy.cjs', '.jscpd.json', 'osv-scanner.toml']) {
      repo.reset()
      expect(repo.checks([path]), path).toEqual(expect.arrayContaining(PLANTED))
    }
  })

  it('canopi-f47t.52.228.54: the GeoLibre CLI build script runs the Rust area, whose CI turns lidar-native on', () => {
    // lidar-native builds the CLI with this script (its cache key hashes it) and runs the LiDAR lanes against it.
    expect(repo.checks(['scripts/build-geolibre-cli.sh'])).toContain('cargo fmt --all -- --check')
  })

  it('canopi-f47t.52.228.54: every change runs the docs row before push, as CI\'s docs job does (A5)', () => {
    // The docs checker reads the code paths the docs name, so a code change alone can break a guide: CI's docs job runs
    // on every change, and the affected lane does too; the commit lane runs it only for a docs path.
    expect(repo.checks(['desktop/src/lib.rs'])).toEqual(expect.arrayContaining(['python3 scripts/check_docs.py',
      `python3 scripts/check_docs.py --drift ${repo.base}`]))
    repo.reset()
    expect(repo.checks(['desktop/src/lib.rs'], true)).not.toContain('python3 scripts/check_docs.py')
  })

  it('canopi-f47t.52.228.54: the pre-push lane runs each selected area\'s full row and every-change rows, as CI does (A13, AR22)', () => {
    const push = (path: string) => {
      repo.reset()
      repo.stage(path)
      return repo.printed(['push', '--base', repo.base]).checks.map((check) => check.id)
    }
    const rust = push('desktop/src/lib.rs')
    expect(rust).toEqual(expect.arrayContaining(['cargo-locked', 'fmt', 'clippy', 'cov', 'policy-check-push', 'docs', 'docs-drift',
      'docs-tests', 'playwright-pins', 'script-tests']))
    expect(rust, 'cov runs the workspace tests, native_command_policy among them').not.toContain('native-command-policy')
    expect(rust).not.toContain('cargo-test')
    expect(rust, 'the scripts row runs every script test').not.toContain('unittest-scripts.test_check_docs')
    const docs = push('docs/a.md')
    expect(docs).toEqual(expect.arrayContaining(['docs', 'docs-drift', 'docs-tests', 'playwright-pins', 'script-tests']))
    expect(docs).not.toContain('cov')
    const web = push('desktop/web/src/app/x.ts')
    expect(web).toEqual(expect.arrayContaining(['typecheck', 'coverage', 'build', 'build-web', 'policy-bundle']))
    expect(web.filter((id) => id.startsWith('vitest-')), 'the coverage run holds every Vitest file').toEqual([])
    expect(push('.beads/issues.jsonl')).toEqual(expect.arrayContaining(['closed-beads', 'docs', 'script-tests']))
  })

  it('canopi-f47t.52.228.54: every change runs the Playwright pins before push and a changed script its own tests in the affected lane', () => {
    expect(repo.checks(['README.md'])).toContain('python3 scripts/check_playwright_pins.py')
    repo.reset()
    const checks = repo.checks(['scripts/check_docs_policy.py'])
    expect(checks).not.toContain('python3 -m unittest discover -s scripts')
  })

  it('canopi-f47t.52.228.10: a docs change runs the docs row', () => {
    expect(repo.checks(['docs/a.md'])).toEqual(['python3 scripts/check_docs.py', `python3 scripts/check_docs.py --drift ${repo.base}`,
      'python3 scripts/check_playwright_pins.py'])
    expect(repo.checks(['scripts/check_docs_policy.py'])).toContain('python3 -m unittest scripts.test_check_docs')
  })

  it('canopi-f47t.52.228.13: an English locale change checks the locale keys against the generator', () => {
    expect(repo.checks(['desktop/web/src/i18n/fr.json'])).not.toContain(CHECK_TYPES)
    repo.reset()
    const checks = repo.checks(['desktop/web/src/i18n/en.json'])
    expect(checks).toContain(CHECK_TYPES)
    expect(checks.filter((check) => check.includes('gen:types')), 'the gate never rewrites a binding it judges').toEqual([])
  })

  it('canopi-f47t.52.228.54: each generated binding and each generator input checks the committed bindings against the generator', () => {
    // CI ran this check on every code change; once only its area selected it, a stale web-catalog-artifact.mjs (a Python
    // contract edited) or a hand-edited settings.ts selected no lane that compares them with what bindings-gen writes.
    const lib = readFileSync(join(REPO_ROOT, 'bindings-gen/src/lib.rs'), 'utf8')
    const outputs = [...lib.matchAll(/^const [A-Z_]+: &str =\s*"(desktop\/[^"]+)";/gm)].map((match) => match[1] ?? '')
    expect(outputs).toEqual(expect.arrayContaining(['desktop/web/src/generated/settings.ts', 'desktop/src/db/plant_filter_fields.rs']))
    for (const path of [...outputs, 'scripts/web_catalog_artifact_contract.py', 'scripts/species_catalog_contract.py',
      'scripts/species_search_normalization.py', 'scripts/schema-contract.json', 'rust-toolchain.toml']) {
      repo.reset()
      expect(repo.checks([path]), path).toContain(CHECK_TYPES)
    }
  })

  it('canopi-f47t.52.228.10: a Rust change in the commit lane runs only fmt and the commit policy families', () => {
    expect(repo.checks(['desktop/src/lib.rs'], true)).toEqual(['cargo fmt --all -- --check', ...COMMIT_POLICIES])
  })

  it('canopi-f47t.52.228.54: every lane runs each cheap family whose scope a changed path matches (A12)', () => {
    // C1 found a commit adding a *.py over the python-lines ratchet passing the commit lane: the one check list selects
    // file-size, test-location and python-lines by their ratchets' scopes wherever no whole policy check runs.
    repo.linkGlobEngine()
    const cheap = (...families: string[]) => `cd desktop/web && npm run test:policies:family -- ${families.map((id) => `--family ${id}`).join(' ')}`
    expect(repo.checks(['scripts/new.py'], true)).toContain(cheap('file-size', 'python-lines'))
    repo.reset()
    expect(repo.checks(['desktop/web/src/__tests__/x.test.ts'], true)).toContain(cheap('file-size', 'test-location'))
    repo.reset()
    expect(repo.checks(['docs/a.md'], true).join(' ; ')).not.toContain('--family')
    repo.reset()
    const affected = repo.checks(['scripts/new.py'])
    expect(affected, 'the whole commit-lane check already observes them').toContain('cd desktop/web && npm run test:policies:check')
    expect(affected.join(' ; ')).not.toContain('--family')
  })

  it('canopi-f47t.52.228.54: unmounted: with no glob engine installed the commit lane names the cheap families it could not select', () => {
    repo.stage('scripts/new.py', 'docs/a.md')
    const printed = repo.printed(['affected', '--staged'])
    expect(printed.checks.map((check) => check.command).join(' ; ')).not.toContain('--family')
    expect(printed.notes).toContain('desktop/web/node_modules/picomatch is missing (run npm ci in desktop/web): file-size, test-location, '
      + 'python-lines run at the affected gate')
  })

  it('canopi-f47t.52.228.10: the commit lane names a change no commit check covers', () => {
    // An area with no commit checks (species catalog, shared contracts, LiDAR) covers nothing here; docs paths run DOCS.
    repo.stage('scripts/foo.py', '.github/workflows/x.yml', 'desktop/web/src/app/x.ts', 'scripts/species_catalog_contract.py',
      'canopi-types/plant-filter-fields.json', 'docs/guides/a.md')
    const printed = repo.printed(['affected', '--staged'])
    expect(printed.checks.map((check) => check.command)).toContain(TYPECHECK)
    // canopi-types/ and the species catalog contract are Rust inputs (AR2), so the Rust row's fmt covers them.
    const covers = 'no commit check covers .github/workflows/x.yml, scripts/foo.py'
    expect(printed.notes).toContain(`${covers}; the affected gate runs their checks`)
    expect(repo.gate(['affected', '--staged']).stderr).toContain(covers)
  })

  it('canopi-f47t.52.228.14: a desktop change names the real-app lane and a docs change does not', () => {
    // F5's Desktop real-app suite (2.1-M213) is a CI lane no local run makes: named for what triggers it, never run.
    const lane = 'CI lane desktop-real-app.yml'
    repo.stage('desktop/src/host/mod.rs')
    const printed = repo.printed(['affected', '--base', repo.base])
    expect(printed.ci_only.map((check) => check.command)).toContain(lane)
    expect(printed.checks.map((check) => check.command)).not.toContain(lane)
    repo.reset()
    repo.stage('docs/guides/a.md')
    expect(repo.printed(['affected', '--base', repo.base]).ci_only.map((check) => check.command)).not.toContain(lane)
  })

  it('canopi-f47t.52.228.54: the axe pair is the a11y area, run only by the workflow whose browsers write its reports', () => {
    // The axe family reads the reports every engine's a11y spec wrote, and its self-test drives Chromium: a local lane
    // names them as CI only, and `full --area a11y` (the browsers workflow's call) runs them.
    const pair = ['cd desktop/web && npm run test:policies:a11y:self-test', 'cd desktop/web && npm run test:policies:a11y']
    repo.stage('desktop/web/src/app/x.ts')
    const printed = repo.printed(['affected', '--base', repo.base])
    expect(printed.selected).toContain('a11y')
    expect(printed.checks.map((check) => check.command)).not.toEqual(expect.arrayContaining([expect.stringContaining('test:policies:a11y')]))
    expect(printed.ci_only.map((check) => check.command)).toEqual(expect.arrayContaining(pair))
    const everything = repo.printed(['full'])
    expect(everything.checks.map((check) => check.command).join(' ; ')).not.toContain('test:policies:a11y')
    expect(repo.printed(['full', '--area', 'a11y']).checks.map((check) => check.command)).toEqual(pair)
  })

  it('canopi-f47t.52.228.10: Rust triggers on sources, manifests and the Rust workflows only', () => {
    expect(repo.checks(['.github/workflows/commit-gate.yml']).join(' ; ')).not.toContain('cargo fmt --all -- --check')
    for (const path of ['canopi-types/src/x.rs', 'Cargo.lock', 'desktop/Cargo.toml', '.github/workflows/build.yml',
      '.github/workflows/release-candidate.yml']) {
      repo.reset()
      expect(repo.checks([path]), path).toContain('cargo fmt --all -- --check')
    }
  })

  it('canopi-f47t.52.228.10: the base lane runs the Rust row without coverage', () => {
    expect(repo.checks(['desktop/web/src/ipc/x.ts'])).toContain('CANOPI_SKIP_BUNDLED_DB=1 cargo test -p canopi-desktop native_command_policy::tests')
    const checks = repo.checks(['desktop/src/lib.rs'])
    expect(checks).toContain('CANOPI_SKIP_BUNDLED_DB=1 cargo clippy --workspace --all-targets -- -D warnings')
    expect(checks).toContain('CANOPI_SKIP_BUNDLED_DB=1 cargo test --workspace')
    expect(checks).toContain('cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push')
    expect(checks, 'the policy-tooling area runs the planted cases (AR8)')
      .not.toContain('cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push:self-test')
    expect(checks).not.toContain('CANOPI_SKIP_BUNDLED_DB=1 cargo cov')
    expect(checks.filter((check) => check.includes('native_command_policy')), 'cargo test --workspace runs it').toEqual([])
  })

  it('canopi-f47t.52.228.10: a toolchain change runs the whole suite, or in the commit lane typecheck and policies', () => {
    expect(repo.checks(['desktop/web/package.json'])).toContain('cd desktop/web && npx vitest run --maxWorkers=4')
    repo.stage('desktop/web/tsconfig.json')
    const staged = repo.printed(['affected', '--staged'])
    expect(staged.checks.map((check) => check.command)).toEqual([TYPECHECK, ...COMMIT_POLICIES])
    expect(staged.notes.join(' ')).toContain('the whole Vitest suite runs at the affected gate')
  })

  it('canopi-f47t.52.228.10: a web change runs typecheck, check:ui, related tests, the families and policies', () => {
    const checks = repo.checks(['desktop/web/src/app/x.ts'])
    expect(checks.slice(0, 2)).toEqual([TYPECHECK, CHECK_UI])
    const related = checks.find((check) => check.includes('vitest related')) ?? ''
    expect(related).toContain('src/app/x.ts')
    expect(related, 'the modules reaching the change, from the cruiser').toContain('src/app/user.ts')
    const families = (checks.find((check) => check.includes('npx vitest run')) ?? '').split(' ')
    for (const test of ['scan', 'harness', 'i18n-copy', 'cited']) expect(families).toContain(`src/__tests__/${test}.test.ts`)
    expect(families).toContain('src/app/user.test.ts')
    expect(families, 'the test beside the changed module').toContain('src/app/x.test.ts')
    expect(families).not.toContain('src/__tests__/plain.test.ts')
    expect(checks.slice(-COMMIT_POLICIES.length)).toEqual(COMMIT_POLICIES)
    expect(checks, 'the policy-tooling area runs the planted cases (AR8)').not.toContain(POLICY_SELF_TEST)
    expect(repo.calls().join(' ')).toContain(String.raw`--reaches ^(?:src/app/x\.ts)$`)
  })

  it('canopi-f47t.52.228.10: a changed script runs the test files split from its test', () => {
    expect(repo.checks(['scripts/foo.py'])).toContain('python3 -m unittest scripts.test_foo_table')
  })

  it('canopi-f47t.52.228.10: every code change runs the families and a changed script its test', () => {
    const checks = repo.checks(['scripts/foo.py'])
    expect(checks).toContain('python3 -m unittest scripts.test_foo')
    expect(checks).toEqual(expect.arrayContaining(COMMIT_POLICIES))
    expect(checks.find((check) => check.includes('npx vitest run'))).toContain('src/__tests__/i18n-copy.test.ts')
    expect(checks.join(' ')).not.toContain('vitest related')
  })

  it('a change to the gate, a module it imports, its hooks or a workflow runs its own Vitest project in both lanes (design check AR20)', () => {
    // The project's files join the lane tests, which CI's scripts job runs when no frontend job does: a PR changing
    // only a hook or commit-gate.yml ran none of the gate's guards on them before, and ci-parity.test.ts reads every
    // workflow.
    const project = ['../../policy/gate/a.test.ts', '../../policy/gate/deep/b.test.ts']
    repo.write({ 'policy/gate/a.test.ts': "it('a', () => {})\n", 'policy/gate/deep/b.test.ts': "it('b', () => {})\n" })
    git(repo.repo, 'add', '-A')
    git(repo.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'gate tests')
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    const gate = ['policy/gate/plan.ts', 'policy/tsconfig.json', 'policy/core/diff.mjs', 'policy/git.mjs', 'policy/selection.mjs',
      '.githooks/commit-msg', '.github/workflows/commit-gate.yml', '.github/workflows/x.yml', 'policy/rules.json', 'policy/adapters/commit-gate.mjs',
      'policy/ratchets/guarded-files.json', 'policy/ratchets/ratchet.schema.json', 'policy/layers.json',
      'policy/fixtures/rules/gate-no-attribution/case.json']
    for (const path of [...gate, 'desktop/web/src/x.ts']) {
      repo.reset(base)
      repo.stage(path)
      const lane = repo.printed(['affected', '--base', base]).checks.map((check) => check.command)
        .find((command) => command.includes('npx vitest run --maxWorkers=4')) ?? ''
      const areas = JSON.parse(repo.gate(['areas', '--base', base]).stdout) as { tests: string[] }
      const want = gate.includes(path) ? expect.arrayContaining(project) : expect.not.arrayContaining([project[0]])
      expect(lane.split(' '), path).toEqual(want)
      expect(areas.tests, path).toEqual(want)
    }
  })

  it('canopi-f47t.52.228.10: the gallery runs the root typecheck and the gallery e2e', () => {
    repo.stage('desktop/web/ui-gallery/main.tsx')
    const printed = repo.printed(['affected', '--base', repo.base])
    const checks = printed.checks.map((check) => check.command)
    expect(checks).toContain(TYPECHECK)
    expect(checks).toContain(CHECK_UI)
    expect(checks.at(-1)).toBe('cd desktop/web && npm run build:web')
    expect(printed.e2e?.specs).toEqual(['e2e/gallery'])
    expect(printed.e2e?.projects).toEqual(['chromium', 'webkit', 'gallery-chromium', 'gallery-webkit'])
  })

  it('canopi-f47t.52.228.10: a global style change runs the canvas e2e in the pinned image', () => {
    repo.stage('desktop/web/src/styles/global.css')
    const e2e = repo.printed(['affected', '--base', repo.base]).e2e
    expect([e2e?.specs, e2e?.projects]).toEqual([['e2e/canvas'], ['chromium', 'webkit']])
    expect(e2e?.image).toBe(PLANTED_IMAGE)
    expect(e2e?.command.startsWith('docker run ')).toBe(true)
    expect(e2e?.command).toContain(`${PLANTED_IMAGE} npx playwright test e2e/canvas`)
    expect(e2e?.command, 'the container keeps its own network; no port is published').not.toContain(' -p ')
    expect(e2e?.command, "the container's network isolates it; the default ports serve").not.toContain('CANOPI_E2E_')
  })

  it('canopi-f47t.52.228.10: the gate hands no port pair to quiet-gates or CI', () => {
    expect(Object.keys(repo.printed(['full', '--area', 'docs']))).not.toContain('ports')
  })

  it('canopi-f47t.52.228.20: a dialog module change runs the specs that drive it, by its data attributes and dialog names (DR13)', () => {
    // .228.20's focus fix in the save-status popover broke draft-persistence.spec.ts in WebKit: the gate selected no spec
    // driving the dialog. A dialog module (role dialog or alertdialog, <dialog>, aria-modal) selects each canvas or
    // gallery spec that reads a data-* attribute only it writes, directly or through an e2e/support helper the spec
    // imports, or opens a dialog by the English name of a locale key it uses; a hook selects the dialogs reaching it.
    repo.write({
      'desktop/web/src/i18n/en.json': JSON.stringify({ save: { title: 'Save problem' }, shared: { close: 'Close' }, rename: { title: 'Rename it' } }),
      'desktop/web/src/components/SaveDialog.tsx': "export const D = () => <div role=\"dialog\" data-save-dialog={kind} "
        + "data-preserve-overlays=\"true\" aria-label={t('save.title')}><button>{t('shared.close')}</button></div>\n",
      'desktop/web/src/components/Other.tsx': 'export const O = () => <div data-preserve-overlays="true" />\n',
      'desktop/web/src/components/Plain.tsx': 'export const P = () => <div data-plain-thing="1" />\n',
      'desktop/web/e2e/canvas/by-attribute.spec.ts': "await page.locator('[data-save-dialog=\"revert\"]').click()\n",
      'desktop/web/e2e/canvas/by-name.spec.ts': "await page.getByRole('dialog', { name: 'Save problem' }).waitFor()\n",
      'desktop/web/e2e/support/save.ts': "export const open = (page) => page.locator('[data-save-dialog]')\n",
      'desktop/web/e2e/canvas/by-helper.spec.ts': "import { open } from '../support/save'\n",
      'desktop/web/e2e/canvas/shared-attribute.spec.ts': "page.locator('[data-preserve-overlays]'); page.getByRole('button', { name: 'Close' })\n",
      'desktop/web/e2e/canvas/plain.spec.ts': "page.locator('[data-plain-thing]')\n",
      'desktop/web/src/app/user.ts': "const el = <aside aria-modal=\"true\" data-user-sheet=\"1\" />\n",
      'desktop/web/e2e/gallery/user.spec.ts': "page.locator('[data-user-sheet]')\n",
      'desktop/web/src/components/Shell.tsx': 'export const Shell = (p) => <div role="dialog" aria-modal="true">{p.children}</div>\n',
      'desktop/web/src/components/Rename.tsx': "import { Shell } from './Shell'\nexport const R = () => <Shell title={t('rename.title')} />\n",
      'desktop/web/e2e/canvas/rename.spec.ts': "await page.getByRole('dialog', { name: 'Rename it' }).waitFor()\n",
    })
    git(repo.repo, 'add', '-A')
    git(repo.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'dialogs')
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    const e2e = (path: string) => {
      repo.reset(base)
      repo.stage(path)
      return repo.printed(['affected', '--base', base]).e2e
    }
    const save = e2e('desktop/web/src/components/SaveDialog.tsx')
    expect(save?.specs).toEqual(expect.arrayContaining(['e2e/canvas/by-attribute.spec.ts', 'e2e/canvas/by-helper.spec.ts',
      'e2e/canvas/by-name.spec.ts']))
    expect(save?.specs).not.toContain('e2e/canvas/shared-attribute.spec.ts')
    expect(save?.projects.slice(0, 2)).toEqual(['chromium', 'webkit'])
    expect(e2e('desktop/web/src/components/Plain.tsx')?.specs, 'no dialog module, no dialog spec').not.toContain('e2e/canvas/plain.spec.ts')
    expect(e2e('desktop/web/src/components/Rename.tsx')?.specs, 'a module rendering a shared dialog component is a dialog module')
      .toContain('e2e/canvas/rename.spec.ts')
    const hook = e2e('desktop/web/src/app/hook.ts')
    expect(hook?.specs, 'the stand-in cruiser names src/app/user.ts reaching the hook').toEqual(['e2e/gallery/user.spec.ts'])
    expect(hook?.projects).toEqual(['chromium', 'webkit', 'gallery-chromium', 'gallery-webkit'])
  })

  it('canopi-f47t.52.228.54: a dialog built on the shared WorkspaceDialog runs the canvas specs that open it by name (DR13)', () => {
    // RenameZoneDialog and KeyboardShortcutsDialog hold no role="dialog" of their own: WorkspaceDialog renders it.
    expect(dialogSpecs(REPO_ROOT, ['src/components/canvas/RenameZoneDialog.tsx'])).toContain('e2e/canvas/touch.spec.ts')
    expect(dialogSpecs(REPO_ROOT, ['src/components/shared/KeyboardShortcutsDialog.tsx'])).toContain('e2e/canvas/overview-tools.spec.ts')
  })

  it('canopi-f47t.52.228.10: a changed spec runs itself and beads run only the closed-bead check', () => {
    repo.stage('desktop/web/e2e/canvas/a.spec.ts')
    expect(repo.printed(['affected', '--base', repo.base]).e2e?.specs).toEqual(['e2e/canvas/a.spec.ts'])
    git(repo.repo, 'reset', '-q')
    expect(repo.checks(['.beads/issues.jsonl'], true)).toEqual(['node policy/check.mjs --closed-beads'])
  })

  it('canopi-f47t.52.228: a bead-only change runs the closed-bead check in every lane', () => {
    for (const staged of [true, false]) {
      const plan = planAffected(repo.repo, ['.beads/issues.jsonl'], staged, 'HEAD')
      expect([plan.checks.map((check) => check.id), plan.e2e], String(staged)).toEqual([['closed-beads'], undefined])
    }
  })

  it('canopi-f47t.52.228.54: the tauri-command area is ipc/ and each file the invoke-only-in-ipc ratchet still lists (AR12)', () => {
    // An invoke outside ipc/ is ratchet debt: its file reaches a native command, so a change to it runs the native
    // command policy as an ipc/ change does; the ratchet holds no entry today, so ipc/ alone selects it.
    const ratchet = 'policy/ratchets/invoke-only-in-ipc.json'
    const selected = (path: string) => {
      repo.reset()
      repo.stage(path)
      return (JSON.parse(repo.gate(['areas', '--base', repo.base]).stdout) as { selected: string[] }).selected
    }
    expect(selected('desktop/web/src/ipc/x.ts')).toContain('tauri-command')
    expect(selected('desktop/web/src/app/x.ts')).not.toContain('tauri-command')
    repo.write({ [ratchet]: JSON.stringify({ family: 'invoke-only-in-ipc', entries: { 'desktop/web/src/app/x.ts': { count: 1 } } }) })
    git(repo.repo, 'add', ratchet)
    git(repo.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'debt')
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    repo.reset(base)
    repo.stage('desktop/web/src/app/x.ts')
    expect((JSON.parse(repo.gate(['areas', '--base', base]).stdout) as { selected: string[] }).selected).toContain('tauri-command')
  })

  it('canopi-f47t.52.228.54: missing: an invoke-only-in-ipc ratchet missing at plan time makes areas refuse, never under-select', () => {
    const ratchet = 'policy/ratchets/invoke-only-in-ipc.json'
    git(repo.repo, 'rm', '-q', ratchet)
    repo.stage('desktop/web/src/app/x.ts')
    for (const args of [['areas', '--base', repo.base], ['affected', '--base', repo.base, '--print'], ['affected', '--staged', '--print']]) {
      const run = repo.gate(args)
      expect(run.status, args.join(' ')).toBe(1)
      expect(run.stdout, args.join(' ')).toBe('')
      expect(run.stderr).toContain(`the tauri-command area reads ${ratchet}, which is missing or unreadable`)
    }
  })

  it('canopi-f47t.52.228.10: areas selects without running a tool', () => {
    repo.stage('desktop/web/src/app/x.ts', 'Cargo.lock')
    const run = repo.gate(['areas', '--base', repo.base])
    expect(run.status, run.stderr).toBe(0)
    const printed = JSON.parse(run.stdout) as { selected: string[], areas: { name: string }[] }
    expect(printed.selected).toEqual(['rust', 'frontend', 'packaging', 'real-app', 'a11y'])
    expect(printed.areas.map((area) => area.name).slice(0, 2)).toEqual(['rust', 'tauri-command'])
    expect(repo.calls(), "no cruiser: CI's changes job has no node_modules").toEqual([])
  })

  it('canopi-f47t.52.228.10: a file the toolchain scanner reads runs its tests, never the frontend row', () => {
    // A change to a hook, workflow, script or guide alone runs toolchain-typecheck.test.ts and each test naming it (ios,
    // wiring); CI runs these (`areas`' tests), not the Frontend row; typecheck and check:ui stay out.
    const scan = 'desktop/web/src/__tests__/toolchain-typecheck.test.ts'
    repo.write({ [scan]: "import { readdirSync } from 'node:fs'\n" })
    git(repo.repo, 'add', scan)
    git(repo.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'scanner')
    const base = git(repo.repo, 'rev-parse', 'HEAD')
    const alone = ['src/__tests__/toolchain-typecheck.test.ts']
    const families = ['cited', 'harness', 'i18n-copy', 'scan', 'toolchain-typecheck'].map((name) => `src/__tests__/${name}.test.ts`)
    const [ios, wiring] = ['ios', 'wiring'].map((name) => [...families, `src/__tests__/${name}.test.ts`].sort())
    const cases: [string, string[] | undefined][] = [['.githooks/pre-commit', families], ['.github/workflows/desktop-real-app.yml', families],
      ['.github/workflows/web-edition-browsers.yml', ios], ['.github/workflows/build.yml', wiring], ['scripts/foo.sh', families],
      ['docs/guides/x.md', alone], ['README.md', alone], ['AGENTS.md', alone]]
    for (const [path, tests] of cases) {
      repo.reset(base)
      repo.stage(path)
      const areas = JSON.parse(repo.gate(['areas', '--base', base]).stdout) as { selected: string[], tests: string[] }
      expect(areas.selected, path).not.toContain('frontend')
      expect(areas.tests, path).toEqual(tests)
      const checks = repo.printed(['affected', '--base', base]).checks.map((check) => check.command)
      expect(checks, path).toContain(`cd desktop/web && npx vitest run --maxWorkers=4 ${tests?.join(' ')}`)
      expect(checks, path).not.toContain(CHECK_UI)
      expect(repo.printed(['affected', '--staged']).checks.map((check) => check.command), path).not.toContain(TYPECHECK)
    }
    for (const path of ['.beads/issues.jsonl', 'docs/plans/x.md']) { // beads and unscanned docs name no tests
      repo.reset(base)
      repo.stage(path)
      expect((JSON.parse(repo.gate(['areas', '--base', base]).stdout) as { tests: string[] }).tests, path).toEqual([])
    }
  })

  it('canopi-f47t.52.228.10: a changed workflow runs the pinned actionlint and the commit lane does not', () => {
    // GitHub refused a workflow only a scratch run saw (canopi-f47t.52.228.15.1): a workflow or actionlint config change
    // runs actionlint at the affected gate; the commit lane stays offline, so it names the path instead.
    for (const path of ['.github/workflows/x.yml', '.github/actionlint.yaml', '.github/actions/x/action.yml']) {
      repo.reset()
      expect(repo.checks([path]), path).toContain(ACTIONLINT)
      expect(repo.printed(['affected', '--staged']).checks.map((check) => check.command), path).not.toContain(ACTIONLINT)
    }
    repo.reset()
    expect(repo.checks(['desktop/web/src/app/x.ts'])).not.toContain(ACTIONLINT)
  })

  it('canopi-f47t.52.228.10: the affected set comes from the real dependency graph', () => {
    const cruiser = join(REPO_ROOT, 'desktop/web/node_modules/.bin/depcruise')
    expect(existsSync(cruiser), 'desktop/web/node_modules is installed wherever the gate tests run').toBe(true)
    const reached = reaching(REPO_ROOT, ['src/app/design-edit/budget.ts'])
    expect(reached).toContain('src/app/design-edit/index.ts')
    expect(reached).toContain('src/__tests__/budget-actions.test.ts')
    expect(reached).not.toContain('src/app/design-edit/budget.ts')
  })
})

describe('planning is pure and reads the index safely (2.1-Q267)', () => {
  it('retried: areas and --print give identical output on a rerun and write nothing', () => {
    repo.stage('desktop/web/src/app/x.ts', 'docs/a.md', 'Cargo.lock')
    const before = git(repo.repo, 'status', '--porcelain', '--ignored')
    for (const args of [['areas', '--base', repo.base], ['affected', '--base', repo.base, '--print'], ['affected', '--staged', '--print'],
      ['full', '--print']]) {
      const first = repo.gate(args)
      const second = repo.gate(args)
      expect(first.status, first.stderr).toBe(0)
      expect(second.stdout, args.join(' ')).toBe(first.stdout)
    }
    expect(git(repo.repo, 'status', '--porcelain', '--ignored')).toBe(before)
  })

  it('busy: a staged read while another git command holds the index lock is refused by name', () => {
    repo.stage('desktop/web/src/app/x.ts')
    const lock = join(repo.repo, '.git/index.lock')
    writeFileSync(lock, '')
    const run = repo.gate(['affected', '--staged'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`the index is locked (${lock} exists)`)
    expect(run.stderr).toContain('a concurrent commit')
    expect(repo.calls(), 'no check runs on a half-written index').toEqual([])
  })
})

describe('the per-worktree cargo target (2.1-M201)', () => {
  it('canopi-f47t.52.228.10: full rust in a linked worktree needs its own cargo target', () => {
    const linked = join(repo.root, 'linked')
    git(repo.repo, 'worktree', 'add', '-q', '-b', 'linked', linked)
    const refused = repo.gate(['full', '--area', 'rust', '--print'], { cwd: linked })
    expect(refused.status, refused.stdout).toBe(1)
    expect(refused.stderr).toContain('2.1-M201')
    expect(repo.calls()).toEqual([])
    const own = repo.gate(['full', '--area', 'rust', '--print'], { cwd: linked, env: { CARGO_TARGET_DIR: join(repo.root, 't') } })
    expect(own.status, own.stderr).toBe(0)
    expect(repo.gate(['full', '--area', 'docs', '--print'], { cwd: linked }).status).toBe(0)
  })

  it('canopi-f47t.52.228.11: the commit lane never refuses a linked worktree without a cargo target', () => {
    // The pre-commit hook runs from any client (a GUI, an IDE) whose shell may lack CARGO_TARGET_DIR; the per-worktree
    // target rule (2.1-M201) holds at the affected and full gates.
    const linked = join(repo.root, 'linked')
    git(repo.repo, 'worktree', 'add', '-q', '-b', 'linked', linked)
    for (const path of ['desktop/src/lib.rs', 'policy/zz-probe.txt']) {
      repo.write({ [path]: 'x\n' }, linked)
      git(linked, 'add', path)
    }
    const run = repo.gate(['affected', '--staged', '--print'], { cwd: linked })
    expect(run.status, run.stderr).toBe(0)
    expect((JSON.parse(run.stdout) as { checks: { command: string }[] }).checks.map((check) => check.command))
      .toEqual(expect.arrayContaining(COMMIT_POLICIES))
  })

  it('canopi-f47t.52.228.10: a shared cargo target is refused with the per-stream hint', () => {
    // Two worktrees on one shared target wait on cargo's build lock, so the retired shared-build value is refused
    // wherever it is set, and the hint names the fix.
    const linked = join(repo.root, 'linked')
    git(repo.repo, 'worktree', 'add', '-q', '-b', 'linked', linked)
    const shared = join(repo.root, '.rq-scratch/shared-build/target')
    for (const cwd of [linked, repo.repo]) {
      const run = repo.gate(['full', '--area', 'rust', '--print'], { cwd, env: { CARGO_TARGET_DIR: shared } })
      expect(run.status, run.stdout).toBe(1)
      expect(run.stderr).toContain('shared-build')
      expect(run.stderr).toContain('.rq-scratch/targets/<stream>/target')
    }
    expect(repo.calls()).toEqual([])
    const own = join(repo.root, '.rq-scratch/targets/linked/target')
    expect(repo.gate(['full', '--area', 'rust', '--print'], { cwd: linked, env: { CARGO_TARGET_DIR: own } }).status).toBe(0)
    expect(repo.gate(['full', '--area', 'docs', '--print'], { cwd: linked, env: { CARGO_TARGET_DIR: shared } }).status,
      'a gate that builds nothing through cargo ignores the target').toBe(0)
  })
})
