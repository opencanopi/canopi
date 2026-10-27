// map-console-only-through-redactor: a console reached through window, unredacted.
export const report = (error: unknown) => window.console.error(error)
