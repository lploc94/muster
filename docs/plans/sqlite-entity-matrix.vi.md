# SQLite entity matrix (Phase 3 gate)

Tài liệu này là inventory chính thức giữa `TaskStoreFile`/domain types và
`muster.sqlite3`. Mỗi field chỉ có một nguồn sự thật: field dùng cho query,
foreign-key, scheduler hoặc fence nằm ở cột được promote; phần ít truy vấn nằm
trong `payload_json` với `payloadVersion: 1` và được hydrate qua codec trong
`src/task/repository.ts`.

## Workspace và task graph

| Aggregate | Identity / promoted columns | Codec payload | Derived hoặc ephemeral |
|---|---|---|---|
| `RepositoryWorkspace` | `workspaces(id, identity_key, display_name, created_at, last_opened_at)` | — | — |
| `RepositoryWorkspaceLocation` | `workspace_locations(workspace_id, canonical_uri, first_seen_at, last_seen_at)` | — | — |
| `MusterTask` | `(workspace_id,id)`, `parent_id`, `role`, `lifecycle`, `release_state`, `goal`, `backend`, `model`, `revision`, `created_at`, `updated_at` | `description`, `reason`, `continuationOf`, `wait`, `taskType`, `committedSessionId`, `runtimeEpoch`, `cwd`, `capabilities`, `executionPolicy`, `executionEpoch`, `outcomeProposal`, `taskResult`, `inputBindings`, `releasedAt`, `releaseAttemptId`, `brief`, `claimsGit`, `error`, `finishedAt`, `attention`, `pendingParentQuestion`, `pendingChildQuestions`, `remediation`, `sealedBy`, `childOrchestrationSeal`, `handoff` | `viewStatus`, `runtimeActivity`, child counts, activity labels |
| `TaskDependency` | `task_dependencies(workspace_id, task_id, dependency_task_id, required_outcome, on_unsatisfied, required_verdict)` | — | readiness outcome is derived from producer task |
| `TaskTurn` | `(workspace_id,id)`, `task_id`, `sequence`, `status`, `trigger`, `created_at`, `started_at`, `settled_at` | `retryOf`, `executionEpoch`, `effectiveRunLimitMs`, `runDeadlineAt`, `termination`, `runtimeEpoch`, `candidateSessionId`, `observedSessionId`, `disposition`, `error`, `isCancellation`, `holdAutoPromote`, `interruptConfidence`, `dispatchPhase`, `failureClass`, `resolvedInputs`, `compiledPrompt` | `inputs` are promoted to `turn_inputs`; active/readiness status is derived |
| `TurnInput` | `turn_inputs(workspace_id, turn_id, ordering, kind)` | `messageId`, `taskIds`, `interruptedTurnId`, `instruction` in row codec | — |

All graph foreign keys are composite `(workspace_id, id)`. Deleting a task
cascades its turns, inputs and transcript rows; no global task-id uniqueness is
assumed.

## Transcript and coordination

| Aggregate | Promoted / indexed storage | Payload codec or retention rule |
|---|---|---|
| `TaskMessage` | `(workspace_id,id)`, `task_id`, `turn_id`, `role`, `state`, `ordering`, `content`, `created_at`; `updated_at` là metadata tương thích của row, không phải field của domain DTO | `agentContent`; row-level truncation updates only settled output, never a live turn |
| `PersistedToolCall` | `(workspace_id,id)`, `task_id`, `turn_id`, `tool_call_id`, `ordering`, `status`, `name`, `created_at`, `updated_at` | `kind`, `input`, `output`, `error`; retention truncates output in-place |
| `PersistedReasoning` | `reasoning_segments(workspace_id,id)`, `task_id`, `turn_id`, `content`, `created_at`, `updated_at`; `ordering=0` là storage sort key vì domain hiện có một reasoning record/turn và không có field `order` | no opaque workspace envelope; retention never truncates a live turn |
| `OperationLedgerEntry` | `(workspace_id,ledger_key)`, `fingerprint`, `created_at` | `result_json` codec; claim/replay/conflict is transaction-fenced |
| `CancelRequest` | `(workspace_id,turn_id)` in `turn_cancel_requests`, plus `task_id`, `kind`, `op_id`, `requested_by`, `requested_at` | `sealedBy`, `reason` in `payload_json`; request owner fence is checked before consume |
| `SendReceipt` | `(workspace_id,client_request_id)`, `fingerprint`, `task_id`, `message_id`, `turn_id`, `created_at` | — |

Cancellation uses only `turn_cancel_requests`, keyed by the actual turn aggregate.

## Runtime ownership and leases

| Claim | Table/key | Owner and expiry contract | Recovery |
|---|---|---|---|
| Runtime turn claim | `runtime_claims(workspace_id, turn_id)` | `owner_id`, `claimed_at`, `heartbeat_at`, `expires_at`; only the owner may heartbeat/release or consume a matching cancel request | `claimRuntime` may reclaim an expired row atomically; stale owner events fail the runtime-epoch/owner fence |
| Backend session claim | `session_claims(workspace_id, session_id)` | one session per live turn, no implicit TTL; released in the same settle/cancel transaction | orphan reconciliation/settlement removes the turn-bound claim |
| Resource claim | `resource_claims(workspace_id, resource_key)` | one owner turn per git/path resource; row references task and turn | terminal settlement/cascade deletes claims; FK cascade handles task removal |

`change_log` records each affected entity under one `workspace_revisions`
revision. Claim rows are not a second source of task state: they are fences and
are deleted/reclaimed transactionally with the owning turn.

## Revision và current schema

| Legacy/global field | SQLite source of truth | Ghi chú |
|---|---|---|
| `TaskStoreFile.schemaVersion` | `PRAGMA user_version` | Schema database, không lặp lại trong workspace row. |
| `TaskStoreFile.revision` | `workspace_revisions(workspace_id, revision)` | Mỗi transaction logical tạo tối đa một workspace revision. |
| `TaskStoreFile.tasks`, `turns`, `messages`, `toolCalls`, `reasoning`, `operations`, `cancelRequests`, `sendReceipts`, `runtimeClaims` | Các normalized tables liệt kê trong tài liệu này | Chỉ là projection nội bộ theo phạm vi task, không có full-workspace export API. |
| Incremental invalidation | `change_log(workspace_id, revision, entity_kind, entity_id, task_id, change_kind, created_at)` | Metadata feed, không chứa prompt/tool payload hay secret. |

## Codec and audit rules

- `taskPayload`, `turnPayload`, `messagePayload`, `toolCallPayload` strip every
  promoted column before encoding; decoders validate `payloadVersion` and enum
  values, then overlay promoted columns.
- Không có `readEnvelopeForMigration()` hoặc data importer. Snapshots/export dùng
  focused repository queries.
- `runtime_claims` là lease source duy nhất; không có filesystem lease sidecar.
- SQLite-only current schema; DB có `user_version` khác bị từ chối và phải reset,
  không chạy data migration.
- SQLite-only runtime không có filesystem `TaskStore` hoặc JSON adapter.
- Secrets, credentials, SQL parameters and raw prompts are never written to
  diagnostics or the change feed.
