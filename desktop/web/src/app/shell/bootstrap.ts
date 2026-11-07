import type { SubsystemHealth } from "../../generated/contracts";
import { applyHealthSnapshot } from "../../failures/health";
import { reportFailure } from "../../failures/report";
import { initTheme } from "../../utils/theme";
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
 * native API itself. The boot snapshot feeds the one health model
 * (failures/health.ts); a query that fails leaves every store opening, never
 * ready, and goes to the sink. A settings load that fails reports itself and
 * marks settings unavailable (SET-05).
 */
export function bootstrapShell(
  settingsAdapter: SettingsPlatformAdapter,
  loadHealth: () => Promise<SubsystemHealth>,
): ShellBootstrap {
  const disposeTheme = initTheme();
  let disposed = false;

  const healthReady = loadHealth()
    .then((health) => {
      if (!disposed) applyHealthSnapshot(health);
    })
    .catch((error: unknown) => {
      if (!disposed) reportFailure(error, { shown: "none", source: "health" });
    });

  const settingsInstallation = installSettingsProjection(settingsAdapter);
  // The projection reported the failure and marked settings unavailable; the shell starts on defaults.
  const settingsReady = settingsInstallation.ready.catch(() => undefined);

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
