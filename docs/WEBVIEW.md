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
| `sessionStarted` | Internal / optional debug only | — | **Do not** show session id in product chrome (Phase A+) |
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

- **Composer stays editable** while a focused open task is `running` or has FIFO queued follow-ups so Enter can queue another turn and Ctrl+Enter can interrupt & send. Do **not** hard-disable solely because a turn is in-flight.
- **Disabled / blocked** while any `askPending` is unresolved (or show `AskCard` modal — user must submit or cancel), during recovery gates, or dependency-blocked free-form send. Terminal lifecycles stay writable: next `send` **reopens** the same task id to `open`.
- **Enter** posts host `send` (FIFO follow-up while live, no interrupt). **Ctrl+Enter** / **Meta+Enter**: posts `sendLiveInput` when a turn is running — host **reserves a follow-up then interrupts** the live turn (cut & continue). Not concurrent ACP inject. When idle, posts ordinary `send`. Shift+Enter inserts a newline; IME composition suppresses submit.
- **Stop / cancel** still targets the live turn; queue mutations use the `queuedTurns` panel (`editQueuedTurn` / `deleteQueuedTurn`). See §14 for the full queue and interrupt-and-send contract.
- **Terminal messages:** a normal adapter `error` NormalizedEvent (non-zero exit, cancellation) arrives via an `event` message and is then followed by `turnDone`; only an uncaught host/adapter failure sends `turnError`. Treat either terminal message as end-of-turn for stop-button and streaming chrome so the UI never gets stuck mid-run.

### Session / tasks

- **New task** opens an unpersisted composer; first `send` has no `taskId` → `startNewTask` (`lifecycle: open`).
- **Status axes** (see `TASK-MANAGEMENT.md` §4.3; Phase A of
  `docs/plans/task-chat-turn-hide-cli.md`):
  - **Task lifecycle** on list + **workspace status card header**: `open` /
    `succeeded` / `failed` / `cancelled` / `skipped`.
  - **Turn activity** on the **composer strip** (`data-turn-activity`):
    `executing` (“Working”), `waiting_you`, `queued`, `failed_turn`
    (“Could not finish”). **No strip** when ready / between turns. Product UI
    must **not** show CLI process vocabulary (`CLI running/stopped/idle`).
  - **Orchestration** (deps, children, recovery, outcome proposal): action panels
    or expand-details one-liners — not the task badge, not a second App header row.
  Do **not** set task lifecycle from `turnDone` / adapter errors alone.
- **Workspace header = task status card** (not a duplicate title/status bar):
  name + lifecycle badge + **status menu** (`setTaskLifecycle`). **Expand task
  details** (collapsed by default) for lifecycle copy and orchestration hint;
  do **not** show bound session id in product chrome (Phase A).
- **Turn activity mapping (Phase A client derive; Phase B host-owned):** live
  generating → `executing`; `waiting_user` / pending ask → `waiting_you`;
  queued only → `queued`; `needs_recovery` → `failed_turn`; otherwise no strip.
  Stop control is labeled **Stop this turn**.
- **Who seals outcomes:** **user** always (status menu → `setTaskLifecycle`);
  **coordinator** when the user enables outcome delegation (`coordinator_delegate`
  / future `yolo`). See `TASK-MANAGEMENT.md` §4.1.1.
- **Outcome proposal** (`awaiting_outcome`): prefer Accept / Reject when a
  dedicated card ships (`acceptOutcome` / `rejectOutcome`). **Today:** composer
  stays writable; `send` clears the proposal and continues on the same task/
  session. Status menu can still seal `succeeded` / `failed` / cancel / skip.
- **Delegate / yolo:** coordinator may mark success without Accept card; show a
  short “sealed by coordinator” notice; user can still cancel/override.
- **Any sealed lifecycle** (`failed` / `succeeded` / `cancelled` / `skipped`):
  composer stays available; next `send` **reopens** the same task to `open`
  (not a new task id). Status menu / panel **Reopen** → `setTaskLifecycle` `open`.
  For a separate conversation, user creates a **new task** (no continuation draft).
- **Cancel / skip** via status menu (`setTaskLifecycle` → `cancelled` / `skipped`):
  host cascades descendants (`cancelTask` / `skipTask`). Distinct from interrupt
  turn. See `TASK-MANAGEMENT.md` §5.4–§5.6.
- Legacy flat chat, `newSession`, and “Continue last” (`.muster-sessions.json`) were removed in Phase E.
- **`needs_recovery` / `failed_turn`**: inline “Could not finish” card with optional **Try again** / **Continue**; free-form composer remains open; lifecycle stays `open`.
- **Reload-preserved queued turn**: **Resume** → `resumeQueuedTurn`.

### Webview persistence (host-owned transcript + lazy scrollback)

**Decision:** keep **`retainContextWhenHidden: false`** — we do **not** hold the DOM/thread alive when hidden. The **extension host owns the transcript** (a `TranscriptItem[]` per session, §4); the webview is a pure view that renders a recent window and **lazy-loads older items on scroll-up**.

