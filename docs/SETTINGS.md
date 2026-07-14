# Settings pattern

Muster settings are host-backed. The webview can render controls and request changes, but it must not invent durable settings state or write directly to VS Code configuration.

## Reader and action

Reader: internal contributors who are extending Muster after the retention settings pattern exists.

Post-read action: add a new setting to Muster using the same host-backed pattern, with typed messages, fail-closed validation, and local tests.

This guide documents the destination pattern for feature settings. It is not a migration log and it does not claim evidence from an interactive Extension Development Host session.

## Non-negotiable invariants

- At least one real settings group is backed by VS Code contributed configuration. Today the retention group exposes `muster.retention.maxTurnsPerTask` and `muster.retention.maxStoredOutputChars` through the extension manifest so VS Code owns default values, minimums, and the user-facing Settings entry. Task-type presets use resource-scoped `muster.taskTypes` (object map); empty fails closed for coordinator create/delegate (see `docs/TASK-MANAGEMENT.md` §8).
- The extension host owns reads and writes. It reads configuration into a snapshot, validates update requests, writes through VS Code configuration APIs, and sends the result back to the webview.
- The webview is a typed view. It requests a snapshot, renders values from host messages, posts update requests, and waits for host results before treating a value as saved.
- Webview messages are typed and runtime-guarded. Every new host-to-webview or webview-to-host settings message needs a static TypeScript shape and a runtime guard so malformed messages are ignored instead of partially applied.
- Invalid updates fail closed with sanitized feedback. Bad IDs, wrong types, non-finite values, non-integers, below-minimum values, and host write failures must leave the prior value visible and report a safe user-facing message.
- Unit and protocol coverage pairs with Playwright webview harness coverage. The host validation path, the webview message guards, and the rendered settings flow each need local checks.
- Settings documentation is part of R008: contributors must be able to find the pattern, understand the ownership boundary, and run local verification without relying on tribal knowledge.

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
   - The panel may keep draft input while the user edits.
   - The panel must not mark a value saved until the host returns a successful update result.
   - The panel should keep task and chat context visible when Settings opens and closes.
   - Loading, saving, saved, field-error, and global-error states should remain inspectable with `role="status"` or `role="alert"` semantics.

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

## Failure behavior

Settings failures should localize to one layer:

| Failure | Required behavior |
|---------|-------------------|
| Unknown setting ID | Host rejects the request and the webview keeps existing values. |
| Wrong value type | Runtime guards or host validation reject the message before a write. |
| Non-finite or non-integer number | Host validation fails and returns a field-specific message. |
| Below minimum | UI validation blocks the obvious case; host validation still enforces the same rule. |
| VS Code configuration write rejects | Host returns a sanitized update failure and the webview restores the previous value. |
| Refreshed snapshot cannot be read | Host keeps the update result visible and skips the refreshed snapshot. |
| Malformed host message | Webview runtime guards reject the message and leave existing state intact. |
| Missing docs link or drifted claims | The local documentation verifier fails with a targeted assertion. |

The important rule is fail closed: a rejected update must never become the displayed saved value just because the webview had a draft.

## Verification

Run the focused local checks while changing settings behavior or this guide:

```bash
node --test scripts/verify-settings-docs.test.mjs
npx playwright test e2e/muster-webview-state.spec.ts
```

The first command protects this guide from becoming orphaned, losing R008, omitting the host-backed invariants, or overclaiming unsupported runtime proof. The second command exercises the browser-visible webview path with mocked host messages so the loading, saving, saved, field-error, and sanitized global-error states stay observable.

For a full local pre-ship gate, also run the project test and compile commands from the root README workflow:

```bash
npm test
npm run compile
```

These checks are local verification only. If a future change needs interactive manual evidence, record it separately and keep this guide precise about what the automated commands prove.
