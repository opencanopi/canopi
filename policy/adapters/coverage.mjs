// policy/adapters/coverage.mjs: the coverage floors the configs enforce (contracts §12; 2.1-M217, 2.1-M222; ADR 0028).
//
// The `coverage` floor family holds, per tool, the floor of each metric and the include and exclusion patterns it is
// measured over. vite.config.ts and the gate's `cov` run read them from policy/ratchets/coverage.json; this adapter
// measures what each enforces once loaded, so the family refuses a floor lowered below it or a pattern added or dropped
// in either:
//   - `vitest.config.*` or `vite.config.*` (vitest): `test.coverage.thresholds` {statements, branches, functions,
//     lines}, with its include and exclude, read by loading the config through desktop/web's Vite in test mode, as
//     vitest does. Only the config vitest loads is measured: the one the `test:coverage` script beside it names with
//     `--config`, else the first of vitest's own order (vitest.config.* before vite.config.*). Coverage must be on:
//     the script passes a bare `--coverage` or the config sets `test.coverage.enabled: true`, else no floor runs. Any
//     other coverage option in the script (`--coverage.*`, `--coverage=<value>`, `--coverage <value>`,
//     `--no-coverage`) is refused, since it would override the config unseen;
//   - `llvm-cov.mjs`, policy/gate's (cargo-llvm-cov): the `--fail-under-<metric>` values and `--ignore-filename-regex` of
//     the arguments it builds, which must name `--workspace`.
//   - `gate-cov.mjs`, policy/gate's (policy-gate): the floors and repository-relative patterns its coverage run of the
//     policy-gate Vitest project judges the merged totals by, child CLIs included (design check AR20, F9).
// Each path it is given is one config; observed is { <tool>: { values, include?, exclude? } }.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = 'desktop/web';
const VITEST_METRICS = ['statements', 'branches', 'functions', 'lines'];

const fail = (message) => { throw Object.assign(new Error(`coverage: ${message}`), { code: 'tool-failed' }); };

// vitest's config lookup: each name with each extension, in this order (vitest's CONFIG_NAMES and CONFIG_EXTENSIONS).
const VITEST_CONFIGS = ['vitest.config', 'vite.config'].flatMap((n) => ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((e) => n + e));

/**
 * What `npm run test:coverage` in `dir` makes vitest do: `loads`, the `--config` (`-c`) it names, else the first of
 * vitest's lookup order present in `dir`, and `switchedOn`, whether it passes a bare `--coverage`. Any other coverage
 * option is refused, since a value can switch coverage off or override the config.
 */
function vitestRun(root, dir) {
  const manifest = path.join(root, dir, 'package.json');
  const script = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts?.['test:coverage'] ?? '' : '';
  const args = script.split(/\s+/).filter(Boolean).map((a) => a.replace(/^(['"])(.*)\1$/, '$2'));
  const override = args.find((a, i) => (/^--(no-)?coverage\b/.test(a) && a !== '--coverage')
    || (a === '--coverage' && args[i + 1] !== undefined && !args[i + 1].startsWith('-')));
  if (override) fail(`${dir}/package.json's test:coverage passes ${override} with a value or an option, which can switch coverage off or override the config; pass a bare --coverage and set the rest in the config`);
  const switchedOn = args.includes('--coverage');
  let named;
  args.forEach((a, i) => {
    if (a === '--config' || a === '-c') named = args[i + 1];
    else if (a.startsWith('--config=')) named = a.slice('--config='.length);
  });
  if (named) return { loads: path.posix.normalize(path.posix.join(dir, named)), switchedOn };
  const found = VITEST_CONFIGS.find((name) => fs.existsSync(path.join(root, dir, name)));
  return { loads: found && path.posix.join(dir, found), switchedOn };
}

/** The vitest floors a Vite config enforces, loaded with desktop/web's Vite as `vitest` loads it. */
async function vitest(root, file) {
  const require = createRequire(path.join(root, WEB, 'package.json'));
  let vite;
  try {
    vite = await import(pathToFileURL(require.resolve('vite')).href);
  } catch (error) {
    fail(`desktop/web's vite cannot be loaded (${error.message}); run npm ci in desktop/web`);
  }
  const { loads, switchedOn } = vitestRun(root, path.posix.dirname(file));
  if (loads !== file) fail(`vitest loads ${loads}, not ${file}; hold the floors of the config it loads`);
  const absolute = path.join(root, file);
  const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, absolute, path.dirname(absolute), 'silent');
  const coverage = loaded?.config?.test?.coverage;
  if (!coverage?.thresholds) fail(`${file} sets no test.coverage.thresholds`);
  if (!switchedOn && coverage.enabled !== true) {
    fail(`${path.posix.dirname(file)}/package.json's test:coverage passes no --coverage and ${file} does not set test.coverage.enabled: true, so no floor runs`);
  }
  const values = Object.fromEntries(VITEST_METRICS.filter((m) => m in coverage.thresholds).map((m) => [m, coverage.thresholds[m]]));
  return { values, include: coverage.include ?? [], exclude: coverage.exclude ?? [] };
}

/** The cargo-llvm-cov floors the gate's `cov` run enforces: the arguments policy/gate/llvm-cov.mjs builds, read back. */
async function cargoLlvmCov(root, file) {
  const { llvmCovArgs } = await import(pathToFileURL(path.join(root, file)).href);
  let args;
  try {
    args = llvmCovArgs(root);
  } catch (error) {
    fail(error.message);
  }
  const values = {};
  const exclude = [];
  args.forEach((arg, i) => {
    const under = /^--fail-under-([a-z]+)$/.exec(arg);
    if (under) values[under[1]] = Number(args[i + 1]);
    if (arg === '--ignore-filename-regex') exclude.push(args[i + 1]);
  });
  if (!args.includes('--workspace')) fail(`${file} runs cargo llvm-cov without --workspace, so it measures the default members`);
  return { values, exclude };
}

/** The policy-gate floors the gate's `gate-cov` run judges by: what policy/gate/gate-cov.mjs reads, read back. */
async function policyGate(root, file) {
  const { gateCovPlan } = await import(pathToFileURL(path.join(root, file)).href);
  let plan;
  try {
    plan = gateCovPlan(root);
  } catch (error) {
    fail(error.message);
  }
  return { values: { ...plan.floors }, include: plan.include, exclude: plan.exclude };
}

export async function measure({ root, paths }) {
  const observed = {};
  for (const file of paths) {
    const base = path.posix.basename(file);
    const [tool, read] = /^vite(?:st)?\.config\.[cm]?[jt]s$/.test(base) ? ['vitest', vitest]
      : base === 'llvm-cov.mjs' ? ['cargo-llvm-cov', cargoLlvmCov]
        : base === 'gate-cov.mjs' ? ['policy-gate', policyGate]
          : fail(`${file} is not a coverage config (vitest.config.*, vite.config.*, policy/gate/llvm-cov.mjs or policy/gate/gate-cov.mjs)`);
    if (observed[tool]) fail(`two ${tool} configs: ${file} and another`);
    observed[tool] = await read(root, file);
  }
  return observed;
}
