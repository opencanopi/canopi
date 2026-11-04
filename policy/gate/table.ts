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
  readonly commit?: readonly string[]
  /** Affected checks another selected area's check already runs. */
  readonly coveredBy?: readonly string[]
  /** A path-keyed ratchet whose listed files also select the area, read at plan time (a missing one refuses). */
  readonly ratchet?: string
  /** The workflow whose job runs this area's full row (`full --area <name>`) once what its checks read exists there
   * (the axe reports each engine's browser job writes): no local lane runs it, and `full` with no area leaves it out. */
  readonly workflow?: string
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
}

export type PathRule = 'toolchain' | 'policy' | 'docsOnly' | 'notDocs' | 'docsValidator' | 'webModule' | 'spec'
  | 'e2eCanvas' | 'e2eGallery' | 'workflow' | 'policyGate'

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
// the digest (the release's actionlint_<version>_checksums.txt), and build.yml's actionlint job equals both.
const ACTIONLINT_VERSION = '1.7.12'

export const TABLE: Table = {
  checks: {
    'fmt': { command: 'cargo fmt --all -- --check' },
    'clippy': { command: `${SKIP_DB} cargo clippy --workspace --all-targets -- -D warnings`, cargo: true },
    // cargo-llvm-cov runs every workspace test, so it is the Rust row's test run too (no doctest; 2.1-M327).
    'cov': { command: `${SKIP_DB} cargo cov`, cargo: true, runs: ['cargo-test'] },
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
    'gen-types': web('npm run gen:types', { cargo: true }),
    'check-types': web('npm run check:types', { cargo: true }),
    'typecheck': web('npm run typecheck'),
    'coverage': web('npm run test:coverage -- --maxWorkers=4'),
    'check-ui': web('npm run check:ui'),
    'build': web('npm run build'),
    'build-web': web('npm run build:web'),
    // check:notices regenerates the notices from both bundles and cargo-about 0.9.3, which must be on PATH (2.1-M239).
    'notices': web('npm run check:notices'),
    'species-contract': { command: 'python3 scripts/species_catalog_contract.py check' },
    'species-tests': { command: 'python3 -m unittest scripts.test_species_catalog_contract', prose: true },
    'lidar-native': { command: 'CI job lidar-native: the engine lane', shown: 'lidar-native', ciOnly: true },
    'lidar-comparison': { command: 'the comparison lane (docs/guides/data-library.md)', prose: true, ciOnly: true },
    // The Desktop real-app suite (2.1-M213) needs tauri-driver, a WebKit driver and a display; its triggers are the
    // workflow's paths, and docs/guides/native-and-release.md has the local Linux run.
    'desktop-real-app': { command: 'CI lane desktop-real-app.yml', shown: 'desktop-real-app.yml', ciOnly: true },
    'docs': { command: 'python3 scripts/check_docs.py' },
    'docs-drift': { command: 'python3 scripts/check_docs.py --drift origin/main', shown: '--drift origin/main' },
    'docs-tests': { command: 'python3 -m unittest scripts.test_check_docs' },
    'closed-beads': { command: 'node policy/check.mjs --closed-beads' },
    // The plan names the families a change's paths reach (CHEAP_FAMILIES) after `--`.
    'cheap-families': web('npm run test:policies:family --'),
    'actionlint': { command: 'node policy/gate/cli.mjs actionlint' },
    // Both builds' chunks parsed by the oldest engine, Debian 12's JavaScriptCore, in its pinned image (A15).
    'oldest-engine': { command: 'node policy/gate/cli.mjs oldest-engine' },
    'pdf-fonts': web('npm run prepare:pdf-fonts'),
  },
  areas: [
    {
      name: 'rust', label: 'Rust',
      row: '`{fmt}`; `{clippy}`; `{cov}` above its floor (it runs the workspace tests); `cd desktop/web && {policy-check-push}`; '
        + 'CI `{platform-tests}` and `{packaging}`',
      // Beyond the sources and manifests, what the Rust build and tests read: the desktop shell outside desktop/web (Tauri
      // config, capabilities, icons), the shared contracts and their generator, the scripts and fixtures Rust tests
      // compare against, and the composite actions the Rust jobs run (design check AR2: build.yml's rust_paths and
      // web_rust_paths, retired).
      patterns: [String.raw`\.rs$`, String.raw`(^|/)Cargo\.(toml|lock)$`, String.raw`^(rust-toolchain|clippy|deny)\.toml$`,
        String.raw`^\.cargo/`, String.raw`^\.github/workflows/(build|release-candidate)\.yml$`, String.raw`^desktop/(?!web/)`,
        String.raw`^(canopi-types|bindings-gen)/`, String.raw`^\.github/actions/`, String.raw`^desktop/web/src/maplibre/raster-display/fixtures/`,
        String.raw`^scripts/(schema-contract\.json|species_catalog_contract\.py|species_search_normalization\.py|web_catalog_artifact_contract\.py)$`],
      full: ['fmt', 'clippy', 'cov', 'policy-check-push', 'platform-tests', 'packaging'],
      affected: ['fmt', 'clippy', 'cargo-test', 'policy-check-push'],
      commit: ['fmt', ...POLICY_COMMIT],
    },
    {
      name: 'tauri-command', label: 'A `#[tauri::command]`',
      row: '`{native-command-policy}`',
      // ipc/ is the only place that invokes native commands (AR12); a file the invoke-only-in-ipc ratchet still lists
      // invokes one too, so it selects the area as well.
      patterns: [String.raw`^desktop/src/.*\.rs$`, String.raw`^desktop/web/src/ipc/`],
      ratchet: 'policy/ratchets/invoke-only-in-ipc.json',
      full: ['native-command-policy'],
      coveredBy: ['cargo-test'],
    },
    {
      // generated/locale-keys.ts derives from en.json (2.1-Q211), so an English locale change regenerates it.
      name: 'shared-contracts', label: 'Shared contracts (`canopi-types/`, `en.json`)',
      row: '`cd desktop/web && {gen-types} && {check-types}`',
      patterns: [String.raw`^canopi-types/`, String.raw`^bindings-gen/`, String.raw`^desktop/web/src/i18n/en\.json$`],
      full: ['gen-types', 'check-types'],
    },
    {
      // `^policy/` and the ast-grep config run the policy lane; the gallery also runs the root typecheck.
      name: 'frontend', label: 'Frontend',
      row: '`cd desktop/web && {typecheck} && {coverage} && {policy-check} && {policy-node-tests} && '
        + '{policy-generate} && {policy-generate-self-test} && {ast-grep-test} && {check-ui} && {build} && {build-web} && '
        + '{policy-bundle} && {notices}`; `{oldest-engine}`',
      patterns: [String.raw`^desktop/web/(?!.*\.md$)`, String.raw`^policy/`, String.raw`^sgconfig\.yml$`,
        String.raw`(^|/)THIRD_PARTY_NOTICES\.md$`, String.raw`^about\.(toml|hbs)$`,
        String.raw`^scripts/(generate_notices\.mjs|notices-hand-rows\.json)$`],
      full: ['typecheck', 'coverage', ...POLICY_COMMIT, 'check-ui', 'build', 'build-web', 'policy-bundle', 'notices', 'oldest-engine'],
      affected: ['typecheck', 'check-ui'],
      commit: ['typecheck'],
      // What toolchain-typecheck.test.ts reads for a bare compiler run (2.1-Q205), beyond desktop/web.
      scans: [String.raw`^\.githooks/`, String.raw`^\.github/workflows/[^/]+\.ya?ml$`, String.raw`^scripts/.+\.(sh|py|mjs|js|ts)$`,
        String.raw`^docs/guides/.+\.md$`, String.raw`^(README|AGENTS)\.md$`],
    },
    {
      // Each lane's planted cases run where the policy tooling or what its adapters run changes (design check AR8):
      // policy/ but the gate's own TypeScript (its Vitest project), and the adapters' inputs, each the tool or config
      // an adapter runs: ast-grep and suppressions read sgconfig.yml; oxlint, knip, jscpd, dependency-cruiser and tsc run
      // desktop/web's locked packages with its tsconfigs and their own configs (.oxlintrc.json, knip.json, the three
      // .dependency-cruiser*.cjs, /.jscpd.json); osv-scanner reads osv-scanner.toml; clippy runs the pinned toolchain with
      // clippy.toml; cargo-deny reads deny.toml; agent-hooks runs scripts/agent_hooks.py. A config edit that silences a
      // rule is caught only by these planted cases (planted-silent). A push adapter's change runs the push check too.
      name: 'policy-tooling', label: 'Policy tooling (`policy/`, an adapter\'s tool or config)',
      row: '`cd desktop/web && {policy-self-test} && {policy-self-test-push} && {policy-check-push} && {policy-self-test-bundle}`',
      patterns: [String.raw`^policy/(?!gate/)`, String.raw`^sgconfig\.yml$`, String.raw`^desktop/web/package(-lock)?\.json$`,
        String.raw`^desktop/web/tsconfig[^/]*\.json$`, String.raw`^(rust-toolchain|clippy|deny)\.toml$`,
        String.raw`^desktop/web/(\.oxlintrc\.json|knip\.json|\.dependency-cruiser[^/]*\.cjs)$`,
        String.raw`^(\.jscpd\.json|osv-scanner\.toml)$`, String.raw`^scripts/agent_hooks\.py$`],
      full: ['policy-self-test', 'policy-self-test-push', 'policy-check-push', 'policy-self-test-bundle'],
    },
    {
      // A packaging input builds every platform's installer (a PR otherwise packages Linux and Apple silicon only): the
      // manifests and toolchain, the build script, the Windows manifest, icons, Tauri config, the sidecar and its smoke,
      // the npm manifests (the Tauri CLI), build.yml and its actions.
      name: 'packaging', label: 'Desktop packaging inputs',
      row: 'CI `{packaging-every-platform}` on every platform',
      patterns: [String.raw`^Cargo\.lock$`, String.raw`^([^/]+/)?Cargo\.toml$`, String.raw`^rust-toolchain\.toml$`,
        String.raw`^desktop/(build\.rs|windows-app-manifest\.xml|updater-endpoints\.json)$`, String.raw`^desktop/(icons|linux|binaries)/`,
        String.raw`^desktop/tauri[^/]*\.json$`, String.raw`^desktop/tauri\.conf`,
        String.raw`^scripts/(build-geolibre-cli\.sh|smoke-bundled-sidecar\.sh|check_windows_manifest\.py)$`,
        String.raw`^desktop/web/package[^/]*\.json$`, String.raw`^\.github/(workflows/build\.yml$|actions/|tauri-branch-nsis\.json$)`],
      full: ['packaging-every-platform'],
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
      full: ['lidar-native', 'lidar-comparison'],
    },
    {
      name: 'real-app', label: 'Desktop real app',
      row: 'CI lane `{desktop-real-app}`',
      patterns: [String.raw`^desktop/`, String.raw`^canopi-types/`, String.raw`^Cargo\.lock$`,
        String.raw`^\.github/workflows/desktop-real-app\.yml$`],
      full: ['desktop-real-app'],
    },
    {
      // The axe family judges the reports each engine's a11y spec writes, and its self-test drives Chromium: the browsers
      // workflow runs the pair after its browser jobs. The patterns are that workflow's triggers.
      name: 'a11y', label: 'Accessibility (axe reports)',
      row: 'CI lane `web-edition-browsers.yml`: `cd desktop/web && {policy-self-test-a11y} && {policy-a11y}`',
      workflow: '.github/workflows/web-edition-browsers.yml',
      patterns: [String.raw`^desktop/web/(?!.*\.md$)`, String.raw`^desktop/tauri\.conf\.json$`, String.raw`^policy/`,
        String.raw`^\.github/workflows/web-edition-browsers\.yml$`],
      full: ['policy-self-test-a11y', 'policy-a11y'],
    },
    {
      // The docs checker reads the code paths the docs name, so a code change alone can break a guide (`every`).
      name: 'docs', label: 'Docs', every: true,
      row: '`{docs}` and its `{docs-drift}` (validator changes: `{docs-tests}`)',
      patterns: [String.raw`\.md$`, String.raw`^docs/`, String.raw`^\.interface-design/`,
        String.raw`^scripts/(test_)?check_docs[a-z_]*\.py$`],
      full: ['docs', 'docs-drift', 'docs-tests'],
    },
  ],
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
    workflow: String.raw`^\.github/(workflows/[^/]+|actionlint)\.ya?ml$`,
    // The gate's own files and tests: all of policy/ (the gate, the modules it imports, the adapters, ratchets, schema
    // and layers it judges with, and the cases its tests read; a planted repository copies the tree), the hooks and the
    // Commit gate workflow. A change runs its Vitest project's files in the lane tests (design check AR20), and
    // commit-gate.ts lists a commit changing one of them that is no test.
    policyGate: String.raw`^(?:policy/|\.githooks/|\.github/workflows/commit-gate\.yml$)`,
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
}

/** The table cannot be read as a gate: the CLI refuses naming TABLE_FILE and makes no plan. */
export class TableError extends Error {}

const PLACEHOLDER = /\{([a-z0-9-]+)\}/g
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
    for (const ran of check?.runs ?? []) if (!(ran in table.checks)) fault(`check ${id} runs ${ran}, which is no check`)
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
