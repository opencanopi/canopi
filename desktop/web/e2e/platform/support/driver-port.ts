// Refusing a driver port that already answers, for the Desktop real-app harness: a previous session's tauri-driver
// still listening would take the new session and attach it to that session's app (F5 probe 10, canopi-f47t.52.228.14).
// Framework-free, so it is unit tested over a real server (src/__tests__/process-group.test.ts).

/** Fails when something already answers `url`: a previous session's driver still running, which must not be reused. */
export async function refuseWhenAnswering(url: string): Promise<void> {
  let answered = false
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) })
    answered = true
  } catch {
    // Nothing listening: the port is free.
  }
  if (answered) throw new Error(`${url} already answers before tauri-driver starts: a previous session's driver is still running`)
}
