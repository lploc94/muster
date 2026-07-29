# Packaging

How Muster is packaged into a VSIX, what ships in the archive, and which gates prove the pruned tree still activates with marketplace-credible metadata.

## Release package path

The single documented release path is:

```bash
npm run package
```

That script is exactly `vsce package` (no `--no-dependencies`). `vscode:prepublish` runs `npm run compile` first so the webview and host TypeScript always rebuild before packaging.

Output: a `.vsix` at the repo root (`tlelabs-muster-<version>.vsix` / publisher-name-version naming from vsce).

## Marketplace metadata

`package.json` declares:

- `icon: "resources/icon.png"` — a real ≥128×128 PNG (IHDR-checked by `npm run test:m022-s03`)
- `categories: ["AI", "Chat"]` — non-placeholder marketplace categories
- root `CHANGELOG.md` with a release heading matching `package.json` `version`

Neither `resources/icon.png` nor `CHANGELOG.md` is excluded by `.vscodeignore`, so both ship in the VSIX. The packaging gate records their archive presence under `marketplaceEntries` and fails closed if either is missing.

## What ships in `node_modules`

Production `dependencies` contain exactly one package: `@modelcontextprotocol/sdk`.

The ten webview-only packages (`@tailwindcss/typography`, `@tanstack/svelte-virtual`, `@tanstack/virtual-core`, `@vscode-elements/elements`, `diff`, `dompurify`, `github-markdown-css`, `highlight.js`, `marked`, `mermaid`) live under `devDependencies`. Vite already bundles them into `dist/webview`, so staging them again would duplicate payload for every user download.

vsce therefore stages only the production dependency closure of `@modelcontextprotocol/sdk` (the measured 91-package set, including `express` required by dynamic resolution in `src/bridge/server.ts` — D067).

## Allowlist contract

`scripts/packaging-allowlist.mjs` is at `mode: 'sdk-closure-only'`. The packaging gate fails closed when any staged `extension/node_modules` package is not in `allowedNodeModulesPrefixes`.

Drift between the literal allowlist and the real lockfile production walk is rejected by `scripts/packaging-allowlist-closure.test.mjs`.

## Gates

| Command | What it proves | Cost |
|---------|----------------|------|
| `npm run test:m022-s02` | Dependency shape + allowlist closure + packaging-gate unit evidence | seconds |
| `npm run test:m022-s03` | Marketplace metadata contract (icon, categories, CHANGELOG.md, .vscodeignore) | seconds |
| `node scripts/run-packaging-gate.mjs --census-only` | Archive census + allowlist + entrypoint/marketplace presence without Extension Host | ~1–2 min |
| `npm run test:packaging` | Full packaging gate: createVSIX → extract → census → Extension Host activation + MCP bridge listen | multi-minute |
| `npm run test:m022-s02-archive` | Tracked post-prune evidence contract + `docs/PACKAGING.md` markers | seconds |
| `npm run test:m022-s03-regression` | Injected mermaid dependency drill proving the CI-wired fast tier blocks | ~1 min |

`--census-only` separates a staging regression from a host regression. It does **not** prove activation, bridge listen, or Extension Host behavior — use `npm run test:packaging` for that.

## CI enforcement surface

`.github/workflows/ci.yml` runs packaging checks automatically on push and pull_request to `main`:

| Surface | Job | Command | Failure localises to |
|---------|-----|---------|----------------------|
| Fast tier | `compile` | `npm run test:m022-s02` | `allowlist.violations` / dependency-shape diagnostics (seconds) |
| Fast tier | `compile` | `npm run test:m022-s03` | marketplace metadata contract (icon, categories, CHANGELOG) |
| Host tier | `packaging-gate` | `xvfb-run -a npm run test:packaging` | typed phase: `missing-archive-entry`, `require-failed`, `spawn-failed`, `activation`, `health-unreachable` |

The `packaging-gate` job always uploads `docs/plans/m022-s01-packaging-gate-evidence.json` via `actions/upload-artifact@v4` with `if: always()`, so a failed hosted run leaves a machine-readable snapshot (`ok`, `mode`, counts, allowlist, entrypoints, marketplaceEntries, activation, bridgePhase) instead of only console output.

CI wiring is guarded by `scripts/source-boundary-smoke.mjs` (plus fixture negatives in `scripts/source-boundary-smoke.test.mjs`) so the steps cannot be silently deleted.

### Injected-regression drill

`npm run test:m022-s03-regression` injects `mermaid` into `dependencies`, runs the same CI-wired command `npm run test:m022-s02`, requires a non-zero exit that names `mermaid`, restores `package.json` byte-for-byte, and re-passes the command. Evidence lands in `docs/plans/m022-s03-injected-regression-evidence.json`. The drill never overwrites the packaging-gate evidence path.

## Evidence snapshot

Full-gate results are written to:

`docs/plans/m022-s01-packaging-gate-evidence.json`

Post-prune + marketplace contract (enforced by `scripts/verify-m022-s02-prune-evidence.test.mjs`):

- `ok: true`, `mode: "full"`
- `allowlist.mode === "sdk-closure-only"`, `allowlist.ok === true`, `violations: []`
- `nodeModulesEntryCount` far below the S01 baseline of 15801 (asserted `< 5000`)
- all three required archive entrypoints `present/resolved/phase: "ok"`
- `marketplaceEntries` includes `extension/resources/icon.png` and `extension/changelog.md` with `present: true`
- `topLevelCounts.resources` exceeds the pre-icon baseline of 5; `changelog.md` is present
- `activation === "ok"`, `bridgePhase === "ok"`, `bridge.port > 0`
- bridge payload keys exactly `port`, `status`, `generation` (no env values)

## Failure modes

| Symptom | Likely cause | Signal |
|---------|--------------|--------|
| Webview package reappears under `dependencies` | Accidental re-add | `allowlist.violations` names the package; `test:m022-s02` fails |
| `nodeModulesEntryCount` jumps toward 15801 | Prune regress / lockfile drift | evidence contract + allowlist |
| Icon or CHANGELOG missing from VSIX | `.vscodeignore` regression or deleted asset | `marketplaceEntries[].present === false`; `test:m022-s03` / packaging gate fail |
| Bridge never listens | Missing SDK CJS build or `express` in archive | `bridgePhase: "health-unreachable"` |
| Stdio proxy / SQLite worker fail | Missing compiled entry or require graph break | `require-failed` / `spawn-failed` with child stderr tail |
| Activation fails | Broken packaged `extension.js` or activation path | `activation: "failed"`, `bridgePhase: "activation"` |
| Bridge still serving after deactivate | `deactivate()` did not close the MCP listen socket | `bridgeClosure.phase: "still-serving"` or `"not-closed"`; host smoke fails closed |
| Deactivate trace missing | UAT deactivate path not registered or not invoked | `bridgeClosure.phase: "trace-missing"` |

## Refreshing evidence

```bash
npm run test:packaging
npm run test:m022-s02-archive
```

Do not hand-edit the evidence JSON to claim pass. The gate runner is the only writer of a full-mode snapshot. After any `--census-only` triage run, restore the tracked artifact with `npm run test:packaging` (census-only overwrites `mode` to `"census-only"` and breaks the archive contract).
