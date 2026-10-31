// Stopping a process group and every member it left behind (POSIX only), for the Desktop real-app harness on Linux.
// tauri-driver starts in its own group (spawned detached); WebKitWebDriver, the app and the app's WebKit processes
// join it, since nothing between them starts a new session. tauri-driver's SIGTERM stops only WebKitWebDriver, which
// orphans the app; the orphan keeps the single-instance name on the job's session bus, so the next spec's app hands its
// launch off and exits, and WebKitWebDriver never answers POST /session (F5 probe 10, canopi-f47t.52.228.14).
// Framework-free, so it is unit tested over real processes (src/__tests__/process-group.test.ts).

/** How long a group has to leave after SIGTERM before SIGKILL, and how often the harness looks. */
export interface GroupStopOptions {
  readonly graceMs?: number
  readonly pollMs?: number
}

const KILLED_WAIT_MS = 5_000

/** Whether any process of the group `pgid` still exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // EPERM: a member exists that this user may not signal.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function goneWithin(pgid: number, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await new Promise((wake) => setTimeout(wake, pollMs))
  }
  return true
}

/**
 * Sends SIGTERM to the group `pgid`, waits until every member is gone, sends SIGKILL to what is left after `graceMs`,
 * and resolves only once the group is empty; rejects when it survives SIGKILL too.
 */
export async function stopGroup(pgid: number, { graceMs = 10_000, pollMs = 100 }: GroupStopOptions = {}): Promise<void> {
  signalGroup(pgid, 'SIGTERM')
  if (await goneWithin(pgid, graceMs, pollMs)) return
  signalGroup(pgid, 'SIGKILL')
  if (await goneWithin(pgid, KILLED_WAIT_MS, pollMs)) return
  throw new Error(`process group ${pgid} is still running ${KILLED_WAIT_MS / 1000} s after SIGKILL`)
}

/**
 * Sends SIGKILL to the group `pgid` when this process exits, so a worker whose session never started (WebdriverIO
 * then skips afterSession) still takes its driver and app with it. Returns the disposer for a group stopped normally,
 * whose id the system may give to another group later.
 */
export function killGroupOnExit(pgid: number): () => void {
  const kill = () => {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Gone already, or not ours to signal: nothing an exiting worker can do about either.
    }
  }
  process.once('exit', kill)
  return () => {
    process.off('exit', kill)
  }
}
