import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { placeSearchFocusRequest } from "../app/geocoding/place-search-ui";
import { installPhoneLayout, phoneLayout } from "../app/shell/phone-layout";
import { t } from "../i18n";
import { PlaceSearchField } from "../components/canvas/PlaceSearch";
import { ToolIcon } from "../components/canvas/toolbar-icons";
import { ButtonTooltip } from "../components/shared/ButtonTooltip";
import { ControlIcon } from "../components/shared/ControlIcon";
import { DesignNameField } from "../components/shared/DesignNameField";
import { PanelRail } from "../components/shared/PanelRail";
import { SaveStatusLabel } from "../components/shared/SaveStatusLabel";
import { useChromeRow } from "../components/shared/useMapChrome";
import { useModalInertRegion } from "../components/shared/useModalLayer";
import { WorkspaceTitleBar, type TitleBarCommand } from "../components/shared/WorkspaceTitleBar";
import titleBarStyles from "../components/shared/WorkspaceTitleBar.module.css";
import {
  type BrowserShellChromeProjection,
  type BrowserShellDesignIdentity,
  type BrowserShellProjectedCommand,
} from "./browser-shell-commands";
import {
  browserShellNotice,
  dismissBrowserShellNotice,
  type BrowserShellNotice as BrowserShellNoticeState,
} from "./browser-shell-notice";
import { DRAFT_PERSISTENCE_REASON } from "./browser-draft-persistence";
import styles from "./BrowserAppShell.module.css";

interface BrowserAppShellProps {
  readonly commandProjection: BrowserShellChromeProjection;
  readonly designIdentity?: BrowserShellDesignIdentity | null;
  readonly onRenameDesign?: (name: string) => void;
  readonly onRetrySave?: () => void;
  /** Settles a Draft another browser tab changed. */
  readonly onResolveSaveConflict?: () => void;
  /** Whether the title bar offers the place search (while a Design is open). */
  readonly placeSearch?: boolean;
  /** Undo, which the phone top bar carries in place of the tool rail's history. */
  readonly undo?: TitleBarCommand;
  /** The browser may clear Drafts (2.1-Q82): the save status warns, with the reason. */
  readonly draftsMayBeCleared?: boolean;
  /** Unkept Drafts at launch and not yet answered (review F1): while a Design is open, the reason shows as a row
   *  under the title bar, so it is on screen before File › New or Open (or Ctrl O) asks. Text only, no link (Q192). */
  readonly draftPersistenceReason?: boolean;
  readonly children?: ComponentChildren;
}

/**
 * The Web Edition frame: the same floating title bar and panel rail as
 * Desktop over a full-bleed workspace. Saving is to this browser; a copy is
 * a download. It owns the phone layout (`installPhoneLayout`): on a phone the
 * title bar becomes the 44 px top bar (Menu, the Design name and status,
 * Undo and a place search button that opens the search over the map), and
 * the workspace's phone sheet stands in for the panel rail.
 */
