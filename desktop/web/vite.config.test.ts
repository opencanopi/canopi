import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'

import viteConfig from './vite.config'

describe('test timeout', () => {
  it('sets one test timeout in the config, the same for every run and project, and none on a command line (canopi-f47t.52.240)', async () => {
    const environment: ConfigEnv = { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false }
    const config: UserConfig = typeof viteConfig === 'function' ? await viteConfig(environment) : viteConfig
    const test = config.test as { testTimeout?: number; projects?: { test?: { testTimeout?: number } }[] }
    expect(test.testTimeout).toBe(120_000)
    for (const project of test.projects ?? []) {
      expect(project.test?.testTimeout ?? test.testTimeout).toBe(test.testTimeout)
    }
    const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(Object.entries(packageJson.scripts).filter(([, script]) => /--test-?timeout/i.test(script))).toEqual([])
  })
})
