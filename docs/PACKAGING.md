# Packaging

How Muster is packaged into a VSIX, what ships in the archive, and which gates prove the pruned tree still activates.

## Release package path

The single documented release path is:

```bash
npm run package
```

That script is exactly `vsce package` (no `--no-dependencies`). `vscode:prepublish` runs `npm run compile` first so the webview and host TypeScript always rebuild before packaging.

Output: a `.vsix` at the repo root (`tlelabs-muster-<version>.vsix` / publisher-name-version naming from vsce).

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
| `node scripts/run-packaging-gate.mjs --census-only` | Archive census + allowlist + entrypoint presence without Extension Host | ~1–2 min |
| `npm run test:packaging` | Full packaging gate: createVSIX → extract → census → Extension Host activation + MCP bridge listen | multi-minute |
| `npm run test:m022-s02-archive` | Tracked post-prune evidence contract + `docs/PACKAGING.md` markers | seconds |

`--census-only` separates a staging regression from a host regression. It does **not** prove activation, bridge listen, or Extension Host behavior — use `npm run test:packaging` for that.

## Evidence snapshot

Full-gate results are written to:

`docs/plans/m022-s01-packaging-gate-evidence.json`

Post-prune contract (enforced by `scripts/verify-m022-s02-prune-evidence.test.mjs`):

- `ok: true`, `mode: "full"`
- `allowlist.mode === "sdk-closure-only"`, `allowlist.ok === true`, `violations: []`
- `nodeModulesEntryCount` far below the S01 baseline of 15801 (asserted `< 5000`)
- all three required archive entrypoints `present/resolved/phase: "ok"`
- `activation === "ok"`, `bridgePhase === "ok"`, `bridge.port > 0`
- bridge payload keys exactly `port`, `status`, `generation` (no env values)

## Failure modes

| Symptom | Likely cause | Signal |
|---------|--------------|--------|
| Webview package reappears under `dependencies` | Accidental re-add | `allowlist.violations` names the package; `test:m022-s02` fails |
| `nodeModulesEntryCount` jumps toward 15801 | Prune regress / lockfile drift | evidence contract + allowlist |
| Bridge never listens | Missing SDK CJS build or `express` in archive | `bridgePhase: "health-unreachable"` |
| Stdio proxy / SQLite worker fail | Missing compiled entry or require graph break | `require-failed` / `spawn-failed` with child stderr tail |
| Activation fails | Broken packaged `extension.js` or activation path | `activation: "failed"`, `bridgePhase: "activation"` |

## Refreshing evidence

```bash
npm run test:packaging
npm run test:m022-s02-archive
```

Do not hand-edit the evidence JSON to claim pass. The gate runner is the only writer of a full-mode snapshot.
