import type { SubsystemHealth } from "../../types/health";
import { initTheme } from "../../utils/theme";
import { applyHostHealth } from "../health/state";
import type { SettingsPlatformAdapter } from "../settings/platform-adapter";
import { installSettingsProjection } from "../settings/projection";

export interface ShellBootstrap {
  readonly ready: Promise<void>;
  dispose(): void;
}

/**
 * Construct one Desktop shell lifetime. The platform composition root owns
 * replacement and disposal when bootstrap repeats or Vite reloads the module,
 * and passes the host's health query (ipc/health.ts), so the shell reaches no
 * native API itself.
 */
export function bootstrapShell(
  settingsAdapter: SettingsPlatformAdapter,
  loadHealth: () => Promise<SubsystemHealth>,
): ShellBootstrap {
  const disposeTheme = initTheme();
  let disposed = false;

  const healthReady = loadHealth()
    .then((health) => {
      if (!disposed) applyHostHealth(health);
    })
    .catch((error) => {
      if (!disposed) console.error("Failed to query health:", error);
    });

  const settingsInstallation = installSettingsProjection(settingsAdapter);
  const settingsReady = settingsInstallation.ready
    .catch((error) => {
      if (!disposed) console.error("Failed to bootstrap settings:", error);
    });

  return {
    ready: Promise.all([healthReady, settingsReady]).then(() => undefined),
    dispose() {
      if (disposed) return;
      disposed = true;
      settingsInstallation.dispose();
      disposeTheme();
    },
  };
}
