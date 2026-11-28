// edition-ports-installed-only-by-roots: a planted site the rule counts.
declare function installEditionPorts(ports: unknown): void
export const planted = () => installEditionPorts({})
