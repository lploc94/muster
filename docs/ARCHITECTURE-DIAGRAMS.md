# Architecture diagrams

Two views of the same system. Both are hand-maintained from the source tree, not generated.

| Diagram | Use it for | Shows direction of control? |
|---------|------------|-----------------------------|
| [Project execution flow](#project-execution-flow) | Quick visual overview of a prompt turn, including retry and user-input loops | Yes |
| [Runtime flow](#runtime-flow) | Understanding how a turn actually executes, and who calls whom | Yes |
| [Module inventory](#module-inventory) | Onboarding, locating a subsystem, scoping a change | No |

Prefer the runtime flow when debugging or planning a change that crosses layers. Prefer the
inventory when you need to know *what exists* and where it lives.

Both diagrams render inside Muster itself: the webview pipes fenced `mermaid` blocks through
`webview/src/lib/mermaid-renderer.ts` (`securityLevel: 'strict'` plus a fail-closed
`sanitizeMermaidSvg` DOMPurify pass), so this file doubles as a live rendering check.

## Project execution flow

A compact flowchart in the dark, decision-oriented style used for the quick visual reference.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "#191a24", "primaryColor": "#252c43", "primaryTextColor": "#c9d4ff", "primaryBorderColor": "#465579", "lineColor": "#b8c6ef", "secondaryColor": "#252c43", "tertiaryColor": "#252c43", "edgeLabelBackground": "#191a24", "fontFamily": "Inter, Segoe UI, sans-serif"}}}%%
flowchart TB
    START["Start<br/>User sends a prompt"] --> UI["Webview<br/>Svelte chat UI"]
    UI --> HOST["Extension host<br/>protocol v2"]
    HOST --> ENGINE["Task engine<br/>schedule + persist"]

    ENGINE --> READY{"Backend ready?"}
    READY -->|"No"| DOCTOR["Probe / diagnose"]
    DOCTOR --> RETRY{"Retry?"}
    RETRY -->|"Yes"| READY
    RETRY -->|"No"| BLOCKED["Turn blocked"]

    READY -->|"Yes"| ACP["ACP run<br/>session + prompt"]
    ACP --> ASK{"Needs user input?"}
    ASK -->|"Yes"| WAIT["MCP / RFD bridge<br/>waiting_user"]
    WAIT --> ANSWER["User answers<br/>or approves"]
    ANSWER --> ACP
    ASK -->|"No"| CLI["AI CLI<br/>Claude · Codex · Grok · Kiro · OpenCode"]

    CLI --> EVENTS["Stream normalized events"]
    EVENTS --> VERIFY{"Verification passed?"}
    VERIFY -->|"No"| REPAIR["Repair / continue"]
    REPAIR --> ACP
    VERIFY -->|"Yes"| RESULT["Persist result<br/>update Webview"]
    RESULT --> DONE(("Done"))

    classDef box fill:#252c43,stroke:#465579,color:#c9d4ff,stroke-width:1px
    classDef decision fill:#252c43,stroke:#6075a6,color:#c9d4ff,stroke-width:1px
    classDef terminal fill:#252c43,stroke:#465579,color:#c9d4ff,stroke-width:1px
    class START,UI,HOST,ENGINE,DOCTOR,ACP,WAIT,ANSWER,CLI,EVENTS,REPAIR,RESULT box
    class READY,RETRY,ASK,VERIFY decision
    class BLOCKED,DONE terminal
    linkStyle default stroke:#b8c6ef,stroke-width:1px
```

## Runtime flow

Layers top-level, with the ACP turn path as the spine.

```mermaid
flowchart TB
    subgraph UI["1 · Webview (Svelte)"]
        direction LR
        A1["App.svelte<br/>task list + chat"]
        A2["composer +<br/>file-mention"]
        A3["Presentation.svelte<br/>read-only tabs"]
    end

    subgraph HOST["2 · Extension host"]
        direction LR
        H2["send-request"]
        H1["extension.ts<br/>commands + view"]
        H4["presentation mgr<br/>+ tool router"]
        H3["probe / readiness<br/>+ settings"]
    end

    subgraph ENGINE["3 · Task engine"]
        direction LR
        E1["engine +<br/>scheduler"]
        E2["transitions +<br/>derived-status"]
        E3["workflow +<br/>handoff"]
        E4["verification<br/>gate + verdict"]
    end

    subgraph BE["4 · ACP backends"]
        direction LR
        B1["acp-run +<br/>acp-client"]
        B2["Grok / Kiro / OpenCode<br/>native ACP"]
        B3["Claude / Codex<br/>bundled adapter"]
    end

    subgraph STORE["Durable state"]
        direction TB
        S1["SqliteTaskRepository"]
        S2["rpc to worker"]
        S3[("muster.sqlite3<br/>schema v3")]
        S1 --> S2 --> S3
    end

    subgraph BR["Muster Bridge (MCP)"]
        direction TB
        R1["mcp-config<br/>per-turn mcpServers"]
        R2["mcp-stdio-proxy"]
        R3["ask / permission /<br/>elicitation bridge"]
        R1 --> R2
    end

    A1 -->|"protocol v2"| H2
    H2 --> E1
    E1 --> B1
    B1 --> B2
    B1 --> B3
    B2 -->|"stdio JSON-RPC"| CLI[["AI CLI processes"]]
    B3 --> CLI

    E1 -->|"persist / rehydrate"| S1
    E1 -.->|"inject"| R1
    R2 -.-> CLI
    B2 -.->|"ACP RFD"| R3
