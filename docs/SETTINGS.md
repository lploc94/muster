# Settings pattern

Muster settings are host-backed. The webview can render controls and request changes, but it must not invent durable settings state or write directly to VS Code configuration.

## Reader and action

Reader: internal contributors who are extending Muster after the retention settings pattern exists.

Post-read action: add a new setting to Muster using the same host-backed pattern, with typed messages, fail-closed validation, and local tests.

This guide documents the destination pattern for feature settings and the assembled Settings domain shell. It is not a migration log and it does not claim evidence from an interactive Extension Development Host session.

[SETTINGS-DESIGN.md](SETTINGS-DESIGN.md) defines the adopted product taxonomy and placement rules for future settings. This guide documents the implemented contract for that taxonomy: three actionable domains render as tabs (Agents, Execution, Data) and one domain (Connections) is reserved and not rendered.

At least one real settings group is always backed by VS Code contributed configuration; the single `RuntimeStorageSettingsSnapshot` host surface (run limit plus the two retention/output bounds) is the current concrete example, even though its fields render across two domains.

## Non-negotiable invariants

- The runtime/storage host snapshot is backed by VS Code configuration. It exposes one runtime enum, `muster.execution.runLimit` (`15m`–`8h`, default `2h`), plus `muster.retention.maxRetainedTurnsPerTask` and `muster.retention.maxStoredOutputChars`. This is one host surface whose fields render across two domains: `runLimit` appears as **Run limits** under Execution, while the two retention/output bounds appear as **History** and **Outputs** under Data. The old `muster.retention.maxTurnsPerTask` key is a deprecated one-release read/migration fallback. The **Tool access** section under Execution exposes security-sensitive `muster.permissions.mode` (`ask` | `allow` | `readonly`, default `ask`) through the same contributed-configuration path; the host validates exact enum updates, persists Workspace-target mode only after validation, and re-reads the stored mode live for each runtime permission request without treating Settings configuration as a runtime permission prompt. **Task profiles** (formerly labelled Task Types; the internal id and config key `muster.taskTypes` are unchanged) use resource-scoped `muster.taskTypes` (object map) with **Muster ship defaults** that include `coordinate`, `plan`, `breakdown`, `implement`, `verify`, and `research` (no model pins); the custom Settings panel can edit and **Save** the full map into workspace settings.json. Explicit empty map fails closed for coordinator create/delegate (see `docs/TASK-MANAGEMENT.md` §8).
- The extension host owns reads and writes. It reads configuration into a snapshot, validates update requests, writes through VS Code configuration APIs, and sends the result back to the webview.
- The webview is a typed view. It requests a snapshot, renders values from host messages, posts update requests, and waits for host results before treating a value as saved.
- Webview messages are typed and runtime-guarded. Every new host-to-webview or webview-to-host settings message needs a static TypeScript shape and a runtime guard so malformed messages are ignored instead of partially applied.
- Invalid updates fail closed with sanitized feedback. Bad IDs, wrong types, non-finite values, non-integers, below-minimum values, and host write failures must leave the prior value visible and report a safe user-facing message.
- Unit and protocol coverage pairs with Playwright harness coverage. The host validation path, the webview message guards, and the rendered settings flow each need local checks.
- Settings documentation is part of R008: contributors must be able to find the pattern, understand the ownership boundary, and run local verification without relying on tribal knowledge.

## Settings domain taxonomy

The custom Settings panel follows a four-domain product taxonomy: **Agents**, **Execution**, **Connections**, and **Data**. Only domains with at least one actionable host-backed control are rendered, so the visible shell is **three tabs** — Agents, Execution, and Data. **Connections** is a reserved domain: it has no host-backed control yet, so it is not rendered. There is no `Coming soon` tab and no empty or placeholder navigation destination; an unavailable domain simply does not appear.

The presentation order of the rendered tabs is product contract, not a generic registry:

