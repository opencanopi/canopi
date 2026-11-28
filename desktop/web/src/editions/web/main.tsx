/**
 * editions/web/main.tsx: L5 Web edition entry (ADR 0022, ADR 0030, contracts §22).
 */
import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import "../../styles/global.css";
import { setToolCapabilityReader } from "../../app/keyboard/arming";
import { editionPorts, hasEditionPorts } from "../../platform/edition-ports";
import { createWebAppCatalog, createWebShellShortcutSource, WebApp } from "./WebApp";
import { installWebKeyRouter } from "./browser-shell-commands";
import { installWebProblemReport, WebRootBoundary } from "./WebRoot";
import { bootWebEdition } from "./boot";

bootWebEdition();
setToolCapabilityReader(() => (hasEditionPorts() ? editionPorts().capabilities : null));
const catalog = createWebAppCatalog();
installWebKeyRouter(createWebShellShortcutSource(catalog));
installWebProblemReport();

render(
  <WebRootBoundary>
    <WebApp catalog={catalog} />
  </WebRootBoundary>,
  document.getElementById("app")!,
);
