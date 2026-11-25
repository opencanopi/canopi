/**
 * editions/desktop/main.tsx: L5 Desktop edition entry (ADR 0022, ADR 0030, contracts §22).
 */
import { render } from "preact";
import "maplibre-gl/dist/maplibre-gl.css";
import { App, reloadAfterExitFlush } from "../../app";
import { openProblemReport } from "../../app/problem-report/submission";
import { LazyProblemReportDialog } from "../../components/shared/LazyDialogs";
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
    dialogs={<><LazyProblemReportDialog /><SaveProblemDialog /></>}
  >
    <App updates={desktopUpdatePorts} dismissStoreNoticeOnHost={dismissStoreNoticeOnHost} />
  </RootBoundary>,
  document.getElementById("app")!,
);
