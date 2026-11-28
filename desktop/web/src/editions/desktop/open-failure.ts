// editions/desktop/open-failure.ts
//
// Desktop open-failure notice presenter on the shared NoticeRow (2.1-M20, 2.1-Q286, 2.1-M435).
// Refused `.canopi` files show in the notice row with Report a problem instead of a native dialog.

import type { DesignOpenFailureNotice } from '../../app/document-session/open-failure'
import { openProblemReportDialog } from '../../app/problem-report/submission'
import { raiseNotice, withdrawNotice } from '../../failures/notices'

const DESKTOP_OPEN_FAILURE_NOTICE_KEY = 'desktop.open-failure'

/** Desktop presents a Design that cannot be opened in the notice row with Report a problem. */
export function presentDesktopDesignOpenFailure(notice: DesignOpenFailureNotice): void {
  withdrawNotice(DESKTOP_OPEN_FAILURE_NOTICE_KEY)
  raiseNotice({
    key: DESKTOP_OPEN_FAILURE_NOTICE_KEY,
    kind: 'outcome',
    tone: notice.tone,
    title: notice.title,
    message: notice.message,
    action: { label: 'boundary.reportProblem', run: openProblemReportDialog },
  })
}
