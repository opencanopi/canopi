import { effect, signal, untracked } from '@preact/signals'
import type { convertFileSrc } from '@tauri-apps/api/core'
import type { RasterDisplayLayer } from '../../maplibre/raster-display/adapter'
import { lidarDisplayDescriptor, type LidarDisplayDescriptor } from '../../ipc/lidar'
import type { LibraryItemRole } from '../../generated/contracts'
import { lidarFailureMessage } from './lidar-failures'
import { cutOutlierRange, requestCutOutlierRange, resetCutOutlierRanges } from './display-range'
import { displayVariant, itemTypeStyle, type DisplayVariant, type LidarDisplayStyle, type RasterStyleInput } from './item-types'
import { storyPresentationOverrides } from '../story-presentation/overrides'
import { readCurrentLidarPresentation, refreshLidarLibrary, type LidarPresentationItem } from './library-store'

/**
 * Display descriptors of library entities, keyed by entity, generation and
 * variant (`displayVariant`: the relief Relief draws, else the elevation a
 * ramp colours).
 *
 * The library owns derivative preparation; this store only asks for the
 * descriptor of each generation something wants to draw or measure (a visible
 * Design reference, a library preview, or an entry set to Cut outliers) and
 * polls while it is preparing. Entries are identity-keyed, so a descriptor of
 * an older generation, or of the other variant, can never be used for this one.
 *
 * A key is asked only while something wants it: the map's effect, or a
 * caller holding the release `requestLidarDisplay` returns (a preview). At
 * most `MAX_CONCURRENT_CALLS` calls run at once, the rest queued, so a Data
 * library mounting every preview together never fills the user-data
 * executor's admissions and a Rename or Delete still finds a slot.
 *
 * A refused or failed call is no answer about the derivative: a wanted key is
 * asked again, ever more slowly with a random spread, so keys refused together
 * never re-ask together. A busy executor ("operations are busy") is only
 * waited out: it never reads Display failed. Any other call that keeps
 * failing reads Display failed until one answers, the entry of the call that
 * turned it marked surfaced through `lidarFailureMessage`. Every refused call
 * is recorded by the transport (2.1-M409), a repeat counted on the entry it
 * repeats (failures/ring.ts, canopi-vsey); the re-ask back-off bounds how fast
 * they come. When the last asker lets a key
 * go, its re-asks stop and a call-failure Display failed is dropped, so the
 * next asker asks afresh. A failed preparation is an answer and is never
 * asked again unasked.
 */
export const lidarDisplayDescriptors = signal<ReadonlyMap<string, LidarDisplayDescriptor>>(new Map())

const PREPARING_POLL_MS = 800
/** A refused call is asked again after 0.8 s, doubling up to this, each wait spread over its upper half. */
const MAX_REASK_MS = 30_000
/** Consecutive failed calls, busy refusals aside, before an entry reads Display failed. */
const FAILURES_BEFORE_FAILED = 3
/** Below the user-data executor's 8 admissions, so the library's own actions always find one. */
const MAX_CONCURRENT_CALLS = 4
const MAX_ENTRIES = 256

const inflight = new Set<string>()
/** Calls waiting for a free slot, in asking order. */
const queued = new Map<string, () => void>()
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** A key's run of failed calls: all of them (the back-off) and those that were no busy refusal (Display failed). */
const refusals = new Map<string, { calls: number, failures: number }>()
/** Unreleased `requestLidarDisplay` holds per key. */
const holders = new Map<string, number>()
/** Keys the map's effect asked for on its last run. */
let effectWanted: ReadonlySet<string> = new Set()
let storeGeneration = 0

/** A descriptor's identity: entity, generation and the derivative it draws, so relief and elevation never share one. */
export function displayKey(kind: LibraryItemRole, entityId: string, generationId: string | null, variant: DisplayVariant): string {
  return `${kind}/${entityId}/${generationId ?? ''}${variant === 'relief' ? '/relief' : ''}`
}