- **On restore** (webview recreated after hide): webview requests the latest window with `loadHistory` (no `before`) → `historyChunk`. The DOM does not need to have survived.
- **Scroll-up** near the top fires `loadHistory { before: <oldest loaded id> }`; host returns the previous page, webview **prepends** it (anchor scroll — see §7.5). Pairs with virtualization (§7.4).
- **Live turns still stream via `event`** — `loadHistory` is only for older/settled items. The host appends each settled item to the transcript as events arrive.
- `vscode.getState()` / `setState()` is only for tiny view state (draft composer text, scroll position) — **not** the transcript; it is not sized for large histories. The host store is the source of truth.
- **New host responsibility (currently unimplemented):** accumulate settled `TranscriptItem`s per session and serve pages on `loadHistory`. In-memory per session suffices for MVP; persist to `workspaceState`/file only if survival across window reload is wanted.

### Cancellation

- `cancelTurn` → extension aborts `AbortSignal`, `AskBridge.cancelAll()`, kills CLI child. Targets the current live turn/`runId` (at most one **running** turn per task; additional follow-ups may already be FIFO-queued — cancel does not delete them).
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

## 12. File-drop mentions

Dragging onto an enabled composer inserts a **textual file mention** (chip). It is not an editor attachment in the VS Code sense, but **OS/Finder drops without a visible path** may be **copied into a private temp directory** so the agent can still open the bytes.

### Protocol

1. Webview extracts drag candidates (`resolveFileDrop { candidates }`) or, when only a `File` blob is available, sends `importDroppedFile { name, data }` (raw bytes, max 25 MiB).
2. Host resolves paths (workspace-relative when inside a folder, otherwise absolute) or materializes an owner-only temp copy under `os.tmpdir()/muster-file-drops/drop-*/`.
3. Host replies `filePicked { path, displayName? }`. Composer inserts a **short display chip** (`@name` / `@"name with spaces"`) and binds it to the resolve path.
4. On **send**, webview keeps display text for the transcript and may send `llmText` with chips expanded to full paths for the agent (`TaskMessage.agentContent`).

### Contract notes

- Prefer **one file** per drop; alternate encodings of the same file are collapsed.
- VS Code often requires **Shift** when dropping into a webview from Explorer/Finder.
- Disabled composers ignore drag input.
- Temp imports use exclusive create (`wx`), mode `0o600`, per-drop directories, and best-effort 24h prune on the next import.
- Directories are rejected when `stat` reports a folder; missing targets may still be mentioned if a path string was provided.

### Proof boundary

Unit tests cover extraction, host resolution, import, and mention expand-on-send. Focused Playwright covers the browser-visible composer flow with synthetic host messages. Local unit and Playwright checks are **supportive only**; live Extension Development Host observation is required for PASS/FAIL of native Explorer/Finder drags.

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

## 14. Queued follow-ups and interrupt & send

Task-workspace composer keyboard and queue UX (product contract for multi-turn follow-ups):

| Input | Host message | Behavior |
|-------|--------------|----------|
| **Enter** (task focused) | `send` `{ taskId, text }` | Creates a **distinct** FIFO follow-up turn bound to that user message. Works while a turn is already running or other turns are queued. On terminal lifecycle, reopens the same task then queues. |
| **Ctrl+Enter** / **Meta+Enter** (running) | `sendLiveInput` → `interruptAndSend` | **Reserve** FIFO follow-up first, then **interrupt** the live turn when a local handle exists. No concurrent `backend.sendLiveInput`, no `liveInputResult` banner. Instruction uses agent-facing expanded mention text when present. |
| **Ctrl+Enter** / **Meta+Enter** (idle) | `send` `{ taskId, text }` | Same as Enter — starts/continues a normal turn immediately. |
| **Shift+Enter** | — | Inserts a newline; does not submit. |
| IME composition / keyCode 229 | — | Suppresses submit. |

### Composer unlock vs blocks

The **composer stays editable** during `running`, `queued`, `needs_recovery`, and dependency/children/external waits so operators can stack follow-ups (scheduler gates promotion). Free-form send is UI-blocked only for structured `waiting_you` / pending ask (AskCard primary). Terminal lifecycles (`succeeded` / `failed` / `cancelled` / `skipped`) stay writable: next `send` reopens the same task id to `open` and may queue a turn.

Guidance copy on the composer strip describes queue vs interrupt-and-send (e.g. “Enter queues a follow-up · Ctrl+Enter interrupts and sends”) rather than a hard disable-while-running message.

### FIFO queue panel (`queuedTurns`)

Host snapshots project `queuedTurns` (ordered by sequence) for the focused task. The workspace **queued turns** panel is the inspection surface: each undispatched turn may be edited or deleted. **Queued follow-ups (including interrupt-and-send reservations) do not appear in the chat transcript** until their turn starts; the panel uses host `previewText` (not chat bubbles).

