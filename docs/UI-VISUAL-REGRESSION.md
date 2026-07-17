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
| `npm run test:webview:visual:linux` | Authoritative Linux compare (webview matrix) |
| `npm run test:presentation:visual:linux` | Authoritative Linux compare (presentation matrix) |

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

## M014 S01 dual-entrypoint flow

Stable independently executable proof (exact Playwright title):

```text
M014 S01 flow: deterministic dual-entrypoint pilot
```

Spec: `e2e/visual/m014-slice-flows.spec.ts`

This flow exercises **both** main-webview and Presentation pilot boundaries in
one test and compares them against the committed Linux goldens. It supplements
the per-entrypoint pilot specs and is the named slice verification entrypoint:

```bash
npm run test:visual:linux -- --grep "M014 S01 flow: deterministic dual-entrypoint pilot"
```


## M014 S02 representative visual matrix

Bounded committed matrix (hard cap **eight** cases, currently six) covering both
entrypoints, compact 320px main-webview and narrow Presentation containment, and
light / dark / high-contrast browser theme tokens.

Machine-checkable source of truth:

- `e2e/visual/visual-cases.manifest.json` — case ids, owners, entrypoints, states,
  layouts, viewports, themes, requirement mapping, snapshot paths, fixture factories
- `e2e/visual/visual-cases.ts` — typed re-export (`VISUAL_MATRIX_CASES`,
  `M014_S02_FLOW_TITLE`, `VISUAL_MATRIX_MAX_CASES`)
- `scripts/verify-visual-baselines.test.mjs` — contract + negative tests
  (`node --test scripts/verify-visual-baselines.test.mjs`)

Stable independently executable proof (exact Playwright title):

```text
M014 S02 flow: representative visual matrix
```

Spec: `e2e/visual/m014-slice-flows.spec.ts`

This named flow **must** be grepped independently. Aggregate `npm run test:visual:linux`
matrix runs cannot substitute for it:

```bash
npm run test:visual:linux -- --grep "M014 S02 flow: representative visual matrix"
node --test scripts/verify-visual-baselines.test.mjs
npm run test:visual:linux
npm run test:visual:linux
git diff --exit-code -- e2e/visual
```

### Matrix case IDs

| ID | Entrypoint | Layout | Theme | Spec snapshot |
|----|------------|--------|-------|---------------|
| `V01-webview-compact-dark` | webview | compact 320×600 | dark | `muster-webview.visual.spec.ts-snapshots/` |
| `V02-presentation-rich-dark` | presentation | standard 1280×720 | dark | `muster-presentation.visual.spec.ts-snapshots/` |
| `V03-webview-autocomplete-light` | webview | compact 320×600 | light | `muster-webview.visual.spec.ts-snapshots/` |
| `V04-webview-settings-prompt-hc` | webview | compact 320×600 | high-contrast | `muster-webview.visual.spec.ts-snapshots/` |
| `V05-webview-validation-errors-dark` | webview | compact 320×600 | dark | `muster-webview.visual.spec.ts-snapshots/` |
| `V06-presentation-narrow-light` | presentation | narrow 360×600 | light | `muster-presentation.visual.spec.ts-snapshots/` |

Flow-owned goldens under `m014-slice-flows.spec.ts-snapshots/` use the `S02-`
prefix so they do not collide with the S01 dual-entrypoint pilot snapshots that
share V01/V02 ids at a different viewport.

Before commit, inspect every image for:

- clipping of critical chrome
- stale Settings taxonomy / placeholder ("Coming soon") tabs
- unreadable contrast
- secrets, absolute paths, or real user content

## Pilot IDs

| Entrypoint | Pilot ID | Spec |
|------------|----------|------|
| Main webview | `V01-webview-compact-dark` | `e2e/visual/muster-webview.visual.spec.ts` |
| Presentation (rich, dark) | `V02-presentation-rich-dark` | `e2e/visual/muster-presentation.visual.spec.ts` |
| Presentation (narrow, light) | `V06-presentation-narrow-light` | `e2e/visual/muster-presentation.visual.spec.ts` |
| Dual-entrypoint flow | `M014 S01 flow: deterministic dual-entrypoint pilot` | `e2e/visual/m014-slice-flows.spec.ts` |
| Autocomplete (light) | `V03-webview-autocomplete-light` | `e2e/visual/muster-webview.visual.spec.ts` |
| Settings + prompt (HC) | `V04-webview-settings-prompt-hc` | `e2e/visual/muster-webview.visual.spec.ts` |
| Validation errors (dark) | `V05-webview-validation-errors-dark` | `e2e/visual/muster-webview.visual.spec.ts` |
| Matrix flow | `M014 S02 flow: representative visual matrix` | `e2e/visual/m014-slice-flows.spec.ts` |

