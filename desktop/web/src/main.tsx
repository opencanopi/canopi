import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App } from "./app";
import { bootstrapPlatform } from "#platform";
import { openProblemReport, ProblemReportDialog } from "./components/shared/ProblemReportDialog";
import { RootBoundary } from "./components/shared/SurfaceBoundary";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { flushBeforeExit } from "./app/shell/close-guard";
import { desktopUpdatePorts } from "./platform/updates.desktop";

bootstrapPlatform();

/** A boundary's Reload: the exit flush first, as a window close runs it, then the reload on proceed. */
function reloadAfterExitFlush(): void {
  void flushBeforeExit("close").then((answer) => {
    if (answer === "proceed") location.reload();
  });
}

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
