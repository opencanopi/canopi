// The oxlint family's planted violation (2.1-M225), linted through the real desktop/web/.oxlintrc.json: a zero-site
// rule (no-var), a type-aware one (typescript/no-floating-promises) and a disable directive that covers nothing
// (unused-disable-directive, an error by the adapter's command line: 2.1-M187), each a site the family counts.
// Never imported.
async function settle(): Promise<number> {
  return 1
}

export function planted(): void {
  var unused = 0
  settle()
  // oxlint-disable-next-line no-eval
  void unused
}
