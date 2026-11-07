import { render } from "preact";
import { bootstrapPlatform } from "#platform";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/global.css";
import { createWebAppCatalog, createWebShellShortcutSource, WebApp } from "./web/WebApp";
import { installWebKeyRouter } from "./web/browser-shell-commands";
import { RootBoundary } from "./components/shared/SurfaceBoundary";

bootstrapPlatform();
const catalog = createWebAppCatalog();
installWebKeyRouter(createWebShellShortcutSource(catalog));

render(<RootBoundary source="root.web"><WebApp catalog={catalog} /></RootBoundary>, document.getElementById("app")!);
