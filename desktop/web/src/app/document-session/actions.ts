// app/document-session/actions.ts
// Single-authority Design Session actions backed exclusively by the live Session Core (C4, ADR 0024, contracts §4).

import { computed } from "@preact/signals";
import type { DraftId, FileGrantId } from "../../platform/design-home";
import { editionPorts } from "../../platform/edition-ports";
import type { CanopiFile } from "../../types/design";
import { applyNewDesignBackground } from "../settings/new-design-defaults";
import type { DeepReadonly } from "./core";
import { activeSessionCore, getLiveSessionCore, requireLiveSessionCore } from "./live-core";
import { presentDesignOpenFailure } from "./open-failure";
import { requestSaveProblemDecision } from "./save-problem";
import { saveStatusOf, type DesignSaveStatus } from "./save-status";

export interface DesignSaveSettlement {
  readonly status: "applied" | "stale";
  readonly path: string | null;
  readonly content: DeepReadonly<CanopiFile>;
}

export const designSaveStatus = computed<DesignSaveStatus>(() => {
  const core = activeSessionCore.value;
  const open = core?.currentDesign.value;
  if (!core || !open) return "saved";
  return saveStatusOf(open.save, core.dirty.value, {
    readOnly: open.readOnly,
    homeKind: open.home.kind,
  });
});

export const designSaveFailureReason = computed<string | null>(() => {
  const save = activeSessionCore.value?.currentDesign.value?.save;
  if (!save) return null;
  if (save.kind === "failed" || save.kind === "refused") return save.reason;
  if (save.kind === "quota") return "quota_refused";
  if (save.kind === "copy_blocked") return save.folder;
  return null;
});

export const designRevertAvailable = computed<boolean>(
  () => activeSessionCore.value?.revertAvailable.value ?? false,
);

export async function saveCurrentDesign(): Promise<boolean> {
  const core = requireLiveSessionCore();
  const open = core.currentDesign.peek();
  if (!open || open.readOnly) return false;
  if (open.home.kind === "file") return core.flushNow({ force: true });
  const settlement = await saveAsCurrentDesign();
  return settlement?.status === "applied";
}

export async function saveCurrentDesignEdits(): Promise<boolean> {
  const core = requireLiveSessionCore();
  const open = core.currentDesign.peek();
  if (!open || open.readOnly) return false;
  return core.flushNow();
}

export async function saveAsCurrentDesign(): Promise<DesignSaveSettlement | null> {
  const core = requireLiveSessionCore();
  const open = core.currentDesign.peek();
  if (!open || open.readOnly) return null;

  let outcome = await core.saveAs();
  if (outcome === "conflict") {
    const afterConflict = core.currentDesign.peek();
    const fileGone = afterConflict?.save.kind === "conflict" && afterConflict.save.current === null;
    const choice = await requestSaveProblemDecision({ kind: "conflict", fileGone });
    if (choice === "keep-mine" || choice === "save-copy") {
      const resolved = await core.resolveConflict(choice === "save-copy" ? "save-as" : "keep-mine");
      outcome = resolved === "resolved" ? "saved" : "failed";
    } else {
      return null;
    }
  }
  if (outcome !== "saved") return null;
  const saved = core.currentDesign.peek();
  const content = core.snapshot();
  if (!saved || !content) return null;
  return {
    status: "applied",
    path: saved.home.kind === "file" ? saved.home.key : null,
    content,
  };
}

export async function retryDesignSave(): Promise<void> {
  const core = requireLiveSessionCore();
  if (!core.currentDesign.peek()) return;
  await core.flushNow({ force: true });
}

export async function resolveDesignConflict(): Promise<void> {
  const core = requireLiveSessionCore();
  const open = core.currentDesign.peek();
  if (!open || open.save.kind !== "conflict") return;
  const choice = await requestSaveProblemDecision({ kind: "conflict", fileGone: open.save.current === null });
  if (choice === "cancel") return;
  if (choice === "use-file") {
    await core.resolveConflict("use-file");
    return;
  }
  await core.resolveConflict(choice === "save-copy" ? "save-as" : "keep-mine");
}

export async function revertDesign(): Promise<void> {
  const core = requireLiveSessionCore();
  if (!core.revertAvailable.peek()) return;
  const choice = await requestSaveProblemDecision({ kind: "revert" });
  if (choice !== "revert") return;
  await core.revert();
}

function toOpenError(error: unknown, fallbackReason: string): Error {
  if (error instanceof Error) return error;
  const err = new Error(fallbackReason);
  if (error && typeof error === "object") Object.assign(err, error);
  return err;
}

export async function openDesignDraft(
  id: string,
  options: { readonly presentFailure?: boolean } = {},
): Promise<void> {
  const core = requireLiveSessionCore();
  const result = await core.openFrom({ kind: "draft", id: id as DraftId });
  if (result.status === "refused") {
    const error = toOpenError(result.error, result.reason);
    if (options.presentFailure !== false) presentDesignOpenFailure(result.error ?? error);
    throw error;
  }
}

export async function openDesign(): Promise<void> {
  requireLiveSessionCore();
  const picked = await editionPorts().fileAccess.pickOpen("canopi");
  if (picked.kind === "cancelled") return;
  await openDesignFileHome(picked);
}

async function openDesignFileHome(
  target: {
    readonly grant: FileGrantId;
    readonly displayName?: string;
    readonly recentId?: string;
  },
  options: { readonly presentFailure?: boolean } = {},
): Promise<void> {
  const core = requireLiveSessionCore();
  const result = await core.openFrom({
    kind: "file",
    grant: target.grant,
    ...(target.displayName ? { displayName: target.displayName } : {}),
    ...(target.recentId ? { recentId: target.recentId } : {}),
  });
  if (result.status === "refused") {
    const error = toOpenError(result.error, result.reason);
    if (options.presentFailure !== false) presentDesignOpenFailure(result.error ?? error);
    throw error;
  }
}

export async function openDesignFromPath(
  grant: FileGrantId,
  options: {
    readonly presentFailure?: boolean;
    readonly grant?: FileGrantId;
    readonly displayName?: string;
    readonly recentId?: string;
  } = {},
): Promise<void> {
  await openDesignFileHome(
    {
      grant: options.grant ?? grant,
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.recentId ? { recentId: options.recentId } : {}),
    },
    options,
  );
}

export async function newDesignAction(): Promise<void> {
  const core = requireLiveSessionCore();
  const result = await core.createNew();
  if (result.status === "opened") applyNewDesignBackground();
  if (result.status === "refused") {
    throw new Error(result.reason);
  }
}

export async function closeDesign(): Promise<void> {
  const core = getLiveSessionCore();
  if (!core) return;
  await core.close("close");
}
