// What a process the Desktop real-app harness starts prints, kept in a file of the session profile, which the CI job
// uploads when it fails (desktop-real-app.yml), and still passed on to the job log. F5 probe 8: a WebDriver session
// request timed out on ubuntu-22.04 with the app's output mixed into the job log and nothing in the profile, so the
// driver's hang and an app that hung before its own log started looked alike. Framework-free, so it is unit tested
// (src/__tests__/process-log.test.ts).
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import type { Writable } from 'node:stream'

/**
 * Appends every chunk `child` writes on its piped stdout and stderr to `file` (created empty at once, so a silent
 * process leaves an empty file) and passes it on to `echo`. Each chunk is written synchronously, so the file is
 * complete however the process ends. The pipes do not hold the harness open: a process the child started
 * (tauri-driver's WebKitWebDriver and app) may keep them open after the child is stopped, and the worker still exits.
 */
export function logOutput(child: ChildProcess, file: string, echo: Writable = process.stderr): void {
  writeFileSync(file, '')
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    stream.on('data', (chunk: Buffer) => {
      appendFileSync(file, chunk)
      echo.write(chunk)
    })
    if (stream instanceof Socket) stream.unref()
  }
}
