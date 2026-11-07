import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App } from "./app";
import { bootstrapPlatform } from "#platform";
import { openProblemReport, ProblemReportDialog } from "./components/shared/ProblemReportDialog";
import { RootBoundary } from "./components/shared/SurfaceBoundary";
import { desktopUpdatePorts } from "./platform/updates.desktop";

bootstrapPlatform();

render(
  <RootBoundary source="root.desktop" onReport={openProblemReport} reportDialog={<ProblemReportDialog />}>
    <App updates={desktopUpdatePorts} />
  </RootBoundary>,
  document.getElementById("app")!,
);
