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

## Failure evidence (expected / actual / diff / trace / HTML)

When a visual compare fails, Playwright writes diagnosable evidence under stable
repository-relative paths. CI uploads the same roots as a single artifact.

| Kind | Path pattern | Notes |
|------|--------------|-------|
| Expected golden | `test-results/**/*-expected.png` | Copy of the committed baseline used for compare |
| Actual screenshot | `test-results/**/*-actual.png` | What Chromium rendered in this run |
| Diff image | `test-results/**/*-diff.png` | Pixel-level highlight of the mismatch |
| Trace | `test-results/**/trace.zip` | Playwright trace (`trace: retain-on-failure`) |
| Failure screenshot | `test-results/**/test-failed-*.png` | Page capture on failure (`screenshot: only-on-failure`) |
| HTML report | `playwright-report/index.html` | Aggregated Playwright HTML report |

### Local controlled mismatch probe

Prove the failure path without committing baseline changes:

```bash
# 1) Clean green compare
npm run test:visual:linux

# 2) Disposable mismatch → expect fail + full artifact inventory → restore fixture
node scripts/probe-visual-failure.mjs

# 3) Green again; committed goldens untouched
npm run test:visual:linux
git diff --exit-code -- e2e/visual
```

The probe temporarily recolors the dark-theme `--vscode-foreground` token in
`e2e/fixtures/visual-environment.ts` for case `V01-webview-compact-dark`, runs
the pinned Linux compare, inventories the six required artifact kinds, then
**always** restores the fixture. It never writes under `e2e/visual/*-snapshots`.

Unit coverage for inventory / mismatch helpers:

```bash
node --test scripts/probe-visual-failure.test.mjs
```

### CI artifact download

On a failed `visual` job:

1. Open the GitHub Actions run → **visual** job.
2. Download the artifact named **`visual-regression-failure`** (retention **14** days).
3. Unpack locally; open `playwright-report/index.html` and inspect
   `test-results/**/*-{expected,actual,diff}.png` plus `trace.zip`.
4. Fix the product/fixture regression **or** intentionally re-author goldens via
   `npm run test:visual:linux:update` (never enable update-snapshots in CI).

Contract tests that pin the workflow artifact name and retention:

```bash
node --test scripts/verify-visual-ci.test.mjs
```

## Ownership

| Surface | Owner |
|---------|--------|
| Visual matrix cases + goldens (`e2e/visual/`) | Maintainer who lands the UI change that requires a baseline update |
| Pinned Linux runner (`scripts/run-visual-baselines.mjs`) | Platform / CI maintainers |
| CI `jobs.visual` + artifact contract (`.github/workflows/ci.yml`) | Platform / CI maintainers |
| Operations guide (this doc) | Any maintainer updating visual tooling |
| Deferred product UI work | Tracked in [UI-IMPROVEMENT-ROADMAP.md](UI-IMPROVEMENT-ROADMAP.md) — **not** implemented by M014 visual slices |

PR authors own intentional golden updates in the same PR as the product/fixture
change. Reviewers own the **update review** checklist below before merge.

## Compare path (normal day-to-day)

Use the **authoritative compare** only when judging green/red for baselines:

```bash
npm run test:visual:linux
```

This invokes `scripts/run-visual-baselines.mjs` inside the lockfile-pinned
Playwright Docker image. It never updates snapshots.

Host-only shortcuts (`npm run test:visual`, entrypoint-scoped host scripts) are
dev feedback loops. They are **not** interchangeable with Linux goldens and must
not be used as the sole proof for a PR.

## Pinned authoring and explicit update

Authoring is an **explicit** command, separate from compare:

```bash
npm run test:visual:linux:update
```

Rules:

- Never pass `--update-snapshots` (or `test:visual:linux:update`) in standing CI.
- Never commit host-OS screenshots from `npm run test:visual:update`.
- Prefer updating only the cases whose fixtures or product chrome intentionally
  changed; re-read the matrix in `e2e/visual/visual-cases.manifest.json`.
- After an explicit update, always re-run two clean compares (see Authoring
  baselines above) before push.

## Update review

When a PR touches `e2e/visual/*-snapshots/**` or visual fixtures, reviewers must:

1. Confirm the PR description explains **why** goldens changed (product fix vs
   fixture sanitization vs intentional chrome change).
2. Open every new/changed PNG and reject images with secrets, tokens, absolute
   local paths, real user transcripts, stale Settings taxonomy, clipped critical
   chrome, or unreadable contrast (Presentation black-on-black fails closed via
   `assertPresentationReadableContrast`).
