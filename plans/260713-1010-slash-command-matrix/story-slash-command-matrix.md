---
story: slash-command-matrix
status: implemented
priority: P1
---

# Story: Slash command matrix

## Goal

Users discover only truthful slash commands and receive a visible result or an
exact prerequisite explanation for each one.

## Proof obligations

- Matrix includes all 25 canonical commands plus aliases.
- Core tests prove effects and rejected no-op calls.
- Browser tests prove discovery and presenters.
- CLI proof demonstrates adapter/runtime parity; live Dev Host replay remains
  supplemental after packaging.
- Example-web journey proves artifacts, graph, edits, checks and browser result.

## Completion rule

Do not complete while an advertised command is a stub, silently drops a result,
or lacks an explicit unavailable-state contract and automated proof.
