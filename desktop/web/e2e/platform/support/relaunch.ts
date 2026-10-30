// The updater end to end's hand-over of the session profile to the update's relaunch (updater.spec.ts; CI triage
// round 4, canopi-f47t.52.228.15).
//
// Windows: the elevated runner's NSIS installer relaunches through nsis_tauri_utils' RunAsUser, which takes the desktop
// user's token and an environment built fresh from the user's profile, so the e2e build would start without
// CANOPI_E2E_PROFILE and refuse to run. The harness writes the session's profile variables to HKCU\Environment, which
// that environment block reads, just before the install, and removes them when the spec ends.
import { execFileSync } from 'node:child_process'
import { currentPlatform, profileEnvironment } from './app'

const HANDED = ['CANOPI_E2E_PROFILE', 'CANOPI_E2E_DIALOGS'] as const
let handed = false

/**
 * Windows: writes the profile variables of the session at `root` to HKCU\Environment, so a relaunch RunAsUser starts
 * with an environment built from the user's profile runs on the session's profile. Elsewhere the relaunch inherits
 * the app's environment, and this does nothing.
 */
export function handProfileToRelaunch(root: string): void {
  if (currentPlatform() !== 'windows') return
  const environment = profileEnvironment(root)
  handed = true
  for (const name of HANDED) {
    const value = environment[name]
    if (value === undefined) throw new Error(`the profile environment has no ${name}`)
    execFileSync('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'pipe' })
  }
}

/** Removes what `handProfileToRelaunch` wrote, so no later process on the machine starts on the spec's profile. */
export function withdrawProfileFromRelaunch(): void {
  if (!handed) return
  handed = false
  for (const name of HANDED) {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { stdio: 'pipe' })
    } catch {
      // Not written (the add failed before it): nothing to remove.
    }
  }
}
