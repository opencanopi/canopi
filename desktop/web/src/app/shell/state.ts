import { signal, batch, effect } from "@preact/signals";
import { currentDesign, designSessionStore } from "../document-session/store";
import { DEFAULT_SETTINGS } from "../../generated/settings";
import { phoneToolOptions } from "./phone-layout";

export type Panel = "plant-db" | "canvas" | "favorites" | "templates" | "design-notebook" | "species-key" | "layers" | "site-data" | "calendar" | "budget" | "consortium" | "stories";

// Panels that open as a sidebar alongside the canvas instead of replacing it.
export type SidePanel = "plant-db" | "favorites" | "design-notebook" | "species-key" | "layers" | "site-data" | "calendar" | "budget" | "consortium" | "stories";

const SIDE_PANELS = new Set<Panel>(["plant-db", "favorites", "design-notebook", "species-key", "layers", "site-data", "calendar", "budget", "consortium", "stories"]);

export function isSidePanel(panel: Panel): panel is SidePanel {
  return SIDE_PANELS.has(panel);
}

export const activePanel = signal<Panel>("canvas");

// Which sidebar panel is open alongside the canvas. null = none.
// Starts closed — the user opens the Species Catalog Workbench when they need it
// (by then IPC is ready).
export const sidePanel = signal<SidePanel | null>(null);

// Close Design closes every side panel but the Catalog before the next render (Q5). Only the Design is tracked, so
// panels that run from the start screen (the Catalog, the Design Notebook, Web Favorites) still open without one.
effect(() => {
  if (currentDesign.value === null && sidePanel.peek() !== "plant-db") sidePanel.value = null;
});

// Sidebar width in pixels. null = no explicit user resize, so the shell uses
// the responsive first-use default.
export const sidePanelWidth = signal<number | null>(DEFAULT_SETTINGS.side_panel_width);

/**
 * Select a panel without applying the command-layer toggle behavior. Every route that shows a panel comes here, so on a
 * phone it also closes the tool's options, which would cover the panel in the sheet, even when it is already open.
 */
export function selectPanel(panel: Panel): void {
  batch(() => {
    phoneToolOptions.value = null;
    if (isSidePanel(panel)) {
      sidePanel.value = panel;
      activePanel.value = "canvas";
      return;
    }

    sidePanel.value = null;
    activePanel.value = panel;
  });
}

/**
 * Navigate to a panel using the correct routing model:
 * - side panels share a single dock alongside the canvas (toggle if already open)
 * - canvas / templates: full-screen primary panels
 */
export function navigateTo(panel: Panel): void {
  if (isSidePanel(panel) && sidePanel.value === panel) {
    sidePanel.value = null;
    return;
  }

  selectPanel(panel);
}

/**
 * The open Design is shown read-only (one a newer Canopi saved, 2.1-M478): the chrome's tools and commands read it to
 * offer only what looks (Select, Pan, the panels, Close). A computed that calls it follows the Session kind.
 */
export function designShownReadOnly(): boolean {
  return designSessionStore.isReadOnly();
}
