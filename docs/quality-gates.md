<!-- Generated from policy/gate/table.ts by `node policy/gate/cli.mjs agents-rows --write` (2.1-Q342). Do not edit by hand. -->

# Quality gates

| Change | Run |
|---|---|
| Rust | `cargo fetch --locked`; `cargo fmt --all -- --check`; `CANOPI_SKIP_BUNDLED_DB=1 cargo clippy --workspace --all-targets -- -D warnings`; `CANOPI_SKIP_BUNDLED_DB=1 node policy/gate/cli.mjs cov` above its floor (it runs the workspace tests); `CANOPI_SKIP_BUNDLED_DB=1 node policy/check.mjs --lane push`; CI `build.yml platform-tests` and `build.yml build` |
| A `#[tauri::command]` | `CANOPI_SKIP_BUNDLED_DB=1 cargo test -p canopi-desktop native_command_policy::tests` |
| Shared contracts (`canopi-types/`, `en.json`) | `cd desktop/web && npm run check:types` (stale: `npm run gen:types`); `python3 scripts/species_search_unicode_facts.py check` |
| Frontend | `cd desktop/web && npm run typecheck && npm run test:coverage -- --maxWorkers=4 --project web && npm run test:policies:node && npm run test:policies:generate && npm run test:policies:generate:self-test && npm run test:policies:ast-grep && npm run build:desktop:bundle && npm run build:web:bundle && npm run check:notices`; `node policy/check.mjs`; `node policy/check.mjs --family bundle-size`; `node policy/gate/cli.mjs gate-cov`; `node policy/gate/cli.mjs oldest-engine` |
| Policy tooling (`policy/`, an adapter's tool or config) | `node policy/check.mjs --self-test`; `CANOPI_SKIP_BUNDLED_DB=1 node policy/check.mjs --self-test --lane push`; `CANOPI_SKIP_BUNDLED_DB=1 node policy/check.mjs --lane push`; `node policy/check.mjs --self-test --family bundle-size` |
| Desktop packaging inputs | CI `build.yml build` on every platform |
| Release build inputs | CI `build.yml release-build` |
| Supply chain (lockfiles, `policy/advisories.json`) | CI `build.yml supply-chain` |
| Species catalog queries | `python3 scripts/species_catalog_contract.py check` and its Python tests |
| LiDAR services | the engine lane (CI job `lidar-native`) and the comparison lane ([data library](guides/data-library.md)) |
| Desktop real app | CI `build.yml real-app` |
| Web Edition browsers and axe reports | CI `build.yml web-browsers`, then `node policy/check.mjs --self-test --family axe`; `node policy/check.mjs --family axe` |
| Updater | CI `build.yml updater` |
| Store readers and frozen store forms | CI `build.yml rollback` |
| CI workflows (`.github/`) | `node policy/gate/cli.mjs actionlint` |
| Script tests | `python3 -m unittest discover -s scripts` |
| Docs | `python3 scripts/check_docs.py` and its `--drift origin/main` (validator changes: `python3 -m unittest scripts.test_check_docs`); `python3 scripts/check_playwright_pins.py` |

Docs-only changes skip code gates; say so in the handoff.
