// app/saved-object-stamps/row-state.ts
// Owner of what a listed saved stamp offers and where a newer one lists (Step 2.0.4 R2-5, canopi-f47t.52.271). It sits
// beside the stamp workbench, not in the payload codec (canvas/saved-object-stamp-payload.ts), so the codec the arming
// chunk carries keeps only what placing a stamp reads (bundle-size, 2.1-Q203).

/** The payload version Canopi wrote before 2.0 (ADR 0021). */
const SAVED_OBJECT_STAMP_PAYLOAD_VERSION_BEFORE_2_0 = 1

/**
 * True for a payload written by Canopi before 2.0 (version 1). Canopi 2.0
 * cannot place, drag, export or convert it (ADR 0021); it can only delete it.
 * The one classifier for Favorites and the tool card's stamp chooser.
 */
export function isSavedObjectStampPayloadFromBefore2_0(raw: string): boolean {
  if (!raw) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && 'version' in parsed
      && parsed.version === SAVED_OBJECT_STAMP_PAYLOAD_VERSION_BEFORE_2_0
  } catch {
    // A payload that is not JSON is no stamp Canopi wrote before 2.0 either.
    return false
  }
}

/**
 * What a listed stamp offers, the one classifier for Favorites, the tool card's stamp chooser and the workbench:
 * `ready`; `before-2-0`, Delete only (ADR 0021); `needs-newer`, a payload newer than v2 that the stamp store marks in
 * its listing (2.1-M88): listed by name, never placed, dragged, renamed, reordered or deleted.
 */
export type SavedObjectStampRowState = 'ready' | 'before-2-0' | 'needs-newer'

export function savedObjectStampRowState(
  stamp: { readonly payload_json: string; readonly needs_newer?: boolean | undefined },
): SavedObjectStampRowState {
  if (stamp.needs_newer === true) return 'needs-newer'
  return isSavedObjectStampPayloadFromBefore2_0(stamp.payload_json) ? 'before-2-0' : 'ready'
}

/**
 * Moves the ids of `needs-newer` stamps after the others, keeping each part's order: the library lists them last, and
 * a reorder renumbers only the others, so a drop past one lands above it (canopi-f47t.52.271).
 */
export function savedObjectStampIdsNeedsNewerLast(
  ids: readonly string[],
  stamps: readonly { readonly id: string; readonly needs_newer?: boolean | undefined }[],
): readonly string[] {
  const needsNewer = new Set(stamps.filter((stamp) => stamp.needs_newer === true).map((stamp) => stamp.id))
  return [...ids.filter((id) => !needsNewer.has(id)), ...ids.filter((id) => needsNewer.has(id))]
}
