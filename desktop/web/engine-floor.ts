// The engine floor's one source (canopi-4kfl; 2.1-M470, 2.1-M490, 2.1-Q327): the oldest engine each edition runs on.
// vite.config.ts builds both editions' scripts (build.target and the dependency pre-bundle's target) and styles
// (cssTarget) for it; policy/gate/engine-floor.test.ts holds tauri.conf.json's minimumSystemVersion and the published
// floor line (README's download line, the stable release notes) to it; the oldest-engine check (policy/gate/
// oldest-engine.ts) parses every chunk in a WebKit of the floor's age; .github/workflows/engine-floor-probe.yml boots
// the built editions and the format worker in WebKit images on both sides of it. Nothing below the floor is supported
// (2.1-Q306): an older engine gets the start-up guard's update message, never a transpiled build (2.1-Q327).
//
// Measured by U-2 (2026-11-12, engine-floor-probe.yml on both built editions): Safari 16.4, set by the class static
// blocks of the MapLibre chunk under the es2022 build (WebKit 15.4 and 16.0 refuse it at parse; 16.4 renders). The other
// engines' floors come from the same fresh build, scripts and styles: its scripts reach Firefox 93 (class static blocks)
// and Chrome and Edge 98 (Oxc lowers class fields below 98) untranspiled, and its styles need color-mix() (Chrome and
// Edge 111, Safari 16.2) and :has() (Firefox 121; hiding the Design's chrome rests on it). None of these lowers anything
// in today's build; a raise that would transpile is a floor decision, not a build tweak.
// Plain TypeScript with no imports: vite.config.ts and the policy tooling both load it.

/** The oldest version of each engine Canopi runs on: Safari for Desktop on macOS and for Web, the others for Web. */
export const ENGINE_FLOOR = { safari: '16.4', chrome: '111', edge: '111', firefox: '121' } as const

/** The floor as Vite's browser targets (`safari16.4`, ...): the styles' target. */
export const ENGINE_FLOOR_BROWSERS: readonly string[] = Object.entries(ENGINE_FLOOR).map(([engine, version]) => `${engine}${version}`)

/** The scripts' target: the language level the build is written for, held to the floor's browsers. */
export const ENGINE_FLOOR_TARGET: readonly string[] = ['es2022', ...ENGINE_FLOOR_BROWSERS]

/** Two engine versions compared as dotted numbers (`16.4` against `17.0`): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
