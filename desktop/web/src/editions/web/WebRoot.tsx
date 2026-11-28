// web/WebRoot.tsx: the Web Edition's root boundary and its problem report writer (ADR 0022, ADR 0025, contracts §22,
// 2.1-Q83, Q189, Q283).
import type { ComponentChildren } from "preact";
import { CANOPI_VERSION } from "../../app/about/metadata";
import { installProblemReportPort } from "../../app/problem-report/submission";
import { capabilitiesForEdition } from "../../generated/edition-capabilities";
import { readSettingsReportSummary } from "../../app/settings/projection";
import { openProblemReport, ProblemReportDialog } from "../../components/shared/ProblemReportDialog";
import { SaveProblemDialog } from "../../components/shared/SaveProblemDialog";
import { RootBoundary } from "../../components/shared/SurfaceBoundary";
import { storeHealth } from "../../failures/health";
import { reportFailure } from "../../failures/report";
import { createBrowserProblemReportWriter } from "./problem-report";
import { currentWebDesignText, reloadWebForRelease } from "./web-session";

interface ReportSession {
  currentDesignText(): string | null | Promise<string | null>;
}
interface RootSession {
  reloadForRelease(): Promise<unknown>;
}

const DEFAULT_REPORT_SESSION: ReportSession = { currentDesignText: currentWebDesignText };
const DEFAULT_ROOT_SESSION: RootSession = { reloadForRelease: () => reloadWebForRelease() };

export function installWebProblemReport(session: ReportSession = DEFAULT_REPORT_SESSION): () => void {
  const writer = createBrowserProblemReportWriter({
    build: () => ({ app: "Canopi", version: CANOPI_VERSION }),
    health: () => storeHealth.peek(),
    settings: () => readSettingsReportSummary(capabilitiesForEdition("web", "linux")),
    currentDesign: () => session.currentDesignText(),
  });
  const uninstall = installProblemReportPort(writer);
  return () => {
    uninstall();
    writer.dispose();
  };
}

export function WebRootBoundary({ session = DEFAULT_ROOT_SESSION, children }: {
  readonly session?: RootSession;
  readonly children: ComponentChildren;
}) {
  const reload = () => {
    void session.reloadForRelease().catch((error: unknown) => {
      reportFailure(error, { shown: "none", source: "web.reload", echo: true });
    });
  };
  return (
    <RootBoundary
      source="root.web"
      onReport={openProblemReport}
      onReload={reload}
      dialogs={<><ProblemReportDialog /><SaveProblemDialog /></>}
    >
      {children}
    </RootBoundary>
  );
}
