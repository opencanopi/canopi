// policy/adapters/rust-module-graph.mjs: the native module cycles as sites (ADR 0023 Checks `rust-scc`; contracts §12;
// Phase 0 F2, 2.1-M189).
//
// desktop/src/module_layering/graph.rs builds canopi-desktop's module graph from the layering test's own path reading
// (`crate::`, `self::`, `super::` and bare child-module paths, test code skipped) and runs Tarjan's algorithm over it;
// its ignored test `report_module_cycles` prints one `POLICY-SITE {"key","count"}` line per module in a strongly
// connected component of two or more modules (`count` the component's size), then `POLICY-SITES-END <lines>`. Each
// such module is `count` sites named by its key, so a module joining a cycle is unlisted and a cycle growing is
// rising for each member. A path under policy/fixtures/rules/<rule>/ names a planted crate whose `src/` the test reads
// instead (CANOPI_RUST_SCC_ROOT, relative to the repository root); the repository's paths name canopi-desktop.
//
// The test compiles the desktop crate, so the family is push-lane, with CANOPI_SKIP_BUNDLED_DB=1 (no bundled
// catalogue). A run is refused (`tool-failed`) on a non-zero exit, a site line that is not its JSON, an output
// without the end marker or whose marker counts other than the site lines printed (a truncated run).
export const RULE = 'rust-scc';
const TEST = 'module_layering::tests::report_module_cycles';
const SITE = 'POLICY-SITE ';
const END = /^POLICY-SITES-END (\d+)$/u;

const fail = (message) => { throw Object.assign(new Error(`rust-module-graph: ${message}`), { code: 'tool-failed' }); };

/** The sites of one report: `count` sites per module line, checked against the end marker. */
export function parse(stdout) {
  const sites = [];
  let lines = 0;
  let end;
  for (const line of stdout.split('\n').map((l) => l.trim())) {
    const marker = END.exec(line);
    if (marker) {
      end = Number(marker[1]);
      continue;
    }
    if (!line.startsWith(SITE)) continue;
    let site;
    try {
      site = JSON.parse(line.slice(SITE.length));
    } catch {
      fail(`a site line that is not JSON: ${line.slice(0, 120)}`);
    }
    if (typeof site?.key !== 'string' || !Number.isInteger(site?.count) || site.count < 2) fail(`a site line without a key and a count of 2 or more: ${line.slice(0, 120)}`);
    lines++;
    for (let i = 0; i < site.count; i++) sites.push({ rule: RULE, name: site.key });
  }
  if (end === undefined) fail('no POLICY-SITES-END marker: the report was cut short or never ran');
  if (end !== lines) fail(`the end marker counts ${end} site lines, the report printed ${lines}`);
  return sites;
}

/** The crate directory a scoped path names: a planted crate (its directory above `src/`) or the desktop crate. */
function crateOf(p) {
  const planted = /^(policy\/fixtures\/rules\/[^/]+(?:\/.+?)?)\/src\//u.exec(p);
  return planted ? planted[1] : 'desktop';
}

export function collect({ root, paths, exec }) {
  const crates = [...new Set(paths.filter((p) => p.endsWith('.rs')).map(crateOf))].sort();
  return crates.flatMap((crate) => {
    const env = ['CANOPI_SKIP_BUNDLED_DB=1', ...(crate === 'desktop' ? [] : [`CANOPI_RUST_SCC_ROOT=${crate}`])];
    const args = [...env, 'cargo', 'test', '--manifest-path', 'desktop/Cargo.toml', '--lib', '--quiet', TEST, '--', '--ignored', '--exact', '--nocapture'];
    const { status, stdout, stderr } = exec('env', args, { cwd: root });
    if (status !== 0) fail(`cargo test exited ${status}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    return parse(stdout);
  });
}
