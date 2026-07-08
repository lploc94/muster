# Backend Adapter Specification

This is the core contract between the coordinator and each CLI backend.

**Guiding principles for this spec:**
- **ACP-only:** every backend adapter drives one ACP session per `run()` on a shared `<cli> agent stdio` connection (see `CLI-COMMANDS.md`). No headless `-p`/`exec` stdout parsing.
- Explicit session IDs for resume (the coordinator, not the adapter, owns conversation identity).
- MCP injection happens at turn start (so the agent can use tools like the context engine during that turn).
- Streaming events normalized for UI (thinking + tool visibility).
- Keep the interface simple for MVP while leaving room for extension.

## Goals for MVP
- Simple, stable interface that multiple backends can implement.
- Clear separation: adapter manages one *turn* (process + stream), coordinator manages *conversation* (session IDs across turns).
- Support for resume via explicit session ID.
- Support for injecting MCP config per turn.
- Normalized events for streaming thinking + tool calls.
- Easy to add new CLIs later.

## NormalizedEvent (core type)

```ts
export type NormalizedEvent =
  | { type: 'sessionStarted'; sessionId?: string; meta?: Record<string, unknown> }
  | { type: 'assistantDelta'; content: string; messageId: string; meta?: Record<string, unknown> }
  | { type: 'reasoningDelta'; content: string; messageId: string; meta?: Record<string, unknown> }   // optional per backend
  | { type: 'toolStarted'; toolCallId: string; name: string; kind?: 'mcp' | 'builtin' | 'other'; input?: unknown; meta?: Record<string, unknown> }
  | { type: 'toolUpdated'; toolCallId: string; input?: unknown; meta?: Record<string, unknown> }
  | { type: 'toolCompleted'; toolCallId: string; outcome: 'success' | 'error'; output?: unknown; error?: string; meta?: Record<string, unknown> }
  | { type: 'usage'; usage: Record<string, unknown>; meta?: Record<string, unknown> }
  | { type: 'turnCompleted'; meta?: Record<string, unknown> }
  | { type: 'error'; message: string; isCancellation?: boolean; raw?: unknown; meta?: Record<string, unknown> }
  | { type: 'raw'; line: string };   // for unknown/debug output from the CLI
```

**Design notes and invariants (MVP):**
- Keep the set small and stable.
- `reasoningDelta`, detailed tool events, and `meta` are optional capabilities.
- `sessionStarted` is emitted **at most once per run**, as early as possible (usually from the first system/init event), and always before content events. `sessionId` may be omitted only when the CLI has not revealed it yet by end of turn (then the fallback below applies).
- New-session ID strategy: emit `sessionStarted` from the `session/new` response (server-assigned `sessionId`). Do not pre-generate IDs unless a backend's ACP implementation documents client-chosen IDs.
- **Termination:** each `run()` must end with exactly one terminal event — either `{ type: 'turnCompleted' }` on success, or `{ type: 'error' }` on failure/cancellation. No events may follow the terminal event.
- Operational failures (non-zero exit, parse errors that abort the turn, etc.) are represented by `{ type: 'error' }`, not thrown exceptions from the adapter. Unexpected programming errors may still reject the iterator.
- `messageId` is required on `assistantDelta` and `reasoningDelta`; adapters synthesize stable per-run IDs when the provider does not supply them.
- `toolCallId` is required and should be namespaced by the adapter (e.g. `claude:tool-abc123`).
- **Tool event ordering:** `toolStarted` for a given `toolCallId` must precede any `toolUpdated`/`toolCompleted` with the same ID, and each `toolCallId` gets exactly one `toolCompleted` — unless the turn ends in `error` mid-tool, in which case in-flight tools are simply abandoned (no synthetic completion required).
- `toolUpdated.input` is a **full replacement** of the previous input snapshot (not a merge patch). Adapters should buffer fragmented input until a valid snapshot can be emitted.
- `toolCompleted.outcome: 'success'` permits `output` but not `error`; `outcome: 'error'` requires `error` and must not include `output`.
- **`raw` policy:** adapters emit `raw` for stdout lines they cannot parse and for unknown provider events. The coordinator uses `raw` only for diagnostic logging — never rendered in the UI. This preserves unexpected output for debugging when CLI formats change.
- `kind` on tools helps the UI render MCP tools differently from built-in ones.

## Backend Interface

