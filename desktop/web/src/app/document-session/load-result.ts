// app/document-session/load-result.ts
// What a document transition's load hands the Design Session state machine, and how the native load's answers map onto
// it: a Design or Draft a newer Canopi saved comes as its read view (`ReadOnlyDesign`) and opens in the read-only
// Session kind, with no path, Draft id or fingerprint (2.1-M478).

import type { ReadOnlyDesign } from "../../generated/contracts";
import type { CanopiFile, LoadedDesign } from "../../types/design";
import type { DesignSessionKind } from "./store";

export interface DocumentTransitionLoadResult {
  file: CanopiFile;
  path: string | null;
  name: string;
  /** Draft home of a pathless Design. */
  draftId?: string | null;
  /** Fingerprint of the loaded file at `path`. */
  fingerprint?: string | null;
  /** The home does not hold this content yet. */
  writePending?: boolean;
  /**
   * The session it opens in; `editing` when omitted. A `read-only` result carries no path, Draft id or fingerprint:
   * its session has no home (2.1-M478).
   */
  session?: DesignSessionKind;
}

/** The document a transition applies for a Design the native side loaded from `path`. */
export function loadResultOf(
  design: LoadedDesign | ReadOnlyDesign,
  path: string,
): DocumentTransitionLoadResult {
  if (isReadOnlyDesign(design)) return readOnlyLoadResultOf(design);
  return {
    file: design.file,
    path,
    name: design.file.name,
    fingerprint: design.fingerprint,
  };
}

/** The document a transition applies for the Draft `id`; a newer Draft opens without its Draft id. */
export function draftLoadResultOf(
  draft: CanopiFile | ReadOnlyDesign,
  id: string,
): DocumentTransitionLoadResult {
  if (isReadOnlyDesign(draft)) return readOnlyLoadResultOf(draft);
  return { file: draft, path: null, name: draft.name, draftId: id };
}

function readOnlyLoadResultOf(design: ReadOnlyDesign): DocumentTransitionLoadResult {
  return {
    file: design.view,
    path: null,
    name: design.view.name,
    session: { kind: "read-only", origin: "newer-version", savedByVersion: design.saved_by_version },
  };
}

/** The native load's two shapes are told apart by `saved_by_version`, which only the read view carries. */
function isReadOnlyDesign(
  design: LoadedDesign | CanopiFile | ReadOnlyDesign,
): design is ReadOnlyDesign {
  return "saved_by_version" in design;
}
