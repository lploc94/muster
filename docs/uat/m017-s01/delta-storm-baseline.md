# M017 S01 — Delta-storm baseline (PR0)

Pre-refactor baseline for synchronous per-delta `TaskStore.commit` storm.
S03 must beat this: `commitCount` should drop well below `chunkCount` while
keeping p95 commit latency comparable or better.

## Capture

- **When:** 2026-07-17
- **Command:** `node scripts/bench-delta-storm.mjs` (default `chunkCount=120`)
- **Worktree:** `milestone/M017` (`.gsd-worktrees/M017`)
- **Method:** Direct `TaskStore.commit` loop mirroring `engine.ts` assistant /
  reasoning / tool mutators; `onCommit` counts durable writes after seed reset.

## Baseline JSON

```json
{"name":"delta-storm","commitCount":120,"chunkCount":120,"commitPerChunk":1,"p50Ms":6.315,"p95Ms":7.56,"meanMs":6.381,"totalWallMs":767.097,"p50":6.3151000000000295,"p95":7.559799999999996,"schemaNote":"Each assistantDelta/reasoningDelta/toolUpdated maps to one TaskStore.commit (engine.ts streaming path)."}
```

## Key signals (S03 gate)

| Metric | Value | Meaning |
|--------|------:|---------|
| `chunkCount` | 120 | Scripted streaming deltas |
| `commitCount` | 120 | Durable `onCommit` firings during storm |
| `commitPerChunk` | 1.0 | Today's 1:1 commit storm |
| `p50Ms` | 6.315 | Median commit latency |
| `p95Ms` | 7.56 | p95 commit latency (PR0 latency baseline) |
| `totalWallMs` | 767.097 | Wall clock for the storm loop |

## Production behavior check (S01 T05)

- `npx vitest run src/backends/acp-client.test.ts src/task/transitions.test.ts` — 93 passed
- `npx vitest run src/backends/m017-fault-repro.test.ts` — 9 passed (R1/R2 RED baselines + G1 isolation + FakeMcpBridge smoke)
- `npm run compile` — exit 0 (`tsc -p .` + webview build)
- `git status` — clean working tree
- Diff vs `main` merge-base for production `src/**/*.ts` (excluding `*.test.ts` / `*.testkit.ts` / fault harness fixtures): **none**

S01 additive surface only:

- `src/bridge/mcp-fault-fixture.testkit.ts`
- `src/backends/acp-fault-harness.testkit.ts`
- `src/backends/acp-test-harness.testkit.ts` (testkit surface)
- `src/backends/m017-fault-repro.test.ts`
- `scripts/bench-delta-storm.mjs`
- `scripts/smoke-acp-fault-harness.mjs`
- `docs/uat/m017-s01/delta-storm-baseline.md` (this file)

## How to re-run

```bash
node scripts/bench-delta-storm.mjs
MUSTER_BENCH_CHUNKS=200 node scripts/bench-delta-storm.mjs
```

Compare new JSON `commitCount` / `commitPerChunk` / `p95Ms` against the table above.
