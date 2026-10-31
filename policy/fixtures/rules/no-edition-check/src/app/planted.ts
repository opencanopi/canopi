// A planted edition test in feature code (ADR 0030 No edition checks): the feature reads the edition, not a capability.
export const reason = (context: { edition: string }) => (context.edition === 'web' ? 'NeedsDesktop' : null)