```

### Reading notes

- **The webview owns no state.** Everything durable round-trips through the host to
  `TaskEngine` and SQLite. There is no JSON task store.
- **`acp-run` has two paths.** Without `RunOptions.mcpSetup` it is the legacy
  session → `onBeforePrompt` → prompt sequence. With `mcpSetup` it runs a hard-capped
  max-2 attempt loop (`prepareAttempt` → `session/load`|`session/new` → `awaitReady` →
  `onBeforePrompt` → prompt once). Exhaustion yields
  `{ mcpSetupCode: 'attempts_exhausted', readinessCode, attemptCount }` with no
  `terminal_received`. `ensureConnected` stays outside the loop.
- **Dotted edges are out-of-band.** MCP injection and RFD elicitation do not follow the
  request/response spine. The callback and user-response loop is shown separately below;
  keeping it out of this DAG preserves the layer ordering.
- **Cancellation is ownership-scoped.** Local live turns settle terminally in-process;
  remotely leased turns persist `cancelRequests` for the owning process to settle.

## Elicitation and approval callback

The callback is intentionally separate from the forward runtime DAG above. It shows the
round-trip when an ACP backend needs user input during a turn.

```mermaid
sequenceDiagram
    actor User
    participant UI as Webview
    participant Host as Extension host
    participant Engine as Task engine
    participant Bridge as Muster Bridge
    participant ACP as ACP backend
    participant CLI as AI CLI

    User->>UI: Submit prompt
    UI->>Host: protocol v2 message
    Host->>Engine: Start or enqueue turn
    Engine->>ACP: runAcpTurn
    Engine->>Bridge: prepare mcpServers
    Bridge->>CLI: MCP stdio proxy
    ACP->>CLI: ACP prompt
    CLI-->>ACP: RFD elicitation or permission request
    ACP->>Bridge: Forward request
    Bridge->>Engine: beginElicitationWait
    Engine-->>UI: elicitationFormPending
    UI->>User: Show form or approval prompt
    User->>UI: Submit answer or decision
    UI->>Engine: Resolve pending wait
    Engine->>Bridge: Resume pending request
    Bridge-->>CLI: Return answer or approval
    CLI-->>ACP: Continue turn
    ACP-->>Engine: Stream normalized events
    Engine-->>Host: Persisted snapshot
    Host-->>UI: protocol v2 update
```

## Module inventory

This is intentionally a high-level mindmap: the runtime flow and sequence diagram carry the
implementation detail, while this view is for remembering the main system boundaries.

```mermaid
mindmap
  root((Muster))
    Webview
      Svelte chat UI
      Presentation tabs
      Markdown and Mermaid
    Extension host
      Commands and settings
      Backend readiness
      Tool routing
    Task engine
      Scheduler and workflow
      Turns and handoff
      Verification and retention
    AI backends
      Claude and Codex
      Grok, Kiro, OpenCode
      ACP client runtime
    MCP bridge
      Context injection
      Permissions
      User elicitation
    SQLite storage
      Task repository
      Worker and RPC
      Backup and recovery
    Quality and docs
      Unit and E2E tests
      Visual regression
      Design and operation guides
```

## Keeping these accurate

These diagrams are living documents, same rule as the rest of `docs/`. Update them when a
layer boundary moves, not when a file is renamed inside a layer. Source of truth per box:

| Box | Source of truth |
|-----|-----------------|
| Backends | `src/backends/`, `resources/*-acp/` |
| Task engine | `src/task/` |
| Storage | `src/task/sqlite/`, [SQLITE-STORAGE.md](SQLITE-STORAGE.md) |
| Bridge | `src/bridge/`, [MUSTER-BRIDGE.md](MUSTER-BRIDGE.md), [MCP-INJECTION.md](MCP-INJECTION.md) |
| Host layer | `src/host/`, `src/extension.ts`, `contributes` in `package.json` |
| Webview | `webview/src/`, [WEBVIEW.md](WEBVIEW.md) |
