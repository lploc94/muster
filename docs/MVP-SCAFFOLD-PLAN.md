# MVP Scaffold Plan

Goal: Get a **runnable** thing as fast as possible that proves the core loop works.

We do **not** need full VS Code UI or all 4 backends on day 1.

## Phase 0 — Documents (already started)
- [x] docs/DESIGN.md (high level)
- [x] docs/ADAPTER-SPEC.md (the contract)
- [x] docs/CLI-COMMANDS.md (exact commands)
- [x] docs/SESSION-MANAGEMENT.md
- [x] docs/MCP-INJECTION.md
- [x] docs/MUSTER-BRIDGE.md (MCP `ask_user` + AskBridge)

## Phase 1 — Console MVP (fastest feedback)

Target: A Node/TypeScript script you can run from terminal that:
- Takes a backend name + prompt
- Invokes the real CLI over **ACP** (`<cli> agent stdio` or equivalent)
- Streams normalized events to console
- Supports basic resume with explicit session ID
- Optionally passes MCP config

### Minimal files to create

1. `src/types.ts`
   - Copy NormalizedEvent from ADAPTER-SPEC.md
   - Define `RunOptions` and `Backend` interface

2. `src/backends/acp-client.ts` + `src/backends/grok.ts` (reference — done)
   - Shared ACP JSON-RPC client
   - `grok agent stdio`; one session per turn

3. `src/backends/claude.ts` (migrate next)
   - Replace legacy headless `-p` with `claude-code-acp` on `acp-client.ts`

4. `src/runner.ts`
   - Small function: `runTurn(backend, options)`
   - For console: just `for await (const ev of backend.run(...)) { console.log(ev) }`

5. `src/cli.ts` or `scripts/test-runner.ts`
   - Simple CLI or script:
     ```bash
     tsx scripts/test-runner.ts claude "fix the bug in foo.ts" --resume <id>
     ```

6. Basic `SessionStore` (in-memory or small json file for now)
   - `saveSession(backend, id)`
   - `getLastSession(backend)`

### Success criteria for Phase 1
- Can send a prompt to Claude → see streaming text in terminal
- Can resume the same session → history is continued by the CLI
- Can pass a dummy MCP config and see if the agent mentions the tool

## Phase 2 — Add MCP + Polish one more backend

- Make MCP injection work for real (copy a context-engine.json)
- Add Codex backend
- Better error handling + cancellation

## Phase 3 — VS Code Integration (still thin)

- Create basic extension skeleton
- Register a command "Muster: Send to Claude"
- Show output in a simple OutputChannel or Webview first (not beautiful UI yet)
- Wire the runner from Phase 1 into the extension host
- Persist session IDs using VS Code `workspaceState` or `globalState`

## Phase 4 — Minimal Webview

- Simple chat-like view that consumes NormalizedEvent
- Show reasoning blocks + basic tool cards
- Add backend picker + "Continue last session" button

## What NOT to do in MVP

- Do not build full session history UI
- Do not support all 4 backends from the beginning
- Do not implement rich permission / diff UI
- Do not over-abstract MCP too early
- Do not reuse ACP sessions across unrelated turns (shared agent process is OK — see `DESIGN.md` §2.1)

## Recommended Order (Fastest Path to Working)

1. Finish ADAPTER-SPEC + CLI-COMMANDS (done)
2. Implement `claude.ts` + console runner (biggest learning)
3. Add explicit resume support + simple store
4. Add MCP config passing
5. Add Grok backend
6. Move the runner into VS Code extension (command + OutputChannel)
7. Build first version of webview that renders the events
8. Add Codex
9. Add Antigravity (experimental)

Start coding from step 2 as soon as the two spec files feel solid.