- **Edit** → `editQueuedTurn` `{ taskId, turnId, content }` — updates the bound pending user message of that turn only; clears any stale `agentContent` so the edited text drives the next prompt.
- **Delete** → `deleteQueuedTurn` `{ taskId, turnId }` — removes the undispatched turn and its bound pending message(s); does **not** cancel a running turn.
- Controls **lock** when `turnId` leaves the live `queuedTurns` projection (dispatch / start boundary). Stale mutations refuse with a visible `commandError` banner; they never silently no-op as success.

Scheduler promotes at most **one active (running) turn** per task and only the **earliest** queued sequence (FIFO). Multiple queued follow-ups drain after **successful** settlement **or** a **confirmed** interrupt settlement (cut & continue). Forced interrupt and failed settlements keep MEM030 hold until recovery/resume.

Over-cap `send` refuses visibly (`commandError` / engine reason) and does **not** leave free-floating pending messages without turn identity.

### Interrupt & send feedback

| Outcome | Host / engine | UI |
|---------|---------------|----|
| Reserve + interrupt | `interruptAndSend` | Follow-up appears in `queuedTurns`; no `liveInputResult` banner |
| Reserve failed | `commandError` | Live turn keeps running |
| Confirmed interrupt settle | FIFO promote + optional session bind | Next turn runs with user message |
| Forced / unconfirmed cancel | Hold queue | Follow-up stays queued until recovery/resume |

Capability / concurrent inject is **not** the product path for Ctrl+Enter.

Draft / new-task mode has **no** interrupt-and-send path: Ctrl+Enter behaves like Enter (`send` / first-turn create).

### Proof boundary

Unit tests cover keyboard intent, protocol shapes, queue control locking, and interrupt-and-send host wiring. Focused Playwright (`e2e/muster-webview-state.spec.ts` against the Vite webview) proves Enter vs Ctrl+Enter message shapes and queue edit/delete with synthetic host messages. Local unit and Playwright checks are supportive only: only direct observation in an actual VS Code Extension Development Host can establish a live keyboard proof. See [CONTRIBUTING.md](../CONTRIBUTING.md) for verification commands.

---

## 15. Task / chat Markdown export

From a **focused task** workspace, **Export task/chat** posts a host-owned export request for that task only. The host projects a point-in-time Markdown document (`muster-task-export/v1`), opens the native VS Code Save As dialog, and writes UTF-8 on approval. Domain contract details (allowlist, metadata, filename rules) live in [TASK-MANAGEMENT.md](TASK-MANAGEMENT.md) §18.

### Protocol

| Direction | Message | Shape / notes |
|-----------|---------|----------------|
| Webview → host | `exportTask` | `{ type: 'exportTask', taskId }` — focused task id only |
| Host → webview | `exportResult` | `{ type: 'exportResult', taskId, fileName, sourceRevision, exportedAt }` — `fileName` is **basename-only** (never an absolute path) |
| Host → webview | `commandError` | Task-scoped sanitized failure text (`invalid_request`, `task_not_found`, `render_bound`, `write_failed`, `dialog_failed`) |
| Host → webview | _(none)_ | User cancel of Save As is **silent** — cancel produces no webview message |

### UX rules

- The control is available on the focused task workspace; it must not export a foreign task id.
- Success uses the task-scoped notice chrome with basename + `sourceRevision` context (for example `Export saved as ship-readable-export.md (source revision 11).`).
- Failures reuse existing `commandError` chrome with host-sanitized generic text — no absolute destinations, raw stacks, credentials, or other-task content.
- Cancel clears no extra chrome beyond the click that starts export (prior error banners may clear when re-triggering export).
- Foreign-task `exportResult` / `commandError` feedback stays hidden when another task is focused.

### Proof boundary

Unit tests cover the pure Markdown projector, host export route (including silent cancel and sanitized failures), and webview protocol guards. Focused Playwright (`e2e/muster-webview-state.spec.ts` against the Vite webview with mocked VS Code APIs) proves **Export task/chat** posts focused `exportTask` and shows task-scoped success/failure chrome with synthetic host messages. Local unit and Playwright checks are supportive only; they do not prove native Save As, overwrite, Unicode filename, or write-failure outcomes. Live Extension Development Host observation and the verifier-backed ledger in [CONTRIBUTING.md](../CONTRIBUTING.md) establish PASS / FAIL / ENVIRONMENT BLOCKED for those scenarios.

---

## 16. References

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Elements docs](https://vscode-elements.github.io)
- [VS Code Elements — getting started](https://vscode-elements.github.io/guides/getting-started/)
- [Svelte custom elements interop](https://svelte.dev/docs/svelte/custom-elements) — we consume CEs, not author them
- [react-virtuoso](https://github.com/petyosi/react-virtuoso) — reference for chat virtualization patterns (Cline)
- [@humanspeak/svelte-virtual-chat](https://github.com/humanspeak/svelte-virtual-chat) — Svelte chat virtual list option
