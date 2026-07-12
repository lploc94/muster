# Webview UI — design & implementation

Authoritative spec for the Muster chat sidebar webview: tech stack, folder layout, `postMessage` protocol, rendering rules, and MVP phases.

> **Scope:** The concrete `runId` / `newSession` protocol below describes the
> current single-chat UI. The task-based target adds `taskId`, renames `runId` to
> the persisted `turnId`, and replaces New Session with New Task as specified in
> `TASK-MANAGEMENT.md` §14. Rendering and streaming rules in this document remain
> applicable.

**Related docs (do not duplicate here):**
- [`ADAPTER-SPEC.md`](ADAPTER-SPEC.md) — `NormalizedEvent` types and adapter invariants
- [`MUSTER-BRIDGE.md`](MUSTER-BRIDGE.md) — `ask_user` + AskBridge (§3.2–3.3), extension↔webview messages (§6)
- [`SESSION-MANAGEMENT.md`](SESSION-MANAGEMENT.md) — resume IDs, `.muster-sessions.json`
- [`DESIGN.md`](DESIGN.md) — coordinator architecture (extension host vs webview)
- [`SETTINGS.md`](SETTINGS.md) — host-backed Settings pattern for feature configuration

---

## 1. Stack (decided)

| Layer | Choice | Role |
|-------|--------|------|
| UI framework | **Svelte 5** | Components, reactivity, streaming append |
| Bundler | **Vite** | Bundle webview assets for `asWebviewUri()`; dev watch |
| CSS | **Tailwind CSS v4** (`@tailwindcss/vite`) | Layout only — flex, gap, scroll, spacing |
| VS Code controls | **`@vscode-elements/elements`** | Native-feel buttons, inputs, collapsibles, selects |
| Extension host | **TypeScript + `tsc`** | Unchanged; loads built webview, relays events |

**Not used:** React, `@vscode/webview-ui-toolkit` (deprecated Jan 2025).

### Why Svelte + Vite?

- **Svelte** compiles components to JS — it does not bundle or serve files.
- **Vite** bundles `webview/` → `dist/webview/` so the sandboxed iframe can load a single JS/CSS payload.
- Extension host and webview are **two separate build targets**.

### Theme

All colors and fonts come from VS Code CSS variables (`var(--vscode-*)`). Tailwind handles structure, not palette — do not use default Tailwind grays for backgrounds.

