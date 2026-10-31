// platform/desktop.ts
//
// Owner of the Desktop window host: a native host adapter for @tauri-apps/* (tauri-only-in-native-host, ADR 0022; §18 F2).
// Invariant: Tauri is reached only through ipc/ and the platform Desktop adapters.

import { bootstrapShell, type ShellBootstrap } from "../app/shell/bootstrap";
import {
  registerCloseGuard,
  type CloseGuardLifetime,
} from "../app/shell/close-guard";
import {
  disposeLidarWorkflow,
  installLidarWorkflow,
} from "../app/lidar/workflow";
import {
  disposeLidarDisplayDescriptors,
  installLidarDisplayDescriptors,
} from "../app/lidar/display";
import { installDesignContinuousSave } from "../app/document-session/transition";
import { installLaunchFile } from "../app/document-session/launch-file";
import { subscribePendingOpen, takePendingOpen } from "../ipc/launch";
import { installPlaceSearchSession } from "../app/geocoding/place-search-session";
import { installToolRailLearning } from "../app/tool-rail/learning";
import { focusOwner } from "../app/keyboard/focus-owner";
import { installKeyRouter } from "../app/keyboard/key-router";
import { singleKeyShortcuts } from "../app/settings/state";
import { currentCanvasKeyboardPort } from "../canvas/session";
import { detectPlatform } from "../canvas/runtime/input/platform";
import { setShortcutPlatform } from "../app/shell-commands/shortcut-text";
import { installDesktopKeyRouter } from "../commands/registry";
import { registerDesignOpenFailurePresenter } from "../app/document-session/open-failure";
import { presentDesktopDesignOpenFailure } from "./open-failure.desktop";
import { desktopSettingsPlatformAdapter } from "./settings.desktop";

let shellBootstrap: ShellBootstrap | null = null;
let closeGuardLifetime: CloseGuardLifetime | null = null;
let disposeContinuousSave: (() => void) | null = null;
let disposeLaunchFile: (() => void) | null = null;
let disposePlaceSearchSession: (() => void) | null = null;
let disposeToolRailLearning: (() => void) | null = null;
let disposeKeyRouter: (() => void) | null = null;

export function bootstrapPlatform(): void {
  closeGuardLifetime?.dispose();
  disposeKeyRouter?.();
  disposeToolRailLearning?.();
  disposePlaceSearchSession?.();
  disposeLaunchFile?.();
  disposeContinuousSave?.();
  registerDesignOpenFailurePresenter(null);
  shellBootstrap?.dispose();
  // Desktop application/workspace lifetime: one LiDAR workflow owner that
  // outlives panel navigation and Design replacement.
  installLidarWorkflow();
  installLidarDisplayDescriptors();
  shellBootstrap = bootstrapShell(desktopSettingsPlatformAdapter);
  registerDesignOpenFailurePresenter(presentDesktopDesignOpenFailure);
  disposeContinuousSave = installDesignContinuousSave();
  // The Design file a launch asked to open (2.1-M214), after continuous save so a replaced Design is flushed first.
  disposeLaunchFile = installLaunchFile({ take: takePendingOpen, subscribe: subscribePendingOpen });
  disposePlaceSearchSession = installPlaceSearchSession();
  disposeToolRailLearning = installToolRailLearning();
  // One platform for the key router's chords and the labels that name them (Cmd on macOS).
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  setShortcutPlatform(platform);
  const keyRouter = installDesktopKeyRouter(installKeyRouter, {
    target: window,
    canvas: currentCanvasKeyboardPort,
    singleKeys: singleKeyShortcuts,
    focus: focusOwner,
    platform,
    document,
  });
  disposeKeyRouter = () => keyRouter.dispose();
  closeGuardLifetime = registerCloseGuard();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLidarWorkflow();
    disposeLidarDisplayDescriptors();
    closeGuardLifetime?.dispose();
    closeGuardLifetime = null;
    disposePlaceSearchSession?.();
    disposePlaceSearchSession = null;
    disposeToolRailLearning?.();
    disposeToolRailLearning = null;
    disposeKeyRouter?.();
    disposeKeyRouter = null;
    disposeLaunchFile?.();
    disposeLaunchFile = null;
    disposeContinuousSave?.();
    disposeContinuousSave = null;
    registerDesignOpenFailurePresenter(null);
    shellBootstrap?.dispose();
    shellBootstrap = null;
  });
}