3. Confirm CI `Visual regression` is green on the PR head **without** any
   update-snapshots step in the workflow diff.
4. Confirm behavioral jobs remain independently required (`compile` / webview
   suite) — visual green does not replace behavioral green.

## Troubleshooting

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Local Linux compare cannot start Docker | Docker Desktop down / WSL engine unavailable | Start Docker or WSL docker-ce; re-run `npm run test:visual:linux`. Diagnostics land in `test-results/visual-linux-diagnostics.json`. |
| Host compare green, Linux CI red | OS font/rasterization drift | Trust Linux goldens only; re-author with `npm run test:visual:linux:update`, never commit host screenshots. |
| Single case red after intentional UI change | Fixture or product chrome changed | Inspect expected/actual/diff under `test-results/`; if intentional, explicit-update that case and re-compare twice. |
| Many cases red after dependency bump | Playwright / Chromium raster change | Follow **Playwright upgrade** below; re-author the full matrix once in pinned Linux. |
| CI red but no downloadable evidence | Artifact upload path drift | Check `jobs.visual` still uploads `test-results/` + `playwright-report/` as `visual-regression-failure` on `if: failure()`. Contract: `node --test scripts/verify-visual-ci.test.mjs`. |
| Need to prove failure artifacts without dirty goldens | — | `node scripts/probe-visual-failure.mjs` (restores fixtures; never writes snapshots). |
| Docker image tag mismatch | Lockfile `@playwright/test` drift vs cached image | Re-run via `run-visual-baselines.mjs` (resolves tag from lockfile); avoid hard-coding image tags in docs or CI. |

Health signals: green `npm run test:visual:linux` twice + `git diff --exit-code -- e2e/visual`.
Failure signals: non-zero visual job, `visual-regression-failure` artifact present.
Recovery signals: probe restores fixtures; explicit update is human-gated; standing CI stays compare-only.

## Playwright upgrade

Upgrading `@playwright/test` (and thus the Chromium revision inside
`mcr.microsoft.com/playwright:v*-jammy`) can shift subpixel rasterization and
break committed goldens even with no product CSS change.

Procedure:

1. Bump `@playwright/test` in `package.json` / lockfile in an isolated PR when
   possible.
2. Run `npm install` so `package-lock.json` records the new version.
3. Re-author **all** matrix goldens in the new pinned image:

   ```bash
   npm run test:visual:linux:update
   npm run test:visual:linux
   npm run test:visual:linux
   git diff --stat -- e2e/visual
   ```

4. Review every changed PNG (update review checklist).
5. Keep behavioral suites green (`npm run test:webview`, Presentation specs).
6. Do **not** leave a temporary CI authoring workflow enabled after the upgrade.

`scripts/run-visual-baselines.mjs` must continue to resolve the image tag from
the lockfile so docs, CI, and local authoring cannot drift independently.

## Browser-versus-native proof boundary

| Proof class | What it covers | What it does **not** cover |
|-------------|----------------|----------------------------|
| Pinned Linux visual matrix (this guide) | Extension-owned main-webview + Presentation DOM chrome under synthetic theme tokens, fixed fonts/locale/clock, reduced-motion fixtures | Native VS Code workbench chrome, activity bar, panel layout, OS window decorations, real host zoom UI |
| Behavioral Playwright (`test:webview`, presentation specs) | Interaction contracts with mocked `acquireVsCodeApi` | Live Extension Development Host, real ACP backends |
| Native host / live-host ledgers | Extension Development Host UAT when environment allows | Must not be claimed from browser-only green |

Synthetic browser theme tokens and body classes prove **extension-owned**
webview chrome stability. They do **not** prove native VS Code host chrome
rendering, workbench layout, or OS window decorations. Pilot fixtures are
static sanitized contracts (no live ACP backends, no real user content).

When a requirement needs native theme, forced-colors, or 200% zoom acceptance,
track it under [UI-IMPROVEMENT-ROADMAP.md](UI-IMPROVEMENT-ROADMAP.md) and prove
it with the appropriate native or dual-class gate — not by expanding PNG
goldens alone.

## Scope limits

- Visual CI is a **distinct** required check (`jobs.visual`) and does not replace
  the behavioral `compile` job.
- Baselines are never auto-accepted; compare and explicit update stay separate.
- M014 records deferred product UI work without implementing redesigns here.

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
- Presentation table/Mermaid contrast via `assertPresentationReadableContrast` (fails closed on black-on-black)
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