Body classes from VS Code: `vscode-light`, `vscode-dark`, `vscode-high-contrast` ([Webview theming](https://code.visualstudio.com/api/extension-guides/webview#theming-webviews)).

### Bundle size targets

Keep the webview lean:

- Import **individual** vscode-elements components (not full `bundled.js`) once past MVP.
- Tailwind v4: restrict scanning with `@source "./src/**"` in `app.css` (v4 auto-detects content — there is no `content` array like v3) — expect ~5–15 KB CSS after purge.
- Defer heavy deps (`react-markdown` equivalents, syntax highlighters, mermaid) until Phase 2+.

---

## 2. Repository layout

```
muster/
├── src/                          # Extension host (existing)
│   ├── extension.ts              # WebviewViewProvider — postMessage only
│   ├── backends/
│   ├── runner.ts
│   └── types.ts                  # NormalizedEvent (shared contract)
│
├── webview/                      # Svelte app (new)
│   ├── index.html
│   ├── vite.config.ts
│   ├── svelte.config.mjs
│   ├── src/
│   │   ├── main.ts               # mount App, import vscode-elements
│   │   ├── app.css               # @import "tailwindcss"
│   │   ├── App.svelte
│   │   ├── lib/
│   │   │   ├── vscode.ts         # acquireVsCodeApi() singleton
│   │   │   ├── protocol.ts       # Message type guards
│   │   │   └── turn-state.ts     # Svelte stores / run state
│   │   └── components/
│   │       ├── ChatThread.svelte
│   │       ├── MessageBubble.svelte
│   │       ├── Composer.svelte
│   │       ├── Toolbar.svelte
│   │       ├── ToolCard.svelte
│   │       ├── ReasoningBlock.svelte
│   │       └── AskCard.svelte
│   └── tsconfig.json
│
└── dist/
    ├── src/extension.js          # tsc output
    └── webview/                  # vite build output
        ├── index.html
        └── assets/
```

Extension host loads the built bundle. **Vite hashes asset names by default** (`index-[hash].js`) and emits an `index.html` that references them — so loading a fixed path only works if you pin non-hashed names (see `vite.config.ts` in §3):

```ts
// Works because vite.config pins entry/asset names (no hash).
const scriptUri = webview.asWebviewUri(
  vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js')
);
const styleUri = webview.asWebviewUri(
  vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.css')
);
// Inject as an ES module: <script type="module" src="${scriptUri}"></script>
```

If you keep hashing instead: (b) read `dist/webview/index.html` at runtime and rewrite its `src`/`href` through `asWebviewUri`, or (c) inline everything with [`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile) (one HTML, but the inline `<script>` then needs a nonce in the CSP). Pinning (a) is simplest for a single-entry MVP.

`localResourceRoots`: `[vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]` (tighter than `[extensionUri]`).

---

## 3. Build & dependencies (target)

### Dependencies to add

```bash
npm i -D svelte @sveltejs/vite-plugin-svelte vite \
        tailwindcss @tailwindcss/vite
npm i @vscode-elements/elements
```

`svelte`, `vite`, `tailwindcss`, `@tailwindcss/vite` and the Svelte plugin are build-time only; `@vscode-elements/elements` is bundled into the webview payload.

### `package.json` scripts

```json
{
  "scripts": {
    "build:webview": "vite build --config webview/vite.config.ts",
    "watch:webview": "vite build --config webview/vite.config.ts --watch",
    "compile": "tsc -p . && npm run build:webview",
    "vscode:prepublish": "npm run compile"
  }
}
```

`vscode:prepublish` makes `vsce package` always rebuild the webview — without it a stale/missing `dist/webview` ships in the VSIX. `.vscodeignore` must **not** exclude `dist/**` (the built webview must ship).

### `webview/vite.config.ts` (minimal)

```ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  base: './',                         // relative URLs inside the sandbox
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      output: {                       // pin non-hashed names (see §2 loader)
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
```

### `webview/svelte.config.mjs`

`.mjs` (not `.js`) so it is treated as ESM without adding `"type": "module"` to the root `package.json` — the extension host is CommonJS.

```js
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default { preprocess: vitePreprocess() };
```

F5 / `tasks.json`: run `watch:webview` alongside `tsc -watch` so UI changes rebuild before reload.

**Local UI dev (optional):** [vscode-elements Webview Playground](https://github.com/vscode-elements/webview-playground) emulates `--vscode-*` variables outside VS Code.

---

## 4. `postMessage` protocol

Webview never calls MCP or spawns CLIs. All I/O goes through the extension host.

### 4.1 Extension → webview

| `type` | Payload | When |
|--------|---------|------|
| `turnStart` | `{ runId: string; prompt: string; backend: string; resume: boolean }` | User message accepted; adapter `run()` begins |
| `event` | `{ runId: string; event: NormalizedEvent }` | Each normalized event from adapter |
| `turnDone` | `{ runId: string }` | Adapter iterator finished without host error |
| `turnError` | `{ runId: string; message: string }` | Uncaught host/adapter failure |
| `askPending` | `{ id: string; questions: Question[] }` | AskBridge registered (see MUSTER-BRIDGE §6) |
| `historyChunk` | `{ items: TranscriptItem[]; hasMore: boolean }` | Reply to `loadHistory`: older items to **prepend** (scroll-up), or the latest window on restore |
| `sessionReset` | `{}` | New session — clear thread state |

`Question` shape (from `muster_bridge` `ask_user`):

```ts
interface Question {
  prompt: string;
  options?: string[];
  allowFreeText?: boolean;
}
```

`TranscriptItem` = the **settled** form of a rendered entry (the persisted twin of §7.3 `settledMessages`), owned by the host per session (§8):

```ts
interface TranscriptItem {
  id: string;                              // stable; sorts chronologically (cursor for loadHistory)
  kind: 'user' | 'assistant' | 'tool' | 'error';
  content: unknown;                        // rendered payload per kind (text / tool snapshot / error)
}
```

### 4.2 Webview → extension

| `type` | Payload | When |
|--------|---------|------|
| `send` | `{ text: string; continueLast?: boolean }` | User submits composer |
| `newSession` | `{}` | Toolbar — clear session ID, reset UI |
| `loadHistory` | `{ before?: string; limit: number }` | Lazy-load older transcript (scroll-up / on restore). `before` = id of oldest loaded item (cursor); omit for the latest window |
| `cancelTurn` | `{}` | User aborts in-flight turn (`AbortSignal`) |
| `submitAsk` | `{ id: string; answers: Record<string, { selected: string[]; freeText: string \| null }> }` | Ask card submitted |
| `cancelAsk` | `{ id: string }` | User dismisses ask — may cancel turn |

Answer keys are **question index as string** (`"0"`, `"1"`, …) per MUSTER-BRIDGE §3.3.

### 4.3 Legacy aliases (migration)

Current inline HTML in `extension.ts` uses older names. Phase 1 scaffold replaces them:

| Legacy (remove) | Canonical |
|-----------------|-----------|
| `start` | `turnStart` |
| `done` | `turnDone` |
| `error` (host) | `turnError` |

`event` payload stays `{ event }` but gains `runId` for multi-turn safety.

### 4.4 `runId`

Extension generates a UUID per user send. Webview tags all `event` / `turnDone` / `turnError` with the same `runId` so late events from a cancelled turn are ignored.

---

## 5. Rendering `NormalizedEvent`

Source of truth for event shapes: [`ADAPTER-SPEC.md`](ADAPTER-SPEC.md). UI rules:

| Event | Render | Component | Notes |
|-------|--------|-----------|-------|
| `sessionStarted` | Status chip / toolbar hint | `Toolbar` | Show session ID truncated; optional |
| `assistantDelta` | Append to open bubble | `MessageBubble` | Group by `messageId`; same ID → same bubble |
| `reasoningDelta` | Append in collapsible | `ReasoningBlock` | Group by `messageId` (like `assistantDelta`); default collapsed; muted style |
| `toolStarted` | New card, running state | `ToolCard` | Show `name`, `kind`; MCP badge if `kind === 'mcp'` |
| `toolUpdated` | Update card input preview | `ToolCard` | Replace input snapshot (not merge) |
| `toolCompleted` | Card done / error state | `ToolCard` | `outcome: 'error'` → show `error` text |
| `usage` | Footer metadata (optional) | — | Phase 2; can hide in MVP |
| `turnCompleted` | End turn indicator | `ChatThread` | Subtle “done” — host also sends `turnDone` |
| `error` | Inline error block | `MessageBubble` | `isCancellation` → “Cancelled” not red alert |
| `raw` | **Do not render** | — | Extension may log; ADAPTER-SPEC policy |

**Streaming:** append `assistantDelta.content` to the bubble matching `messageId`. Create a new bubble when `messageId` changes.

**Tool correlation:** index cards by `toolCallId`. `toolStarted` must arrive before `toolUpdated` / `toolCompleted`.

---

## 6. Component map

### Layout (Tailwind)

```
┌─────────────────────────────────┐
│ Toolbar                         │  backend select, New Session, status
├─────────────────────────────────┤
│ ChatThread (scroll)             │  messages, tool cards, reasoning, asks
│                                 │
├─────────────────────────────────┤
│ AskCard (conditional, overlay   │  blocks composer while pending
│  or inline above composer)      │
├─────────────────────────────────┤
│ Composer                        │  textarea + send
└─────────────────────────────────┘
```

### vscode-elements usage

| UI need | Component |
|---------|-----------|
| Send / Cancel / New session | `vscode-button` |
| Prompt input | `vscode-textarea` |
| Backend picker | `vscode-single-select` |
| Tool output / reasoning | `vscode-collapsible` |
| ask_user options | `vscode-radio` or `vscode-checkbox` |
| ask_user free text | `vscode-textfield` |
| Group labels | `vscode-form-group` |
| MCP / running badge | `vscode-badge` |
| Divider | `vscode-divider` |

Import per component in `main.ts` (tree-shake). Example:

```ts
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-textarea/index.js';
```

Svelte uses web components as plain HTML tags — no React wrapper. Custom element events may need `use:` actions or `addEventListener` if `on:click` does not bind (verify per component in playground).

### Chat bubbles (custom Svelte + Tailwind)

vscode-elements has no message bubble — build with Tailwind + `--vscode-badge-background` / `--vscode-editor-background` for user vs assistant distinction.

---

## 7. Scroll & performance

Many chat extensions lag with long threads — usually **not** because of `overflow-y: auto` itself, but because every streaming token re-renders or re-parses the entire history.

### 7.1 Common lag causes

| Cause | Symptom |
|-------|---------|
| Full-list re-render on each `assistantDelta` | CPU spikes while assistant streams |
| Markdown + syntax highlight on every token | Jank grows with message count |
| No DOM ceiling | 200+ messages → thousands of nodes in layout/paint |
| `retainContextWhenHidden: true` | Heavy DOM kept alive when tab is hidden |
| Reactive store updates at parent | One delta invalidates whole `ChatThread` |

Reference: Cline uses [`react-virtuoso`](https://github.com/petyosi/react-virtuoso) for variable-height chat virtualization.

### 7.2 Scroll container (Phase 1–2)

MVP uses **native CSS scroll** — no virtual-list dependency until needed.

```svelte
<div
  class="flex-1 min-h-0 overflow-y-auto overscroll-contain"
  bind:this={scrollEl}
>
  <!-- settled messages + streaming bubble -->
</div>
```

`min-h-0` is required inside flex parents so the thread can shrink and scroll instead of expanding the panel.

**Stick-to-bottom** while streaming — only auto-scroll if the user is already near the bottom (do not yank scroll while they read history):

```ts
const BOTTOM_THRESHOLD_PX = 80;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
}

function scrollToBottomIfPinned(el: HTMLElement) {
  if (isNearBottom(el)) {
    el.scrollTop = el.scrollHeight;
  }
}
```

Call after each batched streaming update, not on every raw `postMessage` (see §7.3).

### 7.3 Render patterns (required — more important than virtual list)

#### Separate streaming bubble from settled history

Do **not** push a new array entry on every `assistantDelta`. Keep one mutable buffer for the in-flight assistant message; commit to `settledMessages` on `turnCompleted` / `turnDone`.

```svelte
{#each settledMessages as msg (msg.id)}
  <MessageBubble {msg} />
{/each}
{#if streaming}
  <MessageBubble content={streamingBuffer} streaming />
{/if}
```

Only the open bubble re-renders during a turn — historical messages stay static.

**Multiple `messageId`s per turn:** commit the buffer and open a new bubble whenever `messageId` changes (per §5) — not only at `turnCompleted` / `turnDone`. Tool cards (`toolCallId`) are timeline items too: settle them in order between assistant segments so the thread stays chronological. (Today’s Claude adapter uses one `messageId` per turn, so this only bites multi-message backends — but build the buffer keyed by `messageId` from the start.)

#### Plain text while streaming; markdown once

| Phase | Assistant output |
|-------|------------------|
| During `assistantDelta` | `white-space: pre-wrap` text node — no markdown parser |
| After `turnCompleted` | Optional markdown pass **once** per bubble |

Never run markdown or syntax highlighting on the full thread per token.

#### Tool cards keyed by `toolCallId`

Update `ToolCard` in place (`toolStarted` → `toolUpdated` → `toolCompleted`). Do not rebuild the message list when a tool event arrives.

#### Optional: batch deltas

Coalesce rapid `assistantDelta` events with `requestAnimationFrame` before flushing to `streamingBuffer` — reduces layout thrashing on fast backends.

### 7.4 Virtual list (Phase 3+ / when lag is observed)

Add virtualization only when profiling shows need (e.g. 100+ settled messages with tool cards). Chat lists are **variable height** — prefer chat-oriented libs over fixed-height virtual lists.

| Library | Notes |
|---------|-------|
| [`@humanspeak/svelte-virtual-chat`](https://github.com/humanspeak/svelte-virtual-chat) | Chat-focused for Svelte |
| [`@tanstack/svelte-virtual`](https://tanstack.com/virtual) | Flexible; more setup for variable rows |

**Caveat:** virtual lists complicate stick-to-bottom and “streaming tail” — keep the **active streaming bubble outside** the virtualized window, or use a lib that supports a pinned footer row. Trigger lazy scrollback (§7.5) when the **top** sentinel / overscan enters view: fetch the previous page via `loadHistory` and prepend.

### 7.5 History window & lazy scrollback

The webview never holds the whole thread. Render a **recent window**; older items are **lazy-loaded on scroll-up** from the host transcript (`loadHistory` → `historyChunk`, §4 + §8) — not kept in memory or DOM.

- Initial / after-restore render = latest N items (e.g. 50); scrolling near the top prepends the previous page.
- **Prepend without jump:** capture `scrollHeight` before insert, then set `scrollTop += (newScrollHeight - oldScrollHeight)` after (or use the virtual list's anchoring). Do not stick-to-bottom during an upward load.
- Guard against overlapping requests (one in-flight `loadHistory` at a time; stop when `hasMore === false`).
- Optionally collapse older **turns** in `<vscode-collapsible>` (one block per user prompt + replies).
- Do not render `raw` events (ADAPTER-SPEC policy).

### 7.6 Checklist

- [ ] `ChatThread`: `overflow-y-auto` + `min-h-0` + stick-to-bottom helper
- [ ] Streaming buffer separate from `settledMessages`
- [ ] Plain-text streaming; defer markdown to turn end
- [ ] `ToolCard` updates by `toolCallId`, not list splice
- [ ] Lazy scrollback — render a recent window; `loadHistory` older on scroll-up; host owns transcript (§7.5, §8)
- [ ] Virtual list — only when measured lag warrants it (§7.4)

---

## 8. State & UX rules

### Composer

- **Disabled** while a turn is in-flight (`turnStart` received, no `turnDone` / `turnError` yet).
- **Disabled** while any `askPending` is unresolved (or show `AskCard` modal — user must submit or cancel).
- Enter sends; Shift+Enter newline (standard chat pattern).
- **Re-enable on `turnDone` OR `turnError`.** A normal adapter `error` NormalizedEvent (non-zero exit, cancellation) arrives via an `event` message and is then followed by `turnDone`; only an uncaught host/adapter failure sends `turnError`. Treat either terminal message as end-of-turn so the composer never gets stuck.

### Session / tasks

- **New task** opens an unpersisted composer; first `send` has no `taskId` → `startNewTask` (`lifecycle: open`).
- **Three status axes** (see `TASK-MANAGEMENT.md` §4.3):
  - **Task lifecycle** on list + **workspace status card header**: `open` /
    `succeeded` / `failed` / `cancelled` / `skipped`.
  - **CLI view** on the **composer strip**: `not_started` / `running` / `idle` /
    `stopped`. Optional subtitle for `lastExit` (`ok` / `error` / `cancelled`)
    when stopped. **Error is not a CLI phase.**
  - **Orchestration** (deps, children, recovery, outcome proposal): action panels
    or expand-details one-liners — not the task badge, not a second App header row.
  Do **not** set task lifecycle from `turnDone` / CLI errors alone.
- **Workspace header = task status card** (not a duplicate title/status bar):
  name + lifecycle badge + **status menu** (`setTaskLifecycle`). **Expand task
  details** (collapsed by default) for lifecycle copy, orchestration hint, bound
  session id; keep collapsed chrome free of “Task is open / Session ses_…” noise.
- **CLI mapping:** live generating → `running`; `waiting_user` / process alive
  not generating → `idle`; never spawned / only queued → `not_started`; process
  exited → `stopped`. After reload, derive prior process from `hadProcess` and/or
  `committedSessionId` when host has not projected `cliViewStatus`.
- **Who seals outcomes:** **user** always (status menu → `setTaskLifecycle`);
  **coordinator** when the user enables outcome delegation (`coordinator_delegate`
  / future `yolo`). See `TASK-MANAGEMENT.md` §4.1.1.
- **Outcome proposal** (`awaiting_outcome`): prefer Accept / Reject when a
  dedicated card ships (`acceptOutcome` / `rejectOutcome`). **Today:** composer
  stays writable; `send` clears the proposal and continues on the same task/
  session. Status menu can still seal `succeeded` / `failed` / cancel / skip.
- **Delegate / yolo:** coordinator may mark success without Accept card; show a
  short “sealed by coordinator” notice; user can still cancel/override.
- **Soft failed:** composer stays available; next `send` **reopens** the same task
  to `open` (not a new task id). Status menu **Reopen** → `setTaskLifecycle` `open`.
- **Continue as new task** for **hard** terminal (`succeeded` / `cancelled` /
  `skipped`): `send { text, continuationOf }` (no `taskId`). No reopen-on-same-id.
- **Cancel / skip** via status menu (`setTaskLifecycle` → `cancelled` / `skipped`):
  host cascades descendants (`cancelTask` / `skipTask`). Distinct from interrupt
  turn. See `TASK-MANAGEMENT.md` §5.4–§5.6.
- Legacy flat chat, `newSession`, and “Continue last” (`.muster-sessions.json`) were removed in Phase E.
- **`needs_recovery`**: explicit **Retry** (required instruction) and **Continue** (required message) controls; lifecycle stays `open`.
- **Reload-preserved queued turn**: **Resume** → `resumeQueuedTurn`.

### Webview persistence (host-owned transcript + lazy scrollback)

**Decision:** keep **`retainContextWhenHidden: false`** — we do **not** hold the DOM/thread alive when hidden. The **extension host owns the transcript** (a `TranscriptItem[]` per session, §4); the webview is a pure view that renders a recent window and **lazy-loads older items on scroll-up**.

- **On restore** (webview recreated after hide): webview requests the latest window with `loadHistory` (no `before`) → `historyChunk`. The DOM does not need to have survived.
- **Scroll-up** near the top fires `loadHistory { before: <oldest loaded id> }`; host returns the previous page, webview **prepends** it (anchor scroll — see §7.5). Pairs with virtualization (§7.4).
- **Live turns still stream via `event`** — `loadHistory` is only for older/settled items. The host appends each settled item to the transcript as events arrive.
- `vscode.getState()` / `setState()` is only for tiny view state (draft composer text, scroll position) — **not** the transcript; it is not sized for large histories. The host store is the source of truth.
- **New host responsibility (currently unimplemented):** accumulate settled `TranscriptItem`s per session and serve pages on `loadHistory`. In-memory per session suffices for MVP; persist to `workspaceState`/file only if survival across window reload is wanted.

### Cancellation

- `cancelTurn` → extension aborts `AbortSignal`, `AskBridge.cancelAll()`, kills CLI child. Targets the current `runId` (only one turn is ever in-flight — the composer is disabled otherwise).
- Pending `AskCard` → `cancelAsk` or turn cancel clears card.

### Security

- CSP on webview HTML: `default-src 'none'`; scripts/styles from `webview.cspSource` only. Vite emits an **ES module**, so allow it via `script-src ${cspSource}` (an external bundle file carries no nonce) and `style-src ${cspSource} 'unsafe-inline'` if Vite injects a `<style>`:

  ```
  default-src 'none';
  img-src ${cspSource} https: data:;
  font-src ${cspSource};
  style-src ${cspSource} 'unsafe-inline';
  script-src ${cspSource};
  ```

  Load the entry as `<script type="module" src="${scriptUri}"></script>`. (Use a nonce instead of `${cspSource}` only if you inline the script — e.g. the `vite-plugin-singlefile` path in §2.)
- Sanitize any rendered CLI output (future markdown phase).
- Webview has no Node integration — only `postMessage`.

---

## 9. MVP phases

### Phase 1 — Scaffold + layout (no AskBridge)

- [ ] Create `webview/` with Svelte 5 + Vite + Tailwind v4 + vscode-elements
- [ ] Wire `MusterChatProvider` to load `dist/webview/` via `asWebviewUri`
- [ ] Implement protocol §4 (canonical names)
- [ ] `Toolbar` + `Composer` + `ChatThread` with §7.2 scroll + §7.3 streaming buffer
- [ ] Render `assistantDelta`, `toolStarted` / `toolCompleted`, `error` — note: today’s Claude adapter emits only `sessionStarted` / `assistantDelta` / `error` / `turnCompleted` (`supportsDetailedToolEvents: false`), so drive `ToolCard` with mock events until an adapter emits real tool events
- [ ] Remove inline HTML from `extension.ts`

### Phase 2 — Rich streaming

- [ ] `ReasoningBlock` (collapsible)
- [ ] `toolUpdated` input preview
- [ ] `messageId` grouping polish
- [x] Backend picker (Claude + Grok)
- [ ] Markdown subset for assistant bubbles — **once per turn**, not per delta (§7.3)
- [ ] Optional: `requestAnimationFrame` delta batching

### Phase 3 — AskBridge

- [ ] `AskCard` + `askPending` / `submitAsk` / `cancelAsk`
- [ ] Block composer during pending ask
- [ ] Depends on AskBridge + `MusterMcpHttpServer` (MUSTER-BRIDGE checklist)
- [ ] Evaluate virtual list if long sessions lag (§7.4)

### Post-MVP

- Host-owned transcript + lazy scrollback (`loadHistory`, §7.5 / §8), session list UI, usage footer, `notify_user` toasts — see MUSTER-BRIDGE §4.2+.

---

## 10. Type sharing (optional)

`NormalizedEvent` lives in `src/types.ts` today. Options:

1. **Duplicate** a slim type copy in `webview/src/types.ts` (simplest for MVP).
2. **Shared package** `packages/types` later if drift becomes painful.
3. Do not import `src/types.ts` directly into webview — different build graphs.

`postMessage` payloads should be validated with type guards in `webview/src/lib/protocol.ts`.

---

## 11. Implementation checklist

- [ ] `docs/WEBVIEW.md` (this file)
- [ ] `webview/` scaffold per §2
- [ ] `package.json` scripts per §3
- [ ] `.vscode/tasks.json` — parallel `tsc -watch` + `watch:webview`
- [ ] Refactor `extension.ts` — thin provider, no inline HTML
- [ ] Phase 1 UI components per §6
- [ ] Scroll + streaming performance per §7
- [ ] Update `CONTRIBUTING.md` with webview dev instructions (when scaffold lands)

---

## 12. Workspace file-drop mentions

Dragging onto an enabled composer is a request to insert a **textual mention**; it is not an attachment and does not upload or persist file contents. The webview extracts bounded drag candidates and sends `resolveFileDrop` with `{ candidates: string[] }` to the extension host. The host alone parses URIs, checks the workspace boundary, verifies the target, and replies with `filePicked` carrying `{ path: string }` only after resolution succeeds.

The supported contract is deliberately narrow:

- exactly one regular file from the current workspace; local `file:` and matching `vscode-remote:` workspace resources are accepted;
- the returned path is workspace-relative, uses forward slashes, and contains no absolute workspace identity;
- the composer inserts `@path` (or `@"path with spaces"`) at the current selection/caret, preserving surrounding draft text and placing the caret after the mention;
- disabled composers ignore drag input and send no resolution request; and
- multiple files, malformed or oversized data, unsupported schemes, missing workspaces, outside-workspace paths, directories, and stat failures are rejected with a bounded, sanitized user-facing error. Rejection does not change the draft and never reflects raw paths or filesystem errors.

This is a security boundary, not merely formatting: the webview cannot declare a candidate safe, and `filePicked` must contain only the host-validated relative mention. The protocol does not grant the backend direct file bytes or create an attachment.

### Proof boundary

Unit tests cover extraction, host resolution, protocol guards, and negative cases. Focused Playwright covers the browser-visible composer flow with synthetic host messages. Local unit and Playwright checks are supportive only: only direct observation in an actual VS Code Extension Development Host can establish a live `PASS` or `FAIL`. Record live attempts and scenario-local environmental blockers using the contributor procedure and tracked evidence ledger.

---

## 13. Read-only presentation review and revision

A coordinator-triggered dedicated tab presents a bounded review artifact beside the Muster chat. It is **read-only**: it is not an editor, file manager, or alternate conversation surface. Markdown paragraphs, tables, fenced code, and safe links render in the tab; links use the host's safe external-opening policy.

### Identity, updates, and isolation

Each tab has a stable presentation ID and immutable owning task. A monotonic revision updates that same tab only when the revision is newer; stale or replayed revisions are ignored. Multiple tabs may remain open, and each presentation ID is isolated so an update cannot mutate another tab.

### Mermaid and visible fallback

Mermaid rendering is deliberately bounded by diagram count, source length, strict rendering, and sanitized SVG output. Unsupported, oversized, malformed, unsafe, or failed diagrams remain visible as source-backed fallback blocks rather than disappearing. For troubleshooting, inspect the diagram element's `data-mermaid-state` (`rendered` or `fallback`) and `data-mermaid-reason` (for example `malformed`, `unsafe-output`, or `renderer-failure`). These attributes describe renderer state without exposing task or transcript content.

### Revise through the linked chat

Use **Open linked chat** to reveal the presentation owner's existing task. The button reports a typed `success` or `failure` status. Submit feedback in that existing task; when the coordinator produces a newer correlated revision, the stable presentation ID refreshes the same panel. The tab does not create a second conversation channel, and its content cannot be edited directly.

### Restore, dispose, and diagnose

Supported window reload restores a validated persisted presentation while preserving its identity, owner, and latest revision. Closing the tab disposes its panel registration; a later update may create a fresh panel but cannot mutate the disposed instance. Close all scenario-created tabs when finished.

If review or revision fails:

1. Check the linked-chat typed status. A failure means reveal was rejected or the owning task could not be shown; continue from the task list rather than assuming feedback was sent.
2. Check `data-mermaid-state` and `data-mermaid-reason` for a diagram-specific fallback. The source remains available for review.
3. Confirm the update uses the same presentation and owner identities with a strictly newer revision.
4. After reload, distinguish a rejected invalid snapshot from a valid restored tab. After disposal, verify the closed panel does not change.

Contributor proof and live-host evidence rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 14. References

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Elements docs](https://vscode-elements.github.io)
- [VS Code Elements — getting started](https://vscode-elements.github.io/guides/getting-started/)
- [Svelte custom elements interop](https://svelte.dev/docs/svelte/custom-elements) — we consume CEs, not author them
- [react-virtuoso](https://github.com/petyosi/react-virtuoso) — reference for chat virtualization patterns (Cline)
- [@humanspeak/svelte-virtual-chat](https://github.com/humanspeak/svelte-virtual-chat) — Svelte chat virtual list option
