// utils/normalize-search.ts
// Owner of search folding (search-fold-only-in-search-text, ADR 0028; §18 F18) until 2a's
// platform/page-rules.ts. Invariant: search text is folded only here.

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
}
