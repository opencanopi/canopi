import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The release smoke's macOS probe (scripts/release_smoke.py, 2.1-Q136) drives the real app through its bridge by data
// attributes and notice keys. It reports and never blocks, so an attribute the app stops rendering only times it out.
const PROBE = readFileSync(resolve('../../scripts/release_smoke.py'), 'utf8')

const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
})

describe('the release probe selectors', () => {
  it('[canopi-hul9] every data attribute and notice key the macOS probe queries is rendered by the app', () => {
    const app = sources(resolve('src')).map((path) => readFileSync(path, 'utf8')).join('\n')
    const attributes = [...new Set([...PROBE.matchAll(/\[(data-[a-z-]+)/g)].map((match) => match[1]!))]
    const keys = [...new Set([...PROBE.matchAll(/noticeKey === '([\w.-]+)'/g)].map((match) => match[1]!))]

    expect(attributes).toContain('data-notice-row')
    expect(keys).toEqual(['update.available'])
    expect(attributes.filter((name) => !app.includes(name))).toEqual([])
    expect(keys.filter((key) => !app.includes(`'${key}'`))).toEqual([])
  })
})
