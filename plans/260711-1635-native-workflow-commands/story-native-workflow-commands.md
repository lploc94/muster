# Story: Native workflow commands and agentic task orchestration

Lane: high-risk
Status: implemented

## Goal

Deliver host-enforced native Muster commands that require a structured plan and
user approval before implementation starts, while preserving task/session and
lifecycle invariants.

## Scope

All eight phases in [plan.md](./plan.md): native knowledge, store migration,
command core, bridge gates, VS Code UX, utilities and CLI portability proof.

Out of scope: importing CK workflows, forwarding provider slash commands,
provider-specific debate runners, automatic approval by default, and claiming
every ACP backend can hard-block provider built-in writes during planning.

## Plan Link

[Native workflow commands and agentic task orchestration](./plan.md)

## Verification

- Store migration/reload/approval idempotency tests.
- Command parser and adapter parity tests.
- Pre-approval bridge-denial tests.
- Workflow artifact and semantic-validation tests.
- Protocol, Svelte and Playwright auto-plan/approval scenarios.
- Full repository check matrix in phase 8.

## Trace

Planned on 2026-07-11 from the agreed command catalog, current Muster task/MCP
architecture and the referenced curriculum. CK commands/runners are excluded.
