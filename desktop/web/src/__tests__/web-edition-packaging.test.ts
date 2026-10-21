import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  validWebCatalogManifest,
  WEB_CATALOG_TEST_LOCALES,
} from './fixtures/web-catalog-manifest'

declare const process: {
  cwd(): string
  env: {
    TMPDIR?: string
    TEMP?: string
    TMP?: string
  }
}

const fsWithWriteAndTemp = fs as unknown as {
  existsSync(path: string): boolean
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  mkdtempSync(prefix: string): string
  readFileSync(path: string, encoding: 'utf8'): string
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  symlinkSync(target: string, path: string): void
  writeFileSync(path: string, content: string): void
}

const webRoot = process.cwd()
const scriptPath = joinPath(webRoot, 'scripts/package-web-edition.mjs')
const catalogFiles = (id: string) => [
  'images/images-0000.parquet',
  'manifest.json',
  ...WEB_CATALOG_TEST_LOCALES.map((locale) => `names/names-${locale}.parquet`),
  'species/species-0000.parquet',
].map((path) => `assets/catalog/${id}/${path}`).sort()

describe('Web Edition packaging', () => {
  it('names the commit of a worktree checked out on a branch, whose refs live in the common git dir (canopi-eon8.15.2)', async () => {
    const { execFileSync } = (await import('node:child_process')) as unknown as {
      execFileSync(file: string, args: string[], options: { cwd: string; encoding: 'utf8' }): string
    }
    const temp = fsWithWriteAndTemp.mkdtempSync(joinPath(process.env.TMPDIR ?? '/tmp', 'canopi-git-'))
    try {
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
      const main = joinPath(temp, 'main')
      fsWithWriteAndTemp.mkdirSync(main, { recursive: true })
      git(main, 'init', '-q', '-b', 'main')
      fsWithWriteAndTemp.writeFileSync(joinPath(main, 'file.txt'), 'one')
      git(main, 'add', 'file.txt')
      git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'one')
      const worktree = joinPath(temp, 'wt')
      git(main, 'worktree', 'add', '-q', '-b', 'wt/branch', worktree)
      fsWithWriteAndTemp.writeFileSync(joinPath(worktree, 'file.txt'), 'two')
      git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-am', 'two')
      const { readGitCommit } = await import(toFileUrl(scriptPath)) as { readGitCommit(root: string): string }

      expect(readGitCommit(worktree)).toBe(git(worktree, 'rev-parse', 'HEAD').slice(0, 12))
      expect(readGitCommit(main)).toBe(git(main, 'rev-parse', 'HEAD').slice(0, 12))
    } finally {
      fsWithWriteAndTemp.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('creates a versioned /app artifact with manifest checksums and an index entry', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(joinPath(dist, 'assets'), { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script type="module" src="/app/assets/web.js"></script>\n')
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'assets', 'web.js'), "console.log('web')\n")
      const catalogId = writeCatalogFixture(dist)

      const { packageWebEdition } = await loadPackager()
      await packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 8192,
      })

      const artifactDir = joinPath(out, 'canopi-web-edition-v0.9.1-abcdef1')
      const manifestPath = joinPath(artifactDir, 'canopi-web-edition-manifest.json')
      const manifest = JSON.parse(fsWithWriteAndTemp.readFileSync(manifestPath, 'utf8')) as {
        version: string
        commit: string
        basePath: string
        spaFallback: { source: string; destination: string; status: number }
        catalog: { manifestPath: string; files: string[] }
        files: Array<{ path: string; bytes: number; sha256: string }>
      }

      expect(catalogId).toMatch(/^[0-9a-f]{16}$/)
      expect(manifest.catalog.manifestPath).toBe(`assets/catalog/${catalogId}/manifest.json`)
      expect(manifest.catalog.files).toContain(`assets/catalog/${catalogId}/species/species-0000.parquet`)
      expect(fsWithWriteAndTemp.existsSync(joinPath(artifactDir, 'index.html'))).toBe(true)
      expect(fsWithWriteAndTemp.existsSync(joinPath(artifactDir, 'web.html'))).toBe(false)
      expect(fsWithWriteAndTemp.existsSync(joinPath(out, 'canopi-web-edition-v0.9.1-abcdef1.tar.gz'))).toBe(true)
      expect(manifest.version).toBe('0.9.1')
      expect(manifest.commit).toBe('abcdef1')
      expect(manifest.basePath).toBe('/app/')
      expect(manifest.spaFallback).toEqual({
        source: '/app/*',
        destination: '/app/index.html',
        status: 200,
      })
      expect(manifest.files.map((file) => file.path).sort()).toEqual([
        'assets/web.js',
        ...catalogFiles(catalogId),
        'index.html',
      ].sort())
      expect(manifest.files.find((file) => file.path === 'assets/web.js')).toMatchObject({
        bytes: 19,
        sha256: 'bf9701e79b9afe9cdd0c900f3e9e890906762d7e71bf5e19d3d4860b3349dd21',
      })
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('creates an explicit root-base artifact without an app wrapper directory', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(joinPath(dist, 'assets'), { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script type="module" src="/assets/web.js"></script>\n')
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'assets', 'web.js'), "console.log('web')\n")
      const catalogId = writeCatalogFixture(dist)

      const { packageWebEdition } = await loadPackager()
      await packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 8192,
        basePath: '/',
      })

      const artifactDir = joinPath(out, 'canopi-web-edition-root-v0.9.1-abcdef1')
      const manifestPath = joinPath(artifactDir, 'canopi-web-edition-manifest.json')
      const manifest = JSON.parse(fsWithWriteAndTemp.readFileSync(manifestPath, 'utf8')) as {
        basePath: string
        spaFallback: { source: string; destination: string; status: number }
        files: Array<{ path: string }>
      }

      expect(fsWithWriteAndTemp.existsSync(joinPath(artifactDir, 'index.html'))).toBe(true)
      expect(fsWithWriteAndTemp.existsSync(joinPath(out, 'canopi-web-edition-root-v0.9.1-abcdef1.tar.gz'))).toBe(true)
      expect(fsWithWriteAndTemp.existsSync(joinPath(artifactDir, 'app'))).toBe(false)
      expect(fsWithWriteAndTemp.readFileSync(joinPath(artifactDir, 'index.html'), 'utf8')).not.toContain('/app/')
      expect(manifest.basePath).toBe('/')
      expect(manifest.spaFallback).toEqual({
        source: '/*',
        destination: '/index.html',
        status: 200,
      })
      expect(manifest.files.map((file) => file.path).sort()).toEqual([
        'assets/web.js',
        ...catalogFiles(catalogId),
        'index.html',
      ].sort())
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects root-base packaging when the build output still targets /app/', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(joinPath(dist, 'assets'), { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script type="module" src="/app/assets/web.js"></script>\n')
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'assets', 'web.js'), "console.log('web')\n")
      writeCatalogFixture(dist)

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 8192,
        basePath: '/',
      })).rejects.toThrow(/CANOPI_WEB_BASE_PATH=\/.*\/app\//i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when a generated asset exceeds the Cloudflare Pages per-asset limit', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '0123456789')

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 8,
      })).rejects.toThrow(/Cloudflare Pages per-asset limit.*web\.html/s)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when the generated catalog manifest is missing', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/missing generated Species Catalog manifest/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when supported-filter metadata is missing from the catalog manifest', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      writeCatalogFixture(dist, (manifest) => {
        manifest.supported_filters = []
      })

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/supported_filters/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when the generated catalog manifest is not Parquet-backed', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      writeCatalogFixture(dist, (manifest) => {
        manifest.asset_format = 'ndjson'
      })

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/asset_format.*parquet/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when the catalog manifest was generated from a stale artifact contract', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      writeCatalogFixture(dist, (manifest) => {
        manifest.artifact_contract_fingerprint = '0'.repeat(64)
      })

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/artifact_contract_fingerprint/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a catalog asset symlink even when its target matches the manifest', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      const catalogId = writeCatalogFixture(dist)
      const assetPath = joinPath(dist, `assets/catalog/${catalogId}/species/species-0000.parquet`)
      const outsidePath = joinPath(workspace, 'outside-species.parquet')
      fsWithWriteAndTemp.writeFileSync(outsidePath, fsWithWriteAndTemp.readFileSync(assetPath, 'utf8'))
      fsWithWriteAndTemp.rmSync(assetPath)
      fsWithWriteAndTemp.symlinkSync(outsidePath, assetPath)

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/symbolic link.*species-0000\.parquet/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a catalog asset directory symlink', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      const catalogId = writeCatalogFixture(dist)
      const speciesDir = joinPath(dist, `assets/catalog/${catalogId}/species`)
      const outsideDir = joinPath(workspace, 'outside-species')
      fsWithWriteAndTemp.mkdirSync(outsideDir, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(
        joinPath(outsideDir, 'species-0000.parquet'),
        fsWithWriteAndTemp.readFileSync(joinPath(speciesDir, 'species-0000.parquet'), 'utf8'),
      )
      fsWithWriteAndTemp.rmSync(speciesDir, { recursive: true })
      fsWithWriteAndTemp.symlinkSync(outsideDir, speciesDir)

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/symbolic link.*species/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when a generated catalog asset checksum does not match its manifest entry', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      writeCatalogFixture(dist, (manifest) => {
        const assets = manifest.assets as {
          species: Array<{ sha256: string }>
        }
        assets.species[0]!.sha256 = '0'.repeat(64)
      })

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/checksum mismatch.*species\/species-0000\.parquet/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when a generated catalog asset listed in the manifest is missing', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      const catalogId = writeCatalogFixture(dist)
      fsWithWriteAndTemp.rmSync(joinPath(dist, `assets/catalog/${catalogId}/species/species-0000.parquet`))

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/catalog asset is missing.*species\/species-0000\.parquet/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when a generated catalog asset byte count does not match its manifest entry', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      writeCatalogFixture(dist, (manifest) => {
        const assets = manifest.assets as {
          species: Array<{ bytes: number }>
        }
        assets.species[0]!.bytes = 999
      })

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/byte count mismatch.*species\/species-0000\.parquet/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when the static artifact contains raw DuckDB WASM', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(joinPath(dist, 'assets'), { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'assets', 'duckdb-browser.wasm'), 'raw-wasm')
      writeCatalogFixture(dist)

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
      })).rejects.toThrow(/must not bundle DuckDB raw WASM/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails when the Web Edition artifact exceeds the Cloudflare Pages file-count limit', async () => {
      const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      writeCatalogFixture(dist)

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 32_768,
        maxFileCount: 4,
      })).rejects.toThrow(/above the Cloudflare Pages file limit 4/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('counts the artifact manifest against the Cloudflare Pages file-count limit', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(joinPath(dist, 'assets'), { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script type="module" src="/app/assets/web.js"></script>\n')
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'assets', 'web.js'), "console.log('web')\n")
      writeCatalogFixture(dist)

      const { packageWebEdition } = await loadPackager()

      await expect(packageWebEdition({
        distRoot: dist,
        artifactRoot: out,
        version: '0.9.1',
        commit: 'abcdef1',
        maxAssetBytes: 8192,
        maxFileCount: 16,
      })).rejects.toThrow(/contains 17 files.*Cloudflare Pages file limit 16/i)
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('refuses a catalog outside assets/catalog/<id>/ and a directory not named by its manifest hash', async () => {
    const workspace = createWorkspace()
    try {
      const dist = joinPath(workspace, 'dist-web')
      const out = joinPath(workspace, 'artifacts')
      fsWithWriteAndTemp.mkdirSync(dist, { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'web.html'), '<script></script>')
      const catalogId = writeCatalogFixture(dist)
      const { packageWebEdition } = await loadPackager()
      const options = { distRoot: dist, artifactRoot: out, version: '0.9.1', commit: 'abcdef1', maxAssetBytes: 32_768 }

      fsWithWriteAndTemp.mkdirSync(joinPath(dist, 'canopi-catalog'), { recursive: true })
      fsWithWriteAndTemp.writeFileSync(joinPath(dist, 'canopi-catalog/manifest.json'), '{}')
      await expect(packageWebEdition(options)).rejects.toThrow(/canopi-catalog\/manifest\.json.*assets\/catalog\/<id>/)
      fsWithWriteAndTemp.rmSync(joinPath(dist, 'canopi-catalog'), { recursive: true })

      const manifest = joinPath(dist, `assets/catalog/${catalogId}/manifest.json`)
      fsWithWriteAndTemp.writeFileSync(manifest, `${fsWithWriteAndTemp.readFileSync(manifest, 'utf8')}\n`)
      await expect(packageWebEdition(options)).rejects.toThrow(new RegExp(`catalog directory ${catalogId} is not the content id`))
    } finally {
      fsWithWriteAndTemp.rmSync(workspace, { recursive: true, force: true })
    }
  })
})

