# UI Visual Regression

Muster's dual-entrypoint visual pilots (main webview + Presentation) are
compared against committed PNG baselines that are authored **only** inside the
pinned Linux Chromium Playwright Docker image.

## Why Linux-only goldens

Chromium rasterization differs across OS font stacks, subpixel rendering, and
GPU/software paths. Host Windows/macOS screenshots are not interchangeable with
Linux CI. Committed goldens therefore come from:

```text
mcr.microsoft.com/playwright:v<lockfile-@playwright/test>-jammy
```

The lockfile version is resolved by `scripts/run-visual-baselines.mjs` so the
image tag cannot drift from `@playwright/test` in `package-lock.json`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run test:visual` | Local host compare (dev only; not authoritative) |
| `npm run test:visual:update` | Local host snapshot update (dev only; do not commit) |
| `npm run test:visual:linux` | **Authoritative compare** in pinned Linux Docker |
| `npm run test:visual:linux:update` | **Authoritative author/update** in pinned Linux Docker |
| `npm run test:webview:visual` | Host compare for main-webview pilot only |
| `npm run test:presentation:visual` | Host compare for Presentation pilot only |

Behavioral suites (`test:webview`, `e2e/muster-presentation.spec.ts`) stay
independent of visual scripts.

## Authoring baselines

1. Ensure a Docker engine is available:
   - Docker Desktop, or
   - docker-ce inside WSL (the runner auto-detects `Ubuntu-24.04` when Desktop is down).
2. Run **only** the explicit update path:

   ```bash
   npm run test:visual:linux:update
   ```

3. Inspect the generated goldens under:
   - `e2e/visual/muster-webview.visual.spec.ts-snapshots/`
   - `e2e/visual/muster-presentation.visual.spec.ts-snapshots/`
4. Reject images that contain:
   - secrets, tokens, absolute local paths
   - real user transcripts or live session content
   - stale taxonomy / clipped critical chrome
5. Prove stability with two compare runs and a clean snapshot tree:

   ```bash
   npm run test:visual:linux
   npm run test:visual:linux
   git diff --exit-code -- e2e/visual/*-snapshots
   ```

6. Commit the PNG goldens together with any intentional fixture changes.

## Diagnostics

Each Linux run writes:

- `test-results/visual-linux-diagnostics.json` — host + container summary
- `test-results/visual-linux-diagnostics.container.json` — raw container probe

These include Playwright version, uname, locale/timezone, and font family
listings sufficient to reproduce rasterization context.

## CI policy

- Normal CI **compares** baselines (`npm run test:visual:linux` or equivalent).
- Normal CI **must never** pass `--update-snapshots`.
- If local Docker is unavailable, use a **temporary** explicit CI authoring
  workflow that uploads snapshot artifacts, review them offline, commit from the
  developer machine, then **delete** the temporary authoring path. Do not leave
  update-snapshots enabled on the standing `ci.yml` workflow.

## Scope limits

- Synthetic browser theme tokens and body classes prove **extension-owned**
  webview chrome stability. They do **not** prove native VS Code host chrome
  rendering, workbench layout, or OS window decorations.
- Pilot fixtures are static sanitized contracts (no live ACP backends, no real
  user content).

## Pilot IDs

| Entrypoint | Pilot ID | Spec |
|------------|----------|------|
| Main webview | `muster-webview-visual-pilot` | `e2e/visual/muster-webview.visual.spec.ts` |
| Presentation | `muster-presentation-visual-pilot` | `e2e/visual/muster-presentation.visual.spec.ts` |
