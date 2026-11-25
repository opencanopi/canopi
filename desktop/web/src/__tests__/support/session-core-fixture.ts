/**
 * __tests__/support/session-core-fixture.ts: Real SessionCore test fixture with in-memory
 * DesignHomeStore, fake FileAccessPort, fake AppLifecyclePort, and JSON codec (Blueprint §2, 2b-3).
 */
import { encodeCanopiDesign } from '../../app/contracts/canopi-design-wire'
import type { AppLifecyclePort, LifecycleEvent } from '../../platform/app-lifecycle'
import type {
  DesignHome,
  DesignHomeStore,
  DesignHomeWriteResult,
  DraftId,
  DraftRecord,
  HomeRead,
  HomeVersion,
  LastOpenHome,
} from '../../platform/design-home'
import type { FileAccessPort, PickFileOutcome } from '../../platform/file-access'
import type { CanopiFile } from '../../types/design'
import { mintDraftId } from '../../utils/ids'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore, type SessionCore } from '../../app/document-session/live-core'
import type { DesignSessionKind } from '../../app/document-session/store'

export interface InMemoryDesignHomeStore extends DesignHomeStore {
  readonly files: Map<string, { bytes: Uint8Array; version: HomeVersion; updatedAt: string; name: string }>
  setWriteResult(next: DesignHomeWriteResult | null): void
  seedFile(key: string, file: CanopiFile, version?: HomeVersion): void
}

export function createInMemoryDesignHomeStore(): InMemoryDesignHomeStore {
  const files = new Map<string, { bytes: Uint8Array; version: HomeVersion; updatedAt: string; name: string }>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let versionCounter = 1
  let forcedWriteResult: DesignHomeWriteResult | null = null
  const listeners = new Set<() => void>()

  return {
    files,
    setWriteResult(next) {
      forcedWriteResult = next
    },
    seedFile(key, file, version = `v-${versionCounter++}`) {
      files.set(key, {
        bytes: encoder.encode(JSON.stringify(encodeCanopiDesign(file))),
        version,
        updatedAt: new Date().toISOString(),
        name: file.name || 'Untitled',
      })
    },
    async read(key: string): Promise<HomeRead> {
      const entry = files.get(key)
      if (!entry) return { kind: 'absent' }
      return { kind: 'present', bytes: Array.from(entry.bytes), version: entry.version }
    },
    async write(key: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult> {
      if (forcedWriteResult) return forcedWriteResult
      const existing = files.get(key)
      if (existing && expected !== null && existing.version !== expected) {
        return { kind: 'conflict', current: existing.version }
      }
      const nextVersion = `v-${versionCounter++}`
      let name = 'Untitled'
      try {
        name = (JSON.parse(decoder.decode(bytes)) as { name?: string }).name || 'Untitled'
      } catch {
        // Non-JSON bytes in test fixture; keep default name.
      }
      files.set(key, { bytes: new Uint8Array(bytes), version: nextVersion, updatedAt: new Date().toISOString(), name })
      for (const cb of listeners) cb()
      return { kind: 'written', version: nextVersion }
    },
    async listDrafts(): Promise<readonly DraftRecord[]> {
      return [...files.entries()].map(([id, entry]) => ({
        id: id as DraftId,
        updatedAt: entry.updatedAt,
        bytes: new Uint8Array(entry.bytes),
      }))
    },
    async deleteDraft(id: DraftId) {
      files.delete(id)
      return { ok: true as const }
    },
    onVersionChange(cb: () => void) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
}

export interface TestSessionCoreOptions {
  readonly file?: CanopiFile | null
  readonly path?: string | null
  readonly name?: string
  readonly kind?: DesignSessionKind
  readonly home?: InMemoryDesignHomeStore
  readonly flushDelayMs?: number
  readonly flushSettings?: () => Promise<void>
  readonly pickOpenResult?: PickFileOutcome
  readonly pickHomeTargetResult?: PickFileOutcome
  readonly newDesignFactory?: () => Promise<CanopiFile> | CanopiFile
  readonly install?: boolean
}

export interface TestSessionCoreHandle {
  readonly core: SessionCore
  readonly home: InMemoryDesignHomeStore
  readonly lifecycle: AppLifecyclePort & { emit(event: LifecycleEvent): void; destroyedCount(): number }
  readonly fileAccess: FileAccessPort & {
    setPickOpen(outcome: PickFileOutcome): void
    setPickHomeTarget(outcome: PickFileOutcome): void
  }
  readonly lastOpenHome: { current: DesignHome | null }
  dispose(): void
}

export function makeTestDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    extra: {},
    ...overrides,
  }
}

