/**
 * editions/web/main.tsx: L5 Web edition entry (ADR 0022, ADR 0030, contracts §22).
 */
import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import "../../styles/global.css";
import { createWebAppCatalog, createWebShellShortcutSource, WebApp } from "./WebApp";
import { installWebKeyRouter } from "./browser-shell-commands";
import { installWebProblemReport, WebRootBoundary } from "./WebRoot";
import { bootWebEdition } from "./boot";

bootWebEdition();
const catalog = createWebAppCatalog();
installWebKeyRouter(createWebShellShortcutSource(catalog));
installWebProblemReport();

render(
  <WebRootBoundary>
    <WebApp catalog={catalog} />
  </WebRootBoundary>,
  document.getElementById("app")!,
);
