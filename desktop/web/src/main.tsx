import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App } from "./app";
import { bootstrapPlatform } from "#platform";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { desktopUpdatePorts } from "./platform/updates.desktop";

bootstrapPlatform();

render(<ErrorBoundary><App updates={desktopUpdatePorts} /></ErrorBoundary>, document.getElementById("app")!);