export function BrowserAppShell({
  commandProjection,
  designIdentity = null,
  onRenameDesign,
  onRetrySave,
  onResolveSaveConflict,
  placeSearch = false,
  undo,
  draftsMayBeCleared = false,
  draftPersistenceReason = false,
  children,
}: BrowserAppShellProps) {
  const notice = browserShellNotice.value;
  const [reasonDismissed, setReasonDismissed] = useState(false);
  const reasonRow = draftPersistenceReason && designIdentity !== null && !reasonDismissed;
  // The whole frame sits behind a modal dialog; the dialogs mount outside it.
  const shell = useRef<HTMLDivElement>(null);
  useModalInertRegion(shell);
  useLayoutEffect(() => installPhoneLayout(window), []);
  const phone = phoneLayout.value;
  const [searching, setSearching] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const phoneSearchOpen = phone !== null && placeSearch && searching;
  // Leaving the phone layout puts the field back in the bar and forgets the card.
  useEffect(() => { if (!phone) setSearching(false); }, [phone]);
  // View › Search a place (Ctrl K) opens the search card on a phone, where no field waits in the bar.
  const seenSearchRequest = useRef(placeSearchFocusRequest.peek());
  useSignalEffect(() => {
    const request = placeSearchFocusRequest.value;
    if (request === seenSearchRequest.current) return;
    seenSearchRequest.current = request;
    if (phoneLayout.peek() !== null) setSearching(true);
  });
  const closePhoneSearch = () => {
    setSearching(false);
    searchButton.current?.focus();
  };
  const commands = commandProjection.commands;
  const help = requireCommand(commands.get("help.shortcuts"), "help.shortcuts");
  const settings = requireCommand(commands.get("app.settings"), "app.settings");
  const openCanopi = commands.get("file.openCanopi");
  const download = commands.get("file.downloadCanopi");
  const downloadAction = {
    label: t("webShell.downloadCopy"),
    run: () => download?.action(),
  };

  return (
    <div ref={shell} className={styles.shell} data-testid="browser-app-shell" data-phone-layout={phone ?? undefined}>
      <main className={styles.workspace} aria-label={t("webShell.workspace")}>
        {children}
      </main>
      <WorkspaceTitleBar
        menus={commandProjection.workspaceMenus}
        design={designIdentity ? (
          <>
            <DesignNameField name={designIdentity.name} onRename={(name) => onRenameDesign?.(name)} />
            <SaveStatusLabel
              status={designIdentity.saveStatus}
              failureReason={designIdentity.saveFailureReason}
              draftLabel={t("webShell.savedInBrowser")}
              draftAction={{ ...downloadAction, style: "link" }}
              draftWarning={draftsMayBeCleared
                ? { label: t("webStorage.statusWarning"), reason: t("webStorage.statusDetails") }
                : null}
              saveElsewhere={downloadAction}
              onRetry={() => onRetrySave?.()}
              conflictSource="another-tab"
              onResolveConflict={onResolveSaveConflict}
            />
          </>
        ) : undefined}
        fileActions={openCanopi ? (
          <button
            type="button"
            className={titleBarStyles.iconButton}
            data-web-command-id={openCanopi.id}
            aria-label={t("webShell.openCanopiFile")}
            aria-keyshortcuts={openCanopi.ariaShortcut}
            onClick={() => openCanopi.action()}
          >
            <ControlIcon name="folder-open" size={20} />
            <ButtonTooltip label={t("webShell.openCanopiFile")} shortcut={openCanopi.shortcut} side="bottom" />
          </button>
        ) : undefined}
        search={phone ? (
          <>
            {undo && <TitleBarUndo command={undo} />}
            {placeSearch && (
              <button
                ref={searchButton}
                type="button"
                className={titleBarStyles.iconButton}
                aria-label={t("canvas.placeSearch.placeholderShort")}
                aria-expanded={phoneSearchOpen}
                data-phone-search
                data-design-chrome
                onClick={() => setSearching(!searching)}
              >
                <ControlIcon name="search" size={20} />
              </button>
            )}
          </>
        ) : placeSearch ? <PlaceSearchField compact /> : undefined}
        help={help}
        settings={settings}
      />
      {phoneSearchOpen && <PhoneSearch onClose={closePhoneSearch} />}
      {/* The Web rail stays for Templates and the catalog, which work without a Design.
          On a phone the workspace's sheet carries the panels instead. */}
      {!phone && <PanelRail
        label={t("webShell.panels")}
        groups={[
          // The Design canvas and the Templates map are the two primary views; with
          // no Templates there is nothing to switch between.
          commandProjection.panelBar.primary.length > 1 ? commandProjection.panelBar.primary : [],
          commandProjection.panelBar.design,
          commandProjection.panelBar.planning,
        ]}
      />}
      {notice || reasonRow ? (
        <ShellNotices tone={notice?.tone ?? "info"}>
          {notice ? <ShellNotice notice={notice} onDismiss={dismissBrowserShellNotice} /> : null}
          {reasonRow ? (
            <ShellNotice
              notice={{ tone: "info", title: "", message: t("webStorage.reason") }}
              id={DRAFT_PERSISTENCE_REASON}
              onDismiss={() => setReasonDismissed(true)}
            />
          ) : null}
        </ShellNotices>
      ) : null}
    </div>
  );
}

