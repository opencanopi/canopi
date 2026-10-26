// The Web dev server's entry: the root and /index.html serve web.html, as the packaged archive does (2.1-Q85).
const WEB_EDITION_DEV_ENTRY_PATHS = new Set(["/", "/index.html"]);

export function resolveWebEditionDevHtmlUrl(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;

  const url = new URL(requestUrl, "http://canopi.local");
  if (!WEB_EDITION_DEV_ENTRY_PATHS.has(url.pathname)) return null;

  return `/web.html${url.search}`;
}