export function readLidarDisplay(
  kind: LibraryItemRole,
  entityId: string,
  generationId: string | null,
  variant: DisplayVariant,
): LidarDisplayDescriptor | null {
  return lidarDisplayDescriptors.value.get(displayKey(kind, entityId, generationId, variant)) ?? null
}

/** The derivative one entry draws; a reference whose item is gone draws nothing, so its elevation stands in. */
function entryVariant(item: Pick<LidarPresentationItem, 'itemType' | 'ramp'>): DisplayVariant {
  return item.itemType ? displayVariant(item.itemType, item) : 'elevation'
}

/** The descriptor of what one Site data entry draws, for its row's Preparing and Display failed. */
export function readLidarEntryDisplay(
  item: Pick<LidarPresentationItem, 'kind' | 'id' | 'generationId' | 'itemType' | 'ramp'>,
): LidarDisplayDescriptor | null {
  return item.generationId ? readLidarDisplay(item.kind, item.id, item.generationId, entryVariant(item)) : null
}

function store(key: string, descriptor: LidarDisplayDescriptor): void {
  const next = new Map(lidarDisplayDescriptors.value)
  next.delete(key)
  next.set(key, descriptor)
  while (next.size > MAX_ENTRIES) next.delete(next.keys().next().value!)
  lidarDisplayDescriptors.value = next
}

function wanted(key: string): boolean {
  return (holders.get(key) ?? 0) > 0 || effectWanted.has(key)
}

/** A busy executor refused admission: wait it out, it says nothing about the derivative. */
function isBusyRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /^Native [\w-]+ operations are busy; try again$/.test(message)
}

/** Nothing wants the key any more: stop its re-asks, and drop a Display failed that came from failed calls. */
function forget(key: string): void {
  clearTimeout(pollTimers.get(key))
  pollTimers.delete(key)
  queued.delete(key)
  if (!refusals.has(key)) return
  refusals.delete(key)
  if (lidarDisplayDescriptors.value.get(key)?.state !== 'Failed') return
  const next = new Map(lidarDisplayDescriptors.value)
  next.delete(key)
  lidarDisplayDescriptors.value = next
}

function drainQueue(): void {
  for (const [key, call] of queued) {
    if (inflight.size >= MAX_CONCURRENT_CALLS) return
    queued.delete(key)
    call()
  }
}

/**
 * Ask the library for one generation's descriptor of a variant unless an
 * answer that does not change on its own (ready, unavailable, failed) is
 * already stored, and hold the key until the returned release is called.
 */
export function requestLidarDisplay(
  kind: LibraryItemRole,
  entityId: string,
  generationId: string | null,
  variant: DisplayVariant,
  options: { retry?: boolean } = {},
): () => void {
  const key = displayKey(kind, entityId, generationId, variant)
  holders.set(key, (holders.get(key) ?? 0) + 1)
  const owner = storeGeneration
  ask(kind, entityId, generationId, variant, options.retry ?? false)
  let released = false
  return () => {
    if (released || owner !== storeGeneration) return
    released = true
    const left = (holders.get(key) ?? 1) - 1
    if (left > 0) holders.set(key, left)
    else holders.delete(key)
    if (!wanted(key)) forget(key)
  }
}

