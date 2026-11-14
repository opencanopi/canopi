// The rollback harness's Web reader (Step 2.0.4 R4, canopi-f47t.52.239; reader.spec.ts beside it): the rollback lane
// (.github/workflows/rollback.yml) runs it from main's tree against the reader's Web bundle, CANOPI_ROLLBACK_WEB_DIST
// (default dist-web, this tree's `npm run build:web`), over the writer's fixture directory, CANOPI_ROLLBACK_FIXTURES
// (default the in-repo frozen forms), in the pinned image mcr.microsoft.com/playwright:v1.64.1-noble. It is not part of
// playwright.config.ts's projects: it serves another tree's bundle.
//   npm run test:rollback -- --project=chromium
import { defineConfig } from '@playwright/test'
import { WEB_PORT as PORT } from '../e2e/support/ports'

const isCI = Boolean(process.env.CI)
const dist = process.env.CANOPI_ROLLBACK_WEB_DIST ?? 'dist-web'

export default defineConfig({
  testDir: '.',
  retries: 0,
  forbidOnly: isCI,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.CANOPI_ROLLBACK_OUTPUT ?? '../test-results/rollback',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${PORT}/web.html`,
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    // The reader's bundle as built, served at the root base as the Web Edition's preview server serves dist-web.
    command: `npx vite preview --mode web --outDir ${JSON.stringify(dist)} --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://localhost:${PORT}/web.html`,
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
})
