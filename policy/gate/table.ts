// policy/gate/table.ts: the one gate table, as data (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q205, 2.1-Q267; contracts §12;
// ADR 0028 Agent enforcement; design check AR11, AR20). Each check has a stable id, the command it runs from its
// directory (leading NAME=value words are its environment) and what it needs; each area maps its anchored path regexes
// (never globs: picomatch through policy/check.mjs is the one glob engine) to its checks per lane, and renders its
// AGENTS.md Quality gates row from a template whose `{id}` placeholders name its checks (agents-rows.ts). An area's
// scans are the files its source-text tests read: they select those tests, never a check or a CI job. validateTable
// refuses a malformed table naming this file, before any plan is made.

export const TABLE_FILE = 'policy/gate/table.ts'
export const WEB = 'desktop/web'
const SKIP_DB = 'CANOPI_SKIP_BUNDLED_DB=1'

export interface Check {
  readonly command: string
  /** The directory it runs from, relative to the repository root; the root when absent. */
  readonly cwd?: string
  /** How the AGENTS.md row writes it, when not its command. */
  readonly shown?: string
  /** The AGENTS.md row names it in prose only, never by placeholder ("its Python tests"). */
  readonly prose?: boolean
  /** Builds through cargo: it takes the build lock and needs a per-worktree target (2.1-M201). */
  readonly cargo?: boolean
  /** A CI lane no local run can make: named, never run. */
  readonly ciOnly?: boolean
  /** The checks this one runs too, so an area they cover needs no run of its own. */
  readonly runs?: readonly string[]
  /** A CI-only lane outside Build & Test: the events of the workflow of its own that runs it (design check A5 (4)). */
  readonly on?: readonly string[]
}

export interface Area {
  readonly name: string
  /** AGENTS.md's Change cell. */
  readonly label: string
  /** AGENTS.md's Run cell, with `{id}` for each of its full checks the row names. */
  readonly row: string
  readonly patterns: readonly string[]
  readonly full: readonly string[]
  readonly affected?: readonly string[]
  /** Checks of the full row the affected lane runs too, each only when a changed path matches its patterns: a check
   * too costly for every change of the area whose inputs are a few files (check:notices reads the lockfiles). */
  readonly affectedWhen?: Readonly<Record<string, readonly string[]>>
  readonly commit?: readonly string[]
  /** Affected checks another selected area's check already runs. */
  readonly coveredBy?: readonly string[]
  /** A path-keyed ratchet whose listed files also select the area, read at plan time (a missing one refuses). */
  readonly ratchet?: string
  /** The workflow build.yml calls (a `uses:` job) when this area is selected, whose jobs run the area's lane, its
   * runnable checks through `full --area <name>` once what they read exists there (the axe reports each engine's browser
   * job writes): no local lane runs it, and `full` with no area leaves it out (design check AR3). */
  readonly workflow?: string
  /** The composite actions (.github/actions/<name>) its CI jobs and called lane run, which select it (inCiHome). */
  readonly actions?: readonly string[]
  /** The affected lane runs this area's row on every change, as CI's job for it does; the commit lane only for its paths. */
  readonly every?: boolean
  readonly scans?: readonly string[]
}

