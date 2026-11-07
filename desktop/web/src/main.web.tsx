import { render } from "preact";
import { bootstrapPlatform } from "#platform";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/global.css";
import { createWebAppCatalog, createWebShellShortcutSource, WebApp } from "./web/WebApp";
import { installWebKeyRouter } from "./web/browser-shell-commands";
import { RootBoundary } from "./components/shared/SurfaceBoundary";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { browserDesignSessionController } from "./web/browser-design-session";
import { reportFailure } from "./failures/report";

bootstrapPlatform();
const catalog = createWebAppCatalog();
installWebKeyRouter(createWebShellShortcutSource(catalog));

/**
 * A boundary's Reload is the release's: it writes the Draft first, asks the save question when it cannot and reopens
 * this tab's own Draft after the reload (2.1-Q83, Q189).
 */
function reloadAfterSaving(): void {
  void browserDesignSessionController.reloadForRelease().catch((error: unknown) => {
    reportFailure(error, { shown: "none", source: "web.reload", echo: true });
  });
}

render(
  <RootBoundary source="root.web" onReload={reloadAfterSaving} dialogs={<SaveProblemDialog />}>
    <WebApp catalog={catalog} />
  </RootBoundary>,
  document.getElementById("app")!,
);
