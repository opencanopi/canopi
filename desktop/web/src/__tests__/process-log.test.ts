// The Desktop real-app lane keeps tauri-driver's and the app's output in the session profile, which the job uploads
// when it fails, so a WebDriver session that never starts leaves what the driver and the app printed (F5 probe 8).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { logOutput } from '../../e2e/platform/support/process-log'

function closed(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((done) => child.once('close', () => done()))
}

describe('logOutput', () => {
  it('writes a process\'s stdout and stderr to the file and still passes them on', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'canopi-process-log-')), 'tauri-driver-output.log')
    const echo = new PassThrough()
    let echoed = ''
    echo.on('data', (chunk: Buffer) => { echoed += chunk.toString() })
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("listening\\n"); process.stderr.write("session failed\\n")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    logOutput(child, file, echo)
    await closed(child)
    const kept = readFileSync(file, 'utf8')
    expect(kept).toContain('listening\n')
    expect(kept).toContain('session failed\n')
    expect(echoed).toContain('listening\n')
    expect(echoed).toContain('session failed\n')
  })

  it('leaves an empty file for a process that printed nothing, so the artifact shows it ran silent', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'canopi-process-log-')), 'app-output.log')
    const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] })
    logOutput(child, file, new PassThrough())
    await closed(child)
    expect(readFileSync(file, 'utf8')).toBe('')
  })
})
