// Mutation testing for the Node lane (2.1-M60, ADR 0028): .github/workflows/mutation.yml runs Stryker with
// `--incremental --mutate <changed files>` on a pull request, from the report cached on main, and the whole of one
// area on `workflow_dispatch`. Vitest runs the mutants through vite.config.ts (its Node environment, its setup);
// the TypeScript checker (the `typescript` alias, TS 6: tsgo has no API Stryker can load) drops mutants that do not
// compile, so a survivor is one a test could have caught.
// One command locally and in CI: `npm run test:mutation -- --mutate 'src/canvas/**'` mutates one area (the workflow
// passes its file list the same way); without `--mutate` it mutates the default below.
// In place, not in a sandbox: vite.config.ts and the tests read files beside desktop/web (../tauri.conf.json,
// ../../policy, ../../THIRD_PARTY_NOTICES.md), which a sandbox copy of desktop/web does not have. Stryker keeps a
// backup and restores every mutated file when the run ends or is interrupted; run it in CI or a worktree, never
// in a checkout with a dev server watching src/.
// Every output sits under node_modules/.cache/stryker (ignored, never committed): the incremental report CI caches,
// the JSON report the workflow turns into annotations, and the backups.
const OUT = 'node_modules/.cache/stryker'

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // Forks, as plain vitest runs: the runner's default pool, threads, overrides vite.config.ts, and inside a thread the
  // web-worker polyfill (geotiff, DuckDB's node path) takes itself for a worker.
  vitest: { configFile: 'vite.config.ts', pool: 'forks' },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  // The default when no `--mutate` is given: application code, never tests or test support.
  mutate: ['src/**/*.{ts,tsx}', '!src/**/__tests__/**', '!src/**/*.test.{ts,tsx}', '!src/generated/**'],
  coverageAnalysis: 'perTest',
  // The perTest dry run of the whole suite in forks takes about 5 minutes on a CI runner, Stryker's default limit.
  dryRunTimeoutMinutes: 15,
  incrementalFile: `${OUT}/incremental.json`,
  inPlace: true,
  tempDirName: `${OUT}/tmp`,
  cleanTempDir: 'always',
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: `${OUT}/mutation.json` },
  // Information, never a gate (ADR 0028): survivors become annotations, tests or beads.
  thresholds: { high: 80, low: 60, break: null },
  concurrency: 4,
  timeoutMS: 60_000,
}