| Order | Domain | Rendered | Sections and host ownership |
|------:|--------|----------|-----------------------------|
| 1 | **Agents** | Yes | **Task profiles** — host-owned `muster.taskTypes` (workspace write from the panel; resource-scoped contributed config). Formerly labelled Task Types; the label changed but the internal id and config key did not. |
| 2 | **Execution** | Yes | **Run limits** — the `runLimit` enum from the runtime/storage host snapshot (`muster.execution.runLimit`). **Tool access** — host-owned `muster.permissions.mode` enum (formerly the Permissions topic; unchanged semantics). Concurrent scheduling caps (`muster.execution.maxConcurrentPerBackend`, `maxConcurrentTurns`, `maxConcurrentPerRoot`) are contributed configuration under the Execution domain; they are edited in native VS Code Settings (not yet in the custom panel) and read live by the task engine each scheduling pass. |
| 3 | **Data** | Yes | **History** — `muster.retention.maxRetainedTurnsPerTask`. **Outputs** — `muster.retention.maxStoredOutputChars`. Both are flat sections; the old **History storage (Advanced)** disclosure is gone. |
| — | **Connections** | Reserved (not rendered) | No host-backed context-engine or MCP control exists yet. |

The three rendered domains use typed host snapshots and update results. The runtime/storage snapshot keeps its stable setting IDs while its fields render across Execution (`runLimit` as **Run limits**) and Data (the two retention/output bounds as **History** and **Outputs**). It is one host surface even though it is displayed in two domains; the host contract, protocol messages, and guards are unchanged from the pre-refactor shell.

