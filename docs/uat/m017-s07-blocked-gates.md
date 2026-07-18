# M017-S07 D036 BLOCKED Rollout Gates

## Proof Boundary

This tracked ledger records live rollout gates that **cannot** run on the current
host. Per **D036**, correctness for M017 is proven via vitest fault-injection,
5-backend ACP contract suites (FakeMcpBridge / loopback), debt-ledger scans, and
source-boundary/secret checks. Live packaging and multi-session OpenCode metrics
are recorded as **BLOCKED** with an environment reason and must **never** be
mock-substituted into live proof.

Related:

- `docs/MCP-INJECTION.md` — SUPERSEDED http/sse ACP injection; stdio-only `muster_bridge`
- `docs/VERIFICATION-EVIDENCE.md` — M017-S07 D036 BLOCKED table
- `docs/plans/delegate-task-ux-improve.md` — disposition_repair SUPERSEDED by M017-S07

## Host / Environment

- **When:** 2026-07-18
- **Worktree:** `.gsd-worktrees/M017` (milestone M017 / slice S07)
- **Session type:** non-interactive agent execution
- **Attempted:** detect controllable VS Code / Codium Extension Development Host
  packaging surface and a live OpenCode multi-session metrics harness
- **Result:** neither surface is available for direct observation on this Windows
  host in this session

## Scenario Evidence

### GATE-VSIX-REMOTE-PACKAGING

- Gate ID: `M017-S07-GATE-VSIX`
- Verdict: **BLOCKED** (D036)
- Timestamp: 2026-07-18
- Expected: Install or side-load a built VSIX / Remote package, activate Muster
  in a real Extension Development Host (or Remote window), and observe that ACP
  turns still receive stdio-only `muster_bridge` injection with no token-in-argv
  leak under packaging layout.
- Observed: No controllable Extension Development Host or Remote packaging
  surface is available in this session; packaging smoke was not executed.
- Blocker: D036 environment — no `code`/`codium` host automation and no Remote
  packaging target for direct observation. In-process / FakeMcpBridge contract
  suites must not be promoted to packaging proof.
- Cleanup: None (no package install or host session was started).
- Supportive-only local surfaces:
  - `src/bridge/mcp-config.test.ts`
  - `src/bridge/mcp-provider-contract.test.ts` (`BLOCKED_D036_VSIX_REMOTE_PACKAGING_SMOKE`)
  - `npm run compile` / `npm run test:source-boundary` (wiring only)

### GATE-OPENCODE-MULTI-SESSION-METRICS

- Gate ID: `M017-S07-GATE-OPENCODE-SESSIONS`
- Verdict: **BLOCKED** (D036)
- Timestamp: 2026-07-18
- Expected: Run 8–12 concurrent OpenCode ACP sessions under Muster, collect
  rollout metrics (session isolation, MCP readiness, recovery), and confirm
  session-A MCP failure never tears down session-B or the shared agent process.
- Observed: No live OpenCode multi-session harness and no production metrics
  endpoint exist on this host. M017-S07 deliberately does **not** add a new
  production metrics endpoint.
- Blocker: D036 environment — live OpenCode CLI multi-session acceptance and
  rollout metrics collection are unavailable; concurrent isolation is covered
  only by in-process FakeAcpFaultHarness / named D037 flow suites (S06/S07).
- Cleanup: None (no OpenCode processes were spawned).
- Supportive-only local surfaces:
  - `src/backends/m017-fault-repro.test.ts` / S06 recovery D037 flow
  - future `src/backends/m017-s07-debt-ledger.test.ts` (in-repo debt ledger only)

## Explicit Non-Claims

- This file does **not** claim live VS Code activation success.
- This file does **not** claim live OpenCode multi-session rollout success.
- This file does **not** claim package/release readiness.
- Supportive vitest results remain contract/integration proof only.

## How to Unblock Later

1. On a host with VS Code Extension Development Host automation: build VSIX,
   install, activate, run one ACP turn per backend, record packaging layout paths
   for the stdio proxy, re-mark `M017-S07-GATE-VSIX` PASS/FAIL with direct
   observation notes (never backfill from mocks).
2. On a host with OpenCode CLI: script 8–12 concurrent sessions, capture isolation
   and readiness metrics, re-mark `M017-S07-GATE-OPENCODE-SESSIONS` PASS/FAIL.
3. Keep this ledger as the acceptance contract until both gates leave BLOCKED.
