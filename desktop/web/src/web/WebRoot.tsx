// web/WebRoot.tsx: the Web Edition's root boundary and its problem report writer (ADR 0022, ADR 0025, contracts §22,
// 2.1-Q83, Q189, Q283). Invariant: the writer is installed once for the page, outside the app, so a fault that takes
// the app down still leaves Report a problem working; the report attaches the Web Design session's open Design only
// when ticked, never a newer Canopi's read view (canopi-v4kj), and downloads one zip of the browser's sections.
import type { ComponentChildren } from "preact";
import { CANOPI_VERSION } from "../app/about/metadata";
import { designAttachable } from "../app/problem-report/design-consent";
import { installProblemReportPort } from "../app/problem-report/submission";
import { locale, plantSpacingIntervalM, theme } from "../app/settings/state";
import { openProblemReport, ProblemReportDialog } from "../components/shared/ProblemReportDialog";
import { SaveProblemDialog } from "../components/shared/SaveProblemDialog";
import { RootBoundary } from "../components/shared/SurfaceBoundary";
import { storeHealth } from "../failures/health";
import { reportFailure } from "../failures/report";
import { createBrowserProblemReportWriter } from "../platform/problem-report.browser";
import { browserDesignSessionController, type BrowserDesignSessionController } from "./browser-design-session";

type ReportSession = Pick<BrowserDesignSessionController, "currentDesignText" | "readDesignIdentity">;
type RootSession = Pick<BrowserDesignSessionController, "reloadForRelease">;

/**
 * Installs the Web problem report's writer for the page: the browser's sections, and the session's open Design for the
 * consent row. Returns the uninstall, which also frees its pending download URLs.
 */
export function installWebProblemReport(session: ReportSession = browserDesignSessionController): () => void {
  const writer = createBrowserProblemReportWriter({
    build: () => ({ app: "Canopi", version: CANOPI_VERSION }),
    health: () => storeHealth.peek(),
    settings: () => ({ locale: locale.peek(), theme: theme.peek(), plant_spacing_interval_m: plantSpacingIntervalM.peek() }),
    currentDesign: () => (designAttachable(session.readDesignIdentity()?.readOnlyOrigin) ? session.currentDesignText() : null),
  });
  const uninstall = installProblemReportPort(writer);
  return () => {
    uninstall();
    writer.dispose();
  };
}

/**
 * The Web root boundary: Report a problem opens the problem report, and Reload is the release's, which writes the
 * Draft first, asks the save question when it cannot and reopens this tab's own Draft after the reload.
 */
export function WebRootBoundary({ session = browserDesignSessionController, children }: {
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