/** Undo in the phone top bar: the tool strip there leaves history to it and to Edit. */
function TitleBarUndo({ command }: { readonly command: TitleBarCommand }) {
  return (
    <button
      type="button"
      className={titleBarStyles.iconButton}
      aria-label={command.label}
      aria-keyshortcuts={command.ariaShortcut}
      aria-disabled={command.disabled ? true : undefined}
      data-phone-undo
      data-design-chrome
      onClick={() => { if (!command.disabled) command.action(); }}
    >
      <ToolIcon name="undo" className={styles.undoIcon} />
    </button>
  );
}

/**
 * The place search on a phone (board WebPhoneSearch): a card over the top of
 * the map with Back and the field, its results below. Back, Escape and a
 * chosen place close it and return focus to the search button.
 */
function PhoneSearch({ onClose }: { readonly onClose: () => void }) {
  return (
    <div
      className={styles.phoneSearch}
      role="search"
      aria-label={t("canvas.placeSearch.placeholderShort")}
      data-phone-search-card
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <button type="button" className={titleBarStyles.iconButton} aria-label={t("webPhone.searchBack")} onClick={onClose}>
        <ControlIcon name="chevron-left" size={20} />
      </button>
      <PlaceSearchField compact autoFocus onPicked={onClose} />
    </div>
  );
}

/**
 * The Web notices: one row of their own below the title bar (`useChromeRow`), one live region, the shell notice
 * above the Draft persistence reason when both show.
 */
function ShellNotices({ tone, children }: { readonly tone: BrowserShellNoticeState["tone"]; readonly children: ComponentChildren }) {
  const row = useRef<HTMLDivElement>(null);
  useBelowTitleBar(row);
  useChromeRow(row);
  return (
    <div ref={row} className={styles.notices} role={tone === "error" ? "alert" : "status"} data-web-shell-notice>
      {children}
    </div>
  );
}

/**
 * Starts the notices row below the title bar as drawn: between 760 px and the phone layout the bar stacks the name
 * over its status and grows past `--title-bar-height` (review F1, neighbour matrix at 700×500). Runs before
 * `useChromeRow` measures the row.
 */
function useBelowTitleBar(ref: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const row = ref.current;
    const bar = row?.parentElement?.querySelector<HTMLElement>("[data-workspace-title-bar]");
    if (!row || !bar) return;
    const place = () => { row.style.top = `calc(${bar.offsetTop + bar.offsetHeight}px + var(--space-2))`; };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      row.style.removeProperty("top");
    };
  }, [ref]);
}

/** One dismissible Web notice: the shell notice, or the Draft persistence reason. */
function ShellNotice({ notice, id, onDismiss }: {
  readonly notice: BrowserShellNoticeState;
  readonly id?: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div className={styles.notice} data-tone={notice.tone} data-notice={id}>
      {notice.title ? <span className={styles.noticeTitle}>{notice.title}</span> : null}
      <span className={styles.noticeMessage}>{notice.message}</span>
      <button
        type="button"
        className={styles.noticeDismiss}
        aria-label={t("webShell.dismissNotice")}
        onClick={onDismiss}
      >
        <ControlIcon name="close" />
      </button>
    </div>
  );
}

function requireCommand(
  command: BrowserShellProjectedCommand | undefined,
  id: string,
): BrowserShellProjectedCommand {
  if (!command) throw new Error(`Browser shell projection requires '${id}'`);
  return command;
}