export interface Table {
  readonly checks: Readonly<Record<string, Check>>
  readonly areas: readonly Area[]
  /** The selection rules beside the areas, as anchored regexes. */
  readonly paths: Readonly<Record<PathRule, string>>
  /** The always-run vitest families, by content (a scanner reads source text, a locale test imports a locale file). */
  readonly families: Readonly<Record<'scanner' | 'locale' | 'cited', string>>
  readonly actionlint: { readonly version: string, readonly url: string, readonly sha256: string }
  /** What a build.yml job, or a job of any other workflow (keyed `<file> <job>`), runs that is no gate call (A5 (1)),
   * by job and step name (`*`: the whole job): CI_SETUP for a step that judges nothing (an install, a download, the
   * selection, a report of a failed step), else the ci_only check that step or job is. Every other step is a gate call
   * (ci-parity.test.ts). */
  readonly ci: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export type PathRule = 'toolchain' | 'policy' | 'docsOnly' | 'notDocs' | 'docsValidator' | 'webModule' | 'spec'
  | 'e2eCanvas' | 'e2eGallery' | 'policyGate' | 'webVitestTest'

const web = (command: string, extra: Omit<Check, 'command' | 'cwd'> = {}): Check => ({ command, cwd: WEB, ...extra })
/** The policy tooling's commit-lane checks: the commit families, the policy modules' node:test files, the generated
 * configs and the ast-grep rule tests. */
/**
 * The ratchet families cheap enough for every commit (A12): each runs, by `--family`, wherever a changed path matches
 * its ratchet's scope and no whole policy check runs (C1: a *.py over python-lines passed the commit lane).
 */
export const CHEAP_FAMILIES = ['file-size', 'test-location', 'python-lines'] as const
export const POLICY_COMMIT = ['policy-check', 'policy-node-tests', 'policy-generate', 'policy-generate-self-test', 'ast-grep-test'] as const

// The pinned actionlint (canopi-f47t.52.228.15.1), the Linux x86-64 release CI installs: a bump changes the version and
// the digest (the release's actionlint_<version>_checksums.txt), and build.yml's workflows job equals both.
const ACTIONLINT_VERSION = '1.7.12'
/** What check:notices regenerates THIRD_PARTY_NOTICES.md from, beside the bundles: the lockfiles, the manifests of
 * desktop, of the format worker's module (canopi-format-wasm, cargo-about's second run) and of the workspace members they
 * depend on (the crates cargo-about lists), cargo-about's config and template,
 * the generator and its hand rows, and the file itself. */
const NOTICES_INPUTS = [String.raw`^Cargo\.lock$`, String.raw`^(desktop|canopi-types|canopi-redact|canopi-format-wasm)/Cargo\.toml$`,
  String.raw`^desktop/web/package-lock\.json$`, String.raw`(^|/)THIRD_PARTY_NOTICES\.md$`,
  String.raw`^about\.(toml|hbs)$`, String.raw`^scripts/(generate_notices\.mjs|notices-hand-rows\.json)$`]

/**
 * An area selects on every file its CI job body or called lane lives in (canopi-f47t.52.228.54: a pull request editing
 * the frontend job in build.yml ran no frontend job, and a broken edit merged green): build.yml, which holds each area's
 * job or the call to its lane, the lane's workflow and the composite actions they run. An `every` area's job runs on
 * every change already. table.test.ts derives each area's files from the workflows and holds this to them.
 */
const inCiHome = (area: Area): Area => (area.every ? area : {
  ...area,
  patterns: [...area.patterns, String.raw`^\.github/workflows/build\.yml$`,
    ...area.workflow ? [`^${area.workflow.replaceAll('.', '\\.')}$`] : [], ...(area.actions ?? []).map((name) => String.raw`^\.github/actions/${name}/`)],
})

/** A ci row naming a step that sets a job up and judges nothing. */
export const CI_SETUP = 'setup'

export const TABLE: Table = {
  checks: {
    // A Cargo.lock the manifests would change fails here first: the row's cargo commands take no --locked.
    'cargo-locked': { command: 'cargo fetch --locked' },
    'fmt': { command: 'cargo fmt --all -- --check' },
    'clippy': { command: `${SKIP_DB} cargo clippy --workspace --all-targets -- -D warnings`, cargo: true },
    // cargo-llvm-cov runs every workspace test, so it is the Rust row's test run too (no doctest; 2.1-M327); the gate
    // builds its command from policy/ratchets/coverage.json (llvm-cov.mjs).
    'cov': { command: `${SKIP_DB} node policy/gate/cli.mjs cov`, cargo: true, runs: ['cargo-test'] },
    'cargo-test': { command: `${SKIP_DB} cargo test --workspace`, cargo: true },
    'platform-tests': { command: 'CI job platform-tests: the native tests on macOS and Windows', shown: 'build.yml platform-tests', ciOnly: true },
    'packaging': { command: 'CI job build: the Linux and Apple silicon installers', shown: 'build.yml build', ciOnly: true },
    'packaging-every-platform': { command: 'CI job build: every platform\'s installer', shown: 'build.yml build', ciOnly: true },
    // The policy checker runs one lane per run, each through a package script that is that one command (design check
    // AR8, amending 2.1-M223): lane-unrun reads these checks, so each lane's families and planted cases have a check and a
    // self-test here. The push lane holds the clippy and cargo families, which build canopi-desktop: SKIP_DB (no catalog
    // DB in CI).
    'policy-check': web('npm run test:policies:check'),
    'policy-self-test': web('npm run test:policies:self-test'),
    'policy-check-push': web(`${SKIP_DB} npm run test:policies:push`, { cargo: true }),
    'policy-self-test-push': web(`${SKIP_DB} npm run test:policies:push:self-test`, { cargo: true }),
    'policy-bundle': web('npm run test:policies:bundle'),
    'policy-self-test-bundle': web('npm run test:policies:bundle:self-test'),
    'policy-a11y': web('npm run test:policies:a11y'),
    'policy-self-test-a11y': web('npm run test:policies:a11y:self-test'),
    'policy-node-tests': web('npm run test:policies:node'),
    'policy-generate': web('npm run test:policies:generate'),
    'policy-generate-self-test': web('npm run test:policies:generate:self-test'),
    'ast-grep-test': web('npm run test:policies:ast-grep'),
    // native_command_policy also reads the web files that call invoke(): ipc/ only (AR12).
    'native-command-policy': { command: `${SKIP_DB} cargo test -p canopi-desktop native_command_policy::tests`, cargo: true },
    'check-types': web('npm run check:types', { cargo: true }),
    'typecheck': web('npm run typecheck'),
    // The web project's coverage run; the policy-gate project's is gate-coverage, whose child CLIs it measures too.
    'coverage': web('npm run test:coverage -- --maxWorkers=4 --project web'),
    'gate-coverage': { command: 'node policy/gate/cli.mjs gate-cov' },
    // The bundles alone: the row's typecheck runs before them, and `npm run build` would run it again (DR17).
    'build': web('npm run build:desktop:bundle'),
    'build-web': web('npm run build:web:bundle'),
    // check:notices regenerates the notices from both bundles and cargo-about 0.9.3, which must be on PATH (2.1-M239).
    'notices': web('npm run check:notices'),
    // The Species Search Unicode facts against the pinned Python's unicodedata (.python-version).
    'unicode-facts': { command: 'python3 scripts/species_search_unicode_facts.py check' },
    'species-contract': { command: 'python3 scripts/species_catalog_contract.py check' },
    'species-tests': { command: 'python3 -m unittest scripts.test_species_catalog_contract', prose: true },
    'lidar-native': { command: 'CI job lidar-native: the engine lane', shown: 'lidar-native', ciOnly: true },
    'lidar-comparison': { command: 'the comparison lane (docs/guides/data-library.md)', prose: true, ciOnly: true },
    // The lanes build.yml calls (design check AR3): the Desktop real-app suite (2.1-M213) needs tauri-driver, a WebKit
    // driver and a display (docs/guides/native-and-release.md has the local Linux run); the browser suites need the
    // pinned Playwright image; the updater lane installs and updates real packages.
    'desktop-real-app': { command: 'CI job real-app: the Desktop real-app suite on WebKitGTK and WebView2', shown: 'build.yml real-app', ciOnly: true },
    'web-browsers': { command: 'CI job web-browsers: the canvas and gallery suites in Chromium, WebKit and Firefox, and the format worker in WebKitGTK and Edge', shown: 'build.yml web-browsers', ciOnly: true },
    'updater-e2e': { command: 'CI job updater: N-1 updates itself to N as an AppImage, a .deb and an NSIS install', shown: 'build.yml updater', ciOnly: true },
    'release-build': { command: 'CI job release-build: the Release Candidate\'s preflight and build on every platform as a dry run, publishing nothing', shown: 'build.yml release-build', ciOnly: true },
    'docs': { command: 'python3 scripts/check_docs.py' },
    'docs-drift': { command: 'python3 scripts/check_docs.py --drift origin/main', shown: '--drift origin/main' },
    'docs-tests': { command: 'python3 -m unittest scripts.test_check_docs' },
    // Every Playwright image tag in a tracked file (a README's included) names the locked @playwright/test.
    'playwright-pins': { command: 'python3 scripts/check_playwright_pins.py' },
    // Every scripts/test*.py, found by discovery (its default pattern, so no glob reaches a pasted row), so a new
    // test file runs with no list to edit (2.1-M216).
    'script-tests': { command: 'python3 -m unittest discover -s scripts' },
    // The Release Candidate's package and verify over the Web build, with the release's catalog only CI downloads.
    // OSV, the one advisory scan (design check A17), over a pull request's lockfile changes, with the Renovate config.
    'supply-chain': { command: 'CI job supply-chain: OSV advisories against policy/advisories.json, npm audit signatures and the Renovate config',
      shown: 'build.yml supply-chain', ciOnly: true },
    'web-release': { command: 'CI job frontend: the Web Edition packaged and verified as a release would', shown: 'build.yml frontend', ciOnly: true },
    'closed-beads': { command: 'node policy/check.mjs --closed-beads' },
    // The plan names the families a change's paths reach (CHEAP_FAMILIES) after `--`.
    'cheap-families': web('npm run test:policies:family --'),
    'actionlint': { command: 'node policy/gate/cli.mjs actionlint' },
    // Both builds' chunks parsed by the oldest engine, Debian 12's JavaScriptCore, in its pinned image (A15).
    'oldest-engine': { command: 'node policy/gate/cli.mjs oldest-engine' },
    'pdf-fonts': web('npm run prepare:pdf-fonts'),
    // The lanes outside Build & Test, each a workflow of its own on the events it names (A5 (4)): information, a
    // probe, a schedule or a release step, never a merge's binding check (2.1-Q222).
    'advisories': { command: 'CI workflow advisories.yml: the OSV advisories and npm audit signatures of every push to main, and weekly',
      shown: 'advisories.yml', ciOnly: true, on: ['push', 'schedule', 'workflow_dispatch'] },
    'mutation': { command: 'CI workflow mutation.yml: Stryker and cargo-mutants over the diff, or over an area on dispatch',
      shown: 'mutation.yml', ciOnly: true, on: ['pull_request', 'push', 'workflow_dispatch'] },
    'perf': { command: 'CI workflow performance.yml: the perf scenarios timed in Chromium, information only', shown: 'performance.yml',
      ciOnly: true, on: ['pull_request', 'push', 'workflow_dispatch'] },
    'pdf-production-probe': { command: 'CI workflow pdf-production-probe.yml: the production PDF worker in each platform\'s WebView',
      shown: 'pdf-production-probe.yml', ciOnly: true, on: ['pull_request', 'push', 'workflow_dispatch'] },
    'engine-floor-probe': { command: 'CI workflow engine-floor-probe.yml: both editions booted in old Playwright WebKit images and the listener page in three engines',
      shown: 'engine-floor-probe.yml', ciOnly: true, on: ['workflow_dispatch'] },
    'phone-smoke': { command: 'CI workflow phone-smoke.yml: Safari in iOS simulators and Chrome on an Android emulator',
      shown: 'phone-smoke.yml', ciOnly: true, on: ['pull_request', 'push', 'schedule', 'workflow_dispatch'] },
    'seed': { command: 'CI workflow seed-lane.yml: the suites from random seeds, with their planted failures', shown: 'seed-lane.yml',
      ciOnly: true, on: ['pull_request', 'push', 'schedule'] },
    'update-channel': { command: 'CI workflow update-channel.yml: the update channels moved for a published release',
      shown: 'update-channel.yml', ciOnly: true, on: ['release', 'workflow_dispatch'] },
  },
  areas: ([
    {
      name: 'rust', label: 'Rust',
      row: '`{cargo-locked}`; `{fmt}`; `{clippy}`; `{cov}` above its floor (it runs the workspace tests); `cd desktop/web && {policy-check-push}`; '
        + 'CI `{platform-tests}` and `{packaging}`',
      // Beyond the sources and manifests, what the Rust build and tests read: the desktop shell outside desktop/web (Tauri
      // config, capabilities, icons), the shared contracts and their generator, the scripts and fixtures Rust tests
      // compare against, and the GeoLibre CLI build script that lidar-native's action runs and keys its cache on (design
      // check AR2: build.yml's rust_paths and web_rust_paths, retired); its jobs' actions by inCiHome.
      patterns: [String.raw`\.rs$`, String.raw`(^|/)Cargo\.(toml|lock)$`, String.raw`^(rust-toolchain|clippy|deny)\.toml$`,
        String.raw`^\.cargo/`, String.raw`^\.github/workflows/release-candidate\.yml$`, String.raw`^desktop/(?!web/)`,
        String.raw`^(canopi-types|bindings-gen)/`, String.raw`^desktop/web/src/maplibre/raster-display/fixtures/`,
        String.raw`^scripts/(build-geolibre-cli\.sh|schema-contract\.json|species_catalog_contract\.py|species_search_normalization\.py|web_catalog_artifact_contract\.py)$`],
      actions: ['install-linux-deps', 'cargo-policy-tools', 'build-geolibre-cli', 'package-desktop'],
      full: ['cargo-locked', 'fmt', 'clippy', 'cov', 'policy-check-push', 'platform-tests', 'packaging'],
      affected: ['cargo-locked', 'fmt', 'clippy', 'cargo-test', 'policy-check-push'],
      commit: ['fmt', ...POLICY_COMMIT],
    },
    {
      name: 'tauri-command', label: 'A `#[tauri::command]`',
      row: '`{native-command-policy}`',
      // ipc/ is the only place that invokes native commands (AR12); a file the invoke-only-in-ipc ratchet still lists
      // invokes one too, so it selects the area as well.
      patterns: [String.raw`^desktop/src/.*\.rs$`, String.raw`^desktop/web/src/ipc/`],
      ratchet: 'policy/ratchets/invoke-only-in-ipc.json',
      actions: ['install-linux-deps'],
      full: ['native-command-policy'],
      coveredBy: ['cargo-test'],
    },
    {
      // check:types compares every committed binding with what bindings-gen writes, never rewriting one, so a stale or
      // hand-edited binding fails it: its inputs (the contracts, en.json for generated/locale-keys.ts (2.1-Q211), the
      // Python contracts it runs and what they read, the toolchain whose rustfmt formats the Rust ones) and its outputs
      // (bindings-gen/src/lib.rs's paths) select it; the Unicode facts read canopi-types and the pinned Python.
      name: 'shared-contracts', label: 'Shared contracts (`canopi-types/`, `en.json`)',
      row: '`cd desktop/web && {check-types}` (stale: `npm run gen:types`); `{unicode-facts}`',
      patterns: [String.raw`^canopi-types/`, String.raw`^bindings-gen/`, String.raw`^desktop/web/src/i18n/en\.json$`,
        String.raw`^desktop/web/src/generated/`, String.raw`^desktop/src/(db/plant_filter_fields|design/new_design_defaults|services/lidar/analysis_registry_generated)\.rs$`,
        String.raw`^scripts/(species_catalog_contract\.py|web_catalog_artifact_contract\.py|species_search_normalization\.py|schema-contract\.json)$`,
        String.raw`^rust-toolchain\.toml$`, String.raw`^scripts/species_search_unicode_facts\.py$`, String.raw`^\.python-version$`],
      full: ['check-types', 'unicode-facts'],
    },
    {
      // `^policy/` and the ast-grep config run the policy lane; the typecheck holds the gallery's project (DR17).
      name: 'frontend', label: 'Frontend',
      row: '`cd desktop/web && {typecheck} && {coverage} && {policy-check} && {policy-node-tests} && '
        + '{policy-generate} && {policy-generate-self-test} && {ast-grep-test} && {build} && {build-web} && '
        + '{policy-bundle} && {notices}`; `{gate-coverage}`; `{oldest-engine}`',
      // The notices' inputs select it too: Cargo.lock, whose crates THIRD_PARTY_NOTICES.md and third-party-notices.test.ts
      // name (17a86728d left them stale), and the npm lockfile; the affected lane runs check:notices for them alone.
      // And the crates the Web build compiles into the format worker's module (`build:format-wasm`, Step 2.0.4), whose
      // size is a bundle budget.
      patterns: [String.raw`^desktop/web/(?!.*\.md$)`, String.raw`^policy/`, String.raw`^sgconfig\.yml$`, ...NOTICES_INPUTS,
        String.raw`^canopi-(types|redact|format|format-wasm)/`],
      full: ['typecheck', 'coverage', ...POLICY_COMMIT, 'build', 'build-web', 'policy-bundle', 'notices', 'gate-coverage', 'oldest-engine'],
      affected: ['typecheck'],
      affectedWhen: { notices: NOTICES_INPUTS },
      actions: ['install-linux-deps'],
      commit: ['typecheck'],
      // What toolchain-typecheck.test.ts reads for a bare compiler run (2.1-Q205), beyond desktop/web.
      scans: [String.raw`^\.githooks/`, String.raw`^\.github/workflows/[^/]+\.ya?ml$`, String.raw`^scripts/.+\.(sh|py|mjs|js|ts)$`,
        String.raw`^docs/guides/.+\.md$`, String.raw`^(README|AGENTS)\.md$`],
    },
    {
      // Each lane's planted cases run where the policy tooling or what its adapters run changes (design check AR8):
      // all of policy/ (the commit-gate adapter judges its gate-* cases with policy/gate/commit-gate.ts and what it
      // imports, which the gate's Vitest project never runs), and the adapters' inputs, each the tool or config an
      // adapter runs: ast-grep and suppressions read sgconfig.yml; oxlint, knip, jscpd, dependency-cruiser and tsc run
      // desktop/web's locked packages with its tsconfigs and their own configs (.oxlintrc.json, knip.json, the three
      // .dependency-cruiser*.cjs, /.jscpd.json); osv-scanner reads osv-scanner.toml; clippy runs the pinned toolchain with
      // clippy.toml; cargo-deny reads deny.toml; agent-hooks runs policy/gate/agent-hooks.ts. A config edit that silences
      // a rule is caught only by these planted cases (planted-silent). A push adapter's change runs the push check too.
      name: 'policy-tooling', label: 'Policy tooling (`policy/`, an adapter\'s tool or config)',
      row: '`cd desktop/web && {policy-self-test} && {policy-self-test-push} && {policy-check-push} && {policy-self-test-bundle}`',
      patterns: [String.raw`^policy/`, String.raw`^sgconfig\.yml$`, String.raw`^desktop/web/package(-lock)?\.json$`,
        String.raw`^desktop/web/tsconfig[^/]*\.json$`, String.raw`^(rust-toolchain|clippy|deny)\.toml$`,
        String.raw`^desktop/web/(\.oxlintrc\.json|knip\.json|\.dependency-cruiser[^/]*\.cjs)$`,
        String.raw`^(\.jscpd\.json|osv-scanner\.toml)$`],
      actions: ['install-linux-deps', 'cargo-policy-tools'],
      full: ['policy-self-test', 'policy-self-test-push', 'policy-check-push', 'policy-self-test-bundle'],
    },
    {
      // A packaging input builds every platform's installer (a PR otherwise packages Linux and Apple silicon only): the
      // manifests and toolchain, the build script, the Windows manifest, icons, Tauri config, the sidecar and its smoke,
      // the npm manifests (the Tauri CLI), the PR's NSIS overlay; build.yml and its actions by inCiHome.
      name: 'packaging', label: 'Desktop packaging inputs',
      row: 'CI `{packaging-every-platform}` on every platform',
      patterns: [String.raw`^Cargo\.lock$`, String.raw`^([^/]+/)?Cargo\.toml$`, String.raw`^rust-toolchain\.toml$`,
        String.raw`^desktop/(build\.rs|windows-app-manifest\.xml|updater-endpoints\.json)$`, String.raw`^desktop/(icons|linux|binaries)/`,
        String.raw`^desktop/tauri[^/]*\.json$`, String.raw`^desktop/tauri\.conf`,
        String.raw`^scripts/(build-geolibre-cli\.sh|smoke-bundled-sidecar\.sh|check_windows_manifest\.py)$`,
        String.raw`^desktop/web/package[^/]*\.json$`, String.raw`^\.github/tauri-branch-nsis\.json$`],
      actions: ['install-linux-deps', 'build-geolibre-cli', 'package-desktop'],
      full: ['packaging-every-platform'],
    },
    {
      // What the Release Candidate's build reads beyond the packaging inputs, run by its dry run (canopi-f47t.52.228.61):
      // its workflow, the release updater overlay its builds pass with --config, the smoke script whose repack-deb
      // repacks a beta's .deb, and the package-desktop action, whose updater, beta and preflight-sha paths only a
      // release build takes. Never every platform's packaging (build.yml's build reads none of them but the action).
      // And tauri.conf.json, the version authority with the updater key: the dry run builds its version, so a bump to a
      // beta takes the beta paths. The other manifests stay out, so a dependency bump never pays the release build: the
      // policy checker every one of them selects holds their versions to tauri.conf.json's (policy/release-version.mjs).
      // And updater-e2e.yml, the lane the workflow calls: a dry run skips that job, but GitHub resolves the call when it
      // starts the workflow, so a broken lane breaks the dry run too.
      name: 'release-build', label: 'Release build inputs',
      row: 'CI `{release-build}`',
      workflow: '.github/workflows/release-candidate.yml',
      patterns: [String.raw`^\.github/tauri-release-updater\.json$`, String.raw`^scripts/release_smoke\.py$`,
        String.raw`^desktop/tauri\.conf\.json$`, String.raw`^\.github/workflows/updater-e2e\.yml$`],
      actions: ['install-linux-deps', 'build-geolibre-cli', 'package-desktop'],
      full: ['release-build'],
    },
    {
      // What decides a pull request's advisories (design check A17): the lockfiles osv-scanner reads (the app's, the iOS
      // lane's Appium) and the manifest beside the app's, the exception table and the config it generates, the scanner's
      // adapter and checker, the action that runs them, the main-and-weekly workflow that holds only that action, and the
      // Renovate config the job validates.
      name: 'supply-chain', label: 'Supply chain (lockfiles, `policy/advisories.json`)',
      row: 'CI `{supply-chain}`',
      patterns: [String.raw`^Cargo\.lock$`, String.raw`^desktop/web/(e2e/platform/phones/ios/appium/)?package(-lock)?\.json$`,
        String.raw`^policy/advisories\.json$`, String.raw`^osv-scanner\.toml$`, String.raw`^policy/adapters/osv-scanner\.mjs$`,
        String.raw`^policy/adapters/advisories\.ts$`, String.raw`^renovate\.json$`, String.raw`^\.github/workflows/advisories\.yml$`],
      actions: ['osv-advisories'],
      full: ['supply-chain'],
    },
    {
      name: 'species-catalog', label: 'Species catalog queries',
      row: '`{species-contract}` and its Python tests',
      patterns: [String.raw`^desktop/src/services/species_catalog`, String.raw`^desktop/src/db/`,
        String.raw`^scripts/(test_)?species_catalog_contract\.py$`, String.raw`^scripts/schema-contract\.json$`,
        String.raw`^canopi-types/plant-filter-fields\.json$`],
      full: ['species-contract', 'species-tests'],
    },
    {
      name: 'lidar', label: 'LiDAR services',
      row: 'the engine lane (CI job `{lidar-native}`) and the comparison lane ([data library](docs/guides/data-library.md))',
      patterns: [String.raw`^desktop/src/services/lidar/`],
      actions: ['install-linux-deps', 'build-geolibre-cli'],
      full: ['lidar-native', 'lidar-comparison'],
    },
    {
      name: 'real-app', label: 'Desktop real app',
      row: 'CI `{desktop-real-app}`',
      workflow: '.github/workflows/desktop-real-app.yml',
      patterns: [String.raw`^desktop/`, String.raw`^canopi-types/`, String.raw`^Cargo\.lock$`],
      actions: ['install-linux-deps'],
      full: ['desktop-real-app'],
    },
    {
      // The browsers lane and the axe ratchet over the reports its canvas jobs write (the a11y area widened: one area
      // serves both, as the ratchet reads nothing the browsers did not write). The axe family's self-test drives Chromium,
      // so the called workflow runs the pair after its browser jobs. Only the Web Edition, the gallery, the version About
      // shows (tauri.conf.json) and the policy checker that gates the axe reports reach the browsers.
      name: 'web-browsers', label: 'Web Edition browsers and axe reports',
      row: 'CI `{web-browsers}`, then `cd desktop/web && {policy-self-test-a11y} && {policy-a11y}`',
      workflow: '.github/workflows/web-edition-browsers.yml',
      // The format worker's module instantiated in every engine: the crates it is built from (Step 2.0.4).
      patterns: [String.raw`^desktop/web/(?!.*\.md$)`, String.raw`^desktop/tauri\.conf\.json$`, String.raw`^policy/`,
        String.raw`^canopi-(redact|format|format-wasm)/`],
      actions: ['install-linux-deps'],
      full: ['web-browsers', 'policy-self-test-a11y', 'policy-a11y'],
    },
    {
      // What decides whether an update installs (2.1-M64, M82): the updater and the update flow's files outside its
      // folders (the update contract, the host's exit, operation, single-instance and launch paths, the IPC transport its
      // commands go through, the close guard and app root, the dialogs and the notice row owning the selectors
      // updater.spec.ts drives, the launch notices and the notice queue that raise Update not installed, the release
      // overlay), the scripts the lane runs, and the lockfiles and manifest that pin the Tauri CLI (the .sig format,
      // 2.1-M210) and tauri-plugin-updater.
      name: 'updater', label: 'Updater',
      row: 'CI `{updater-e2e}`',
      workflow: '.github/workflows/updater-e2e.yml',
      patterns: [String.raw`^desktop/src/host/updater/`, String.raw`^desktop/src/commands/update\.rs$`,
        String.raw`^desktop/web/src/app/updates/`, String.raw`^desktop/web/src/ipc/(update|transport)\.ts$`,
        String.raw`^desktop/web/e2e/platform/(updater\.spec\.ts$|support/)`, String.raw`^desktop/(tauri\.conf|updater-endpoints)\.json$`,
        String.raw`^scripts/(update_channel|release_smoke)\.py$`, String.raw`^desktop/web/package-lock\.json$`,
        String.raw`^(desktop/Cargo\.toml|Cargo\.lock)$`,
        String.raw`^canopi-types/src/update\.rs$`, String.raw`^desktop/src/(host/(exit|single_instance|launch)\.rs|native_operation\.rs|lib\.rs)$`,
        String.raw`^desktop/web/src/(app/shell/close-guard\.ts|app\.tsx|components/shared/(AboutCanopi|Settings)Dialog\.tsx)$`,
        String.raw`^desktop/web/src/(components/(shared/NoticeRow\.tsx|workspace/launch-notices\.ts)|failures/notices\.ts)$`,
        String.raw`^\.github/tauri-release-updater\.json$`],
      actions: ['install-linux-deps'],
      full: ['updater-e2e'],
    },
    {
      // GitHub refused a workflow only a scratch run saw (canopi-f47t.52.228.15.1): a workflow, the actionlint config or
      // a composite action a workflow runs is checked by the pinned actionlint.
      name: 'workflows', label: 'CI workflows (`.github/`)',
      row: '`{actionlint}`',
      patterns: [String.raw`^\.github/(workflows/[^/]+|actionlint)\.ya?ml$`, String.raw`^\.github/actions/`],
      full: ['actionlint'],
    },
    {
      // Some script tests read the docs tree or the gate, so every change runs them before push, as CI's scripts job does;
      // the affected lane runs a changed script's own tests only.
      name: 'scripts', label: 'Script tests', every: true,
      row: '`{script-tests}`',
      patterns: [String.raw`^scripts/`],
      full: ['script-tests'],
      affected: [],
    },
    {
      // The docs checker reads the code paths the docs name, so a code change alone can break a guide (`every`).
      name: 'docs', label: 'Docs', every: true,
      row: '`{docs}` and its `{docs-drift}` (validator changes: `{docs-tests}`); `{playwright-pins}`',
      patterns: [String.raw`\.md$`, String.raw`^docs/`, String.raw`^\.interface-design/`,
        String.raw`^scripts/(test_)?check_docs[a-z_]*\.py$`],
      full: ['docs', 'docs-drift', 'docs-tests', 'playwright-pins'],
      affected: ['docs', 'docs-drift', 'playwright-pins'],
    },
  ] satisfies Area[]).map(inCiHome),
  paths: {
    toolchain: String.raw`^desktop/web/(package(-lock)?\.json|vite\.config\.ts|tsconfig[^/]*\.json)$`,
    policy: String.raw`^(policy/|sgconfig\.yml$)`,
    docsOnly: String.raw`^(\.beads/|docs/|\.interface-design/)|\.md$`,
    notDocs: String.raw`(^|/)THIRD_PARTY_NOTICES\.md$`,
    docsValidator: String.raw`^scripts/(test_)?check_docs[a-z_]*\.py$`,
    webModule: String.raw`^desktop/web/((?:src|ui-gallery)/.*\.(?:tsx?|css))$`,
    spec: String.raw`^desktop/web/(e2e/.*\.spec\.ts)$`,
    e2eCanvas: String.raw`^desktop/web/src/(styles/|app/shell/visible-map-area\.ts$)`,
    e2eGallery: String.raw`^desktop/web/(src/components/|ui-gallery/)`,
    // The gate's own files and tests: all of policy/ (the gate, the modules it imports, the adapters, ratchets, schema
    // and layers it judges with, and the cases its tests read; a planted repository copies the tree), the hooks and all of
    // .github/ (ci-parity.test.ts reads every workflow and install-linux-deps, package-desktop.test.ts the package action
    // and the release overlay). A change runs its Vitest project's files in the lane tests (design check AR20), and
    // commit-gate.ts lists a commit changing one of them that is no test.
    policyGate: String.raw`^(?:policy/|\.githooks/|\.github/)`,
    // The test files the web Vitest project runs (desktop/web/vite.config.ts: Vitest's default include, Playwright's e2e/
    // and e2e-release/ out): scripts/ and vite.config.test.ts beside src/, and the real-app harness's unit tests beside
    // their modules in e2e/platform/ (`*.test.*`, never a spec; canopi-f47t.52.228.35). The deletion guard's Vitest pass
    // lists these, and the typecheck covers its TypeScript ones; table.test.ts holds the rule to `vitest list --filesOnly`.
    webVitestTest: String.raw`^desktop/web/(?:(?!e2e/|e2e-release/)(?:[^/]+/)*[^/]+\.(?:test|spec)|e2e/platform/(?:[^/]+/)*[^/]+\.test)\.[cm]?[jt]sx?$`,
  },
  families: {
    scanner: String.raw`policy-harness|readdirSync|readFileSync\(\s*(?:new URL\(|[\x60'"](?:\./)?src/)`,
    locale: String.raw`from ['"]\.\./i18n/[a-z-]+\.json['"]`,
    cited: String.raw`\x60([A-Za-z0-9_.-]+\.test\.tsx?)\x60`,
  },
  actionlint: {
    version: ACTIONLINT_VERSION,
    url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`,
    sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  },
  ci: {
    'changes': { base: CI_SETUP, diff: CI_SETUP, packaging: CI_SETUP },
    'docs': { 'Install frontend deps': CI_SETUP },
    'rust': { 'Install frontend deps': CI_SETUP },
    'policy-tooling': { 'Install frontend deps': CI_SETUP },
    'shared-contracts': { 'Install frontend deps': CI_SETUP },
    'workflows': { 'Install the pinned actionlint': CI_SETUP },
    'scripts': { 'Install frontend deps': CI_SETUP },
    'frontend': { 'Install frontend deps and fetch the locked crates': CI_SETUP, 'Download and verify the Web catalog': CI_SETUP,
      'Package and verify the Web Edition as a release would': 'web-release' },
    'lidar-native': { '*': 'lidar-native' },
    'platform-tests': { '*': 'platform-tests' },
    'build': { '*': 'packaging' },
    'linux-floor': { '*': 'packaging' },
    'supply-chain': { '*': 'supply-chain' },
    'build-and-test': { 'Every job passed or was skipped': CI_SETUP },
    'desktop-real-app.yml real-app': { '*': 'desktop-real-app' },
    'web-edition-browsers.yml browsers': { '*': 'web-browsers' },
    'web-edition-browsers.yml format-core-engines': { '*': 'web-browsers' },
    'web-edition-browsers.yml a11y-policy': { 'Install frontend deps': CI_SETUP, 'Trust the workspace for the planted cases': CI_SETUP },
    // The macOS self-update probe runs on a dispatch or a Release Candidate only, never called by build.yml (2.1-Q136).
    'updater-e2e.yml updater': { '*': 'updater-e2e' },
    'updater-e2e.yml macos-probe': { '*': 'updater-e2e' },
    // A call runs the preflight and the build as the dry run; every later job is a dispatch's only.
    'release-candidate.yml preflight': { '*': 'release-build' },
    'release-candidate.yml build': { '*': 'release-build' },
    'release-candidate.yml linux-floor': { '*': 'release-build' },
    'release-candidate.yml smoke-linux': { '*': 'release-build' },
    'release-candidate.yml smoke-windows': { '*': 'release-build' },
    'release-candidate.yml web': { '*': 'release-build' },
    'release-candidate.yml manifest': { '*': 'release-build' },
    // The workflows outside Build & Test: the Commit gate's steps are gate calls; each other one is its own lane, and
    // cache-prune.yml deletes superseded caches, judging nothing.
    'commit-gate.yml gate': { 'Install frontend deps': CI_SETUP },
    'cache-prune.yml prune': { '*': CI_SETUP },
    'advisories.yml advisories': { '*': 'advisories' },
    'mutation.yml plan': { '*': 'mutation' },
    'mutation.yml stryker': { '*': 'mutation' },
    'mutation.yml cargo-mutants': { '*': 'mutation' },
    'mutation.yml measured': { '*': 'mutation' },
    'performance.yml perf': { '*': 'perf' },
    'pdf-production-probe.yml native': { '*': 'pdf-production-probe' },
    'pdf-production-probe.yml verify': { '*': 'pdf-production-probe' },
    'engine-floor-probe.yml build': { '*': 'engine-floor-probe' },
    'engine-floor-probe.yml engines': { '*': 'engine-floor-probe' },
    'phone-smoke.yml ios': { '*': 'phone-smoke' },
    'phone-smoke.yml android-plan': { '*': 'phone-smoke' },
    'phone-smoke.yml android': { '*': 'phone-smoke' },
    'phone-smoke.yml android-repeats': { '*': 'phone-smoke' },
    'phone-smoke.yml snapshots': { '*': 'phone-smoke' },
    'seed-lane.yml frontend': { '*': 'seed' },
    'seed-lane.yml planted': { '*': 'seed' },
    'seed-lane.yml proptest': { '*': 'seed' },
    'update-channel.yml publish': { '*': 'update-channel' },
  },
}

/** The table cannot be read as a gate: the CLI refuses naming TABLE_FILE and makes no plan. */
export class TableError extends Error {}

const PLACEHOLDER = /\{([a-z0-9-]+)\}/g
const SHELL_SYNTAX = /[*?[\]'"$`\\|;&<>(){}~]/g
const anchored = (pattern: string) => (pattern.startsWith('^') || pattern.startsWith('(^|/)') || pattern.endsWith('$'))
  && !pattern.includes('**')

/** Every fault of `table` as a gate table, each naming TABLE_FILE; none for a sound table. */
export function tableFaults(table: Table): string[] {
  const faults: string[] = []
  const fault = (what: string) => faults.push(`${TABLE_FILE}: ${what}`)
  const regex = (where: string, pattern: string) => {
    try {
      new RegExp(pattern)
    } catch (error) {
      fault(`${where} ${JSON.stringify(pattern)} is no regex (${(error as Error).message})`)
    }
  }
  for (const [id, check] of Object.entries(table.checks)) {
    if (!/^[a-z0-9-]+$/.test(id)) fault(`check id ${JSON.stringify(id)} is not lower-case words joined by '-'`)
    if (typeof check?.command !== 'string' || check.command.trim() === '') fault(`check ${id} has no command`)
    // The gate splits a command on whitespace (run.ts splitEnv) and an agent pastes its row into zsh: shell syntax
    // would run differently in each (an unquoted glob fails in zsh), so a runnable command holds none.
    const syntax = check?.ciOnly ? [] : [...new Set(check?.command?.match(SHELL_SYNTAX) ?? [])]
    if (syntax.length) {
      fault(`check ${id} command holds shell syntax the gate never reads (${syntax.map((c) => JSON.stringify(c)).join(', ')}); a pasted row would differ`)
    }
    for (const ran of check?.runs ?? []) if (!(ran in table.checks)) fault(`check ${id} runs ${ran}, which is no check`)
    if (check?.on && !check.ciOnly) fault(`check ${id} names the triggers of a workflow of its own, but is no CI-only lane`)
  }
  const names = new Set<string>()
  for (const area of table.areas) {
    if (names.has(area.name)) fault(`area ${area.name} is listed twice`)
    names.add(area.name)
    if (!area.full?.length) fault(`area ${area.name} has no full checks`)
    for (const lane of ['full', 'affected', 'commit', 'coveredBy'] as const) {
      for (const id of area[lane] ?? []) if (!(id in table.checks)) fault(`area ${area.name} ${lane} names ${id}, which is no check`)
    }
    for (const [where, list] of [['pattern', area.patterns], ['scan', area.scans ?? []]] as const) {
      if (where === 'pattern' && !list?.length) fault(`area ${area.name} has no patterns`)
      for (const pattern of list ?? []) {
        regex(`area ${area.name} ${where}`, pattern)
        if (!anchored(pattern)) fault(`area ${area.name} ${where} ${JSON.stringify(pattern)} is not anchored`)
      }
    }
    // affectedWhen adds a check of the area's row to its affected lane where an anchored pattern matches (C9a review).
    for (const [id, inputs] of Object.entries(area.affectedWhen ?? {})) {
      if (!area.full?.includes(id)) fault(`area ${area.name} affectedWhen names ${id}, which is not one of its full checks`)
      for (const pattern of inputs) {
        regex(`area ${area.name} affectedWhen ${id} pattern`, pattern)
        if (!anchored(pattern)) fault(`area ${area.name} affectedWhen ${id} pattern ${JSON.stringify(pattern)} is not anchored`)
      }
    }
    const named = [...(area.row ?? '').matchAll(PLACEHOLDER)].map((match) => match[1] ?? '')
    for (const id of named) {
      if (!area.full?.includes(id)) fault(`area ${area.name} row names {${id}}, which is not one of its full checks`)
    }
    for (const id of area.full ?? []) {
      const times = named.filter((name) => name === id).length
      const prose = table.checks[id]?.prose === true
      if (!prose && times !== 1) fault(`area ${area.name} row names {${id}} ${times} times; a full check is named once`)
      if (prose && times !== 0) fault(`area ${area.name} row names {${id}}, which its row holds as prose`)
    }
  }
  for (const [rule, pattern] of Object.entries({ ...table.paths, ...table.families })) regex(`rule ${rule}`, pattern)
  if (!/^\d+\.\d+\.\d+$/.test(table.actionlint?.version ?? '')) fault('actionlint version is not x.y.z')
  if (!/^[0-9a-f]{64}$/.test(table.actionlint?.sha256 ?? '')) fault('actionlint sha256 is not 64 hex digits')
  for (const [job, steps] of Object.entries(table.ci ?? {})) {
    for (const [step, row] of Object.entries(steps)) {
      if (row !== CI_SETUP && table.checks[row]?.ciOnly !== true) fault(`ci row ${job}/${step} is ${row}, neither ${CI_SETUP} nor a ci_only check`)
    }
  }
  return faults
}

/** The table, or a TableError listing its faults. */
export function validTable(table: Table = TABLE): Table {
  const faults = tableFaults(table)
  if (faults.length) throw new TableError(faults.join('\n'))
  return table
}

/** The gate refuses `check` without desktop/web/node_modules, so a CI job installs them before its row. */
export const needsPackages = (check: Check) => check.cwd === WEB

/** A check's text as AGENTS.md and the plan write it: from the repository root. */
export const display = (check: Check) => (check.cwd ? `cd ${check.cwd} && ${check.command}` : check.command)
