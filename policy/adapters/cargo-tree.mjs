// policy/adapters/cargo-tree.mjs: crates a guarded crate must never reach, read from `cargo tree` (contracts §18 R7;
// design check F9; 2.1-M189; ADR 0023).
//
// cargo-deny's [bans] wrappers judge only a banned crate's direct parents, so a crate that must stay free of the native
// stack (the format core, which also runs as wasm in the Web worker) cannot be held there: tokio two edges away passes.
// This adapter lists each guarded crate's whole dependency graph with one `cargo tree --no-dedupe` over the normal and
// build edges on every target (dev-dependencies never ship), the same graph `cargo tree -i <banned>` inverts, and makes each banned
// crate found in a guarded crate's graph one site `{ rule, name: '<guarded> -> <banned>' }`. RULES holds each rule's
// guarded and banned crates; a planted directory (policy/fixtures/rules/<rule>/, its own `[workspace]`, run offline)
// holds stand-ins named like the guarded and banned crates, so its run proves this table.
//
// It fails closed: a non-zero exit, output that is not cargo tree's `{p}` lines, and a guarded crate the output gives no
// tree for are tool-failed, never read as a graph without banned crates.
import { workspaceDir } from './cargo-manifest.mjs';

/** Each rule's guarded crates and the crates none of them may reach. */
export const RULES = [
  {
    rule: 'format-crate-bans-native',
    guarded: ['canopi-format', 'canopi-format-wasm'],
    // schemars too: the Web worker's module carries the read half, and the schema derive is a build-time tool that
    // made it thirteen times larger (canopi-f47t.52.270); the walker reads its keywords from ungated constants.
    banned: ['tauri', 'tokio', 'rusqlite', 'schemars'],
  },
];

const fail = (message) => { throw Object.assign(new Error(`cargo-tree: ${message}`), { code: 'tool-failed' }); };
const lastLine = (text) => String(text ?? '').trim().split('\n').at(-1) ?? '';
/** One `--format {p}` line with `--prefix none`: the package name, its version, then cargo's markers. */
const PACKAGE_LINE = /^(\S+) v\S+(?: \(.*\))?$/u;

/** The `cargo tree` arguments listing `crates`' graphs in the workspace whose root manifest is `<dir>/Cargo.toml`. */
export function treeArgs(crates, dir) {
  return ['tree', '--locked', ...(dir ? ['--offline', '--manifest-path', `${dir}/Cargo.toml`] : []),
    ...crates.flatMap((crate) => ['-p', crate]), '-e', 'normal,build', '--target', 'all', '--no-dedupe', '--prefix', 'none',
    '--format', '{p}'];
}

/**
 * The package names in each tree of `cargo tree` output, by the tree's root: cargo prints one tree per `-p` crate,
 * a blank line between, each starting with its root. `--no-dedupe` repeats a subtree an earlier tree printed, so each
 * tree is its root's whole graph; a `(*)` line (a subtree left out) is refused, as are a line that is not a package and
 * a guarded crate with no tree.
 */
export function graphs(stdout, guarded) {
  const trees = new Map();
  for (const block of String(stdout).split(/\n\s*\n/u).map((b) => b.trim()).filter(Boolean)) {
    const names = block.split('\n').map((line) => {
      if (/ \(\*\)\s*$/u.test(line)) fail(`a deduplicated subtree, whose crates the tree leaves out: ${line.slice(0, 120)}`);
      const name = PACKAGE_LINE.exec(line.trim())?.[1];
      if (!name) fail(`a line that is not a cargo tree package: ${line.slice(0, 120)}`);
      return name;
    });
    trees.set(names[0], new Set(names.slice(1)));
  }
  const missing = guarded.filter((crate) => !trees.has(crate));
  if (missing.length) fail(`cargo tree gave no tree for ${missing.join(', ')} (truncated output, or the crate is gone)`);
  return trees;
}

export function collect({ root, paths, exec, select }) {
  const dir = workspaceDir(paths);
  return RULES.filter(({ rule }) => !select || select.includes(rule)).flatMap(({ rule, guarded, banned }) => {
    const { status, stdout, stderr } = exec('cargo', treeArgs(guarded, dir), { cwd: root });
    if (status !== 0) fail(`cargo tree exited ${status}: ${lastLine(stderr)}`);
    const trees = graphs(stdout, guarded);
    return guarded.flatMap((crate) => banned.filter((b) => trees.get(crate).has(b)).map((b) => ({ rule, name: `${crate} -> ${b}` })));
  });
}