function ask(kind: LibraryItemRole, entityId: string, generationId: string | null, variant: DisplayVariant, retry: boolean): void {
  const key = displayKey(kind, entityId, generationId, variant)
  const relief = variant === 'relief'
  const current = lidarDisplayDescriptors.value.get(key)
  if (!retry && current && current.state !== 'Preparing' && !refusals.has(key)) return
  if (inflight.has(key) || (!retry && (pollTimers.has(key) || queued.has(key)))) return
  const owner = storeGeneration
  const again = (delay: number) => {
    pollTimers.set(key, setTimeout(() => {
      pollTimers.delete(key)
      if (owner === storeGeneration && wanted(key)) ask(kind, entityId, generationId, variant, false)
    }, delay))
  }
  const call = () => {
    inflight.add(key)
    void lidarDisplayDescriptor({
      kind,
      entity_id: entityId,
      expected_generation_id: generationId,
      retry,
      relief,
    })
      .then((descriptor) => {
        if (owner !== storeGeneration) return
        refusals.delete(key)
        store(key, descriptor)
        if (descriptor.state === 'Preparing') {
          if (wanted(key)) again(PREPARING_POLL_MS)
        } else if (descriptor.state === 'Stale') {
          // The item moved on: a fresh library read brings the new generation.
          void refreshLidarLibrary()
        }
      })
      .catch((error: unknown) => {
        if (owner !== storeGeneration || !wanted(key)) return
        const previous = refusals.get(key) ?? { calls: 0, failures: 0 }
        const run = { calls: previous.calls + 1, failures: previous.failures + (isBusyRefusal(error) ? 0 : 1) }
        refusals.set(key, run)
        if (run.failures === FAILURES_BEFORE_FAILED && run.failures > previous.failures) {
          store(key, {
            kind,
            entity_id: entityId,
            generation_id: generationId,
            profile: '',
            relief,
            state: 'Failed',
            // The row reads Display failed; the reason goes to diagnostics, once per run of failures.
            message: lidarFailureMessage(error),
            assets: [],
            prepared_assets: 0,
            total_assets: 0,
          })
        }
        clearTimeout(pollTimers.get(key))
        const base = Math.min(MAX_REASK_MS, PREPARING_POLL_MS * 2 ** (run.calls - 1))
        again(base * (0.5 + Math.random() / 2))
      })
      .finally(() => {
        if (owner !== storeGeneration) return
        inflight.delete(key)
        drainQueue()
      })
  }
  if (inflight.size >= MAX_CONCURRENT_CALLS) queued.set(key, call)
  else call()
}

/**
 * Whether the map draws an entry: as a presented story step shows it (its
 * library ids), else as the Design shows it (`shown`). Only the map reads the
 * story override, since the side dock is closed while a story is presented.
 */
function mapShown(
  item: Pick<LidarPresentationItem, 'id' | 'shown'>,
  presentedIds: ReadonlySet<string> | null,
): boolean {
  return presentedIds ? presentedIds.has(item.id) : item.shown
}

let displayDisposer: (() => void) | null = null

/**
 * Keep descriptors current for every reference the map draws, a presented
 * story step's included, of the variant it draws, and for every entry drawn
 * in Colours set to Cut outliers, shown or not, and read that entry's range
 * from its elevation once ready (`toAssetUrl` serves the display COGs). Relief
 * draws stored greys, so an entry drawing it reads no range.
 * Installed for the Desktop workspace lifetime next to the library workflow.
 */
export function installLidarDisplayDescriptors(toAssetUrl: (path: string) => string = lidarAssetUrl): void {
  disposeLidarDisplayDescriptors()
  displayDisposer = effect(() => {
    const presentedIds = storyPresentationOverrides.value?.siteDataIds ?? null
    const descriptors = lidarDisplayDescriptors.value
    const asked = new Set<string>()
    const asks: Array<() => void> = []
    for (const item of readCurrentLidarPresentation()) {
      if (item.availability !== 'present' || !item.generationId) continue
      const variant = entryVariant(item)
      const cutOutliers = variant === 'elevation' && item.range?.mode === 'CutOutliers'
      // A hidden entry set to Cut outliers still reads its range: its fields and legend show it, and Custom starts from it.
      if (mapShown(item, presentedIds) || cutOutliers) {
        const { kind, id, generationId } = item
        asked.add(displayKey(kind, id, generationId, variant))
        asks.push(() => ask(kind, id, generationId, variant, false))
      }
      if (!cutOutliers) continue
      const key = displayKey(item.kind, item.id, item.generationId, 'elevation')
      const descriptor = descriptors.get(key)
      if (descriptor?.state === 'Ready' && descriptor.generation_id === item.generationId) {
        requestCutOutlierRange(key, descriptor.assets.map((asset) => ({ url: toAssetUrl(asset.path), bbox: asset.bounds })))
      }
    }
    const dropped = [...effectWanted].filter((key) => !asked.has(key))
    effectWanted = asked
    // Untracked: forgetting writes the descriptors this effect reads.
    untracked(() => {
      for (const key of dropped) if (!wanted(key)) forget(key)
      for (const request of asks) request()
    })
  })
}

