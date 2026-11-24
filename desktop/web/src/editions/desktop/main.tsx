/**
 * editions/desktop/main.tsx: L5 Desktop edition entry (ADR 0022, ADR 0030, contracts §22).
 */
import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App, reloadAfterExitFlush } from "../../app";
import { openProblemReport, ProblemReportDialog } from "../../components/shared/ProblemReportDialog";
import { RootBoundary } from "../../components/shared/SurfaceBoundary";
import { SaveProblemDialog } from "../../components/shared/SaveProblemDialog";
import { desktopUpdatePorts } from "./updates";
import { dismissStoreNoticeOnHost } from "./settings";
import { bootDesktopEdition } from "./boot";

bootDesktopEdition();

render(
  <RootBoundary
    source="root.desktop"
    onReport={openProblemReport}
    onReload={reloadAfterExitFlush}
    dialogs={<><ProblemReportDialog /><SaveProblemDialog /></>}
  >
    <App updates={desktopUpdatePorts} dismissStoreNoticeOnHost={dismissStoreNoticeOnHost} />
  </RootBoundary>,
  document.getElementById("app")!,
);