```ts
export interface RunOptions {
  prompt: string;
  resumeId?: string;           // explicit session ID from a previous turn
  mcpConfigPath?: string;      // path to MCP config (backend-specific handling)
  cwd?: string;
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;        // for cancellation from the UI
}

export interface BackendCapabilities {
  supportsReasoning: boolean;
  supportsDetailedToolEvents: boolean;
  supportsMCP: boolean;
}

export interface Backend {
  /** Unique name, e.g. 'claude', 'grok', 'kiro', 'codex', 'opencode' */
  readonly name: string;

  /** What this backend can reliably produce (helps the coordinator decide what to render) */
  readonly capabilities?: BackendCapabilities;

  /**
   * Run one turn. Returns an async iterable of normalized events.
   * Open or resume one ACP session on the backend's shared agent connection,
   * then drive session/prompt and map session/update → NormalizedEvent.
   * Must respect options.signal for cancellation (ACP session/cancel).
   */
  run(options: RunOptions): AsyncIterable<NormalizedEvent>;

  /**
   * Post-turn fallback when no `sessionStarted` with an ID was observed.
   * `rawOutput` is the full raw stdout/stderr of the turn, buffered by the
   * runner (not the adapter). If this also fails, the coordinator falls back
   * to `lastUsedId` (see SESSION-MANAGEMENT.md).
   */
  extractSessionId?(rawOutput: string, lastUsedId?: string): string | undefined;
}
```

## Responsibilities of each Backend implementation

- Configure the backend's ACP agent spawn command (see CLI-COMMANDS.md).
- Reuse or wrap the shared `AcpClient` (`src/backends/acp-client.ts`).
- Inject MCP via `mcpServers` on `session/new` / `session/load` (`RunOptions.mcpServers`).
- Resume via `session/load { sessionId }` when `resumeId` is set.
- Map `session/update` notifications → `NormalizedEvent` as early as possible.
- Yield `sessionStarted` immediately after `session/new` (or at start of `session/load`).
- Handle ACP errors, agent process crash, and `session/cancel` on abort.
- Be defensive with `sessionUpdate` shapes (CLIs evolve).

## Lifecycle clarification (important)

- **Turn** = one invocation of `run()` (what the adapter owns).
- **ACP agent process** = one long-lived stdio JSON-RPC peer per backend type (extension lifetime).
- **ACP session** = one conversation slice on that agent (one per turn; `session/new` or `session/load`).
- **Conversation / session** = long-lived history identified by the `sessionId` from `session/new` (what the coordinator stores and passes in `resumeId`).

The adapter should not try to manage conversation history itself.

## Error & Cancellation

- If `signal` is aborted: send ACP `session/cancel` for the active session, then yield `{ type: 'error', isCancellation: true, ... }` as the terminal event.
- Distinguish user cancellation from other failures so the UI can react differently.
- The shared agent process stays alive; only the session ends. Dispose agent processes on extension deactivate.

## MCP handling

MCP injection is **uniform over ACP**: pass `mcpServers` (http/sse entries) on `session/new` / `session/load` via `RunOptions.mcpServers`. stdio MCP is rejected by some agents over ACP — expose stdio servers (e.g. `context_engine`) via http/sse proxy or the Muster Bridge pattern.

`mcpConfigPath` is a legacy field retained for any future non-ACP (headless) backend; all current ACP adapters (Claude, Grok, Kiro, Codex, OpenCode) use `mcpServers` only.

## Implementation status

All five ACP backends are implemented on the shared `acp-client.ts`:

1. Grok — native ACP (`grok --no-auto-update agent stdio`)
2. Kiro — native ACP (`kiro-cli acp`)
3. OpenCode — native ACP (`opencode acp`)
4. Claude — bundled `@agentclientprotocol/claude-agent-acp`
5. Codex — bundled `@agentclientprotocol/codex-acp`

Next: Antigravity (`agy`), experimental until it exposes an ACP stdio entry with solid streaming + MCP behavior.

## Versioning & evolution

- The normalized event shape is the public contract. Add new optional fields rather than breaking changes.
- Log the exact command + CLI version at the beginning of every turn.
- Keep raw events. This makes it much easier when a CLI changes its JSON format.

## Example usage (pseudocode)

```ts
const backend = new ClaudeBackend();

for await (const event of backend.run({
  prompt: "Fix the bug in foo.ts",
  resumeId: previousId,
  mcpConfigPath: "./context-engine.mcp.json",
  signal: controller.signal
})) {
  if (event.type === 'sessionStarted') storeSessionId(event.sessionId);
  if (event.type === 'assistantDelta') ui.appendText(event.content);
  if (event.type === 'toolStarted') ui.showTool(event.name);
}
```

This spec is intentionally minimal but extensible. We can evolve the event model and add capabilities without rewriting every backend.