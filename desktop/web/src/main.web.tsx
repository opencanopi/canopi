import { render } from "preact";
import { bootstrapPlatform } from "#platform";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/global.css";
import { createWebAppCatalog, createWebShellShortcutSource, WebApp } from "./web/WebApp";
import { installWebKeyRouter } from "./web/browser-shell-commands";
import { installWebProblemReport, WebRootBoundary } from "./web/WebRoot";

bootstrapPlatform();
const catalog = createWebAppCatalog();
installWebKeyRouter(createWebShellShortcutSource(catalog));
// The report downloads one zip of the browser's sections (contracts §22, 2.1-Q283), even after the app has failed.
installWebProblemReport();

render(
  <WebRootBoundary>
    <WebApp catalog={catalog} />
  </WebRootBoundary>,
  document.getElementById("app")!,
);