function createFakeLifecycle(): TestSessionCoreHandle['lifecycle'] {
  const listeners = new Set<(event: LifecycleEvent) => void>()
  let destroyed = 0
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async destroyWindow() { destroyed += 1 },
    emit(event) { for (const listener of listeners) listener(event) },
    destroyedCount: () => destroyed,
  }
}

function createFakeFileAccess(options: TestSessionCoreOptions): TestSessionCoreHandle['fileAccess'] {
  let pickOpenOutcome: PickFileOutcome = options.pickOpenResult ?? { kind: 'cancelled' }
  let pickHomeOutcome: PickFileOutcome = options.pickHomeTargetResult ?? { kind: 'cancelled' }
  return {
    async pickOpen() { return pickOpenOutcome },
    async pickHomeTarget() { return pickHomeOutcome },
    setPickOpen(outcome) { pickOpenOutcome = outcome },
    setPickHomeTarget(outcome) { pickHomeOutcome = outcome },
  }
}

function buildInitialDesign(
  options: TestSessionCoreOptions,
  home: InMemoryDesignHomeStore,
): Parameters<typeof createSessionCore>[0]['initialDesign'] | undefined {
  const initialFile = options.file ?? null
  if (!initialFile) return undefined
  const initialHome: DesignHome = options.path
    ? { kind: 'file', key: options.path, displayName: options.name ?? initialFile.name ?? options.path, version: 'v-0' }
    : { kind: 'draft', key: mintDraftId(), version: null }
  if (initialHome.kind === 'file') home.seedFile(initialHome.key, initialFile, 'v-0')
  const readOnly = options.kind?.kind === 'read-only'
  const savedByVersion = options.kind?.kind === 'read-only' && options.kind.origin === 'newer-version'
    ? options.kind.savedByVersion
    : null
  return {
    home: initialHome,
    file: options.name ? { ...initialFile, name: options.name } : initialFile,
    readOnly,
    savedByVersion,
  }
}

export function createTestSessionCore(options: TestSessionCoreOptions = {}): TestSessionCoreHandle {
  const home = options.home ?? createInMemoryDesignHomeStore()
  const lifecycle = createFakeLifecycle()
  const fileAccess = createFakeFileAccess(options)
  const lastOpenHome: { current: DesignHome | null } = { current: null }
  let storedLastOpen: LastOpenHome | null = null
  const initialDesign = buildInitialDesign(options, home)

  const core = createSessionCore({
    designHome: home,
    fileAccess,
    lifecycle,
    codec: createJsonSessionCodec(),
    settings: {
      readLastOpenHome: async () => storedLastOpen,
      writeLastOpenHome: async (next) => {
        lastOpenHome.current = next
        storedLastOpen = next
          ? (next.kind === 'draft' ? { kind: 'draft', id: next.key } : { kind: 'file', recent_id: next.key })
          : null
      },
      ...(options.flushSettings ? { flushSettings: options.flushSettings } : {}),
    },
    newDesignFactory: options.newDesignFactory ?? (() => {
      if (options.file) return JSON.parse(JSON.stringify(options.file)) as CanopiFile
      throw new Error('No newDesignFactory configured in createTestSessionCore')
    }),
    flushDelayMs: options.flushDelayMs ?? 1_500,
    ...(initialDesign ? { initialDesign } : {}),
  })

  const disposeLive = options.install === false ? () => core.dispose() : installLiveSessionCore(core)
  return { core, home, lifecycle, fileAccess, lastOpenHome, dispose: () => { disposeLive() } }
}