`muster.verification.hostRun` is a reserved destination in Execution. No disabled or `Coming soon` child is rendered for it; native VS Code Settings remains its edit path until a dedicated host contract exists. See the [Verification staging and host contract](SETTINGS-DESIGN.md#verification-staging-and-host-contract) section in the design doc for the future 4-message contract (`requestVerificationSettings` / `verificationSettingsSnapshot` / `updateVerificationSettings` / `verificationSettingsUpdateResult`) and its fail-closed guarantees.

### Execution concurrency caps (native VS Code Settings)

Three resource-scoped `muster.execution` number settings cap concurrent agent turns. They are declared in package contributed configuration, edited in native VS Code Settings (not the custom Settings panel), and consumed by `TaskEngine` via a live `getResourceLimits` getter — the same no-cache pattern as `getRunLimitMs`.

| Setting | Range | Default | Effect on scheduling |
|---------|------:|--------:|----------------------|
| `muster.execution.maxConcurrentPerBackend` | 1–32 | 15 | Maximum concurrent agent turns for a single ACP backend. Further bounded by shared ACP process capacity on the host. |
| `muster.execution.maxConcurrentTurns` | 1–64 | 30 | Maximum concurrent agent turns across all backends in the workspace. |
| `muster.execution.maxConcurrentPerRoot` | 1–64 | 20 | Maximum concurrent agent turns under one root task tree. |

Live-read semantics:

- Values are re-read on **each scheduling pass** (no extension reload required for a raised or lowered cap to affect the next promotion decision).
- Invalid, non-number, or out-of-range values clamp to the package.json min/max (or fall back to the defaults above) through the host clamp path (`resourceLimitsFromSettings`).
- Lowering a cap **does not preempt** already-running turns; it only blocks new promotions until occupancy falls under the new limit.
- Raising a cap allows additional promotions on the **very next** scheduling pass without recreating the engine.
- Structural tree/result limits (`maxDepth`, children, turns-per-task, result/error bytes) stay on engine defaults and are not settings-backed.

Local evidence for the live-read / non-preempt contract is the headless named flow `src/task/m016-settings-live-caps.test.ts` plus clamp unit coverage in `src/task/limits.test.ts`. This guide does not claim interactive Extension Development Host proof for these keys.

Keyboard and narrow layout for the tablist:

- WAI-ARIA tabs with automatic activation: `role="tablist"` / `tab` / `tabpanel`, `aria-controls` / `aria-labelledby`, and roving tabindex.
- ArrowLeft and ArrowRight move and wrap; Home and End jump to first and last topic; Tab leaves the tablist into the active panel controls.
- At 320-pixel width the three tabs remain equal-width in one row without horizontal scrolling, and every tab remains keyboard-reachable. A compact visual state marker replaces long indicator text while the tab's `aria-label` retains the full state.

## State ownership and workspace scope

Settings domains share one shell, but draft ownership and feedback stay domain-local. Treat saved snapshot, per-section draft, and navigation state as three separate layers:

- **App-owned drafts, not panel-owned.** `App.svelte` owns Task profiles drafts, the runtime/storage draft strings (Run limits, History, Outputs), Tool access draft mode, and the active domain id above the conditional Settings panel. Closing Settings, switching tabs, or reopening the panel must not discard in-progress edits.
- **Saved host snapshots stay separate from drafts.** A host `settingsSnapshot`, `taskTypesSettingsSnapshot`, or `permissionSettingsSnapshot` may initialize pristine drafts, but must not overwrite dirty drafts. Only an explicit successful host write (then a force-hydrated snapshot for Task profiles) clears dirty state.
- **Navigation state** (active domain id and non-sensitive view restore) is independent of whether a draft is dirty or a snapshot is stale.
- **Domain-local feedback.** Run limits errors, field validation, and saved banners render only in Execution and never on Agents or Data; History and Outputs feedback renders only in Data; Task profiles diagnostics never render on Execution or Data; Tool access save failures stay on the Execution tab. Because Run limits (Execution) and History/Outputs (Data) share the single runtime/storage host snapshot, dirty, error, saving, and saved feedback for each field must surface only in its owning domain and must not leak across the two domains. Hidden-domain dirty/error/saving/saved state remains inspectable on the owning tab badge.
- **Runtime deadline semantics.** The selected run limit is read when a queued turn promotes and is frozen on that turn. Changing Settings does not move a running deadline. Waiting for dependencies or children happens between backend turns and does not consume the uninterrupted-run budget.
- **Concurrency caps re-read live.** `muster.execution.maxConcurrentPerBackend`, `maxConcurrentTurns`, and `maxConcurrentPerRoot` are resource-scoped contributed numbers (ranges 1–32 / 1–64 / 1–64; defaults 15 / 30 / 20). The host re-reads them on each scheduling pass without reload; per-backend is further bounded by shared ACP process capacity; lowering never preempts running turns (see Execution concurrency caps above).
- **Tool access configuration is not a runtime prompt.** The Tool access section under Execution only configures the default policy mode (`muster.permissions.mode`: `ask` | `allow` | `readonly`). Runtime permission cards still appear as separate in-session prompts when mode is `ask`; already-pending ask-mode requests stay pending until the user, timeout, or cancellation resolves them even if configuration changes (pending-request isolation).
- **Webview hide/reveal persistence.** Non-sensitive navigation and drafts persist under the nested key `muster.settingsView.v1` via `vscode.getState` / `vscode.setState`. The envelope schema is at v3 (bumped from v2 for the domain regroup); the storage key is unchanged. The default active domain is `agents`, and legacy topic ids migrate on restore: `task-types`→`agents`, `permissions`→`execution`, `retention`→`data`, `models-and-clis`→`agents`, `context-and-mcp`→`agents`. For the shared runtime/storage draft, v3 also records the exact dirty setting IDs so the first snapshot after restore can refresh pristine Execution/Data siblings independently. Writes merge into the existing bag and must not delete unrelated keys such as the send outbox. Fail-closed restore rejects malformed or out-of-bounds envelopes.
- **Honest workspace scope for Task profiles.** The custom editor writes the **workspace-level** `muster.taskTypes` map (`workspace settings.json`). Folder-specific resource overrides remain in native VS Code Settings and are not edited here. This guide documents that contract for contributors; it does not claim live Extension Development Host proof of the native Settings UI.
- **Ship defaults include breakdown.** Muster package defaults for `muster.taskTypes` ship `coordinate`, `plan`, `breakdown`, `implement`, `verify`, and `research` without model pins. Reset in the panel restores those package defaults.

## How to add a setting

1. Add the setting to VS Code contributed configuration.
   - Use the `muster.<feature>.<setting>` namespace.
   - Define the type, default, bounds, and description in the manifest so VS Code Settings has the same contract as the custom panel.
   - Prefer a real feature group over a placeholder. The custom panel should prove at least one setting that users can also inspect in VS Code Settings.

2. Add a host definition for the setting.
   - Keep the ID, label, description, default, and minimum in one host-side definition list.
   - Derive defaults and descriptions from the contributed configuration when possible so the manifest and custom panel do not drift.
   - Treat unknown stored values as invalid and fall back to the contributed default when building a snapshot.

3. Add typed protocol messages.
   - Host to webview: send a snapshot message that contains all fields the panel needs to render labels, values, defaults, and constraints.
   - Host to webview: send an update-result message for both success and failure.
   - Webview to host: send a request message for the latest snapshot and an update message with a setting ID plus the candidate value.
   - Add runtime guards for every new message shape. The guard should reject missing IDs, duplicate or unknown settings, invalid numeric values, and malformed result payloads.

4. Keep ownership boundaries clear in the UI.
   - Lift drafts into App-owned state so domain switches and panel unmount cannot discard edits.
   - The panel must not mark a value saved until the host returns a successful update result.
   - Keep domain feedback local: Task profiles (Agents), Run limits and Tool access (Execution), and History and Outputs (Data) each own their error/success surfaces and tab indicators. Fields that share the runtime/storage host snapshot but render in different domains (Run limits in Execution, History and Outputs in Data) must keep their feedback in the owning domain and not bleed across.
   - Full-view Settings replaces the task list while open; Back restores the prior task/chat shell without dropping App-owned settings drafts.
   - Loading, saving, saved, field-error, and domain-local error states should remain inspectable with `role="status"` or `role="alert"` semantics, including text-equivalent tab badges when the domain is not selected.
   - Do not render a domain tab, disabled child, or placeholder for an unavailable domain such as Connections; a domain appears only once it has a real host-backed control.

5. Persist only through the host.
   - Validate the update before calling VS Code configuration APIs.
   - On validation failure, return the validation error and do not write.
   - On write failure, return a sanitized error message and do not expose stack traces, internal paths, or raw host exceptions to the webview.
   - After a write attempt, send a fresh snapshot when one can be read. If reading the snapshot fails, preserve the sanitized update result so the webview can still explain the outcome.

6. Add local coverage before widening the pattern.
   - Host unit tests should cover snapshot defaults, validation failures, successful writes, and sanitized write failures.
   - Protocol tests should reject malformed settings snapshots and malformed update results.
   - The Playwright harness should cover the visible webview states: loading, valid save, client-side field validation, sanitized host rejection, and returning to chat/task state.
   - The documentation verifier should be updated if the stable settings contract changes.

## Settings addition checklist

Before treating a new setting as following this pattern, confirm each item below:

- The setting is declared in VS Code contributed configuration with a user-facing description, default, type, and bounds.
- The extension host can build a complete settings snapshot from contributed configuration and safe stored values.
- The webview only renders the snapshot, posts typed setting update requests, and waits for host success before showing a saved value.
- Runtime guards reject malformed snapshots, unknown setting IDs, duplicate setting IDs, and malformed update results.
- Validation failures and write failures keep the previous saved value visible and show sanitized role-based feedback.
- Local unit, protocol, Playwright, and documentation checks cover the added contract without claiming live Extension Development Host, hosted CI, secret, or session-persistence proof.
- Reserved domains such as Connections render no tab, disabled child, or placeholder and emit no host mutations until a real host-owned control exists.

## Failure behavior

Settings failures should localize to one layer:

| Failure | Required behavior |
|---------|-------------------|
| Unknown setting ID | Host rejects the request and the webview keeps existing values. |
| Wrong value type | Runtime guards or host validation reject the message before a write. |
| Non-finite or non-integer number | Host validation fails and returns a field-specific message. |
| Below minimum | UI validation blocks the obvious case; host validation still enforces the same rule. |
| VS Code configuration write rejects | Host returns a sanitized update failure; the webview keeps the attempted draft, keeps the prior saved snapshot authoritative, and shows domain-local sanitized feedback (it does not rehydrate the input back to saved merely because an error arrived). |
| Refreshed snapshot cannot be read | Host keeps the update result visible and skips the refreshed snapshot. |
| Malformed host message | Webview runtime guards reject the message and leave existing state intact. |
| Cross-domain feedback leak | Run limits (Execution) and History/Outputs (Data) share one host snapshot; feedback must stay in the owning domain and never render in the other. |
| Missing docs link or drifted claims | The local documentation verifier fails with a targeted assertion. |

The important rule is fail closed: a rejected update must never become the displayed saved value just because the webview had a draft.

## Verification

Run the focused local checks while changing settings behavior or this guide:

```bash
npm run test:settings-docs
npm run test:settings-live-evidence
npm run test:settings-webview
```

Equivalent direct commands:

```bash
node --test scripts/verify-settings-docs.test.mjs
node --test scripts/verify-settings-live-host-evidence.test.mjs
npx playwright test e2e/muster-webview-state.spec.ts
```

The docs verifier protects this guide from becoming orphaned, losing R008, omitting the Settings domain taxonomy, accessibility and state-ownership contract, permission security rules, reserved-domain and cross-domain feedback rules, or overclaiming unsupported runtime proof. The live-evidence verifier enforces the native-host ledger shape in `docs/uat/m012-s04/settings-live-host-evidence.md` without turning browser results into native proof. The Playwright command exercises the browser-visible webview path with mocked host messages so loading, saving, saved, field-error, domain-local sanitized failures, Tool access save-to-mode flow, draft isolation across domains, cross-domain feedback isolation between Run limits (Execution) and History/Outputs (Data), the equal-width no-scroll tab row at 320px, WAI-ARIA keyboard behavior, and hide/reveal restore of `muster.settingsView.v1` stay observable. Focused Vitest coverage for the Permissions save-to-runtime path lives in `src/host/permission-settings.test.ts`, `src/backends/permission-policy.test.ts`, `src/backends/acp-client.test.ts`, and `src/bridge/permission-bridge.test.ts`. Execution concurrency clamp and live-read scheduling coverage lives in `src/task/limits.test.ts` and `src/task/m016-settings-live-caps.test.ts` (headless only; not native-host proof).

For the aggregate local Settings acceptance gate (full Vitest, compile, Svelte check, source/evidence checks, docs + ledger verifiers, and the full webview suite):

```bash
npm run test:settings-acceptance
```

These checks are local verification only. A valid `ENVIRONMENT BLOCKED` live-host ledger means the native scenarios were blocked after attempted steps; local CI still only covers docs, ledger shape, and browser webview gates.

## Proof boundary

| Proof class | What it covers | What it does **not** cover |
|-------------|----------------|----------------------------|
| Unit / protocol / docs verifiers | Host validation, message guards, documentation contract, ledger shape | Interactive VS Code UI, native Settings UI |
| Playwright / browser harness | Assembled three-domain webview UX (Agents, Execution, Data) with mocked host messages | Live Extension Development Host, real VS Code configuration writes |
| Native live-host ledger | Direct F5 Extension Development Host observations recorded as PASS, FAIL, or ENVIRONMENT BLOCKED | Browser or Playwright results promoted to native proof |

Browser and Playwright results are **supportive only**. They never upgrade a native Extension Development Host verdict. CI runs compile-equivalent product checks via `npm test`, Svelte check, Settings docs and live-evidence verifiers, and the full webview suite; a green CI job with an honest ENVIRONMENT BLOCKED ledger still only covers local docs, ledger shape, and browser webview gates. Record interactive host attempts separately under `docs/uat/m012-s04/settings-live-host-evidence.md` and keep this guide precise about what each command proves.