function createWorkspace(): string {
  return fsWithWriteAndTemp.mkdtempSync(joinPath(
    process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? '/tmp',
    'canopi-web-artifact-',
  ))
}

/** Writes the catalog where the Web build's catalog plugin puts it and returns its content id. */
function writeCatalogFixture(
  dist: string,
  mutateManifest?: (manifest: Record<string, unknown>) => void,
): string {
  const files = new Map<string, string>()
  const manifest = validWebCatalogManifest()
  const assets = manifest.assets as {
    species: CatalogAssetEntry[]
    names: Record<string, CatalogAssetEntry>
    images: CatalogAssetEntry[]
  }
  const catalogAssets = [
    ...assets.species,
    ...Object.values(assets.names),
    ...assets.images,
  ]
  for (const asset of catalogAssets) {
    const content = `catalog-data:${asset.path}`
    asset.bytes = content.length
    asset.sha256 = createHash('sha256').update(content).digest('hex')
    files.set(asset.path, content)
  }
  mutateManifest?.(manifest)
  const manifestJson = JSON.stringify(manifest, null, 2)
  files.set('manifest.json', manifestJson)
  const id = createHash('sha256').update(manifestJson).digest('hex').slice(0, 16)
  for (const [path, content] of files) {
    const fullPath = joinPath(dist, 'assets/catalog', id, path)
    fsWithWriteAndTemp.mkdirSync(fullPath.split('/').slice(0, -1).join('/'), { recursive: true })
    fsWithWriteAndTemp.writeFileSync(fullPath, content)
  }
  return id
}

interface CatalogAssetEntry {
  path: string
  bytes: number
  sha256: string
}

async function loadPackager(): Promise<{
  packageWebEdition(options: {
    distRoot: string
    artifactRoot: string
    version: string
    commit: string
    maxAssetBytes: number
    maxFileCount?: number
    basePath?: string
  }): Promise<void>
}> {
  return await import(toFileUrl(scriptPath)) as {
    packageWebEdition(options: {
      distRoot: string
      artifactRoot: string
      version: string
      commit: string
      maxAssetBytes: number
      maxFileCount?: number
      basePath?: string
    }): Promise<void>
  }
}

function joinPath(...parts: readonly string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) => {
      if (index === 0) return part.replace(/\/+$/, '')
      return part.replace(/^\/+|\/+$/g, '')
    })
    .join('/')
}

function toFileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
