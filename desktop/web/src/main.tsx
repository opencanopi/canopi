import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App, reloadAfterExitFlush } from "./app";
import { bootstrapPlatform } from "#platform";
import { openProblemReport, ProblemReportDialog } from "./components/shared/ProblemReportDialog";
import { RootBoundary } from "./components/shared/SurfaceBoundary";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { desktopUpdatePorts } from "./platform/updates.desktop";

bootstrapPlatform();

render(
  <RootBoundary
    source="root.desktop"
    onReport={openProblemReport}
    onReload={reloadAfterExitFlush}
    dialogs={<><ProblemReportDialog /><SaveProblemDialog /></>}
  >
    <App updates={desktopUpdatePorts} />
  </RootBoundary>,
  document.getElementById("app")!,
);
