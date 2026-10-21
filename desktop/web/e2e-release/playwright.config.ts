// The Web Edition release smoke: scripts/publish-web-release.sh runs it against a deployed
// release (preview, then web.projectcanopi.com) in the pinned image
// mcr.microsoft.com/playwright:v1.63.0-noble, with CANOPI_WEB_RELEASE_URL set. It is not part
// of playwright.config.ts's projects: it needs a live deployment and the network.
//   docker run --rm --ipc=host -e CANOPI_WEB_RELEASE_URL=https://web.projectcanopi.com \
//     -v "$PWD/desktop/web:/web:ro" -w /web mcr.microsoft.com/playwright:v1.63.0-noble \
//     npx playwright test --config e2e-release/playwright.config.ts
// The deploy-skew check (deploy-skew.spec.ts) runs alone, only with CANOPI_WEB_RELEASE_HANDOFF set; publish-web-release.sh
// sets it for the preview's N-1 to N deploy.
import { defineConfig } from '@playwright/test'

const baseURL = process.env.CANOPI_WEB_RELEASE_URL
if (!baseURL) throw new Error('Set CANOPI_WEB_RELEASE_URL to the deployed Web Edition, such as https://web.projectcanopi.com')

const skew = Boolean(process.env.CANOPI_WEB_RELEASE_HANDOFF)

export default defineConfig({
  testDir: '.',
  ...(skew ? { testMatch: 'deploy-skew.spec.ts' } : { testIgnore: 'deploy-skew.spec.ts' }),
  retries: 0,
  forbidOnly: true,
  workers: 2,
  reporter: [['list']],
  outputDir: process.env.CANOPI_WEB_RELEASE_OUTPUT ?? '../test-results/web-release',
  // A cold DuckDB-WASM catalog load takes 15-20 s on a fast connection; the whole walk stays well inside this.
  timeout: 360_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    viewport: { width: 1366, height: 860 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
