// The Desktop real-app lane on Linux stops tauri-driver with everything it started (WebKitWebDriver, the app, its
// WebKit processes) as one process group, and waits until every member is gone, so the next spec's app never meets
// the previous app's single-instance name and hands its launch off (F5 probe 10, canopi-f47t.52.228.14). These tests
// run real processes: a parent that leaves behind a child ignoring SIGTERM, as an orphaned app outlives tauri-driver.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refuseWhenAnswering } from '../../e2e/platform/support/driver-port'
import { groupAlive, stopGroup } from '../../e2e/platform/support/process-group'

const MODULE = resolve(import.meta.dirname, '../../e2e/platform/support/process-group.ts')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The first line `child` prints, as a process id. */
function firstPid(child: ChildProcess): Promise<number> {
  return new Promise((done, fail) => {
    let text = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      const line = text.split('\n')[0]
      if (text.includes('\n') && line) done(Number(line))
    })
    child.once('error', fail)
  })
}

/**
 * A shell script that starts a child ignoring SIGTERM and waits. The child prints its own pid once its trap is set, so
 * a stop that follows the printed pid never reaches it while it still has the default SIGTERM action.
 */
const STUBBORN_GROUP = `sh -c 'trap "" TERM; echo $$; exec sleep 60' & wait`

/** A detached shell (its own group) running `STUBBORN_GROUP`, with the stubborn child's pid. */
async function groupWithStubbornChild(): Promise<{ leader: number; stubborn: number }> {
  const shell = spawn('sh', ['-c', STUBBORN_GROUP], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const stubborn = await firstPid(shell)
  if (shell.pid === undefined) throw new Error('the shell has no pid')
  return { leader: shell.pid, stubborn }
}

describe.skipIf(process.platform === 'win32')('stopGroup', () => {
  it('stops a group whose member ignores SIGTERM, and resolves only once every member is gone (canopi-f47t.52.228.14)', async () => {
    const { leader, stubborn } = await groupWithStubbornChild()
    expect(alive(stubborn)).toBe(true)
    const started = Date.now()
    await stopGroup(leader, { graceMs: 600, pollMs: 20 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)
    expect(groupAlive(leader)).toBe(false)
    expect(alive(leader)).toBe(false)
    expect(alive(stubborn)).toBe(false)
  })

  it('resolves before the grace ends when SIGTERM stops every member', async () => {
    const shell = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' })
    if (shell.pid === undefined) throw new Error('the shell has no pid')
    const started = Date.now()
    await stopGroup(shell.pid, { graceMs: 5_000, pollMs: 20 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(groupAlive(shell.pid)).toBe(false)
  })

  it('resolves at once for a group that is already gone', async () => {
    const shell = spawn('sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' })
    await new Promise((done) => shell.once('exit', done))
    if (shell.pid === undefined) throw new Error('the shell has no pid')
    await expect(stopGroup(shell.pid, { graceMs: 5_000, pollMs: 20 })).resolves.toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('killGroupOnExit', () => {
  it('kills the group when the process that registered it exits, as a worker whose session never started (canopi-f47t.52.228.14)', async () => {
    // A worker stand-in: it starts a group with a stubborn member, registers the kill and exits without stopping it.
    const worker = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process'
      import { killGroupOnExit } from ${JSON.stringify(MODULE)}
      const shell = spawn('sh', ['-c', ${JSON.stringify(STUBBORN_GROUP)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
      shell.stdout.once('data', (chunk) => {
        process.stdout.write(shell.pid + ' ' + chunk.toString())
        killGroupOnExit(shell.pid)
        process.exit(0)
      })
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    worker.stdout.on('data', (chunk: Buffer) => { text += chunk.toString() })
    await new Promise((done) => worker.once('exit', done))
    const [leader, stubborn] = text.trim().split(/\s+/).map(Number)
    if (!leader || !stubborn) throw new Error(`the worker printed no pids: ${text}`)
    const deadline = Date.now() + 5_000
    while ((alive(stubborn) || groupAlive(leader)) && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 20))
    expect(alive(stubborn)).toBe(false)
    expect(groupAlive(leader)).toBe(false)
  })

  it('kills nothing once disposed, so a group stopped normally is never signalled again', async () => {
    const worker = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process'
      import { killGroupOnExit } from ${JSON.stringify(MODULE)}
      const shell = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
      shell.unref()
      process.stdout.write(String(shell.pid))
      killGroupOnExit(shell.pid)()
      process.exit(0)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    worker.stdout.on('data', (chunk: Buffer) => { text += chunk.toString() })
    await new Promise((done) => worker.once('exit', done))
    const leader = Number(text.trim())
    await new Promise((wake) => setTimeout(wake, 200))
    expect(groupAlive(leader)).toBe(true)
    await stopGroup(leader, { graceMs: 2_000, pollMs: 20 })
  })
})

describe('refuseWhenAnswering', () => {
  it('fails while anything answers the driver port, a 404 included, and passes once the port is free (canopi-f47t.52.228.14)', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`
    try {
      await expect(refuseWhenAnswering(url)).rejects.toThrow(/already answers/)
    } finally {
      await new Promise((done) => server.close(done))
    }
    await expect(refuseWhenAnswering(url)).resolves.toBeUndefined()
  })
})
