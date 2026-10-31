// The DevToolsActivePort parser, apart from the harness (app.ts imports @wdio/globals) so a unit test can import it.

/** The port in a DevToolsActivePort file's text, only once both lines (port and browser path) are written. */
export function devToolsPortIn(text: string): number | undefined {
  const [first, browserPath] = text.split(/\r?\n/)
  if (!browserPath?.trim()) return undefined
  const port = Number(first)
  return Number.isInteger(port) && port > 0 ? port : undefined
}