export function disposeLidarDisplayDescriptors(): void {
  displayDisposer?.()
  displayDisposer = null
  storeGeneration += 1
  resetCutOutlierRanges()
  for (const timer of pollTimers.values()) clearTimeout(timer)
  pollTimers.clear()
  refusals.clear()
  inflight.clear()
  queued.clear()
  holders.clear()
  effectWanted = new Set()
}

/** Replicates Tauri v2 `convertFileSrc` so pure projection stays testable. */
export function lidarAssetUrl(path: string): string {
  const encoded = encodeURIComponent(path)
  const platform = typeof navigator !== 'undefined' ? navigator.platform : ''
  return platform.startsWith('Win') ? `http://asset.localhost/${encoded}` : `asset://localhost/${encoded}`
}

/**
 * Upstream palette and stretch for one entry, always in its item's stored
 * units: its own ramp, Reverse and range over its item type's defaults, with
 * Cut outliers' range once it is read. A reference whose item is gone has no
 * type: it draws nothing and has no legend.
 */
export function lidarDisplayStyle(
  item: RasterStyleInput & Pick<LidarPresentationItem, 'kind' | 'id' | 'generationId' | 'itemType'>,
): LidarDisplayStyle | null {
  if (!item.itemType) return null
  const cutRange = item.range?.mode === 'CutOutliers' && item.generationId && entryVariant(item) === 'elevation'
    ? cutOutlierRange(displayKey(item.kind, item.id, item.generationId, 'elevation'))
    : null
  return itemTypeStyle(item.itemType, { ...item, cutRange })
}

/**
 * Project the references the map draws (`mapShown`) into renderer layers,
 * back to front, each from the derivative of the variant it draws; a relief
 * layer's id ends `-relief`, so the renderer never restyles one variant's
 * tiles into the other. A reference whose derivatives are not ready draws
 * nothing yet; the rest of the band keeps rendering.
 */
export function lidarDisplayLayers(
  items: readonly LidarPresentationItem[],
  descriptors: ReadonlyMap<string, LidarDisplayDescriptor>,
  presentedIds: ReadonlySet<string> | null,
  toAssetUrl: typeof convertFileSrc = lidarAssetUrl,
): RasterDisplayLayer[] {
  const layers: RasterDisplayLayer[] = []
  for (const item of items) {
    if (!mapShown(item, presentedIds) || item.availability !== 'present' || !item.generationId) continue
    const variant = entryVariant(item)
    const descriptor = descriptors.get(displayKey(item.kind, item.id, item.generationId, variant))
    if (!descriptor || descriptor.state !== 'Ready' || descriptor.generation_id !== item.generationId) continue
    if (descriptor.assets.length === 0) continue
    const style = lidarDisplayStyle(item)
    if (!style) continue
    const bounds = descriptor.assets.reduce<[number, number, number, number]>(
      (union, asset) => [
        Math.min(union[0], asset.bounds[0]),
        Math.min(union[1], asset.bounds[1]),
        Math.max(union[2], asset.bounds[2]),
        Math.max(union[3], asset.bounds[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    )
    layers.push({
      id: `lidar-${item.kind === 'Derived' ? 'result' : 'source'}-${item.id}-${item.generationId}${variant === 'relief' ? '-relief' : ''}`,
      name: item.name,
      assets: descriptor.assets.map((asset) => ({ url: toAssetUrl(asset.path), bbox: asset.bounds })),
      bounds,
      opacity: item.opacity,
      rescale: style.rescale,
      colormap: style.colormap,
      reversed: style.reversed,
    })
  }
  return layers
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLidarDisplayDescriptors()
  })
}
