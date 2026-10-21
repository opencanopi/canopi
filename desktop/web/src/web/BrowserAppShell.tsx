import type { ComponentChildren, ComponentProps, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { placeSearchFocusRequest } from "../app/geocoding/place-search-ui";
import { installPhoneLayout, phoneLayout } from "../app/shell/phone-layout";
import { refreshVisibleMapArea } from "../app/shell/visible-map-area";
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
import { canKeepDrafts, DRAFT_PERSISTENCE_REASON, type BrowserDraftPersistence } from "./browser-draft-persistence";
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
  /**
   * Whether the browser keeps Drafts (2.1-Q82): while it may clear them the save status warns, and the warning's
   * popover gives the reason, Keep my Drafts while it is offered (2.1-Q198) and Download a copy. Absent: no warning.
   */
  readonly persistence?: Pick<BrowserDraftPersistence, "view" | "keep" | "showReason"> | null;
  /** A release waits (2.1-Q83): the New version: Reload notice, which keeps the notice row over later notices. */
  readonly release?: BrowserShellReleaseNotice | null;
  readonly children?: ComponentChildren;
}

/** The New version: Reload notice's state and actions; Reload saves first (`reloading` while it saves). */
interface BrowserShellReleaseNotice {
  readonly reloading: boolean;
  readonly onReload: () => void;
  readonly onDismiss: () => void;
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
  persistence = null,
  release = null,
  children,
}: BrowserAppShellProps) {
  const notice = browserShellNotice.value;
  // The whole frame sits behind a modal dialog; the dialogs mount outside it.
  const shell = useRef<HTMLDivElement>(null);
  useModalInertRegion(shell);
  useLayoutEffect(() => installPhoneLayout(window), []);
  const phone = phoneLayout.value;
  const noticeTop = useTitleBarBottom(shell, phone);
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
  // On a phone the warning is text and File carries Keep my drafts…, which opens the warning's popover (P3-6). The
  // row shows only while that popover can open: a Draft status with Keep offered, never a dead tap (P4-1).
  const [keepRequest, setKeepRequest] = useState(0);
  const keepFromFile = phone !== null && designIdentity?.saveStatus === "draft" && persistence !== null
    && canKeepDrafts(persistence.view.value);
  const menus = keepFromFile
    ? withKeepDraftsRow(commandProjection.workspaceMenus, () => setKeepRequest((request) => request + 1))
    : commandProjection.workspaceMenus;

  return (
    <div ref={shell} className={styles.shell} data-testid="browser-app-shell" data-phone-layout={phone ?? undefined}>
      <main className={styles.workspace} aria-label={t("webShell.workspace")}>
        {children}
      </main>
      <WorkspaceTitleBar
        menus={menus}
        design={designIdentity ? (
          <>
            <DesignNameField name={designIdentity.name} onRename={(name) => onRenameDesign?.(name)} />
            <SaveStatusLabel
              status={designIdentity.saveStatus}
              failureReason={designIdentity.saveFailureReason}
              draftLabel={t("webShell.savedInBrowser")}
              draftAction={{ ...downloadAction, style: "link" }}
              draftWarning={persistence?.view.value.warn
                ? { ...draftWarning(persistence), asText: phone !== null, openRequest: keepRequest }
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
      {/* One notice row. An error from the user's own action takes it, and a waiting release returns once the error is
          dismissed (2.1-M182); any other notice waits in its signal until Reload is dismissed (M179). */}
      {release && notice?.tone !== "error"
        ? <ReleaseNotice release={release} top={noticeTop} />
        : notice ? <ShellNotice notice={notice} top={noticeTop} /> : null}
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
 * Where the notice row starts: below the title bar as laid out. Under 760 px outside the phone layout the bar grows to
 * fit the Design name over its status, past `--title-bar-height`, and a row placed from the token overlapped it.
 */
function useTitleBarBottom(shell: RefObject<HTMLElement>, phone: unknown): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const bar = shell.current?.querySelector<HTMLElement>("[data-workspace-title-bar]");
    if (!bar) return;
    const measure = () => setBottom(bar.offsetHeight > 0 ? bar.offsetTop + bar.offsetHeight : null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [shell, phone]);
  return bottom;
}

/**
 * The notice's own row (`useChromeRow`), which reserves the room below it when it mounts or resizes. A row moved with
 * the title bar resizes nothing, so it reserves again in place: no remount, so focus and the live region stay.
 */
function useNoticeRow(row: RefObject<HTMLElement>, top: number | null): void {
  useChromeRow(row);
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!placed.current) {
      placed.current = true;
      return;
    }
    const element = row.current;
    const host = element?.parentElement;
    if (!element || !host) return;
    host.style.setProperty("--chrome-rail-top", `calc(${element.offsetTop + element.offsetHeight}px + var(--space-2))`);
    refreshVisibleMapArea();
  }, [row, top]);
}

function noticeRowStyle(top: number | null) {
  return top === null ? undefined : { top: `calc(${top}px + var(--space-2))` };
}

/** The one dismissible Web notice: a row of its own below the title bar (`useChromeRow`). */
function ShellNotice({ notice, top }: { readonly notice: BrowserShellNoticeState; readonly top: number | null }) {
  const row = useRef<HTMLDivElement>(null);
  useNoticeRow(row, top);
  return (
    <div
      ref={row}
      className={styles.notice}
      style={noticeRowStyle(top)}
      role={notice.tone === "error" ? "alert" : "status"}
      data-tone={notice.tone}
      data-web-shell-notice
    >
      <span className={styles.noticeTitle}>{notice.title}</span>
      <span className={styles.noticeMessage}>{notice.message}</span>
      <button
        type="button"
        className={styles.noticeDismiss}
        aria-label={t("webShell.dismissNotice")}
        onClick={dismissBrowserShellNotice}
      >
        <ControlIcon name="close" />
      </button>
    </div>
  );
}

/**
 * New version: Reload (2.1-Q83, Q187): the notice row with Reload, which reads Saving… and ignores clicks while the
 * Design is written first, and Dismiss. Polite: it never takes focus from an edit.
 */
function ReleaseNotice({ release, top }: { readonly release: BrowserShellReleaseNotice; readonly top: number | null }) {
  const row = useRef<HTMLDivElement>(null);
  useNoticeRow(row, top);
  return (
    <div ref={row} className={styles.notice} style={noticeRowStyle(top)} role="status" data-tone="info" data-web-shell-notice data-release="">
      <span className={styles.noticeText}>
        <span className={styles.noticeTitle}>{t("webRelease.title")}</span>{" "}
        <span className={styles.noticeMessage}>{t("webRelease.message")}</span>
      </span>
      <span className={styles.noticeActions}>
        <button
          type="button"
          className={styles.noticeAction}
          data-release-reload
          disabled={release.reloading}
          onClick={() => { if (!release.reloading) release.onReload(); }}
        >
          {t(release.reloading ? "webRelease.saving" : "webRelease.reload")}
        </button>
        <button
          type="button"
          className={styles.noticeDismiss}
          aria-label={t("webShell.dismissNotice")}
          onClick={release.onDismiss}
        >
          <ControlIcon name="close" />
        </button>
      </span>
    </div>
  );
}

type TitleBarMenus = ComponentProps<typeof WorkspaceTitleBar>["menus"];

/** File with Keep my drafts… after Download a copy (or last): a 44 px phone menu row (P3-6, 2.1-Q198). */
function withKeepDraftsRow(menus: TitleBarMenus, open: () => void): TitleBarMenus {
  return menus.map((menu) => {
    if (menu.id !== "file") return menu;
    const row = { type: "action" as const, id: "file.keepDrafts", label: t("webStorage.keepDraftsMenu"), disabled: false, action: open };
    const at = menu.items.findIndex((item) => item.type === "action" && item.id === "file.downloadCanopi");
    const items = at < 0 ? [...menu.items, row] : [...menu.items.slice(0, at + 1), row, ...menu.items.slice(at + 1)];
    return { ...menu, items };
  });
}

/** The save status's may-be-cleared warning: the reason and Keep my drafts until asked, else what may happen. */
function draftWarning(persistence: Pick<BrowserDraftPersistence, "view" | "keep" | "showReason">) {
  const keepOffered = canKeepDrafts(persistence.view.value);
  return {
    label: t("webStorage.statusWarning"),
    details: t(keepOffered ? "webStorage.reason" : "webStorage.statusDetails"),
    detailsId: keepOffered ? DRAFT_PERSISTENCE_REASON : undefined,
    keep: keepOffered ? { label: t("webStorage.keepDrafts"), run: () => persistence.keep() } : null,
    whileShown: keepOffered ? persistence.showReason : undefined,
  };
}

function requireCommand(
  command: BrowserShellProjectedCommand | undefined,
  id: string,
): BrowserShellProjectedCommand {
  if (!command) throw new Error(`Browser shell projection requires '${id}'`);
  return command;
}
