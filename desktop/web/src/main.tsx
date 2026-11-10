import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App } from "./app";
import { reloadAfterExitFlush } from "./app/shell/close-guard";
import { bootstrapPlatform } from "#platform";
import { installProblemReportPort, openProblemReport, ProblemReportDialog } from "./components/shared/ProblemReportDialog";
import { RootBoundary } from "./components/shared/SurfaceBoundary";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { desktopUpdatePorts } from "./platform/updates.desktop";
import { desktopProblemReport } from "./platform/problem-report.desktop";
import { dismissStoreNoticeOnHost } from "./platform/settings.desktop";

bootstrapPlatform();
// The report writes through the native command (contracts §22, 2.1-M422).
installProblemReportPort(desktopProblemReport);

render(
  <RootBoundary
    source="root.desktop"
    onReport={openProblemReport}
    onReload={() => reloadAfterExitFlush()}
    dialogs={<><ProblemReportDialog /><SaveProblemDialog /></>}
  >
    <App updates={desktopUpdatePorts} dismissStoreNoticeOnHost={dismissStoreNoticeOnHost} />
  </RootBoundary>,
  document.getElementById("app")!,
);
